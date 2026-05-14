# strudel-ai-dj

An AI-controllable live-coding DJ built on a fork of [Strudel](https://codeberg.org/uzu/strudel), driven via the **Model Context Protocol (MCP)** and the **Claude Agent SDK**.

Strudel is the instrument. An LLM (Claude, via the embedded chat panel or via Claude Desktop) is the second pair of hands — writing patterns, mixing transitions, syncing to external audio (Spotify / YouTube / your DAW), running autonomously across a "night."

> Status: **v0.1 in progress.** The architecture is complete, packages are implemented, browser UI is buildable. Full end-to-end audio verification requires running the stack on your machine — see [docs/SETUP.md](docs/SETUP.md).

## Quickstart

```bash
git clone https://github.com/TheSmallPixel/strudel-ai-dj.git
cd strudel-ai-dj
pnpm install
pnpm dev
```

Open `http://localhost:5173`. The bridge runs on `:7777`. See [docs/SETUP.md](docs/SETUP.md) for the full setup including Claude Desktop MCP wiring and optional Spotify / YouTube providers.

## Docs

- [PLAN.md](PLAN.md) — full plan, architecture, phases, MCP tool surface, agent night-mode logic
- [docs/SETUP.md](docs/SETUP.md) — install + run + configure Claude Desktop + Spotify
- [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) — every MCP tool with example arguments
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — process topology and data flow
- [docs/LEGAL.md](docs/LEGAL.md) — legal & privacy posture

## Packages

- `packages/dj-core` — shared types, constants, DJ primitives (transitions, layer-in, drop)
- `packages/scheduler` — bar clock, callback registry, event bus
- `packages/bridge` — WebSocket hub + in-memory state store
- `packages/mcp-server` — stdio MCP server with all tools, used by Claude Desktop
- `packages/agent` — Claude Agent SDK runtime + system prompt + NightMode autonomous loop
- `packages/audio-input` — RMS / FFT / onset / tempo extraction + mel-spectrogram PNG renderer
- `packages/providers/{spotify,youtube,generic}` — pluggable metadata providers
- `apps/dj-console` — browser UI: Strudel REPL + chat + drag-drop + audio meters
- `apps/strudel-dj` — upstream Strudel monorepo via git subtree

## License

AGPL-3.0, inherited from Strudel. See [LICENSE](LICENSE).
