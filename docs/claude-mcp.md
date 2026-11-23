# Use the plugin with Claude (MCP)

This is optional. Import and Export in the plugin work without it. The MCP server lets Claude Code
import pages, build layouts and export frames in Figma for you.

```
Claude Code ──stdio──▶ MCP server (Node) ──WebSocket :3055──▶ Figma plugin ──▶ Figma canvas
                         │
                         └─ headless Chrome renders HTML → layer tree
```

Figma's REST API cannot create layers, so writing to a file has to go through a plugin running
inside Figma. The MCP server hosts a local WebSocket (127.0.0.1 only), and the plugin connects to it
and carries out the server's commands.

## Setup (one time)

1. **Get the server.** Needs Node 18+, Figma Desktop, and Google Chrome, Chromium, Edge or Brave.
   Either download **`figma-html-import-export-mcp-full.zip`** from the
   [latest release](https://github.com/jgptrd/figma-html-import-export-mcp/releases/latest)
   (dependencies included, nothing to install) and unzip it, or clone the repository and install:
   ```bash
   git clone https://github.com/jgptrd/figma-html-import-export-mcp.git
   ```
   ```bash
   cd figma-html-import-export-mcp && npm install
   ```
2. **Register the MCP server** with Claude Code:
   ```bash
   claude mcp add figma-html-import-export-mcp -- node "/absolute/path/to/figma-html-import-export-mcp/server/index.js"
   ```
   Restart Claude Code (or run `/mcp`) so it starts the server.
3. **Load the plugin in Figma Desktop.** Open any design file, then go to
   **Plugins → Development → Import plugin from manifest…** and choose
   `figma-html-import-export-mcp/figma-plugin/manifest.json`.

## Each session

In Figma Desktop, open the file you want to work in and run
**Plugins → Development → HTML Import, Export and MCP Service Plugin → Open plugin window**. Leave its small window open. The window has three tabs: **Import**
(HTML → Figma), **Export** (board → HTML) and **Claude** (connection status, port and the activity
log). The dot on the Claude tab turns green once Claude Code is running, and it reconnects
automatically.

Then ask Claude, for example:

- "Import `~/Desktop/landing-page.html` into Figma at 1440 and 390 widths."
- "Import only the `.modal` element from https://example.com"
- "Design a login screen in Figma: white card, indigo primary button, auto layout."
- "Take the selected frame and make a dark-mode version next to it."
- "Export the frame you just made so you can check it."

## Tools

| Tool | What it does |
| --- | --- |
| `figma_status` | Is the plugin connected? Which file and page? |
| `import_html` | Render an HTML file, URL or string and import it as layers. Options: `widths` (e.g. `[1440, 390]`), `height`, `fullPage`, `selector`, `colorScheme`, `javascript`, `dryRun` |
| `extract_fonts` | Save a page's `@font-face` fonts to a folder so you can install them (see [Fonts](#fonts)) |
| `create_design` | Create layer trees from a JSON spec: frames, auto layout, text, images, SVG, gradients, shadows, components, instances |
| `update_node` | Change properties of an existing layer (same keys as the spec), or move it to another parent |
| `get_document_info` / `get_selection` / `get_node` | Read pages, layers, selection and properties |
| `export_html` | Convert a frame into a self-contained HTML file (`layout`: `auto` flexbox or `absolute`; `savePath`) |
| `export_image` | Render a node to PNG/JPG (Claude sees the image) or SVG; optional `savePath` |
| `clone_node`, `delete_nodes`, `select_nodes` | Edit and organize layers |
| `create_page`, `switch_page` | Manage pages |
| `create_component` | Turn a frame into a component (reuse it with `INSTANCE` nodes) |

The full JSON node spec is in the `create_design` tool description. In short:

```json
{ "type": "FRAME", "name": "Card", "width": 360, "fills": ["#FFFFFF"], "cornerRadius": 16,
  "effects": [{ "type": "DROP_SHADOW", "color": "#00000014", "y": 8, "blur": 24 }],
  "layout": { "mode": "VERTICAL", "gap": 12, "padding": 24 },
  "children": [
    { "type": "TEXT", "text": "Hello, Alex", "fontFamily": "Inter", "fontWeight": 700, "fontSize": 20, "color": "#1A1A1A" },
    { "type": "FRAME", "name": "Button", "height": 44, "sizing": { "horizontal": "FILL" }, "fills": ["#6366F1"],
      "cornerRadius": 10, "layout": { "mode": "HORIZONTAL", "justify": "center", "align": "center" },
      "children": [{ "type": "TEXT", "text": "Continue", "fontWeight": 600, "color": "#FFFFFF" }] }
  ] }
```

## What the importer handles

- Layout: element boxes at their exact rendered positions, CSS paint order (z-index), overflow clipping, opacity
- Backgrounds: colors, linear, radial and conic gradients, `background-image` (cover/contain, positioned icons, tiling)
- Borders: per-side widths, mixed colors (extra sides become edge layers), dashed/dotted, per-corner radius
- Effects: box-shadow (multiple, inset, spread), text-shadow, `filter: blur`, `backdrop-filter: blur`
- Text: one Figma text layer per paragraph with styled ranges (bold, italic, links, colors, sizes),
  line height, letter spacing, text-transform, alignment, `text-overflow: ellipsis` (truncation), wrapping
- Inline `<svg>` as editable vectors (`currentColor` and CSS styles resolved), with a raster fallback
- `<img>`, `<picture>`, CSS images (PNG/JPEG/GIF/WebP/AVIF/SVG, converted when Figma needs it), `object-fit`
- Forms: input values and placeholders, select values with a dropdown arrow, textareas. Checkboxes,
  radios, `<canvas>`, `<video>` and `<iframe>` are rasterized
- Saved pages (e.g. SingleFile) with strict CSP, finished CSS animations, `prefers-color-scheme`

**Limitations:** imports use absolute positioning (flexbox isn't converted to auto layout), CSS
`::before`/`::after` decorations are skipped (icon fonts are rasterized), and CSS transforms are
flattened to their bounding boxes. A page captured at a mobile width looks the way the page itself
renders at that width.

## Fonts

Figma can only use fonts installed on your computer, plus its bundled fonts like Inter. Missing
fonts fall back to Inter, and `import_html` lists which fonts were substituted. If the page embeds
its fonts (for example custom web fonts loaded with `@font-face`), ask Claude to run `extract_fonts`,
install the saved `.otf`/`.ttf` files, restart Figma, and import again.

## Configuration

- `HTML_MCP_PORT`: WebSocket port (default `3055`). If you change it, also update
  `figma-plugin/manifest.json` (`devAllowedDomains`) and the port field in the plugin window.
- `CHROME_PATH`: browser executable, if it isn't found automatically.

Running several Claude sessions at once is supported. The first server owns the port and the others
relay their commands through it.

## Troubleshooting

- **"Figma plugin is not connected"**: run the plugin in Figma and keep its window open. Check that
  its port matches the server's.
- **Plugin says "Waiting for MCP server"**: Claude Code isn't running the server. Check `/mcp` in
  Claude Code.
- **Text looks different**: check the import summary for substituted fonts (see [Fonts](#fonts)).
- **Page renders wrong**: try `javascript: false` for saved static pages, raise `waitMs` for slow
  apps, or use `dryRun: true` to see Chrome's screenshot.

## Calling tools from a terminal

`scripts/call.js` runs any tool without an MCP client. This is useful in a Claude session that
started before the server was registered.

```bash
node scripts/call.js figma_status
node scripts/call.js import_html '{"source":"/abs/path/page.html"}' --wait 600 --file "My File"
node scripts/call.js export_image '{"id":"5:2"}' --out ./exports
```

`--wait` waits for the plugin to connect, `--file` only proceeds in a matching Figma file, and
`--plugin-version` waits for a specific plugin build. Figma Desktop hot-reloads development plugins
when `figma-plugin/code.js` changes.

