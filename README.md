# IINA Remote

Control the [IINA](https://iina.io) media player on your Mac from your phone's browser, and from iPhone and Apple Watch through the iOS **Shortcuts** app, over your local Wi-Fi network.

The server is written in Node.js with **no external dependencies**: it only uses the built-in `net` and `http` modules. It talks to IINA through mpv's JSON IPC over a Unix socket.

```
iPhone / Watch ──HTTP──▶ Node.js server (Mac) ──Unix socket, JSON IPC──▶ IINA (mpv)
       browser ◀──SSE───┘
```

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Setting up IINA](#setting-up-iina)
- [Installation and starting](#installation-and-starting)
- [Configuration](#configuration)
- [Web interface](#web-interface)
- [API](#api)
- [Sleep timer](#sleep-timer)
- [iOS Shortcuts (iPhone and Apple Watch)](#ios-shortcuts-iphone-and-apple-watch)
- [Start automatically (launchd)](#start-automatically-launchd)
- [Tests and troubleshooting](#tests-and-troubleshooting)
- [Known limitations](#known-limitations)

## Features

- Mobile-friendly "Liquid Glass" web UI in IINA's colours, with large buttons:
  - play/pause, ±10 s / ±60 s, previous/next, fullscreen, mute;
  - fine-grained volume control;
  - a draggable seek bar for absolute seeking.
- Live updates via Server-Sent Events, and a clear indicator when IINA is not running.
- Works as a home-screen web app (manifest, icons, meta tags).
- Simple GET endpoints, so each iOS Shortcut needs only a single "Get Contents of URL" action.
- Sleep timer: put the Mac to sleep after a given time, or when the current media ends.
- Persistent IPC connection with automatic reconnection when IINA quits or restarts.
- Optional token protection.
- launchd template to start at login and restart after a crash.

## Requirements

- macOS with [IINA](https://iina.io)
- Node.js 20 or newer (with Homebrew: `brew install node`)
- The phone and the Mac on the same local network

## Setting up IINA

IINA has to expose mpv's JSON IPC socket:

1. Open IINA's settings: **IINA → Settings… (⌘,)**, then go to the **Advanced** tab.
2. Turn on **Enable advanced settings**.
3. On the same **Advanced** tab, add a new row to **Additional mpv options** with the **+** button:

   | Key                | Value              |
   |--------------------|--------------------|
   | `input-ipc-server` | `/tmp/iina-socket` |

   If you change the server's `SOCKET_PATH`, use the same path here.
4. Restart IINA.

To check it: while IINA is running, the socket file must exist.

```sh
ls -l /tmp/iina-socket        # srwxr-xr-x ... /tmp/iina-socket
```

## Installation and starting

```sh
git clone https://github.com/<your-user>/iina-remote.git
cd iina-remote
npm start                     # or: node server.js
```

There is no `npm install` step, because there are no dependencies.

On startup the server prints the addresses it can be reached at, for example:

```
IINA Remote running: http://0.0.0.0:8080  (socket: /tmp/iina-socket)
  open: http://192.168.1.50:8080/
```

Open that address on your phone.

> **macOS firewall:** if the firewall is on, macOS may ask on first start whether `node` may accept incoming connections. Allow it.

The server also starts when IINA is not running. It retries the connection in the background every 0.5–5 seconds, and the status shows `connected: false` until IINA is back.

### Start with a double-click

Double-click **`Start IINA Remote.command`** in the project folder to start the server in a Terminal window. Stop it with **Ctrl+C**, or by closing the window.

- For settings (port, token, etc.), copy `config.env.example` to `config.env` and edit it. The launcher reads it.
- If the port is already in use (e.g. because launchd is already running the server), the launcher says so and does not start a second instance.
- For quick access, drag the file to the right-hand side of the Dock, next to the Trash.

### A stable address

The Mac's IP address can change. Two ways to avoid that:

- Reserve a fixed IP address for the Mac in your router (DHCP reservation).
- Or use the Mac's Bonjour name. `scutil --get LocalHostName` prints it; if it prints `MacBook`, the address is `http://MacBook.local:8080/`.

## Configuration

All settings come from environment variables:

| Variable             | Default            | Description                                                      |
|----------------------|--------------------|------------------------------------------------------------------|
| `PORT`               | `8080`             | HTTP port                                                        |
| `HOST`               | `0.0.0.0`          | Address to listen on (`127.0.0.1` = local only)                  |
| `SOCKET_PATH`        | `/tmp/iina-socket` | IINA's IPC socket (same as in IINA's settings)                   |
| `TOKEN`              | *(none)*           | If set, required for every `/api/*` request                      |
| `REQUEST_TIMEOUT_MS` | `3000`             | How long to wait for IINA's reply before returning 503           |
| `SLEEP_COMMAND`      | `pmset sleepnow`   | Command run by the [sleep timer](#sleep-timer)                   |

Example:

```sh
PORT=9000 TOKEN=some-long-secret node server.js
```

### Token protection

If `TOKEN` is set, every `/api/…` request must include it, in one of three ways:

- as a query parameter: `/api/pause?token=SECRET` (the easiest in Shortcuts);
- in an `X-Token: SECRET` header;
- in an `Authorization: Bearer SECRET` header.

A missing or wrong token returns `401`.

Static files (HTML, CSS, JS, icons, manifest) can be loaded without a token, because they contain nothing secret. This is required for the home-screen icon and the manifest to work.

To generate a random token:

```sh
openssl rand -hex 16
```

> The connection is plain HTTP, so the token travels unencrypted over the network. That is usually acceptable on a home Wi-Fi network, but not on a public one.

## Web interface

Open `http://<mac-ip>:8080/` on your phone. With a token: `http://<mac-ip>:8080/?token=SECRET`.

- **Buttons:**
  - play/pause;
  - seek ±10 s and ±60 s;
  - previous and next item;
  - fullscreen;
  - mute.
- **Volume:**
  - adjustable in fine 2% steps;
  - **hold** the −/+ button to change it continuously;
  - the slider sets it with 1% precision.
- **Seek bar:** drag it to seek to an absolute position when you release it.
- **Sleep timer:** tap the moon pill in the top-right corner to open the sleep sheet.
  - 15 / 30 / 45 / 60 / 90 / 120 minutes, or **end of media**;
  - the pill and the sheet show the countdown, and the sheet also shows the time;
  - **Cancel sleep timer** turns it off.
  - Details: [Sleep timer](#sleep-timer).
- **Connection dot** in the top-left pill: green = connected to IINA, orange = IINA is not running, red = the server cannot be reached.
- **Reduce Transparency** (iOS accessibility setting) replaces the glass with solid surfaces.
- **Live updates** via Server-Sent Events. The banner at the top shows when:
  - IINA is not running;
  - no file is open;
  - the server cannot be reached.

### Add to Home Screen

1. Open the page in Safari, including the `?token=…` part if you use a token.
2. Tap **Share → Add to Home Screen**.

The icon opens as a full-screen app. The token stays in the URL, so the home-screen app gets it too. This is needed because on iOS the home-screen app cannot see Safari's storage.

If you enter the token later in the UI, the page writes it into the URL automatically, so add the page to the Home Screen **after** that.

## API

All responses are JSON. The control endpoints can be called with `GET`, so a single "Get Contents of URL" action is enough in Shortcuts. `POST` is accepted as well.

| Endpoint                  | mpv command                     | Description                                              |
|---------------------------|---------------------------------|----------------------------------------------------------|
| `GET /api/pause`          | `cycle pause`                   | Toggle play/pause                                        |
| `GET /api/seek?s=10`      | `seek 10 relative`              | Relative seek in seconds (may be negative)               |
| `GET /api/seek?to=600`    | `seek 600 absolute`             | Absolute seek (used by the seek bar)                     |
| `GET /api/volume?d=5`     | `add volume 5`                  | Relative volume (e.g. `d=-2`, `d=0.5`)                   |
| `GET /api/volume?set=40`  | `set_property volume 40`        | Absolute volume (0 … `volume-max`)                       |
| `GET /api/mute`           | `cycle mute`                    | Toggle mute                                              |
| `GET /api/fullscreen`     | `cycle fullscreen`              | Toggle fullscreen                                        |
| `GET /api/next`           | `playlist-next`                 | Next item in the playlist                                |
| `GET /api/prev`           | `playlist-prev`                 | Previous item in the playlist                            |
| `GET /api/sleep?min=30`   | –                               | Put the Mac to sleep in 30 minutes (fractions allowed, max. 1440) |
| `GET /api/sleep?end`      | –                               | Put the Mac to sleep when the current media ends         |
| `GET /api/sleep/cancel`   | –                               | Cancel the sleep timer                                   |
| `GET /api/sleep`          | –                               | Current sleep timer state                                |
| `GET /api/status`         | –                               | Current state                                            |
| `GET /api/events`         | –                               | Server-Sent Events: live state changes                   |
| `POST /api/command`       | anything                        | Arbitrary mpv command (advanced use)                     |

The response of the control endpoints includes the fresh state:

```json
{
  "ok": true,
  "state": {
    "connected": true, "pause": true, "timePos": 1034.2, "duration": 2712,
    "volume": 64, "volumeMax": 100, "mute": false,
    "title": "Movie.mkv", "fullscreen": false,
    "playlistPos": 0, "playlistCount": 3, "eofReached": false,
    "sleep": null
  }
}
```

`/api/status` returns the same state object without the `ok` / `state` wrapper. When IINA is not running it still returns `200`, with `connected: false` and the other fields set to `null`. That makes it easy to display the state in Shortcuts.

### Error codes

| Code  | When                                                                                 |
|-------|--------------------------------------------------------------------------------------|
| `400` | Missing or invalid parameter (`s`, `to`, `d`, `set`, `min`), invalid JSON for `/api/command` |
| `401` | Missing or invalid token                                                             |
| `404` | Unknown endpoint                                                                     |
| `405` | Wrong HTTP method                                                                    |
| `413` | Request body too large (over 16 KB)                                                  |
| `502` | mpv returned an error (e.g. there is no next item in the playlist)                  |
| `503` | **IINA is not available**, or did not reply in time                                  |

Error responses look like this:

```json
{ "ok": false, "error": "IINA is not available (no IPC connection)", "connected": false }
```

### `POST /api/command`

The body is either `{"command": [...]}` or a plain JSON array. The response contains mpv's `data` field.

```sh
curl -X POST http://localhost:8080/api/command \
     -d '{"command":["get_property","path"]}'
# {"ok":true,"data":"/Users/.../Movie.mkv"}

curl -X POST http://localhost:8080/api/command -d '["set_property","speed",1.5]'
curl -X POST http://localhost:8080/api/command -d '["screenshot"]'
curl -X POST http://localhost:8080/api/command -d '["loadfile","/path/to/movie.mkv"]'
```

See the [mpv documentation](https://mpv.io/manual/stable/#list-of-input-commands) for the list of commands.

### `GET /api/events` (SSE)

On connect a `state` event is sent with the full state, followed by `change` events with the changed fields only. `timePos` updates are throttled to about 4 per second.

```sh
curl -N http://localhost:8080/api/events
# event: state
# data: {"connected":true,"pause":false,...}
#
# event: change
# data: {"timePos":1035.25}
```

## Sleep timer

The timer puts the whole Mac to sleep (`pmset sleepnow`), not just the display. Playback is **paused** first, so it does not resume on its own after wake-up.

- **After a given time:** `/api/sleep?min=30`. Minutes may be fractional (`min=0.5`), up to 1440 (24 hours).
- **At the end of the media:** `/api/sleep?end`. The Mac goes to sleep when the file that is playing now ends:
  - If IINA stops at the end (the default, `eof-reached`), the Mac sleeps.
  - If there is a next item in the playlist, it is not played: it is paused, and the Mac sleeps.
  - Stopping manually, closing the file or skipping to the next item does **not** count as the end of the media.
- **Cancel:** `/api/sleep/cancel`. A new schedule always replaces the previous one.

Response:

```json
{ "ok": true, "sleep": { "mode": "timer", "endsAt": 1793713972732 } }
{ "ok": true, "sleep": { "mode": "end",   "endsAt": null } }
{ "ok": true, "sleep": null }
```

`endsAt` is a timestamp (Unix ms). The state also appears in the `sleep` field of `/api/status` and of the SSE stream.

> - The timer lives in the server's memory: it is lost if the server restarts.
> - The timed mode does not need IINA to be running.
> - The end-of-media mode can only fire while IINA is running, because the signal comes from IINA.

**Trying it without sleeping:** with the `SLEEP_COMMAND` environment variable, any command can run instead. For example, the Mac says this out loud and stays awake:

```sh
SLEEP_COMMAND="say Good night" node server.js
curl "http://localhost:8080/api/sleep?min=0.1"     # in 6 seconds
```

With `SLEEP_COMMAND="pmset displaysleepnow"` only the display turns off.

## iOS Shortcuts (iPhone and Apple Watch)

The examples below use `http://192.168.1.50:8080` as the address and `SECRET` as the token. Replace them with your own, or use the Bonjour name (e.g. `http://MacBook.local:8080`). Without a token, leave out the `?token=…` part.

### 1. One-tap shortcut: play/pause

1. **Shortcuts** app → **+** (new shortcut) → name it **IINA Pause**.
2. Add the **Get Contents of URL** action.
3. URL:
   ```
   http://192.168.1.50:8080/api/pause?token=SECRET
   ```
4. Done. Run it with Siri ("Hey Siri, IINA Pause"), the Action button, or a widget.

Create one shortcut per action the same way:

| Shortcut name       | URL                                    |
|---------------------|----------------------------------------|
| IINA Back 10        | `/api/seek?s=-10&token=SECRET`         |
| IINA Forward 30     | `/api/seek?s=30&token=SECRET`          |
| IINA Louder         | `/api/volume?d=5&token=SECRET`         |
| IINA Quieter        | `/api/volume?d=-5&token=SECRET`        |
| IINA Mute           | `/api/mute?token=SECRET`               |
| IINA Next           | `/api/next?token=SECRET`               |

> **Token in a header:** instead of the query parameter you can add it under **Headers** in the "Get Contents of URL" action: key `X-Token`, value `SECRET`. That keeps the token out of the URL.

### 2. Remote control menu (ideal for Apple Watch)

A single shortcut that shows a menu:

1. New shortcut, named **IINA**.
2. **Choose from Menu**, with the options `Pause`, `−10 s`, `+10 s`, `+60 s`, `Louder`, `Quieter`, `Mute`, `Next`.
3. In each branch, add a **Get Contents of URL** action with the matching URL:
   - Pause → `…/api/pause?token=SECRET`
   - −10 s → `…/api/seek?s=-10&token=SECRET`
   - Louder → `…/api/volume?d=3&token=SECRET`
   - and so on.
4. Optionally, after the menu:
   - **Get Dictionary Value**: key `state.title`, from the "Contents of URL" variable;
   - then **Show Result**.

   The Watch then shows what is playing.

### 3. Sleep timer

**Fixed time** (e.g. "IINA Sleep 30"): **Get Contents of URL** → `…/api/sleep?min=30&token=SECRET`

**Ask for the number of minutes:**

1. **Ask for Input**: type **Number**, prompt: "Sleep in how many minutes?"
2. **Get Contents of URL**: `…/api/sleep?min=`**[Provided Input]**`&token=SECRET`. Insert the "Provided Input" variable into the URL.

**At the end of the movie:** `…/api/sleep?end&token=SECRET`. This works nicely with Siri, e.g. "Hey Siri, IINA sleep at the end".

**Cancel:** `…/api/sleep/cancel?token=SECRET`

You can also add these to the Watch menu shortcut, e.g. as `Sleep 30 min`, `Sleep at end` and `Sleep off`.

### 4. Querying the status

1. **Get Contents of URL**: `…/api/status?token=SECRET`
2. **Get Dictionary Value**: key `title`
3. **Show Result**

When IINA is not running, `title` is empty and `connected` is `false`. You can handle that with an **If** action.

### Shortcuts on Apple Watch

- When editing the shortcut, tap **ⓘ** (Details) and turn on **Show on Apple Watch**.
- It appears in the **Shortcuts** app on the Watch. You can also add it to a watch face as a complication, and run it with Siri on the Watch.
- The Watch sends the request either through the iPhone or directly over Wi-Fi. Either way it has to be on the **same local network** as the Mac.

> **Tip:** if it is slow or occasionally fails from the Watch, the Watch is usually not on Wi-Fi and the iPhone is too far away. In that case the IP address is more reliable than the `.local` Bonjour name.

## Start automatically (launchd)

`launchd/local.iina-remote.plist` is a **LaunchAgent** template. It starts the server at login and restarts it after a crash, at most every 10 seconds.

It is a LaunchAgent rather than a LaunchDaemon because IINA also runs in the user session, and the socket belongs to your user. With automatic login enabled, the server effectively starts with the Mac.

### Installation

```sh
cd iina-remote

# 1. Fill in the placeholders and copy to the LaunchAgents folder
sed -e "s|__PROJECT_DIR__|$PWD|g" \
    -e "s|__NODE__|$(which node)|g" \
    -e "s|__HOME__|$HOME|g" \
    launchd/local.iina-remote.plist > ~/Library/LaunchAgents/local.iina-remote.plist

# 2. (Optional) Edit the port and the token
open -e ~/Library/LaunchAgents/local.iina-remote.plist

# 3. Validate and load
plutil -lint ~/Library/LaunchAgents/local.iina-remote.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.iina-remote.plist
```

> With Homebrew, `which node` is `/opt/homebrew/bin/node`, which stays valid when Homebrew updates Node. If you use `nvm`, prefer the Homebrew Node over a version-specific path.

### Managing the service

```sh
# Status
launchctl print gui/$(id -u)/local.iina-remote | grep -E 'state|pid|last exit'

# Restart (e.g. after an update)
launchctl kickstart -k gui/$(id -u)/local.iina-remote

# Stop and remove
launchctl bootout gui/$(id -u)/local.iina-remote
rm ~/Library/LaunchAgents/local.iina-remote.plist

# Log
tail -f ~/Library/Logs/iina-remote.log
```

After editing the plist (e.g. the token), run `bootout` first, then `bootstrap` again.

## Tests and troubleshooting

```sh
npm test            # node --test: IPC client, state, sleep timer, API – no IINA needed
```

The tests start a fake mpv socket server (`test/fake-mpv.js`) in a temporary directory. They cover:

- request/response matching, including out-of-order replies;
- timeouts;
- split and concatenated lines;
- reconnection;
- missing and stale sockets (`ENOENT` / `ECONNREFUSED`);
- the sleep timer (without actually sleeping);
- all endpoints, error codes, SSE and the token.

### Testing the IPC client manually (without the server)

```sh
npm run ipc -- get_property media-title
node scripts/ipc-cli.js cycle pause
node scripts/ipc-cli.js seek 10 relative
node scripts/ipc-cli.js --watch          # live state changes, Ctrl+C to quit
```

### Common problems

| Symptom | Cause and fix |
|---|---|
| `IPC error: ENOENT` in the log | IINA is not running, or `input-ipc-server` is not set (see above). |
| `IPC error: ECONNREFUSED` | The socket file is left over, but IINA is no longer running. Start IINA; the server reconnects on its own. |
| Not reachable from the phone | Same Wi-Fi? Is `node` allowed in the firewall? Is the IP address right? |
| `/api/pause` returns 503 although IINA is running | Check that `SOCKET_PATH` matches IINA's setting (`ls -l /tmp/iina-socket`). |
| The home-screen icon does not update | Regenerate the icons with `node scripts/make-icons.js`, then remove the page from the Home Screen and add it again. |

## Known limitations

- **Multiple IINA windows:** IINA tries to use the same `input-ipc-server` path for every player window. If several windows are open at once, only one of them listens on the socket, usually the most recently opened one. The remote always connects to whichever one is on the socket. When a window closes, the server reconnects on its next attempt.
- When the Mac is asleep (e.g. after the sleep timer), the server cannot be reached, and the phone cannot wake the Mac. If needed, you can prevent sleeping while the display is off under System Settings → Energy.
- The connection is HTTP, not HTTPS. It is meant for the local network; do not expose it to the internet.

## Files

```
server.js                   entry point
src/config.js               configuration from environment variables
src/mpv-client.js           IPC client: framing, request_id, timeouts, reconnection
src/player-state.js         observe_property → in-memory state
src/sleep-timer.js          sleep timer (after a given time / at the end of the media)
src/api.js                  HTTP endpoints, SSE, static files
src/auth.js                 token check
public/                     web UI (HTML/CSS/JS, manifest, icons)
scripts/ipc-cli.js          manual IPC test
scripts/make-icons.js       generates the PNG icons without dependencies
test/                       node:test tests + fake mpv server
launchd/                    LaunchAgent template
Start IINA Remote.command   double-click launcher
config.env.example          example settings for the launcher
```
