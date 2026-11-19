// In-page DOM walker. This function is serialized and executed inside the
// headless browser via page.evaluate(), so it must be fully self-contained
// (no references to module scope).
//
// It converts the rendered page into the same JSON node spec the Figma
// plugin consumes for create_design (see README), using absolute page
// coordinates which the caller converts to parent-relative ones.

export function walkPage(opts) {
  const options = Object.assign(
    { selector: null, maxNodes: 20000, rasterizeNativeControls: true, fullPage: true, collectRasterElements: false },
    opts || {}
  );

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT',
    'TEMPLATE', 'BASE', 'SOURCE', 'TRACK', 'PARAM', 'MAP', 'AREA', 'DATALIST',
  ]);
  const ICON_FONT_RE = /icon|awesome|material|glyph|symbols|fontello|ionicons|feather|remixicon/i;

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const rasters = []; // { id, x, y, width, height } screenshot later
  const rasterElements = {}; // raster id -> element, when options.collectRasterElements
  const images = new Map(); // url -> id
  const stats = { elements: 0, frames: 0, texts: 0, svgs: 0, images: 0, rasters: 0, truncated: false };
  let nodeCount = 0;

  // ---------- colors ----------
  const colorCache = new Map();
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = 1;
  const cctx = cnv.getContext('2d', { willReadFrequently: true });
  const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

  // Returns "#rrggbb" / "#rrggbbaa", or null when fully transparent.
  function normColor(str) {
    if (!str || str === 'transparent' || str === 'none') return null;
    if (colorCache.has(str)) return colorCache.get(str);
    let r, g, b, a = 1;
    const m = str.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) {
      r = +m[1]; g = +m[2]; b = +m[3];
      if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
    } else {
      // Any other CSS color syntax (oklch, color(), hsl, named...): rasterize it.
      cctx.clearRect(0, 0, 1, 1);
      cctx.fillStyle = '#000';
      cctx.fillStyle = str;
      cctx.fillRect(0, 0, 1, 1);
      const d = cctx.getImageData(0, 0, 1, 1).data;
      r = d[0]; g = d[1]; b = d[2]; a = d[3] / 255;
    }
    let out = null;
    if (a > 0.003) {
      out = '#' + hex2(r) + hex2(g) + hex2(b) + (a < 0.998 ? hex2(a * 255) : '');
    }
    colorCache.set(str, out);
    return out;
  }

  // ---------- small parsers ----------
  const px = (v) => parseFloat(v) || 0;

  // Split on a top-level separator (ignoring ones nested in parentheses or quotes).
  function splitTop(str, sep) {
    const out = [];
    let depth = 0, cur = '', quote = null, esc = false;
    for (const ch of str) {
      if (quote) {
        cur += ch;
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // Split a space-separated token list, keeping function calls together.
  function splitSpaces(str) { return splitTop(str.replace(/\s+/g, ' '), ' '); }

  function isColorToken(t) {
    return /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i.test(t) || /^#/.test(t) ||
      /^(transparent|currentcolor|[a-z]+)$/i.test(t) && !/^(inset|to|left|right|top|bottom|center|circle|ellipse|closest|farthest)/i.test(t);
  }

  function parseShadows(value, isText) {
    if (!value || value === 'none') return [];
    const effects = [];
    for (const part of splitTop(value, ',')) {
      const toks = splitSpaces(part);
      let inset = false, color = null;
      const lens = [];
      for (const t of toks) {
        if (t === 'inset') inset = true;
        else if (/^-?[\d.]+(px)?$/.test(t)) lens.push(px(t));
        else color = t;
      }
      const c = normColor(color || 'rgb(0,0,0)');
      if (!c) continue;
      const [x = 0, y = 0, blur = 0, spread = 0] = lens;
      if (!x && !y && !blur && !spread) continue;
      effects.push({
        type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
        color: c, x, y, blur, spread: isText ? 0 : spread,
      });
    }
    // CSS paints the first shadow on top; Figma paints the last effect on top.
    return effects.reverse();
  }

  function angleFromDirection(dir) {
    dir = dir.trim();
    let m;
    if ((m = dir.match(/^(-?[\d.]+)(deg|turn|rad|grad)$/))) {
      const v = +m[1];
      return m[2] === 'deg' ? v : m[2] === 'turn' ? v * 360 : m[2] === 'rad' ? v * 180 / Math.PI : v * 0.9;
    }
    if (dir.startsWith('to ')) {
      const s = dir.slice(3).split(/\s+/).sort().join(' ');
      const map = {
        top: 0, right: 90, bottom: 180, left: 270,
        'right top': 45, 'bottom right': 135, 'bottom left': 225, 'left top': 315,
      };
      if (s in map) return map[s];
    }
    return null;
  }

  function parseStops(parts, lineLength) {
    const stops = [];
    for (const p of parts) {
      const toks = splitSpaces(p);
      const color = normColor(toks[0]);
      const positions = toks.slice(1).map((t) =>
        t.endsWith('%') ? parseFloat(t) / 100 : lineLength ? px(t) / lineLength : null
      );
      if (!positions.length) positions.push(null);
      for (const pos of positions) stops.push({ color: color || '#00000000', position: pos });
    }
    if (!stops.length) return stops;
    // Fill in missing positions (CSS: evenly distributed between known ones).
    if (stops[0].position == null) stops[0].position = 0;
    if (stops[stops.length - 1].position == null) stops[stops.length - 1].position = 1;
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].position != null) continue;
      let j = i;
      while (stops[j].position == null) j++;
      const a = stops[i - 1].position, b = stops[j].position;
      for (let k = i; k < j; k++) stops[k].position = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    }
    for (let i = 1; i < stops.length; i++) {
      stops[i].position = Math.max(stops[i].position, stops[i - 1].position);
    }
    stops.forEach((s) => (s.position = Math.max(0, Math.min(1, s.position))));
    return stops;
  }

  function parseGradient(str, w, h) {
    const m = str.match(/^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/s);
    if (!m) return null;
    const args = splitTop(m[3], ',');
    if (m[2] === 'linear') {
      let angle = 180;
      const a = angleFromDirection(args[0]);
      if (a != null) { angle = a; args.shift(); }
      else if (/^to /.test(args[0])) {
        // Corner directions depend on the box aspect ratio.
        const d = args.shift().slice(3);
        const deg = Math.atan2(w, h) * 180 / Math.PI;
        angle = /top/.test(d) ? (/right/.test(d) ? deg : 360 - deg) : (/right/.test(d) ? 180 - deg : 180 + deg);
      }
      const rad = angle * Math.PI / 180;
      const len = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
      return { type: 'GRADIENT_LINEAR', angle, stops: parseStops(args, len) };
    }
    if (m[2] === 'radial') {
      if (!isColorToken(splitSpaces(args[0])[0])) args.shift();
      // CSS default extent is farthest-corner: sqrt(2) x the inscribed ellipse.
      return { type: 'GRADIENT_RADIAL', radius: Math.SQRT2, stops: parseStops(args, Math.max(w, h) / 2) };
    }
    // conic -> angular
    if (!isColorToken(splitSpaces(args[0])[0])) args.shift();
    return { type: 'GRADIENT_ANGULAR', stops: parseStops(args.map((s) => s.replace(/-?[\d.]+deg/g, (d) => (parseFloat(d) / 3.6) + '%')), 0) };
  }

  function imageRef(url) {
    if (!url) return null;
    if (!images.has(url)) images.set(url, 'img' + images.size);
    return images.get(url);
  }

  function cssUrl(layer) {
    const m = layer.match(/^url\((.*)\)$/s);
    if (!m) return null;
    let u = m[1].trim();
    if ((u[0] === '"' || u[0] === "'") && u[u.length - 1] === u[0]) u = u.slice(1, -1).replace(/\\(["'\\])/g, '$1');
    return u;
  }

  // Resolve one axis of background-position for an image of length `img`
  // inside a box of length `box`.
  function bgPos(val, box, img) {
    val = (val || '0%').trim();
    let m;
    if ((m = val.match(/^calc\(\s*([\d.]+)%\s*([+-])\s*([\d.]+)px\s*\)$/))) {
      return (box - img) * (+m[1] / 100) + (m[2] === '-' ? -1 : 1) * +m[3];
    }
    const toks = val.split(/\s+/);
    let from = 'start', off = null;
    for (const t of toks) {
      if (t === 'left' || t === 'top') from = 'start';
      else if (t === 'right' || t === 'bottom') from = 'end';
      else if (t === 'center') { from = 'start'; off = (box - img) / 2; }
      else if (t.endsWith('%')) off = (box - img) * (parseFloat(t) / 100);
      else off = px(t);
    }
    if (off == null) off = 0;
    return from === 'end' ? box - img - off : off;
  }

  function bgSize(val, box, natural) {
    // returns [w, h] for explicit/auto sizes, or null for cover/contain
    if (/cover|contain/.test(val)) return null;
    const [nw, nh] = natural || [box.w, box.h];
    const toks = (val || 'auto').split(/\s+/);
    const conv = (t, len) => (t === 'auto' ? null : t.endsWith('%') ? (parseFloat(t) / 100) * len : px(t));
    let w = conv(toks[0], box.w);
    let h = conv(toks[1] || 'auto', box.h);
    if (w == null && h == null) { w = nw; h = nh; }
    else if (w == null) w = nh ? (h * nw) / nh : h;
    else if (h == null) h = nw ? (w * nh) / nw : w;
    return [w, h];
  }

  // Returns { fills, layers }: simple backgrounds become fills; positioned,
  // non-repeating images (icons, chevrons) become separate image layers.
  function parseBackground(cs, w, h) {
    const fills = [];
    const layers = [];
    const bg = normColor(cs.backgroundColor);
    if (bg) fills.push({ type: 'SOLID', color: bg });
    const bi = cs.backgroundImage;
    if (bi && bi !== 'none') {
      const imgs = splitTop(bi, ',');
      const sizes = splitTop(cs.backgroundSize || '', ',');
      const repeats = splitTop(cs.backgroundRepeat || '', ',');
      const posX = splitTop(cs.backgroundPositionX || '', ',');
      const posY = splitTop(cs.backgroundPositionY || '', ',');
      const bl = px(cs.borderLeftWidth), bt = px(cs.borderTopWidth);
      const box = { w: w - bl - px(cs.borderRightWidth), h: h - bt - px(cs.borderBottomWidth) };
      // CSS: first layer on top. Figma: last fill on top.
      for (let i = imgs.length - 1; i >= 0; i--) {
        const layer = imgs[i];
        const url = cssUrl(layer);
        if (url) {
          const ref = imageRef(url);
          const size = sizes[i] || sizes[0] || 'auto';
          const rep = repeats[i] || repeats[0] || 'repeat';
          const natural = (window.__bgSizes || {})[url];
          const dims = bgSize(size, box, natural);
          if (!dims) {
            fills.push({ type: 'IMAGE', imageRef: ref, scaleMode: size === 'contain' ? 'FIT' : 'FILL' });
          } else if (/no-repeat/.test(rep) || (dims[0] >= box.w - 1 && dims[1] >= box.h - 1)) {
            const x = bgPos(posX[i] || posX[0], box.w, dims[0]);
            const y = bgPos(posY[i] || posY[0], box.h, dims[1]);
            // SVG backgrounds scale with preserveAspectRatio "meet" (= FIT).
            const isSvg = /^data:image\/svg|\.svg(\?|#|$)/i.test(url);
            if (dims[0] > 0.5 && dims[1] > 0.5) layers.push({ x: bl + x, y: bt + y, width: dims[0], height: dims[1], imageRef: ref, scaleMode: isSvg ? 'FIT' : 'FILL' });
          } else {
            fills.push({ type: 'IMAGE', imageRef: ref, scaleMode: 'TILE' });
          }
          continue;
        }
        const g = parseGradient(layer, w, h);
        if (g && g.stops.length) fills.push(g);
      }
    }
    return { fills, layers };
  }

  function parseRadius(v, w, h) {
    if (!v) return 0;
    const first = v.split(' ')[0];
    if (first.endsWith('%')) return (parseFloat(first) / 100) * Math.min(w, h);
    return px(first);
  }

  // Figma allows one stroke paint per layer. The heaviest border side defines
  // it; sides with a different color/style are returned as `extra` and drawn
  // as separate edge layers.
  function borderInfo(cs) {
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    const found = [];
    for (const s of sides) {
      const st = cs['border' + s + 'Style'];
      const wdt = st === 'none' || st === 'hidden' ? 0 : px(cs['border' + s + 'Width']);
      const c = wdt ? normColor(cs['border' + s + 'Color']) : null;
      if (c && wdt) found.push({ side: s.toLowerCase(), color: c, style: st, weight: wdt });
    }
    if (!found.length) return null;
    const primary = found.reduce((a, b) => (b.weight > a.weight ? b : a));
    const same = (f) => f.color === primary.color && (f.style === primary.style || (f.style !== 'dashed' && f.style !== 'dotted' && primary.style !== 'dashed' && primary.style !== 'dotted'));
    const weights = { top: 0, right: 0, bottom: 0, left: 0 };
    const extra = [];
    for (const f of found) {
      if (same(f)) weights[f.side] = f.weight;
      else extra.push(f);
    }
    return { color: primary.color, style: primary.style, weights, extra };
  }

  function borderEdgeLayers(extra, rect) {
    return extra.map((f) => {
      const w = rect.width, h = rect.height, t = f.weight;
      const dashed = f.style === 'dashed' || f.style === 'dotted';
      const horizontal = f.side === 'top' || f.side === 'bottom';
      const ox = f.side === 'right' ? w - t : 0;
      const oy = f.side === 'bottom' ? h - t : 0;
      const abs = { x: rect.left + scrollX + ox, y: rect.top + scrollY + oy };
      if (dashed && horizontal) {
        return {
          type: 'LINE', name: `border-${f.side}`,
          _abs: { x: abs.x, y: abs.y + t / 2 }, width: w, height: 0,
          strokes: [{ type: 'SOLID', color: f.color }], strokeWeight: t,
          dashPattern: f.style === 'dotted' ? [t, t] : [Math.max(2, t) * 2, Math.max(2, t)],
        };
      }
      return {
        type: 'RECTANGLE', name: `border-${f.side}`, _abs: abs,
        width: horizontal ? w : t, height: horizontal ? t : h,
        fills: [{ type: 'SOLID', color: f.color }],
      };
    });
  }

  // ---------- SVG serialization ----------
  const SVG_PROPS = [
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
    'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
    'stroke-miterlimit', 'clip-rule', 'opacity', 'stop-color', 'stop-opacity',
    'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline',
  ];
  const SVG_DEFAULTS = {
    'fill-opacity': '1', 'stroke-opacity': '1', opacity: '1', 'stroke-dasharray': 'none',
    'stroke-dashoffset': '0px', 'stroke-miterlimit': '4', 'fill-rule': 'nonzero', 'clip-rule': 'nonzero',
    'stroke-linecap': 'butt', 'stroke-linejoin': 'miter', 'text-anchor': 'start', 'dominant-baseline': 'auto',
  };

  function serializeSvg(svg, rect) {
    const clone = svg.cloneNode(true);
    const origs = [svg, ...svg.querySelectorAll('*')];
    const clones = [clone, ...clone.querySelectorAll('*')];
    for (let i = origs.length - 1; i >= 0; i--) {
      const o = origs[i], c = clones[i];
      const cs = getComputedStyle(o);
      if (cs.display === 'none' && !/^(defs|symbol|clipPath|mask|linearGradient|radialGradient|stop|pattern|marker)$/i.test(o.tagName)) {
        c.remove();
        continue;
      }
      if (/^(style|script|title|desc|metadata)$/i.test(o.tagName)) { c.remove(); continue; }
      for (const p of SVG_PROPS) {
        let v = cs.getPropertyValue(p);
        if (!v || SVG_DEFAULTS[p] === v) continue;
        if (/^(fill|stroke|stop-color)$/.test(p) && /^(rgb|#)/.test(v)) {
          const nc = normColor(v);
          if (!nc) v = 'none';
          else if (nc.length === 9) {
            // Split alpha into the *-opacity attribute (Figma ignores 8-digit hex in SVG).
            v = nc.slice(0, 7);
            const opAttr = p === 'stop-color' ? 'stop-opacity' : p + '-opacity';
            c.setAttribute(opAttr, String(parseInt(nc.slice(7), 16) / 255 * parseFloat(cs.getPropertyValue(opAttr) || '1')));
          } else v = nc;
        }
        c.setAttribute(p, v);
      }
      c.removeAttribute('class');
      c.removeAttribute('style');
    }
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clone.getAttribute('viewBox')) {
      const vb = svg.viewBox && svg.viewBox.baseVal;
      if (vb && vb.width) clone.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
      else clone.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    }
    clone.setAttribute('width', String(rect.width));
    clone.setAttribute('height', String(rect.height));
    return new XMLSerializer().serializeToString(clone);
  }

  // ---------- text ----------
  function fontInfo(cs) {
    const families = cs.fontFamily.split(',').map((f) => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    const size = px(cs.fontSize);
    const lh = cs.lineHeight === 'normal' ? 'auto' : px(cs.lineHeight);
    const ls = cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing);
    const tt = cs.textTransform;
    const deco = cs.textDecorationLine || '';
    let align = cs.textAlign;
    const rtl = cs.direction === 'rtl';
    if (align === 'start') align = rtl ? 'right' : 'left';
    if (align === 'end') align = rtl ? 'left' : 'right';
    if (align === '-webkit-center') align = 'center';
    return {
      fontFamily: families[0] || 'Inter',
      fontFallbacks: families.slice(1),
      fontWeight: parseInt(cs.fontWeight, 10) || 400,
      italic: cs.fontStyle === 'italic' || cs.fontStyle.startsWith('oblique'),
      fontSize: size,
      lineHeight: lh,
      letterSpacing: ls,
      textCase: tt === 'uppercase' ? 'UPPER' : tt === 'lowercase' ? 'LOWER' : tt === 'capitalize' ? 'TITLE' : undefined,
      textDecoration: deco.includes('underline') ? 'UNDERLINE' : deco.includes('line-through') ? 'STRIKETHROUGH' : undefined,
      textAlign: align === 'center' ? 'CENTER' : align === 'right' ? 'RIGHT' : align === 'justify' ? 'JUSTIFIED' : 'LEFT',
    };
  }

  function lineCount(rects) {
    const tops = [];
    for (const r of rects) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      if (!tops.some((t) => Math.abs(t - r.top) < r.height * 0.5)) tops.push(r.top);
    }
    return tops.length;
  }

  function makeText(chars, cs, box, lines, color) {
    const fi = fontInfo(cs);
    // `line-height: normal` depends on font metrics; pin it to what the browser
    // rendered so a substituted font in Figma keeps the same vertical rhythm.
    if (fi.lineHeight === 'auto') fi.lineHeight = Math.round((box.height / Math.max(1, lines)) * 100) / 100;
    const lh = fi.lineHeight;
    // Browser text rects cover the font content area; Figma text boxes cover
    // the full line box. Expand by the half-leading so baselines line up.
    let y = box.top, height = box.height;
    if (lh && lines > 0) {
      const contentH = box.height / lines;
      const halfLeading = (lh - contentH) / 2;
      y -= halfLeading;
      height = lh * lines;
    }
    const node = Object.assign({
      type: 'TEXT',
      text: chars,
      _abs: { x: box.left + scrollX, y: y + scrollY },
      width: box.width,
      height,
      color,
    }, fi);
    if (lines <= 1) {
      node.autoResize = 'WIDTH_AND_HEIGHT';
      node.textAnchor = fi.textAlign === 'CENTER' ? 'CENTER' : fi.textAlign === 'RIGHT' ? 'RIGHT' : 'LEFT';
      node.textAlign = 'LEFT';
    } else {
      node.autoResize = 'HEIGHT';
      node.width = box.width + 1;
    }
    if (cs.textShadow && cs.textShadow !== 'none') node.effects = parseShadows(cs.textShadow, true);
    stats.texts++;
    nodeCount++;
    return node;
  }

  function collapseWs(text, ws) {
    if (/^(pre|pre-wrap|break-spaces)$/.test(ws)) return text;
    if (ws === 'pre-line') return text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
    return text.replace(/\s+/g, ' ').trim();
  }

  function textColor(cs) {
    return normColor(cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color ? cs.webkitTextFillColor : cs.color);
  }

  // A text node that starts mid-line (after an inline sibling) and wraps can't
  // be one Figma text box; emit one single-line text layer per rendered line.
  function splitByLines(tn, cs, color) {
    const text = tn.nodeValue;
    const r = document.createRange();
    const out = [];
    let start = 0, top = null;
    const flush = (end) => {
      if (end <= start) return;
      r.setStart(tn, start); r.setEnd(tn, end);
      const b = r.getBoundingClientRect();
      const chars = collapseWs(text.slice(start, end), cs.whiteSpace);
      if (chars && b.width > 0.5) out.push(makeText(chars, cs, b, 1, color));
    };
    for (let i = 0; i < text.length; i++) {
      r.setStart(tn, i); r.setEnd(tn, i + 1);
      const rr = r.getClientRects()[0];
      if (!rr || rr.height < 0.5) continue;
      if (top == null) top = rr.top;
      else if (rr.top > top + rr.height * 0.5) { flush(i); start = i; top = rr.top; }
    }
    flush(text.length);
    return out;
  }

  function textNodeToSpecs(tn, cs) {
    const raw = tn.nodeValue;
    if (!raw || !raw.trim()) return [];
    const range = document.createRange();
    range.selectNodeContents(tn);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width >= 0.5 && r.height >= 0.5);
    const box = range.getBoundingClientRect();
    if (box.width < 0.5 || box.height < 0.5 || !rects.length) return [];
    const color = textColor(cs);
    if (!color) return [];
    const chars = collapseWs(raw, cs.whiteSpace);
    if (!chars) return [];
    const lines = lineCount(rects);
    if (lines > 1 && rects[0].left > box.left + 1) return splitByLines(tn, cs, color);
    return [makeText(chars, cs, box, lines, color)];
  }

  // ---------- merged inline text (one Figma text layer with styled ranges) ----------
  const INLINE_BLOCKERS = /^(IMG|INPUT|BUTTON|SELECT|TEXTAREA|CANVAS|VIDEO|IFRAME|OBJECT|EMBED|PICTURE|SVG|MATH)$/i;

  function isSimpleInline(el) {
    if (SKIP_TAGS.has(el.tagName) || el.tagName === 'BR') return true;
    if (INLINE_BLOCKERS.test(el.tagName)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return true;
    if (cs.display !== 'inline') return false;
    if (cs.visibility !== 'visible' || parseFloat(cs.opacity) < 1) return false;
    if (cs.position === 'absolute' || cs.position === 'fixed') return false;
    if (cs.position === 'relative' && (px(cs.top) || px(cs.left) || px(cs.bottom) || px(cs.right))) return false;
    if (normColor(cs.backgroundColor) || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' || borderInfo(cs)) return false;
    if (Math.abs(px(cs.paddingLeft)) + Math.abs(px(cs.paddingRight)) + Math.abs(px(cs.marginLeft)) + Math.abs(px(cs.marginRight)) > 2) return false;
    if (cs.verticalAlign !== 'baseline') return false;
    if (needsRaster(el, cs)) return false;
    for (const c of el.childNodes) if (c.nodeType === 1 && !isSimpleInline(c)) return false;
    return true;
  }

  function canMergeInline(el, cs) {
    if (/^(flex|inline-flex|grid|inline-grid|contents|table|inline-table|table-row|table-row-group|table-header-group|table-footer-group|ruby)$/.test(cs.display)) return false;
    if (el.tagName !== 'BUTTON' && INLINE_BLOCKERS.test(el.tagName)) return false;
    let hasText = false;
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { if (c.nodeValue.trim()) hasText = true; }
      else if (c.nodeType === 1) {
        if (!isSimpleInline(c)) return false;
        if (!hasText && c.textContent.trim()) hasText = true;
      }
    }
    return hasText;
  }

  function mergedText(el, cs, rect) {
    const raw = [];
    (function collect(node) {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) raw.push({ text: c.nodeValue, cs: c.parentElement === el ? cs : getComputedStyle(c.parentElement) });
        else if (c.nodeType === 1) {
          if (c.tagName === 'BR') { raw.push({ br: true }); continue; }
          if (SKIP_TAGS.has(c.tagName) || getComputedStyle(c).display === 'none') continue;
          collect(c);
        }
      }
    })(el);

    let chars = '';
    const segs = [];
    for (const r of raw) {
      if (r.br) { chars = chars.replace(/ +$/, '') + '\n'; continue; }
      const ws = r.cs.whiteSpace;
      const pre = /^(pre|pre-wrap|break-spaces)$/.test(ws);
      let t = r.text;
      if (ws === 'pre-line') t = t.replace(/[ \t]+/g, ' ');
      else if (!pre) t = t.replace(/\s+/g, ' ');
      if (!pre && (chars === '' || /[ \n]$/.test(chars))) t = t.replace(/^ /, '');
      if (!t) continue;
      segs.push({ start: chars.length, end: chars.length + t.length, cs: r.cs });
      chars += t;
    }
    chars = chars.replace(/^\s+/, (m) => { segs.forEach((s) => { s.start = Math.max(0, s.start - m.length); s.end = Math.max(0, s.end - m.length); }); return ''; });
    chars = chars.replace(/\s+$/, '');
    if (!chars) return null;

    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width >= 0.5 && r.height >= 0.5);
    if (!rects.length) return null;
    const box = {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
    box.width = box.right - box.left;
    box.height = box.bottom - box.top;
    const lines = lineCount(rects);
    const color = textColor(cs) || '#00000000';
    const node = makeText(chars, cs, box, lines, color);

    const cl = rect.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const cw = rect.width - px(cs.borderLeftWidth) - px(cs.paddingLeft) - px(cs.borderRightWidth) - px(cs.paddingRight);
    if (lines > 1) {
      // Wrap at the element's content width, like the browser did.
      if (cw >= box.width - 1) { node._abs.x = cl + scrollX; node.width = cw + 1; }
    } else if (cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible' && box.width > cw + 0.5 && cw > 1) {
      // text-overflow: ellipsis -> fixed-width Figma text with truncation.
      node._abs.x = cl + scrollX;
      node.width = cw;
      node.autoResize = 'NONE';
      node.truncate = true;
      delete node.textAnchor;
    }

    const base = fontInfo(cs);
    const out = [];
    for (const s of segs) {
      if (s.cs === cs) continue;
      const end = Math.min(s.end, chars.length);
      if (end <= s.start) continue;
      const fi = fontInfo(s.cs);
      const c = textColor(s.cs) || '#00000000';
      const d = {};
      if (fi.fontFamily !== base.fontFamily) { d.fontFamily = fi.fontFamily; d.fontFallbacks = fi.fontFallbacks; }
      if (fi.fontWeight !== base.fontWeight) d.fontWeight = fi.fontWeight;
      if (fi.italic !== base.italic) d.italic = fi.italic;
      if (fi.fontSize !== base.fontSize) d.fontSize = fi.fontSize;
      if (c !== color) d.color = c;
      if (fi.textDecoration !== base.textDecoration) d.textDecoration = fi.textDecoration || 'NONE';
      if (fi.textCase !== base.textCase) d.textCase = fi.textCase || 'ORIGINAL';
      if (fi.letterSpacing !== base.letterSpacing) d.letterSpacing = fi.letterSpacing;
      if (Object.keys(d).length) out.push(Object.assign({ start: s.start, end }, d));
    }
    if (out.length) node.segments = out;
    return node;
  }

  function formControlText(el, cs, rect) {
    const tag = el.tagName;
    let value = '', placeholder = false;
    if (tag === 'SELECT') {
      const opt = el.options[el.selectedIndex];
      value = opt ? opt.text : '';
    } else {
      if (/^(checkbox|radio|range|color|file|hidden|image|submit|button|reset)$/i.test(el.type || '')) {
        if (/^(submit|button|reset)$/i.test(el.type)) value = el.value;
        else return null;
      } else {
        value = el.type === 'password' ? '•'.repeat((el.value || '').length) : el.value;
        if (!value && el.placeholder) { value = el.placeholder; placeholder = true; }
      }
    }
    if (!value) return null;
    const pcs = placeholder ? getComputedStyle(el, '::placeholder') : cs;
    const color = normColor(pcs.color) || normColor(cs.color);
    if (!color) return null;
    const pl = px(cs.paddingLeft) + px(cs.borderLeftWidth);
    const pr = px(cs.paddingRight) + px(cs.borderRightWidth);
    const pt = px(cs.paddingTop) + px(cs.borderTopWidth);
    const pb = px(cs.paddingBottom) + px(cs.borderBottomWidth);
    const fi = fontInfo(pcs);
    const node = Object.assign({
      type: 'TEXT',
      text: tag === 'TEXTAREA' ? value : value.replace(/\s+/g, ' '),
      _abs: { x: rect.left + scrollX + pl, y: rect.top + scrollY + pt },
      width: Math.max(1, rect.width - pl - pr),
      height: Math.max(1, rect.height - pt - pb),
      color,
      autoResize: 'NONE',
      verticalAlign: tag === 'TEXTAREA' ? 'TOP' : 'CENTER',
    }, fi);
    if (tag === 'SELECT' && /^(auto|menulist)/.test(cs.appearance)) node.width = Math.max(1, node.width - 16);
    stats.texts++;
    nodeCount++;
    return node;
  }

  // ---------- layer naming ----------
  function layerName(el) {
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label');
    if (aria) return `${tag} "${aria.slice(0, 40)}"`;
    if (el.id && !/^[:_]|\d{3,}/.test(el.id)) return `${tag}#${el.id}`;
    const cls = typeof el.className === 'string'
      ? el.className.split(/\s+/).find((c) => c && !/^(sc-|css-|jsx-|_)|[A-Z0-9]{5,}|^[a-z]{1,3}\d/.test(c))
      : null;
    return cls ? `${tag}.${cls}` : tag;
  }

  // ---------- stacking ----------
  function stackKey(cs) {
    const positioned = cs.position !== 'static';
    const z = positioned && cs.zIndex !== 'auto' ? parseInt(cs.zIndex, 10) || 0 : 0;
    return z * 2 + (positioned ? 1 : 0);
  }
  function createsContext(cs) {
    return (cs.position !== 'static' && cs.zIndex !== 'auto') || parseFloat(cs.opacity) < 1 ||
      cs.transform !== 'none' || cs.filter !== 'none' || cs.isolation === 'isolate';
  }

  // ---------- element visitor ----------
  function needsRaster(el, cs) {
    if (el.tagName === 'CANVAS' || el.tagName === 'VIDEO' || el.tagName === 'IFRAME' || el.tagName === 'OBJECT' || el.tagName === 'EMBED') return true;
    if (options.rasterizeNativeControls && el.tagName === 'INPUT' && /^(checkbox|radio|range|color)$/i.test(el.type) && cs.appearance !== 'none') return true;
    if (el.children.length === 0) {
      if (ICON_FONT_RE.test(cs.fontFamily) && el.textContent.trim()) return true;
      for (const pseudo of ['::before', '::after']) {
        const pcs = getComputedStyle(el, pseudo);
        if (pcs.content && pcs.content !== 'none' && pcs.content !== 'normal' && pcs.content !== '""' && ICON_FONT_RE.test(pcs.fontFamily)) return true;
      }
    }
    return false;
  }

  function addRaster(node, rect, el) {
    const id = 'r' + rasters.length;
    rasters.push({ id, x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height });
    if (options.collectRasterElements) rasterElements[id] = el;
    node.fills = (node.fills || []).concat([{ type: 'IMAGE', imageRef: id, scaleMode: 'FILL' }]);
    stats.rasters++;
  }

  function visit(el, isRoot) {
    if (nodeCount >= options.maxNodes) { stats.truncated = true; return null; }
    if (SKIP_TAGS.has(el.tagName)) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return null;
    const opacity = parseFloat(cs.opacity);
    if (opacity === 0) return null;
    stats.elements++;

    if (cs.display === 'contents') {
      // No box of its own: hoist children.
      return { _hoist: visitChildren(el, cs) };
    }

    const rect = el.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const visible = cs.visibility === 'visible';
    const tag = el.tagName;

    const node = {
      type: 'FRAME',
      name: layerName(el),
      _abs: { x: rect.left + scrollX, y: rect.top + scrollY },
      width: w,
      height: h,
      _stack: stackKey(cs),
      _ctx: createsContext(cs),
    };
    if (opacity < 1) node.opacity = opacity;

    // SVG: serialize and stop.
    if (tag.toLowerCase() === 'svg') {
      if (!visible || w < 0.5 || h < 0.5) return null;
      node.type = 'SVG';
      node.svg = serializeSvg(el, rect);
      // Fallback raster in case Figma's SVG parser rejects it.
      node._rasterFallback = 'r' + rasters.length;
      rasters.push({ id: node._rasterFallback, x: rect.left + scrollX, y: rect.top + scrollY, width: w, height: h, svg: true });
      stats.svgs++;
      nodeCount++;
      return node;
    }

    let hasVisual = false;
    let bgLayers = [];
    if (visible) {
      const bg = parseBackground(cs, w, h);
      if (bg.fills.length) { node.fills = bg.fills; hasVisual = true; }
      bgLayers = bg.layers.map((l) => ({
        type: 'RECTANGLE',
        name: 'background-image',
        _abs: { x: rect.left + scrollX + l.x, y: rect.top + scrollY + l.y },
        width: l.width,
        height: l.height,
        fills: [{ type: 'IMAGE', imageRef: l.imageRef, scaleMode: l.scaleMode }],
      }));
      if (bgLayers.length) { hasVisual = true; nodeCount += bgLayers.length; }
      const border = borderInfo(cs);
      if (border && border.extra.length) {
        bgLayers = bgLayers.concat(borderEdgeLayers(border.extra, rect));
        nodeCount += border.extra.length;
      }
      if (border) {
        node.strokes = [{ type: 'SOLID', color: border.color }];
        const ws = border.weights;
        if (ws.top === ws.right && ws.top === ws.bottom && ws.top === ws.left) node.strokeWeight = ws.top;
        else node.strokeWeights = ws;
        node.strokeAlign = 'INSIDE';
        if (border.style === 'dashed') node.dashPattern = [Math.max(2, ws.top || ws.left) * 2, Math.max(2, ws.top || ws.left)];
        if (border.style === 'dotted') node.dashPattern = [Math.max(1, ws.top || ws.left), Math.max(1, ws.top || ws.left)];
        hasVisual = true;
      }
      const effects = parseShadows(cs.boxShadow, false);
      const blur = cs.filter && cs.filter.match(/blur\(([\d.]+)px\)/);
      if (blur) effects.push({ type: 'LAYER_BLUR', radius: +blur[1] });
      const bblur = (cs.backdropFilter || cs.webkitBackdropFilter || '').match(/blur\(([\d.]+)px\)/);
      if (bblur) effects.push({ type: 'BACKGROUND_BLUR', radius: +bblur[1] });
      if (effects.length) { node.effects = effects; hasVisual = true; }
    }

    const radii = [
      parseRadius(cs.borderTopLeftRadius, w, h), parseRadius(cs.borderTopRightRadius, w, h),
      parseRadius(cs.borderBottomRightRadius, w, h), parseRadius(cs.borderBottomLeftRadius, w, h),
    ];
    if (radii.some((r) => r > 0)) node.cornerRadius = radii.every((r) => r === radii[0]) ? radii[0] : radii;

    const clips = !/^(visible)$/.test(cs.overflowX) || !/^(visible)$/.test(cs.overflowY) ||
      (tag === 'IMG' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
    node.clipsContent = !!clips && !isRoot ? true : false;

    if (visible && tag === 'IMG') {
      const src = el.currentSrc || el.src;
      if (src && el.complete && el.naturalWidth > 0) {
        node.fills = (node.fills || []).concat([{
          type: 'IMAGE', imageRef: imageRef(src),
          scaleMode: cs.objectFit === 'contain' || cs.objectFit === 'scale-down' ? 'FIT' : 'FILL',
        }]);
        node.name = el.alt ? `img "${el.alt.slice(0, 40)}"` : 'img';
        hasVisual = true;
        stats.images++;
      }
    } else if (visible && needsRaster(el, cs)) {
      addRaster(node, rect, el);
      node.name += ' (raster)';
      nodeCount++;
      return node;
    }

    let children = [];
    if (visible && /^(INPUT|TEXTAREA|SELECT)$/.test(tag)) {
      const t = formControlText(el, cs, rect);
      if (t) children.push(t);
      if (tag === 'SELECT' && cs.appearance !== 'none' && cs.backgroundImage === 'none') {
        // Native dropdown arrow isn't in the DOM: draw an equivalent chevron.
        const col = (textColor(cs) || '#000000').slice(0, 7);
        const ax = rect.right - px(cs.borderRightWidth) - 18;
        const ay = rect.top + rect.height / 2 - 3;
        children.push({
          type: 'SVG', name: 'select-arrow',
          _abs: { x: ax + scrollX, y: ay + scrollY }, width: 10, height: 6,
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="${col}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        });
        nodeCount++;
      }
    } else if (tag !== 'IMG') {
      const merged = visible && canMergeInline(el, cs) ? mergedText(el, cs, rect) : null;
      children = merged ? [merged] : visitChildren(el, cs);
    }
    if (bgLayers.length) children = bgLayers.concat(children);

    if (!hasVisual && !children.length && !isRoot) return null;
    if (w < 0.5 && h < 0.5 && !children.length) return null;

    // Sort by CSS paint order (stable).
    children = children
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (a.c._stack || 0) - (b.c._stack || 0) || a.i - b.i)
      .map((x) => x.c);
    // Non-stacking-context wrappers inherit the elevation of their content
    // so overlays (dropdowns, sticky headers) stay on top of later siblings.
    if (!node._ctx && node._stack <= 1) {
      const maxChild = Math.max(0, ...children.map((c) => c._stack || 0));
      if (maxChild > 1) node._stack = maxChild;
    }
    if (children.length) node.children = children;
    if (node.fills || node.strokes || node.effects) stats.frames++;
    nodeCount++;
    return node;
  }

  function visitChildren(el, cs) {
    const out = [];
    const visible = cs.visibility === 'visible';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        if (!visible) continue;
        out.push(...textNodeToSpecs(child, cs));
      } else if (child.nodeType === 1) {
        const r = visit(child, false);
        if (!r) continue;
        if (r._hoist) out.push(...r._hoist);
        else out.push(r);
      }
      if (stats.truncated) break;
    }
    return out;
  }

  // ---------- root ----------
  const docEl = document.documentElement;
  const body = document.body;
  let rootEl = body;
  if (options.selector) {
    rootEl = document.querySelector(options.selector);
    if (!rootEl) throw new Error(`Selector not found: ${options.selector}`);
  }

  let root;
  if (rootEl === body) {
    const htmlCs = getComputedStyle(docEl);
    const bodyCs = getComputedStyle(body);
    const canvasBg = normColor(htmlCs.backgroundColor) || normColor(bodyCs.backgroundColor) || '#ffffff';
    const width = Math.max(docEl.clientWidth, window.innerWidth);
    const height = options.fullPage
      ? Math.max(docEl.scrollHeight, body.scrollHeight, window.innerHeight)
      : window.innerHeight;
    const bodyNode = visit(body, false);
    let kids = bodyNode ? [bodyNode] : [];
    // Body background is propagated to the canvas; avoid painting it twice.
    if (bodyNode && !normColor(htmlCs.backgroundColor) && bodyNode.fills) {
      bodyNode.fills = bodyNode.fills.filter((f) => f.type !== 'SOLID' || f.color !== canvasBg);
      if (!bodyNode.fills.length) delete bodyNode.fills;
    }
    root = {
      type: 'FRAME',
      name: document.title || 'Imported page',
      _abs: { x: 0, y: 0 },
      width,
      height,
      fills: [{ type: 'SOLID', color: canvasBg }],
      clipsContent: true,
      children: kids,
    };
  } else {
    root = visit(rootEl, true);
    root.clipsContent = true;
  }

  // Convert absolute coordinates to parent-relative and strip internals.
  function finalize(node, parentAbs) {
    node.x = Math.round((node._abs.x - parentAbs.x) * 100) / 100;
    node.y = Math.round((node._abs.y - parentAbs.y) * 100) / 100;
    node.width = Math.round(node.width * 100) / 100;
    node.height = Math.round(node.height * 100) / 100;
    const abs = node._abs;
    delete node._abs; delete node._stack; delete node._ctx;
    if (node.children) node.children.forEach((c) => finalize(c, abs));
  }
  const rootAbs = root._abs;
  finalize(root, rootAbs);
  root.x = 0; root.y = 0;

  return {
    tree: root,
    rasters: rasters.map((r) => Object.assign({}, r, { x: r.x, y: r.y })),
    images: Array.from(images.entries()).map(([url, id]) => ({ id, url })),
    rasterElements: options.collectRasterElements ? rasterElements : undefined,
    rootOffset: rootAbs,
    stats,
  };
}
