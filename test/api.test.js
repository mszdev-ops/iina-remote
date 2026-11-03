import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MpvClient } from '../src/mpv-client.js';
import { PlayerState } from '../src/player-state.js';
import { createServer } from '../src/api.js';
import { SleepTimer } from '../src/sleep-timer.js';
import { FakeMpv, tmpSocketPath, waitFor } from './fake-mpv.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

async function startStack({ token = null, withMpv = true } = {}) {
  const socketPath = tmpSocketPath();
  const mpv = withMpv ? await new FakeMpv(socketPath).start() : null;
  const client = new MpvClient({ socketPath, requestTimeoutMs: 300, minRetryMs: 20, maxRetryMs: 50 });
  const state = new PlayerState(client);
  const sleeps = [];
  const sleepTimer = new SleepTimer({ client, state, sleepFn: async () => { sleeps.push(Date.now()); } });
  const server = createServer({ client, state, sleepTimer, token, publicDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  client.start();
  if (mpv) await waitFor(() => state.state.title !== null);
  return {
    socketPath, mpv, client, state, server, base, sleepTimer, sleeps,
    async stop() {
      sleepTimer.stop();
      client.stop();
      await new Promise((r) => server.close(r));
      if (this.mpv) await this.mpv.stop();
    },
  };
}

/** SSE reader: collects events until closed. */
async function openSse(url) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  const events = [];
  const decoder = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
        }
      }
    } catch {}
  })();
  return { res, events, close: () => ac.abort() };
}

describe('API (IINA running)', () => {
  let s;
  before(async () => { s = await startStack(); });
  after(async () => { await s.stop(); });
  beforeEach(() => { s.mpv.received.length = 0; });

  const lastCommand = () => s.mpv.received.at(-1).command;

  test('GET /api/status', async () => {
    const res = await fetch(`${s.base}/api/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.connected, true);
    assert.equal(body.title, 'Test video');
    assert.equal(body.duration, 100);
    for (const k of ['pause', 'timePos', 'volume', 'mute', 'fullscreen']) assert.ok(k in body);
  });

  test('GET /api/pause toggles pause and returns the fresh state', async () => {
    const before = s.state.state.pause;
    const res = await fetch(`${s.base}/api/pause`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(lastCommand(), ['cycle', 'pause']);
    assert.equal(body.ok, true);
    assert.equal(body.state.pause, !before);
  });

  test('simple toggles: mute, fullscreen, next, prev', async () => {
    for (const [p, cmd] of [
      ['mute', ['cycle', 'mute']],
      ['fullscreen', ['cycle', 'fullscreen']],
      ['next', ['playlist-next']],
      ['prev', ['playlist-prev']],
    ]) {
      const res = await fetch(`${s.base}/api/${p}`);
      assert.equal(res.status, 200, p);
      assert.deepEqual(lastCommand(), cmd);
    }
  });

  test('seek: relative (also negative) and absolute', async () => {
    await fetch(`${s.base}/api/seek?s=-10`);
    assert.deepEqual(lastCommand(), ['seek', -10, 'relative']);
    const res = await fetch(`${s.base}/api/seek?to=42.5`);
    assert.deepEqual(lastCommand(), ['seek', 42.5, 'absolute']);
    assert.equal((await res.json()).state.timePos, 42.5);
  });

  test('volume: relative, fractional step, decimal comma, absolute', async () => {
    await fetch(`${s.base}/api/volume?d=5`);
    assert.deepEqual(lastCommand(), ['add', 'volume', 5]);
    await fetch(`${s.base}/api/volume?d=-0.5`);
    assert.deepEqual(lastCommand(), ['add', 'volume', -0.5]);
    await fetch(`${s.base}/api/volume?d=1,5`);
    assert.deepEqual(lastCommand(), ['add', 'volume', 1.5]);
    const res = await fetch(`${s.base}/api/volume?set=33`);
    assert.deepEqual(lastCommand(), ['set_property', 'volume', 33]);
    assert.equal((await res.json()).state.volume, 33);
  });

  test('400 on invalid or missing parameters', async () => {
    for (const q of ['/api/seek', '/api/seek?s=abc', '/api/seek?to=-1', '/api/volume', '/api/volume?d=', '/api/volume?set=500']) {
      const res = await fetch(s.base + q);
      assert.equal(res.status, 400, q);
      assert.equal((await res.json()).ok, false);
    }
    assert.equal(s.mpv.received.length, 0);
  });

  test('502 when mpv returns an error (e.g. no next item)', async () => {
    s.mpv.properties['playlist-pos'] = 1;
    const res = await fetch(`${s.base}/api/next`);
    assert.equal(res.status, 502);
  });

  test('POST /api/command as object and as array', async () => {
    let res = await fetch(`${s.base}/api/command`, {
      method: 'POST', body: JSON.stringify({ command: ['get_property', 'volume-max'] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, data: 100 });

    res = await fetch(`${s.base}/api/command`, { method: 'POST', body: '["get_property","media-title"]' });
    assert.deepEqual(await res.json(), { ok: true, data: 'Test video' });
  });

  test('POST /api/command: 400 on bad JSON/format, 405 on GET, 413 on oversized body', async () => {
    for (const body of ['not json', '{}', '[]', '[1,2]', '{"command":"pause"}']) {
      const res = await fetch(`${s.base}/api/command`, { method: 'POST', body });
      assert.equal(res.status, 400, body);
    }
    assert.equal((await fetch(`${s.base}/api/command`)).status, 405);
    const big = JSON.stringify({ command: ['x', 'a'.repeat(20000)] });
    const res = await fetch(`${s.base}/api/command`, { method: 'POST', body: big }).catch(() => null);
    if (res) assert.equal(res.status, 413);
  });

  test('sleep: timer, end of media, cancel, status', async () => {
    let res = await fetch(`${s.base}/api/sleep?min=30`);
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.sleep.mode, 'timer');
    assert.ok(Math.abs(body.sleep.endsAt - (Date.now() + 30 * 60000)) < 2000);
    assert.equal((await (await fetch(`${s.base}/api/status`)).json()).sleep.mode, 'timer');

    body = await (await fetch(`${s.base}/api/sleep?end`)).json();
    assert.deepEqual(body.sleep, { mode: 'end', endsAt: null });

    body = await (await fetch(`${s.base}/api/sleep`)).json();
    assert.equal(body.sleep.mode, 'end');

    body = await (await fetch(`${s.base}/api/sleep/cancel`)).json();
    assert.equal(body.sleep, null);
    assert.equal(s.sleeps.length, 0);
  });

  test('sleep: 400 on invalid minutes', async () => {
    for (const q of ['min=0', 'min=-5', 'min=abc', 'min=', 'min=99999', 'foo=1']) {
      assert.equal((await fetch(`${s.base}/api/sleep?${q}`)).status, 400, q);
    }
  });

  test('sleep: also sent over SSE', async () => {
    const sse = await openSse(`${s.base}/api/events`);
    await waitFor(() => sse.events.length >= 1);
    assert.ok('sleep' in sse.events[0].data);
    await fetch(`${s.base}/api/sleep?min=10`);
    await waitFor(() => sse.events.some((e) => e.event === 'change' && e.data.sleep?.mode === 'timer'));
    await fetch(`${s.base}/api/sleep/cancel`);
    await waitFor(() => sse.events.some((e) => e.event === 'change' && e.data.sleep === null));
    sse.close();
  });

  test('404 on unknown endpoint', async () => {
    assert.equal((await fetch(`${s.base}/api/nope`)).status, 404);
  });

  test('SSE: full state first, then changes', async () => {
    const sse = await openSse(`${s.base}/api/events`);
    assert.equal(sse.res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    await waitFor(() => sse.events.length >= 1);
    assert.equal(sse.events[0].event, 'state');
    assert.equal(sse.events[0].data.connected, true);

    s.mpv.setProp('mute', !s.mpv.properties.mute);
    await waitFor(() => sse.events.some((e) => e.event === 'change' && 'mute' in e.data));
    sse.close();
  });

  test('SSE: throttles time-pos updates', async () => {
    const sse = await openSse(`${s.base}/api/events`);
    await waitFor(() => sse.events.length >= 1);
    for (let i = 0; i < 50; i++) s.mpv.setProp('time-pos', i);
    await new Promise((r) => setTimeout(r, 400));
    const timeEvents = sse.events.filter((e) => e.event === 'change' && 'timePos' in e.data);
    assert.ok(timeEvents.length >= 1 && timeEvents.length <= 4, `too many events: ${timeEvents.length}`);
    assert.equal(timeEvents.at(-1).data.timePos, 49);
    sse.close();
  });

  test('static files and path traversal protection', async () => {
    const res = await fetch(`${s.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${s.base}/..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${s.base}/nope.html`)).status, 404);
  });
});

describe('API (IINA not running)', () => {
  let s;
  before(async () => { s = await startStack({ withMpv: false }); });
  after(async () => { await s.stop(); });

  test('/api/status 200, connected: false', async () => {
    const body = await (await fetch(`${s.base}/api/status`)).json();
    assert.equal(body.connected, false);
    assert.equal(body.title, null);
  });

  test('commands return 503', async () => {
    for (const p of ['/api/pause', '/api/seek?s=10', '/api/volume?d=1', '/api/next']) {
      const res = await fetch(s.base + p);
      assert.equal(res.status, 503, p);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.connected, false);
    }
    const res = await fetch(`${s.base}/api/command`, { method: 'POST', body: '["cycle","pause"]' });
    assert.equal(res.status, 503);
  });

  test('connects automatically once IINA starts', async () => {
    const sse = await openSse(`${s.base}/api/events`);
    s.mpv = await new FakeMpv(s.socketPath).start();
    await waitFor(() => sse.events.some((e) => e.event === 'change' && e.data.connected === true));
    assert.equal((await fetch(`${s.base}/api/pause`)).status, 200);
    sse.close();
  });

  test('503 when IINA does not reply in time', async () => {
    s.mpv.handler = () => true;
    assert.equal((await fetch(`${s.base}/api/pause`)).status, 503);
    s.mpv.handler = null;
  });
});

describe('Token protection', () => {
  let s;
  before(async () => { s = await startStack({ token: 'secret' }); });
  after(async () => { await s.stop(); });

  test('401 without or with a wrong token', async () => {
    assert.equal((await fetch(`${s.base}/api/status`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/status?token=wrong`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/events`)).status, 401);
  });

  test('works with query parameter, X-Token and Bearer header', async () => {
    assert.equal((await fetch(`${s.base}/api/status?token=secret`)).status, 200);
    assert.equal((await fetch(`${s.base}/api/status`, { headers: { 'X-Token': 'secret' } })).status, 200);
    assert.equal((await fetch(`${s.base}/api/status`, { headers: { Authorization: 'Bearer secret' } })).status, 200);
  });

  test('static files are available without a token', async () => {
    assert.equal((await fetch(`${s.base}/`)).status, 200);
  });
});
