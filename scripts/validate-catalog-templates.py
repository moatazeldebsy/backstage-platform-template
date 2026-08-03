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

Run from the repo root:  python3 scripts/validate-catalog-templates.py
"""

from __future__ import annotations

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

errors: list[str] = []


def err(path: Path | str, msg: str) -> None:
    errors.append(f"{path}: {msg}")


def load(path: Path):
    try:
        return yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        err(path, f"invalid YAML — {exc}")
        return None


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
