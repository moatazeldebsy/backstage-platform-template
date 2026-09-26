#!/usr/bin/env python3
"""Build every TechDocs site the catalog declares, the way Backstage would.

A catalog entity opts into TechDocs with `backstage.io/techdocs-ref: dir:<path>`.
Nothing checked that <path> actually builds, so broken sites only surfaced
when someone opened the TechDocs tab and got "Building a newer version of this
documentation failed" over a 404. Two real cases this catches:

  - templates shipped with `techdocs-ref: dir:.` but no docs/ folder or
    mkdocs.yml ("Failed to read '.../docs'")
  - a mkdocs.yml with `docs_dir: .`, which MkDocs 1.6 rejects outright

For every entity with a `dir:` ref this script requires an mkdocs.yml in the
target directory and runs `mkdocs build` there. Install the same versions the
Backstage image uses (see the techdocs-build job in ci.yml), or a site that
builds here can still fail in Backstage.

`url:` refs point at other repositories and are skipped.

Run from the repo root:  python3 scripts/check-techdocs.py
"""
import glob
import os
import subprocess
import sys
import tempfile

import yaml

ANNOTATION = 'backstage.io/techdocs-ref'


def entity_files():
    files = set(glob.glob('backstage/catalog/**/*.yaml', recursive=True))
    files |= set(glob.glob('**/catalog-info.yaml', recursive=True))
    for f in sorted(files):
        parts = f.split(os.sep)
        # Skeletons are rendered by the scaffolder; their refs point into the
        # repo a template will create, not into this one.
        if 'node_modules' in parts or any(p.startswith('skeleton') for p in parts):
            continue
        if f.startswith('backstage/app/examples/'):
            continue
        yield f


def declared_sites():
    """Map each TechDocs directory to the entities that point at it."""
    sites = {}
    for f in entity_files():
        try:
            docs = list(yaml.safe_load_all(open(f)))
        except yaml.YAMLError:
            continue  # catalog-lint reports unparseable YAML
        for doc in docs:
            if not isinstance(doc, dict):
                continue
            meta = doc.get('metadata') or {}
            ref = (meta.get('annotations') or {}).get(ANNOTATION)
            if not isinstance(ref, str) or not ref.startswith('dir:'):
                continue
            target = os.path.normpath(os.path.join(os.path.dirname(f), ref[len('dir:'):]))
            entity = f"{doc.get('kind', '?')}:{meta.get('name', '?')} ({f})"
            sites.setdefault(target, []).append(entity)
    return sites


def check(target):
    """Return an error message for `target`, or None if it builds."""
    if not os.path.isdir(target):
        return f'directory {target}/ does not exist'
    if not any(os.path.isfile(os.path.join(target, c)) for c in ('mkdocs.yml', 'mkdocs.yaml')):
        return f'no mkdocs.yml in {target}/'
    with tempfile.TemporaryDirectory() as site:
        result = subprocess.run(
            ['mkdocs', 'build', '--site-dir', site],
            cwd=target, capture_output=True, text=True,
        )
    if result.returncode != 0:
        lines = (result.stdout + result.stderr).splitlines()
        errors = [l for l in lines if 'ERROR' in l or 'Error' in l] or lines[-3:]
        return 'mkdocs build failed:\n      ' + '\n      '.join(errors[:5])
    return None


def main():
    sites = declared_sites()
    if not sites:
        print('No TechDocs sites found — is this the repo root?')
        return 1
    failures = []
    for target in sorted(sites):
        error = check(target)
        if error:
            failures.append((target, error))
    print(f'Built {len(sites) - len(failures)}/{len(sites)} TechDocs sites.')
    for target, error in failures:
        print(f'\nFAIL {target}/')
        for entity in sites[target]:
            print(f'  used by {entity}')
        print(f'  {error}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
