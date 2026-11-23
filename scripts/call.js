#!/usr/bin/env node
// Call one of the MCP tools from a terminal (handy when the MCP tools aren't
// loaded in the current AI session).
//
// Usage: node scripts/call.js <tool> ['<json args>'] [--wait <sec>] [--file <name>] [--out <dir>]
//   --wait  first wait up to <sec> seconds for the Figma plugin to connect
//   --file  only proceed once the plugin runs in a file whose name contains <name>
//   --plugin-version  only proceed once the plugin reports this version (after a relaunch)
//   --out   save returned images into <dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
  else positional.push(argv[i]);
}
const [tool, rawArgs] = positional;
if (!tool) {
  console.error("usage: node scripts/call.js <tool> ['<json args>'] [--wait <sec>] [--file <name>] [--out <dir>]");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'server/index.js')],
  env: process.env,
  stderr: 'ignore',
});
const client = new Client({ name: 'figma-html-import-export-mcp-cli', version: '1.0.0' });
await client.connect(transport);
const textOf = (r) => (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

try {
  if (flags.wait) {
    const deadline = Date.now() + Number(flags.wait) * 1000;
    const want = flags.file ? flags.file.toLowerCase() : null;
    let last = '';
    for (;;) {
      const s = JSON.parse(textOf(await client.callTool({ name: 'figma_status', arguments: {} })));
      const versionOk = !flags['plugin-version'] || s.pluginVersion === flags['plugin-version'];
      const ok = s.connected && versionOk && (!want || String(s.file || '').toLowerCase().includes(want));
      const line = s.connected ? `plugin ${s.pluginVersion} connected in "${s.file}" / ${s.page}` : 'waiting for the Figma plugin…';
      if (line !== last) { console.log(line); last = line; }
      if (ok) break;
      if (Date.now() > deadline) {
        console.error(!s.connected ? 'Timed out waiting for the Figma plugin.' : !versionOk ? `Plugin ${s.pluginVersion} is running; relaunch it to load ${flags['plugin-version']}.` : `Plugin is open in "${s.file}", not "${flags.file}".`);
        process.exit(2);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // '@file.json' reads the arguments from a file (for large design specs).
  const argsText = rawArgs && rawArgs.startsWith('@') ? fs.readFileSync(rawArgs.slice(1), 'utf8') : rawArgs;
  const res = await client.callTool({ name: tool, arguments: argsText ? JSON.parse(argsText) : {} }, undefined, { timeout: 15 * 60 * 1000 });
  console.log(textOf(res));
  const images = (res.content || []).filter((c) => c.type === 'image');
  if (images.length && flags.out) {
    fs.mkdirSync(flags.out, { recursive: true });
    images.forEach((img, i) => {
      const file = path.join(flags.out, `${tool}-${Date.now()}-${i}.${img.mimeType.includes('jpeg') ? 'jpg' : 'png'}`);
      fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
      console.log(`image saved: ${file}`);
    });
  }
  process.exitCode = res.isError ? 1 : 0;
} finally {
  await client.close();
}
