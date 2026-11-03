import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MpvClient } from '../src/mpv-client.js';
import { PlayerState } from '../src/player-state.js';
import { SleepTimer, makeSleepCommand } from '../src/sleep-timer.js';
import { FakeMpv, tmpSocketPath, waitFor } from './fake-mpv.js';

describe('SleepTimer', () => {
  let socketPath, mpv, client, state, timer, sleeps;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    mpv = await new FakeMpv(socketPath).start();
    client = new MpvClient({ socketPath, requestTimeoutMs: 300, minRetryMs: 20, maxRetryMs: 50 });
    state = new PlayerState(client);
    sleeps = [];
    // Instead of really sleeping, just record the call.
    timer = new SleepTimer({ client, state, sleepFn: async () => { sleeps.push(Date.now()); } });
    client.start();
    await waitFor(() => state.state.title !== null && state.state.eofReached === false);
  });

  afterEach(async () => {
    timer.stop();
    client.stop();
    await mpv.stop();
  });

  test('initially nothing is scheduled, and the state shows it', () => {
    assert.equal(timer.status(), null);
    assert.equal(state.state.sleep, null);
  });

  test('timer: on expiry pauses, then sleeps', async () => {
    assert.equal(mpv.properties.pause, false);
    timer.setTimer(0.002); // 120 ms
    assert.equal(state.state.sleep.mode, 'timer');
    assert.ok(state.state.sleep.endsAt > Date.now());
    await waitFor(() => sleeps.length === 1);
    assert.equal(mpv.properties.pause, true, 'must pause before sleeping');
    assert.equal(timer.status(), null);
    assert.equal(state.state.sleep, null);
  });

  test('does not sleep after cancel', async () => {
    timer.setTimer(0.002);
    timer.cancel();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sleeps.length, 0);
    assert.equal(state.state.sleep, null);
  });

  test('a new schedule replaces the previous one', async () => {
    timer.setTimer(0.002);
    timer.setTimer(10);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sleeps.length, 0);
    assert.equal(timer.status().mode, 'timer');
  });

  test('invalid minutes → RangeError', () => {
    for (const m of [0, -1, NaN, Infinity, 24 * 60 + 1]) {
      assert.throws(() => timer.setTimer(m), RangeError, String(m));
    }
  });

  test('end of media: sleeps on eof-reached (keep-open)', async () => {
    timer.setEndOfMedia();
    assert.deepEqual(state.state.sleep, { mode: 'end', endsAt: null });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sleeps.length, 0);
    mpv.setProp('eof-reached', true);
    await waitFor(() => sleeps.length === 1);
    assert.equal(mpv.properties.pause, true);
    assert.equal(state.state.sleep, null);
  });

  test('end of media: sleeps on end-file (reason: eof) and pauses the next item', async () => {
    timer.setEndOfMedia();
    mpv.sendEvent({ event: 'end-file', reason: 'eof' });
    await waitFor(() => sleeps.length === 1);
    assert.equal(mpv.properties.pause, true);
  });

  test('end of media: a manual stop (reason: stop) does not trigger sleep', async () => {
    timer.setEndOfMedia();
    mpv.sendEvent({ event: 'end-file', reason: 'stop' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sleeps.length, 0);
    assert.equal(timer.status().mode, 'end');
  });

  test('end of media: sleeps right away if already at the end', async () => {
    mpv.setProp('eof-reached', true);
    await waitFor(() => state.state.eofReached === true);
    timer.setEndOfMedia();
    await waitFor(() => sleeps.length === 1);
  });

  test('sleeps only once even if several signals arrive', async () => {
    timer.setEndOfMedia();
    mpv.sendEvent({ event: 'end-file', reason: 'eof' });
    mpv.setProp('eof-reached', true);
    await waitFor(() => sleeps.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sleeps.length, 1);
  });

  test('sleeps without pausing if IINA is not running', async () => {
    timer.setTimer(0.003);
    await mpv.stop();
    await waitFor(() => !client.connected);
    await waitFor(() => sleeps.length === 1);
    assert.equal(state.state.sleep, null);
  });
});

describe('makeSleepCommand', () => {
  test('runs the given command (here: true / false, no actual sleep)', async () => {
    await makeSleepCommand('true')();
    await assert.rejects(makeSleepCommand('false')());
  });
});
