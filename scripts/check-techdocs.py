#!/usr/bin/env python3
"""Build every TechDocs site the catalog declares, the way Backstage would.

A catalog entity gets a TechDocs tab from one of two annotations:

  backstage.io/techdocs-ref: dir:<path> | url:<git url>
      the entity has its own site
  backstage.io/techdocs-entity: <kind>:<namespace>/<name>
  backstage.io/techdocs-entity-path: /<page>/       (optional)
      the tab shows another entity's site, starting at <page>

Nothing checked that any of these actually build, so broken sites only
surfaced when someone opened the tab and got "Building a newer version of
this documentation failed" over a 404. Real cases this catches:

  - templates with `techdocs-ref: dir:.` but no docs/ or mkdocs.yml
  - a mkdocs.yml with `docs_dir: .`, which MkDocs 1.6 rejects outright
  - a `url:` ref into this repo pointing at a directory with no docs

For every site this script requires an mkdocs.yml and runs `mkdocs build`.
`url:` refs into this repository are resolved to their directory and built
too; `url:` refs to other repositories are skipped. For every
`techdocs-entity`, the target must be a known entity whose site builds, and
the `techdocs-entity-path` page must exist in that built site.

Install the same MkDocs versions the Backstage image uses (see the
techdocs-build job in ci.yml), or a site that builds here can still fail in
Backstage.

Run from the repo root:  python3 scripts/check-techdocs.py
"""
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile

import yaml

REF = 'backstage.io/techdocs-ref'
EXTERNAL = 'backstage.io/techdocs-entity'
EXTERNAL_PATH = 'backstage.io/techdocs-entity-path'


def repo_name():
    """This repository's name, to recognise url: refs that point back into it."""
    if os.environ.get('GITHUB_REPOSITORY'):
        return os.environ['GITHUB_REPOSITORY'].split('/')[-1]
    try:
        url = subprocess.run(['git', 'config', '--get', 'remote.origin.url'],
                             capture_output=True, text=True, check=True).stdout.strip()
        return re.sub(r'\.git$', '', url.rstrip('/').split('/')[-1])
    except (subprocess.CalledProcessError, FileNotFoundError):
        return os.path.basename(os.getcwd())


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


def entity_ref(doc):
    meta = doc.get('metadata') or {}
    return f"{doc.get('kind', '?')}:{meta.get('namespace', 'default')}/{meta.get('name', '?')}".lower()


def normalise_ref(ref):
    """kind:name / kind:ns/name -> kind:ns/name, lower-cased."""
    kind, _, rest = ref.partition(':')
    if '/' not in rest:
        rest = f'default/{rest}'
    return f'{kind}:{rest}'.lower()


def collect():
    """Return (sites, entity_sites, externals).

    sites:        site dir -> [entity labels using it]
    entity_sites: entity ref -> site dir (only for entities with a local site)
    externals:    [(label, target ref, page path or '')]
    """
    self_url = re.compile(
        r'^url:https://github\.com/[^/]+/' + re.escape(repo_name()) +
        r'/(?:tree|blob)/[^/]+/(.+?)/?$')
    sites, entity_sites, externals = {}, {}, []
    for f in entity_files():
        try:
            docs = list(yaml.safe_load_all(open(f)))
        except yaml.YAMLError:
            continue  # catalog-lint reports unparseable YAML
        for doc in docs:
            if not isinstance(doc, dict):
                continue
            ann = (doc.get('metadata') or {}).get('annotations') or {}
            label = f'{entity_ref(doc)} ({f})'
            ref = ann.get(REF)
            target = None
            if isinstance(ref, str) and ref.startswith('dir:'):
                target = os.path.normpath(os.path.join(os.path.dirname(f), ref[len('dir:'):]))
            elif isinstance(ref, str) and self_url.match(ref):
                target = os.path.normpath(self_url.match(ref).group(1))
            if target:
                sites.setdefault(target, []).append(label)
                entity_sites[entity_ref(doc)] = target
            if isinstance(ann.get(EXTERNAL), str):
                externals.append((label, normalise_ref(ann[EXTERNAL]), ann.get(EXTERNAL_PATH) or ''))
    return sites, entity_sites, externals


def build(target, out):
    """Build `target` into `out`; return an error message or None."""
    if not os.path.isdir(target):
        return f'directory {target}/ does not exist'
    if not any(os.path.isfile(os.path.join(target, c)) for c in ('mkdocs.yml', 'mkdocs.yaml')):
        return f'no mkdocs.yml in {target}/'
    result = subprocess.run(['mkdocs', 'build', '--site-dir', out],
                            cwd=target, capture_output=True, text=True)
    if result.returncode != 0:
        lines = (result.stdout + result.stderr).splitlines()
        errors = [l for l in lines if 'ERROR' in l or 'Error' in l] or lines[-3:]
        return 'mkdocs build failed:\n      ' + '\n      '.join(errors[:5])
    return None


def page_exists(site_dir, path):
    path = path.strip('/')
    if not path:
        return os.path.isfile(os.path.join(site_dir, 'index.html'))
    return (os.path.isfile(os.path.join(site_dir, path, 'index.html'))
            or os.path.isfile(os.path.join(site_dir, path + '.html'))
            or os.path.isfile(os.path.join(site_dir, path)))


def main():
    sites, entity_sites, externals = collect()
    if not sites:
        print('No TechDocs sites found — is this the repo root?')
        return 1

    out_root = tempfile.mkdtemp(prefix='techdocs-check-')
    built, failures = {}, []
    try:
        for i, target in enumerate(sorted(sites)):
            out = os.path.join(out_root, str(i))
            error = build(target, out)
            if error:
                failures.append((f'{target}/', sites[target], error))
            else:
                built[target] = out

        for label, ref, path in externals:
            target = entity_sites.get(ref)
            if target is None:
                error = f'{EXTERNAL} points at {ref}, which has no TechDocs site in this repo'
            elif target not in built:
                error = f'{EXTERNAL} points at {ref}, whose site ({target}/) does not build'
            elif path and not page_exists(built[target], path):
                error = f'{EXTERNAL_PATH} {path} is not a page in {ref}\'s site ({target}/)'
            else:
                continue
            failures.append((f'{EXTERNAL} on {label.split(" ")[0]}', [label], error))
    finally:
        shutil.rmtree(out_root, ignore_errors=True)

    print(f'Built {len(built)}/{len(sites)} TechDocs sites; '
          f'checked {len(externals)} {EXTERNAL} reference(s).')
    for what, users, error in failures:
        print(f'\nFAIL {what}')
        for entity in users:
            print(f'  used by {entity}')
        print(f'  {error}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
