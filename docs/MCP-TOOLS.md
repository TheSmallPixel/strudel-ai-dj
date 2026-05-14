# MCP tool reference

The `@strudel-ai-dj/mcp-server` package exposes these tools to any MCP client (Claude Desktop, Claude Code, the embedded agent). Tool names use underscores (`set_pattern_slot`) because MCP / JSON-RPC discourages dots in tool identifiers, but the plan documents them in the dotted form (`pattern.set_slot`) for readability.

## Strudel control

### `evaluate_strudel`
Replace the currently running pattern with new code.

```json
{ "code": "stack(s(\"bd*4\"), s(\"hh*8\").gain(0.5)).cpm(124)" }
```

Code may include audio (`note`, `s`, `stack`, `chord`) and visualizations (`.scope()`, `.pianoroll()`, `.spiral()`, `.punchcard()`, full `hydra(\`...\`)` blocks).

### `set_pattern_slot`
Edit one named layer (e.g. `"drums"`, `"bass"`, `"pads"`) without touching the rest of the pattern.

```json
{ "slot": "drums", "code": "s(\"bd*4, ~ ~ sd ~\")" }
```

### `set_tempo`
Set BPM, optionally ramping over a number of bars.

```json
{ "bpm": 128, "rampBars": 8 }
```

Hard rule: don't step more than ±10 BPM without a ramp.

### `stop` / `panic`
`stop` is a normal hush; `panic` is for emergency. Both silence Strudel immediately.

## Listening

### `get_state`
Returns the current pattern, transport (bar, beat, BPM), and full introspection in one shot.

### `strudel_introspect`
Reads the running pattern structurally. Returns scheduled events for the next N bars, active layer count, note density, predicted band energy.

```json
{ "bars": 8 }
```

### `audio_features`
Current real-time features for a stream.

```json
{ "stream": "strudel" }
```

`stream`: one of `"strudel"` (own output), `"system"` (system loopback — Spotify, YouTube, DAW, whatever is mixed at OS level), `"external"` (= system minus strudel; what's playing alongside).

Returns `{ rms, peak, spectralCentroidHz, onsetDensityPerSec, tempoEstimateBpm, lowEnergy, midEnergy, highEnergy, ... }`.

### `audio_spectrogram`
Renders the last N seconds of a stream as a mel-spectrogram PNG and returns it as a base64 image. Claude has vision; use this when numeric features are ambiguous.

```json
{ "stream": "strudel", "seconds": 8 }
```

Expensive — call sparingly, not every tick.

## Scheduling

The bar-quantized scheduler is how the agent wakes itself.

### `schedule_in_bars`
Fire a callback in N bars. Used for "review every 32 bars" patterns.

```json
{ "bars": 32, "reason": "regular review" }
```

### `schedule_at_bar`
Fire at an absolute bar number.

```json
{ "bar": 256, "reason": "transition to peak phase" }
```

### `schedule_in_minutes`
Fire in N minutes of wall-clock time.

```json
{ "minutes": 30, "reason": "advance to comedown phase" }
```

## Visuals

### `visuals_set_style`
Persistent free-text style direction the agent honors when writing future patterns.

```json
{ "description": "liquid gradients, deep purples, slow modulation" }
```

Visual reference images are uploaded via the chat panel drag-drop (not a tool) and pinned to `visualReferences` in the tick context. Claude vision re-reads them each tick.

## Provider control

### `provider_play`
Play an external track (Spotify URI, YouTube URL, etc.).

```json
{ "uri": "spotify:track:7BKLCZ1jbUBVqRi2FVlTVw" }
```

### `provider_pause`
Pause the active provider.

## The full set covers the I/O channels documented in PLAN.md

| Channel from PLAN.md | Tool name |
|---|---|
| `evaluate_strudel(code)` | `evaluate_strudel` |
| `set_pattern_slot` | `set_pattern_slot` |
| `set_tempo(bpm, rampBars?)` | `set_tempo` |
| `hush` / `stop` | `stop` |
| `strudel.introspect(bars)` | `strudel_introspect` |
| `audio.features(stream)` | `audio_features` |
| `audio.spectrogram(stream, secs)` | `audio_spectrogram` |
| `schedule.in_bars(n, reason)` | `schedule_in_bars` |
| `schedule.at_bar(n, reason)` | `schedule_at_bar` |
| `schedule.in_minutes(n, reason)` | `schedule_in_minutes` |
| `visuals.set_style(description)` | `visuals_set_style` |
| `provider.play(uri)` | `provider_play` |
| `provider.pause()` | `provider_pause` |
| `panic` | `panic` |
| `get_state` | `get_state` |
