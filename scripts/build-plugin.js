#!/usr/bin/env node
// Copies the in-page capture code (server/walker.js, server/inpage.js) into
// figma-plugin/ui.html, so the plugin can import HTML without the MCP server.
// Figma loads ui.html as a single file, so the code has to be inlined.
//
// Usage: node scripts/build-plugin.js [--check]
//   --check  exit 1 if ui.html is out of date instead of writing it
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkPage } from '../server/walker.js';
import { fetchImagesInPage, rasterizeInPage, settleInPage } from '../server/inpage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiPath = path.join(root, 'figma-plugin/ui.html');
const BEGIN = '// <generated>';
const END = '// </generated>';

const code = [walkPage, settleInPage, fetchImagesInPage, rasterizeInPage].map(String).join('\n\n');
if (/<\/script/i.test(code)) throw new Error('Inlined code must not contain "</script"');

const ui = fs.readFileSync(uiPath, 'utf8');
const a = ui.indexOf(BEGIN);
const b = ui.indexOf(END);
if (a < 0 || b < a) throw new Error(`${uiPath} has no ${BEGIN} … ${END} block`);
const lineEnd = ui.indexOf('\n', a) + 1;
const out = ui.slice(0, lineEnd) + code + '\n' + ui.slice(b);

if (process.argv.includes('--check')) {
  if (out !== ui) {
    console.error('figma-plugin/ui.html is out of date: run `npm run build`.');
    process.exit(1);
  }
  console.log('figma-plugin/ui.html is up to date.');
} else {
  fs.writeFileSync(uiPath, out);
  console.log(`Updated figma-plugin/ui.html (${Math.round(code.length / 1024)} KB of capture code).`);
}
