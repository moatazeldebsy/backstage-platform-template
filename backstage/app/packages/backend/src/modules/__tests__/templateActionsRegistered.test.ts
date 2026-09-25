import fs from 'fs';
import path from 'path';

// Guards against a scaffolder template calling a custom idp:* action whose
// module was never added to the backend. That fails only at run time, as
// "Template action with ID 'idp:…' is not registered", after earlier steps
// have already run. idp:decommission-service shipped this way: module,
// template and tests all existed, but index.ts never called backend.add().

const backendSrc = path.resolve(__dirname, '../..');
const catalogDir = path.resolve(backendSrc, '../../../../catalog');

function walk(dir: string, match: (f: string) => boolean): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p, match);
    return match(p) ? [p] : [];
  });
}

// Every idp:* action used in a template or catalog YAML under backstage/catalog.
function actionsUsedByTemplates(): Map<string, string> {
  const used = new Map<string, string>();
  for (const f of walk(catalogDir, p => /\.ya?ml$/.test(p) && !p.includes(`${path.sep}skeleton`))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/^\s*action:\s*(idp:[a-z0-9:-]+)/gm)) {
      if (!used.has(m[1])) used.set(m[1], path.relative(catalogDir, f));
    }
  }
  return used;
}

// action id -> names exported by the module file that defines it.
function actionDefinitions(): Map<string, string[]> {
  const defs = new Map<string, string[]>();
  for (const f of walk(path.join(backendSrc, 'modules'), p => p.endsWith('.ts') && !p.includes('__tests__'))) {
    const src = fs.readFileSync(f, 'utf8');
    const exported = [...src.matchAll(/export const (\w+(?:Module|Plugin))\b/g)].map(m => m[1]);
    for (const m of src.matchAll(/\bid:\s*'(idp:[a-z0-9:-]+)'/g)) {
      defs.set(m[1], exported);
    }
  }
  return defs;
}

describe('custom scaffolder actions used by templates', () => {
  const index = fs.readFileSync(path.join(backendSrc, 'index.ts'), 'utf8');
  const used = actionsUsedByTemplates();
  const defs = actionDefinitions();

  it('finds the templates (guards against a wrong catalog path)', () => {
    expect(used.size).toBeGreaterThan(5);
  });

  it.each([...used.entries()])('%s (used in %s) is defined and registered in index.ts', actionId => {
    const exported = defs.get(actionId);
    expect(exported).toBeDefined();
    const registered = (exported ?? []).some(name =>
      new RegExp(`backend\\.add\\(\\s*${name}\\s*\\)`).test(index),
    );
    expect(registered).toBe(true);
  });
});
