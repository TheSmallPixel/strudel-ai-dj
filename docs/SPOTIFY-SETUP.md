# Spotify integration setup

Two cooperating pieces:

1. **Spotify Web API** — the agent searches, plays, pauses, queues, and reads
   Spotify's per-track BPM / key / energy estimates. Requires an OAuth flow
   (one-time per machine).
2. **librespot** — a small Rust binary that registers itself with Spotify as a
   Connect device named *Strudel AI DJ*. You pick it from the device list in
   the Spotify app and music plays through it. The audio comes out your
   default speakers, the console captures it via system loopback, and the
   agent layers Strudel patterns on top.

Both are optional but together they cover the full vision: the agent picks the
music, hears the music, and reacts musically.

---

## 1. Web API (OAuth)

### 1.1 Register a Spotify developer app

1. Visit <https://developer.spotify.com/dashboard> and sign in.
2. **Create app** → name it anything; the redirect URI must be exactly
   `http://127.0.0.1:7878/callback` (this matches `SPOTIFY_OAUTH_CALLBACK_PORT`
   in [`packages/dj-core/src/constants.ts`](../packages/dj-core/src/constants.ts)).
3. Copy the **Client ID** Spotify gives you.

### 1.2 Export the client id

```powershell
# PowerShell, current session only
$env:SPOTIFY_CLIENT_ID = "your-client-id-here"

# To persist for new shells:
[Environment]::SetEnvironmentVariable("SPOTIFY_CLIENT_ID", "your-client-id-here", "User")
```

### 1.3 Start the dev stack and authenticate

```sh
pnpm dev
```

Then in the chat panel, ask the agent:

> spotify_setup

A browser tab opens to Spotify's consent screen. Approve, and the redirect
lands at `127.0.0.1:7878/callback` where our local OAuth server exchanges the
code for tokens. They're saved to `~/.strudel-ai-dj/spotify.json` — one-time
setup per machine.

### 1.4 Verify

> spotify_status

Should return `Spotify ready.` After that the agent has these tools:

| Tool | Purpose |
|---|---|
| `spotify_devices` | List Connect-capable devices (Spotify desktop, mobile, Strudel AI DJ if librespot is running) |
| `spotify_use_device(id)` | Move playback to a specific device |
| `spotify_search(q)` | Find tracks by free-text query |
| `spotify_play(uri)` | Play a specific Spotify URI |
| `spotify_pause`, `spotify_resume`, `spotify_next`, `spotify_prev` | Transport |
| `spotify_queue(uri)` | Queue without interrupting |
| `spotify_now_playing` | Title, artist, position, plus Spotify's own BPM / key / danceability / energy |

---

## 2. Strudel AI DJ as a Spotify Connect device

You have **two options** for the "virtual Connect device" piece:

### Option A (recommended): Web Playback SDK — runs in the browser tab

Spotify's official JavaScript SDK turns the open Strudel AI DJ console tab into
a Spotify Connect device named **Strudel AI DJ**. No binary, no extra install.

1. Make sure step 1 above is done (OAuth tokens persisted).
2. Open the console (`http://localhost:5173`).
3. In the **audio** panel, under *spotify connect*, click **🎧 activate**.
4. After a few seconds you'll see `● Strudel AI DJ` lit green.
5. Open Spotify on any device → the speaker / Connect picker → choose
   **Strudel AI DJ**. Music now plays through the browser tab.
6. Click **start system capture** in the same panel and share the Strudel AI DJ
   tab (with audio) so the agent can hear what it's playing.

Constraints:
- Requires Spotify **Premium**.
- The browser tab must remain open for the device to stay registered.
- Audio is decoded under DRM (Widevine), so we can't read raw PCM directly —
  capture happens via the normal `getDisplayMedia` tab-audio path.

### Option B: librespot (native binary, alternative)

Skip this entirely if Option A works for you. librespot is only useful if you
want the Connect device to run headless (no browser tab open).

### 2.1 Install the binary

Pick one:

- **Releases (Windows / macOS / Linux)**:
  <https://github.com/librespot-org/librespot/releases> — download the archive
  for your platform, extract, and either:
  - drop the binary at `./bin/librespot.exe` (or `./bin/librespot`)
  - or set `LIBRESPOT_PATH=...` in your environment
  - or add it to your `PATH`

- **cargo** (if you have a Rust toolchain):
  ```sh
  cargo install librespot
  ```

### 2.2 Run it alongside the dev stack

```sh
pnpm dev:librespot
```

Output:

```
[librespot] spawning librespot.exe --name Strudel AI DJ --bitrate 320 --backend rodio --initial-volume 70
```

### 2.3 Use it from Spotify

- Open Spotify on any device (phone, desktop, web)
- Hit **Connect to a device** (the little speaker icon at the bottom)
- Pick **Strudel AI DJ**
- Play anything — audio comes out of your default audio device

The browser console's "start system capture" is what gives the agent ears.
Click it, share your screen/tab with audio, and the agent will receive the
loopback feed automatically.

### Notes / gotchas

- librespot needs Spotify **Premium** for Connect playback (free accounts
  can't push playback to a non-Spotify-official device).
- librespot's discovery uses mDNS on the local network. If you don't see the
  device in your Spotify app, check your firewall / VPN.
- If you run multiple machines, give each a different name via
  `LIBRESPOT_DEVICE_NAME=foo pnpm dev:librespot`.
- librespot doesn't expose its audio directly to us — we still rely on the
  console's getDisplayMedia loopback to feed the agent. The benefit of the
  virtual device is *control*: the agent picks `Strudel AI DJ` via
  `spotify_use_device` and `spotify_play(uri)`, so the music flow is fully
  owned by us.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `SPOTIFY_CLIENT_ID env var is not set` | Run `$env:SPOTIFY_CLIENT_ID = "..."` and restart `pnpm dev`. The agent process reads the env at startup. |
| Browser opens but redirect 404s | Make sure your Spotify app has `http://127.0.0.1:7878/callback` listed exactly (no trailing slash, `127.0.0.1` not `localhost`). |
| `Spotify API: 403` on `audio-features` | Spotify deprecates some endpoints for new apps. Other tools still work; the agent gracefully degrades. |
| `spotify_play` returns `Restriction violated` | Active device doesn't allow playback (e.g. another Premium user owns it). Run `spotify_devices`, then `spotify_use_device(id)`. |
| librespot fails with `failed to start` | Check `LIBRESPOT_PATH` or drop the binary at `./bin/librespot[.exe]`. |
| `Strudel AI DJ` not in Spotify device list | Wait ~10 seconds after librespot starts. Check Spotify Premium status. Disable VPN. |
