// Browser-side mock of the Figma Plugin API used to test figma-plugin/code.js
// without Figma. It validates inputs the way Figma does (strict paint/effect
// schemas, font loading rules, auto-layout sizing rules, min sizes) so API
// misuse throws here just like it would in the real plugin sandbox.
(function () {
  const MIXED = Symbol('mixed');
  let idSeq = 1;
  const byId = new Map();
  const loadedFonts = new Set();
  const fk = (f) => f.family + '|' + f.style;

  const FONT_LIST = [];
  const add = (family, styles) => styles.forEach((style) => FONT_LIST.push({ fontName: { family, style } }));
  add('Inter', ['Thin', 'Extra Light', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Extra Bold', 'Black',
    'Thin Italic', 'Light Italic', 'Italic', 'Medium Italic', 'Semi Bold Italic', 'Bold Italic']);
  add('SF Pro', ['Ultralight', 'Thin', 'Light', 'Regular', 'Medium', 'Semibold', 'Bold', 'Heavy', 'Black', 'Italic']);
  add('Helvetica Neue', ['Regular', 'Medium', 'Bold', 'Light', 'Italic']);
  add('Arial', ['Regular', 'Bold', 'Italic', 'Bold Italic']);
  add('Menlo', ['Regular', 'Bold']);
  add('Times New Roman', ['Regular', 'Bold', 'Italic']);
  add('Georgia', ['Regular', 'Bold']);
  const available = new Set(FONT_LIST.map((f) => fk(f.fontName)));

  function fail(msg) { throw new Error(msg); }
  const in01 = (v, what) => { if (typeof v !== 'number' || v < 0 || v > 1 || Number.isNaN(v)) fail(`${what} must be in [0,1], got ${v}`); };
  function strictKeys(obj, allowed, what) {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`Invalid value for ${what}: Unrecognized key(s) in object: '${k}'`);
  }
  function checkRGB(c, what, withA) {
    strictKeys(c, withA ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b'], what);
    ['r', 'g', 'b'].concat(withA ? ['a'] : []).forEach((k) => in01(c[k], `${what}.${k}`));
  }
  function checkTransform(t) {
    if (!Array.isArray(t) || t.length !== 2 || t.some((r) => r.length !== 3 || r.some((v) => !Number.isFinite(v)))) fail('Invalid gradientTransform');
  }
  function checkPaints(paints, what) {
    if (!Array.isArray(paints)) fail(`${what} must be an array`);
    paints.forEach((p, i) => {
      const w = `${what}[${i}]`;
      if (p.type === 'SOLID') {
        strictKeys(p, ['type', 'color', 'opacity', 'visible', 'blendMode', 'boundVariables'], w);
        checkRGB(p.color, w + '.color', false);
        if (p.opacity != null) in01(p.opacity, w + '.opacity');
      } else if (/^GRADIENT_/.test(p.type)) {
        strictKeys(p, ['type', 'gradientTransform', 'gradientStops', 'opacity', 'visible', 'blendMode'], w);
        checkTransform(p.gradientTransform);
        if (!p.gradientStops || p.gradientStops.length < 1) fail(w + ' needs gradientStops');
        p.gradientStops.forEach((s, j) => { strictKeys(s, ['position', 'color', 'boundVariables'], `${w}.gradientStops[${j}]`); in01(s.position, 'position'); checkRGB(s.color, 'stop color', true); });
      } else if (p.type === 'IMAGE') {
        strictKeys(p, ['type', 'scaleMode', 'imageHash', 'imageTransform', 'scalingFactor', 'rotation', 'filters', 'opacity', 'visible', 'blendMode'], w);
        if (!['FILL', 'FIT', 'CROP', 'TILE'].includes(p.scaleMode)) fail(w + ' bad scaleMode ' + p.scaleMode);
        if (!images.has(p.imageHash)) fail(w + ' unknown imageHash');
      } else fail(`${w} invalid paint type ${p.type}`);
    });
    return paints.map((p) => JSON.parse(JSON.stringify(p)));
  }
  function checkEffects(effects) {
    effects.forEach((e, i) => {
      const w = `effects[${i}]`;
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        strictKeys(e, ['type', 'color', 'offset', 'radius', 'spread', 'visible', 'blendMode', 'showShadowBehindNode', 'boundVariables'], w);
        ['color', 'offset', 'radius', 'visible', 'blendMode'].forEach((k) => { if (e[k] == null) fail(`Required value missing at ${w}.${k}`); });
        checkRGB(e.color, w + '.color', true);
        if (e.type === 'INNER_SHADOW' && 'showShadowBehindNode' in e) fail(`${w}: showShadowBehindNode not allowed on INNER_SHADOW`);
      } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
        strictKeys(e, ['type', 'radius', 'visible', 'blurType', 'boundVariables'], w);
        if (e.radius == null || e.visible == null) fail(`Required value missing at ${w}`);
      } else fail(`${w} invalid effect type ${e.type}`);
    });
    return effects.map((e) => JSON.parse(JSON.stringify(e)));
  }

  const images = new Map();

  // -------- text measurement --------
  const mctx = document.createElement('canvas').getContext('2d');
  function cssFont(n, size) {
    const st = n._fontName.style.toLowerCase();
    const weight = /thin/.test(st) ? 100 : /extra ?light/.test(st) ? 200 : /semi ?bold/.test(st) ? 600 : /extra ?bold/.test(st) ? 800 : /black/.test(st) ? 900 : /light/.test(st) ? 300 : /medium/.test(st) ? 500 : /bold/.test(st) ? 700 : 400;
    return `${/italic/.test(st) ? 'italic ' : ''}${weight} ${size}px "${n._fontName.family}", system-ui, sans-serif`;
  }
  function measure(n, s) {
    mctx.font = cssFont(n, n._fontSize);
    let str = s;
    if (n._textCase === 'UPPER') str = str.toUpperCase();
    const ls = n._letterSpacing.unit === 'PIXELS' ? n._letterSpacing.value : (n._letterSpacing.value / 100) * n._fontSize;
    return mctx.measureText(str).width + ls * str.length;
  }
  function lineH(n) {
    const lh = n._lineHeight;
    if (lh.unit === 'PIXELS') return lh.value;
    if (lh.unit === 'PERCENT') return (lh.value / 100) * n._fontSize;
    return n._fontSize * 1.21;
  }
  function wrapLines(n, width) {
    const out = [];
    for (const para of n._characters.split('\n')) {
      const words = para.split(' ');
      let cur = '';
      for (const w of words) {
        const t = cur ? cur + ' ' + w : w;
        if (cur && measure(n, t) > width + 0.01) { out.push(cur); cur = w; } else cur = t;
      }
      out.push(cur);
    }
    return out;
  }

  // -------- nodes --------
  class BaseNode {
    constructor(type) {
      this.id = `${idSeq}:${idSeq++}`;
      this.type = type;
      this._name = type.charAt(0) + type.slice(1).toLowerCase();
      this.parent = null;
      this.removed = false;
      byId.set(this.id, this);
    }
    get name() { return this._name; }
    set name(v) { this._name = String(v); this._autoRename = false; }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; this.removed = true; byId.delete(this.id); }
  }

  const ContainerMixin = {
    appendChild(c) { this.insertChild(this.children.length, c); },
    insertChild(i, c) {
      if (c === this) fail('Cannot append node to itself');
      if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1);
      this.children.splice(i, 0, c);
      c.parent = this;
      if (this._relayout) this._relayout();
    },
    findAll(fn) { const out = []; const walk = (n) => (n.children || []).forEach((c) => { if (!fn || fn(c)) out.push(c); walk(c); }); walk(this); return out; },
  };

  class SceneNode extends BaseNode {
    constructor(type) {
      super(type);
      this._x = 0; this._y = 0; this._w = 100; this._h = 100;
      this.visible = true; this.locked = false; this._opacity = 1; this.rotation = 0; this.blendMode = 'PASS_THROUGH';
      this._fills = []; this._strokes = []; this.strokeWeight = 1; this.strokeAlign = 'CENTER'; this._effects = [];
      this.dashPattern = [];
      this._layoutPositioning = 'AUTO';
      this.constraints = { horizontal: 'MIN', vertical: 'MIN' };
    }
    get x() { return this._x; } set x(v) { if (!Number.isFinite(v)) fail('x must be finite'); this._x = v; }
    get y() { return this._y; } set y(v) { if (!Number.isFinite(v)) fail('y must be finite'); this._y = v; }
    get width() { return this._w; } get height() { return this._h; }
    get opacity() { return this._opacity; } set opacity(v) { in01(v, 'opacity'); this._opacity = v; }
    resize(w, h) {
      if (!(w >= 0.01) || !(h >= 0.01)) fail(`Expected width/height >= 0.01, got ${w}x${h}`);
      this._w = w; this._h = h;
      if ('_sizingH' in this) { this._sizingH = 'FIXED'; this._sizingV = 'FIXED'; }
      if (this.parent && this.parent._relayout) this.parent._relayout();
    }
    rescale(k) { this._w *= k; this._h *= k; }
    get fills() { return this._fills; } set fills(v) { this._fills = checkPaints(v, 'fills'); }
    get strokes() { return this._strokes; } set strokes(v) { this._strokes = checkPaints(v, 'strokes'); }
    get effects() { return this._effects; } set effects(v) { this._effects = checkEffects(v); }
    get layoutPositioning() { return this._layoutPositioning; }
    set layoutPositioning(v) {
      if (v === 'ABSOLUTE' && !(this.parent && this.parent.layoutMode && this.parent.layoutMode !== 'NONE')) fail('ABSOLUTE positioning requires an auto-layout parent');
      this._layoutPositioning = v;
    }
    get absoluteBoundingBox() {
      let x = this.x, y = this.y, p = this.parent;
      while (p && p.type !== 'PAGE') { x += p.x; y += p.y; p = p.parent; }
      return { x, y, width: this.width, height: this.height };
    }
    clone() {
      const c = new this.constructor(this.type);
      for (const k of Object.keys(this)) if (!['id', 'parent', 'children'].includes(k)) c[k] = JSON.parse(JSON.stringify(this[k] === undefined ? null : this[k]));
      if (this.children) { c.children = []; this.children.forEach((ch) => c.appendChild(ch.clone())); }
      if (this.parent) this.parent.appendChild(c);
      return c;
    }
    async exportAsync() { return new Uint8Array([137, 80, 78, 71]); }
  }

  const RADIUS = {
    get cornerRadius() { const r = [this.topLeftRadius, this.topRightRadius, this.bottomRightRadius, this.bottomLeftRadius]; return r.every((v) => v === r[0]) ? r[0] : MIXED; },
    set cornerRadius(v) { if (typeof v !== 'number' || v < 0) fail('cornerRadius must be >= 0'); this.topLeftRadius = this.topRightRadius = this.bottomRightRadius = this.bottomLeftRadius = v; },
  };
  const STROKE_SIDES = {
    get strokeTopWeight() { return this._sw.t; }, set strokeTopWeight(v) { this._sw.t = v; },
    get strokeRightWeight() { return this._sw.r; }, set strokeRightWeight(v) { this._sw.r = v; },
    get strokeBottomWeight() { return this._sw.b; }, set strokeBottomWeight(v) { this._sw.b = v; },
    get strokeLeftWeight() { return this._sw.l; }, set strokeLeftWeight(v) { this._sw.l = v; },
  };

  class RectangleNode extends SceneNode {
    constructor(t) { super(t || 'RECTANGLE'); this.topLeftRadius = this.topRightRadius = this.bottomRightRadius = this.bottomLeftRadius = 0; this._sw = { t: 1, r: 1, b: 1, l: 1 }; this._fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }]; }
  }
  Object.defineProperties(RectangleNode.prototype, Object.getOwnPropertyDescriptors(RADIUS));
  Object.defineProperties(RectangleNode.prototype, Object.getOwnPropertyDescriptors(STROKE_SIDES));

  class EllipseNode extends SceneNode { constructor() { super('ELLIPSE'); this._fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }]; } }
  class LineNode extends SceneNode {
    constructor() { super('LINE'); this._h = 0; this._strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; }
    resize(w, h) { if (h !== 0) fail('LINE height must be 0'); if (!(w >= 0.01)) fail('bad width'); this._w = w; }
  }

  const ALIGN_P = ['MIN', 'MAX', 'CENTER', 'SPACE_BETWEEN'];
  const ALIGN_C = ['MIN', 'MAX', 'CENTER', 'BASELINE'];
  class FrameNode extends RectangleNode {
    constructor(t) {
      super(t || 'FRAME');
      this.children = [];
      this._fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
      this.clipsContent = true;
      this._layoutMode = 'NONE'; this.layoutWrap = 'NO_WRAP';
      this.itemSpacing = 0; this.counterAxisSpacing = 0;
      this.paddingTop = this.paddingRight = this.paddingBottom = this.paddingLeft = 0;
      this._pa = 'MIN'; this._ca = 'MIN';
      this._sizingH = 'FIXED'; this._sizingV = 'FIXED';
      this.layoutGrow = 0;
      this.strokesIncludedInLayout = false;
    }
    get layoutMode() { return this._layoutMode; }
    set layoutMode(v) { if (!['NONE', 'HORIZONTAL', 'VERTICAL', 'GRID'].includes(v)) fail('bad layoutMode ' + v); this._layoutMode = v; this._relayout(); }
    get primaryAxisAlignItems() { return this._pa; } set primaryAxisAlignItems(v) { if (!ALIGN_P.includes(v)) fail('bad primaryAxisAlignItems ' + v); this._pa = v; }
    get counterAxisAlignItems() { return this._ca; } set counterAxisAlignItems(v) { if (!ALIGN_C.includes(v)) fail('bad counterAxisAlignItems ' + v); this._ca = v; }
    _relayout() { /* geometry for auto layout is computed by the renderer */ }
  }
  Object.assign(FrameNode.prototype, ContainerMixin);
  class ComponentNode extends FrameNode {
    constructor() { super('COMPONENT'); }
    createInstance() { const i = this.clone(); i.type = 'INSTANCE'; i._main = this; i.getMainComponentAsync = async () => this; figma.currentPage.appendChild(i); return i; }
  }

  // Sizing props live on every SceneNode (validated per Figma rules).
  Object.defineProperty(SceneNode.prototype, 'layoutSizingHorizontal', {
    get() { return this._sizingH || 'FIXED'; },
    set(v) { checkSizing(this, v); this._sizingH = v; },
  });
  Object.defineProperty(SceneNode.prototype, 'layoutSizingVertical', {
    get() { return this._sizingV || 'FIXED'; },
    set(v) { checkSizing(this, v); this._sizingV = v; },
  });
  function checkSizing(n, v) {
    const parentAuto = n.parent && n.parent.layoutMode && n.parent.layoutMode !== 'NONE';
    const selfAuto = n.layoutMode && n.layoutMode !== 'NONE';
    if (v === 'FILL' && !parentAuto) fail('FILL can only be set on children of auto-layout frames');
    if (v === 'HUG' && !selfAuto && n.type !== 'TEXT') fail('HUG can only be set on auto-layout frames and text nodes');
    if (!['FIXED', 'FILL', 'HUG'].includes(v)) fail('bad sizing ' + v);
  }

  class TextNode extends SceneNode {
    constructor() {
      super('TEXT');
      this._fontName = { family: 'Inter', style: 'Regular' };
      this._characters = ''; this._fontSize = 12;
      this._lineHeight = { unit: 'AUTO' }; this._letterSpacing = { unit: 'PERCENT', value: 0 };
      this._fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
      this._autoResize = 'WIDTH_AND_HEIGHT';
      this.textAlignHorizontal = 'LEFT'; this.textAlignVertical = 'TOP';
      this._textCase = 'ORIGINAL'; this.textDecoration = 'NONE'; this.paragraphSpacing = 0; this._truncation = 'DISABLED'; this._maxLines = null;
      this._autoRename = true;
      this._sizingH = 'HUG'; this._sizingV = 'HUG';
      this._ranges = [];
    }
    _requireFont() { if (!loadedFonts.has(fk(this._fontName))) fail(`Cannot write to node with unloaded font "${this._fontName.family} ${this._fontName.style}"`); }
    get fontName() { return this._fontName; }
    set fontName(v) { strictKeys(v, ['family', 'style'], 'fontName'); if (!loadedFonts.has(fk(v))) fail(`Cannot use unloaded font "${v.family} ${v.style}"`); this._fontName = { family: v.family, style: v.style }; this._reflow(); }
    get characters() { return this._characters; }
    set characters(v) { this._requireFont(); this._characters = v; this._ranges = []; if (this._autoRename) this._name = v.slice(0, 60); this._reflow(); }
    get fontSize() { return this._fontSize; } set fontSize(v) { this._requireFont(); if (!(v >= 1)) fail('fontSize >= 1'); this._fontSize = v; this._reflow(); }
    get lineHeight() { return this._lineHeight; } set lineHeight(v) { this._requireFont(); strictKeys(v, ['unit', 'value'], 'lineHeight'); this._lineHeight = v; this._reflow(); }
    get letterSpacing() { return this._letterSpacing; } set letterSpacing(v) { this._requireFont(); strictKeys(v, ['unit', 'value'], 'letterSpacing'); this._letterSpacing = v; this._reflow(); }
    get textCase() { return this._textCase; } set textCase(v) { this._requireFont(); this._textCase = v; this._reflow(); }
    get textAutoResize() { return this._autoResize; }
    set textAutoResize(v) { if (!['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'].includes(v)) fail('bad textAutoResize'); this._autoResize = v; if (v === 'WIDTH_AND_HEIGHT') { this._truncation = 'DISABLED'; this._maxLines = null; } this._reflow(); }
    resize(w, h) { super.resize(w, h); this._autoResize = 'NONE'; }
    // Figma ignores truncation on auto-width text (and auto-width resets it).
    get textTruncation() { return this._truncation; }
    set textTruncation(v) { if (!['DISABLED', 'ENDING'].includes(v)) fail('bad textTruncation'); if (this._autoResize !== 'WIDTH_AND_HEIGHT') this._truncation = v; }
    get maxLines() { return this._maxLines; }
    set maxLines(v) { if (this.textTruncation !== 'ENDING') fail('maxLines requires textTruncation ENDING'); if (v != null && !(v >= 1)) fail('maxLines >= 1'); this._maxLines = v; }
    getRangeAllFontNames() { return [this._fontName].concat(this._ranges.filter((r) => r.fontName).map((r) => r.fontName)); }
    _range(s, e, props) {
      if (!(Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e <= this._characters.length && s < e)) fail(`Bad range ${s}-${e} (length ${this._characters.length})`);
      this._requireFont();
      this._ranges.push(Object.assign({ s, e }, props));
    }
    setRangeFontName(s, e, f) { if (!loadedFonts.has(fk(f))) fail(`Cannot use unloaded font "${f.family} ${f.style}"`); this._range(s, e, { fontName: f }); }
    setRangeFontSize(s, e, v) { this._range(s, e, { fontSize: v }); }
    setRangeFills(s, e, v) { this._range(s, e, { fills: checkPaints(v, 'range fills') }); }
    setRangeTextDecoration(s, e, v) { if (!['NONE', 'UNDERLINE', 'STRIKETHROUGH'].includes(v)) fail('bad decoration'); this._range(s, e, { textDecoration: v }); }
    setRangeTextCase(s, e, v) { if (!['ORIGINAL', 'UPPER', 'LOWER', 'TITLE'].includes(v)) fail('bad textCase'); this._range(s, e, { textCase: v }); }
    setRangeLetterSpacing(s, e, v) { strictKeys(v, ['unit', 'value'], 'letterSpacing'); this._range(s, e, { letterSpacing: v }); }
    _reflow() {
      if (this._autoResize === 'WIDTH_AND_HEIGHT') {
        const lines = this._characters.split('\n');
        this._w = Math.max(1, ...lines.map((l) => measure(this, l)));
        this._h = lineH(this) * lines.length;
      } else if (this._autoResize === 'HEIGHT') {
        this._h = lineH(this) * wrapLines(this, this._w).length;
      }
    }
  }

  class PageNode extends BaseNode {
    constructor() { super('PAGE'); this.children = []; this._selection = []; }
    get selection() { return this._selection; }
    set selection(v) { v.forEach((n) => { let p = n; while (p && p.type !== 'PAGE') p = p.parent; if (p !== this) fail('Node not on this page'); }); this._selection = v; }
  }
  Object.assign(PageNode.prototype, ContainerMixin);

  const doc = { type: 'DOCUMENT', name: 'Mock File', children: [] };
  const page = new PageNode(); page.name = 'Page 1'; page.parent = doc; doc.children.push(page);

  const listeners = {};
  const ui = {
    _handler: null,
    postMessage(msg) { (window.__uiMessages = window.__uiMessages || []).push(JSON.parse(JSON.stringify(msg))); },
    set onmessage(fn) { this._handler = fn; },
    get onmessage() { return this._handler; },
    resize(w, h) { if (!(w > 0 && h > 0)) fail('Invalid window size'); (window.__uiSizes = window.__uiSizes || []).push([w, h]); },
  };
  const storage = new Map();

  window.__html__ = '<html></html>';
  window.figma = {
    mixed: MIXED,
    root: doc,
    currentPage: page,
    ui,
    showUI() {},
    notify(msg) { (window.__notifications = window.__notifications || []).push(msg); },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    viewport: { scrollAndZoomIntoView() {} },
    clientStorage: {
      async getAsync(key) { return storage.has(key) ? JSON.parse(storage.get(key)) : undefined; },
      async setAsync(key, value) { storage.set(key, JSON.stringify(value)); },
    },
    async listAvailableFontsAsync() { return JSON.parse(JSON.stringify(FONT_LIST)); },
    async loadFontAsync(f) { if (!available.has(fk(f))) throw new Error('Font not available: ' + fk(f)); loadedFonts.add(fk(f)); },
    async getNodeByIdAsync(id) { return byId.get(id) || (id === page.id ? page : null); },
    async setCurrentPageAsync(p) { this.currentPage = p; },
    createFrame: () => new FrameNode(),
    createComponent: () => new ComponentNode(),
    createRectangle: () => new RectangleNode(),
    createEllipse: () => new EllipseNode(),
    createLine: () => new LineNode(),
    createText: () => new TextNode(),
    createPage() { const p = new PageNode(); p.parent = doc; doc.children.push(p); return p; },
    createPolygon: () => new RectangleNode('POLYGON'),
    createStar: () => new RectangleNode('STAR'),
    createComponentFromNode(n) { const c = new ComponentNode(); for (const k of Object.keys(n)) if (!['id', 'parent', 'children', 'type'].includes(k)) c[k] = n[k]; (n.children || []).slice().forEach((ch) => c.appendChild(ch)); const p = n.parent; const i = p.children.indexOf(n); n.remove(); p.insertChild(i, c); return c; },
    createNodeFromSvg(svg) {
      if (!/^\s*<svg[\s>]/i.test(svg) && !/^\s*<\?xml/.test(svg)) fail('Invalid SVG');
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (doc.querySelector('parsererror')) fail('Failed to parse SVG');
      const f = new FrameNode(); f._fills = []; f._svg = svg; f.name = 'svg';
      const el = doc.documentElement;
      const vb = (el.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
      f._w = parseFloat(el.getAttribute('width')) || vb[2] || 100;
      f._h = parseFloat(el.getAttribute('height')) || vb[3] || 100;
      return f;
    },
    createImage(bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.length < 8) fail('Image data must be a Uint8Array');
      const sig = Array.from(bytes.slice(0, 4));
      const ok = (sig[0] === 0x89 && sig[1] === 0x50) || (sig[0] === 0xff && sig[1] === 0xd8) || (sig[0] === 0x47 && sig[1] === 0x49);
      if (!ok) fail('Image type is unsupported');
      let b = ''; for (let i = 0; i < bytes.length; i += 8192) b += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      const hash = 'h' + images.size;
      images.set(hash, { b64: btoa(b), mime: sig[0] === 0x89 ? 'image/png' : sig[0] === 0xff ? 'image/jpeg' : 'image/gif' });
      return { hash };
    },
    base64Decode(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; },
    base64Encode(u) { let b = ''; for (let i = 0; i < u.length; i += 8192) b += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(b); },
  };
  window.__mock = { images, page, byId };

  // Send a command to the plugin and wait for its response.
  window.__send = function (command, params) {
    const id = 't' + Math.random().toString(36).slice(2);
    figma.ui.onmessage({ type: 'command', id, command, params });
    return new Promise((resolve) => {
      const iv = setInterval(() => {
        const r = (window.__uiMessages || []).find((m) => m.type === 'response' && m.id === id);
        if (r) { clearInterval(iv); resolve(r); }
      }, 20);
    });
  };
})();
