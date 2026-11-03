#!/usr/bin/env node
// IINA Remote server – entry point.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './src/config.js';
import { MpvClient } from './src/mpv-client.js';
import { PlayerState } from './src/player-state.js';
import { createServer } from './src/api.js';
import { SleepTimer, makeSleepCommand } from './src/sleep-timer.js';

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const client = new MpvClient({
  socketPath: config.socketPath,
  requestTimeoutMs: config.requestTimeoutMs,
  log,
});
const state = new PlayerState(client, { log });
const sleepTimer = new SleepTimer({
  client,
  state,
  sleepFn: makeSleepCommand(config.sleepCommand, log),
  log,
});
const server = createServer({
  client,
  state,
  sleepTimer,
  token: config.token,
  publicDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'),
  log,
});

server.on('error', (err) => {
  console.error(`The HTTP server failed to start: ${err.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  log(`IINA Remote running: http://${config.host}:${config.port}  (socket: ${config.socketPath})`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) log(`  open: http://${a.address}:${config.port}/`);
    }
  }
  log(config.token ? 'Token protection: ON' : 'Token protection: off (TOKEN not set)');
  client.start();
});

function shutdown(signal) {
  log(`${signal} – shutting down`);
  sleepTimer.stop();
  client.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
