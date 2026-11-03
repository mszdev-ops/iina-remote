// Sleep timer: puts the Mac to sleep after a given time, or when the current media ends.
//
// Before sleeping it pauses playback (if IINA is reachable), so playback does not
// resume on its own after wake-up.
//
// The state is written to the PlayerState `sleep` field, so it is also sent over SSE:
//   null                                  – no sleep scheduled
//   { mode: 'timer', endsAt: <epoch ms> } – at a given time
//   { mode: 'end',   endsAt: null }       – at the end of the current media

import { execFile } from 'node:child_process';

export const MAX_MINUTES = 24 * 60;

/** Default sleep function: `pmset sleepnow` (does not require admin rights). */
export function makeSleepCommand(commandLine = 'pmset sleepnow', log = () => {}) {
  const [file, ...args] = commandLine.trim().split(/\s+/);
  return () =>
    new Promise((resolve, reject) => {
      execFile(file, args, { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) {
          log(`Sleep command failed (${commandLine}): ${stderr || err.message}`);
          reject(err);
        } else {
          resolve();
        }
      });
    });
}

export class SleepTimer {
  /**
   * @param {object} deps
   * @param {import('./mpv-client.js').MpvClient} deps.client
   * @param {import('./player-state.js').PlayerState} deps.state
   * @param {() => Promise<void>} deps.sleepFn  puts the machine to sleep
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ client, state, sleepFn, log = () => {} }) {
    if (typeof sleepFn !== 'function') throw new TypeError('sleepFn is required');
    this.client = client;
    this.state = state;
    this.sleepFn = sleepFn;
    this.log = log;
    this.mode = null;
    this.endsAt = null;
    this._timer = null;
    this._firing = false;

    // End of media: with a playlist an 'end-file' event (reason: eof) arrives;
    // with keep-open (IINA's default) 'eof-reached' becomes true.
    client.on('event', (msg) => {
      if (this.mode === 'end' && msg.event === 'end-file' && msg.reason === 'eof') {
        this._fire('the media ended');
      }
    });
    state.on('change', (patch) => {
      if (this.mode === 'end' && patch.eofReached === true) this._fire('the media ended');
    });

    this._publish();
  }

  /** Sleep in `minutes` minutes. */
  setTimer(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) {
      throw new RangeError(`Minutes must be a number between 0 and ${MAX_MINUTES}`);
    }
    this._clear();
    this.mode = 'timer';
    this.endsAt = Date.now() + Math.round(minutes * 60000);
    this._timer = setTimeout(() => this._fire('the timer expired'), this.endsAt - Date.now());
    this.log(`Sleep scheduled in ${minutes} minutes`);
    this._publish();
  }

  /** Sleep at the end of the current media. */
  setEndOfMedia() {
    this._clear();
    this.mode = 'end';
    this.endsAt = null;
    this.log('Sleep scheduled at the end of the media');
    this._publish();
    // Already at the end (keep-open): sleep right away.
    if (this.state.state.eofReached === true) this._fire('the media is already at its end');
  }

  cancel() {
    const had = this.mode !== null;
    this._clear();
    this.mode = null;
    this.endsAt = null;
    if (had) this.log('Sleep cancelled');
    this._publish();
  }

  status() {
    return this.mode ? { mode: this.mode, endsAt: this.endsAt } : null;
  }

  _clear() {
    clearTimeout(this._timer);
    this._timer = null;
  }

  _publish() {
    this.state.set({ sleep: this.status() });
  }

  async _fire(reason) {
    if (this._firing || this.mode === null) return;
    this._firing = true;
    this._clear();
    this.mode = null;
    this.endsAt = null;
    this._publish();
    this.log(`Sleep: ${reason} – pausing playback and putting the Mac to sleep`);
    try {
      if (this.client.connected) {
        await this.client.command(['set_property', 'pause', true]).catch((err) => {
          this.log(`Pause failed: ${err.message}`);
        });
      }
      await this.sleepFn();
    } catch {
      // already logged by sleepFn
    } finally {
      this._firing = false;
    }
  }

  stop() {
    this._clear();
  }
}
