# Development

## Building and testing

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
npm run release                            # build the release zips in dist/
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
