# Work with any AI app (MCP)

This is **optional** and **off by default**. Import and Export in the plugin work without it: no
account, no AI, no limits.

Turn it on if you want an AI assistant to work inside Figma for you: import pages, build layouts
with auto layout, edit layers and export boards. It works with **any AI app that supports MCP**
(the Model Context Protocol), for example Claude Code, Claude Desktop, Cursor, VS Code (GitHub
Copilot), Windsurf, Gemini CLI, OpenAI Codex CLI, Cline, Zed or LM Studio.

```
Your AI app ──MCP (stdio)──▶ MCP server (Node, on your computer) ──WebSocket 127.0.0.1:3055──▶ Figma plugin ──▶ Figma canvas
                                │
                                └─ headless Chrome renders HTML → layer tree
```

Figma's REST API cannot create layers, so writing to a file has to go through a plugin running
inside Figma. The MCP server runs on your computer and only listens on 127.0.0.1; the plugin
connects to it and carries out the server's commands. Nothing goes through any outside server
(your AI app itself may of course use its own online service).

## Setup (one time)

### 1. Get the server

Needs Node 18+ and Google Chrome, Chromium, Edge or Brave. Either download
**`figma-html-import-export-mcp-full.zip`** from the
[latest release](https://github.com/jgptrd/figma-html-import-export-mcp/releases/latest)
(dependencies included) and unzip it, or clone the repository and install:

```bash
git clone https://github.com/jgptrd/figma-html-import-export-mcp.git
```
```bash
cd figma-html-import-export-mcp && npm install
```

Note the full path of `server/index.js` in that folder. Below it is written as
`/path/to/figma-html-import-export-mcp/server/index.js`.

### 2. Add the server to your AI app

The server is a standard **stdio** MCP server: the command is `node` and the argument is the path
to `server/index.js`. Pick your app:

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add figma-html -- node "/path/to/figma-html-import-export-mcp/server/index.js"
```
</details>

<details>
<summary><b>Claude Desktop, Cursor, Windsurf, Gemini CLI, Cline, LM Studio</b> (the <code>mcpServers</code> JSON format)</summary>

Add this to the app's MCP config file:

```json
{
  "mcpServers": {
    "figma-html": {
      "command": "node",
      "args": ["/path/to/figma-html-import-export-mcp/server/index.js"]
    }
  }
}
```

Where the file is:

- **Claude Desktop**: Settings → Developer → Edit Config (`claude_desktop_config.json`)
- **Cursor**: `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project)
- **Windsurf**: `~/.codeium/windsurf/mcp_config.json`
- **Gemini CLI**: `~/.gemini/settings.json`
- **Cline**: MCP Servers → Configure → `cline_mcp_settings.json`
- **LM Studio**: Program → Edit `mcp.json`
</details>

<details>
<summary><b>VS Code (GitHub Copilot agent mode)</b></summary>

Create `.vscode/mcp.json` in your project (or run **MCP: Add Server**):

```json
{
  "servers": {
    "figma-html": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/figma-html-import-export-mcp/server/index.js"]
    }
  }
}
```
</details>

<details>
<summary><b>OpenAI Codex CLI</b></summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.figma-html]
command = "node"
args = ["/path/to/figma-html-import-export-mcp/server/index.js"]
```
</details>

Any other app that supports stdio MCP servers works the same way. On Windows, write the path with
forward slashes or escaped backslashes (`C:\\Users\\you\\...`). Restart the app afterwards so it
starts the server.

### 3. Turn on the AI connection in the plugin

In Figma Desktop, open the plugin, click the **gear icon (Settings)** and turn on
**Connect to an AI assistant (MCP)**. An **AI** tab appears; its dot turns green when your AI app
has started the server. The setting is remembered, and you can turn it off again at any time. While
it is off, the plugin doesn't connect to any MCP server.

## Each session

Open the file you want to work in and run
**Plugins → Development → HTML Import, Export and MCP Service Plugin → Open plugin window**. Keep its
window open while the AI works. The connection reconnects by itself.

Then ask your AI, for example:

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
| `export_image` | Render a node to PNG/JPG (the AI sees the image) or SVG; optional `savePath` |
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
its fonts (for example custom web fonts loaded with `@font-face`), ask the AI to run `extract_fonts`,
install the saved `.otf`/`.ttf` files, restart Figma, and import again.

## Configuration

- `HTML_MCP_PORT`: WebSocket port (default `3055`). If you change it, also update
  `figma-plugin/manifest.json` (`devAllowedDomains`) and the port field in the plugin window.
- `CHROME_PATH`: browser executable, if it isn't found automatically.

Running several AI apps or chat sessions at once is supported. The first server owns the port and the others
relay their commands through it.

## Troubleshooting

- **"Figma plugin is not connected"**: run the plugin in Figma, keep its window open, and make sure
  the AI connection is turned on in its Settings. Check that
  its port matches the server's.
- **The plugin says "Waiting for the MCP server"**: your AI app isn't running the server. Check that it is
  registered (step 2 above) and restart the app. In Claude Code, `/mcp` lists the servers.
- **No AI tab in the plugin**: open Settings (gear icon) and turn on **Connect to an AI assistant (MCP)**.
- **Text looks different**: check the import summary for substituted fonts (see [Fonts](#fonts)).
- **Page renders wrong**: try `javascript: false` for saved static pages, raise `waitMs` for slow
  apps, or use `dryRun: true` to see Chrome's screenshot.

## Calling tools from a terminal

`scripts/call.js` runs any tool without an MCP client. This is useful in an AI session that
started before the server was registered.

```bash
node scripts/call.js figma_status
node scripts/call.js import_html '{"source":"/abs/path/page.html"}' --wait 600 --file "My File"
node scripts/call.js export_image '{"id":"5:2"}' --out ./exports
```

`--wait` waits for the plugin to connect, `--file` only proceeds in a matching Figma file, and
`--plugin-version` waits for a specific plugin build. Figma Desktop hot-reloads development plugins
when `figma-plugin/code.js` changes.

