// Plugin-only import test, no MCP server: the real figma-plugin/ui.html runs
// in an iframe the way Figma hosts it, imports an HTML file through its own
// file picker, and the real code.js builds the layers against the mock Figma
// API. The result is compared with the server's import of the same file.
//
// Usage: node test/e2e-plugin.js [file.html] [outDir]   (defaults to test/fixtures/features.html)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { captureHtml, closeBrowser, findChrome } from '../server/capture.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlFile = path.resolve(process.argv[2] || path.join(root, 'test/fixtures/features.html'));
const outDir = process.argv[3] || path.join(root, 'test', 'out');
const base = path.basename(htmlFile).replace(/\.[^.]+$/, '').replace(/\s+/g, '-');
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// Keep the test's plugin window away from a real MCP server on this machine.
const ui = fs.readFileSync(path.join(root, 'figma-plugin/ui.html'), 'utf8');
const uiForTest = '<script>window.WebSocket = function () { throw new Error("disabled in test"); };</script>\n' + ui;

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--hide-scrollbars', '--font-render-hinting=none'],
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.setViewport({ width: 1200, height: 900 });
  await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="ui" style="width:320px;height:600px;border:0"></iframe></body></html>');
  await page.addScriptTag({ path: path.join(root, 'test/mock-figma.js') });
  // Act as the Figma host: relay messages between code.js and the UI iframe.
  await page.evaluate(() => {
    const frame = document.getElementById('ui');
    const record = figma.ui.postMessage.bind(figma.ui);
    figma.ui.postMessage = (msg) => {
      record(msg);
      frame.contentWindow.postMessage({ pluginMessage: JSON.parse(JSON.stringify(msg)) }, '*');
    };
    window.addEventListener('message', (e) => {
      if (e.source === frame.contentWindow && e.data && e.data.pluginMessage) figma.ui.onmessage(e.data.pluginMessage);
    });
  });
  await page.addScriptTag({ path: path.join(root, 'figma-plugin/code.js') });
  await page.addScriptTag({ path: path.join(root, 'test/render-mock.js') });
  await page.evaluate((html) => new Promise((res) => {
    const frame = document.getElementById('ui');
    frame.onload = res;
    frame.srcdoc = html;
  }), uiForTest);
  const uiFrame = page.frames().find((f) => f.parentFrame() === page.mainFrame());

  await uiFrame.waitForFunction(() => document.getElementById('file').textContent.includes('Mock File'), { timeout: 5000 });
  check(true, 'UI shows the open file without an AI app');
  const status = await uiFrame.$eval('#status', (el) => el.textContent);
  check(status === 'Off', 'AI connection is off by default', status);
  check(await uiFrame.$eval('.tab[data-tab=ai]', (t) => t.hidden), 'AI tab hidden until turned on in Settings');
  check(await uiFrame.$eval('#import', (b) => b.disabled), 'Import disabled until a file is chosen');

  const input = await uiFrame.$('#file-input');
  await input.uploadFile(htmlFile);
  await uiFrame.waitForFunction(() => !document.getElementById('import').disabled, { timeout: 10000 });
  check(true, 'file picker loads the HTML', await uiFrame.$eval('#picked', (el) => el.textContent));

  await uiFrame.click('[data-width="390"]'); // 1440 is on by default
  const t0 = Date.now();
  await uiFrame.click('#import');
  await uiFrame.waitForFunction(() => /ok|error/.test(document.getElementById('progress').className), { timeout: 300000 });
  const progress = await uiFrame.$eval('#progress', (el) => ({ text: el.textContent, ok: el.className === 'ok' }));
  check(progress.ok, `import from the plugin window (${Date.now() - t0}ms)`, progress.text);

  const got = await page.evaluate(() => ({
    frames: figma.currentPage.children.map((n) => ({ name: n.name, x: n.x, width: n.width, height: n.height })),
    responses: (window.__uiMessages || []).filter((m) => m.type === 'response' && /^ui-/.test(m.id)).map((m) => m.result || { error: m.error }),
    sizes: window.__uiSizes || [],
  }));
  const log = await uiFrame.$eval('#log', (el) => el.textContent);
  console.log(log.trim().split('\n').map((l) => '      ' + l).join('\n'));
  check(got.frames.length === 2 && /1440px$/.test(got.frames[0].name) && /390px$/.test(got.frames[1].name),
    'one frame per width, named after the file', got.frames.map((f) => `${f.name} ${f.width}×${f.height}`).join(' | '));
  check(got.frames.length === 2 && got.frames[1].x >= got.frames[0].x + got.frames[0].width, 'frames placed side by side');
  check(got.sizes.length > 0, 'plugin window resizes to its content', JSON.stringify(got.sizes.slice(-1)));

  const stored = await page.evaluate(() => figma.clientStorage.getAsync('importSettings'));
  check(stored && stored.widths.includes(390) && stored.widths.includes(1440), 'width choice is remembered', JSON.stringify(stored && stored.widths));

  // Same file through the MCP server's headless-Chrome capture, for comparison.
  const desktop = got.responses[0];
  const cap = await captureHtml({ source: htmlFile, width: 1440, height: 900 });
  const ref = await page.evaluate((n, a) => window.__send('create_nodes', { nodes: n, assets: a, x: 0, y: -5000 }), [cap.tree], cap.assets);
  const refCount = ref.result.layerCount;
  const diff = Math.abs(desktop.layerCount - refCount) / refCount;
  check(diff <= 0.05, 'layer count matches the MCP import (±5%)', `plugin ${desktop.layerCount}, server ${refCount}`);
  const missing = (r) => (r.warnings || []).filter((w) => /Missing image data/.test(w)).length;
  check(missing(desktop) <= missing(ref.result), 'every image and raster has data', `plugin ${missing(desktop)} missing, server ${missing(ref.result)}`);
  check(desktop.errors.length === 0, 'no layer errors', desktop.errors.slice(0, 3).join(' | '));

  // Render the plugin-built 1440 frame back to pixels for a visual check.
  await page.evaluate(() => {
    const f = figma.currentPage.children[0];
    window.__renderMock([f], f.x, f.y);
  });
  await page.setViewport({ width: 1440, height: 900 });
  const shot = path.join(outDir, `${base}-plugin-import.png`);
  await page.screenshot({ path: shot, fullPage: true });
  console.log('screenshot:', shot);
} finally {
  await browser.close();
  await closeBrowser();
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
