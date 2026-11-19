// Full-chain test: MCP client --stdio--> server --WebSocket--> "plugin"
// (mock Figma API + the real figma-plugin/code.js, running in headless Chrome).
// Also starts a second server instance to verify peer relaying.
//
// Usage: node test/e2e-mcp.js [file.html] [outDir]   (defaults to test/fixtures/features.html)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import puppeteer from 'puppeteer-core';
import { findChrome } from '../server/capture.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlFile = path.resolve(process.argv[2] || path.join(root, 'test/fixtures/features.html'));
const outDir = process.argv[3] || path.join(root, 'test', 'out');
const PORT = '3999';
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};
const textOf = (r) => (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function startClient(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'server/index.js')],
    env: { ...process.env, HTML_MCP_PORT: PORT },
    stderr: 'pipe',
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  transport.stderr?.on('data', (d) => process.env.DEBUG && process.stderr.write(`[${name}] ${d}`));
  return client;
}

const host = await startClient('host');
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
});
try {
  const tools = await host.listTools();
  check(tools.tools.length >= 14, 'tools/list', tools.tools.map((t) => t.name).join(', '));

  let r = await host.callTool({ name: 'figma_status', arguments: {} });
  check(textOf(r).includes('"connected": false'), 'status before plugin connects');

  r = await host.callTool({ name: 'get_document_info', arguments: {} });
  check(r.isError && textOf(r).includes('not connected'), 'clear error when plugin is missing');

  // Fake plugin: mock Figma + real code.js, relayed over a real WebSocket.
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: path.join(root, 'test/mock-figma.js') });
  await page.addScriptTag({ path: path.join(root, 'figma-plugin/code.js') });
  await page.evaluate((port) => new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:' + port);
    figma.ui.postMessage = (msg) => { if (ws.readyState === 1 && msg.type !== 'log') ws.send(JSON.stringify(msg)); };
    ws.onmessage = (e) => figma.ui.onmessage(JSON.parse(e.data));
    ws.onopen = () => { figma.ui.onmessage({ type: 'ui-connected' }); setTimeout(resolve, 200); };
  }), PORT);

  r = await host.callTool({ name: 'figma_status', arguments: {} });
  check(textOf(r).includes('"connected": true') && textOf(r).includes('Mock File'), 'status after plugin connects');

  r = await host.callTool({ name: 'import_html', arguments: { source: htmlFile, dryRun: true } });
  check(!r.isError && r.content.some((c) => c.type === 'image'), 'import_html dryRun returns stats + preview', textOf(r).split('\n')[0]);

  const t0 = Date.now();
  r = await host.callTool({ name: 'import_html', arguments: { source: htmlFile, widths: [1440, 390] } });
  const imp = textOf(r);
  check(!r.isError && (imp.match(/Created FRAME/g) || []).length === 2, `import_html desktop+mobile (${Date.now() - t0}ms)`, imp.split('\n').filter((l) => /Created|Layers|Fonts|errors/.test(l)).join(' | '));

  r = await host.callTool({ name: 'get_document_info', arguments: {} });
  const firstFrame = JSON.parse(textOf(r)).topLevelNodes[0].id;
  r = await host.callTool({ name: 'get_node', arguments: { id: firstFrame, depth: 50 } });
  const truncated = [];
  (function walk(n) { if (n.truncate) truncated.push(n); (n.children || []).forEach(walk); })(JSON.parse(textOf(r)));
  check(!htmlFile.endsWith('features.html') || truncated.length > 0, 'ellipsis text keeps truncation', truncated.map((n) => n.text).join(', '));

  const design = JSON.parse(fs.readFileSync(path.join(root, 'test/design-sample.json'), 'utf8'));
  r = await host.callTool({ name: 'create_design', arguments: { nodes: design } });
  const created = textOf(r);
  const frameId = (created.match(/id=(\S+)/) || [])[1];
  check(!r.isError && !!frameId, 'create_design', created.split('\n')[0]);

  r = await host.callTool({ name: 'get_node', arguments: { id: frameId, depth: 3 } });
  const tree = JSON.parse(textOf(r));
  const card = tree.children[0];
  check(card.layout?.mode === 'VERTICAL' && card.layout.gap === 20, 'get_node reports auto layout', JSON.stringify(card.layout));
  const textNode = card.children[1].children[1];
  check(textNode.type === 'TEXT' && textNode.autoResize === 'HEIGHT', 'FILL text switched to auto-height', textNode.autoResize);

  r = await host.callTool({ name: 'update_node', arguments: { id: textNode.id, props: { text: 'Texto actualizado', fontWeight: 700, color: '#ff0000' } } });
  check(!r.isError && textOf(r).includes('Texto actualizado') && textOf(r).includes('Bold'), 'update_node text + font weight', textOf(r).slice(0, 120).replace(/\s+/g, ' '));

  r = await host.callTool({ name: 'export_image', arguments: { id: frameId } });
  check(!r.isError && r.content[0].type === 'image', 'export_image returns an image');

  const glow = card.children.find((c) => c.name === 'Glow');
  r = await host.callTool({ name: 'update_node', arguments: { id: glow.id, props: { x: 300 } } });
  check(JSON.parse(textOf(r)).node.x === 300, 'update_node moves an absolute child of an auto-layout frame');

  r = await host.callTool({ name: 'clone_node', arguments: { id: card.id, x: 0, y: 0 } });
  const cloneId = JSON.parse(textOf(r)).id;
  check(!!cloneId, 'clone_node');
  r = await host.callTool({ name: 'delete_nodes', arguments: { ids: [cloneId] } });
  check(JSON.parse(textOf(r)).deleted[0] === cloneId, 'delete_nodes');

  r = await host.callTool({ name: 'create_component', arguments: { id: card.id, name: 'Card/Login' } });
  const compId = JSON.parse(textOf(r)).id;
  r = await host.callTool({ name: 'create_design', arguments: { nodes: [{ type: 'INSTANCE', componentId: compId }] } });
  check(!r.isError && textOf(r).includes('Created INSTANCE'), 'create_component + INSTANCE');

  r = await host.callTool({ name: 'create_page', arguments: { name: 'Explorations' } });
  check(!r.isError && textOf(r).includes('Explorations'), 'create_page');
  r = await host.callTool({ name: 'switch_page', arguments: { name: 'Page 1' } });
  check(!r.isError, 'switch_page');
  r = await host.callTool({ name: 'select_nodes', arguments: { ids: [frameId] } });
  check(!r.isError, 'select_nodes');
  r = await host.callTool({ name: 'get_selection', arguments: {} });
  check(textOf(r).includes(frameId), 'get_selection');
  r = await host.callTool({ name: 'get_document_info', arguments: {} });
  check(JSON.parse(textOf(r)).pages.length === 2, 'get_document_info');

  r = await host.callTool({ name: 'create_design', arguments: { nodes: [{ type: 'TEXT', text: 'x', color: 'notacolor' }] } });
  check(textOf(r).includes('Invalid color'), 'bad input reported, not crashing', textOf(r).split('\n').find((l) => l.includes('Invalid')));

  // Second Claude session -> peer relayed through the host.
  const peer = await startClient('peer');
  r = await peer.callTool({ name: 'figma_status', arguments: {} });
  check(textOf(r).includes('"mode": "peer"') && textOf(r).includes('"connected": true'), 'second MCP instance relays via host');
  r = await peer.callTool({ name: 'create_design', arguments: { nodes: [{ type: 'RECTANGLE', width: 50, height: 50, fills: ['#6366F1'] }] } });
  check(!r.isError && textOf(r).includes('Created RECTANGLE'), 'peer create_design');
  await peer.close();

  const fontsDir = path.join(outDir, 'fonts');
  r = await host.callTool({ name: 'extract_fonts', arguments: { source: htmlFile, outDir: fontsDir } });
  check(!r.isError, 'extract_fonts', textOf(r).split('\n')[0]);

  await page.addScriptTag({ path: path.join(root, 'test/render-mock.js') });
  await page.evaluate(() => window.__renderMock(figma.currentPage.children.slice(0, 2), 0, 0));
  await page.setViewport({ width: 1440 + 390 + 120, height: 900 });
  await page.screenshot({ path: path.join(outDir, 'e2e-import.png'), fullPage: true });
} finally {
  await browser.close();
  await host.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
