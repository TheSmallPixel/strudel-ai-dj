# Architecture

A short tour of how the parts fit together at runtime.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Browser (Chromium)                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ apps/dj-console (React + Vite)                                      │    │
│  │  - Strudel REPL (via @strudel/web)                                  │    │
│  │  - Chat panel (drag-drop URLs / images)                             │    │
│  │  - Audio capture: getDisplayMedia → system stream                   │    │
│  │  - Audio capture: AudioWorklet sidechain → strudel stream           │    │
│  │  - Transport bar, audio meters, feedback hotkeys                    │    │
│  └─────────────────────┬───────────────────────────────────────────────┘    │
│                        │ WebSocket (BridgeMessage protocol)                  │
└────────────────────────┼─────────────────────────────────────────────────────┘
                         │
                         ▼  ws://localhost:7777
┌─────────────────────────────────────────────────────────────────────────────┐
│ Node.js host                                                                 │
│                                                                              │
│  ┌─ packages/bridge (BridgeServer) ───────────────────────────────────┐      │
│  │  - WebSocket hub (role-aware: 'controller' | 'console')            │      │
│  │  - StateStore: transport, pattern, audio per-stream, queues        │      │
│  │  - Forwards messages between console and controllers               │      │
│  └────────────┬─────────────────────────────────┬──────────────────────┘     │
│               │                                 │                            │
│               ▼ (in-process)                    ▼ (separate process)         │
│  ┌─ packages/agent ────────────────┐  ┌─ packages/mcp-server ────────┐      │
│  │  AgentRuntime                   │  │  Stdio MCP server             │      │
│  │   - Claude Agent SDK            │  │   - All tools defined         │      │
│  │   - subscription OR api-key     │  │   - BridgeClient connects     │      │
│  │  NightMode                      │  │     to bridge via WS          │      │
│  │   - per-tick perceive→decide    │  │   - Used by Claude Desktop    │      │
│  │     →act→journal loop           │  │     (or any external MCP      │      │
│  │  buildTickContext flattens      │  │     client) on stdio          │      │
│  │  StateStore + scheduler state   │  │                               │      │
│  │  into a prompt-ready string     │  │                               │      │
│  └─────────────────────────────────┘  └───────────────────────────────┘      │
│                                                                              │
│  ┌─ packages/scheduler ──────────────────────────────────────────────┐      │
│  │  BarClock (wall-clock-driven, overridable by Strudel transport)   │      │
│  │  CallbackRegistry (in_bars / at_bar / in_minutes / recurring)     │      │
│  │  EventBus (audio events, user events)                             │      │
│  │  Scheduler (60s watchdog re-fire)                                 │      │
│  └───────────────────────────────────────────────────────────────────┘      │
│                                                                              │
│  ┌─ packages/providers/{spotify,youtube,generic} ────────────────────┐     │
│  │  Pluggable metadata: nowPlaying, analysis, search                 │     │
│  └───────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Process topology

In normal `pnpm dev` operation:

- **`dev:bridge`** — runs `packages/bridge/src/bin.ts`. Owns the WebSocket hub and StateStore. Long-lived.
- **`dev:mcp`** — runs `packages/mcp-server/src/bin.ts`. Stdio MCP server. In `pnpm dev` this prints `[mcp-server] ready on stdio` and waits; it's mostly useful when Claude Desktop spawns it as a subprocess (with stdio piped). The bridge connection is the WS path between MCP tool calls and the running Strudel.
- **`dev:console`** — Vite dev server at `:5173`. The browser app.

When Claude Desktop is configured per `docs/SETUP.md`, it spawns its OWN mcp-server process, separately from `pnpm dev`'s. Both processes connect to the same bridge.

## Data flow examples

### "Play a 4-on-the-floor at 124 BPM" (chat in browser)

```
Browser ChatPanel
  → BridgeMessage {type:'chat.message', message:{role:'user', text:...}}
  → BridgeServer.state.pushChat()
  → on next scheduler tick, agent picks up chatQueue
  → AgentRuntime.turn() → Claude Agent SDK → tool calls
  → tool dispatch in MCP server emits BridgeMessage {type:'pattern.evaluate', code}
  → BridgeServer routes to role='console' (the browser)
  → StrudelPanel.useEffect sees pattern.evaluate → window.strudel.evaluate(code)
  → Strudel synthesizes audio
  → AudioWorklet tap → BrowserAudioPipeline.pushChunk()
  → BridgeMessage {type:'audio.features', features:{stream:'strudel', ...}}
  → BridgeServer.state.audio.strudel = features
  → next tick sees the agent's own output in audioStrudel
```

### "Sync to Spotify track"

```
SpotifyProvider.nowPlaying() returns ProviderNowPlaying
  → buildTickContext puts it in ctx.provider.nowPlaying
  → Agent reads in tick prompt: "Spotify track at 128.0 BPM, key A minor"
  → tool call: set_tempo(128)
  → BridgeMessage {type:'pattern.set_tempo', bpm:128}
  → browser updates Strudel CPS
  → agent now writes a pattern at the matched BPM
  → audio.features("external") = system - strudel
    → agent can reason about how its layer relates to the Spotify track
```

## Why a separate bridge?

Three reasons:

1. **Decouples MCP-over-stdio from the browser.** Claude Desktop launches the MCP server with piped stdio; that process can't open a browser window. The bridge gives MCP a path *to* the browser.
2. **One source of truth for state.** Agent runtime, MCP tools, and the browser all read/write through `BridgeServer.state`. No drift.
3. **Multiple controllers can coexist.** The embedded agent and Claude Desktop can both drive the same DJ session. (Mostly useful for debugging; in normal use it's just one.)

## What lives where

| Concern | Package |
|---|---|
| Shared types, constants, DJ helpers | `dj-core` |
| Bar clock, callbacks, events | `scheduler` |
| WebSocket + state store | `bridge` |
| MCP tool surface (stdio) | `mcp-server` |
| Claude SDK runtime + night-mode loop | `agent` |
| DSP, feature extraction, spectrogram, AudioWorklet source | `audio-input` |
| Spotify OAuth + Web API | `providers/spotify` |
| YouTube Data API | `providers/youtube` |
| Null fallback provider | `providers/generic` |
| Browser app (React, Vite) | `apps/dj-console` |
| Upstream Strudel monorepo (subtree) | `apps/strudel-dj` |
