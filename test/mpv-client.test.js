import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MpvClient, NotConnectedError, TimeoutError, MpvCommandError } from '../src/mpv-client.js';
import { PlayerState } from '../src/player-state.js';
import { FakeMpv, tmpSocketPath, waitFor } from './fake-mpv.js';

describe('MpvClient', () => {
  let socketPath, mpv, client;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    mpv = await new FakeMpv(socketPath).start();
    client = new MpvClient({ socketPath, requestTimeoutMs: 300, minRetryMs: 20, maxRetryMs: 50 });
  });

  afterEach(async () => {
    client.stop();
    await mpv.stop();
  });

  test('connects, sends a command and returns the reply', async () => {
    client.start();
    await waitFor(() => client.connected);
    assert.equal(await client.getProperty('media-title'), 'Test video');
    const last = mpv.received.at(-1);
    assert.deepEqual(last.command, ['get_property', 'media-title']);
    assert.equal(typeof last.request_id, 'number');
  });

  test('matches out-of-order replies correctly', async () => {
    const held = [];
    mpv.handler = (msg, sock) => { held.push([msg, sock]); return true; };
    client.start();
    await waitFor(() => client.connected);
    const p1 = client.command(['get_property', 'a']);
    const p2 = client.command(['get_property', 'b']);
    await waitFor(() => held.length === 2);
    // Reply in reverse order.
    for (const [msg, sock] of held.reverse()) {
      sock.write(JSON.stringify({ request_id: msg.request_id, error: 'success', data: msg.command[1] }) + '\n');
    }
    assert.deepEqual(await Promise.all([p1, p2]), ['a', 'b']);
  });

  test('times out when no reply arrives', async () => {
    mpv.handler = () => true; // never replies
    client.start();
    await waitFor(() => client.connected);
    await assert.rejects(client.command(['get_property', 'pause']), TimeoutError);
    assert.equal(client._pending.size, 0);
  });

  test('mpv error reply → MpvCommandError', async () => {
    client.start();
    await waitFor(() => client.connected);
    await assert.rejects(client.command(['no-such-command']), (err) => {
      assert.ok(err instanceof MpvCommandError);
      assert.equal(err.mpvError, 'invalid parameter');
      return true;
    });
  });

  test('NotConnectedError immediately when not connected', async () => {
    await assert.rejects(client.command(['cycle', 'pause']), NotConnectedError);
  });

  test('handles split and concatenated lines, skips invalid JSON', async () => {
    const events = [];
    client.on('event', (e) => events.push(e.event));
    client.start();
    await waitFor(() => client.connected);
    mpv.sendRaw('{"event":"fi');
    mpv.sendRaw('le-loaded"}\n{"event":"seek"}\nnot json\n{"event":"pla');
    mpv.sendRaw('yback-restart"}\n');
    await waitFor(() => events.length === 3);
    assert.deepEqual(events, ['file-loaded', 'seek', 'playback-restart']);
  });

  test('rejects pending requests on disconnect, then reconnects', async () => {
    let disconnects = 0;
    client.on('disconnect', () => disconnects++);
    client.start();
    await waitFor(() => client.connected);
    mpv.handler = () => true;
    const pending = client.command(['get_property', 'pause']);
    await waitFor(() => mpv.received.length > 0);
    await mpv.stop();
    await assert.rejects(pending, NotConnectedError);
    assert.equal(client.connected, false);

    mpv = await new FakeMpv(socketPath).start();
    await waitFor(() => client.connected);
    assert.ok(disconnects >= 1);
    assert.equal(await client.getProperty('volume'), 50);
  });

  test('missing socket file: does not throw, waits and connects later', async () => {
    await mpv.stop();
    assert.equal(fs.existsSync(socketPath), false);
    client.start();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(client.connected, false);
    assert.equal(client.lastError?.code, 'ENOENT');
    mpv = await new FakeMpv(socketPath).start();
    await waitFor(() => client.connected);
  });

  test('stale socket file (ECONNREFUSED): keeps retrying', async () => {
    await mpv.stop({ keepFile: true });
    assert.equal(fs.existsSync(socketPath), true);
    client.start();
    await waitFor(() => client.lastError?.code === 'ECONNREFUSED');
    assert.equal(client.connected, false);
    mpv = await new FakeMpv(socketPath).start(); // FakeMpv removes the old file, like IINA does
    await waitFor(() => client.connected);
  });

  test('does not reconnect after stop()', async () => {
    client.start();
    await waitFor(() => client.connected);
    client.stop();
    await waitFor(() => !client.connected);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(client.connected, false);
    assert.equal(mpv.clients.size, 0);
  });
});

describe('PlayerState', () => {
  let socketPath, mpv, client, state;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    mpv = await new FakeMpv(socketPath).start();
    client = new MpvClient({ socketPath, requestTimeoutMs: 300, minRetryMs: 20, maxRetryMs: 50 });
    state = new PlayerState(client);
  });

  afterEach(async () => {
    client.stop();
    await mpv.stop();
  });

  test('observes the properties and tracks the state', async () => {
    client.start();
    await waitFor(() => state.state.title === 'Test video');
    const observed = mpv.received.filter((m) => m.command[0] === 'observe_property').map((m) => m.command[2]);
    for (const p of ['pause', 'time-pos', 'duration', 'volume', 'mute', 'media-title', 'fullscreen']) {
      assert.ok(observed.includes(p), `missing: ${p}`);
    }
    assert.equal(state.state.connected, true);
    assert.equal(state.state.volume, 50);

    const changes = [];
    state.on('change', (c) => changes.push(c));
    await client.command(['cycle', 'pause']);
    await waitFor(() => state.state.pause === true);
    assert.deepEqual(changes.at(-1), { pause: true });
  });

  test('resets on disconnect, re-observes on reconnect', async () => {
    client.start();
    await waitFor(() => state.state.title !== null);
    await mpv.stop();
    await waitFor(() => state.state.connected === false);
    assert.equal(state.state.title, null);

    mpv = await new FakeMpv(socketPath).start();
    mpv.properties['media-title'] = 'Second';
    await waitFor(() => state.state.title === 'Second');
    assert.ok(mpv.received.some((m) => m.command[0] === 'observe_property'));
  });
});
