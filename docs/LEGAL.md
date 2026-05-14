# Legal & privacy

This is a personal, non-commercial live-coding DJ. The project is licensed AGPL-3.0 (inherited from Strudel). Some specific notes on the touchier areas:

## Spotify

- This app uses the Spotify Web API in **read-only mode** — currently-playing track, audio analysis (beat grid, key, sections), audio features (energy, valence, danceability), and search.
- We do **not** stream audio through any sanctioned Spotify SDK in v0.1.
- This usage falls within what Spotify endorses for personal DJ-style integration: <https://support.spotify.com/us/article/dj-integration/>. Personal, non-commercial, online; no public performance / livestream.
- We do **not** circumvent any technical protection measure or download audio.

## System audio capture

- The `getDisplayMedia({audio:true})` browser API lets the user share their system audio with the app. The user picks the source: a specific tab, a window, or the whole system.
- The captured audio enters a **RAM ring buffer** and is processed for numeric features only. **Nothing is persisted to disk by this app.**
- Source-agnostic: works for Spotify, YouTube, Bandcamp, your DAW, vinyl-through-line-in. The app does not single out any provider.
- Users are responsible for the audio they route through this capture. The app's design is intentionally provider-agnostic so it can be used with any audio source the user has rights to.

## Strudel-output tap

- A sidechain AudioWorklet node taps Strudel's own master output before audio leaves the browser. Same RAM-only feature pipeline.
- This is *Strudel's own output* — your composition. You may record it freely; the app does not record it automatically.

## What is NOT in v0.1

- No public livestream / broadcast feature.
- No multi-user collaborative sessions.
- No "rip Spotify audio" feature, in name, design, or spirit.
- No DRM circumvention of any kind.
- No persistent capture of any input audio.

## License (AGPL-3.0)

Strudel is AGPL-3.0. Any work that includes Strudel's code — which this fork does, via `apps/strudel-dj/` as a git subtree — must also be AGPL-3.0. The whole repository is AGPL-3.0 in `LICENSE`. If you modify and run a service that exposes this code's functionality over the network, you must make your modifications source-available under AGPL-3.0.

## Privacy

- The agent runtime sends prompts to Anthropic's Claude API (via the Claude Agent SDK). The prompts include your tick context: transport state, audio feature numbers, pattern code, recent chat messages, vibe journal entries, optionally spectrogram images and visual reference images you've dropped in. They do **not** include raw audio.
- If you connect the Spotify provider, the app stores OAuth tokens in `localStorage` of the dj-console origin only.
- The bridge listens on `localhost` only and is not exposed to the network.
