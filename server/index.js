#!/usr/bin/env node
// {N} — MCP server: import HTML into Figma and design on the canvas.
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FigmaBridge } from './bridge.js';
import { captureHtml, closeBrowser, extractFonts } from './capture.js';
import { resolveAssets } from './assets.js';

const PORT = parseInt(process.env.HTML_MCP_PORT || '3055', 10);
const bridge = new FigmaBridge(PORT);

const server = new McpServer({ name: 'html-import-export-mcp', version: '1.0.0' });

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e?.message || e}` }], isError: true });

function tool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return await handler(args || {});
    } catch (e) {
      return fail(e);
    }
  });
}

// ---------------------------------------------------------------------------
// Node spec documentation (shared by create_design and update_node)
// ---------------------------------------------------------------------------

const SPEC_DOC = `
NODE SPEC (JSON). Every node: { type, name?, x?, y?, width?, height?, children? }
type: FRAME | TEXT | RECTANGLE | ELLIPSE | LINE | IMAGE | SVG | COMPONENT | INSTANCE
x/y are relative to the parent (ignored inside auto-layout parents unless "absolute": true).

Visual props (FRAME, RECTANGLE, ELLIPSE, IMAGE, COMPONENT):
  fills: ["#RRGGBB" | "#RRGGBBAA" | "rgba(…)" | {type:"SOLID",color,opacity?}
          | {type:"GRADIENT_LINEAR", angle: 135 /*CSS deg*/, stops:[{position:0,color:"#.."},{position:1,color:"#.."}]}
          | {type:"GRADIENT_RADIAL", stops:[…]} | {type:"IMAGE", image:"<path|url|dataURL>", scaleMode:"FILL"|"FIT"|"TILE"}]
  strokes: same as fills; strokeWeight: 1; strokeWeights: {top,right,bottom,left}; strokeAlign: INSIDE|CENTER|OUTSIDE; dashPattern: [4,4]
  cornerRadius: 8 | [tl,tr,br,bl]
  effects: [{type:"DROP_SHADOW"|"INNER_SHADOW", color:"#00000026", x:0, y:4, blur:12, spread:0} | {type:"LAYER_BLUR"|"BACKGROUND_BLUR", radius:8}]
  opacity, visible, rotation, clipsContent (top-level frames default true, nested false)
  Top-level FRAMEs default to a white fill; nested frames are transparent unless fills given.

Auto layout (FRAME/COMPONENT):
  layout: { mode:"HORIZONTAL"|"VERTICAL", gap:12, padding: 16 | [v,h] | [t,r,b,l],
            justify:"start"|"center"|"end"|"space-between", align:"start"|"center"|"end"|"baseline", wrap?:true, rowGap? }
  sizing: { horizontal:"FIXED"|"HUG"|"FILL", vertical:"FIXED"|"HUG"|"FILL" }  (FILL only inside an auto-layout parent)
  Auto-layout frames HUG on any axis without an explicit width/height. absolute: true pins a child with x/y.

TEXT: { type:"TEXT", text:"Hello", fontFamily:"Inter", fontWeight:400..900 | fontStyle:"Semi Bold", italic?,
        fontSize:16, lineHeight: 24 | "150%" | "auto", letterSpacing: 0 | "2%", color:"#111111",
        textAlign:"LEFT"|"CENTER"|"RIGHT"|"JUSTIFIED", verticalAlign:"TOP"|"CENTER"|"BOTTOM",
        textCase:"UPPER"|"LOWER"|"TITLE", textDecoration:"UNDERLINE"|"STRIKETHROUGH",
        width? (wraps when set), autoResize:"WIDTH_AND_HEIGHT"|"HEIGHT"|"NONE"|"TRUNCATE", sizing?,
        truncate?: true (ellipsis at the box edge; give width+height), maxLines? (auto-height text),
        segments?: [{start, end, fontWeight?, color?, fontSize?, italic?, textDecoration?}] (styled character ranges) }
  Fonts resolve against fonts available in Figma (falls back to Inter). Missing fonts are reported.
IMAGE: { type:"IMAGE", image:"/abs/path.png" | "https://…" | "data:image/png;base64,…", width, height, scaleMode?, cornerRadius? }
SVG:   { type:"SVG", svg:"<svg …>…</svg>" | "/abs/path/icon.svg", width?, height? }
LINE:  { type:"LINE", width:200, strokes:["#E5E7EB"], strokeWeight:1, rotation? }
INSTANCE: { type:"INSTANCE", componentId:"12:34" }
`.trim();

const nodeSpec = z.record(z.string(), z.any());

function summarizeCreate(res) {
  const lines = [];
  for (const c of res.created || []) {
    lines.push(`Created ${c.type} "${c.name}" id=${c.id} at (${c.x}, ${c.y}) size ${c.width}×${c.height}`);
  }
  lines.push(`Layers created: ${res.layerCount}`);
  const missing = Object.entries(res.missingFonts || {});
  if (missing.length) {
    lines.push(`Fonts not available in Figma (substituted): ${missing.map(([a, b]) => `${a} → ${b}`).join(', ')}`);
  }
  if (res.warnings?.length) lines.push(`Warnings:\n- ${res.warnings.slice(0, 15).join('\n- ')}`);
  if (res.errors?.length) lines.push(`Layer errors (${res.errors.length}):\n- ${res.errors.slice(0, 15).join('\n- ')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

tool(
  'figma_status',
  {
    title: 'Figma connection status',
    description: 'Check whether the Figma plugin is connected and which file/page it is on.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const status = await bridge.status();
    if (status.connected) {
      // Ask the plugin itself (works even when relayed through an older host).
      try {
        const hello = await bridge.send('ping', {}, 5000);
        status.pluginVersion = hello.pluginVersion || '1.0.0';
        status.file = hello.fileName;
        status.page = hello.page?.name ?? status.page;
      } catch { /* keep bridge-level status */ }
    }
    return text(status);
  }
);

tool(
  'import_html',
  {
    title: 'Import HTML into Figma',
    description:
      'Render an HTML page (local file path, URL, or raw HTML) in headless Chrome and import it into the open Figma file ' +
      'as editable layers (frames, text, vectors, images) — like the html.to.design plugin. Each width in `widths` ' +
      'produces its own frame (e.g. [1440, 390] for desktop + mobile). Use dryRun to preview the capture without Figma.',
    inputSchema: {
      source: z.string().optional().describe('Absolute path to an .html file, or an http(s)/file URL'),
      html: z.string().optional().describe('Raw HTML to import instead of `source`'),
      widths: z.array(z.number().int().min(200).max(4000)).optional().describe('Viewport widths to capture (default [1440])'),
      height: z.number().int().min(200).max(4000).optional().describe('Viewport height in px (default 900); affects 100vh layouts'),
      fullPage: z.boolean().optional().describe('Capture the full scroll height (default true) or just the viewport'),
      selector: z.string().optional().describe('CSS selector to import only one element (e.g. "#app", ".modal")'),
      javascript: z.boolean().optional().describe('Run page scripts (default true). Disable for static saved pages that break when scripts run'),
      waitMs: z.number().int().min(0).max(30000).optional().describe('Extra wait after load before capturing (default 600)'),
      colorScheme: z.enum(['light', 'dark']).optional().describe('Emulate prefers-color-scheme'),
      name: z.string().optional().describe('Name for the imported frame (default: file name + width)'),
      parentId: z.string().optional().describe('Put the frame inside this node instead of the page'),
      x: z.number().optional(),
      y: z.number().optional(),
      dryRun: z.boolean().optional().describe('Only render + analyze; return stats and a screenshot, do not touch Figma'),
    },
  },
  async (a) => {
    const widths = a.widths?.length ? a.widths : [1440];
    const baseName = a.name || (a.source ? path.basename(a.source).replace(/\.[^.]+$/, '') : 'HTML import');
    const out = [];
    const images = [];

    if (!a.dryRun) await bridge.send('ping', {}, 10000); // fail fast if the plugin is not open

    for (const width of widths) {
      const cap = await captureHtml({
        source: a.source,
        html: a.html,
        width,
        height: a.height || 900,
        fullPage: a.fullPage !== false,
        selector: a.selector,
        javascript: a.javascript !== false,
        waitMs: a.waitMs ?? 600,
        colorScheme: a.colorScheme,
        preview: !!a.dryRun,
      });
      cap.tree.name = widths.length > 1 || !a.name ? `${baseName} — ${width}px` : baseName;
      // Let the plugin auto-place the frame (right of existing content) unless x/y given.
      delete cap.tree.x;
      delete cap.tree.y;
      const s = cap.stats;
      const head = `[${width}px] ${s.elements} elements → ${s.texts} text, ${s.svgs} SVG, ${s.images} images, ${s.rasters} rasterized` +
        (s.truncated ? ' (TRUNCATED: page too large)' : '');

      if (a.dryRun) {
        out.push(`${head}\nFrame size: ${cap.tree.width}×${cap.tree.height}` +
          (cap.warnings.length ? `\nWarnings:\n- ${cap.warnings.join('\n- ')}` : ''));
        if (cap.preview) images.push({ type: 'image', data: cap.preview, mimeType: 'image/jpeg' });
        continue;
      }

      const res = await bridge.send(
        'create_nodes',
        { nodes: [cap.tree], assets: cap.assets, parentId: a.parentId, x: a.x, y: a.y, select: true, zoom: true },
        10 * 60 * 1000
      );
      out.push(`${head}\n${summarizeCreate(res)}` +
        (cap.warnings.length ? `\nCapture warnings:\n- ${cap.warnings.slice(0, 10).join('\n- ')}` : '') +
        (Object.keys(res.missingFonts || {}).length
          ? '\nTip: if the page embeds these fonts, run extract_fonts on the same source, install the files, restart Figma, and re-import for exact typography.'
          : ''));
    }
    return { content: [{ type: 'text', text: out.join('\n\n') }, ...images] };
  }
);

tool(
  'extract_fonts',
  {
    title: 'Extract web fonts from a page',
    description:
      'Save the @font-face web fonts an HTML page embeds or loads into a folder so they can be installed on this ' +
      'computer (double-click → Install in Font Book) and used by Figma. Does not need Figma. OTF/TTF install directly; ' +
      'WOFF/WOFF2 files need converting first.',
    inputSchema: {
      source: z.string().optional().describe('Absolute path to an .html file, or a URL'),
      html: z.string().optional(),
      outDir: z.string().describe('Folder to write the font files into'),
      families: z.array(z.string()).optional().describe('Only these font families (default: all)'),
    },
  },
  async (a) => {
    const res = await extractFonts({ source: a.source, html: a.html, outDir: path.resolve(a.outDir), families: a.families });
    if (!res.written.length) return text(`No downloadable @font-face fonts found.${res.skipped.length ? `\nSkipped:\n- ${res.skipped.join('\n- ')}` : ''}`);
    const lines = res.written.map((w) => `- ${w.family} ${w.weight}${w.style === 'italic' ? ' italic' : ''} → ${w.file}`);
    const needsConvert = res.written.some((w) => /woff/.test(w.format));
    return text(`Saved ${res.written.length} font files:\n${lines.join('\n')}` +
      (needsConvert ? '\nNote: WOFF/WOFF2 files must be converted to OTF/TTF before macOS can install them.' : '') +
      '\nInstall them (open each file → Install), then restart Figma so it picks them up.' +
      (res.skipped.length ? `\nSkipped:\n- ${res.skipped.join('\n- ')}` : ''));
  }
);

tool(
  'create_design',
  {
    title: 'Create design layers',
    description:
      'Create one or more layer trees in the open Figma file from a JSON node spec (supports auto layout, text, ' +
      'images, SVG icons, gradients, shadows, components). New top-level nodes are placed to the right of existing ' +
      'content unless x/y are given. Returns created node ids. Use export_image afterwards to check the result.\n\n' + SPEC_DOC,
    inputSchema: {
      nodes: z.array(nodeSpec).min(1).describe('Root node specs to create'),
      parentId: z.string().optional().describe('Create inside this existing node instead of the current page'),
      x: z.number().optional().describe('Origin x for top-level nodes'),
      y: z.number().optional().describe('Origin y for top-level nodes'),
      select: z.boolean().optional().describe('Select the new nodes (default true)'),
      zoom: z.boolean().optional().describe('Scroll/zoom the viewport to them (default true)'),
    },
  },
  async (a) => {
    const nodes = JSON.parse(JSON.stringify(a.nodes));
    const assets = await resolveAssets(nodes);
    const res = await bridge.send(
      'create_nodes',
      { nodes, assets, parentId: a.parentId, x: a.x, y: a.y, select: a.select, zoom: a.zoom },
      5 * 60 * 1000
    );
    return text(summarizeCreate(res));
  }
);

tool(
  'update_node',
  {
    title: 'Update a layer',
    description:
      'Change properties of an existing node using the same keys as the node spec (fills, text, fontSize, layout, ' +
      'sizing, x, y, width, height, cornerRadius, effects, name, visible…). Also accepts parentId/index to move it. ' +
      'Children are not replaced; use create_design with parentId to add children.',
    inputSchema: {
      id: z.string().describe('Node id, e.g. "12:34"'),
      props: nodeSpec.describe('Properties to set'),
    },
  },
  async (a) => {
    const props = JSON.parse(JSON.stringify(a.props));
    delete props.children;
    const assets = await resolveAssets([props]);
    return text(await bridge.send('update_node', { id: a.id, props, assets }, 60000));
  }
);

tool(
  'get_document_info',
  {
    title: 'Document overview',
    description: 'List pages, top-level layers on the current page, and the current selection.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => text(await bridge.send('get_document_info'))
);

tool(
  'get_selection',
  {
    title: 'Get selection',
    description: 'Describe the layers currently selected in Figma (ids, geometry, fills, text, auto layout…).',
    inputSchema: { depth: z.number().int().min(0).max(6).optional().describe('Child depth to include (default 1)') },
    annotations: { readOnlyHint: true },
  },
  async (a) => text(await bridge.send('get_selection', { depth: a.depth }))
);

tool(
  'get_node',
  {
    title: 'Get node',
    description: 'Describe a node and its children (ids, geometry, fills, strokes, text, auto layout).',
    inputSchema: {
      id: z.string(),
      depth: z.number().int().min(0).max(50).optional().describe('Child depth to include (default 2; imported pages can be 20+ deep)'),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) => text(await bridge.send('get_node', { id: a.id, depth: a.depth }))
);

tool(
  'export_image',
  {
    title: 'Export node as image',
    description:
      'Render a node to PNG/JPG (returned as an image so you can see it) or SVG markup. Use it to review designs ' +
      'and imports. Without `scale`, large frames are downscaled to fit `maxSize` px.',
    inputSchema: {
      id: z.string(),
      format: z.enum(['PNG', 'JPG', 'SVG']).optional(),
      scale: z.number().min(0.05).max(4).optional(),
      maxSize: z.number().int().min(100).max(4096).optional().describe('Longest side in px when scale is omitted (default 1600)'),
      savePath: z.string().optional().describe('Also write the export to this file path'),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) => {
    const res = await bridge.send('export_node', { id: a.id, format: a.format, scale: a.scale, maxSize: a.maxSize }, 120000);
    if (res.svg != null) {
      if (a.savePath) fs.writeFileSync(a.savePath, res.svg);
      return text(res.svg.length > 60000 ? res.svg.slice(0, 60000) + '\n…(truncated)' : res.svg);
    }
    if (a.savePath) fs.writeFileSync(a.savePath, Buffer.from(res.base64, 'base64'));
    return {
      content: [
        { type: 'image', data: res.base64, mimeType: res.format === 'JPG' ? 'image/jpeg' : 'image/png' },
        { type: 'text', text: `Node ${a.id} (${Math.round(res.width)}×${Math.round(res.height)})${a.savePath ? ` saved to ${a.savePath}` : ''}` },
      ],
    };
  }
);

tool(
  'export_html',
  {
    title: 'Export board as HTML',
    description:
      'Convert a frame (board) into one self-contained HTML file: CSS classes named after the layers, auto layout as ' +
      'flexbox (or layout "absolute" for exact fixed positions), icons/vectors as inline SVG, image fills embedded, ' +
      'Google Fonts linked. Without `id` it exports the current selection. Pass `savePath` to write the file.',
    inputSchema: {
      id: z.string().optional().describe('Node id; defaults to the first selected node'),
      layout: z.enum(['auto', 'absolute']).optional().describe('"auto" (default): auto layout → flexbox. "absolute": every layer at its exact position'),
      googleFonts: z.boolean().optional().describe('Add Google Fonts <link>s for the fonts used (default true)'),
      savePath: z.string().optional().describe('Write the .html here (a folder uses the board name as file name)'),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) => {
    const res = await bridge.send('export_html', { id: a.id, layout: a.layout, googleFonts: a.googleFonts }, 300000);
    const st = res.stats;
    const summary =
      `"${res.name}" (${res.id}): ${st.layers} layers, ${st.texts} text, ${st.svgs} SVG, ${st.images} images` +
      `${st.rasters ? `, ${st.rasters} PNG` : ''}, ${Math.round(res.bytes / 1024)} KB` +
      (res.warnings.length ? `\nWarnings:\n- ${res.warnings.slice(0, 20).join('\n- ')}` : '');
    if (a.savePath) {
      let file = path.resolve(a.savePath);
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, res.fileName);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, res.html);
      return text(`Saved ${file}\n${summary}`);
    }
    const html = res.html.length > 80000 ? res.html.slice(0, 80000) + '\n…(truncated: pass savePath for the full file)' : res.html;
    return text(`${summary}\n\n${html}`);
  }
);

tool(
  'delete_nodes',
  {
    title: 'Delete layers',
    description: 'Delete nodes by id.',
    inputSchema: { ids: z.array(z.string()).min(1) },
    annotations: { destructiveHint: true },
  },
  async (a) => text(await bridge.send('delete_nodes', { ids: a.ids }))
);

tool(
  'clone_node',
  {
    title: 'Duplicate a layer',
    description: 'Duplicate a node, optionally into another parent and/or at a new position.',
    inputSchema: {
      id: z.string(),
      parentId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      name: z.string().optional(),
    },
  },
  async (a) => text(await bridge.send('clone_node', a))
);

tool(
  'select_nodes',
  {
    title: 'Select layers',
    description: 'Select nodes in Figma and (by default) zoom the viewport to them.',
    inputSchema: { ids: z.array(z.string()).min(1), zoom: z.boolean().optional() },
  },
  async (a) => text(await bridge.send('select_nodes', a))
);

tool(
  'create_page',
  {
    title: 'Create page',
    description: 'Add a new page to the file and switch to it (unless switch=false).',
    inputSchema: { name: z.string(), switch: z.boolean().optional() },
  },
  async (a) => text(await bridge.send('create_page', a))
);

tool(
  'switch_page',
  {
    title: 'Switch page',
    description: 'Make another page current, by id or name.',
    inputSchema: { id: z.string().optional(), name: z.string().optional() },
  },
  async (a) => text(await bridge.send('switch_page', a))
);

tool(
  'create_component',
  {
    title: 'Convert to component',
    description: 'Convert an existing frame/group into a reusable component. Use INSTANCE nodes with its id to reuse it.',
    inputSchema: { id: z.string(), name: z.string().optional() },
  },
  async (a) => text(await bridge.send('create_component', a))
);

// ---------------------------------------------------------------------------

async function main() {
  await bridge.start();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[html-mcp] MCP server ready (bridge ${bridge.mode} on port ${PORT})`);
}

const shutdown = async () => {
  bridge.close();
  await closeBrowser();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

main().catch((e) => {
  console.error('[html-mcp] fatal', e);
  process.exit(1);
});
