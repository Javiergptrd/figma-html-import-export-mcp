# HTML Import, Export and MCP Service Plugin

A Figma plugin plus an MCP server that **imports HTML pages into Figma as editable layers**,
**exports Figma frames as HTML**, and lets Claude **create or edit designs directly on the Figma canvas**.

```
Claude Code ──stdio──▶ MCP server (Node) ──WebSocket :3055──▶ Figma plugin ──▶ Figma canvas
                         │
                         └─ headless Chrome renders HTML → layer tree
```

Figma's REST API cannot create layers, so writing to a file has to go through a plugin running
inside Figma. The MCP server hosts a local WebSocket (127.0.0.1 only), and the plugin connects to it
and carries out the server's commands.

The plugin can also **import HTML on its own**, with no Claude and no server running: see
[Import from the plugin window](#import-from-the-plugin-window).

## Setup (one time)

1. **Get the code and install dependencies.** Needs Node 18+, Figma Desktop, and Google Chrome,
   Chromium, Edge or Brave installed. Clone or download this repository, then:
   ```bash
   cd html-import-export-mcp && npm install
   ```
2. **Register the MCP server** with Claude Code:
   ```bash
   claude mcp add html-import-export-mcp -- node "/absolute/path/to/html-import-export-mcp/server/index.js"
   ```
   Restart Claude Code (or run `/mcp`) so it starts the server.
3. **Load the plugin in Figma Desktop.** Open any design file, then go to
   **Plugins → Development → Import plugin from manifest…** and choose
   `html-import-export-mcp/figma-plugin/manifest.json`.

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

## Import from the plugin window

You don't need Claude Code for plain HTML imports. In Figma, run
**Plugins → Development → HTML Import, Export and MCP Service Plugin**, open the **Import** tab, then:

1. Drop an `.html` file on the window, or click **choose a file**.
2. Pick one or more widths (1920, 1440, 768, 390, or type others like `1280, 375`).
3. Optionally open **Options**: viewport height, light/dark appearance, import only one element
   (CSS selector), full page height, and whether to run the page's scripts.
4. Click **Import to Figma**. Each width becomes its own frame, placed to the right of your
   existing content. The log lists fonts that were replaced and anything that couldn't be imported.

Your width and option choices, and the last tab you used, are remembered. Warnings (replaced
fonts, images that failed) are listed in the Claude tab's activity log. The page renders in a hidden, sandboxed frame inside
the plugin window and goes through the same converter the MCP server uses, so the layers match a
Claude import.

What works best is a **single self-contained HTML file**, such as one saved with the
[SingleFile](https://github.com/gildas-lormeau/SingleFile) browser extension. Differences from a
Claude import:

- Only one file is read, so pages saved as "HTML + folder of assets" lose their local images and CSS.
  Use SingleFile, or import through Claude.
- No URL imports, because most websites don't let other pages download their HTML.
- Images hosted on other websites are imported only if those servers allow cross-site downloads.
- `<iframe>`/`<object>`/`<embed>` contents are skipped. Checkboxes, radios, range and color inputs
  are redrawn instead of screenshotted. Canvas, video frames, icon fonts and SVG fallbacks work as usual.

## Export a board as HTML

Select a frame and, in the plugin window's **Export** tab, click **Download .html** (or
**Copy code**). You get one self-contained file: CSS classes named after the layers, auto layout as
flexbox (or **Fixed positions** for an exact copy), icons and vectors as inline SVG, image fills
embedded, and Google Fonts links for the fonts used.

Shortcuts:

- **⌃⇧E** on a Mac (Alt+Shift+E on Windows) while the plugin window is focused = Download .html.
  Change it in the Export tab: click the **Shortcut** box and press the new keys (it needs ⌃, ⌥ or ⌘;
  Esc cancels), **Reset** restores the default and **None** turns it off. The plugin warns you when a
  combination is one Figma already uses (for example ⇧⌘E is Figma's own Export), and remembers your
  choice.
- **Plugins → Development → HTML Import, Export and MCP Service Plugin → Export selection as HTML** opens the plugin and
  downloads the selected board right away. After that, Figma's **Run last plugin** shortcut
  (**⌥⌘P**, Ctrl+Alt+P on Windows) repeats it from anywhere in Figma.
- To give it its own key on a Mac: **System Settings → Keyboard → Keyboard Shortcuts → App
  Shortcuts → +**, application **Figma**, menu title `Export selection as HTML` (exactly), and pick a
  key combination that Figma doesn't already use.

Running a menu command restarts the plugin, so the Claude connection drops for a second and
reconnects by itself.

## Tools

| Tool | What it does |
| --- | --- |
| `figma_status` | Is the plugin connected? Which file and page? |
| `import_html` | Render an HTML file, URL or string and import it as layers. Options: `widths` (e.g. `[1440, 390]`), `height`, `fullPage`, `selector`, `colorScheme`, `javascript`, `dryRun` |
| `extract_fonts` | Save a page's `@font-face` fonts to a folder so you can install them (see Fonts) |
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

## What the HTML importer handles

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
- **Text looks different**: check the import summary for substituted fonts (see Fonts).
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

## Development and tests

`figma-plugin/ui.html` contains a copy of `server/walker.js` and `server/inpage.js` (Figma loads the
plugin window as one file). After editing either of them, run `npm run build`. `npm test` fails if
the copy is out of date.

No Figma is needed for tests. They run the real plugin code against a strict mock of the Figma
Plugin API that rejects invalid paints/effects, unloaded fonts, bad auto-layout sizing, and more.

```bash
npm test                                   # build check + both end-to-end tests below
node test/e2e-mcp.js                       # full chain: MCP client → server → WebSocket → plugin (mock)
node test/e2e-plugin.js [page.html]        # plugin window imports a file by itself, compared with the server
node test/run-import.js page.html out/     # import + render the Figma result back to a PNG for comparison
node test/screenshot.js page.html out.png  # browser screenshot of the original
npm run test:design                        # create_design sample (auto layout)
```

Files: `server/index.js` (MCP tools), `server/walker.js` (DOM → layer tree, runs in Chrome),
`server/inpage.js` (image fetching, settling and canvas rasters, run in the page),
`server/capture.js` (browser, images, fonts), `server/bridge.js` (WebSocket host/peer),
`figma-plugin/code.js` (builds layers in Figma), `figma-plugin/ui.html` (plugin window: imports and
the Claude connection), `scripts/build-plugin.js` (copies the in-page code into `ui.html`).

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm test` (and
`npm run build` if you changed `server/walker.js` or `server/inpage.js`). Please keep test pages and
samples free of real personal data or third-party branding.

## License

[MIT](LICENSE). Free to use, modify and redistribute, including commercially.

This is an independent community project. It is not affiliated with or endorsed by Figma or
Anthropic. "Figma" and "Claude" are trademarks of their respective owners.
