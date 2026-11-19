// Resolves image/SVG references in node specs into data the plugin can decode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeImages } from './capture.js';

// Resolve `image` references (file paths / URLs / data URLs) and SVG file
// paths in a spec tree into an assets map the plugin can decode.
// Pixel size from PNG/GIF/JPEG headers; Figma rejects images over 4096px.
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'GIF') return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

function tooLarge(buf) {
  const s = imageSize(buf);
  return !!s && (s[0] > 4096 || s[1] > 4096);
}

export async function resolveAssets(specs) {
  const assets = {};
  const pending = [];
  let n = 0;

  const visitPaint = (p) => {
    if (p && typeof p === 'object' && p.type && String(p.type).toUpperCase() === 'IMAGE' && p.image) {
      const id = `a${n++}`;
      pending.push({ id, src: p.image });
      p.imageRef = id;
      delete p.image;
    }
  };
  const visit = (s) => {
    if (!s || typeof s !== 'object') return;
    if (s.image && typeof s.image === 'string') {
      const id = `a${n++}`;
      pending.push({ id, src: s.image });
      s.imageRef = id;
      delete s.image;
    }
    if (s.svg && typeof s.svg === 'string' && !s.svg.trim().startsWith('<')) {
      const p = path.resolve(s.svg.replace(/^~(?=\/)/, os.homedir()));
      s.svg = fs.readFileSync(p, 'utf8');
    }
    for (const key of ['fills', 'fill', 'strokes', 'stroke']) {
      const v = s[key];
      if (Array.isArray(v)) v.forEach(visitPaint);
      else visitPaint(v);
    }
    (s.children || []).forEach(visit);
  };
  specs.forEach(visit);
  if (!pending.length) return assets;

  const toConvert = [];
  for (const { id, src } of pending) {
    if (/^data:/i.test(src)) {
      const m = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (m && m[2] && /image\/(png|jpe?g|gif)/i.test(m[1] || '') && !tooLarge(Buffer.from(m[3].slice(0, 65536), 'base64'))) assets[id] = { mime: m[1], data: m[3] };
      else toConvert.push({ id, url: src });
    } else if (/^https?:/i.test(src)) {
      toConvert.push({ id, url: src });
    } else {
      const p = path.resolve(src.replace(/^~(?=\/)/, os.homedir()));
      if (!fs.existsSync(p)) throw new Error(`Image not found: ${p}`);
      const buf = fs.readFileSync(p);
      const ext = path.extname(p).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.svg': 'image/svg+xml', '.webp': 'image/webp', '.avif': 'image/avif' }[ext] || 'application/octet-stream';
      if (/png|jpeg|gif/.test(mime) && !tooLarge(buf)) assets[id] = { mime, data: buf.toString('base64') };
      else toConvert.push({ id, url: `data:${mime};base64,${buf.toString('base64')}` });
    }
  }
  if (toConvert.length) {
    const converted = await normalizeImages(toConvert);
    for (const c of converted) {
      if (c.error) throw new Error(`Could not load image ${toConvert.find((t) => t.id === c.id).url.slice(0, 100)}: ${c.error}`);
      assets[c.id] = { mime: c.mime, data: c.data };
    }
  }
  return assets;
}
