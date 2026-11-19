// End-to-end test without Figma:
//   capture HTML -> run figma-plugin/code.js against a strict mock Figma API
//   -> render the resulting Figma layer tree back to pixels -> screenshot.
//
// Usage: node test/run-import.js <file.html|url> [outDir] [width]
//        node test/run-import.js --design test/design-sample.json [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { captureHtml, closeBrowser, findChrome } from '../server/capture.js';
import { resolveAssets } from '../server/assets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const isDesign = args[0] === '--design';
const input = isDesign ? args[1] : args[0];
const outDir = (isDesign ? args[2] : args[1]) || path.join(root, 'test', 'out');
const width = parseInt((isDesign ? null : args[2]) || '1440', 10);
if (!input) {
  console.error('usage: node test/run-import.js <file.html|url> [outDir] [width]');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const base = path.basename(input).replace(/\.[^.]+$/, '').replace(/\s+/g, '-');

let nodes, assets, frameW = width;
if (isDesign) {
  const parsed = JSON.parse(fs.readFileSync(input, 'utf8'));
  nodes = Array.isArray(parsed) ? parsed : parsed.nodes;
  assets = await resolveAssets(nodes);
  frameW = Math.max(1600, ...nodes.map((n) => n.width || 0));
} else {
  const t0 = Date.now();
  const cap = await captureHtml({ source: input, width, height: 900 });
  console.log(`capture: ${Date.now() - t0}ms`, cap.stats);
  if (cap.warnings.length) console.log('capture warnings:', cap.warnings);
  nodes = [cap.tree];
  assets = cap.assets;
  frameW = cap.tree.width;
}

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--hide-scrollbars', '--font-render-hinting=none'],
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.setViewport({ width: Math.ceil(frameW), height: 900 });
  await page.setContent('<!doctype html><html><body></body></html>');
  for (const f of ['test/mock-figma.js', 'figma-plugin/code.js', 'test/render-mock.js']) {
    await page.addScriptTag({ path: path.join(root, f) });
  }
  const t1 = Date.now();
  const resp = await page.evaluate((n, a) => window.__send('create_nodes', { nodes: n, assets: a }), nodes, assets);
  console.log(`plugin create_nodes: ${Date.now() - t1}ms`);
  if (resp.error) throw new Error('plugin error: ' + resp.error);
  const r = resp.result;
  console.log('created:', r.created, '\nlayers:', r.layerCount);
  console.log('missingFonts:', r.missingFonts);
  console.log('warnings:', r.warnings);
  console.log(`errors (${r.errors.length}):`, r.errors.slice(0, 20));

  // Exercise the read/update commands too.
  const firstId = r.created[0].id;
  const info = await page.evaluate(() => window.__send('get_document_info', {}));
  if (info.error) throw new Error('get_document_info: ' + info.error);
  const desc = await page.evaluate((id) => window.__send('get_node', { id, depth: 1 }), firstId);
  if (desc.error) throw new Error('get_node: ' + desc.error);
  const sel = await page.evaluate(() => window.__send('get_selection', { depth: 0 }));
  if (sel.error) throw new Error('get_selection: ' + sel.error);
  console.log('get_node ok:', desc.result.name, desc.result.width + 'x' + desc.result.height, (desc.result.children || []).length, 'children');

  await page.evaluate(() => window.__renderMock(figma.currentPage.children, figma.currentPage.children[0].x, figma.currentPage.children[0].y));
  const shot = path.join(outDir, `${base}-figma-mock.png`);
  await page.screenshot({ path: shot, fullPage: true });
  fs.writeFileSync(path.join(outDir, `${base}-result.json`), JSON.stringify(r, null, 2));
  console.log('screenshot:', shot);
} finally {
  await browser.close();
  await closeBrowser();
}
