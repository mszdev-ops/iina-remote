// Fake mpv JSON IPC server for tests (Unix socket in a temporary directory).

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpSocketPath() {
  // On macOS a Unix socket path is limited to ~104 bytes, hence the short name.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iina-'));
  return path.join(dir, 's');
}

export class FakeMpv {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.received = [];       // received messages (objects)
    this.clients = new Set();
    this.server = null;
    this.properties = {
      'pause': false, 'time-pos': 12.5, 'duration': 100, 'volume': 50, 'volume-max': 100,
      'mute': false, 'media-title': 'Test video', 'fullscreen': false,
      'playlist-pos': 0, 'playlist-count': 2, 'eof-reached': false,
    };
    this.observed = new Map(); // name → id
    /** If set and (msg, socket) => true, the server does not reply automatically. */
    this.handler = null;
  }

  async start() {
    try { fs.unlinkSync(this.socketPath); } catch {}
    this.server = net.createServer((sock) => this._onClient(sock));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, resolve);
    });
    return this;
  }

  /** Stops the server. keepFile=true leaves the socket file behind (simulates a stale socket). */
  async stop({ keepFile = false } = {}) {
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    if (keepFile) {
      // close() would delete the file; rename it away and move it back afterwards.
      const tmp = this.socketPath + '.keep';
      fs.renameSync(this.socketPath, tmp);
      await new Promise((r) => server.close(r));
      fs.renameSync(tmp, this.socketPath);
    } else {
      await new Promise((r) => server.close(r));
    }
  }

  _onClient(sock) {
    this.clients.add(sock);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this._onMessage(JSON.parse(line), sock);
      }
    });
    sock.on('close', () => this.clients.delete(sock));
    sock.on('error', () => {});
  }

  _reply(sock, request_id, error = 'success', data) {
    const msg = { request_id, error };
    if (data !== undefined) msg.data = data;
    sock.write(JSON.stringify(msg) + '\n');
  }

  _onMessage(msg, sock) {
    this.received.push(msg);
    if (this.handler && this.handler(msg, sock)) return;
    const [cmd, ...args] = msg.command;
    const id = msg.request_id;
    switch (cmd) {
      case 'observe_property': {
        const [obsId, name] = args;
        this.observed.set(name, obsId);
        this._reply(sock, id);
        this.sendEvent({ event: 'property-change', id: obsId, name, data: this.properties[name] });
        return;
      }
      case 'get_property':
        if (!(args[0] in this.properties)) return this._reply(sock, id, 'property unavailable');
        return this._reply(sock, id, 'success', this.properties[args[0]]);
      case 'set_property':
        this.setProp(args[0], args[1]);
        return this._reply(sock, id);
      case 'cycle':
        this.setProp(args[0], !this.properties[args[0]]);
        return this._reply(sock, id);
      case 'add':
        this.setProp(args[0], Math.min(Math.max(this.properties[args[0]] + Number(args[1]), 0), this.properties['volume-max']));
        return this._reply(sock, id);
      case 'seek': {
        const [amount, mode = 'relative'] = args;
        const base = mode.startsWith('absolute') ? 0 : this.properties['time-pos'];
        this.setProp('time-pos', base + Number(amount));
        return this._reply(sock, id);
      }
      case 'playlist-next':
      case 'playlist-prev': {
        const pos = this.properties['playlist-pos'] + (cmd === 'playlist-next' ? 1 : -1);
        if (pos < 0 || pos >= this.properties['playlist-count']) return this._reply(sock, id, 'error running command');
        this.setProp('playlist-pos', pos);
        return this._reply(sock, id);
      }
      default:
        return this._reply(sock, id, 'invalid parameter');
    }
  }

  setProp(name, value) {
    this.properties[name] = value;
    const obsId = this.observed.get(name);
    if (obsId !== undefined) this.sendEvent({ event: 'property-change', id: obsId, name, data: value });
  }

  sendEvent(ev) {
    const line = JSON.stringify(ev) + '\n';
    for (const c of this.clients) c.write(line);
  }

  /** Sends raw data (for testing message framing). */
  sendRaw(data) {
    for (const c of this.clients) c.write(data);
  }
}

/** Waits until the condition is true (or times out). */
export async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}
