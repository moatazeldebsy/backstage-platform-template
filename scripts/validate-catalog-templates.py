#!/usr/bin/env python3
"""Validate the Backstage scaffolder catalog.

Nothing in CI used to look at `backstage/catalog/` at all — the `changes`
job in ci.yml only matched `backstage/(app/|app-config*.yaml|Dockerfile)`,
so a PR touching only templates ran zero jobs and reported green. This
script is what that path now runs.

Checks, in order of how much they have actually bitten us:

  1. every templates/*/template.yaml is parseable YAML
  2. it is a scaffolder Template whose metadata.name matches its directory
  3. it carries exactly one curation tier (`blessed` xor `advanced`)
  4. it carries a version tag (`v1` or `v2`)
  5. every target in all-templates.yaml resolves to a file on disk
  6. every template is registered exactly once — either in the shared
     all-templates.yaml or, for local-only ones, in app-config.local.yaml,
     and anything registered only locally carries the `local-only` tag
  7. the ModelConfig allow-list baked into the ai-agent-kagent skeleton's CI
     still matches the ModelConfigs this repo applies
  8. every kagent.dev resource — in manifests and in the scaffolder actions
     that emit them — uses an API version the pinned KAgent chart actually
     serves for that kind (they are not uniform: MCPServer is v1alpha1 only,
     Agent is v1alpha2)
  9. no skeleton catalog-info.yaml carries a relative link URL — Backstage
     rejects those, and it fails catalog:register after the repo already exists
 10. steps fail the whole task (there is no `continueOnError`), so
     catalog:register runs last and register-local runs before it

Run from the repo root:  python3 scripts/validate-catalog-templates.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: pip install pyyaml")

CATALOG = Path("backstage/catalog")
TEMPLATES = CATALOG / "templates"
ALL_TEMPLATES = CATALOG / "all-templates.yaml"
LOCAL_CONFIG = Path("backstage/app-config.local.yaml")

TIERS = {"blessed", "advanced"}
VERSIONS = {"v1", "v2"}

# Check 7. The generated agent repo cannot query the cluster from its own CI
# without credentials, so its manifest validation carries a hardcoded copy of
# the valid ModelConfig names. That copy silently goes stale when this repo
# adds or renames one, and the symptom is a scaffolded agent that fails to
# reconcile — the exact failure the check was added to prevent.
AGENT_SKELETON_CI = (
    TEMPLATES / "ai-agent-kagent/skeleton/.github/workflows/ci.yml"
)
MODELCONFIG_GLOB = "kubernetes/kagent/modelconfig*.yaml"
# Shipped by the KAgent install itself, not by a manifest in this repo, so it
# is legitimately in the skeleton's list with no file backing it.
EXTERNAL_MODEL_CONFIGS = {"default-model-config"}

# Check 8. The KAgent CRDs do not all serve the same API version, and the
# difference is not guessable: MCPServer serves only v1alpha1 while Agent,
# ModelConfig and most others serve v1alpha2. Getting it wrong produces "no
# matches for kind" at apply time — on a cluster, long after CI passed.
#
# This table is transcribed from the CRDs in the pinned chart, read with:
#
#   helm pull oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds \
#     --version <KAGENT_CHART_VERSION> --untar
#   # then read spec.versions[].name where served: true, across
#   # templates/*.yaml and charts/kmcp-crds/templates/*.yaml
#
# Re-transcribe it when KAGENT_CHART_VERSION moves in scripts/bootstrap-ai.sh;
# the version below is asserted against that script so the two cannot drift
# silently.
KAGENT_CHART_VERSION = "0.9.4"
BOOTSTRAP_AI = Path("scripts/bootstrap-ai.sh")
KAGENT_SERVED_VERSIONS: dict[str, set[str]] = {
    "Agent": {"v1alpha1", "v1alpha2"},
    "AgentHarness": {"v1alpha2"},
    "MCPServer": {"v1alpha1"},
    "Memory": {"v1alpha1"},
    "ModelConfig": {"v1alpha1", "v1alpha2"},
    "ModelProviderConfig": {"v1alpha2"},
    "RemoteMCPServer": {"v1alpha2"},
    "SandboxAgent": {"v1alpha2"},
    "ToolServer": {"v1alpha1"},
}
# Where kagent CRs are authored. TypeScript modules embed them as template
# literals, so they are scanned as text rather than parsed as YAML.
KAGENT_YAML_GLOBS = (
    "kubernetes/kagent/*.yaml",
    "aws/kagent/*.yaml",
    "backstage/catalog/templates/*/skeleton/kubernetes/*.yaml",
)
KAGENT_TS_GLOB = "backstage/app/packages/backend/src/modules/*.ts"

errors: list[str] = []


def err(path: Path | str, msg: str) -> None:
    errors.append(f"{path}: {msg}")


def load(path: Path):
    try:
        return yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        err(path, f"invalid YAML — {exc}")
        return None


def check_modelconfig_allowlist() -> None:
    """Check 7 — skeleton's hardcoded ModelConfig list vs the real manifests."""
    if not AGENT_SKELETON_CI.is_file():
        err(AGENT_SKELETON_CI, "missing — the ai-agent-kagent skeleton has no CI")
        return

    text = AGENT_SKELETON_CI.read_text()
    start = text.find("KNOWN_MODEL_CONFIGS = [")
    if start == -1:
        err(AGENT_SKELETON_CI, "no KNOWN_MODEL_CONFIGS list found in the skeleton CI")
        return
    end = text.find("]", start)
    declared = set(re.findall(r'"([^"]+)"', text[start:end]))

    applied = set()
    for path in sorted(Path().glob(MODELCONFIG_GLOB)):
        doc = load(path)
        if isinstance(doc, dict):
            name = doc.get("metadata", {}).get("name")
            if name:
                applied.add(name)

    if not applied:
        err(MODELCONFIG_GLOB, "matched no ModelConfig manifests — has the path moved?")
        return

    for name in sorted(applied - declared):
        err(
            AGENT_SKELETON_CI,
            f"ModelConfig '{name}' is applied by this repo but missing from "
            f"KNOWN_MODEL_CONFIGS — a scaffolded agent using it would fail its own CI",
        )
    for name in sorted(declared - applied - EXTERNAL_MODEL_CONFIGS):
        err(
            AGENT_SKELETON_CI,
            f"KNOWN_MODEL_CONFIGS lists '{name}', which no {MODELCONFIG_GLOB} "
            f"manifest defines — stale entry, or add it to EXTERNAL_MODEL_CONFIGS "
            f"if KAgent ships it",
        )


def check_skeleton_entity_links() -> None:
    """Check 9 — a skeleton's catalog-info.yaml must not carry a relative link URL.

    Backstage validates `metadata.links[].url` as an absolute URL. A relative
    one ("/langfuse") fails the entity policy check, which fails the whole
    `catalog:register` step — so the scaffolder run dies AFTER creating the
    GitHub repo, leaving a half-onboarded service. Nothing else in CI looks
    inside a skeleton's catalog-info.yaml, so this shipped once already.

    Template expressions are skipped: the value is only known after rendering.
    """
    for path in sorted(TEMPLATES.glob("*/skeleton*/**/catalog-info.yaml")):
        text = path.read_text()
        # Parsed as text, not YAML: skeletons contain ${{ }} expressions that a
        # YAML load would choke on in some positions.
        for match in re.finditer(r"^\s*url:\s*(\S+)\s*$", text, re.M):
            value = match.group(1).strip("\"'")
            if value.startswith("${{"):
                continue
            if value.startswith("/"):
                err(
                    path,
                    f'relative link url "{value}" — Backstage requires an absolute '
                    f"URL and catalog:register fails on it (use http://<tool>.idp.local)",
                )


def check_step_failure_semantics() -> None:
    """Check 10 — a failing step aborts the task, so ordering is the only guard.

    `continueOnError` is NOT a scaffolder field. TaskStep is exactly
    {id, name, action, input?, if?, each?}, the workflow runner reads only those,
    and the step schema passes unknown keys through silently — so the key looks
    like a safety net while doing nothing. 84 of them had accumulated across 46
    templates before this check existed.

    Two rules follow, both learned from a real run that died at catalog:register
    after publish:github had already created the repo:

      a. No `continueOnError` — it is a lie about the runtime's behaviour.
      b. catalog:register goes last. It is the most failure-prone step (it
         validates the rendered entity, needs a token, talks to two services),
         so anything after it is work a failure throws away.
      c. register-local is a fallback for register, so it must come first —
         otherwise it can never run in the case it exists for.
    """
    for f in sorted(TEMPLATES.glob("*/template.yaml")):
        text = f.read_text()

        for m in re.finditer(r"^[ \t]*continueOnError:", text, re.M):
            line = text[: m.start()].count("\n") + 1
            err(f, f"line {line}: `continueOnError` is not a scaffolder field and "
                   f"does nothing — order the step to fail late instead")

        blocks = re.split(r"\n    - id: ", text)[1:]
        ids, actions = [], []
        for b in blocks:
            ids.append(b.split("\n")[0].strip())
            am = re.search(r"^      action:\s*(\S+)", b, re.M)
            actions.append(am.group(1) if am else "")

        reg = [i for i, a in enumerate(actions) if a == "catalog:register"]
        if reg and max(reg) != len(ids) - 1:
            after = ", ".join(ids[max(reg) + 1 :])
            err(f, f"catalog:register is not the last step; a failure there would "
                   f"skip: {after}")

        if "register" in ids and "register-local" in ids:
            if ids.index("register-local") > ids.index("register"):
                err(f, "register-local is a fallback for register but runs after it, "
                       "so it can never run when register fails")


def _is_template(text: str) -> bool:
    """True for Nunjucks/Actions-templated files, which are not valid YAML."""
    return "{%" in text or "${{" in text


def _scan_kagent_text(path: Path, text: str) -> int:
    """Pull apiVersion/kind pairs out of text that cannot be parsed as YAML."""
    found = 0
    for match in re.finditer(
        r"apiVersion:\s*kagent\.dev/(v1alpha\d+)\s*\n\s*kind:\s*(\w+)", text
    ):
        found += 1
        _check_kagent_api_version(path, match.group(2), match.group(1))
    if not found:
        err(
            path,
            "mentions kagent.dev/ but no apiVersion/kind pair was found — the "
            "check cannot see it, so a wrong version here would go unnoticed",
        )
    return found


def _check_kagent_api_version(where: Path | str, kind: str, version: str) -> None:
    served = KAGENT_SERVED_VERSIONS.get(kind)
    if served is None:
        err(
            where,
            f"kagent.dev/{version} kind '{kind}' is not in KAGENT_SERVED_VERSIONS — "
            f"either a typo, or a new CRD that needs adding to the table",
        )
    elif version not in served:
        err(
            where,
            f"{kind} is declared kagent.dev/{version}, but chart "
            f"{KAGENT_CHART_VERSION} serves only {sorted(served)} for that kind — "
            f"this fails at apply time with 'no matches for kind'",
        )


def check_kagent_api_versions() -> None:
    """Check 8 — every kagent.dev CR uses a version the pinned chart serves."""
    if BOOTSTRAP_AI.is_file():
        pinned = re.search(
            r'KAGENT_CHART_VERSION="([^"]+)"', BOOTSTRAP_AI.read_text()
        )
        if not pinned:
            err(BOOTSTRAP_AI, "no KAGENT_CHART_VERSION found — has it been renamed?")
        elif pinned.group(1) != KAGENT_CHART_VERSION:
            err(
                BOOTSTRAP_AI,
                f"pins KAgent {pinned.group(1)}, but KAGENT_SERVED_VERSIONS in this "
                f"script was transcribed from {KAGENT_CHART_VERSION} — re-read the "
                f"chart's CRDs and update the table",
            )

    seen = 0
    for pattern in KAGENT_YAML_GLOBS:
        for path in sorted(Path().glob(pattern)):
            text = path.read_text()
            if "kagent.dev/" not in text:
                continue
            # Skeleton manifests are Nunjucks templates, not YAML — `{% if %}`
            # is not parseable. Scan those as text; parse everything else, so a
            # real manifest with a malformed body is still reported.
            if _is_template(text):
                seen += _scan_kagent_text(path, text)
                continue
            try:
                docs = list(yaml.safe_load_all(text))
            except yaml.YAMLError as exc:
                err(path, f"invalid YAML — {exc}")
                continue
            for doc in docs:
                if not isinstance(doc, dict):
                    continue
                api = str(doc.get("apiVersion", ""))
                if not api.startswith("kagent.dev/"):
                    continue
                seen += 1
                _check_kagent_api_version(
                    path, str(doc.get("kind", "")), api.split("/", 1)[1]
                )

    # The scaffolder actions build these CRs as template literals; a mismatch
    # here is exactly the bug that made the scaffolded agent fail to reconcile.
    for path in sorted(Path().glob(KAGENT_TS_GLOB)):
        text = path.read_text()
        if "kagent.dev/" in text:
            seen += _scan_kagent_text(path, text)

    if not seen:
        err(
            "kagent apiVersion check",
            "found no kagent.dev resources at all — have the paths moved?",
        )


def main() -> int:
    if not TEMPLATES.is_dir():
        sys.exit(f"{TEMPLATES} not found — run from the repo root")

    template_dirs = sorted(p for p in TEMPLATES.iterdir() if p.is_dir())
    tags_by_name: dict[str, set[str]] = {}

    for d in template_dirs:
        f = d / "template.yaml"
        if not f.is_file():
            err(d, "no template.yaml")
            continue

        doc = load(f)
        if doc is None:
            continue
        if not isinstance(doc, dict):
            err(f, "does not contain a YAML mapping")
            continue

        if doc.get("kind") != "Template":
            err(f, f"kind is {doc.get('kind')!r}, expected 'Template'")
            continue

        meta = doc.get("metadata") or {}
        name = meta.get("name")
        if name != d.name:
            err(f, f"metadata.name {name!r} does not match directory {d.name!r}")

        tags = set(meta.get("tags") or [])
        tags_by_name[d.name] = tags

        tier = tags & TIERS
        if len(tier) != 1:
            err(f, f"needs exactly one of {sorted(TIERS)}, has {sorted(tier)}")
        if not tags & VERSIONS:
            err(f, f"missing a version tag ({'/'.join(sorted(VERSIONS))})")

    # all-templates.yaml — the catalog shared with AWS.
    shared: set[str] = set()
    doc = load(ALL_TEMPLATES)
    if isinstance(doc, dict):
        for target in (doc.get("spec") or {}).get("targets") or []:
            resolved = (CATALOG / target).resolve()
            if not resolved.is_file():
                err(ALL_TEMPLATES, f"target does not exist: {target}")
                continue
            shared.add(resolved.parent.name)

    # app-config.local.yaml — local-only registrations.
    local: set[str] = set()
    doc = load(LOCAL_CONFIG)
    if isinstance(doc, dict):
        for loc in (doc.get("catalog") or {}).get("locations") or []:
            target = str(loc.get("target", ""))
            if "/catalog/templates/" in target:
                local.add(target.split("/catalog/templates/")[1].split("/")[0])

    for d in template_dirs:
        n = d.name
        if n not in shared and n not in local:
            err(d, "not registered in all-templates.yaml or app-config.local.yaml")
        elif n in shared and n in local:
            err(d, "registered twice (all-templates.yaml and app-config.local.yaml)")
        elif n in local and "local-only" not in tags_by_name.get(n, set()):
            err(d, "registered only in app-config.local.yaml but lacks the 'local-only' tag")

    check_modelconfig_allowlist()
    check_kagent_api_versions()
    check_skeleton_entity_links()
    check_step_failure_semantics()

    total = len(template_dirs)
    blessed = sum(1 for t in tags_by_name.values() if "blessed" in t)
    advanced = sum(1 for t in tags_by_name.values() if "advanced" in t)

    if errors:
        print(f"✗ {len(errors)} problem(s) in {total} templates:\n")
        for e in errors:
            print(f"  {e}")
        return 1

    print(
        f"✓ {total} templates valid "
        f"({blessed} blessed, {advanced} advanced; "
        f"{len(shared)} shared, {len(local)} local-only)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
