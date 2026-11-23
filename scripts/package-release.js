#!/usr/bin/env node
// Build the release downloads in dist/:
//   figma-plugin.zip                         the Figma plugin only (manifest.json, code.js, ui.html)
//   figma-html-import-export-mcp-full.zip    plugin + MCP server with production dependencies
// Usage: npm run release   (needs the `zip` command, preinstalled on macOS and most Linux)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const stage = path.join(dist, 'stage');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

execFileSync(process.execPath, [path.join(root, 'scripts/build-plugin.js'), '--check'], { stdio: 'inherit' });

const copy = (from, to) => fs.cpSync(path.join(root, from), to, {
  recursive: true,
  filter: (src) => !/(^|[\\/])\.DS_Store$/.test(src),
});
const zip = (dir, name) => {
  const out = path.join(dist, name);
  execFileSync('zip', ['-qr', '-X', out, path.basename(dir)], { cwd: path.dirname(dir) });
  const kb = fs.statSync(out).size / 1024;
  console.log(`${name}  ${kb > 1024 ? (kb / 1024).toFixed(1) + " MB" : Math.round(kb) + " KB"}`);
};

// 1. Plugin only
const pluginDir = path.join(stage, 'figma-plugin');
for (const f of ['manifest.json', 'code.js', 'ui.html']) copy(`figma-plugin/${f}`, path.join(pluginDir, f));
fs.writeFileSync(path.join(pluginDir, 'INSTALL.txt'), `HTML Import, Export and MCP Service Plugin for Figma ${pkg.version}

1. Open Figma Desktop and any design file.
2. Plugins > Development > Import plugin from manifest...
3. Choose manifest.json in this folder.
4. Run it from Plugins > Development > HTML Import, Export and MCP Service Plugin.

Keep this folder where it is: Figma loads the plugin from it.
Import and Export work without anything else: no account, no AI, no limits.
Optional: to let an AI app (Claude, Cursor, VS Code...) work in Figma, turn on
Settings (gear icon) > "Connect to an AI assistant (MCP)" and set up the MCP
server (figma-html-import-export-mcp-full.zip). Guide:
https://github.com/jgptrd/figma-html-import-export-mcp/blob/main/docs/ai-mcp.md
`);
zip(pluginDir, 'figma-plugin.zip');

// 2. Full bundle with production dependencies
const fullDir = path.join(stage, 'figma-html-import-export-mcp');
for (const f of ['figma-plugin', 'server', 'scripts', 'README.md', 'LICENSE', 'docs', 'package.json', 'package-lock.json']) copy(f, path.join(fullDir, f));
fs.rmSync(path.join(fullDir, 'scripts/package-release.js'));
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--silent'], { cwd: fullDir, stdio: 'inherit' });
zip(fullDir, 'figma-html-import-export-mcp-full.zip');

fs.rmSync(stage, { recursive: true, force: true });
