import { chromium } from '@playwright/test';
const base = 'http://backstage.idp.local';
const b = await chromium.launch();
const p = await b.newPage();
let calls = 0; const results = [];
p.on('response', async r => {
  if (r.url().includes('/permission/authorize')) { calls++;
    try { const j = JSON.parse(await r.text()); results.push(...j.items.map(i => i.result)); } catch {} }
});
await p.goto(`${base}/`, { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(12000);
await p.getByRole('button', { name: /enter/i }).click({ timeout: 30000 }).catch(() => console.log('  (no Enter button - already signed in?)'));
await p.waitForTimeout(15000);
// /create : Choose buttons are gated on usePermission(taskCreatePermission)
await p.goto(`${base}/create`, { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(25000);
console.log('template cards            :', await p.getByTestId('template-card-actions--footer').count());
console.log('Choose buttons (guest)    :', await p.getByTestId('template-card-actions--create').count());
// Kubernetes tab : guests ARE allowed kubernetes.clusters.read, so a working
// permission check must render "Your Clusters", not the admin message.
await p.goto(`${base}/catalog/default/component/hello-service/kubernetes`, { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(25000);
const txt = await p.locator('body').innerText().catch(() => '');
console.log('k8s "Your Clusters"       :', /your clusters/i.test(txt));
console.log('k8s permission message    :', /contact your portal administrator/i.test(txt));
console.log('>>> authorize calls       :', calls, [...new Set(results)]);
await b.close();
