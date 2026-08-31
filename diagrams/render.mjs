// Render a built diagram page to PNG.
//
// Run from backstage/app, which is where playwright is already installed:
//
//   cd backstage/app
//   node ../../docs/diagrams/render.mjs \
//     ../../docs/diagrams/.build/platform-planes.built.html \
//     ../../docs/assets/platform-planes.png
//
// The page is measured after webfonts settle and the viewport is resized to fit,
// so the output is the diagram exactly — no scrollbars, no arbitrary crop.

// Resolved from the working directory, not from this file: the script lives in
// docs/ while playwright is installed under backstage/app, and a bare `import`
// resolves relative to the module's own path.
import { createRequire } from 'node:module';
const require = createRequire(`${process.cwd()}/`);
const { chromium } = require('@playwright/test');

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node render.mjs <built.html> <out.png>');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 2500, height: 2100 },
  deviceScaleFactor: 2, // retina; the diagram is read zoomed-in
});

page.on('pageerror', e => console.error('  page error:', e.message));

await page.goto('file://' + new URL(src, `file://${process.cwd()}/`).pathname, {
  waitUntil: 'networkidle',
  timeout: 90000,
});

// Fonts first: the connector layer is drawn from measured element boxes, and
// those move once the webfont replaces the fallback.
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => window.redrawWires());
await page.waitForTimeout(800);

const size = await page.evaluate(() => {
  const c = document.querySelector('.canvas').getBoundingClientRect();
  return { w: Math.ceil(c.width), h: Math.ceil(c.height) };
});

await page.setViewportSize(size.w > 0 ? { width: size.w, height: size.h } : { width: 2500, height: 2100 });
await page.evaluate(() => window.redrawWires());
await page.waitForTimeout(400);

// A mark that fails to load renders as an empty box rather than an error, so
// check the geometry instead of trusting the request count.
const blank = await page.evaluate(
  () => [...document.querySelectorAll('svg.lg')].filter(e => !e.getBBox().width).length,
);
if (blank) console.warn(`  warning: ${blank} mark(s) rendered blank`);

await page.screenshot({ path: out, clip: { x: 0, y: 0, width: size.w, height: size.h } });
console.log(`  ${size.w}x${size.h} (2x) -> ${out}`);

await browser.close();
