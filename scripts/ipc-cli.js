#!/usr/bin/env node
// Manual test of the IPC client, without the server.
//
//   node scripts/ipc-cli.js get_property media-title
//   node scripts/ipc-cli.js cycle pause
//   node scripts/ipc-cli.js seek 10 relative
//   node scripts/ipc-cli.js --watch          (watch state changes, Ctrl+C to quit)
//
// Use the SOCKET_PATH environment variable for a different socket.

import { MpvClient } from '../src/mpv-client.js';
import { PlayerState } from '../src/player-state.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const args = process.argv.slice(2);
const watch = args[0] === '--watch';

if (!watch && args.length === 0) {
  console.error('Usage: node scripts/ipc-cli.js <command> [args...] | --watch');
  process.exit(2);
}

const client = new MpvClient({
  socketPath: config.socketPath,
  requestTimeoutMs: config.requestTimeoutMs,
  log: (m) => console.error(`[ipc] ${m}`),
});

// Numeric arguments are sent as numbers (e.g. seek 10).
const command = args.map((a) => (a !== '' && !Number.isNaN(Number(a)) ? Number(a) : a));

if (watch) {
  const state = new PlayerState(client);
  state.on('change', (patch) => console.log(JSON.stringify(patch)));
  client.start();
} else {
  const giveUp = setTimeout(() => {
    console.error(`Could not connect: ${config.socketPath} (${client.lastError?.code ?? 'unknown error'})`);
    process.exit(1);
  }, 3000);
  client.once('connect', async () => {
    clearTimeout(giveUp);
    try {
      const data = await client.command(command);
      console.log(JSON.stringify(data ?? null, null, 2));
      process.exitCode = 0;
    } catch (err) {
      console.error(`${err.name}: ${err.message}`);
      process.exitCode = 1;
    } finally {
      client.stop();
    }
  });
  client.start();
}
