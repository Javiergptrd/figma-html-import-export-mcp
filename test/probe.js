// Dev helper: run a probe function (CommonJS module exporting a function) inside a rendered page.
// Usage: node test/probe.js <file.html> <probe.cjs> [width]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from '../server/capture.js';
const [file, probePath, width = '1440'] = process.argv.slice(2);
const fn = createRequire(import.meta.url)(probePath);
const b = await puppeteer.launch({ executablePath: findChrome(), headless: true });
const p = await b.newPage();
await p.setViewport({ width: +width, height: 900 });
await p.setBypassCSP(true);
await p.goto(pathToFileURL(file).href, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 600));
console.log(JSON.stringify(await p.evaluate(fn), null, 1));
await b.close();
