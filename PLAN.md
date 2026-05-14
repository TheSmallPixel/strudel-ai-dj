# Strudel AI DJ — Plan

A live-coding DJ that an LLM controls in real time. Strudel does the
synthesis and pattern playback; an embedded agent (and/or external MCP
clients like Claude Desktop) plans the set, listens to the audio
environment, and writes patterns on phrase boundaries. The agent runs
autonomously across a "night" — perceiving the room, planning an arc,
acting on scheduled callbacks.

## Vision

> Open the app. Click *Start the night*. For the next three hours the
> agent plays. Drop in a Spotify track and Strudel mixes around it.
> Type *"more breakbeat"* in chat and the next phrase reflects it.
> Tap a panic key and everything stops. The agent listens to whatever
> is coming out of your speakers — Spotify, YouTube, vinyl, your DAW
> — and improvises in real time.

## Core design decisions (locked from planning conversation)

1. **All external audio enters through one path: system-audio loopback.**
   Spotify, YouTube, Bandcamp, your DAW, vinyl-through-line-in — all
   identical to Strudel: a RAM ring buffer with real-time feature
   extraction. No audio is ever written to disk.
2. **Metadata is a separate, optional, pluggable layer.** Provider
   plugins (`providers/spotify`, `providers/youtube`, …) can supply
   "currently playing track + beat grid + key + sections" if the user
   authorizes the provider. Without metadata, the agent falls back to
   real-time audio analysis. The system degrades gracefully.
3. **Agent runtime = Claude Agent SDK.** The Strudel-DJ app embeds a
   chat panel; the agent runtime wraps the **Claude Agent SDK**
   (`@anthropic-ai/claude-agent-sdk`), which authenticates against
   *either* the user's Claude Code subscription (Pro/Max) *or* a raw
   Anthropic API key. **Default: subscription mode** (no per-token
   billing, uses the user's existing Claude plan). User can switch to
   API-key mode at any time. This gives us sub-agents, MCP transport,
   permission gates, streaming, and conversation memory for free.
   External MCP clients (Claude Desktop) can also hit the same MCP
   server when desired; the tool surface is identical.
4. **Time is bar-quantized, not seconds.** Scheduled callbacks are
   expressed in bars and phrases (`in 16 bars`, `at next 32-bar
   boundary`, `on section change`). The scheduler holds the bar clock;
   the agent gets called back on musical events, not wall-clock ticks.
5. **The agent has a long horizon.** A *Set Plan* — target BPM/energy
   curve, mood arc, key plan — is generated at the start of the night
   and revised in place. Each tick reconciles current state against the
   plan rather than reacting blindly.

## Architecture

```
                          ┌────────────────────────────────────────┐
                          │       Strudel-DJ Web App (browser)     │
                          │                                        │
   external MCP clients   │   ┌──────────┐  ┌──────────────────┐   │
   (Claude Desktop /      │   │ Chat UI  │  │  Strudel REPL    │   │
    Claude Code)          │   └──────────┘  └──────────────────┘   │
            │             │        │              │                │
            │             │        ▼              ▼                │
            │             │   ┌──────────────────────────────────┐ │
            │             │   │  Web Audio engine + loopback     │ │
            │             │   │  ring buffer + feature extractor │ │
            │             │   └──────────────────────────────────┘ │
            │             └──────────────────┬─────────────────────┘
            │                                │  WebSocket
            ▼                                ▼
       ┌──────────────────────────────────────────────────────────────┐
       │   Core runtime (Node)                                        │
       │                                                              │
       │   ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
       │   │ MCP server  │  │   Agent      │  │   Scheduler        │  │
       │   │ (stdio,     │  │   runtime    │  │   (bar clock +     │  │
       │   │  optional)  │  │  (Claude     │  │   callback registry│  │
       │   │             │  │   Agent SDK) │  │   + event bus)     │  │
       │   └──────┬──────┘  └──────┬───────┘  └─────────┬──────────┘  │
       │          └──────────┬─────┴────────────────────┘             │
       │                     ▼  shared tool router                    │
       │   ┌─────────────────────────────────────────────────────┐    │
       │   │  Tool surface                                       │    │
       │   │  evaluate_strudel, set_tempo, audio.features,       │    │
       │   │  provider.now_playing, schedule.in_bars,            │    │
       │   │  dj.transition, night.start, …                      │    │
       │   └─────────────────────────────────────────────────────┘    │
       │                     │                                        │
       │     ┌───────────────┼────────────────┐                       │
       │     ▼               ▼                ▼                       │
       │ ┌────────┐    ┌──────────────┐  ┌────────────────┐           │
       │ │ Bridge │    │  Providers   │  │  State store   │           │
       │ │ (WS to │    │  spotify /   │  │ (set plan,     │           │
       │ │browser)│    │  youtube /…  │  │  vibe journal) │           │
       │ └────────┘    └──────────────┘  └────────────────┘           │
       └──────────────────────────────────────────────────────────────┘
```

## Repo layout

pnpm workspaces monorepo:

```
strudel-ai-dj/
├─ apps/
│  └─ strudel-dj/              # Forked Strudel + chat UI + audio engine
│                              # (git subtree of codeberg.org/uzu/strudel)
├─ packages/
│  ├─ mcp-server/              # Stdio MCP server (for external clients)
│  ├─ agent/                   # Claude-Agent-SDK runtime, embedded mode
│  ├─ scheduler/               # Bar clock, callback registry, event bus
│  ├─ bridge/                  # WebSocket hub between core runtime & browser
│  ├─ providers/               # Pluggable metadata providers
│  │  ├─ spotify/              # OAuth + Web API (read-only metadata)
│  │  ├─ youtube/              # Data API + best-effort title parsing
│  │  └─ generic/              # No-metadata fallback (audio-only)
│  ├─ audio-input/             # Loopback capture, ring buffer, feature extract
│  └─ dj-core/                 # Set plan, energy model, transition primitives
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ MCP-TOOLS.md
│  ├─ AGENT-LOGIC.md
│  └─ LEGAL.md
├─ .github/workflows/
├─ pnpm-workspace.yaml
├─ package.json
├─ PLAN.md
├─ README.md
└─ LICENSE                     # AGPL-3.0 (inherited from Strudel)
```

## License

AGPL-3.0, inherited from Strudel. Whole repo source-available under it.

## Strudel fork strategy

`git subtree` of `https://codeberg.org/uzu/strudel` into `apps/strudel-dj`.
Single-repo dev experience; `git subtree pull` pulls upstream updates.

## Phases

### M0 — Scaffold + fork
- pnpm workspace, root `package.json`, AGPL license, CI (lint/typecheck)
- `git subtree add` Strudel into `apps/strudel-dj`
- Empty package skeletons

### M1 — MCP↔Strudel minimum loop
- Bridge WS server, in-memory state
- MCP server (stdio) with `evaluate_strudel`, `set_tempo`, `get_state`, `stop`
- Strudel-DJ app: WS client wired into REPL eval pipeline
- **Acceptance:** Claude Desktop drives audible Strudel patterns.

### M2 — Audio input + features (the foundation, replaces old M2+M3)
Three parallel feature pipelines, RAM-only ring buffers, **no
audio persisted to disk by the app**:
- **Strudel-output tap** — `AnalyserNode` + `AudioWorklet` on
  Strudel's master output, *before* audio leaves the browser.
  Sidechain branch — must not affect Strudel's actual playback. This
  is how the agent *hears what it is making.*
- **System loopback** via `getDisplayMedia({audio:true})` on Chromium;
  native helper (Tauri sidecar) as fallback for Windows reliability.
- Derived **external** stream = system − strudel (best-effort), so the
  agent can reason about the external source alone.
- Feature extraction (onset, RMS, spectral centroid, real-time tempo
  estimate, key estimate) runs on every stream.
- Exposed as Strudel signal sources and as MCP tools:
  `audio.features("strudel" | "system" | "external")` — small JSON
  blob (RMS, spectral centroid, onsets, tempo/key estimate, band
  energies), always-on, cheap.
- **On-demand vision tool:** `audio.spectrogram(stream, seconds)`
  renders the last N seconds as a mel-spectrogram PNG. Claude reads it
  as an image when numeric features are ambiguous. Not called every
  tick (expensive); the agent calls it when curious or for transitions.
- **Acceptance:** play audio in another app while Strudel runs; agent
  distinguishes what *it* is making from what *else* is playing.
  Calling `audio.spectrogram("strudel", 8)` returns a recognizable
  mel-spectrogram of the last 8 seconds of Strudel output.

### M3 — Provider metadata layer
- Plugin interface: `Provider.nowPlaying()`, `Provider.analysis(uri)`,
  `Provider.search(query)`. Plugins can opt out of any method.
- First plugins:
  - **spotify** — OAuth PKCE, `/me/player/currently-playing`,
    `/audio-analysis/{id}`, `/audio-features/{id}` (read-only)
  - **youtube** — Data API + URL/title heuristics
  - **generic** — null implementation, fall back to `audio.features`
- Unified MCP surface: `provider.now_playing()`, `provider.analysis()`,
  `provider.list()` (which providers are connected)
- **Acceptance:** with Spotify connected and playing, agent knows the
  track + beat grid; with no provider, falls back gracefully.

### M4 — Embedded UI + agent runtime + scheduler
- Chat panel in the Strudel-DJ app with rich input affordances
  (drag-drop URLs, quick-reaction buttons, bookmark hotkey — see
  *Feedback channels* below)
- Agent runtime wraps Claude Agent SDK; auth mode (subscription vs API
  key) is a config setting. Conversation memory handled by SDK.
- Bar-quantized scheduler:
  - `schedule.in_bars(n, prompt | tool_call)`
  - `schedule.at_bar(n, …)`
  - `schedule.in_minutes(n, …)`
  - `schedule.on_event(kind, …)`
  - `schedule.list()` / `schedule.cancel(id)`
- **Acceptance:** chat with the agent in the app; agent registers
  "in 16 bars write a new hi-hat layer" and it fires on the bar.

### M5 — DJ primitives
- `dj.transition`, `dj.layer_in`, `dj.drop`, `dj.queue`
- Composed from M1–M4 primitives, internally emit lower-level tool calls
- **Acceptance:** "transition to a darker key over 16 bars" produces a
  recognizable, bar-aligned transition.

### M6 — Night mode (the autonomous agent)
- `night.start(duration, vibe, constraints)` — see Agent Logic below
- `night.stop`, `night.set_phase`, `night.vibe_journal`
- **Acceptance:** click *Start the night*; agent runs for the configured
  duration, handling perceive → decide → act → schedule on its own.

### Stretch
- Multi-deck crossfade (Strudel decks A/B)
- Freesound sample loader (`samples.search`, `samples.load_to_slot`)
- MIDI controller (hardware triggers for prepared patterns)
- Visualizer driven by transport + features
- Record Strudel-only stem to disk (synthesis output, never input audio)
- More providers: SoundCloud, Bandcamp, Apple Music, Tidal

## Feedback channels (the chat panel UX)

The chat panel is a wide-bandwidth input surface, not just a textbox.
Every user gesture maps to a tool call or an event the agent reads on
its next tick.

### Track requests
- **Drag-drop** a Spotify / YouTube / Bandcamp URL (or a local audio
  file) into the chat. UI prompts for *when* and *intent*.
- **Inline text** ("play this in a bit", "drop this at the peak",
  "skip current, this next") is parsed into the same fields.
- Tool: `night.request_track(uri, when, intent)` where
  - `when ∈ "now" | "next" | "next_phase" | "at_peak" | "bar:N"`
  - `intent ∈ "play_through" | "transition_into" | "sample_from"`

### Style feedback (textual, free-form)
- Free text in chat: "more breakbeat", "less ambient", "darker",
  "more upfront drums".
- Tool: `night.style_feedback(message)`. Agent integrates into the
  vibe journal and possibly revises the set plan.

### Realtime reactions (quick buttons + hotkeys) — v0.1 minimal set

| Button / hotkey | Meaning                           | Tool                       |
|-----------------|-----------------------------------|----------------------------|
| 👍 / `+`        | Working, keep going               | `feedback.signal("up")`    |
| 👎 / `-`        | Not working, change direction     | `feedback.signal("down")`  |
| ⏸ / `space`     | Panic / hush                      | `hush()`                   |

Every `feedback.signal` writes a timestamped entry into the vibe
journal with the bar number and current pattern. The agent reads recent
signals on each tick — a 👍 right after a change is high-confidence
positive training signal.

Deferred to post-v0.1: 🔥 ❄️ 📌 ❓ as additional reactions, and voice
input (push-to-talk → STT), once the core loop is proven.

### Bookmarks (save / recall a moment)
- `night.bookmark(label?)` snapshots: current pattern, BPM, key,
  transport, optional current track URI, vibe-journal pointer.
- `night.recall(label)` re-evaluates the pattern and asks the agent to
  re-create that vibe (with awareness of the current phase).
- UI: a side list of bookmarks with thumbnails (waveform snippet).

### "Why?" / "What are you doing?"
- Inline `?` link on every agent action rendered in chat history opens
  the vibe-journal entry for that decision (reason + state snapshot).
- `night.explain_last()` is the equivalent tool, also usable from chat
  ("why?" returns the reasoning for the last decision).

## Agent logic for the night

### Self-perception (closing the loop)

The agent perceives its own output through three complementary channels,
so it can ask "what did I just make?" and "did it land?" without
confusing its own output with the external source.

1. **Strudel-output audio features** — `audio.features("strudel")`.
   Sidechain tap on Strudel's Web Audio master. Isolated from external
   audio.
2. **Pattern introspection** — `strudel.introspect()` returns scheduled
   events for the next N bars, active layer count, note density per
   bar, predicted frequency content from current synth patches. The
   agent reading its own code, structurally.
3. **External-audio diff** — `audio.features("external")` = system
   loopback minus strudel-tap. What the room (Spotify, YouTube, vinyl)
   is doing, with Strudel's own contribution subtracted.
4. **Mel-spectrogram (on demand)** — `audio.spectrogram(stream, secs)`
   returns a PNG of the last N seconds. Claude has vision; for
   ambiguous moments the agent can *see* the audio (kick lines, hi-hat
   density, drops). Expensive — called sparingly.

The numeric features answer "what's happening?" cheaply every tick. The
spectrogram answers "what does it actually look like?" when the agent
wants a deeper read. Claude cannot ingest raw audio directly, so an
analyzer always sits between buffer and tick context.

Each tick's `TickContext` contains all three. Vibe-journal entries get
richer: "bar 64: brought in hats — strudel RMS +12%, centroid +1.8
kHz, external unchanged → my change registered, room didn't shift."

Feedback runaway is prevented by the bar-quantized scheduler: the agent
ticks on phrase boundaries (8/16/32 bars), so it sees aggregated
features over a stable window, not instantaneous reactions.

### Three operating modes

| Mode          | Who picks audio source | Who writes patterns | Who decides transitions |
|---------------|------------------------|---------------------|-------------------------|
| **Autonomous**| Agent                  | Agent               | Agent                   |
| **Co-pilot**  | Human                  | Agent               | Agent                   |
| **Chat**      | Human                  | Agent on request    | Agent on request        |

Autonomous mode *is* "the night." The others are subsets of its
machinery — same scheduler, same tools, less initiative.

### Lifecycle of an autonomous night

#### 1. Open ceremony (once, at `night.start`)
Inputs from the human: duration (e.g. 180 min), seed vibe
(`"warm liquid DnB → peak time → ambient comedown"`), constraints
(key preferences, BPM range, banned moves, energy ceiling).

The agent then:
- Generates a **Set Plan**: an ordered list of phases, each with
  target BPM range, target energy, key plan, mood, expected duration.
  Stored in state.
- Generates an **Opening Pattern** (Strudel code) for phase 1.
- Registers initial callbacks:
  - `schedule.in_bars(32, "review")` — recurring self-check
  - `schedule.on_event("section_boundary", "check sync")`
  - `schedule.on_event("silence_3s", "fill gap")`
  - `schedule.at_phase_boundary("transition to next phase")`

#### 2. Tick loop (every callback fires this shape)

```
async function tick(reason: string, ctx: TickContext) {
  const state = {
    plan:           getSetPlan(),
    phase:          getCurrentPhase(),
    transport:      getTransport(),         // bar, beat, set_elapsed
    strudel:        getCurrentPattern(),
    introspect:     strudelIntrospect(8),   // events scheduled next 8 bars
    audioStrudel:   getAudioFeatures("strudel"),   // what I'm making
    audioSystem:    getAudioFeatures("system"),    // everything mixed
    audioExternal:  getAudioFeatures("external"),  // system - strudel
    provider:       getNowPlaying(),        // optional metadata
    energyRecent:   getEnergyHistory(30_000),
    vibeJournal:    getVibeJournal(20),     // last 20 decisions
  };

  // LLM call
  const decision = await agent.complete({
    system: NIGHT_SYSTEM_PROMPT,
    state, reason,
    tools: ALL_TOOLS,
  });

  // Tool calls in `decision` execute (mutations + scheduling next wakes)
}
```

#### 3. System prompt — encodes DJ craft

- Never change pattern mid-phrase. Phrase boundary = current bar mod
  {8, 16, 32} == 0 depending on phase intensity.
- Move energy gradually. No more than ±10 BPM step without an explicit
  transition.
- Respect key relationships. Modulate by P4/P5 or relative minor/major.
- Listen first. If audio features show the room (or external track)
  hasn't responded to the last change, hold — don't pile on.
- Drops earn their place. Build for ≥32 bars before any drop.
- Sync, then improvise. If provider metadata is available, lock to its
  beat grid before improvising on top.

#### 4. Event-driven callbacks (what wakes the agent)

- **Time-based:** `at_bar(N)`, `in_bars(N)`, `in_minutes(N)`,
  `at_phase_boundary`
- **Audio events:** `on_silence(duration_ms)`, `on_onset_burst`,
  `on_energy_drop`, `on_loud_transient` (clip warning)
- **Provider events:** `on_track_change`, `on_track_section_change`,
  `on_track_ending` (last 30s of current track)
- **User events:** chat message arrived, `feedback.signal` fired
  (`up`/`down`/`more`/`less`), track requested, bookmark saved/recalled,
  panic pressed

Every callback carries a `reason` string so the LLM knows why it woke.

#### 5. State the agent owns

- `set_plan` — phases with targets, mutable mid-night
- `vibe_journal` — short log of decisions ("bar 64: brought in hats,
  energy +; bar 96: tried key shift, room flat, reverted"). The agent's
  working memory across the night.
- `current_phase`, `current_pattern`, `current_bpm`, `current_key`
- `pending_callbacks` — what's scheduled and why

#### 6. Failsafes

- **Watchdog.** If no tick fired in 60s of wall-clock, scheduler self-
  tests and re-registers a default tick.
- **Panic.** Human hotkey → `hush()` instantly; agent gets a "user
  panic" event and pauses until restarted.
- **Cost cap.** Agent runtime tracks token spend; hard cap per night,
  warnings at 50/75/90%.
- **Rate limit.** Agent cannot emit more than N tool calls per bar.
  Forces musical-time-aligned behavior, prevents runaway loops.
- **Single-active-tab.** Bridge rejects a second Strudel-DJ tab to
  prevent split-brain.

### Cost model (rough order)

Two backends, user picks at config:

**Subscription mode (Claude Pro / Max via Claude Agent SDK):**
- No per-token cost; constrained by 5-hour rolling rate limits
- Pro plan likely insufficient for a full 3-hour autonomous night on
  Sonnet — surface a soft warning at 75% of the limit and degrade to
  Haiku automatically in cruise phases
- Max plan has substantially more headroom

**API key mode:**
- Tick every 32 bars at 128 BPM ≈ once per ~60s
- Each tick: ~3K in / ~500 out tokens
- Sonnet 4.6 default for transitions; Haiku 4.5 for cruise
- 3-hour night ≈ 180 ticks ≈ ~$2–4 mixed model, less Haiku-heavy
- Event-driven extra ticks add ~50% on top

Cost-cap hooks (built into the SDK) hard-stop at a configured budget
regardless of mode.

### Open questions for night mode
- Should the agent revise its own set plan mid-night, or freeze at open?
- How much history per tick? Last N decisions vs full vibe journal vs
  rolling summary. Compaction needed at long durations.
- Per-phase model swap? Haiku for cruise, Sonnet for transitions?
- "Audience" feedback: a `+`/`-` hotkey the human taps when something
  lands or flops, agent reads it as ground-truth signal.

## MCP tool surface (consolidated)

| Group       | Tools                                                            |
|-------------|------------------------------------------------------------------|
| Strudel     | `evaluate_strudel`, `set_tempo`, `get_state`, `stop`,            |
|             | `strudel.introspect`                                             |
| Audio       | `audio.start_input`, `audio.features("strudel"\|"system"\|         |
|             | "external")`, `audio.on_onset`, `audio.spectrogram(stream, secs)`|
| Providers   | `provider.list`, `provider.now_playing`, `provider.analysis`,    |
|             | `provider.search`                                                |
| Scheduler   | `schedule.in_bars`, `schedule.at_bar`, `schedule.in_minutes`,    |
|             | `schedule.on_event`, `schedule.list`, `schedule.cancel`          |
| DJ          | `dj.transition`, `dj.layer_in`, `dj.drop`, `dj.queue`            |
| Night       | `night.start`, `night.stop`, `night.set_phase`,                  |
|             | `night.vibe_journal`, `night.revise_plan`                        |
| Requests    | `night.request_track`, `night.style_feedback`                    |
| Feedback    | `feedback.signal` (up/down/more/less)                            |
| Memory      | `night.bookmark`, `night.recall`, `night.explain_last`           |

## Legal posture (`docs/LEGAL.md`)

- **Use case:** personal, non-commercial live coding alongside legally
  accessible audio sources.
- **Spotify:** read-only Web API for metadata (when the spotify provider
  is connected). No bypassing of any protection. Falls within Spotify's
  endorsed DJ-integration use (personal, non-commercial, online).
- **System audio input:** generic OS-level system-audio capture.
  Provider-agnostic. RAM-only ring buffer; **no audio persisted to
  disk** by the app. Only derived numerical features ever leave the
  buffer.
- **Strudel-output tap:** in-browser sidechain on Strudel's own Web
  Audio output. The agent listens to what it is producing.
- **No public-performance, livestream, or commercial features.**
- Strudel's *own synthesis output* may be recorded by the user — that's
  the user's own composition.

## Risks

- Bar-clock drift between Strudel and external audio in audio-only mode
  (no metadata). Real-time tempo estimation must be solid; consider
  particle-filter beat tracker.
- LLM latency vs phrase boundary. Mitigation: agent pre-decides one
  phrase ahead and queues the next pattern; tick on the actual
  boundary just commits the pre-decision.
- Claude Pro 5-hour rate limits on long autonomous nights — degrade to
  Haiku, warn at 75%, allow seamless switch to API-key mode mid-night.
- Loopback capture UX in browser. `getDisplayMedia` is the Chromium
  path; user has to pick the right source. Native helper if needed.
- Provider OAuth in a web app. Tiny local callback server (`localhost:
  PORT/callback`) is the cleanest path.
- Strudel REPL API surface — needs M1 spike to confirm a clean
  eval-from-outside entry point exists.

## Definition of "done" for v0.1
1. Claude Desktop has the MCP server configured.
2. User opens Strudel-DJ in a browser and authorizes audio loopback.
3. User asks Claude in natural language to play patterns; Strudel
   responds in real time.
4. User starts a Spotify track; Strudel locks to it (via metadata if
   provider is connected, via real-time tempo estimation if not) and
   layers a pattern that stays on the beat.
5. `night.start` runs the autonomous loop for ≥30 min without
   intervention.
6. Nothing in the repo violates AGPL or Spotify ToS.

## Out of scope (explicit)
- Public livestreaming / broadcasting
- Multi-user collab sessions
- Mobile
- Any feature framed as "rip Spotify audio"
- DRM circumvention of any kind
- Persisting any input audio to disk
