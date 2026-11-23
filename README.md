# HTML Import, Export and MCP Service Plugin for Figma

**A free, open-source Figma plugin for unlimited HTML → Figma imports and unlimited Figma → HTML
exports.** No account, no API key, no AI, no limits. Everything runs on your own computer, inside
your own Figma.

[![Download](https://img.shields.io/github/v/release/Javiergptrd/figma-html-import-export-mcp?label=download&color=6366f1)](https://github.com/Javiergptrd/figma-html-import-export-mcp/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)
![Free forever](https://img.shields.io/badge/price-free%20forever-22c55e)
![No account needed](https://img.shields.io/badge/account-not%20needed-0ea5e9)

![The plugin window: Import, Export and Claude tabs](docs/images/plugin-tabs.png)

## Why this plugin

| | |
| --- | --- |
| ✅ **Unlimited imports** | Turn as many HTML pages into Figma layers as you want. No monthly cap, no credits. |
| ✅ **Unlimited exports** | Export any board to a clean HTML file, as often as you want. |
| ✅ **100% free** | No trial, no paid plan, no "pro" features held back. MIT license, commercial use included. |
| ✅ **No account, no API key** | Install it and use it. Nothing to sign up for, nothing to paste in. |
| ✅ **No AI required** | Import and Export are plain, predictable converters. AI is an optional extra, not a requirement. |
| ✅ **Private by design** | Your designs and HTML files are processed locally in Figma and are never uploaded anywhere. |
| ✅ **Open source** | Read every line, change it, and build your own version. |

## Everything stays on your computer

- **Import** renders your HTML inside the plugin window in Figma on your machine and converts it to
  layers right there.
- **Export** builds the HTML file inside Figma and saves it straight to your computer.
- The plugin has **no server, no tracking and no analytics**. The only internet access is to load
  images and fonts that your own HTML page links to, exactly as a browser would.

## What it does

### Import HTML into Figma

![An HTML page imported into Figma as editable layers](docs/images/import-example.png)

- Real, **editable layers**: frames, text, vectors and images, not a flat screenshot
- Several **screen widths at once** (1920, 1440, 768, 390 or any custom width), each as its own frame
- Text keeps its styles: bold, italic, links, colors, sizes, line height, letter spacing, truncation
- Gradients, shadows, blurs, borders, rounded corners, opacity and clipping
- Inline SVG icons become **editable vectors**; images, `<picture>`, CSS backgrounds and `object-fit` work
- Form fields, canvas and video frames are included
- Options: light or dark appearance, import only one element (CSS selector), full page height, and
  whether to run the page's scripts

### Export boards as HTML

- **Export many boards at once**: select several frames and get one `.zip` with an `.html` file for each
- One **self-contained `.html` file** per board: images embedded, icons as inline SVG, nothing else to ship
- **Auto layout becomes flexbox**, or choose fixed positions for a pixel-exact copy
- **Readable CSS** with class names taken from your layer names
- Gradients, shadows, blurs, strokes, corner radius and text styles carried over
- Google Fonts linked automatically for the fonts you used
- **Download .html** or **Copy code**, with a keyboard shortcut you can change

## Install (no command line)

1. Download **`figma-plugin.zip`** from the
   [latest release](https://github.com/Javiergptrd/figma-html-import-export-mcp/releases/latest)
   and unzip it.
2. Open **Figma Desktop** and any design file. (The browser version of Figma can't load plugins from
   a file.)
3. Go to **Plugins → Development → Import plugin from manifest…** and choose `manifest.json` inside
   the unzipped `figma-plugin` folder.

That's it. Run it any time from **Plugins → Development → HTML Import, Export and MCP Service Plugin**.
Keep the unzipped folder where it is, because Figma loads the plugin from it.

## How to use it

**Import:** open the **Import** tab, drop an `.html` file on the window (or click **choose a file**),
pick one or more widths, and click **Import to Figma**. Each width becomes its own frame next to your
existing work.

> Tip: a single self-contained HTML file works best, for example a page saved with the free
> [SingleFile](https://github.com/gildas-lormeau/SingleFile) browser extension. Pages saved as
> "HTML + folder of files" lose their local images and styles.

**Export:** select one or more frames, open the **Export** tab, and click **Download .html** (or
**Copy code** for a single board). With several boards selected you get one `.zip` with an `.html`
file for each board.

- Shortcut: **⌃⇧E** on Mac, **Alt+Shift+E** on Windows, while the plugin window is focused. Click
  the **Shortcut** box to set your own keys; the plugin warns you if Figma already uses them.
- **Plugins → Development → HTML Import, Export and MCP Service Plugin → Export selection as HTML**
  downloads the selected board in one step. After that, Figma's **Run last plugin** (**⌥⌘P**,
  Ctrl+Alt+P on Windows) repeats it from anywhere.

## Bonus: design with Claude (optional)

The plugin's third tab, **Claude**, can connect to a small MCP server on your computer so
[Claude Code](https://claude.com/claude-code) can import pages, build layouts and export frames for
you. It is **an extra feature only**: you don't need it, an AI subscription or any account to use
Import and Export.

Setup and the list of Claude tools: **[docs/claude-mcp.md](docs/claude-mcp.md)**.

## Good to know

- Imports use fixed positions (flexbox in the HTML isn't turned into auto layout yet), CSS
  `::before`/`::after` decorations are skipped, and CSS transforms are flattened.
- Figma can only use fonts installed on your computer. Missing fonts fall back to Inter and the
  plugin tells you which ones were replaced.
- Importing straight from a website URL needs the optional Claude setup, because most sites don't
  allow other pages to download their HTML.

## Contributing

Ideas, bug reports and pull requests are welcome. See **[docs/development.md](docs/development.md)**
for how to build and test.

## License

[MIT](LICENSE): free to use, modify and share, including for commercial work.

This is an independent community project, not affiliated with or endorsed by Figma or Anthropic.
"Figma" and "Claude" are trademarks of their respective owners.
