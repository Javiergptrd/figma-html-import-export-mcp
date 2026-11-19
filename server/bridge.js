// WebSocket bridge between MCP server instances and the Figma plugin.
//
// The first MCP instance to start becomes the "host": it listens on
// 127.0.0.1:<port> and the Figma plugin connects to it. Any additional MCP
// instances (e.g. a second Claude session) connect to the host as "peers" and
// have their commands relayed to the plugin. If the host goes away, the next
// command from a peer promotes it to host.
import { WebSocketServer, WebSocket } from 'ws';

const log = (...a) => console.error('[html-mcp]', ...a);

// Browsers attach an Origin header; only allow the Figma plugin iframe
// (origin "null" / figma.com) and non-browser peers (no Origin).
function originAllowed(origin) {
  if (!origin || origin === 'null') return true;
  return /^https:\/\/([a-z0-9-]+\.)*figma\.com$/i.test(origin);
}

export class FigmaBridge {
  constructor(port = 3055) {
    this.port = port;
    this.mode = null; // 'host' | 'peer'
    this.wss = null;
    this.plugins = []; // [{ ws, info }] most recent last
    this.peerSocket = null;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.routed = new Map(); // hostId -> { ws, id }
    this.seq = 0;
  }

  async start() {
    try {
      await this.#listen();
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      log(`port ${this.port} in use; will relay through the existing host`);
      this.mode = 'peer';
    }
  }

  #listen() {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: this.port, maxPayload: 512 * 1024 * 1024 });
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.off('error', reject);
        wss.on('error', (err) => log('server error', err.message));
        this.wss = wss;
        this.mode = 'host';
        log(`listening on ws://127.0.0.1:${this.port}`);
        resolve();
      });
      wss.on('connection', (ws, req) => this.#onConnection(ws, req));
    });
  }

  #onConnection(ws, req) {
    if (!originAllowed(req.headers.origin)) {
      log('rejected connection from origin', req.headers.origin);
      ws.close(1008, 'origin not allowed');
      return;
    }
    let role = null;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'hello') {
        role = msg.role;
        if (role === 'plugin') {
          this.plugins = this.plugins.filter((p) => p.ws !== ws);
          this.plugins.push({ ws, info: { fileName: msg.fileName, page: msg.page, pluginVersion: msg.pluginVersion || '1.0.0' } });
          log(`plugin connected: ${msg.fileName} / ${msg.page?.name}`);
        }
        return;
      }
      if (msg.type === 'response') return this.#onResponse(msg);
      if (msg.type === 'command' && role === 'peer') return this.#relayFromPeer(ws, msg);
    });
    ws.on('close', () => {
      this.plugins = this.plugins.filter((p) => p.ws !== ws);
      if (role === 'plugin') log('plugin disconnected');
    });
  }

  #onResponse(msg) {
    const routed = this.routed.get(msg.id);
    if (routed) {
      this.routed.delete(msg.id);
      if (routed.ws.readyState === WebSocket.OPEN) {
        routed.ws.send(JSON.stringify({ ...msg, id: routed.id }));
      }
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }

  #relayFromPeer(peerWs, msg) {
    const reply = (payload) => peerWs.send(JSON.stringify({ type: 'response', id: msg.id, ...payload }));
    if (msg.command === '__status') return reply({ result: this.#hostStatus() });
    const plugin = this.#activePlugin();
    if (!plugin) return reply({ error: NOT_CONNECTED });
    const hostId = `peer-${++this.seq}`;
    this.routed.set(hostId, { ws: peerWs, id: msg.id });
    plugin.ws.send(JSON.stringify({ type: 'command', id: hostId, command: msg.command, params: msg.params }));
  }

  #activePlugin() {
    const open = this.plugins.filter((p) => p.ws.readyState === WebSocket.OPEN);
    return open[open.length - 1] || null;
  }

  #hostStatus() {
    const active = this.#activePlugin();
    return {
      connected: !!active,
      file: active?.info.fileName ?? null,
      page: active?.info.page?.name ?? null,
      pluginVersion: active?.info.pluginVersion ?? null,
      openFiles: this.plugins.map((p) => p.info.fileName),
    };
  }

  async #ensure() {
    if (this.mode === 'host') return;
    if (this.peerSocket && this.peerSocket.readyState === WebSocket.OPEN) return;
    // Host may have exited: try to take over the port first.
    try {
      await this.#listen();
      return;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`, { maxPayload: 512 * 1024 * 1024 });
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'hello', role: 'peer' }));
        this.peerSocket = ws;
        this.mode = 'peer';
        resolve();
      });
      ws.once('error', reject);
      ws.on('message', (raw) => {
        try { this.#onResponse(JSON.parse(raw.toString())); } catch { /* ignore */ }
      });
      ws.on('close', () => {
        if (this.peerSocket === ws) this.peerSocket = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Lost connection to the bridge host; retry the command.'));
          this.pending.delete(id);
        }
      });
    });
  }

  async status() {
    await this.#ensure();
    if (this.mode === 'host') return { mode: 'host', port: this.port, ...this.#hostStatus() };
    const s = await this.#request('__status', {}, 5000, this.peerSocket);
    return { mode: 'peer', port: this.port, ...s };
  }

  async send(command, params = {}, timeoutMs = 60000) {
    await this.#ensure();
    if (this.mode === 'host') {
      const plugin = this.#activePlugin();
      if (!plugin) throw new Error(NOT_CONNECTED);
      return this.#request(command, params, timeoutMs, plugin.ws);
    }
    return this.#request(command, params, timeoutMs, this.peerSocket);
  }

  #request(command, params, timeoutMs, ws) {
    const id = `c${process.pid}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Figma did not answer "${command}" within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: 'command', id, command, params }));
    });
  }

  close() {
    this.wss?.close();
    this.peerSocket?.close();
  }
}

export const NOT_CONNECTED =
  'Figma plugin is not connected. In Figma Desktop open a design file and run ' +
  'Plugins → Development → "HTML Import, Export and MCP Service Plugin" (keep its window open), then retry.';
