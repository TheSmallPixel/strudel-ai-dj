# Setup

Local development of Strudel AI DJ. Tested on Windows 11 + Node 20 + pnpm 9; should work on macOS / Linux with the same versions.

## Prerequisites

- **Node 20+** (`node -v`)
- **pnpm 9+** (`npm i -g pnpm@9` if you don't have it)
- **Chromium-based browser** (Chrome, Edge, Brave) — `getDisplayMedia` audio capture and AudioWorklet are required
- **A Claude Code subscription** (Pro/Max) OR an **Anthropic API key** — pick one for the embedded agent
- (Optional) **Spotify Developer app** with PKCE flow enabled — for the spotify provider
- (Optional) **YouTube Data API key** — for the youtube provider

## Install

```bash
git clone https://github.com/TheSmallPixel/strudel-ai-dj.git
cd strudel-ai-dj
pnpm install
```

This installs deps for the root workspace and all packages **except** the nested Strudel sub-monorepo at `apps/strudel-dj/`. That one has its own install (only needed if you plan to modify Strudel internals; for normal use, the `@strudel/web` package pulled from npm is sufficient).

If you do want to work on Strudel itself:
```bash
pnpm --dir apps/strudel-dj install
```

## Run

In one terminal, start everything:
```bash
pnpm dev
```

This runs three processes concurrently:
- **bridge** — WebSocket hub on `ws://localhost:7777`
- **mcp-server** — stdio MCP server (only useful when launched by Claude Desktop; the `pnpm dev` instance is mostly for visibility)
- **console** — Vite dev server at `http://localhost:5173`

Open `http://localhost:5173` in your Chromium browser. You should see:
- The TransportBar with green "● bridge" indicator
- Strudel REPL initializing in the left panel
- Audio panel with "start system capture" button
- Chat panel on the right

## Configure the agent

The agent runtime can authenticate two ways. Choose one:

### Option A — Claude Code subscription (default, recommended)

Make sure you're logged into Claude Code (`claude` CLI) on the machine running the bridge. The `@anthropic-ai/claude-agent-sdk` will use your subscription automatically.

### Option B — Anthropic API key

Set the env var before running:

```bash
# Windows PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
pnpm dev

# macOS / Linux
export ANTHROPIC_API_KEY=sk-ant-...
pnpm dev
```

## Configure Claude Desktop MCP

To drive the DJ from Claude Desktop in addition to (or instead of) the embedded chat panel, add the MCP server to your Claude Desktop config.

Find your config file:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the `strudel-ai-dj` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "strudel-ai-dj": {
      "command": "node",
      "args": ["C:/path/to/strudel-ai-dj/packages/mcp-server/dist/bin.js"],
      "env": {
        "BRIDGE_PORT": "7777"
      }
    }
  }
}
```

Then `pnpm -r --filter "./packages/**" build` once to produce the `dist/` outputs, and restart Claude Desktop.

## Configure Spotify (optional)

1. Create a Spotify Developer app at <https://developer.spotify.com/dashboard>.
2. Add `http://localhost:7878/callback` as a redirect URI.
3. Copy your Client ID.
4. Set `VITE_SPOTIFY_CLIENT_ID` in `apps/dj-console/.env.local`:
   ```
   VITE_SPOTIFY_CLIENT_ID=your_client_id_here
   ```
5. In the console, click "Connect Spotify" (when M3 UI lands). The PKCE flow opens a browser window and redirects back to localhost.

## Configure YouTube (optional)

Create a YouTube Data API v3 key at <https://console.cloud.google.com/>. Set in `apps/dj-console/.env.local`:

```
VITE_YOUTUBE_API_KEY=your_key_here
```

## Audio capture notes

When you click "start system capture", the browser asks which window/tab/screen to share. **You must check "Share tab audio" / "Share system audio"** in the picker, or no audio will be captured.

Strudel's own output is captured automatically via a sidechain tap on the Web Audio graph when you evaluate the first pattern (no permission prompt needed).

Audio is held in RAM ring buffers; nothing is written to disk by this app.
