// Screenshot a page as the browser renders it (for comparing with imports).
// Usage: node test/screenshot.js <file.html|url> <out.png> [width] [height]
import puppeteer from 'puppeteer-core';
import { findChrome } from '../server/capture.js';
import { pathToFileURL } from 'node:url';
const [src, out, w = 1440, h = 900] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--hide-scrollbars','--font-render-hinting=none'] });
const p = await b.newPage();
await p.setViewport({ width: +w, height: +h });
await p.goto(src.startsWith('file:') ? src : pathToFileURL(src).href, { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 600));
await p.screenshot({ path: out, fullPage: true });
await b.close();
