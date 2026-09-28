#!/usr/bin/env node
// Render a scaffolder template offline, the way fetch:template does it:
// Nunjucks with ${{ }} variable delimiters ({% %} stays active), each step's
// `if:` and `values:` evaluated against the form parameters, file contents
// and file names both templated, targetPath honoured, and entries whose
// rendered name is empty skipped.
//
// Form parameters come from the template's own schema: defaults first, then
// placeholders for required fields ("fixture-<template>" names, a fixture
// repo URL, ...), then the overrides file. Steps that call live actions
// (publish:*, idp:*, catalog:*) are not run; their outputs render empty.
//
// usage: node scripts/render-template.js <templatesDir> <template> <overrides.json|-> <outDir>
//
// Needs `nunjucks` and `yaml`, resolved from RENDER_NODE_PATH (CI installs
// them there) or backstage/app/node_modules.
'use strict';
const path = require('path');
const fs = require('fs');

const searchPaths = [process.env.RENDER_NODE_PATH, path.join(__dirname, '..', 'backstage', 'app')].filter(Boolean);
const need = m => require(require.resolve(m, { paths: searchPaths }));
const nunjucks = need('nunjucks');
const yaml = need('yaml');

const [tdir, name, overridesFile, outDir] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: render-template.js <templatesDir> <template> <overrides.json|-> <outDir>');
  process.exit(2);
}
const root = path.join(tdir, name);
const tpl = yaml.parse(fs.readFileSync(path.join(root, 'template.yaml'), 'utf8'));
const overrides = overridesFile && overridesFile !== '-' ? JSON.parse(fs.readFileSync(overridesFile, 'utf8')) : {};

const env = new nunjucks.Environment(null, { autoescape: false, tags: { variableStart: '${{', variableEnd: '}}' } });
// The filters Backstage's SecureTemplater adds.
env.addFilter('parseRepoUrl', v => {
  const [host, q] = String(v).split('?');
  const p = new URLSearchParams(q || '');
  return { host, owner: p.get('owner'), repo: p.get('repo'), organization: p.get('organization'), workspace: p.get('workspace'), project: p.get('project') };
});
env.addFilter('parseEntityRef', (v, ctx) => {
  const m = /^(?:([^:]+):)?(?:([^/]+)\/)?(.+)$/.exec(String(v));
  return { kind: m[1] || (ctx && ctx.defaultKind) || 'Component', namespace: m[2] || 'default', name: m[3] };
});
env.addFilter('pick', (o, k) => (o ? o[k] : undefined));
env.addFilter('projectSlug', v => { const r = env.getFilter('parseRepoUrl')(v); return `${r.owner}/${r.repo}`; });

// Form values: schema defaults, then placeholders, then overrides.
const params = {};
const visit = o => {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) return o.forEach(visit);
  for (const [k, v] of Object.entries(o.properties || {})) {
    if (!v || typeof v !== 'object' || k in params) continue;
    if ('default' in v) params[k] = v.default;
    else if (v.const !== undefined) params[k] = v.const;
    else if (v.enum) params[k] = v.enum[0];
    else if (v.type === 'boolean') params[k] = false;
    else if (v.type === 'array') params[k] = v.items && v.items.enum ? [v.items.enum[0]] : [];
    else if (v.type === 'integer' || v.type === 'number') params[k] = v.minimum ?? 1;
    else if (/RepoUrlPicker/.test(v['ui:field'] || '')) params[k] = `github.com?owner=fixture-org&repo=fixture-${name}`;
    else if (/Owner|Group/.test(v['ui:field'] || '') || /^owner$/i.test(k)) params[k] = 'group:default/platform-team';
    else if (/EntityPicker/.test(v['ui:field'] || '')) params[k] = 'component:default/hello-service';
    else if (/package/i.test(k)) params[k] = 'com.example.fixture';
    else if (/url/i.test(k)) params[k] = 'https://example.com';
    else if (/^name$|Name$/.test(k)) params[k] = `fixture-${name}`.slice(0, 40);
    else params[k] = 'fixture';
  }
  for (const v of Object.values(o)) visit(v);
};
visit(tpl.spec.parameters);
Object.assign(params, overrides);

const ctx = { parameters: params, steps: {}, user: { entity: { metadata: { name: 'fixture-user' } }, ref: 'user:default/fixture-user' } };
const renderStr = s => env.renderString(String(s), ctx);
// `${{ x }}` as a whole value keeps its type in Backstage (arrays, objects, booleans).
const evalExpr = s => {
  const m = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(String(s));
  if (!m) return renderStr(s);
  return env.renderString(`\${{ (${m[1]}) | dump | safe }}`, ctx);
};
const typedValues = v => {
  if (typeof v === 'string') { try { return JSON.parse(evalExpr(v)); } catch { return renderStr(v); } }
  if (Array.isArray(v)) return v.map(typedValues);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typedValues(x)]));
  return v;
};

const report = { template: name, params, rendered: [], skipped: [] };
for (const step of tpl.spec.steps || []) {
  if (step.action !== 'fetch:template') continue;
  if (step.if !== undefined) {
    let ok;
    try { ok = JSON.parse(evalExpr(step.if)); } catch { ok = Boolean(step.if); }
    if (!ok) { report.skipped.push(step.id); continue; }
  }
  const input = step.input || {};
  const values = typedValues(input.values || {});
  const src = path.join(root, renderStr(input.url || './skeleton'));
  const dest = path.join(outDir, renderStr(input.targetPath || '.'));
  const fctx = { values };
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const relName = env.renderString(ent.name, fctx);
      if (!relName) continue;
      const from = path.join(dir, ent.name), to = path.join(dest, rel, relName);
      if (ent.isDirectory()) { walk(from, path.join(rel, relName)); continue; }
      const buf = fs.readFileSync(from);
      const out = buf.includes(0) ? buf : env.renderString(buf.toString('utf8'), fctx);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, out);
    }
  };
  walk(src, '');
  report.rendered.push({ step: step.id, from: path.relative(root, src), to: path.relative(outDir, dest) || '.' });
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, '.render-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ template: name, rendered: report.rendered.map(r => r.step), skipped: report.skipped }));
