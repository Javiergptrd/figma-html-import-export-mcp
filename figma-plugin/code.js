// HTML Import, Export and MCP Service Plugin — plugin main thread.
// Receives commands from the MCP server (relayed by ui.html over a local
// WebSocket) and executes them with the Figma Plugin API. ui.html also sends
// create_nodes itself when you import an HTML file from the plugin window.
//
// Written in conservative ES2017 (no optional chaining / nullish coalescing /
// object spread) because the plugin sandbox has historically lagged behind.

var UI_WIDTH = 320;
figma.showUI(__html__, { width: UI_WIDTH, height: 470, title: "HTML Import, Export and MCP Service Plugin", themeColors: true });

// ----------------------------------------------------------------------------
// Messaging
// ----------------------------------------------------------------------------

var queue = [];
var busy = false;

function post(msg) {
  figma.ui.postMessage(msg);
}

var PLUGIN_VERSION = '1.3.3';
var SETTINGS_KEY = 'importSettings';
var autoExportSent = false;

function helloInfo() {
  return {
    type: 'hello',
    role: 'plugin',
    pluginVersion: PLUGIN_VERSION,
    fileName: figma.root.name,
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
  };
}

figma.ui.onmessage = function (msg) {
  if (!msg) return;
  if (msg.type === 'ui-connected') post(helloInfo());
  if (msg.type === 'ui-ready') {
    post(helloInfo());
    post(selectionInfo());
    figma.clientStorage.getAsync(SETTINGS_KEY).then(function (settings) {
      post({ type: 'settings', settings: settings || null });
      // Menu command "Export selection as HTML": export once the saved options are applied.
      if (figma.command === 'export-html' && !autoExportSent) {
        autoExportSent = true;
        post({ type: 'auto-export' });
      }
    });
  }
  if (msg.type === 'save-settings') figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings);
  if (msg.type === 'resize') figma.ui.resize(UI_WIDTH, Math.max(160, Math.min(900, Math.round(msg.height) || 470)));
  if (msg.type === 'command') {
    queue.push(msg);
    pump();
  }
};

figma.on('currentpagechange', function () {
  post(helloInfo());
  post(selectionInfo());
});

figma.on('selectionchange', function () {
  post(selectionInfo());
});

// What the "Export HTML" section of the plugin window shows.
function selectionInfo() {
  var sel = figma.currentPage.selection;
  var n = sel[0];
  return {
    type: 'selection',
    count: sel.length,
    node: n ? { id: n.id, name: n.name, type: n.type, width: Math.round(n.width || 0), height: Math.round(n.height || 0) } : null,
  };
}

function pump() {
  if (busy || !queue.length) return;
  busy = true;
  var msg = queue.shift();
  var started = Date.now();
  post({ type: 'log', text: '▶ ' + msg.command });
  run(msg.command, msg.params || {})
    .then(function (result) {
      post({ type: 'response', id: msg.id, result: result });
      post({ type: 'log', text: '✓ ' + msg.command + ' (' + (Date.now() - started) + 'ms)' });
    })
    .catch(function (err) {
      var text = err && err.message ? err.message : String(err);
      post({ type: 'response', id: msg.id, error: text });
      post({ type: 'log', text: '✗ ' + msg.command + ': ' + text });
    })
    .then(function () {
      busy = false;
      pump();
    });
}

function progress(text) {
  post({ type: 'log', text: text });
}

// ----------------------------------------------------------------------------
// Commands
// ----------------------------------------------------------------------------

var COMMANDS = {
  ping: function () {
    return Promise.resolve(helloInfo());
  },
  get_document_info: getDocumentInfo,
  get_selection: function (p) {
    return Promise.all(figma.currentPage.selection.map(function (n) {
      return describe(n, p.depth == null ? 1 : p.depth);
    })).then(function (nodes) { return { page: figma.currentPage.name, nodes: nodes }; });
  },
  get_node: function (p) {
    return requireNode(p.id).then(function (n) { return describe(n, p.depth == null ? 2 : p.depth); });
  },
  create_nodes: createNodes,
  update_node: updateNode,
  delete_nodes: deleteNodes,
  clone_node: cloneNode,
  export_node: exportNode,
  select_nodes: selectNodes,
  create_page: createPage,
  switch_page: switchPage,
  create_component: createComponent,
  export_html: exportHtml,
};

function run(command, params) {
  var fn = COMMANDS[command];
  if (!fn) return Promise.reject(new Error('Unknown command: ' + command));
  try {
    return Promise.resolve(fn(params));
  } catch (e) {
    return Promise.reject(e);
  }
}

function requireNode(id) {
  return figma.getNodeByIdAsync(id).then(function (n) {
    if (!n) throw new Error('Node not found: ' + id);
    return n;
  });
}

async function getDocumentInfo() {
  var page = figma.currentPage;
  return {
    fileName: figma.root.name,
    currentPage: { id: page.id, name: page.name },
    pages: figma.root.children.map(function (p) { return { id: p.id, name: p.name }; }),
    topLevelNodes: page.children.map(function (n) {
      return { id: n.id, name: n.name, type: n.type, x: r2(n.x), y: r2(n.y), width: r2(n.width), height: r2(n.height) };
    }),
    selection: page.selection.map(function (n) { return { id: n.id, name: n.name, type: n.type }; }),
  };
}

async function deleteNodes(p) {
  var ids = p.ids || [];
  var deleted = [];
  var missing = [];
  for (var i = 0; i < ids.length; i++) {
    var n = await figma.getNodeByIdAsync(ids[i]);
    if (n && n.type !== 'PAGE' && n.type !== 'DOCUMENT') {
      n.remove();
      deleted.push(ids[i]);
    } else missing.push(ids[i]);
  }
  return { deleted: deleted, notFound: missing };
}

async function cloneNode(p) {
  var n = await requireNode(p.id);
  var c = n.clone();
  if (p.parentId) {
    var parent = await requireNode(p.parentId);
    parent.appendChild(c);
  }
  if (p.x != null) c.x = p.x;
  if (p.y != null) c.y = p.y;
  if (p.name) c.name = p.name;
  return describe(c, 0);
}

async function exportNode(p) {
  var n = await requireNode(p.id);
  var format = (p.format || 'PNG').toUpperCase();
  if (format === 'JPEG') format = 'JPG';
  var settings = { format: format };
  if (format === 'PNG' || format === 'JPG') {
    var scale = p.scale;
    if (!scale) {
      var maxSide = Math.max(n.width, n.height) || 1;
      scale = Math.min(2, (p.maxSize || 1600) / maxSide);
    }
    settings.constraint = { type: 'SCALE', value: scale };
  }
  if (format === 'SVG') settings.svgOutlineText = false;
  var bytes = await n.exportAsync(settings);
  if (format === 'SVG') return { format: format, svg: utf8Decode(bytes) };
  return { format: format, base64: figma.base64Encode(bytes), width: n.width, height: n.height };
}

async function selectNodes(p) {
  var nodes = [];
  for (var i = 0; i < (p.ids || []).length; i++) {
    var n = await figma.getNodeByIdAsync(p.ids[i]);
    if (n && n.type !== 'PAGE' && n.type !== 'DOCUMENT') nodes.push(n);
  }
  if (nodes.length) {
    var page = pageOf(nodes[0]);
    if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
  }
  figma.currentPage.selection = nodes;
  if (p.zoom !== false && nodes.length) figma.viewport.scrollAndZoomIntoView(nodes);
  return { selected: nodes.map(function (n) { return n.id; }) };
}

async function createPage(p) {
  var page = figma.createPage();
  page.name = p.name || 'Page';
  if (p.switch !== false) await figma.setCurrentPageAsync(page);
  return { id: page.id, name: page.name };
}

async function switchPage(p) {
  var page = null;
  if (p.id) page = await figma.getNodeByIdAsync(p.id);
  if (!page && p.name) {
    page = figma.root.children.find(function (pg) { return pg.name === p.name; }) || null;
  }
  if (!page || page.type !== 'PAGE') throw new Error('Page not found');
  await figma.setCurrentPageAsync(page);
  return { id: page.id, name: page.name };
}

async function createComponent(p) {
  var n = await requireNode(p.id);
  var comp = figma.createComponentFromNode(n);
  if (p.name) comp.name = p.name;
  return describe(comp, 0);
}

function pageOf(n) {
  while (n && n.type !== 'PAGE') n = n.parent;
  return n;
}

// ----------------------------------------------------------------------------
// Colors & paints
// ----------------------------------------------------------------------------

var NAMED = {
  white: '#ffffff', black: '#000000', transparent: '#00000000', red: '#ff0000', green: '#008000',
  blue: '#0000ff', gray: '#808080', grey: '#808080', yellow: '#ffff00', orange: '#ffa500',
};

function parseColor(c) {
  if (c && typeof c === 'object') {
    return { r: c.r, g: c.g, b: c.b, a: c.a == null ? 1 : c.a };
  }
  var s = String(c).trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  var m;
  if (s.charAt(0) === '#') {
    var h = s.slice(1);
    if (h.length === 3 || h.length === 4) {
      h = h.split('').map(function (ch) { return ch + ch; }).join('');
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16) / 255,
        g: parseInt(h.slice(2, 4), 16) / 255,
        b: parseInt(h.slice(4, 6), 16) / 255,
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
  }
  if ((m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/))) {
    var a = 1;
    if (m[4] != null) a = m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: a };
  }
  throw new Error('Invalid color: ' + c);
}

function rgb(c) {
  return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b) };
}
function rgba(c) {
  return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: clamp01(c.a) };
}
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// CSS angle (0deg = to top, clockwise) -> Figma gradientTransform, which maps
// normalized layer space to gradient space (gradient runs along x from 0 to 1).
function linearGradientTransform(angleDeg, w, h) {
  w = w || 1; h = h || 1;
  var t = (angleDeg * Math.PI) / 180;
  var s = Math.sin(t);
  var c = Math.cos(t);
  var L = Math.abs(w * s) + Math.abs(h * c) || 1;
  var sx = w / 2 - (L / 2) * s;
  var sy = h / 2 + (L / 2) * c;
  return [
    [(w * s) / L, (-h * c) / L, (-sx * s + sy * c) / L],
    [(w * c) / L, (h * s) / L, (-sx * c - sy * s) / L + 0.5],
  ];
}

function scaledTransform(k) {
  k = k || 1;
  return [[1 / k, 0, 0.5 - 0.5 / k], [0, 1 / k, 0.5 - 0.5 / k]];
}

function toStops(stops) {
  return (stops || []).map(function (st, i, arr) {
    return {
      position: st.position != null ? clamp01(st.position) : arr.length > 1 ? i / (arr.length - 1) : 0,
      color: rgba(parseColor(st.color)),
    };
  });
}

function toPaint(p, w, h, ctx) {
  if (typeof p === 'string') p = { type: 'SOLID', color: p };
  var type = (p.type || 'SOLID').toUpperCase();
  var paint;
  if (type === 'SOLID') {
    var c = parseColor(p.color);
    paint = { type: 'SOLID', color: rgb(c), opacity: clamp01(c.a * (p.opacity == null ? 1 : p.opacity)) };
  } else if (type === 'GRADIENT_LINEAR') {
    paint = {
      type: type,
      gradientTransform: linearGradientTransform(p.angle == null ? 180 : p.angle, w, h),
      gradientStops: toStops(p.stops),
    };
  } else if (type === 'GRADIENT_RADIAL' || type === 'GRADIENT_ANGULAR' || type === 'GRADIENT_DIAMOND') {
    paint = { type: type, gradientTransform: scaledTransform(p.radius), gradientStops: toStops(p.stops) };
  } else if (type === 'IMAGE') {
    var hash = imageHashFor(p, ctx);
    if (!hash) return null;
    paint = { type: 'IMAGE', imageHash: hash, scaleMode: (p.scaleMode || 'FILL').toUpperCase() };
  } else {
    throw new Error('Unsupported paint type: ' + p.type);
  }
  if (p.opacity != null && type !== 'SOLID') paint.opacity = clamp01(p.opacity);
  if (p.visible === false) paint.visible = false;
  return paint;
}

function imageHashFor(p, ctx) {
  var key = p.imageRef || null;
  var data = null;
  if (key && ctx.assets[key]) data = ctx.assets[key].data;
  else if (p.image) {
    data = String(p.image).replace(/^data:[^,]*,/, '');
    key = 'inline:' + data.length + ':' + data.slice(0, 64);
  }
  if (!data) {
    ctx.warn('Missing image data' + (key ? ' for ' + key : ''));
    return null;
  }
  if (ctx.imageHashes[key]) return ctx.imageHashes[key];
  try {
    var img = figma.createImage(figma.base64Decode(data));
    ctx.imageHashes[key] = img.hash;
    return img.hash;
  } catch (e) {
    ctx.warn('Image rejected by Figma (' + key + '): ' + e.message);
    return null;
  }
}

function toPaints(list, w, h, ctx) {
  if (list == null) return null;
  if (!Array.isArray(list)) list = [list];
  return list.map(function (p) { return toPaint(p, w, h, ctx); }).filter(Boolean);
}

function toEffects(list) {
  return (list || []).map(function (e) {
    var type = (e.type || 'DROP_SHADOW').toUpperCase();
    if (type === 'DROP_SHADOW' || type === 'INNER_SHADOW') {
      var eff = {
        type: type,
        color: rgba(parseColor(e.color || '#00000040')),
        offset: { x: e.x || 0, y: e.y || 0 },
        radius: Math.max(0, e.blur != null ? e.blur : e.radius || 0),
        spread: e.spread || 0,
        visible: true,
        blendMode: 'NORMAL',
      };
      if (type === 'DROP_SHADOW') eff.showShadowBehindNode = false;
      return eff;
    }
    return { type: type, radius: Math.max(0, e.radius || e.blur || 0), visible: true };
  });
}

function setEffects(node, effects) {
  try {
    node.effects = effects;
  } catch (e) {
    // Newer API versions require blurType on blur effects.
    node.effects = effects.map(function (ef) {
      if (ef.type === 'LAYER_BLUR' || ef.type === 'BACKGROUND_BLUR') {
        return Object.assign({ blurType: 'NORMAL' }, ef);
      }
      return ef;
    });
  }
}

// ----------------------------------------------------------------------------
// Fonts
// ----------------------------------------------------------------------------

var GENERIC_FONTS = {
  'system-ui': ['SF Pro Text', 'SF Pro', 'SF Pro Display', 'Inter'],
  '-apple-system': ['SF Pro Text', 'SF Pro', 'SF Pro Display', 'Inter'],
  'blinkmacsystemfont': ['SF Pro Text', 'SF Pro', 'SF Pro Display', 'Inter'],
  'ui-sans-serif': ['SF Pro Text', 'SF Pro', 'Inter'],
  'ui-rounded': ['SF Pro Rounded', 'Nunito', 'Inter'],
  'sans-serif': ['Inter', 'Helvetica Neue', 'Helvetica', 'Arial'],
  'serif': ['Times New Roman', 'Georgia', 'Times', 'Noto Serif'],
  'ui-serif': ['New York', 'Georgia', 'Times New Roman'],
  'monospace': ['SF Mono', 'Menlo', 'Monaco', 'Roboto Mono', 'Source Code Pro', 'Courier New'],
  'ui-monospace': ['SF Mono', 'Menlo', 'Monaco', 'Roboto Mono', 'Courier New'],
  'sfmono-regular': ['SF Mono', 'Menlo'],
  'segoe ui': ['Segoe UI', 'Inter'],
  'helvetica': ['Helvetica', 'Helvetica Neue', 'Arial'],
  'cursive': ['Comic Sans MS', 'Inter'],
};

var fontIndex = null;

async function getFontIndex() {
  if (fontIndex) return fontIndex;
  var list = await figma.listAvailableFontsAsync();
  fontIndex = {};
  list.forEach(function (f) {
    var key = f.fontName.family.toLowerCase();
    if (!fontIndex[key]) fontIndex[key] = [];
    fontIndex[key].push(f.fontName);
  });
  return fontIndex;
}

function styleWeight(style) {
  var s = style.toLowerCase().replace(/[\s_-]/g, '');
  if (/thin|hairline/.test(s)) return 100;
  if (/extralight|ultralight/.test(s)) return 200;
  if (/semibold|demibold/.test(s)) return 600;
  if (/extrabold|ultrabold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500;
  if (/bold/.test(s)) return 700;
  return 400;
}

function pickStyle(styles, weight, italic) {
  var best = null;
  var bestScore = Infinity;
  styles.forEach(function (fn) {
    var st = fn.style.toLowerCase();
    var isItalic = /italic|oblique/.test(st);
    var score = Math.abs(styleWeight(fn.style) - weight);
    if (isItalic !== !!italic) score += 1000;
    if (/condensed|expanded|narrow|wide|compressed|display|caption|small|text|mono/.test(st)) score += 30;
    if (/^(regular|italic|bold|medium|semibold|semi bold|light)$/.test(st)) score -= 1;
    if (score < bestScore) { bestScore = score; best = fn; }
  });
  return best;
}

function familyCandidates(spec) {
  var list = [spec.fontFamily || 'Inter'].concat(spec.fontFallbacks || []);
  var out = [];
  list.forEach(function (f) {
    var key = String(f).toLowerCase();
    out.push(f);
    if (GENERIC_FONTS[key]) out = out.concat(GENERIC_FONTS[key]);
  });
  out.push('Inter');
  return out;
}

// Resolve every text node's font up front and load them in parallel.
async function prepareFonts(specs, ctx) {
  var index = await getFontIndex();
  var cache = {};
  var toLoad = {};
  specs.forEach(function (spec) {
    var weight = spec.fontWeight || 400;
    var key;
    if (spec.fontStyle) key = (spec.fontFamily || 'Inter') + '|style:' + spec.fontStyle;
    else key = familyCandidates(spec).join(',') + '|' + weight + '|' + (spec.italic ? 1 : 0);
    if (!cache[key]) {
      var resolved = null;
      if (spec.fontStyle) {
        var fam = index[String(spec.fontFamily || 'Inter').toLowerCase()];
        if (fam) resolved = fam.find(function (f) { return f.style.toLowerCase() === String(spec.fontStyle).toLowerCase(); }) || null;
      }
      var cands = familyCandidates(spec);
      for (var i = 0; !resolved && i < cands.length; i++) {
        var styles = index[String(cands[i]).toLowerCase()];
        if (styles && styles.length) resolved = pickStyle(styles, weight, spec.italic);
      }
      if (!resolved) resolved = { family: 'Inter', style: 'Regular' };
      var requested = spec.fontFamily || 'Inter';
      if (!GENERIC_FONTS[String(requested).toLowerCase()] && resolved.family.toLowerCase() !== String(requested).toLowerCase()) {
        ctx.missingFonts[requested] = resolved.family;
      }
      cache[key] = resolved;
      toLoad[resolved.family + '|' + resolved.style] = resolved;
    }
    spec._font = cache[key];
  });
  var names = Object.keys(toLoad);
  await Promise.all(names.map(function (k) {
    return figma.loadFontAsync(toLoad[k]).catch(function () {
      ctx.warn('Could not load font ' + k + '; using Inter Regular');
      toLoad[k].failed = true;
    });
  }));
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  specs.forEach(function (spec) {
    if (spec._font.failed) spec._font = { family: 'Inter', style: 'Regular' };
  });
}

// ----------------------------------------------------------------------------
// Node builder
// ----------------------------------------------------------------------------

var ALIGN_MAP = {
  start: 'MIN', min: 'MIN', left: 'MIN', top: 'MIN', 'flex-start': 'MIN',
  center: 'CENTER', middle: 'CENTER',
  end: 'MAX', max: 'MAX', right: 'MAX', bottom: 'MAX', 'flex-end': 'MAX',
  'space-between': 'SPACE_BETWEEN', space_between: 'SPACE_BETWEEN', between: 'SPACE_BETWEEN',
  baseline: 'BASELINE', stretch: 'MIN',
};

function mapAlign(v) {
  if (!v) return null;
  var k = String(v).toLowerCase();
  return ALIGN_MAP[k] || String(v).toUpperCase();
}

function padding4(p) {
  if (p == null) return null;
  if (typeof p === 'number') return [p, p, p, p];
  if (Array.isArray(p)) {
    if (p.length === 2) return [p[0], p[1], p[0], p[1]];
    if (p.length === 3) return [p[0], p[1], p[2], p[1]];
    return [p[0] || 0, p[1] || 0, p[2] || 0, p[3] || 0];
  }
  return [p.top || 0, p.right || 0, p.bottom || 0, p.left || 0];
}

function collectTextSpecs(spec, out) {
  if (!spec) return out;
  if (spec.type && String(spec.type).toUpperCase() === 'TEXT') {
    out.push(spec);
    // Styled ranges inherit the base font unless they override it.
    (spec.segments || []).forEach(function (sg) {
      if (sg.fontFamily == null) { sg.fontFamily = spec.fontFamily; sg.fontFallbacks = spec.fontFallbacks; }
      if (sg.fontWeight == null) sg.fontWeight = spec.fontWeight;
      if (sg.italic == null) sg.italic = spec.italic;
      if (sg.fontStyle == null && spec.fontStyle && sg.fontFamily === spec.fontFamily && sg.fontWeight === spec.fontWeight) sg.fontStyle = spec.fontStyle;
      out.push(sg);
    });
  }
  (spec.children || []).forEach(function (c) { collectTextSpecs(c, out); });
  return out;
}

function makeCtx(assets) {
  var ctx = {
    assets: assets || {},
    imageHashes: {},
    missingFonts: {},
    warnings: [],
    errors: [],
    count: 0,
    warn: function (w) { if (ctx.warnings.length < 50) ctx.warnings.push(w); },
  };
  return ctx;
}

function isAutoLayout(n) {
  return n && 'layoutMode' in n && n.layoutMode && n.layoutMode !== 'NONE';
}

async function createNodes(p) {
  var specs = p.nodes || (p.node ? [p.node] : []);
  if (!specs.length) throw new Error('No nodes given');
  var ctx = makeCtx(p.assets);
  var texts = [];
  specs.forEach(function (s) { collectTextSpecs(s, texts); });
  if (texts.length) {
    progress('Loading fonts for ' + texts.length + ' text layers…');
    await prepareFonts(texts, ctx);
  }

  var parent = figma.currentPage;
  if (p.parentId) parent = await requireNode(p.parentId);
  if (!('appendChild' in parent)) throw new Error('Parent cannot contain children: ' + parent.type);

  // Nodes with explicit x/y are placed there (offset by p.x/p.y). Others go
  // at p.x/p.y, or on a page, to the right of the existing content.
  var autoX = p.x != null ? p.x : 0;
  var autoY = p.y != null ? p.y : 0;
  if (parent.type === 'PAGE' && p.x == null) {
    var maxRight = null;
    var minTop = null;
    parent.children.forEach(function (n) {
      maxRight = maxRight == null ? n.x + n.width : Math.max(maxRight, n.x + n.width);
      minTop = minTop == null ? n.y : Math.min(minTop, n.y);
    });
    autoX = maxRight == null ? 0 : Math.round(maxRight + 120);
    if (p.y == null) autoY = minTop == null ? 0 : minTop;
  }

  var created = [];
  for (var i = 0; i < specs.length; i++) {
    var spec = specs[i];
    var node = await build(spec, parent, ctx, true);
    if (!node) continue;
    if (!isAutoLayout(parent) || spec.absolute) {
      if (spec.x != null || spec.y != null) {
        node.x = (p.x || 0) + (spec.x || 0);
        node.y = (p.y || 0) + (spec.y || 0);
      } else {
        node.x = autoX;
        node.y = autoY;
        autoX += node.width + 120;
      }
    }
    created.push(node);
  }

  try {
    if (p.select !== false && created.length) figma.currentPage.selection = created;
    if (p.zoom !== false && created.length) figma.viewport.scrollAndZoomIntoView(created);
  } catch (e) {
    // Parent may live on another page; selection is best-effort.
  }
  figma.notify('Created ' + ctx.count + ' layers');

  return {
    created: created.map(function (n) {
      return { id: n.id, name: n.name, type: n.type, x: r2(n.x), y: r2(n.y), width: r2(n.width), height: r2(n.height) };
    }),
    layerCount: ctx.count,
    missingFonts: ctx.missingFonts,
    warnings: ctx.warnings,
    errors: ctx.errors.slice(0, 30),
  };
}

async function build(spec, parent, ctx, isTop) {
  var type = String(spec.type || 'FRAME').toUpperCase();
  var node;
  try {
    node = await createRaw(type, spec, ctx);
  } catch (e) {
    ctx.errors.push((spec.name || type) + ': ' + e.message);
    if (type === 'SVG' && spec._rasterFallback && ctx.assets[spec._rasterFallback]) {
      node = figma.createRectangle();
      node.fills = toPaints([{ type: 'IMAGE', imageRef: spec._rasterFallback }], 0, 0, ctx) || [];
      node.name = (spec.name || 'svg') + ' (raster)';
      node.resize(Math.max(0.01, spec.width || 1), Math.max(0.01, spec.height || 1));
    } else {
      return null;
    }
  }
  ctx.count++;
  // Top-level frames default to white like Figma's own frame tool.
  if (isTop && (type === 'FRAME' || type === 'COMPONENT') && spec.fills === undefined && spec.fill === undefined) {
    node.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  }
  if (ctx.count % 400 === 0) {
    progress('Created ' + ctx.count + ' layers…');
    await new Promise(function (r) { setTimeout(r, 0); });
  }

  try {
    parent.appendChild(node);
    applyProps(node, spec, ctx, { isTop: isTop, isNew: true, type: type });
  } catch (e) {
    ctx.errors.push((spec.name || type) + ': ' + e.message);
  }

  if (spec.children && 'appendChild' in node && type !== 'SVG' && type !== 'INSTANCE') {
    for (var i = 0; i < spec.children.length; i++) {
      await build(spec.children[i], node, ctx, false);
    }
  }
  if (type === 'TEXT') anchorText(node, spec);
  return node;
}

async function createRaw(type, spec, ctx) {
  switch (type) {
    case 'FRAME': {
      var f = figma.createFrame();
      f.fills = [];
      return f;
    }
    case 'COMPONENT': {
      var c = figma.createComponent();
      c.fills = [];
      return c;
    }
    case 'RECTANGLE':
    case 'IMAGE':
      return figma.createRectangle();
    case 'ELLIPSE':
      return figma.createEllipse();
    case 'LINE':
      return figma.createLine();
    case 'POLYGON':
      return figma.createPolygon();
    case 'STAR':
      return figma.createStar();
    case 'TEXT': {
      var t = figma.createText();
      t.fontName = spec._font || { family: 'Inter', style: 'Regular' };
      return t;
    }
    case 'SVG': {
      if (!spec.svg) throw new Error('SVG node needs an `svg` string');
      return figma.createNodeFromSvg(spec.svg);
    }
    case 'INSTANCE': {
      var comp = await figma.getNodeByIdAsync(spec.componentId);
      if (!comp || comp.type !== 'COMPONENT') throw new Error('Component not found: ' + spec.componentId);
      return comp.createInstance();
    }
    default:
      throw new Error('Unsupported node type: ' + type);
  }
}

function applyProps(node, spec, ctx, opts) {
  opts = opts || {};
  var type = opts.type || node.type;
  var parent = node.parent;
  var inAutoLayout = isAutoLayout(parent);

  if (spec.name != null) node.name = String(spec.name);
  else if (opts.isNew && type === 'IMAGE') node.name = 'Image';

  // --- text content first (sizing depends on it) ---
  if (node.type === 'TEXT') applyText(node, spec, ctx, opts.isNew);

  // --- auto layout container props ---
  if (spec.layout && 'layoutMode' in node) applyLayout(node, spec.layout);

  // --- size ---
  var w = spec.width;
  var h = spec.height;
  if (node.type === 'TEXT') {
    applyTextSizing(node, spec, opts.isNew);
    // Truncation only sticks on fixed-size text, so apply it after sizing.
    // A one-line fixed box gives CSS-style `text-overflow: ellipsis`;
    // maxLines limits auto-height text instead.
    if (spec.truncate || spec.maxLines != null) {
      if (node.textAutoResize === 'WIDTH_AND_HEIGHT') node.textAutoResize = 'NONE';
      node.textTruncation = 'ENDING';
      if (spec.maxLines != null) {
        try { node.maxLines = spec.maxLines; } catch (e) { ctx.warn('maxLines unsupported: ' + e.message); }
      }
    } else if (spec.truncate === false) {
      node.textTruncation = 'DISABLED';
    }
  } else if (type === 'SVG') {
    if (w != null && h != null && (Math.abs(node.width - w) > 0.5 || Math.abs(node.height - h) > 0.5)) {
      node.rescale(Math.max(0.01, w) / Math.max(0.01, node.width));
      if (Math.abs(node.height - h) > 0.5) node.resize(Math.max(0.01, w), Math.max(0.01, h));
    }
  } else if (node.type === 'LINE') {
    if (w != null) node.resize(Math.max(0.01, w), 0);
  } else if (w != null || h != null) {
    node.resize(Math.max(0.01, w != null ? w : node.width), Math.max(0.01, h != null ? h : node.height));
  }

  // --- position ---
  if (spec.absolute && inAutoLayout) node.layoutPositioning = 'ABSOLUTE';
  if (spec.absolute === false && inAutoLayout && node.layoutPositioning === 'ABSOLUTE') node.layoutPositioning = 'AUTO';
  var isAbsolute = inAutoLayout && 'layoutPositioning' in node && node.layoutPositioning === 'ABSOLUTE';
  if (!inAutoLayout || isAbsolute) {
    if (spec.x != null && !opts.isTop) node.x = spec.x;
    if (spec.y != null && !opts.isTop) node.y = spec.y;
    if (!opts.isNew && opts.isTop) {
      if (spec.x != null) node.x = spec.x;
      if (spec.y != null) node.y = spec.y;
    }
  }

  // --- sizing modes (auto layout) ---
  applySizing(node, spec, inAutoLayout, opts.isNew);

  // --- visuals ---
  var pw = node.width;
  var ph = node.height;
  if ((spec.image || spec.imageRef) && node.type !== 'TEXT' && 'fills' in node) {
    var imgFill = toPaint({ type: 'IMAGE', image: spec.image, imageRef: spec.imageRef, scaleMode: spec.scaleMode }, pw, ph, ctx);
    node.fills = imgFill ? [imgFill] : [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }];
  }
  if (spec.fills !== undefined && node.type !== 'TEXT' && type !== 'SVG') node.fills = toPaints(spec.fills, pw, ph, ctx) || [];
  if (spec.fill !== undefined && node.type !== 'TEXT' && type !== 'SVG') node.fills = toPaints(spec.fill, pw, ph, ctx) || [];
  if (spec.strokes !== undefined || spec.stroke !== undefined) {
    node.strokes = toPaints(spec.strokes !== undefined ? spec.strokes : spec.stroke, pw, ph, ctx) || [];
  }
  if (spec.strokeAlign && 'strokeAlign' in node && node.type !== 'LINE') node.strokeAlign = spec.strokeAlign;
  else if (opts.isNew && (spec.strokes || spec.stroke) && 'strokeAlign' in node && node.type !== 'LINE' && node.type !== 'TEXT') node.strokeAlign = 'INSIDE';
  if (spec.strokeWeight != null) node.strokeWeight = spec.strokeWeight;
  if (spec.strokeWeights && 'strokeTopWeight' in node) {
    var sw = spec.strokeWeights;
    node.strokeTopWeight = sw.top || 0;
    node.strokeRightWeight = sw.right || 0;
    node.strokeBottomWeight = sw.bottom || 0;
    node.strokeLeftWeight = sw.left || 0;
  }
  if (spec.dashPattern && 'dashPattern' in node) node.dashPattern = spec.dashPattern;
  if (spec.cornerRadius != null && 'cornerRadius' in node) {
    if (Array.isArray(spec.cornerRadius) && 'topLeftRadius' in node) {
      var cr = spec.cornerRadius;
      node.topLeftRadius = cr[0] || 0;
      node.topRightRadius = cr[1] != null ? cr[1] : cr[0] || 0;
      node.bottomRightRadius = cr[2] != null ? cr[2] : cr[0] || 0;
      node.bottomLeftRadius = cr[3] != null ? cr[3] : cr[1] != null ? cr[1] : cr[0] || 0;
    } else if (!Array.isArray(spec.cornerRadius)) {
      node.cornerRadius = spec.cornerRadius;
    }
  }
  if (spec.effects !== undefined) setEffects(node, toEffects(spec.effects));
  if (spec.opacity != null) node.opacity = clamp01(spec.opacity);
  if (spec.visible != null) node.visible = !!spec.visible;
  if (spec.locked != null) node.locked = !!spec.locked;
  if (spec.rotation != null) node.rotation = spec.rotation;
  if (spec.blendMode) node.blendMode = spec.blendMode;
  if ('clipsContent' in node && type !== 'SVG') {
    if (spec.clipsContent != null) node.clipsContent = !!spec.clipsContent;
    else if (opts.isNew) node.clipsContent = !!opts.isTop;
  }
  if (spec.constraints && 'constraints' in node) node.constraints = spec.constraints;
  if (spec.characters != null && node.type !== 'TEXT') ctx.warn('`characters` ignored on non-text node ' + node.name);
}

function applyLayout(node, L) {
  if (L.mode === null || L.mode === 'NONE' || L.mode === 'none') {
    node.layoutMode = 'NONE';
    return;
  }
  var mode = String(L.mode || 'VERTICAL').toUpperCase();
  if (mode === 'ROW') mode = 'HORIZONTAL';
  if (mode === 'COLUMN') mode = 'VERTICAL';
  node.layoutMode = mode;
  if (L.wrap != null && mode === 'HORIZONTAL') node.layoutWrap = L.wrap ? 'WRAP' : 'NO_WRAP';
  if (L.gap != null) {
    if (L.gap === 'auto') node.primaryAxisAlignItems = 'SPACE_BETWEEN';
    else node.itemSpacing = L.gap;
  }
  if (L.rowGap != null && node.layoutWrap === 'WRAP') node.counterAxisSpacing = L.rowGap;
  var pad = padding4(L.padding);
  if (pad) {
    node.paddingTop = pad[0];
    node.paddingRight = pad[1];
    node.paddingBottom = pad[2];
    node.paddingLeft = pad[3];
  }
  if (L.justify) node.primaryAxisAlignItems = mapAlign(L.justify);
  if (L.align) node.counterAxisAlignItems = mapAlign(L.align);
  if (L.strokesIncludedInLayout != null) node.strokesIncludedInLayout = !!L.strokesIncludedInLayout;
}

function normSizing(v) {
  if (!v) return null;
  var s = String(v).toUpperCase();
  if (s === 'FIT' || s === 'AUTO' || s === 'HUG_CONTENTS') return 'HUG';
  if (s === 'STRETCH' || s === 'FILL_CONTAINER') return 'FILL';
  return s;
}

function applySizing(node, spec, inAutoLayout, isNew) {
  if (!('layoutSizingHorizontal' in node)) return;
  var selfAuto = isAutoLayout(node);
  var sz = spec.sizing || {};
  var hz = normSizing(sz.horizontal || sz.width);
  var vt = normSizing(sz.vertical || sz.height);
  // Defaults for new auto-layout frames: hug unless a size was given.
  if (isNew && selfAuto) {
    if (!hz) hz = spec.width != null ? 'FIXED' : 'HUG';
    if (!vt) vt = spec.height != null ? 'FIXED' : 'HUG';
  }
  var ok = function (mode) {
    if (mode === 'FILL') return inAutoLayout && !spec.absolute;
    if (mode === 'HUG') return selfAuto || node.type === 'TEXT';
    return true;
  };
  if (hz && ok(hz)) node.layoutSizingHorizontal = hz;
  if (vt && ok(vt)) node.layoutSizingVertical = vt;
  // A fill-width text box must wrap: switch auto-width text to auto-height.
  if (node.type === 'TEXT' && hz === 'FILL' && ok(hz) && node.textAutoResize === 'WIDTH_AND_HEIGHT') {
    node.textAutoResize = 'HEIGHT';
  }
  if (spec.grow != null && inAutoLayout) node.layoutGrow = spec.grow ? 1 : 0;
  if (spec.minWidth != null && (selfAuto || inAutoLayout)) node.minWidth = spec.minWidth;
  if (spec.maxWidth != null && (selfAuto || inAutoLayout)) node.maxWidth = spec.maxWidth;
}

function applyText(node, spec, ctx, isNew) {
  if (spec._font) node.fontName = spec._font;
  var chars = spec.text != null ? spec.text : spec.characters;
  if (chars != null) node.characters = String(chars);
  if (spec.fontSize != null) node.fontSize = Math.max(1, spec.fontSize);
  if (spec.lineHeight != null) {
    var lh = spec.lineHeight;
    if (lh === 'auto' || lh === 'AUTO') node.lineHeight = { unit: 'AUTO' };
    else if (typeof lh === 'string' && lh.slice(-1) === '%') node.lineHeight = { unit: 'PERCENT', value: parseFloat(lh) };
    else node.lineHeight = { unit: 'PIXELS', value: +lh };
  }
  if (spec.letterSpacing != null) {
    var ls = spec.letterSpacing;
    if (typeof ls === 'string' && ls.slice(-1) === '%') node.letterSpacing = { unit: 'PERCENT', value: parseFloat(ls) };
    else node.letterSpacing = { unit: 'PIXELS', value: +ls };
  }
  if (spec.textCase) node.textCase = spec.textCase;
  if (spec.textDecoration) node.textDecoration = spec.textDecoration;
  if (spec.textAlign) node.textAlignHorizontal = String(spec.textAlign).toUpperCase();
  if (spec.verticalAlign) node.textAlignVertical = String(spec.verticalAlign).toUpperCase();
  if (spec.color != null) node.fills = toPaints([spec.color], 0, 0, ctx);
  else if (spec.fills !== undefined) node.fills = toPaints(spec.fills, node.width, node.height, ctx) || [];
  if (spec.paragraphSpacing != null) node.paragraphSpacing = spec.paragraphSpacing;
  if (spec.segments) applySegments(node, spec, ctx);
}

// Styled character ranges: [{ start, end, fontFamily?, fontWeight?, italic?,
// fontSize?, color?, textDecoration?, textCase?, letterSpacing? }]
function applySegments(node, spec, ctx) {
  var len = node.characters.length;
  var base = spec._font || (node.fontName !== figma.mixed ? node.fontName : null);
  spec.segments.forEach(function (sg) {
    var s = Math.max(0, Math.min(len, sg.start || 0));
    var e = Math.max(0, Math.min(len, sg.end == null ? len : sg.end));
    if (e <= s) return;
    try {
      if (sg._font && (!base || sg._font.family !== base.family || sg._font.style !== base.style)) node.setRangeFontName(s, e, sg._font);
      if (sg.fontSize != null) node.setRangeFontSize(s, e, Math.max(1, sg.fontSize));
      if (sg.color != null) node.setRangeFills(s, e, toPaints([sg.color], 0, 0, ctx));
      if (sg.textDecoration) node.setRangeTextDecoration(s, e, sg.textDecoration);
      if (sg.textCase) node.setRangeTextCase(s, e, sg.textCase);
      if (sg.letterSpacing != null) node.setRangeLetterSpacing(s, e, { unit: 'PIXELS', value: +sg.letterSpacing });
    } catch (err) {
      ctx.warn('Text range ' + s + '-' + e + ' on "' + node.name + '": ' + err.message);
    }
  });
}

function applyTextSizing(node, spec, isNew) {
  var mode = spec.autoResize ? String(spec.autoResize).toUpperCase() : null;
  if (!mode && isNew) mode = spec.width != null ? 'HEIGHT' : 'WIDTH_AND_HEIGHT';
  if (mode === 'WIDTH_AND_HEIGHT') {
    node.textAutoResize = 'WIDTH_AND_HEIGHT';
  } else if (mode === 'HEIGHT') {
    node.resize(Math.max(1, spec.width != null ? spec.width : node.width), Math.max(1, node.height));
    node.textAutoResize = 'HEIGHT';
  } else if (mode === 'NONE' || mode === 'TRUNCATE') {
    node.resize(Math.max(1, spec.width != null ? spec.width : node.width), Math.max(1, spec.height != null ? spec.height : node.height));
    node.textAutoResize = mode;
  } else if (spec.width != null || spec.height != null) {
    node.resize(Math.max(1, spec.width != null ? spec.width : node.width), Math.max(1, spec.height != null ? spec.height : node.height));
  }
}

// Imported single-line text keeps its original center/right edge even when
// Figma's font metrics differ slightly from the browser's.
function anchorText(node, spec) {
  if (!spec.textAnchor || spec.textAnchor === 'LEFT' || spec.width == null || spec.x == null) return;
  if (isAutoLayout(node.parent) && !spec.absolute) return;
  if (spec.textAnchor === 'CENTER') node.x = spec.x + (spec.width - node.width) / 2;
  else if (spec.textAnchor === 'RIGHT') node.x = spec.x + spec.width - node.width;
}

async function updateNode(p) {
  var node = await requireNode(p.id);
  var props = p.props || {};
  var ctx = makeCtx(p.assets);
  if (props.parentId) {
    var parent = await requireNode(props.parentId);
    if (props.index != null) parent.insertChild(props.index, node);
    else parent.appendChild(node);
  } else if (props.index != null && node.parent) {
    node.parent.insertChild(props.index, node);
  }
  if (node.type === 'TEXT') {
    var needsFont = props.fontFamily || props.fontWeight || props.fontStyle || props.italic != null;
    if (needsFont) {
      if (!props.fontFamily && node.fontName !== figma.mixed) props.fontFamily = node.fontName.family;
      await prepareFonts([props], ctx);
    } else if (node.fontName !== figma.mixed) {
      await figma.loadFontAsync(node.fontName);
    } else {
      var fonts = node.getRangeAllFontNames(0, node.characters.length);
      await Promise.all(fonts.map(function (f) { return figma.loadFontAsync(f); }));
    }
  }
  applyProps(node, props, ctx, { isNew: false, isTop: node.parent && node.parent.type === 'PAGE' });
  return { node: await describe(node, 0), warnings: ctx.warnings, missingFonts: ctx.missingFonts };
}

// ----------------------------------------------------------------------------
// Serialization
// ----------------------------------------------------------------------------

function r2(v) {
  return Math.round(v * 100) / 100;
}

function hex(c, a) {
  var h = function (v) { return ('0' + Math.round(v * 255).toString(16)).slice(-2); };
  return '#' + h(c.r) + h(c.g) + h(c.b) + (a != null && a < 0.999 ? h(a) : '');
}

function describePaints(paints) {
  if (paints === figma.mixed) return 'mixed';
  if (!paints || !paints.length) return undefined;
  return paints.map(function (p) {
    if (p.type === 'SOLID') return hex(p.color, p.opacity);
    if (p.type === 'IMAGE') return { type: 'IMAGE', scaleMode: p.scaleMode };
    if (p.type.indexOf('GRADIENT') === 0) {
      return { type: p.type, stops: p.gradientStops.map(function (s) { return { position: r2(s.position), color: hex(s.color, s.color.a) }; }) };
    }
    return { type: p.type };
  });
}

async function describe(node, depth) {
  var d = { id: node.id, name: node.name, type: node.type };
  if ('x' in node) {
    d.x = r2(node.x); d.y = r2(node.y); d.width = r2(node.width); d.height = r2(node.height);
  }
  if ('visible' in node && !node.visible) d.visible = false;
  if ('opacity' in node && node.opacity < 1) d.opacity = r2(node.opacity);
  if ('fills' in node) { var f = describePaints(node.fills); if (f) d.fills = f; }
  if ('strokes' in node) {
    var s = describePaints(node.strokes);
    if (s) { d.strokes = s; d.strokeWeight = node.strokeWeight === figma.mixed ? 'mixed' : node.strokeWeight; }
  }
  if ('cornerRadius' in node && node.cornerRadius) {
    d.cornerRadius = node.cornerRadius === figma.mixed
      ? [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius]
      : node.cornerRadius;
  }
  if ('effects' in node && node.effects.length) {
    d.effects = node.effects.map(function (e) {
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        return { type: e.type, color: hex(e.color, e.color.a), x: e.offset.x, y: e.offset.y, blur: e.radius, spread: e.spread };
      }
      return { type: e.type, radius: e.radius };
    });
  }
  if (isAutoLayout(node)) {
    d.layout = {
      mode: node.layoutMode,
      gap: node.itemSpacing,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
      justify: node.primaryAxisAlignItems,
      align: node.counterAxisAlignItems,
    };
    if (node.layoutWrap === 'WRAP') d.layout.wrap = true;
  }
  if ('layoutSizingHorizontal' in node && (isAutoLayout(node) || isAutoLayout(node.parent))) {
    d.sizing = { horizontal: node.layoutSizingHorizontal, vertical: node.layoutSizingVertical };
  }
  if ('clipsContent' in node && node.clipsContent) d.clipsContent = true;
  if (node.type === 'TEXT') {
    d.text = node.characters.length > 1000 ? node.characters.slice(0, 1000) + '…' : node.characters;
    if (node.fontName !== figma.mixed) { d.fontFamily = node.fontName.family; d.fontStyle = node.fontName.style; }
    if (node.fontSize !== figma.mixed) d.fontSize = node.fontSize;
    d.textAlign = node.textAlignHorizontal;
    d.autoResize = node.textAutoResize;
    if (node.textTruncation === 'ENDING') { d.truncate = true; d.maxLines = node.maxLines; }
  }
  if (node.type === 'INSTANCE') {
    var main = await node.getMainComponentAsync();
    if (main) d.componentId = main.id;
  }
  if ('children' in node) {
    if (depth > 0) {
      d.children = [];
      for (var i = 0; i < node.children.length; i++) d.children.push(await describe(node.children[i], depth - 1));
    } else if (node.children.length) {
      d.childCount = node.children.length;
    }
  }
  return d;
}

// ----------------------------------------------------------------------------
// Export as HTML: turns a frame (board) into one self-contained .html file.
// Auto layout becomes flexbox (or everything is absolutely positioned with
// layout: 'absolute'), icons and vectors become inline SVG, image fills are
// embedded as data URLs and Google Fonts are linked for the fonts used.
// ----------------------------------------------------------------------------

var HTML_VECTOR = { VECTOR: 1, BOOLEAN_OPERATION: 1, STAR: 1, POLYGON: 1, LINE: 1 };
var HTML_CONTAINER = { FRAME: 1, GROUP: 1, COMPONENT: 1, COMPONENT_SET: 1, INSTANCE: 1, SECTION: 1 };
var HTML_ICON_MAX = 200; // vector-only frames up to this size become one SVG
var SYSTEM_FONTS = /^(\.?sf |sf pro|sf compact|new york|helvetica|arial|times|courier|georgia|verdana|tahoma|menlo|monaco|segoe|system-ui|apple)/i;

async function exportHtml(p) {
  var node = p.id ? await requireNode(p.id) : figma.currentPage.selection[0];
  if (!node) throw new Error('Select a board (frame) to export.');
  if (!('absoluteTransform' in node)) throw new Error(node.type + ' cannot be exported as HTML.');
  var ctx = {
    rules: [], names: {}, images: {}, imageVars: [], fonts: {}, svgSeq: 0, warnings: [],
    absolute: p.layout === 'absolute',
    stats: { layers: 0, texts: 0, images: 0, svgs: 0, rasters: 0 },
  };
  progress('Exporting "' + node.name + '" as HTML…');
  var body = await htmlNode(node, ctx, { root: true, parent: null, flex: false, abs: node.absoluteTransform, depth: 1 });

  var head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + escHtml(node.name.trim() || 'Board') + '</title>',
  ];
  var links = p.googleFonts === false ? [] : googleFontLinks(ctx.fonts);
  if (links.length) {
    head.push('<link rel="preconnect" href="https://fonts.googleapis.com">');
    head.push('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
    links.forEach(function (l) { head.push('<link rel="stylesheet" href="' + escHtml(l) + '">'); });
  }
  var css = [
    '*, *::before, *::after { box-sizing: border-box; }',
    'body { margin: 0; background: #ffffff; -webkit-font-smoothing: antialiased; }',
    'p { margin: 0; }',
    'a { color: inherit; }',
    'svg, img { display: block; }',
  ].concat(ctx.rules);
  head.push('<style>\n' + css.join('\n') + '\n</style>');
  if (ctx.imageVars.length) head.push('<style>\n/* Embedded images */\n:root {\n' + ctx.imageVars.join('\n') + '\n}\n</style>');

  var html = '<!DOCTYPE html>\n<html>\n<head>\n' + head.join('\n') + '\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';
  var fileName = (node.name.trim() || 'board').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() + '.html';
  return { html: html, name: node.name, id: node.id, fileName: fileName, bytes: html.length, stats: ctx.stats, warnings: ctx.warnings };
}

async function htmlNode(node, ctx, env) {
  if (node.visible === false) return '';
  ctx.stats.layers++;
  if (ctx.stats.layers % 250 === 0) {
    progress('HTML: ' + ctx.stats.layers + ' layers…');
    await new Promise(function (r) { setTimeout(r, 0); });
  }
  var ind = new Array(env.depth).join('  ');
  var cls = htmlClass(node, ctx);
  var st = [];

  if (!env.root) {
    var kind = graphicKind(node);
    if (kind) {
      var out = await graphicHtml(node, kind, cls, ind, ctx, env);
      if (out != null) return out;
    }
  }

  var isFlex = !ctx.absolute && HTML_CONTAINER[node.type] && node.layoutMode && node.layoutMode !== 'NONE' && node.layoutMode !== 'GRID';
  // A container whose content is absolutely positioned (no auto layout, Figma grid layout, groups)
  // or that has nothing visible can't "hug" in CSS: give it Figma's size.
  var hugFixed = !!HTML_CONTAINER[node.type] && (!isFlex ||
    !('children' in node) || !node.children.some(function (c) { return c.visible !== false; }));
  placeNode(node, st, env, null, hugFixed);
  if (node.type === 'TEXT') return textNodeHtml(node, cls, st, ind, ctx);

  var after = await boxStyles(node, st, ctx);
  if (isFlex) flexStyles(node, st, ctx);
  pushRule(ctx, '.' + cls, st);
  if (after) pushRule(ctx, '.' + cls + '::after', after);

  var kids = [];
  if ('children' in node) {
    var childEnv = { root: false, parent: node, flex: isFlex, abs: node.absoluteTransform, depth: env.depth + 1 };
    for (var i = 0; i < node.children.length; i++) {
      var h = await htmlNode(node.children[i], ctx, childEnv);
      if (h) kids.push(h);
    }
  }
  if (!kids.length) return ind + '<div class="' + cls + '"></div>';
  return ind + '<div class="' + cls + '">\n' + kids.join('\n') + '\n' + ind + '</div>';
}

// --- naming and CSS output ---------------------------------------------------

function htmlClass(node, ctx) {
  var base = String(node.name || '');
  try { base = base.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
  base = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  if (!/^[a-z]/.test(base)) base = node.type.toLowerCase().replace(/_/g, '-') + (base ? '-' + base : '');
  var n = ctx.names[base] = (ctx.names[base] || 0) + 1;
  return n === 1 ? base : base + '-' + n;
}

function pushRule(ctx, selector, st) {
  if (!st.length) return;
  ctx.rules.push(selector + ' {\n' + st.map(function (d) { return '  ' + d[0] + ': ' + d[1] + ';'; }).join('\n') + '\n}');
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cssPx(v) {
  var r = Math.round(v * 100) / 100;
  return r === 0 ? '0' : r + 'px';
}

// CSS box shorthand: [t, r, b, l] → "8px", "8px 16px", …
function cssBox(v) {
  var c = v.map(cssPx);
  if (c[1] === c[3]) {
    c.pop();
    if (c[0] === c[2]) { c.pop(); if (c[0] === c[1]) c.pop(); }
  }
  return c.join(' ');
}

function cssNum(v) {
  return String(Math.round(v * 1000) / 1000);
}

function cssColor(c, a) {
  var alpha = a == null ? (c.a == null ? 1 : c.a) : a;
  var r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
  if (alpha >= 0.999) return '#' + [r, g, b].map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + cssNum(alpha) + ')';
}

function utf8Decode(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, i, i + 8192));
  }
  try { return decodeURIComponent(escape(out)); } catch (e) { return out; }
}

// --- 2D transforms ([[a, c, e], [b, d, f]], as in Figma) -----------------------

function mInvert(m) {
  var a = m[0][0], c = m[0][1], e = m[0][2], b = m[1][0], d = m[1][1], f = m[1][2];
  var det = a * d - b * c || 1e-9;
  return [[d / det, -c / det, (c * f - d * e) / det], [-b / det, a / det, (b * e - a * f) / det]];
}

function mMul(m, n) {
  return [
    [m[0][0] * n[0][0] + m[0][1] * n[1][0], m[0][0] * n[0][1] + m[0][1] * n[1][1], m[0][0] * n[0][2] + m[0][1] * n[1][2] + m[0][2]],
    [m[1][0] * n[0][0] + m[1][1] * n[1][0], m[1][0] * n[0][1] + m[1][1] * n[1][1], m[1][0] * n[0][2] + m[1][1] * n[1][2] + m[1][2]],
  ];
}

function mApply(m, x, y) {
  return { x: m[0][0] * x + m[0][1] * y + m[0][2], y: m[1][0] * x + m[1][1] * y + m[1][2] };
}

// --- position and size -----------------------------------------------------------

function layoutSizing(node, axis) {
  try {
    var v = axis === 'H' ? node.layoutSizingHorizontal : node.layoutSizingVertical;
    if (v) return v;
  } catch (e) {}
  return 'FIXED';
}

// box: an axis-aligned absolute box to use instead of the node's own transform
// (for SVG/PNG exports, which already contain any rotation).
function placeNode(node, st, env, box, hugFixed) {
  var w = box ? box.width : node.width;
  var h = box ? box.height : node.height;
  if (env.root) {
    st.push(['position', 'relative'], ['width', cssPx(w)]);
    var hugV = node.layoutMode && node.layoutMode !== 'NONE' && layoutSizing(node, 'V') === 'HUG';
    st.push([hugV ? 'min-height' : 'height', cssPx(h)]);
    st.push(['margin', '0 auto']);
    return;
  }
  if (env.flex && node.layoutPositioning !== 'ABSOLUTE') {
    st.push(['position', 'relative']);
    var horiz = env.parent.layoutMode === 'HORIZONTAL';
    var sh = box ? 'FIXED' : layoutSizing(node, 'H');
    var sv = box ? 'FIXED' : layoutSizing(node, 'V');
    if (hugFixed) { if (sh === 'HUG') sh = 'FIXED'; if (sv === 'HUG') sv = 'FIXED'; }
    var prim = horiz ? sh : sv, cross = horiz ? sv : sh;
    var pdim = horiz ? 'width' : 'height', cdim = horiz ? 'height' : 'width';
    if (prim === 'FILL') st.push(['flex', '1 1 0'], ['min-' + pdim, '0']);
    else {
      st.push(['flex-shrink', '0']);
      if (prim === 'FIXED') st.push([pdim, cssPx(horiz ? w : h)]);
    }
    if (cross === 'FILL') st.push(['align-self', 'stretch']);
    else if (cross === 'FIXED') st.push([cdim, cssPx(horiz ? h : w)]);
    [['minWidth', 'min-width'], ['maxWidth', 'max-width'], ['minHeight', 'min-height'], ['maxHeight', 'max-height']].forEach(function (k) {
      if (node[k[0]] != null && !(prim === 'FILL' && k[1] === 'min-' + pdim)) st.push([k[1], cssPx(node[k[0]])]);
    });
    return;
  }
  var inv = mInvert(env.abs);
  if (box) {
    var pt = mApply(inv, box.x, box.y);
    st.push(['position', 'absolute'], ['left', cssPx(pt.x)], ['top', cssPx(pt.y)], ['width', cssPx(w)], ['height', cssPx(h)]);
    return;
  }
  var rel = mMul(inv, node.absoluteTransform);
  st.push(['position', 'absolute'], ['left', cssPx(rel[0][2])], ['top', cssPx(rel[1][2])], ['width', cssPx(w)], ['height', cssPx(h)]);
  var a = rel[0][0], b = rel[1][0], c = rel[0][1], d = rel[1][1];
  if (Math.abs(a - 1) > 1e-4 || Math.abs(d - 1) > 1e-4 || Math.abs(b) > 1e-4 || Math.abs(c) > 1e-4) {
    st.push(['transform', 'matrix(' + [a, b, c, d].map(cssNum).join(', ') + ', 0, 0)'], ['transform-origin', '0 0']);
  }
}

function flexStyles(node, st, ctx) {
  var horiz = node.layoutMode === 'HORIZONTAL';
  st.push(['display', 'flex'], ['flex-direction', horiz ? 'row' : 'column']);
  var between = node.primaryAxisAlignItems === 'SPACE_BETWEEN';
  var justify = { CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' }[node.primaryAxisAlignItems];
  if (justify) st.push(['justify-content', justify]);
  st.push(['align-items', { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' }[node.counterAxisAlignItems] || 'flex-start']);
  var gap = between ? 0 : node.itemSpacing || 0;
  if (gap < 0) { ctx.warnings.push('Negative spacing in "' + node.name + '" was set to 0.'); gap = 0; }
  if (node.layoutWrap === 'WRAP') {
    st.push(['flex-wrap', 'wrap']);
    var cross = node.counterAxisSpacing || 0;
    if (gap || cross) st.push(['gap', horiz ? cssPx(cross) + ' ' + cssPx(gap) : cssPx(gap) + ' ' + cssPx(cross)]);
  } else if (gap) st.push(['gap', cssPx(gap)]);
  var pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map(function (v) { return v || 0; });
  // "Include strokes in layout": the stroke takes room inside the frame, like a CSS border would.
  if (node.strokesIncludedInLayout && visiblePaints(node.strokes).length) {
    var sw = 'strokeTopWeight' in node
      ? [node.strokeTopWeight, node.strokeRightWeight, node.strokeBottomWeight, node.strokeLeftWeight]
      : [0, 1, 2, 3].map(function () { return node.strokeWeight === figma.mixed ? 1 : node.strokeWeight || 0; });
    pad = pad.map(function (v, i) { return v + (sw[i] || 0); });
  }
  if (pad.some(function (v) { return v; })) st.push(['padding', cssBox(pad)]);
}

// --- fills, strokes, corners, effects ----------------------------------------------

function visiblePaints(list) {
  if (!list || list === figma.mixed) return [];
  return list.filter(function (pt) { return pt.visible !== false && (pt.opacity == null || pt.opacity > 0); });
}

function hasVisibleFill(node) {
  return 'fills' in node && visiblePaints(node.fills).length > 0;
}

function radiiOf(node) {
  if (!('cornerRadius' in node)) return null;
  var r = node.cornerRadius === figma.mixed
    ? [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius]
    : [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius];
  return r.some(function (v) { return v > 0; }) ? r : null;
}

function radiusCss(r) {
  return cssBox(r); // same order trick works for corners (tl tr br bl)
}

async function boxStyles(node, st, ctx) {
  if ('fills' in node) await backgroundStyles(node, st, ctx);
  var radii = node.type === 'ELLIPSE' ? null : radiiOf(node);
  if (node.type === 'ELLIPSE') st.push(['border-radius', '50%']);
  else if (radii) st.push(['border-radius', radiusCss(radii)]);
  var after = strokeStyles(node, st, radii);
  effectStyles(node, st, false);
  commonStyles(node, st);
  if (node.clipsContent) st.push(['overflow', 'hidden']);
  return after;
}

function commonStyles(node, st) {
  if ('opacity' in node && node.opacity < 1) st.push(['opacity', cssNum(node.opacity)]);
  var blend = node.blendMode && { MULTIPLY: 'multiply', SCREEN: 'screen', OVERLAY: 'overlay', DARKEN: 'darken', LIGHTEN: 'lighten',
    COLOR_DODGE: 'color-dodge', COLOR_BURN: 'color-burn', HARD_LIGHT: 'hard-light', SOFT_LIGHT: 'soft-light', DIFFERENCE: 'difference',
    EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity' }[node.blendMode];
  if (blend) st.push(['mix-blend-mode', blend]);
}

async function backgroundStyles(node, st, ctx) {
  var paints = visiblePaints(node.fills).slice().reverse(); // CSS lists the top layer first
  if (!paints.length) return;
  var bottom = paints[paints.length - 1];
  if (bottom.type === 'SOLID') {
    st.push(['background-color', cssColor(bottom.color, bottom.opacity)]);
    paints = paints.slice(0, -1);
  }
  if (!paints.length) return;
  var layers = [], sizes = [], positions = [], repeats = [];
  for (var i = 0; i < paints.length; i++) {
    var pt = paints[i], layer = null, size = 'auto', pos = '0 0', rep = 'no-repeat';
    if (pt.type === 'SOLID') {
      var c = cssColor(pt.color, pt.opacity);
      layer = 'linear-gradient(' + c + ', ' + c + ')';
    } else if (/^GRADIENT_/.test(pt.type)) {
      layer = gradientCss(pt, node.width, node.height);
    } else if (pt.type === 'IMAGE') {
      var im = await imageLayer(pt, node, ctx);
      if (im) { layer = im.layer; size = im.size; pos = im.position; rep = im.repeat; }
    }
    if (!layer) continue;
    layers.push(layer); sizes.push(size); positions.push(pos); repeats.push(rep);
  }
  if (!layers.length) return;
  st.push(['background-image', layers.join(', ')]);
  if (sizes.some(function (s) { return s !== 'auto'; })) st.push(['background-size', sizes.join(', ')]);
  if (positions.some(function (s) { return s !== '0 0'; })) st.push(['background-position', positions.join(', ')]);
  st.push(['background-repeat', repeats.join(', ')]);
}

function gradientStops(pt, from, to) {
  var op = pt.opacity == null ? 1 : pt.opacity;
  return pt.gradientStops.map(function (s) {
    var t = from + s.position * (to - from);
    return cssColor(s.color, s.color.a * op) + ' ' + cssNum(t * 100) + '%';
  }).join(', ');
}

function gradientCss(pt, w, h) {
  var inv = mInvert(pt.gradientTransform);
  var pAt = function (x, y) { var q = mApply(inv, x, y); return { x: q.x * w, y: q.y * h }; };
  if (pt.type === 'GRADIENT_LINEAR') {
    var s = pAt(0, 0.5), e = pAt(1, 0.5);
    var dx = e.x - s.x, dy = e.y - s.y;
    var ang = Math.atan2(dx, -dy); // CSS: 0deg points up, clockwise
    var ux = Math.sin(ang), uy = -Math.cos(ang);
    var len = Math.abs(w * ux) + Math.abs(h * uy) || 1;
    var proj = function (q) { return ((q.x - w / 2) * ux + (q.y - h / 2) * uy + len / 2) / len; };
    return 'linear-gradient(' + cssNum(ang * 180 / Math.PI) + 'deg, ' + gradientStops(pt, proj(s), proj(e)) + ')';
  }
  var c = pAt(0.5, 0.5), rx = pAt(1, 0.5), ry = pAt(0.5, 1);
  var at = ' at ' + cssPx(c.x) + ' ' + cssPx(c.y);
  if (pt.type === 'GRADIENT_ANGULAR') {
    var from = Math.atan2(rx.x - c.x, -(rx.y - c.y)) * 180 / Math.PI;
    return 'conic-gradient(from ' + cssNum(from) + 'deg' + at + ', ' + gradientStops(pt, 0, 1) + ')';
  }
  var rw = Math.hypot(rx.x - c.x, rx.y - c.y), rh = Math.hypot(ry.x - c.x, ry.y - c.y);
  return 'radial-gradient(' + cssPx(rw) + ' ' + cssPx(rh) + at + ', ' + gradientStops(pt, 0, 1) + ')';
}

function imageMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp';
  return 'image/png';
}

async function imageVar(hash, ctx) {
  if (ctx.images[hash]) return ctx.images[hash];
  var img = figma.getImageByHash(hash);
  if (!img) return null;
  var bytes = await img.getBytesAsync();
  var size = await img.getSizeAsync();
  var name = '--image-' + (ctx.imageVars.length + 1);
  ctx.imageVars.push('  ' + name + ': url("data:' + imageMime(bytes) + ';base64,' + figma.base64Encode(bytes) + '");');
  ctx.stats.images++;
  ctx.images[hash] = { name: name, width: size.width, height: size.height };
  return ctx.images[hash];
}

async function imageLayer(pt, node, ctx) {
  if (!pt.imageHash) return null;
  var im;
  try { im = await imageVar(pt.imageHash, ctx); } catch (e) { ctx.warnings.push('Image in "' + node.name + '" could not be read.'); return null; }
  if (!im) return null;
  if (pt.opacity != null && pt.opacity < 1) ctx.warnings.push('Image opacity in "' + node.name + '" is not exported.');
  var out = { layer: 'var(' + im.name + ')', size: 'cover', position: 'center', repeat: 'no-repeat' };
  if (pt.scaleMode === 'FIT') out.size = 'contain';
  else if (pt.scaleMode === 'TILE') {
    var k = pt.scalingFactor || 1;
    out.size = cssPx(im.width * k) + ' ' + cssPx(im.height * k);
    out.position = '0 0';
    out.repeat = 'repeat';
  } else if (pt.scaleMode === 'CROP' && pt.imageTransform) {
    var inv = mInvert(pt.imageTransform);
    var o = mApply(inv, 0, 0), e = mApply(inv, 1, 1);
    out.size = cssPx((e.x - o.x) * node.width) + ' ' + cssPx((e.y - o.y) * node.height);
    out.position = cssPx(o.x * node.width) + ' ' + cssPx(o.y * node.height);
  }
  return out;
}

function strokeStyles(node, st, radii) {
  if (!('strokes' in node)) return null;
  var strokes = visiblePaints(node.strokes);
  if (!strokes.length) return null;
  var pt = strokes[0];
  var color = pt.type === 'SOLID' ? cssColor(pt.color, pt.opacity)
    : pt.gradientStops ? cssColor(pt.gradientStops[0].color, pt.gradientStops[0].color.a) : null;
  if (!color) return null;
  var sides;
  if ('strokeTopWeight' in node) sides = [node.strokeTopWeight, node.strokeRightWeight, node.strokeBottomWeight, node.strokeLeftWeight];
  else {
    var w = node.strokeWeight === figma.mixed ? 1 : node.strokeWeight;
    sides = [w, w, w, w];
  }
  if (!sides.some(function (v) { return v > 0; })) return null;
  var uniform = sides[0] === sides[1] && sides[1] === sides[2] && sides[2] === sides[3];
  var dash = node.dashPattern && node.dashPattern.length ? node.dashPattern : null;
  var style = dash ? (dash[0] <= Math.max(sides[0], 1) ? 'dotted' : 'dashed') : 'solid';
  var off = node.strokeAlign === 'OUTSIDE' ? 1 : node.strokeAlign === 'CENTER' ? 0.5 : 0;
  if (off === 1 && uniform && node.clipsContent) {
    // An ::after outside the box would be clipped by overflow: hidden.
    st.push(['outline', cssPx(sides[0]) + ' ' + style + ' ' + color]);
    return null;
  }
  var after = [['content', '""'], ['position', 'absolute'], ['pointer-events', 'none']];
  after.push(['inset', cssBox(sides.map(function (v) { return -v * off; }))]);
  after.push(['border', (uniform ? cssPx(sides[0]) : '0') + ' ' + style + ' ' + color]);
  if (!uniform) after.push(['border-width', cssBox(sides)]);
  if (node.type === 'ELLIPSE') after.push(['border-radius', '50%']);
  else if (radii) {
    var grow = Math.max(sides[0], sides[1], sides[2], sides[3]) * off;
    after.push(['border-radius', radiusCss(radii.map(function (r) { return r + grow; }))]);
  }
  return after;
}

function effectStyles(node, st, isText) {
  if (!('effects' in node) || !node.effects.length) return;
  var shadows = [], drops = [], filters = [], backdrop = [];
  var filled = isText || hasVisibleFill(node);
  node.effects.forEach(function (e) {
    if (e.visible === false) return;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      var c = cssColor(e.color, e.color.a);
      var xy = cssPx(e.offset.x) + ' ' + cssPx(e.offset.y) + ' ' + cssPx(e.radius);
      if (isText) { if (e.type === 'DROP_SHADOW') shadows.push(xy + ' ' + c); }
      else if (e.type === 'INNER_SHADOW') shadows.push('inset ' + xy + ' ' + cssPx(e.spread || 0) + ' ' + c);
      else if (filled) shadows.push(xy + ' ' + cssPx(e.spread || 0) + ' ' + c);
      else drops.push('drop-shadow(' + xy.replace(/ (\S+)$/, function (m, r) { return ' ' + cssPx(parseFloat(r) / 2); }) + ' ' + c + ')');
    } else if (e.type === 'LAYER_BLUR') filters.push('blur(' + cssPx(e.radius / 2) + ')');
    else if (e.type === 'BACKGROUND_BLUR') backdrop.push('blur(' + cssPx(e.radius / 2) + ')');
  });
  if (shadows.length) st.push([isText ? 'text-shadow' : 'box-shadow', shadows.join(', ')]);
  if (drops.length || filters.length) st.push(['filter', drops.concat(filters).join(' ')]);
  if (backdrop.length) st.push(['backdrop-filter', backdrop.join(' ')], ['-webkit-backdrop-filter', backdrop.join(' ')]);
}

// --- text ----------------------------------------------------------------------------

function fontStack(family) {
  var generic = /mono|code|courier|menlo|consol/i.test(family) ? 'monospace'
    : /serif/i.test(family) && !/sans/i.test(family) ? 'serif' : 'sans-serif';
  return '"' + family.replace(/"/g, '') + '", ' + generic;
}

function segmentCss(s, ctx) {
  var italic = /italic|oblique/i.test(s.fontName.style);
  var weight = s.fontWeight || 400;
  var fam = ctx.fonts[s.fontName.family] = ctx.fonts[s.fontName.family] || {};
  fam[(italic ? 1 : 0) + ',' + weight] = true;
  var css = {
    'font-family': fontStack(s.fontName.family),
    'font-size': cssPx(s.fontSize),
    'font-weight': String(weight),
  };
  if (italic) css['font-style'] = 'italic';
  var lh = s.lineHeight;
  if (lh && lh.unit === 'PIXELS') css['line-height'] = cssPx(lh.value);
  else if (lh && lh.unit === 'PERCENT') css['line-height'] = cssNum(lh.value / 100);
  var ls = s.letterSpacing;
  if (ls && ls.value) css['letter-spacing'] = ls.unit === 'PERCENT' ? cssNum(ls.value / 100) + 'em' : cssPx(ls.value);
  var fills = visiblePaints(s.fills);
  if (fills.length) {
    var f = fills[fills.length - 1];
    if (f.type === 'SOLID') css.color = cssColor(f.color, f.opacity);
    else if (f.gradientStops) css.color = cssColor(f.gradientStops[0].color, f.gradientStops[0].color.a);
  }
  if (s.textDecoration === 'UNDERLINE') css['text-decoration'] = 'underline';
  else if (s.textDecoration === 'STRIKETHROUGH') css['text-decoration'] = 'line-through';
  var tc = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }[s.textCase];
  if (tc) css['text-transform'] = tc;
  if (s.textCase === 'SMALL_CAPS' || s.textCase === 'SMALL_CAPS_FORCED') css['font-variant'] = 'small-caps';
  return css;
}

function textNodeHtml(node, cls, st, ind, ctx) {
  ctx.stats.texts++;
  var fields = ['fontName', 'fontSize', 'fontWeight', 'fills', 'textDecoration', 'textCase', 'letterSpacing', 'lineHeight', 'hyperlink'];
  var segs = node.getStyledTextSegments(fields);
  var styled = segs.map(function (s) { return { seg: s, css: segmentCss(s, ctx) }; });
  var base = styled.reduce(function (m, s) { return s.seg.characters.length > m.seg.characters.length ? s : m; }, styled[0]);
  var uniform = segs.every(function (sg) { return sg.fontSize === segs[0].fontSize && sg.lineHeight && sg.lineHeight.unit === 'AUTO'; });
  if (uniform && node.height > 0) {
    // Browsers' "normal" differs from Figma's auto line height; derive it from the laid-out box instead.
    var lines = Math.max(1, Math.round(node.height / (segs[0].fontSize * 1.21)));
    if (!/\n|\u2028/.test(node.characters) && node.textAutoResize === 'WIDTH_AND_HEIGHT') lines = 1;
    var lh = cssPx(node.height / lines);
    base.css['line-height'] = lh;
    styled.forEach(function (x) { x.css['line-height'] = lh; });
  }
  Object.keys(base.css).forEach(function (k) { st.push([k, base.css[k]]); });
  if (base.css.color == null) st.push(['color', 'transparent']);

  var align = { CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }[node.textAlignHorizontal];
  if (align) st.push(['text-align', align]);
  var auto = node.textAutoResize;
  var truncate = node.textTruncation === 'ENDING';
  if (truncate && (!node.maxLines || node.maxLines <= 1)) {
    st.push(['white-space', 'pre'], ['overflow', 'hidden'], ['text-overflow', 'ellipsis']);
  } else if (truncate) {
    st.push(['white-space', 'pre-wrap'], ['display', '-webkit-box'], ['-webkit-box-orient', 'vertical'], ['-webkit-line-clamp', String(node.maxLines)], ['overflow', 'hidden']);
  } else {
    st.push(['white-space', auto === 'WIDTH_AND_HEIGHT' ? 'pre' : 'pre-wrap']);
  }
  // Truncated text that hugs or fills: the width Figma laid it out at is the limit.
  if (truncate && !st.some(function (d) { return d[0] === 'width'; })) st.push(['max-width', cssPx(node.width)]);
  var valign = { CENTER: 'center', BOTTOM: 'flex-end' }[node.textAlignVertical];
  if (valign && !truncate) st.push(['display', 'flex'], ['flex-direction', 'column'], ['justify-content', valign]);
  effectStyles(node, st, true);
  commonStyles(node, st);
  pushRule(ctx, '.' + cls, st);

  var inner = styled.map(function (s) {
    var txt = escHtml(s.seg.characters.replace(/\u2028/g, '\n'));
    var diff = Object.keys(s.css).filter(function (k) { return s.css[k] !== base.css[k]; })
      .map(function (k) { return k + ': ' + s.css[k]; });
    Object.keys(base.css).forEach(function (k) { if (s.css[k] == null) diff.push(k + ': inherit'); });
    var link = s.seg.hyperlink && s.seg.hyperlink.type === 'URL' ? s.seg.hyperlink.value : null;
    var attr = diff.length ? ' style="' + escHtml(diff.join('; ')) + '"' : '';
    if (link) return '<a href="' + escHtml(link) + '"' + attr + '>' + txt + '</a>';
    return attr ? '<span' + attr + '>' + txt + '</span>' : txt;
  }).join('');
  if (valign && !truncate) inner = '<span>' + inner + '</span>';
  return ind + '<p class="' + cls + '">' + inner + '</p>';
}

function googleFontLinks(fonts) {
  return Object.keys(fonts).filter(function (f) { return !SYSTEM_FONTS.test(f); }).sort().map(function (family) {
    var tuples = Object.keys(fonts[family]).map(function (k) { return k.split(',').map(Number); })
      .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var hasItalic = tuples.some(function (t) { return t[0]; });
    var spec = hasItalic
      ? 'ital,wght@' + tuples.map(function (t) { return t[0] + ',' + t[1]; }).join(';')
      : 'wght@' + tuples.map(function (t) { return t[1]; }).join(';');
    return 'https://fonts.googleapis.com/css2?family=' + family.trim().replace(/ +/g, '+') + ':' + spec + '&display=swap';
  });
}

// --- vectors, icons and rasters -----------------------------------------------------

function scanGraphics(node, acc) {
  if (!('children' in node)) return acc;
  for (var i = 0; i < node.children.length; i++) {
    var c = node.children[i];
    if (c.visible === false) continue;
    if (c.type === 'TEXT') acc.text = true;
    else if (HTML_VECTOR[c.type] || c.type === 'ELLIPSE' || c.type === 'RECTANGLE') acc.vector = acc.vector || HTML_VECTOR[c.type] === 1 || c.type === 'ELLIPSE';
    else if (!HTML_CONTAINER[c.type]) acc.other = true;
    if (c.isMask) acc.mask = true;
    if ('effects' in c && c.effects.some(function (e) { return e.visible !== false; })) acc.effects = true;
    if ('fills' in c && visiblePaints(c.fills).some(function (pt) { return pt.type === 'IMAGE' || pt.type === 'VIDEO'; })) acc.image = true;
    scanGraphics(c, acc);
  }
  return acc;
}

// 'svg', 'png' or null (build it as HTML).
function graphicKind(node) {
  if (HTML_VECTOR[node.type]) return 'svg';
  if (node.type === 'ELLIPSE' && node.arcData) {
    var a = node.arcData;
    if (a.innerRadius > 0 || Math.abs(a.endingAngle - a.startingAngle) < Math.PI * 2 - 1e-3) return 'svg';
  }
  if (node.type === 'TEXT' || node.type === 'RECTANGLE' || node.type === 'ELLIPSE') return null;
  if (!HTML_CONTAINER[node.type]) return 'png'; // stickies, widgets, embeds…
  var acc = scanGraphics(node, {});
  if (acc.mask) return acc.text || acc.image ? 'png' : 'svg';
  // A frame with its own shadow/blur is built as HTML (CSS box-shadow) and only its vectors become SVG:
  // Figma's SVG export can drop shadows that sit on a transparent layer.
  if (acc.effects || ('effects' in node && node.effects.some(function (e) { return e.visible !== false; }))) return null;
  if (acc.text || acc.image || acc.other || !acc.vector) return null;
  return node.width <= HTML_ICON_MAX && node.height <= HTML_ICON_MAX ? 'svg' : null;
}

async function graphicHtml(node, kind, cls, ind, ctx, env) {
  var bb = node.absoluteBoundingBox;
  if (!bb) return null;
  var rb = node.absoluteRenderBounds || bb;
  var st = [];
  // In auto layout the node keeps its layout box; otherwise use its on-canvas bounds.
  var inFlow = env.flex && node.layoutPositioning !== 'ABSOLUTE';
  placeNode(node, st, env, inFlow ? { x: bb.x, y: bb.y, width: node.width, height: node.height } : bb);
  pushRule(ctx, '.' + cls, st);
  var inner;
  try {
    if (kind === 'svg') {
      var svg = utf8Decode(await node.exportAsync({ format: 'SVG', svgOutlineText: true, svgIdAttribute: false }));
      var pre = 's' + (++ctx.svgSeq) + '-';
      svg = svg.replace(/<\?xml[^>]*>\s*/, '')
        .replace(/\sid="([^"]+)"/g, ' id="' + pre + '$1"')
        .replace(/url\(#([^)]+)\)/g, 'url(#' + pre + '$1)')
        .replace(/href="#([^"]+)"/g, 'href="#' + pre + '$1"')
        .trim();
      inner = svg;
      ctx.stats.svgs++;
    } else {
      var png = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
      inner = '<img alt="" src="data:image/png;base64,' + figma.base64Encode(png) + '" width="' + Math.round(rb.width) + '" height="' + Math.round(rb.height) + '">';
      ctx.stats.rasters++;
    }
  } catch (e) {
    ctx.warnings.push('"' + node.name + '" could not be exported (' + (e && e.message ? e.message : e) + ').');
    return null;
  }
  // The export covers the render bounds (strokes, shadows), which can stick out of the layout box.
  var dx = rb.x - bb.x, dy = rb.y - bb.y;
  if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
    pushRule(ctx, '.' + cls + ' > :first-child', [['position', 'absolute'], ['left', cssPx(dx)], ['top', cssPx(dy)]]);
  }
  return ind + '<div class="' + cls + '">' + inner + '</div>';
}
