// Persistent connection to the mpv (IINA) JSON IPC Unix socket.
//
// - One JSON message per line (terminated by \n), in both directions.
// - request_id based request/response matching, with timeouts.
// - Automatic reconnection with exponential backoff (ENOENT if the socket file
//   does not exist; ECONNREFUSED if the file is left over but nobody listens).
//
// Events:
//   'connect'                     – connected
//   'disconnect'                  – the connection was lost (or never established)
//   'event'    (msg)              – any mpv event (e.g. file-loaded)
//   'property' (name, data, id)   – property-change event
//   'error'    (err)              – only if there is a listener (never throws)

import net from 'node:net';
import { EventEmitter } from 'node:events';

export class NotConnectedError extends Error {
  constructor(message = 'IINA is not available (no IPC connection)') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

export class TimeoutError extends Error {
  constructor(command, ms) {
    super(`No response within ${ms} ms: ${JSON.stringify(command)}`);
    this.name = 'TimeoutError';
  }
}

export class MpvCommandError extends Error {
  constructor(command, mpvError) {
    super(`mpv returned an error (${mpvError}): ${JSON.stringify(command)}`);
    this.name = 'MpvCommandError';
    this.mpvError = mpvError;
  }
}

const MAX_LINE_BYTES = 1024 * 1024; // guard against an endless stream without \n

export class MpvClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.socketPath
   * @param {number} [opts.requestTimeoutMs=3000]
   * @param {number} [opts.minRetryMs=500]
   * @param {number} [opts.maxRetryMs=5000]
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ socketPath, requestTimeoutMs = 3000, minRetryMs = 500, maxRetryMs = 5000, log = () => {} }) {
    super();
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.minRetryMs = minRetryMs;
    this.maxRetryMs = maxRetryMs;
    this.log = log;

    this.socket = null;
    this.connected = false;
    this.lastError = null;
    this._buffer = '';
    this._nextId = 1;
    this._pending = new Map();
    this._retryMs = minRetryMs;
    this._retryTimer = null;
    this._stopped = true;
  }

  /** Starts connecting (and retrying in the background). */
  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._connect();
  }

  /** Closes the connection and stops retrying. */
  stop() {
    this._stopped = true;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    if (this.socket) this.socket.destroy();
  }

  _connect() {
    if (this._stopped) return;
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    socket.setEncoding('utf8');

    socket.on('connect', () => {
      this.connected = true;
      this.lastError = null;
      this._retryMs = this.minRetryMs;
      this._buffer = '';
      this.log(`IPC connected: ${this.socketPath}`);
      this.emit('connect');
    });

    socket.on('data', (chunk) => this._onData(chunk));

    socket.on('error', (err) => {
      // 'close' always follows; reconnection is handled there.
      if (this.lastError?.code !== err.code) {
        this.log(`IPC error: ${err.code || err.message}`);
      }
      this.lastError = err;
    });

    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      const wasConnected = this.connected;
      this.connected = false;
      this._buffer = '';
      this._rejectAllPending(new NotConnectedError('The IPC connection was lost'));
      if (wasConnected) this.log('IPC connection lost');
      this.emit('disconnect');
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    const delay = this._retryMs;
    this._retryMs = Math.min(this._retryMs * 2, this.maxRetryMs);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._connect();
    }, delay);
    this._retryTimer.unref?.();
  }

  _onData(chunk) {
    this._buffer += chunk;
    let idx;
    while ((idx = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (line) this._handleLine(line);
    }
    if (this._buffer.length > MAX_LINE_BYTES) {
      this.log('IPC: line too long, buffer discarded');
      this._buffer = '';
    }
  }

  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`IPC: invalid JSON line discarded: ${line.slice(0, 200)}`);
      return;
    }
    if (msg === null || typeof msg !== 'object') return;

    if (typeof msg.event === 'string') {
      if (msg.event === 'property-change') {
        this.emit('property', msg.name, msg.data, msg.id);
      }
      this.emit('event', msg);
      return;
    }

    if (msg.request_id !== undefined) {
      const pending = this._pending.get(msg.request_id);
      if (!pending) return; // e.g. a late reply to a request that already timed out
      this._pending.delete(msg.request_id);
      clearTimeout(pending.timer);
      if (msg.error === 'success') pending.resolve(msg.data);
      else pending.reject(new MpvCommandError(pending.command, msg.error));
    }
  }

  _rejectAllPending(err) {
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this._pending.clear();
  }

  /**
   * Sends an mpv command. The Promise resolves with the `data` field of mpv's reply.
   * @param {Array} command e.g. ['cycle', 'pause']
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   */
  command(command, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!Array.isArray(command) || command.length === 0) {
      return Promise.reject(new TypeError('The command must be a non-empty array'));
    }
    if (!this.connected || !this.socket) {
      return Promise.reject(new NotConnectedError());
    }
    const id = this._nextId++;
    if (this._nextId > Number.MAX_SAFE_INTEGER) this._nextId = 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new TimeoutError(command, timeoutMs));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, command });
      this.socket.write(JSON.stringify({ command, request_id: id }) + '\n');
    });
  }

  /** Requests property-change events for a property. */
  observeProperty(observeId, name) {
    return this.command(['observe_property', observeId, name]);
  }

  getProperty(name) {
    return this.command(['get_property', name]);
  }

  setProperty(name, value) {
    return this.command(['set_property', name, value]);
  }

  // EventEmitter: do not throw when there is no 'error' listener.
  emit(name, ...args) {
    if (name === 'error' && this.listenerCount('error') === 0) return false;
    return super.emit(name, ...args);
  }
}
