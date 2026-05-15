# strudel-ai-dj

> An AI-controllable live-coding DJ. **Claude** writes [Strudel](https://strudel.cc) patterns in real time, plays Spotify through a virtual Connect device, samples the audio, chops it, and layers a full techno (or house, or D&B, or whatever you ask for) set on top — autonomously, across a whole "night."

Strudel is the instrument. Claude is the second pair of hands. You sit in the chat panel and steer the vibe.

```
                          ┌──────────────────────────┐
                          │  Spotify app (your phone) │
                          │  → cast to "Strudel AI DJ"│
                          └────────────┬──────────────┘
                                       │
                          ┌────────────▼──────────────┐
                          │  librespot (native Rust)   │
                          │  raw PCM, 44.1k stereo     │
                          └────────────┬──────────────┘
                                       │ stdout pipe
              ┌────────────────────────▼─────────────────────────┐
              │  Node host                                       │
              │  ┌──────────────┐   ┌──────────────────────────┐ │
              │  │ bridge (WS)  │◄─►│ agent (Claude Agent SDK) │ │
              │  └──────┬───────┘   └──────────────────────────┘ │
              │         │                                        │
              │         │ ws://localhost:7777                    │
              └─────────┼────────────────────────────────────────┘
                        │
              ┌─────────▼────────────────────────────────────────┐
              │  Browser (Chromium)                              │
              │  - Strudel REPL via @strudel/web                 │
              │  - Audio worklet + feature extractor             │
              │  - Mel-spectrogram renderer (PNG to Claude)      │
              │  - Chat / slot map / restart buttons             │
              └──────────────────────────────────────────────────┘
                        │
                        ▼   Strudel synthesizes audio
                  YOUR SPEAKERS
```

The user only hears Strudel. Spotify audio is captured silently in the background — the agent uses it as a feature source and a sampling source, never as a playback path. It is *the agent's ears*, not the audience's.

---

## Table of contents

- [What it does](#what-it-does)
- [Why this is interesting](#why-this-is-interesting)
- [Quickstart (5 min)](#quickstart-5-min)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [How a night runs (data flow)](#how-a-night-runs-data-flow)
- [The agent's tool surface](#the-agents-tool-surface)
- [The slot model](#the-slot-model)
- [Spotify integration](#spotify-integration)
- [Configuration](#configuration)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Status & roadmap](#status--roadmap)
- [Legal](#legal)
- [License](#license)

---

## What it does

Drop a Spotify URL in the chat panel and say *"remix this in techno"*. The agent will:

1. Call `spotify_track_info` to pull artist, BPM, key, popularity, release year.
2. Lock a vibe via `set_vibe("industrial techno, 132 BPM, dark and driving")` so it stays on-style across hours.
3. Call `spotify_play(uri)` to push the track through the **Strudel AI DJ** Connect device. librespot decodes raw PCM in the Node host; the audience never hears it.
4. Every ~16 bars, wake up (`onNightTick`), check `audio_features` and `audio_spectrogram`, and produce *at least one* incremental change — a new layer, a filter sweep, a kick variation.
5. Once the source is flowing, call `record_sample` 4–6 times to capture diverse moments (drum loop, vocal chop, bass hit, atmospheric texture) into the in-memory sample server at `http://127.0.0.1:7779/samples/<name>.wav`.
6. Compose those samples into the running pattern via `set_pattern_slot` — chopped, sliced, sidechained, panned, filter-swept.
7. Display a self-evaluation scorecard each tick (BPM drift vs. Spotify, distinct sample bases, slot count, user feedback) and self-correct.

You can interrupt with chat at any time. The agent queues your message ahead of the next tick.

## Why this is interesting

Most "AI DJ" demos are MIDI loop pickers. This one writes the music: real Strudel code, every slot a single live-coded expression, recomposed into a running `stack(slot1, slot2, ...)` every cycle.

Three pieces make that work:

- **Slot composition.** The browser keeps a named-slot map (`kick`, `hh`, `bass`, `lead`, `pad`, `fx`, `vis`, …). The agent edits one slot at a time. Other slots stay byte-identical, so Strudel swaps at the next cycle boundary with no audible click. The agent doesn't hard-cut every tick — it *evolves*.
- **Persistent vibe across SDK turns.** Claude Agent SDK is stateless between `query()` calls. We re-inject the locked vibe + a self-evaluation scorecard into every night-tick prompt so the agent stays on-style across hours, not minutes.
- **Raw PCM from Spotify, legally.** librespot registers as a Spotify Connect device. Spotify decodes Ogg/Vorbis natively (no DRM bypass), pipes S16LE PCM to stdout, and our Node host paces it in real time (50 ms ticks, with backpressure so the buffer doesn't underrun). The agent can sample, analyze, and chop from any Spotify track without touching DRM-protected paths.

## Quickstart (5 min)

**Prereqs:** Node 20+, pnpm 9+, a Chromium-based browser, and either a Claude Code Pro/Max subscription or an `ANTHROPIC_API_KEY`.

```bash
git clone https://github.com/TheSmallPixel/strudel-ai-dj.git
cd strudel-ai-dj
pnpm install
pnpm dev
```

Open <http://localhost:5173>. You should see:
- Green **● bridge** in the transport bar
- Strudel REPL booting (the prebake pulls `github:tidalcycles/dirt-samples`, takes ~10s on first run)
- Audio panel with feature bars
- Chat panel ready

Type: `make a 124 BPM techno groove with a filter-swept bass and a syncopated hat`. Within 5–10 seconds you'll hear the first slots come in.

To wire Spotify (optional but recommended for the full experience), see [Spotify integration](#spotify-integration).

## Architecture

Three processes talking over one WebSocket bridge:

| Process       | What it owns                                                              | Connect role |
|---------------|---------------------------------------------------------------------------|--------------|
| `bridge`      | WS hub on `ws://localhost:7777`. Stateless message router + state mirror. | hub          |
| `agent`       | Claude Agent SDK runtime. Reads features, writes patterns. Holds the night loop and the locked vibe. Optionally hosts `librespot` (the Spotify Connect device) on Windows. | controller   |
| `dj-console`  | Browser app (React + Vite). Owns the Strudel runtime, audio capture, chat UI, slot map, sample registry. | console      |

`mcp-server` is a fourth, optional process — it speaks **stdio MCP** for Claude Desktop integration. The same tool surface, exposed to any external MCP client.

The bridge multiplexes by *role*:
- `controller` = backend agents (Node)
- `console` = the browser tab
- Some messages broadcast (slot edits); some target one side (sample registry events, restart commands).

There is one source of truth (the bridge's `StateStore`), and zero polling — everything is event-driven.

For a deeper tour see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Repository layout

```
strudelAIDJ/
├─ apps/
│  ├─ dj-console/          ← Browser app (React + Vite, port 5173)
│  └─ strudel-dj/          ← Upstream Strudel monorepo, kept as a git subtree
│                           for future deep integration (currently we use the
│                           public @strudel/web npm package)
├─ packages/
│  ├─ dj-core/             ← Shared types, bridge protocol, constants
│  ├─ scheduler/           ← Bar clock, callback registry, event bus
│  ├─ bridge/              ← WebSocket hub + in-memory state store
│  ├─ agent/               ← Claude Agent SDK runtime + night-tick loop
│  │                         + librespot host (Spotify PCM tap)
│  │                         + sample server (HTTP on 7779)
│  ├─ mcp-server/          ← Stdio MCP server (for Claude Desktop)
│  ├─ audio-input/         ← DSP: RMS, FFT, onset, tempo, mel-spectrogram PNG
│  └─ providers/
│     ├─ spotify/          ← OAuth (PKCE), Web API client
│     ├─ youtube/          ← YouTube Data API v3 client
│     └─ generic/          ← Null fallback provider
├─ docs/                   ← Architecture, setup, MCP tool reference, legal
├─ bin/                    ← Slot for the librespot.exe binary (optional)
├─ scripts/                ← Dev helpers (librespot launcher)
└─ PLAN.md                 ← Original spec & ongoing design doc
```

`apps/strudel-dj` is the upstream Strudel codebase pulled in as a subtree. **You don't need to install or build it** to run this project — the browser app uses the public `@strudel/web` package. Subtree is there for future fork-level changes (e.g. exposing the audio graph or adding new visualizers).

## How a night runs (data flow)

### "Play this song and remix it" (chat in browser)

```
You type a Spotify URL in chat
  → BridgeMessage { type:'chat.message', message:{ role:'user', text:'...' } }
  → bridge.broadcast → agent receives
  → agent enqueues a turn (Claude Agent SDK query())
  → Tool calls stream out as the agent reasons:
       spotify_track_info(uri)          → metadata
       set_vibe("techno remix, 130bpm") → locks the night
       set_tempo(130)                   → broadcasts pattern.set_tempo
       spotify_play(uri)                → librespot starts decoding PCM
       audio_features({stream:"external"})  → first read still empty
       set_pattern_slot(slot:"kick", code:'s("bd*4").gain(.9)')
                                        → broadcasts pattern.set_slot
  → Browser StrudelPanel applies each slot edit, recomposes stack, evaluates
  → AudioWorklet tap on Strudel's master → "strudel" stream features
  → librespot stdout PCM → FeatureExtractor → "external" stream features
  → Every 16 bars (configurable), agent wakes via onNightTick
  → Each tick: current_slots → audio_features → 1+ slot edits → strudel_log
```

### "Record samples from what's playing"

```
record_sample(name:"vocal_chop", seconds:2, stream:"external")
  → agent sends sample.record_request to bridge
  → bridge broadcasts to controllers (librespot host) AND console
  → librespot host owns 'external': snapshot ring buffer → WAV →
       store in /tmp/wavStore → serve at http://127.0.0.1:7779/samples/vocal_chop.wav
  → sample.record_result with wavUrl
  → console receives, registers as a Strudel sample
  → set_pattern_slot(slot:"fx", code:'s("vocal_chop").slice(8, "0 ~ 3 ~ 5 ~ 2 ~").gain(.4)')
```

### "Stop everything, the speakers are blown"

The transport bar has a red **PANIC** button. Browser broadcasts `{type:'panic'}`, console hushes Strudel, agent clears its queue. UI also has **⟳ restart speaker** (kill+respawn librespot) and **⟳ restart agent** (wipe vibe / scorecard / buffers in place; WS stays connected).

## The agent's tool surface

All tools are registered as a single MCP server (`mcp__dj__*`) in [`packages/agent/src/chat-bin.ts`](packages/agent/src/chat-bin.ts).

### Pattern control
| Tool                     | What it does                                                                 |
|--------------------------|------------------------------------------------------------------------------|
| `set_pattern_slot`       | Edit ONE named slot. Other slots untouched. **Primary tool.**                |
| `clear_pattern_slot`     | Remove a slot from the running stack.                                        |
| `set_tempo`              | Global BPM. After first call, future calls clamp to ≤ 4 BPM jumps.            |
| `evaluate_strudel`       | Wipe all slots & hard-cut. Last resort.                                      |
| `stop` / `panic`         | Hush the runtime.                                                            |
| `current_slots`          | Return all slot names + code. **Called first every tick.**                   |
| `strudel_log`            | Pull recent Strudel-runtime log lines (compile errors, sample-load misses).  |

### Audio analysis
| Tool                  | What it does                                                                       |
|-----------------------|------------------------------------------------------------------------------------|
| `audio_features`      | Rolling-5s scalar summary: RMS, BPM, spectral centroid, low/mid/high energy, onsets/s. Per-stream. |
| `audio_spectrogram`   | Render last N seconds as a mel-spectrogram PNG. Returned as a vision-capable image. |
| `transport_state`     | Current bar/beat/BPM.                                                              |
| `last_track_request`  | Last URL the user dropped in chat.                                                 |

### Sampling
| Tool                  | What it does                                                                          |
|-----------------------|---------------------------------------------------------------------------------------|
| `record_sample`       | Snapshot last N seconds of a stream into a WAV, register under a name. Usable immediately as `s("name")`. |
| `list_samples`        | Names + durations of recorded samples.                                                |

### Spotify
| Tool                                | What it does                                                                 |
|-------------------------------------|------------------------------------------------------------------------------|
| `spotify_setup`                     | Run OAuth (PKCE). Opens browser, persists tokens to `~/.strudel-ai-dj/`.     |
| `spotify_status` / `spotify_devices` / `spotify_use_device` | Account + Connect device management.                                          |
| `spotify_search`                    | Free-text search → URIs.                                                     |
| `spotify_play` / `spotify_pause` / `spotify_resume` / `spotify_next` / `spotify_prev` / `spotify_queue` | Transport control.                              |
| `spotify_now_playing`               | Current track title/artist/position.                                         |
| `spotify_track_info`                | Full metadata for a track URI. **Primary tool for parsing a Spotify URL.**   |

### Night-mode control
| Tool                | What it does                                                                |
|---------------------|-----------------------------------------------------------------------------|
| `start_night`       | Start (or re-pace) the autonomous tick loop. `bars` argument sets cadence.  |
| `set_tick_rate`     | Change tick cadence while running.                                          |
| `tick_now`          | Trigger an immediate tick (chain decisions quickly).                        |
| `stop_night`        | End the loop.                                                               |
| `set_vibe`          | Lock the genre/mood/BPM range for the night. Re-injected every tick.        |
| `fetch_url`         | Generic web fetch (Wikipedia, lyrics, label notes). Capped 2/turn.          |
| `say`               | Emit a chat-visible string. Used sparingly — tool calls are streamed.       |

The full tool list with example arguments lives in [`docs/MCP-TOOLS.md`](docs/MCP-TOOLS.md).

## The slot model

A running Strudel pattern in this project is *always* of the form:

```js
stack(
  s("bd*4").gain(.9),                                     // ← "kick" slot
  s("~ oh ~ oh").gain(.5),                                // ← "oh" slot
  s("hh*16").gain(sine.range(.2,.5).slow(8)).pan(rand),   // ← "hh" slot
  note("c2*8").s("jvbass").lpf(sine.range(400,3000).slow(16)), // ← "bass" slot
  s("vocal_chop").slice(8, "0 ~ 3 ~ 5 ~ 2 ~").gain(.4),   // ← "fx" slot
)
```

The browser holds the slot-name → code map. Every `set_pattern_slot(slot, code)` updates one entry, then re-composes the full `stack(...)` and re-evaluates Strudel. Because the other slots' code strings are byte-identical, Strudel's cycle scheduler swaps the new pattern in at the next cycle boundary with no audible discontinuity.

The agent reuses stable slot names (`kick`, `snare`, `hh`, `oh`, `perc`, `bass`, `lead`, `pad`, `fx`, `vis`) so the running mix gradually evolves rather than restarting. Visuals attach via Strudel pattern decorators (`.scope()`, `.pianoroll()`, `.spiral()`, `.punchcard()`) on an audible slot — no Hydra in this build, since `@strudel/web` doesn't ship the Hydra integration.

## Spotify integration

There are two cooperating pieces:

1. **Spotify Web API** — for search, metadata, transport, devices. Requires a one-time OAuth flow.
2. **librespot virtual Connect device** — for raw PCM access without DRM-bypass shenanigans.

### Set up Spotify OAuth (one-time)

1. Create a developer app at <https://developer.spotify.com/dashboard>.
2. Add `http://127.0.0.1:7878/callback` as a redirect URI (exactly; `127.0.0.1` not `localhost`).
3. Copy the Client ID.
4. Export it before running:

   ```powershell
   # PowerShell, current session only
   $env:SPOTIFY_CLIENT_ID = "your-client-id-here"
   # Persist for new shells:
   [Environment]::SetEnvironmentVariable("SPOTIFY_CLIENT_ID", "your-client-id-here", "User")
   ```

5. `pnpm dev`, then in the chat panel: `spotify_setup`. A browser tab opens to Spotify's consent screen. Tokens persist to `~/.strudel-ai-dj/spotify.json`.

### Install librespot (one-time)

Pick one:

- **Cargo (if you have Rust):** `cargo install librespot --version 0.8.0 --locked` (older versions like 0.7.1 hit "context has no tracks" — pin 0.8.0).
- **Pre-built release:** download from <https://github.com/librespot-org/librespot/releases>, drop the binary at `./bin/librespot.exe` (Windows) or `./bin/librespot` (macOS / Linux), or set `LIBRESPOT_PATH=...`.

The agent process auto-spawns librespot with these flags:
```
librespot --name "Strudel AI DJ" --backend pipe --format S16
          --bitrate 320 --disable-gapless --zeroconf-port 53092
```

Once running, open Spotify on your phone/desktop, tap the **Connect to a device** icon, and pick **Strudel AI DJ**. Audio decodes inside librespot, streams stdout PCM to the Node host (paced in real time with backpressure), and feeds the `external` audio stream.

You hear *only Strudel*. Spotify is the agent's ears, not the audience's.

Full setup with troubleshooting: [`docs/SPOTIFY-SETUP.md`](docs/SPOTIFY-SETUP.md).

## Configuration

Environment variables read by the stack:

| Var                     | Default                    | What                                                                   |
|-------------------------|----------------------------|------------------------------------------------------------------------|
| `BRIDGE_PORT`           | `7777`                     | WebSocket port for the bridge                                          |
| `CLAUDE_MODEL`          | `claude-sonnet-4-6`        | Model used by the agent                                                |
| `ANTHROPIC_API_KEY`     | (use Claude Code login)    | Alternate auth path for the Claude Agent SDK                           |
| `SPOTIFY_CLIENT_ID`     | (unset)                    | Required for Spotify Web API. Get from Spotify dev dashboard.          |
| `LIBRESPOT_PATH`        | `./bin/librespot[.exe]` or PATH | Path to librespot binary                                          |
| `LIBRESPOT_DEVICE_NAME` | `Strudel AI DJ`            | Connect device name (use unique per machine)                           |
| `VITE_SPOTIFY_CLIENT_ID`| (unset)                    | Same client id, exposed to browser via Vite — for in-browser flows     |
| `VITE_YOUTUBE_API_KEY`  | (unset)                    | YouTube Data API key (for the youtube provider)                        |

Per-app `.env.local` works for the Vite-prefixed ones. The Node processes read `process.env` directly — set them in your shell before `pnpm dev`.

## Development

```bash
# Everything in one shot (concurrent processes, color-tagged output):
pnpm dev

# Or individually, in separate terminals:
pnpm dev:bridge      # WS hub
pnpm dev:agent       # Claude Agent SDK + librespot host
pnpm dev:console     # Vite dev server
pnpm dev:mcp         # MCP stdio server (only useful when Claude Desktop spawns it)

# Without the agent (useful when poking at the browser or bridge in isolation):
pnpm dev:noagent
```

> **Why `tsx` and not `tsx watch` for the agent?** Under `concurrently` + `tsx watch` on Windows, the Anthropic SDK's import path hangs. Plain `tsx` works reliably. Trade-off: you must Ctrl+C and restart `pnpm dev` (or just the agent terminal) to pick up `chat-bin.ts` / `system-prompt.ts` changes. The UI **⟳ restart agent** button only wipes in-memory state — it does NOT reload code.

```bash
pnpm typecheck       # tsc across all packages
pnpm build           # tsc → dist/ for all packages
pnpm format          # prettier
pnpm lint            # placeholder (eslint integration is TODO)
```

### Adding a new agent tool

1. Define it in `packages/agent/src/chat-bin.ts` inside `createSdkMcpServer({ tools: [...] })`.
2. Add the `mcp__dj__<name>` entry to `ALLOWED_TOOLS`.
3. Mention it in the `SLOT_GUIDANCE` system prompt so the agent knows it exists.
4. If it sends/receives over the bridge, add the message types to `packages/dj-core/src/types/bridge.ts` and add routing to `packages/bridge/src/ws-server.ts`.
5. Restart the agent terminal.

### Adding a bridge message type

Two-file change: add the discriminated-union variant in `packages/dj-core/src/types/bridge.ts`, then teach `packages/bridge/src/ws-server.ts` who should receive it (broadcast / `sendToRole('controller')` / `sendToRole('console')`).

## Troubleshooting

| Symptom                                                                 | Likely cause / fix                                                                                                                              |
|-------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| Bridge indicator is red                                                 | The bridge process isn't running. Check the `pnpm dev` terminal for a `[bridge] listening on ws://localhost:7777` line.                          |
| Strudel REPL stuck on "loading"                                         | First-run prebake is downloading the dirt-samples pack (~10s). After that, refresh.                                                              |
| `sound bd not found`                                                    | The prebake `samples('github:tidalcycles/dirt-samples')` didn't run. Refresh the page; if persistent, check the browser console for fetch errors.|
| Agent ignores everything after the first message                        | The SDK's `query()` is busy. Either wait for the current turn (the chat will say "queued"), or click **⟳ restart agent**.                         |
| Spotify "Strudel AI DJ" device doesn't appear                           | librespot version too old, wait 10s after start, check for mDNS-blocking VPN/firewall. Confirm Premium account (free can't push to Connect).     |
| Tracks skip / cut out in librespot                                      | Old librespot version (0.7.x). `cargo install librespot --version 0.8.0 --locked --force`.                                                       |
| Spotify OAuth callback shows "client_id Not present"                    | On Windows, `cmd /c start <url>` truncates at `&`. The OAuth flow handles this — make sure you're on a recent commit (uses `rundll32`).         |
| `audio_features` returns `null` even though Spotify is playing          | Either Spotify isn't targeting **Strudel AI DJ** (check the Connect picker) or the agent process needs a restart (state is wiped).               |
| Agent emits `Read`, `Grep`, `Bash` tool calls in chat                   | Should be filtered. If still showing, check `summarizeToolCall` in `chat-bin.ts` — the whitelist is `name.startsWith('mcp__dj__')`.              |
| Hydra visual didn't work                                                | `@strudel/web` doesn't load Hydra. The agent's vocabulary forbids it; use `.scope()`, `.pianoroll()`, `.spiral()`, `.punchcard()` instead.       |

## Status & roadmap

**Done (v0.1 in main):**
- Bridge + dj-console + Strudel REPL with slot-based composition
- Claude Agent SDK runtime, night-tick loop, persistent vibe, self-evaluation scorecard
- librespot virtual Spotify Connect device with real-time-paced PCM consumer
- Web API integration: search, transport, devices, track metadata
- In-memory sample server + record-from-stream + slot reference
- Mel-spectrogram tool (returns PNG to Claude's vision)
- UI restart buttons (agent + speaker) with in-place state wipe
- MCP server for Claude Desktop integration

**Next:**
- `docs_lookup` sub-agent so `fetch_url` doesn't pollute the main agent's context
- Hard-rejection in the tool layer (e.g. `record_sample` refuses names whose base matches one recorded < 8s ago; `set_tempo` clamps to ±4 BPM unless `force=true`)
- Optional Hydra wiring via `<script src="https://unpkg.com/hydra-synth">` in `index.html`
- YouTube provider parity with Spotify
- Persistent session log (write the slot history + sample library to disk)

**Won't:**
- Public livestream / broadcast features
- Any DRM-circumvention path
- Persistent capture of input audio

## Legal

This is a **personal, non-commercial** live-coding instrument. The Spotify Web API is used in read-mode-only ways that fall within Spotify's [endorsed DJ-style integration](https://support.spotify.com/us/article/dj-integration/). librespot is an open-source Spotify Connect implementation; it does not bypass DRM.

System audio captured via the browser's `getDisplayMedia` API and librespot's stdout PCM both flow into RAM-only ring buffers. **Nothing is persisted to disk by this app** unless you explicitly call `record_sample`, in which case the WAV lives at `http://127.0.0.1:7779/samples/<name>.wav` for the lifetime of the process and is not written to disk.

The agent runtime sends prompts to Anthropic's Claude API: tick context (transport state, audio feature *numbers*, pattern code, recent chat, spectrogram PNGs). It does **not** send raw audio.

Full notes: [`docs/LEGAL.md`](docs/LEGAL.md).

## License

AGPL-3.0-or-later, inherited from Strudel. See [`LICENSE`](LICENSE). If you modify and run this code as a network service, you must make your modifications source-available under AGPL-3.0.

---

## Acknowledgements

- [Strudel](https://strudel.cc) — the live-coding music language this is built on (AGPL-3.0)
- [librespot](https://github.com/librespot-org/librespot) — open-source Spotify Connect
- [Claude Agent SDK](https://github.com/anthropics/anthropic-sdk-typescript) — the agent runtime
- [TidalCycles dirt-samples](https://github.com/tidalcycles/dirt-samples) — the sample pack that backs `bd`, `hh`, `sd`, etc.
