// Renders HTML in headless Chrome and converts it into a Figma node tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { walkPage } from './walker.js';
import { fetchImagesInPage, settleInPage } from './inpage.js';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

const IDLE_CLOSE_MS = 5 * 60 * 1000;
let browserPromise = null;
let idleTimer = null;

export function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error('No Chrome/Chromium found. Install Google Chrome or set CHROME_PATH.');
  }
  return found;
}

async function getBrowser() {
  clearTimeout(idleTimer);
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        executablePath: findChrome(),
        headless: true,
        userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'html-mcp-chrome-')),
        args: [
          '--disable-web-security',
          '--allow-file-access-from-files',
          '--font-render-hinting=none',
          '--hide-scrollbars',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      })
      .then((b) => {
        b.on('disconnected', () => { browserPromise = null; });
        return b;
      })
      .catch((e) => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = browserPromise;
    browserPromise = null;
    if (p) (await p).close().catch(() => {});
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

export async function closeBrowser() {
  clearTimeout(idleTimer);
  const p = browserPromise;
  browserPromise = null;
  if (p) await (await p).close().catch(() => {});
}

function resolveUrl(source) {
  if (/^(https?|file|data):/i.test(source)) return source;
  const abs = path.resolve(source.replace(/^~(?=\/)/, os.homedir()));
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return pathToFileURL(abs).href;
}

// Convert arbitrary image URLs / data URLs (SVG, WebP, remote…) into
// Figma-compatible PNG/JPEG/GIF base64. Used by create_design.
export async function normalizeImages(list) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto('about:blank');
    return await page.evaluate(fetchImagesInPage, list);
  } finally {
    await page.close().catch(() => {});
    scheduleIdleClose();
  }
}

async function settlePage(page) {
  await page.evaluate(settleInPage);
}

/**
 * Save the web fonts a page embeds/loads (@font-face) to `outDir` so they can
 * be installed locally and used by Figma. Returns the written files.
 */
export async function extractFonts({ source, html, outDir, families }) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setBypassCSP(true);
    if (html) await page.setContent(html, { waitUntil: 'networkidle2', timeout: 60000 });
    else await page.goto(resolveUrl(source), { waitUntil: 'networkidle2', timeout: 60000 });
    const faces = await page.evaluate(async (wanted) => {
      const out = [];
      const visit = (rules) => {
        for (const r of rules) {
          if (r instanceof CSSFontFaceRule) {
            const family = r.style.getPropertyValue('font-family').replace(/^["']|["']$/g, '').trim();
            if (wanted && wanted.length && !wanted.some((w) => w.toLowerCase() === family.toLowerCase())) continue;
            const src = r.style.getPropertyValue('src');
            const m = src.match(/url\(["']?((?:[^"'\\)]|\\.)*)["']?\)\s*(?:format\(["']?([\w-]+)["']?\))?/);
            if (m) out.push({ family, weight: r.style.getPropertyValue('font-weight') || '400', style: r.style.getPropertyValue('font-style') || 'normal', url: new URL(m[1], document.baseURI).href, format: m[2] || '' });
          } else if (r.cssRules) {
            try { visit(r.cssRules); } catch { /* cross-origin */ }
          }
        }
      };
      for (const sheet of document.styleSheets) {
        try { visit(sheet.cssRules); } catch { /* cross-origin sheet */ }
      }
      for (const f of out) {
        try {
          const resp = await fetch(f.url);
          const buf = new Uint8Array(await resp.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
          f.data = btoa(bin);
          f.mime = resp.headers.get('content-type') || '';
        } catch (e) {
          f.error = String(e.message || e);
        }
        if (f.url.startsWith('data:')) f.url = f.url.slice(0, 40) + '…';
      }
      return out;
    }, families || null);

    fs.mkdirSync(outDir, { recursive: true });
    const written = [];
    const skipped = [];
    for (const f of faces) {
      if (!f.data) { skipped.push(`${f.family} ${f.weight}: ${f.error || 'no data'}`); continue; }
      const bytes = Buffer.from(f.data, 'base64');
      const sig = bytes.subarray(0, 4).toString('latin1');
      const ext = sig === 'wOF2' ? 'woff2' : sig === 'wOFF' ? 'woff' : sig === 'OTTO' ? 'otf' : 'ttf';
      const safe = f.family.replace(/[^\w-]+/g, '');
      const file = path.join(outDir, `${safe}-${f.weight.replace(/\s+/g, '_')}${f.style === 'italic' ? '-Italic' : ''}.${ext}`);
      fs.writeFileSync(file, bytes);
      written.push({ file, family: f.family, weight: f.weight, style: f.style, format: ext });
    }
    return { written, skipped };
  } finally {
    await page.close().catch(() => {});
    scheduleIdleClose();
  }
}

/**
 * Render HTML and convert it into a Figma node tree.
 * @returns {Promise<{tree, assets, stats, warnings, preview?}>}
 */
export async function captureHtml({
  source,
  html,
  width = 1440,
  height = 900,
  fullPage = true,
  selector,
  javascript = true,
  waitMs = 600,
  colorScheme,
  svgFallbacks = true,
  preview = false,
}) {
  if (!source && !html) throw new Error('Provide either `source` (file path / URL) or `html`.');
  const browser = await getBrowser();
  const page = await browser.newPage();
  const warnings = [];
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    // Saved pages (e.g. SingleFile) ship a CSP that blocks fetch() of their own images.
    await page.setBypassCSP(true);
    await page.setJavaScriptEnabled(javascript);
    if (colorScheme) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: colorScheme }]);
    }
    page.on('pageerror', () => {});
    if (html) {
      await page.setContent(html, { waitUntil: 'networkidle2', timeout: 60000 });
    } else {
      await page.goto(resolveUrl(source), { waitUntil: 'networkidle2', timeout: 60000 });
    }
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    await settlePage(page);

    const result = await page.evaluate(walkPage, { selector, fullPage });

    // Raster captures (canvas/video/iframes/native controls, SVG fallbacks).
    const assets = {};
    for (const r of result.rasters) {
      if (r.width < 1 || r.height < 1) continue;
      if (r.svg && !svgFallbacks) continue;
      try {
        const data = await page.screenshot({
          clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 2 },
          omitBackground: true,
          encoding: 'base64',
          captureBeyondViewport: true,
        });
        assets[r.id] = { mime: 'image/png', data };
      } catch (e) {
        warnings.push(`Could not rasterize ${r.id}: ${e.message}`);
      }
    }

    if (result.images.length) {
      const fetched = await page.evaluate(fetchImagesInPage, result.images);
      for (const f of fetched) {
        if (f.error) {
          warnings.push(`Image ${result.images.find((i) => i.id === f.id)?.url.slice(0, 120)} failed: ${f.error}`);
          continue;
        }
        assets[f.id] = { mime: f.mime, data: f.data };
      }
    }

    let previewPng;
    if (preview) {
      previewPng = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 70, fullPage: false });
    }

    return { tree: result.tree, assets, stats: result.stats, warnings, preview: previewPng };
  } finally {
    await page.close().catch(() => {});
    scheduleIdleClose();
  }
}
