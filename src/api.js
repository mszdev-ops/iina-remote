// HTTP server: simple GET control endpoints, POST /api/command, SSE and static files.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NotConnectedError, TimeoutError, MpvCommandError } from './mpv-client.js';
import { isAuthorized } from './auth.js';
import { MAX_MINUTES } from './sleep-timer.js';

const MAX_BODY_BYTES = 16 * 1024;
const SSE_KEEPALIVE_MS = 15000;
const TIME_POS_THROTTLE_MS = 250;
const STATE_SETTLE_MS = 150;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

/** A required, finite number from the query string. */
function numberParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') throw new HttpError(400, `Missing parameter: ${name}`);
  const n = Number(raw.replace(',', '.')); // a decimal comma is accepted too
  if (!Number.isFinite(n)) throw new HttpError(400, `Parameter "${name}" is not a number: ${raw}`);
  return n;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCommandBody(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON');
  }
  const command = Array.isArray(body) ? body : body?.command;
  if (!Array.isArray(command) || command.length === 0) {
    throw new HttpError(400, 'Expected format: {"command": ["name", ...]} or ["name", ...]');
  }
  if (typeof command[0] !== 'string') throw new HttpError(400, 'The command name must be a string');
  return command;
}

/**
 * Manages SSE clients; throttles time-pos updates.
 */
class EventHub {
  constructor(state) {
    this.state = state;
    this.clients = new Set();
    this._pending = {};
    this._timer = null;
    this._lastFlush = 0;
    state.on('change', (patch) => this._onChange(patch));
  }

  add(res) {
    this.clients.add(res);
    this._write(res, 'state', this.state.snapshot());
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), SSE_KEEPALIVE_MS);
    res.on('close', () => {
      clearInterval(keepalive);
      this.clients.delete(res);
    });
  }

  _onChange(patch) {
    Object.assign(this._pending, patch);
    const onlyTime = Object.keys(this._pending).every((k) => k === 'timePos');
    const since = Date.now() - this._lastFlush;
    if (!onlyTime || since >= TIME_POS_THROTTLE_MS) {
      this._flush();
    } else if (!this._timer) {
      this._timer = setTimeout(() => this._flush(), TIME_POS_THROTTLE_MS - since);
    }
  }

  _flush() {
    clearTimeout(this._timer);
    this._timer = null;
    const patch = this._pending;
    this._pending = {};
    this._lastFlush = Date.now();
    if (Object.keys(patch).length === 0) return;
    for (const res of this.clients) this._write(res, 'change', patch);
  }

  _write(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  closeAll() {
    clearTimeout(this._timer);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

/**
 * @param {object} deps
 * @param {import('./mpv-client.js').MpvClient} deps.client
 * @param {import('./player-state.js').PlayerState} deps.state
 * @param {import('./sleep-timer.js').SleepTimer} [deps.sleepTimer]
 * @param {string|null} deps.token
 * @param {string} deps.publicDir
 * @param {(msg: string) => void} [deps.log]
 */
export function createServer({ client, state, sleepTimer, token, publicDir, log = () => {} }) {
  const hub = new EventHub(state);

  /** Runs a command, then waits briefly so the property-change events can arrive. */
  async function runAndReport(command) {
    const settled = new Promise((resolve) => {
      const t = setTimeout(done, STATE_SETTLE_MS);
      function done() {
        clearTimeout(t);
        state.off('change', onChange);
        resolve();
      }
      function onChange(patch) {
        // Plain time-pos ticks don't count as a response (except when seeking, where that is the point).
        if (command[0] === 'seek' || Object.keys(patch).some((k) => k !== 'timePos')) setTimeout(done, 20);
      }
      state.on('change', onChange);
    });
    await client.command(command);
    await settled;
    return { ok: true, state: state.snapshot() };
  }

  // GET endpoints → mpv commands
  const simpleRoutes = {
    '/api/pause': () => ['cycle', 'pause'],
    '/api/mute': () => ['cycle', 'mute'],
    '/api/fullscreen': () => ['cycle', 'fullscreen'],
    '/api/next': () => ['playlist-next'],
    '/api/prev': () => ['playlist-prev'],
    '/api/seek': (url) => {
      if (url.searchParams.has('to')) {
        const to = numberParam(url, 'to');
        if (to < 0) throw new HttpError(400, '"to" must not be negative');
        return ['seek', to, 'absolute'];
      }
      return ['seek', numberParam(url, 's'), 'relative'];
    },
    '/api/volume': (url) => {
      if (url.searchParams.has('set')) {
        const v = numberParam(url, 'set');
        const max = state.state.volumeMax ?? 100;
        if (v < 0 || v > max) throw new HttpError(400, `Volume must be between 0 and ${max}`);
        return ['set_property', 'volume', v];
      }
      return ['add', 'volume', numberParam(url, 'd')];
    },
  };

  async function handleApi(req, res, url) {
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (p === '/api/status') {
      if (req.method !== 'GET') throw new HttpError(405, 'GET only');
      return sendJson(res, 200, state.snapshot());
    }

    if (p === '/api/events') {
      if (req.method !== 'GET') throw new HttpError(405, 'GET only');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      hub.add(res);
      return;
    }

    if (p === '/api/sleep' || p === '/api/sleep/cancel') {
      if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'GET or POST only');
      if (!sleepTimer) throw new HttpError(404, 'The sleep timer is not enabled');
      if (p === '/api/sleep/cancel') {
        sleepTimer.cancel();
      } else if (url.searchParams.has('min')) {
        const min = numberParam(url, 'min');
        if (min <= 0 || min > MAX_MINUTES) throw new HttpError(400, `"min" must be a number between 0 and ${MAX_MINUTES}`);
        sleepTimer.setTimer(min);
      } else if (url.searchParams.has('end')) {
        sleepTimer.setEndOfMedia();
      } else if ([...url.searchParams.keys()].some((k) => k !== 'token')) {
        throw new HttpError(400, 'Usage: /api/sleep?min=30, /api/sleep?end, /api/sleep/cancel');
      }
      return sendJson(res, 200, { ok: true, sleep: sleepTimer.status() });
    }

    if (p === '/api/command') {
      if (req.method !== 'POST') throw new HttpError(405, 'POST only');
      const command = parseCommandBody(await readBody(req));
      const data = await client.command(command);
      return sendJson(res, 200, { ok: true, data: data ?? null });
    }

    const route = simpleRoutes[p];
    if (route) {
      if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'GET or POST only');
      return sendJson(res, 200, await runAndReport(route(url)));
    }

    throw new HttpError(404, `Unknown endpoint: ${p}`);
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'GET only');
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Invalid path');
    }
    if (rel === '/') rel = '/index.html';
    const file = path.resolve(publicDir, '.' + rel);
    if (!file.startsWith(path.resolve(publicDir) + path.sep)) throw new HttpError(404, 'Not found');
    let data;
    try {
      data = await fs.readFile(file);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    try {
      if (isApi) {
        if (!isAuthorized(req, url, token)) throw new HttpError(401, 'Missing or invalid token');
        await handleApi(req, res, url);
      } else {
        await serveStatic(req, res, url);
      }
    } catch (err) {
      let status = 500;
      if (err instanceof HttpError) status = err.status;
      else if (err instanceof NotConnectedError || err instanceof TimeoutError) status = 503;
      else if (err instanceof MpvCommandError) status = 502;
      else log(`Unexpected error (${req.method} ${url.pathname}): ${err.stack || err}`);
      if (res.headersSent) return res.end();
      sendJson(res, status, { ok: false, error: err.message, connected: state.state.connected });
    }
  });

  // Without this, open SSE connections would keep close() from finishing.
  const origClose = server.close.bind(server);
  server.close = (cb) => {
    hub.closeAll();
    origClose(cb);
    server.closeAllConnections?.();
    return server;
  };

  return server;
}
