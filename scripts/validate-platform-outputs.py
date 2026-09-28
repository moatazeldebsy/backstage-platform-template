#!/usr/bin/env python3
"""Validate what scaffolder templates commit to this repo, and what is committed.

Templates that open a PR against the platform repo (service onboarding values,
Terraform modules, Crossplane claims, ExternalSecrets, team namespaces, SLOs)
were only ever checked as template source. Rendered, several were broken:
Deployments with no containerPort, invalid Terraform, PRs that overwrote the
repo's own README.md and Terraform root, and files written where nothing
applies them. This renders each such template with scripts/render-template.js
and checks the result the way the cluster and CI would, then runs the same
checks over the committed paths those PRs land in:

  placement   the PR adds only new files (never overwrites one), under a path
              something applies or reads
  terraform   fmt -check, init -backend=false, validate (terraform/infra/**)
  claims      apiVersion/kind served by an XRD in aws/crossplane, spec valid
              against its openAPIV3Schema (services/*/claims/)
  manifests   kubeconform (services/*/secrets/, kubernetes/teams/, observability/slo/)
  values      helm template helm/service-template the way the ApplicationSets
              do, then kubeconform and the Gatekeeper policies in
              kubernetes/policies/ (services/*/helm-values-{aws,local}.yaml)
  rollout     helm-values-rollout-<env>.yaml uses an env an ApplicationSet loads

Needs node (+ nunjucks and yaml, see render-template.js), terraform, helm,
kubeconform, gator, and python3 with PyYAML and jsonschema on PATH.

usage: python3 scripts/validate-platform-outputs.py [--only TEMPLATE ...] [--skip-committed]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import jsonschema
import yaml

REPO = Path(__file__).resolve().parent.parent
TEMPLATES = REPO / "backstage/catalog/templates"
ALL_TEMPLATES = REPO / "backstage/catalog/all-templates.yaml"
PLATFORM_REPO = "backstage-platform-template"
CHART = REPO / "helm/service-template"
POLICIES = sorted((REPO / "kubernetes/policies").glob("*.yaml"))  # not kyverno/
CRD_CATALOG = "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"

# Form overrides where a template's defaults skip the step that writes to the
# platform repo (flutter-app only opens its GitOps PR when web deploy is on).
OVERRIDES = {"flutter-app": {"platforms": ["web"], "enableWebDeploy": True}}

# Where a template PR may add files, and what consumes each path.
CONSUMED = [
    (r"services/[^/]+/helm-values-(aws|local)\.yaml", "idp-services ApplicationSets"),
    (r"services/[^/]+/helm-values-rollout-(dev|local|staging|prod)\.yaml", "ApplicationSets (rollout overlay)"),
    (r"services/[^/]+/claims/[^/]+\.yaml", "idp-service-resources ApplicationSet"),
    (r"services/[^/]+/secrets/[^/]+\.yaml", "idp-service-resources ApplicationSet"),
    (r"terraform/infra/[^/]+/[^/]+/.+", "manual terraform apply per module"),
    (r"kubernetes/teams/[^/]+/[^/]+\.yaml", "bootstrap.sh / bootstrap-local.sh"),
    (r"observability/slo/[^/]+\.yaml", "bootstrap.sh / bootstrap-local.sh"),
    (r"\.github/workflows/secret-rotation-[^/]+\.yml", "GitHub Actions (scheduled)"),
]
# ApplicationSet envs that load helm-values-rollout-<env>.yaml.
ROLLOUT_ENVS = {"dev", "local", "staging", "prod"}

failures: list[str] = []


def fail(scope: str, msg: str) -> None:
    failures.append(f"{scope}: {msg}")
    print(f"  FAIL {msg}")


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def props(o):
    if isinstance(o, list):
        for x in o:
            yield from props(x)
    elif isinstance(o, dict):
        yield from (o.get("properties") or {}).items()
        for v in o.values():
            if isinstance(v, (dict, list)):
                yield from props(v)


def platform_pr_templates() -> list[str]:
    """Registered, enabled templates whose publish:github:pull-request targets this repo."""
    registered = set()
    for doc in yaml.safe_load_all(ALL_TEMPLATES.read_text()):
        for t in ((doc or {}).get("spec") or {}).get("targets") or []:
            registered.add(Path(t).parent.name)
    out = []
    for f in sorted(TEMPLATES.glob("*/template.yaml")):
        name = f.parent.name
        if name not in registered or (f.parent / "DISABLED.md").exists():
            continue
        d = yaml.safe_load(f.read_text())
        params = dict(props(d["spec"].get("parameters")))
        for s in d["spec"].get("steps") or []:
            if s.get("action") != "publish:github:pull-request":
                continue
            url = str((s.get("input") or {}).get("repoUrl", ""))
            m = re.search(r"parameters\.(\w+)", url)
            p = params.get(m.group(1), {}) if m else {}
            allowed = ((p.get("ui:options") or {}).get("allowedRepos")) or []
            if PLATFORM_REPO in url or PLATFORM_REPO in allowed or p.get("default") == PLATFORM_REPO:
                out.append(name)
                break
    return out


def render(name: str, work: Path) -> Path | None:
    """Render a template; return the tree of files its platform-repo PR adds."""
    out = work / name
    ov = work / f"{name}.overrides.json"
    ov.write_text(json.dumps(OVERRIDES.get(name, {})))
    r = run(["node", str(REPO / "scripts/render-template.js"), str(TEMPLATES), name, str(ov), str(out)])
    if r.returncode:
        fail(name, f"render failed: {r.stderr.strip()[:400]}")
        return None
    pr = work / f"{name}.pr"
    pr.mkdir()
    d = yaml.safe_load((TEMPLATES / name / "template.yaml").read_text())
    report = json.loads((out / ".render-report.json").read_text())
    for s in d["spec"]["steps"]:
        if s.get("action") != "publish:github:pull-request":
            continue
        i = s.get("input") or {}
        src = out / str(i.get("sourcePath", ".")).lstrip("./")
        tgt = str(i.get("targetPath", "") or "")
        tgt = re.sub(r"\$\{\{\s*parameters\.(\w+)\s*\}\}", lambda m: str(report["params"].get(m.group(1), "")), tgt)
        if src.is_dir():
            shutil.copytree(src, pr / tgt, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".render-report.json", "platform-values") if src == out else None)
    return pr


# ── checks ────────────────────────────────────────────────────────────────────

def check_placement(name: str, pr: Path) -> None:
    for f in sorted(p for p in pr.rglob("*") if p.is_file()):
        rel = f.relative_to(pr).as_posix()
        if (REPO / rel).exists():
            fail(name, f"PR would overwrite existing {rel}")
        elif not any(re.fullmatch(rx, rel) for rx, _ in CONSUMED):
            fail(name, f"{rel} lands where nothing applies or reads it")


def check_terraform(scope: str, root: Path) -> None:
    for d in sorted({p.parent for p in root.glob("terraform/infra/**/*.tf")}):
        rel = d.relative_to(root).as_posix()
        r = run(["terraform", "fmt", "-check", "-recursive"], cwd=d)
        if r.returncode:
            fail(scope, f"{rel}: terraform fmt -check: {r.stdout.split()}")
        work = Path(tempfile.mkdtemp())
        shutil.copytree(d, work, dirs_exist_ok=True)
        r = run(["terraform", "init", "-backend=false", "-input=false", "-no-color"], cwd=work, timeout=600)
        if r.returncode:
            fail(scope, f"{rel}: terraform init: {(r.stderr or r.stdout).strip()[-400:]}")
            continue
        r = run(["terraform", "validate", "-no-color", "-json"], cwd=work)
        res = json.loads(r.stdout or "{}")
        for diag in res.get("diagnostics", []):
            sev = diag.get("severity")
            if sev == "error" or (sev == "warning" and "future version" in diag.get("detail", "")):
                fail(scope, f"{rel}: terraform {sev}: {diag.get('summary')} — {diag.get('detail', '')[:200]}")
        shutil.rmtree(work, ignore_errors=True)


def load_xrds() -> dict:
    xrds = {}
    for f in (REPO / "aws/crossplane/compositions").glob("*/xrd.yaml"):
        for d in yaml.safe_load_all(f.read_text()):
            if not d or d.get("kind") != "CompositeResourceDefinition":
                continue
            claim = (d["spec"].get("claimNames") or {}).get("kind")
            for v in d["spec"]["versions"]:
                xrds[(f'{d["spec"]["group"]}/{v["name"]}', claim)] = v
    return xrds


XRDS: dict = {}
CROSSPLANE_SPEC = ("compositionRef", "compositionSelector", "compositionUpdatePolicy", "compositionRevisionRef",
                   "writeConnectionSecretToRef", "resourceRef", "publishConnectionDetailsTo", "compositeDeletePolicy")


def check_claims(scope: str, root: Path) -> None:
    for f in sorted(root.glob("services/*/claims/*.yaml")):
        if f.name.startswith("catalog-info"):
            continue
        rel = f.relative_to(root).as_posix()
        for doc in yaml.safe_load_all(f.read_text()):
            if not doc:
                continue
            ver = XRDS.get((doc.get("apiVersion"), doc.get("kind")))
            if ver is None:
                fail(scope, f"{rel}: no XRD serves {doc.get('apiVersion')} {doc.get('kind')} as a claim")
                continue
            if not ver.get("served"):
                fail(scope, f"{rel}: {doc.get('apiVersion')} is not served")
            schema = json.loads(json.dumps(ver["schema"]["openAPIV3Schema"]))
            spec = schema.setdefault("properties", {}).setdefault("spec", {"type": "object"})
            for k in CROSSPLANE_SPEC:  # injected by Crossplane, valid on any claim
                spec.setdefault("properties", {}).setdefault(k, {})
            for e in jsonschema.Draft7Validator(schema).iter_errors({"spec": doc.get("spec", {})}):
                fail(scope, f"{rel}: {'/'.join(map(str, e.absolute_path))}: {e.message}")


def kubeconform(files: list[Path]) -> str | None:
    if not files:
        return None
    r = run(["kubeconform", "-strict", "-summary", "-output", "text",
             "-schema-location", "default", "-schema-location", CRD_CATALOG, *map(str, files)])
    return None if r.returncode == 0 else (r.stdout + r.stderr).strip()


def check_manifests(scope: str, root: Path) -> None:
    files = [f for pat in ("services/*/secrets/*.yaml", "kubernetes/teams/**/*.yaml", "observability/slo/*.yaml")
             for f in sorted(root.glob(pat))]
    out = kubeconform(files)
    if out:
        fail(scope, "kubeconform:\n      " + "\n      ".join(l for l in out.splitlines() if "invalid" in l.lower() or "error" in l.lower()))


SERVICES_DEV_NS = next(d for d in yaml.safe_load_all((REPO / "kubernetes/namespaces/namespaces.yaml").read_text())
                       if d and d.get("kind") == "Namespace" and d["metadata"]["name"] == "services-dev")


def check_values(scope: str, root: Path) -> None:
    for f in sorted(root.glob("services/*/helm-values-*.yaml")):
        svc, rel = f.parent.name, f.relative_to(root).as_posix()
        m = re.fullmatch(r"helm-values-rollout-(.+)\.yaml", f.name)
        if m:
            if m.group(1) not in ROLLOUT_ENVS:
                fail(scope, f"{rel}: no ApplicationSet loads helm-values-rollout-{m.group(1)}.yaml (envs: {sorted(ROLLOUT_ENVS)})")
            continue
        if f.name not in ("helm-values-aws.yaml", "helm-values-local.yaml"):
            continue  # staging/prod are written by CI promotion, not templates
        # Committed services only when deployable (same rule as build-and-deploy.yml).
        if root == REPO and not (f.parent / "Dockerfile").exists():
            continue
        valuefiles = ["-f", str(f)]
        env = "dev" if f.name.endswith("aws.yaml") else "local"
        overlay = f.parent / f"helm-values-rollout-{env}.yaml"
        if overlay.exists():
            valuefiles += ["-f", str(overlay)]
        r = run(["helm", "template", svc, str(CHART), "-n", "services-dev",
                 "--set", f"backstage.kubernetesId={svc}", *valuefiles])
        if r.returncode:
            fail(scope, f"{rel}: helm template: {r.stderr.strip()[:300]}")
            continue
        docs = [d for d in yaml.safe_load_all(r.stdout) if d]
        tmp = Path(tempfile.mkdtemp())
        rendered = tmp / "rendered.yaml"
        rendered.write_text(yaml.safe_dump_all(docs))
        out = kubeconform([rendered])
        if out:
            bad = [l.replace(f"{rendered} - ", "") for l in out.splitlines() if "invalid" in l.lower()]
            fail(scope, f"{rel}: rendered manifests invalid:\n      " + "\n      ".join(bad))
        # Gatekeeper constraints match by namespace, which helm template leaves
        # unset; ArgoCD applies into services-dev. Include the real Namespace so
        # namespace-scoped matching resolves.
        for d in docs:
            d.setdefault("metadata", {})["namespace"] = "services-dev"
        adm = tmp / "admission.yaml"
        adm.write_text(yaml.safe_dump_all([SERVICES_DEV_NS] + [d for d in docs if d.get("kind") == "Deployment"]))
        args = [a for p in POLICIES for a in ("-f", str(p))]
        r = run(["gator", "test", *args, "-f", str(adm)], timeout=120)
        if r.returncode:
            fail(scope, f"{rel}: Gatekeeper would deny:\n      " + "\n      ".join(l for l in (r.stdout + r.stderr).splitlines() if l.strip() and not l.startswith(" ")))
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", help="templates to render (default: every platform-repo PR template)")
    ap.add_argument("--skip-committed", action="store_true", help="do not check the committed repo paths")
    a = ap.parse_args()

    missing = [t for t in ("node", "terraform", "helm", "kubeconform", "gator") if not shutil.which(t)]
    if missing:
        sys.exit(f"missing tools: {', '.join(missing)}")
    XRDS.update(load_xrds())

    names = a.only or platform_pr_templates()
    work = Path(tempfile.mkdtemp(prefix="platform-outputs-"))
    print(f"Templates that open a PR against {PLATFORM_REPO}: {len(names)}")
    for name in names:
        print(f"\n== {name}")
        before = len(failures)
        pr = render(name, work)
        if pr is None:
            continue
        files = [p.relative_to(pr).as_posix() for p in pr.rglob("*") if p.is_file()]
        print(f"  adds: {', '.join(sorted(files)) or '(nothing)'}")
        check_placement(name, pr)
        check_terraform(name, pr)
        check_claims(name, pr)
        check_manifests(name, pr)
        check_values(name, pr)
        if len(failures) == before:
            print("  ok")

    if not a.skip_committed:
        print("\n== committed repo paths")
        before = len(failures)
        check_terraform("repo", REPO)
        check_claims("repo", REPO)
        check_manifests("repo", REPO)
        check_values("repo", REPO)
        if len(failures) == before:
            print("  ok")

    shutil.rmtree(work, ignore_errors=True)
    if failures:
        print(f"\n✗ {len(failures)} problem(s):")
        for f in failures:
            print(f"  {f}")
        return 1
    print(f"\n✓ {len(names)} platform-repo PR templates and the committed paths are valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
