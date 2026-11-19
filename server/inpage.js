// Functions that run inside the rendered page, not in Node. Each one is
// serialized (page.evaluate() in capture.js, or inlined into the Figma plugin
// UI by scripts/build-plugin.js), so it must be fully self-contained.

// Wait for fonts, record CSS background image sizes and settle animations.
export async function settleInPage() {
  if (document.fonts) await document.fonts.ready;
  // Natural sizes of CSS background images (needed for background-size: auto).
  window.__bgSizes = {};
  const urls = new Set();
  for (const el of document.querySelectorAll('*')) {
    const bi = getComputedStyle(el).backgroundImage;
    if (!bi || !bi.includes('url(')) continue;
    for (const m of bi.matchAll(/url\("((?:[^"\\]|\\.)*)"\)/g)) urls.add(m[1].replace(/\\(["'\\])/g, '$1'));
  }
  await Promise.all([...urls].map((u) => new Promise((res) => {
    const im = new Image();
    im.onload = () => { window.__bgSizes[u] = [im.naturalWidth, im.naturalHeight]; res(); };
    im.onerror = () => res();
    setTimeout(res, 4000);
    im.src = u;
  })));
  // Jump finite animations to their end state, freeze infinite ones.
  for (const a of document.getAnimations ? document.getAnimations() : []) {
    try { a.finish(); } catch { a.pause(); a.currentTime = 0; }
  }
}

// Fetch every referenced image inside the page (so relative URLs, cookies and
// data: URIs all resolve the same way the page did) and normalize to PNG/JPEG/GIF,
// the only formats Figma's createImage accepts.
export function fetchImagesInPage(list) {
  const toB64 = (blob) =>
    new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1]);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  const loadImg = (src) =>
    new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('decode failed'));
      im.src = src;
    });
  // data: URLs are decoded here rather than fetched: the Figma plugin window's
  // content security policy may not allow fetch() of data: URLs.
  const load = async (url) => {
    const m = /^data:([^,]*?)(;base64)?,/i.exec(url);
    if (!m) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.blob();
    }
    const body = url.slice(m[0].length);
    let bytes;
    if (m[2]) {
      const bin = atob(body.replace(/\s+/g, ''));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      let text;
      try { text = decodeURIComponent(body); } catch { text = unescape(body); }
      bytes = new TextEncoder().encode(text);
    }
    return new Blob([bytes], { type: (m[1] || 'text/plain').split(';')[0] });
  };
  // Figma rejects images larger than 4096px on either side.
  const MAX = 4096;
  const fit = (w, h) => {
    const k = Math.min(1, MAX / Math.max(w, h));
    return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
  };
  return Promise.all(
    list.map(async ({ id, url }) => {
      try {
        const blob = await load(url);
        const type = (blob.type || '').toLowerCase();
        let bmp = null;
        if (!type.includes('svg')) {
          try { bmp = await createImageBitmap(blob); } catch { /* fall back to <img> decoding */ }
        }
        const tooBig = bmp && (bmp.width > MAX || bmp.height > MAX);
        if (/^image\/(png|jpeg|jpg|gif)$/.test(type) && !tooBig) {
          return { id, mime: type, data: await toB64(blob) };
        }
        if (bmp) {
          const [w, h] = fit(bmp.width, bmp.height);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(bmp, 0, 0, w, h);
          const jpeg = /jpe?g/.test(type);
          return { id, mime: jpeg ? 'image/jpeg' : 'image/png', data: c.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.92).split(',')[1] };
        }
        // SVG, ICO and anything createImageBitmap can't decode: rasterize via <img>.
        const objUrl = URL.createObjectURL(blob);
        try {
          const im = await loadImg(objUrl);
          let w = im.naturalWidth || 256, h = im.naturalHeight || 256;
          const isSvg = type.includes('svg');
          const k = isSvg ? Math.min(4, Math.max(2, 1024 / Math.max(w, h))) : 1;
          [w, h] = fit(w * k, h * k);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(im, 0, 0, w, h);
          return { id, mime: 'image/png', data: c.toDataURL('image/png').split(',')[1] };
        } finally {
          URL.revokeObjectURL(objUrl);
        }
      } catch (e) {
        return { id, error: String(e && e.message || e) };
      }
    })
  );
}

// Stand-in for page screenshots when there is no headless Chrome (imports run
// by the Figma plugin itself). Draws each raster region the walker asked for
// onto a canvas: <canvas>/<video> frames, native checkboxes, radios, range and
// color inputs, icon-font glyphs, and SVG fallbacks (from `svgs`, id -> markup).
// `elements` maps raster ids to elements (walkPage's rasterElements).
export async function rasterizeInPage(rasters, elements, svgs) {
  const SCALE = 2;
  const MAX = 4096;
  const px = (v) => parseFloat(v) || 0;
  const loadImg = (src) =>
    new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('SVG could not be decoded'));
      im.src = src;
    });
  const accentOf = (cs) => (cs.accentColor && cs.accentColor !== 'auto' ? cs.accentColor : '#0075ff');
  const roundRect = (g, x, y, w, h, r) => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };
  const cssString = (content) => {
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(content || '');
    return m ? m[1].replace(/\\(.)/g, '$1') : '';
  };
  const glyph = (g, cs, text, w, h) => {
    if (!text) return false;
    g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    g.fillStyle = cs.color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2);
    return true;
  };

  function drawElement(g, el, w, h) {
    const cs = getComputedStyle(el);
    const tag = el.tagName;
    if (tag === 'CANVAS' || tag === 'VIDEO') {
      const l = px(cs.borderLeftWidth) + px(cs.paddingLeft), t = px(cs.borderTopWidth) + px(cs.paddingTop);
      const r = px(cs.borderRightWidth) + px(cs.paddingRight), b = px(cs.borderBottomWidth) + px(cs.paddingBottom);
      g.drawImage(el, l, t, Math.max(1, w - l - r), Math.max(1, h - t - b));
      return;
    }
    if (tag === 'INPUT') {
      const type = el.type.toLowerCase();
      const accent = accentOf(cs);
      if (el.disabled) g.globalAlpha = 0.5;
      if (type === 'checkbox' || type === 'radio') {
        const s = Math.min(w, h), x = (w - s) / 2, y = (h - s) / 2;
        if (type === 'checkbox') {
          roundRect(g, x + 0.5, y + 0.5, s - 1, s - 1, Math.max(1, s * 0.15));
          g.fillStyle = el.checked || el.indeterminate ? accent : '#ffffff';
          g.fill();
          if (!el.checked && !el.indeterminate) { g.strokeStyle = '#767676'; g.lineWidth = 1; g.stroke(); }
          g.strokeStyle = '#ffffff';
          g.lineWidth = Math.max(1.5, s * 0.14);
          g.lineCap = 'round';
          g.lineJoin = 'round';
          g.beginPath();
          if (el.indeterminate) {
            g.moveTo(x + s * 0.28, y + s / 2); g.lineTo(x + s * 0.72, y + s / 2);
          } else if (el.checked) {
            g.moveTo(x + s * 0.25, y + s * 0.52); g.lineTo(x + s * 0.43, y + s * 0.7); g.lineTo(x + s * 0.76, y + s * 0.32);
          }
          g.stroke();
        } else {
          g.beginPath();
          g.arc(w / 2, h / 2, s / 2 - 0.75, 0, Math.PI * 2);
          g.fillStyle = '#ffffff';
          g.fill();
          g.strokeStyle = el.checked ? accent : '#767676';
          g.lineWidth = el.checked ? Math.max(1.5, s * 0.12) : 1;
          g.stroke();
          if (el.checked) {
            g.beginPath();
            g.arc(w / 2, h / 2, s * 0.25, 0, Math.PI * 2);
            g.fillStyle = accent;
            g.fill();
          }
        }
        return;
      }
      if (type === 'range') {
        const min = +el.min || 0, max = el.max === '' ? 100 : +el.max;
        const k = max > min ? Math.min(1, Math.max(0, (+el.value - min) / (max - min))) : 0;
        const th = Math.min(16, h), tr = Math.min(8, h / 4);
        const cx = th / 2 + (w - th) * k;
        roundRect(g, 0, h / 2 - tr / 2, w, tr, tr / 2);
        g.fillStyle = '#efefef';
        g.fill();
        roundRect(g, 0, h / 2 - tr / 2, cx, tr, tr / 2);
        g.fillStyle = accent;
        g.fill();
        g.beginPath();
        g.arc(cx, h / 2, th / 2, 0, Math.PI * 2);
        g.fill();
        return;
      }
      if (type === 'color') {
        roundRect(g, 0.5, 0.5, w - 1, h - 1, 2);
        g.fillStyle = '#efefef';
        g.fill();
        g.strokeStyle = '#767676';
        g.lineWidth = 1;
        g.stroke();
        g.fillStyle = el.value || '#000000';
        g.fillRect(5, 5, Math.max(1, w - 10), Math.max(1, h - 10));
        return;
      }
    }
    if (tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED') {
      throw new Error(`<${tag.toLowerCase()}> content can't be captured inside Figma`);
    }
    // Icon fonts: draw the ::before/::after glyphs, else the element's own
    // text (ligature icons like Material Icons).
    let drawn = false;
    for (const pseudo of ['::before', '::after']) {
      const pcs = getComputedStyle(el, pseudo);
      if (glyph(g, pcs, cssString(pcs.content), w, h)) drawn = true;
    }
    if (!drawn) drawn = el.children.length === 0 && glyph(g, cs, el.textContent.trim(), w, h);
    if (!drawn) throw new Error(`nothing to draw for <${tag.toLowerCase()}>`);
  }

  const out = [];
  for (const r of rasters) {
    const k = Math.min(SCALE, MAX / Math.max(r.width, r.height, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(r.width * k));
    c.height = Math.max(1, Math.round(r.height * k));
    const g = c.getContext('2d');
    g.scale(c.width / r.width, c.height / r.height);
    try {
      if (r.svg) {
        if (!svgs[r.id]) throw new Error('no SVG markup');
        const im = await loadImg('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgs[r.id]));
        g.drawImage(im, 0, 0, r.width, r.height);
      } else {
        if (!elements[r.id]) throw new Error('element not found');
        drawElement(g, elements[r.id], r.width, r.height);
      }
      out.push({ id: r.id, mime: 'image/png', data: c.toDataURL('image/png').split(',')[1] });
    } catch (e) {
      out.push({ id: r.id, error: String(e && e.message || e) });
    }
  }
  return out;
}
