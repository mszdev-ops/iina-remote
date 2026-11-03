// In-memory state of the observed mpv properties.
//
// Event: 'change' (patch) – an object with the changed fields
// (e.g. { pause: true } or { connected: false, ... }).

import { EventEmitter } from 'node:events';

/** mpv property name → state field name */
export const OBSERVED = {
  'pause': 'pause',
  'time-pos': 'timePos',
  'duration': 'duration',
  'volume': 'volume',
  'volume-max': 'volumeMax',
  'mute': 'mute',
  'media-title': 'title',
  'fullscreen': 'fullscreen',
  'playlist-pos': 'playlistPos',
  'playlist-count': 'playlistCount',
  'eof-reached': 'eofReached',
};

function emptyState() {
  const s = { connected: false };
  for (const key of Object.values(OBSERVED)) s[key] = null;
  return s;
}

export class PlayerState extends EventEmitter {
  /** @param {import('./mpv-client.js').MpvClient} client */
  constructor(client, { log = () => {} } = {}) {
    super();
    this.client = client;
    this.log = log;
    this.state = emptyState();
    this._idToKey = new Map();

    const names = Object.keys(OBSERVED);
    names.forEach((name, i) => this._idToKey.set(i + 1, OBSERVED[name]));

    client.on('connect', () => {
      this._apply({ connected: true });
      // Observers must be re-registered after every reconnect.
      names.forEach((name, i) => {
        client.observeProperty(i + 1, name).catch((err) => {
          this.log(`observe_property ${name} failed: ${err.message}`);
        });
      });
    });

    client.on('disconnect', () => {
      if (!this.state.connected && this._isEmpty()) return;
      this._apply(emptyState());
    });

    client.on('property', (name, data, id) => {
      const key = this._idToKey.get(id) ?? OBSERVED[name];
      if (!key) return;
      this._apply({ [key]: data === undefined ? null : data });
    });
  }

  _isEmpty() {
    return Object.values(OBSERVED).every((k) => this.state[k] === null);
  }

  _apply(patch) {
    const changed = {};
    for (const [k, v] of Object.entries(patch)) {
      if (this.state[k] !== v) {
        this.state[k] = v;
        changed[k] = v;
      }
    }
    if (Object.keys(changed).length) this.emit('change', changed);
  }

  /** Sets fields that do not come from mpv (e.g. sleep); a disconnect does not reset them. */
  set(patch) {
    this._apply(patch);
  }

  snapshot() {
    return { ...this.state };
  }
}
