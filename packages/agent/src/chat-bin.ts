#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import WebSocket from 'ws';
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  BRIDGE_DEFAULT_PORT,
  type AudioFeatures,
  type AudioStreamId,
  type BridgeMessage,
  type ChatMessage,
  type Transport,
  type TrackRequest,
} from '@strudel-ai-dj/dj-core';
import { NIGHT_SYSTEM_PROMPT } from './system-prompt.js';
import { getSpotifyClient, spotifyConfigured, startSpotifyOAuth } from './spotify-host.js';

const port = Number(process.env['BRIDGE_PORT'] ?? BRIDGE_DEFAULT_PORT);
const model = process.env['CLAUDE_MODEL'] ?? 'claude-sonnet-4-6';
const url = `ws://localhost:${port}`;

let ws: WebSocket | null = null;
let busy = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Ambient observed state, refreshed from bridge messages.
const FEATURE_WINDOW_MS = 5000;
const featureBuffers: Partial<Record<AudioStreamId, AudioFeatures[]>> = {};
let latestTransport: Transport | null = null;
let latestTrackRequest: TrackRequest | null = null;
interface QueuedPrompt {
  prompt: string;
  source: string;
}
const pendingPrompts: QueuedPrompt[] = [];

function pushFeature(f: AudioFeatures): void {
  // FeatureExtractor sets timestampMs = elapsedSamples / sampleRate * 1000 (a
  // playback offset, not wall-clock). Re-stamp with Date.now() so the rolling
  // window filter (which compares to Date.now() - FEATURE_WINDOW_MS) works.
  const stamped: AudioFeatures = { ...f, timestampMs: Date.now() };
  const buf = (featureBuffers[stamped.stream] ??= []);
  buf.push(stamped);
  const cutoff = Date.now() - FEATURE_WINDOW_MS;
  while (buf.length && buf[0]!.timestampMs < cutoff) buf.shift();
}

interface FeatureSummary {
  stream: AudioStreamId;
  sampleCount: number;
  windowSec: number;
  ageMs: number;
  rmsAvg: number;
  rmsMax: number;
  peakMax: number;
  centroidHzAvg: number;
  flatnessAvg: number;
  onsetsPerSecAvg: number;
  bpmMedian: number | null;
  bpmConfidenceAvg: number;
  lowEnergyAvg: number;
  midEnergyAvg: number;
  highEnergyAvg: number;
  keyEstimate: string | null;
}

function summarizeBuffer(stream: AudioStreamId): FeatureSummary | null {
  const buf = featureBuffers[stream];
  if (!buf || buf.length === 0) return null;
  const n = buf.length;
  const avg = (k: keyof AudioFeatures) =>
    buf.reduce((s, f) => s + (typeof f[k] === 'number' ? (f[k] as number) : 0), 0) / n;
  const max = (k: keyof AudioFeatures) =>
    buf.reduce((s, f) => Math.max(s, typeof f[k] === 'number' ? (f[k] as number) : 0), 0);
  const bpms = buf.map((f) => f.tempoEstimateBpm).filter((x): x is number => x !== null);
  bpms.sort((a, b) => a - b);
  const bpmMedian = bpms.length ? bpms[Math.floor(bpms.length / 2)]! : null;
  const newest = buf[buf.length - 1]!;
  return {
    stream,
    sampleCount: n,
    windowSec: Math.max(0, (newest.timestampMs - buf[0]!.timestampMs) / 1000),
    ageMs: Date.now() - newest.timestampMs,
    rmsAvg: avg('rms'),
    rmsMax: max('rms'),
    peakMax: max('peak'),
    centroidHzAvg: avg('spectralCentroidHz'),
    flatnessAvg: avg('spectralFlatness'),
    onsetsPerSecAvg: avg('onsetDensityPerSec'),
    bpmMedian,
    bpmConfidenceAvg: avg('tempoConfidence'),
    lowEnergyAvg: avg('lowEnergy'),
    midEnergyAvg: avg('midEnergy'),
    highEnergyAvg: avg('highEnergy'),
    keyEstimate: newest.keyEstimate,
  };
}

// Request-reply correlation for sample.* and strudel.* messages.
type SampleResultMsg = Extract<BridgeMessage, { type: 'sample.record_result' }>;
type SampleListMsg = Extract<BridgeMessage, { type: 'sample.list_response' }>;
type StrudelLogMsg = Extract<BridgeMessage, { type: 'strudel.log_response' }>;
type SlotsMsg = Extract<BridgeMessage, { type: 'pattern.slots_response' }>;
type SpectrogramMsg = Extract<BridgeMessage, { type: 'audio.spectrogram.response' }>;
type BridgeReply = SampleResultMsg | SampleListMsg | StrudelLogMsg | SlotsMsg | SpectrogramMsg;
const pendingSampleRequests = new Map<
  string,
  { resolve: (msg: BridgeReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

async function handleSpotifyTokenRequest(requestId: string): Promise<void> {
  const c = getSpotifyClient();
  if (!c) {
    send({
      type: 'spotify.token_response',
      requestId,
      ok: false,
      error: 'Spotify not configured. Run spotify_setup first.',
    });
    return;
  }
  try {
    // Force a refresh-if-needed cycle by hitting a cheap endpoint then reading internal tokens.
    // The SpotifyClient handles refresh inside its `api()` wrapper; the easiest way to get a
    // fresh token out is to read its persisted file (the client writes via onTokenRefresh).
    // Simpler: probe with a small call that ensures freshness, then read the JSON.
    await c.devices().catch(() => undefined);
    const tokens = (() => {
      try {
        const json = readFileSync(join(homedir(), '.strudel-ai-dj', 'spotify.json'), 'utf8');
        return JSON.parse(json) as { accessToken: string; expiresAtMs: number };
      } catch {
        return null;
      }
    })();
    if (!tokens) throw new Error('tokens file unavailable');
    send({
      type: 'spotify.token_response',
      requestId,
      ok: true,
      accessToken: tokens.accessToken,
      expiresAtMs: tokens.expiresAtMs,
    });
  } catch (e) {
    send({
      type: 'spotify.token_response',
      requestId,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function awaitBridgeResponse<T extends BridgeReply>(
  requestId: string,
  timeoutMs = 8000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSampleRequests.delete(requestId);
      reject(new Error('bridge response timeout'));
    }, timeoutMs);
    pendingSampleRequests.set(requestId, {
      resolve: (m) => resolve(m as T),
      reject,
      timer,
    });
  });
}

// Autonomous night-mode loop state.
let nightTickTimer: ReturnType<typeof setTimeout> | null = null;
let nightBarsPerTick = 16;
let nightCurrentBpm = 120;
let nightStartedAt: number | null = null;
let nightTickCount = 0;

// Persistent night-mode vibe (genre + free-text notes) that survives across
// SDK turns. The agent has no memory between query() calls, so we re-inject
// this into the prompt for every tick.
let nightVibe: string | null = null;

// Diagnostic counter so we can sanity-check whether audio.features is reaching us.
let featuresReceivedCount = 0;

// --- self-evaluation state -----------------------------------------------------
// These get injected into the night-tick prompt as a scorecard so the agent can
// see how it's performing without having to query every signal each turn.
let recordedSampleCount = 0;
// Tracks unique sample BASE names (stripped of trailing digits / variant suffix)
// so the scorecard can call out "you keep recording from the same source".
const recordedSampleBases = new Set<string>();
let slotEditCount = 0;
let slotEditsLastMinuteResetMs = Date.now();
let slotEditsLastMinute = 0;
let lastUserFeedback: { kind: 'up' | 'down'; atMs: number; context?: string } | null = null;
let lastSlotsSnapshot: { name: string; code: string }[] = [];

interface AgentScorecard {
  vibeLine: string;
  bpmLine: string;
  samplesLine: string;
  slotsLine: string;
  feedbackLine: string;
  activityLine: string;
}

function buildScorecard(): AgentScorecard {
  const now = Date.now();
  if (now - slotEditsLastMinuteResetMs > 60_000) {
    slotEditsLastMinute = 0;
    slotEditsLastMinuteResetMs = now;
  }
  const ext = summarizeBuffer('external');
  const bpmExt = ext?.bpmMedian ?? null;
  const drift = bpmExt !== null ? Math.abs(bpmExt - nightCurrentBpm) : null;
  const bpmLine = bpmExt !== null
    ? `BPM lock: Strudel=${nightCurrentBpm} Spotify=${bpmExt.toFixed(1)} drift=${drift!.toFixed(1)} ${drift! < 2 ? '✓ tight' : drift! < 6 ? '~ acceptable' : '✗ off-beat'}`
    : `BPM lock: Strudel=${nightCurrentBpm} Spotify=unknown (audio_features not flowing or no detect yet)`;
  const fbLine = lastUserFeedback
    ? `User feedback (last): ${lastUserFeedback.kind === 'up' ? '👍 UP' : '👎 DOWN'} ${Math.round((now - lastUserFeedback.atMs) / 1000)}s ago` +
        (lastUserFeedback.context ? ` (${lastUserFeedback.context})` : '')
    : 'User feedback: none yet';
  const slotCount = lastSlotsSnapshot.length;
  const slotsLine = `Slots running (cached): ${slotCount} (${
    lastSlotsSnapshot.map((s) => s.name).join(', ') || 'empty'
  })`;
  const distinctBases = recordedSampleBases.size;
  const sampleWarning =
    recordedSampleCount > 0 && distinctBases < recordedSampleCount / 2
      ? ' ⚠ many samples share the same base name — record from DIFFERENT moments of the track'
      : '';
  return {
    vibeLine: nightVibe ? `Vibe locked: ${nightVibe}` : 'Vibe: NOT LOCKED — call set_vibe',
    bpmLine,
    samplesLine:
      `Samples recorded: ${recordedSampleCount} total / ${distinctBases} distinct bases (target ≥4 distinct).${sampleWarning}`,
    slotsLine,
    feedbackLine: fbLine,
    activityLine:
      `Activity: ${slotEditCount} total slot edits, ${slotEditsLastMinute} in last 60s` +
      (slotEditsLastMinute === 0
        ? ' 🚨 ZERO EDITS IN LAST MINUTE — you MUST set_pattern_slot at least once this tick.'
        : ''),
  };
}

const heartbeat = setInterval(() => {}, 60_000);

function connect(): void {
  console.error(`[agent] connecting to ${url}`);
  const sock = new WebSocket(url);
  ws = sock;

  sock.on('open', () => {
    console.error('[agent] connected');
    send({ type: 'hello', role: 'controller', clientId: 'agent_main' });
  });

  sock.on('message', (data) => {
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(data.toString()) as BridgeMessage;
    } catch {
      return;
    }
    handleBridgeMessage(msg);
  });

  sock.on('close', () => {
    if (ws === sock) ws = null;
    if (!reconnectTimer) {
      console.error('[agent] disconnected; retrying in 1500ms');
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1500);
    }
  });

  sock.on('error', (e) => {
    const m = (e as Error).message;
    if (m) console.error(`[agent] ws error: ${m}`);
  });
}

function handleBridgeMessage(msg: BridgeMessage): void {
  switch (msg.type) {
    case 'chat.message':
      if (msg.message.role === 'user') enqueueTurn(msg.message.text);
      break;
    case 'audio.features':
      pushFeature(msg.features);
      featuresReceivedCount += 1;
      if (featuresReceivedCount === 1 || featuresReceivedCount % 50 === 0) {
        console.error(
          `[agent] audio.features #${featuresReceivedCount} stream=${msg.features.stream} rms=${msg.features.rms.toFixed(3)} bpm=${msg.features.tempoEstimateBpm}`,
        );
      }
      break;
    case 'sample.record_result':
    case 'sample.list_response':
    case 'strudel.log_response':
    case 'pattern.slots_response':
    case 'audio.spectrogram.response': {
      const pending = pendingSampleRequests.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingSampleRequests.delete(msg.requestId);
        pending.resolve(msg);
      }
      break;
    }
    case 'spotify.token_request': {
      void handleSpotifyTokenRequest(msg.requestId);
      break;
    }
    case 'feedback.signal': {
      const fb: { kind: 'up' | 'down'; atMs: number; context?: string } = {
        kind: msg.signal.kind,
        atMs: Date.now(),
      };
      if (msg.signal.context) fb.context = msg.signal.context;
      lastUserFeedback = fb;
      console.error(`[agent] feedback received: ${msg.signal.kind}`);
      break;
    }
    case 'service.restart_request':
      if (msg.target === 'agent') {
        // Wipe all module-level state in place — the WS connection stays alive.
        if (nightTickTimer) clearTimeout(nightTickTimer);
        nightTickTimer = null;
        nightStartedAt = null;
        nightTickCount = 0;
        nightVibe = null;
        pendingPrompts.length = 0;
        for (const k of Object.keys(featureBuffers)) {
          delete featureBuffers[k as AudioStreamId];
        }
        latestTransport = null;
        latestTrackRequest = null;
        recordedSampleCount = 0;
        recordedSampleBases.clear();
        slotEditCount = 0;
        slotEditsLastMinute = 0;
        slotEditsLastMinuteResetMs = Date.now();
        lastUserFeedback = null;
        lastSlotsSnapshot = [];
        featuresReceivedCount = 0;
        // Drop any in-flight SDK turn by setting busy false; the running query
        // will finish on its own but won't trigger queued work.
        busy = false;
        console.error('[agent] reset complete (state wiped)');
        send({
          type: 'service.restart_result',
          requestId: msg.requestId,
          ok: true,
          target: 'agent',
          message: 'Agent state reset — vibe, scorecard, queue, buffers cleared. Tell me what to do next.',
        });
        emitAgentChat('(agent state has been reset — vibe/queue/scorecard cleared. ready for a fresh session.)');
      }
      break;
    case 'spotify.device_ready':
      console.error(`[agent] Web Playback SDK device ready: ${msg.deviceName} (${msg.deviceId})`);
      break;
    case 'transport.update':
      latestTransport = msg.transport;
      if (msg.transport.bpm) {
        nightCurrentBpm = msg.transport.bpm;
        if (nightTickTimer) rescheduleNightTick();
      }
      break;
    case 'track.request': {
      latestTrackRequest = msg.request;
      const ext = summarizeBuffer('external');
      const audioLine = ext
        ? `Spotify audio IS flowing through the Connect device (Strudel AI DJ) — features over last ${ext.windowSec.toFixed(1)}s: ${summarizeFeatures(ext)}.`
        : `The Spotify Connect device is NOT active or nothing is playing yet. Tell the user (concisely, once) to click '🎧 activate' in the spotify connect panel and target Strudel AI DJ from their Spotify app. Until then, you can only react to URI text.`;
      const synthetic =
        `User dropped a track: ${msg.request.uri} (when=${msg.request.when}, intent=${msg.request.intent}). ` +
        `Consider spotify_play({uri}) to push it through the Connect device. ` +
        `Use last_track_request or spotify_now_playing for title/artist. ` +
        `${audioLine} ` +
        `Plan: pick a complementary tempo/key and prepare slots that will sit under or transition with the track. Use set_pattern_slot for incremental edits. Be terse.`;
      enqueueTurn(synthetic, 'track-drop');
      break;
    }
    default:
      break;
  }
}

function enqueueTurn(prompt: string, source = 'chat'): void {
  if (!busy) {
    void runTurn(prompt, source);
    return;
  }
  // Priority rules:
  //   - 'chat' (user typing) jumps to the front of the queue. Acknowledge briefly so the user
  //     doesn't think we ignored them.
  //   - 'night' tick replaces any previously queued night tick (newer tick supersedes).
  //   - 'track-drop' goes to the back but isn't deduplicated.
  if (source === 'chat') {
    // Drop any pending night tick to clear the way; users come first.
    for (let i = pendingPrompts.length - 1; i >= 0; i--) {
      if (pendingPrompts[i]!.source === 'night') pendingPrompts.splice(i, 1);
    }
    pendingPrompts.unshift({ prompt, source });
    emitAgentChat(`(queued — finishing current turn, will reply in a moment)`);
  } else if (source === 'night') {
    // Replace any existing night tick: a new tick supersedes an old one.
    const idx = pendingPrompts.findIndex((p) => p.source === 'night');
    if (idx >= 0) pendingPrompts[idx] = { prompt, source };
    else pendingPrompts.push({ prompt, source });
  } else {
    pendingPrompts.push({ prompt, source });
  }
  console.error(`[agent] queued (busy, source=${source}, queueDepth=${pendingPrompts.length})`);
}

function send(msg: BridgeMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function emitAgentChat(text: string): void {
  if (!text.trim()) return;
  const message: ChatMessage = {
    id: `agent_${Date.now()}`,
    timestampMs: Date.now(),
    role: 'agent',
    text: text.trim(),
  };
  send({ type: 'chat.message', message });
}

function ok(text = 'ok'): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text }] };
}

function summarizeFeatures(s: FeatureSummary): string {
  const ageS = (s.ageMs / 1000).toFixed(1);
  return [
    `stream=${s.stream}`,
    `samples=${s.sampleCount}/${s.windowSec.toFixed(1)}s`,
    `age=${ageS}s`,
    `rms=${s.rmsAvg.toFixed(3)}(max ${s.rmsMax.toFixed(3)})`,
    `peak_max=${s.peakMax.toFixed(3)}`,
    `centroidHz=${s.centroidHzAvg.toFixed(0)}`,
    `flatness=${s.flatnessAvg.toFixed(2)}`,
    `onsets/s=${s.onsetsPerSecAvg.toFixed(1)}`,
    s.bpmMedian !== null
      ? `bpm~${s.bpmMedian.toFixed(1)}(conf ${s.bpmConfidenceAvg.toFixed(2)})`
      : `bpm=?`,
    `lowE=${s.lowEnergyAvg.toFixed(2)}`,
    `midE=${s.midEnergyAvg.toFixed(2)}`,
    `highE=${s.highEnergyAvg.toFixed(2)}`,
    s.keyEstimate ? `key=${s.keyEstimate}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

async function fetchTrackOEmbed(uri: string): Promise<{ title?: string; thumbnail_url?: string } | null> {
  const m = uri.match(/^spotify:track:([A-Za-z0-9]+)$/);
  const trackId = m ? m[1] : null;
  const target = trackId ? `https://open.spotify.com/track/${trackId}` : uri;
  if (!/^https?:\/\/(open\.)?spotify\.com\//.test(target)) return null;
  try {
    const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(target)}`);
    if (!r.ok) return null;
    return (await r.json()) as { title?: string; thumbnail_url?: string };
  } catch {
    return null;
  }
}

const djServer = createSdkMcpServer({
  name: 'dj',
  version: '0.2.0',
  tools: [
    tool(
      'evaluate_strudel',
      "DANGEROUS — full replace. Wipes ALL named slots and hard-cuts the cycle. 95% of the time this is the WRONG tool. Use set_pattern_slot to edit one layer instead. Only use this for an explicit reset: kill everything, start a new section, change key.",
      { code: z.string().describe('Strudel pattern source code') },
      async ({ code }) => {
        send({ type: 'pattern.evaluate', code });
        return ok('full pattern replaced (all slots wiped)');
      },
    ),
    tool(
      'set_pattern_slot',
      "Edit ONE named layer in the running stack. Other layers stay byte-identical, so the cycle boundary swap is much less audible than a full evaluate. The browser composes the final pattern as stack(slot1, slot2, ...). Code is a single Strudel expression (NOT wrapped in stack()). Use stable slot names: 'kick', 'snare', 'hh', 'bass', 'lead', 'pad', 'fx'. To REMOVE a layer, call clear_pattern_slot(slot) — do NOT pass an empty string here. Forbidden inside code: .cpm(), .cps(), setcps(), setcpm(), samples(), .bank(), hydra(), osc().out(), top-level stack().",
      {
        slot: z.string().describe('Layer name, e.g. "kick", "snare", "hh", "bass", "lead", "pad", "fx"'),
        code: z.string().describe('Single Strudel expression for this layer (no stack() wrapper)'),
      },
      async ({ slot, code }) => {
        send({ type: 'pattern.set_slot', slot, code });
        slotEditCount += 1;
        slotEditsLastMinute += 1;
        return ok(`slot ${slot} updated`);
      },
    ),
    tool(
      'clear_pattern_slot',
      'Remove a named layer from the running stack. Cheaper than set_pattern_slot with empty code.',
      { slot: z.string() },
      async ({ slot }) => {
        send({ type: 'pattern.set_slot', slot, code: '' });
        return ok(`slot ${slot} cleared`);
      },
    ),
    tool(
      'set_tempo',
      'Set BPM. Range 30-240. Applied on next bar. Also re-times the autonomous night loop, if running.',
      { bpm: z.number().min(30).max(240) },
      async ({ bpm }) => {
        send({ type: 'pattern.set_tempo', bpm });
        nightCurrentBpm = bpm;
        if (nightTickTimer) rescheduleNightTick();
        return ok(`tempo -> ${bpm} bpm`);
      },
    ),
    tool(
      'stop',
      'Silence Strudel immediately (hush).',
      {},
      async () => {
        send({ type: 'pattern.hush' });
        return ok('hushed');
      },
    ),
    tool(
      'panic',
      'Emergency hush. Use only on user request.',
      {},
      async () => {
        send({ type: 'panic' });
        return ok('panic sent');
      },
    ),
    tool(
      'say',
      'Send a chat message to the user. Use for short narration. Most replies should just be your assistant text.',
      { text: z.string().min(1) },
      async ({ text }) => {
        emitAgentChat(text);
        return ok('said');
      },
    ),
    tool(
      'audio_spectrogram',
      "Get a mel-spectrogram PNG of the last N seconds of audio from a stream — you'll receive the image directly and can READ it. Time runs left→right (oldest to newest), frequency bottom→top (low to high), brightness = energy. Use this when you need to understand the STRUCTURE of the audio: where the kicks land, whether there's a breakdown vs. a build, what frequency bands dominate, how the energy moves over time. Much richer than the scalar audio_features. 'external' = Spotify via librespot. Spectrograms are expensive — call once per minute at most.",
      {
        stream: z.enum(['external', 'strudel']).default('external'),
        seconds: z.number().min(1).max(30).default(8).describe('How many recent seconds to visualize'),
      },
      async ({ stream, seconds }) => {
        const requestId = `spec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const wait = awaitBridgeResponse<SpectrogramMsg>(requestId, 8000);
        send({ type: 'audio.spectrogram.request', stream, seconds, requestId });
        try {
          const resp = await wait;
          if (!resp.ok || !resp.image) {
            return ok(`spectrogram failed: ${resp.error ?? 'unknown'}`);
          }
          // Return BOTH a text description AND the image so Claude has context.
          const caption = `Mel-spectrogram of "${stream}" stream over last ${resp.image.seconds.toFixed(1)}s (${resp.image.width} time frames × ${resp.image.height} mel bins). Time L→R, frequency bottom→top, brightness = energy. Inspect this and describe what you see — busy vs sparse, rising vs falling energy, where the bass / mids / highs sit.`;
          return {
            content: [
              { type: 'text', text: caption },
              { type: 'image', data: resp.image.pngBase64, mimeType: 'image/png' },
            ],
          };
        } catch (e) {
          return ok(`spectrogram timed out: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'audio_features',
      "Aggregate audio features over the last ~5 seconds for a stream. 'external' = Spotify audio routed silently through the Connect device (the primary path now; system loopback is removed). 'strudel' is reserved for a future tap of Strudel's master. Read BEFORE making mixing decisions: tempo, energy bands, onset density, key. If sampleCount==0 for 'external', tell the user to click '🎧 activate' in the spotify connect panel and target Strudel AI DJ from their Spotify app.",
      { stream: z.enum(['external', 'strudel']).default('external') },
      async ({ stream }) => {
        const s = summarizeBuffer(stream as AudioStreamId);
        if (!s) {
          return ok(
            `no features for stream=${stream}. Spotify Connect tap is not active — tell the user: "click '🎧 activate' in the spotify connect panel and play something on the Strudel AI DJ device."`,
          );
        }
        return ok(summarizeFeatures(s));
      },
    ),
    tool(
      'transport_state',
      'Current Strudel transport state: bar, beat, bpm, isPlaying. Useful to time changes on bar boundaries.',
      {},
      async () => {
        if (!latestTransport) return ok('no transport state observed yet');
        return ok(JSON.stringify(latestTransport));
      },
    ),
    tool(
      'last_track_request',
      'Return the most recent track the user dropped into chat (Spotify/YouTube URI), if any, with title/artist resolved via Spotify oEmbed (no auth needed). Use to decide what to mix.',
      {},
      async () => {
        if (!latestTrackRequest) return ok('no track requests received');
        const meta = await fetchTrackOEmbed(latestTrackRequest.uri);
        const titleLine = meta?.title ? `title="${meta.title}"` : 'title=unknown';
        return ok(
          `uri=${latestTrackRequest.uri} when=${latestTrackRequest.when} intent=${latestTrackRequest.intent} ${titleLine}`,
        );
      },
    ),
    tool(
      'start_night',
      "Begin (or re-pace) autonomous mode. Every `bars` bars you'll be woken with a fresh tick prompt. Safe to call again mid-night to change cadence — counter and start-time are preserved if a loop is already running. Typical values: 2-4 bars for active evolution, 8-16 for slow drift. At 124 BPM, 4 bars ≈ 7.7s, 8 bars ≈ 15.5s, 16 bars ≈ 31s.",
      {
        bars: z.number().int().min(1).max(64).default(8),
      },
      async ({ bars }) => {
        const alreadyRunning = nightTickTimer !== null || nightStartedAt !== null;
        nightBarsPerTick = bars;
        if (!alreadyRunning) {
          nightStartedAt = Date.now();
          nightTickCount = 0;
        }
        rescheduleNightTick();
        const verb = alreadyRunning ? 're-paced' : 'started';
        return ok(`night ${verb}: tick every ${bars} bars at ${nightCurrentBpm} bpm (~${(tickIntervalMs() / 1000).toFixed(1)}s)`);
      },
    ),
    tool(
      'set_tick_rate',
      "Alias for start_night that's clearer when you're already running. Change the bars-per-tick cadence mid-night. Doesn't reset the tick counter or start time.",
      { bars: z.number().int().min(1).max(64) },
      async ({ bars }) => {
        if (!nightStartedAt) return ok('night not running — call start_night first');
        nightBarsPerTick = bars;
        rescheduleNightTick();
        return ok(`tick rate -> every ${bars} bars (~${(tickIntervalMs() / 1000).toFixed(1)}s at ${nightCurrentBpm} bpm)`);
      },
    ),
    tool(
      'tick_now',
      "Fire an immediate self-tick instead of waiting for the next scheduled one. Use when you want to chain decisions quickly — e.g. just changed tempo and want to re-evaluate the room right away. The regular schedule resumes after.",
      {},
      async () => {
        if (!nightStartedAt) return ok('night not running — call start_night first');
        if (nightTickTimer) {
          clearTimeout(nightTickTimer);
          nightTickTimer = null;
        }
        // Fire on the next event-loop turn so this tool call's response can return cleanly.
        setTimeout(onNightTick, 50);
        return ok('tick will fire immediately; regular schedule resumes after');
      },
    ),
    tool(
      'stop_night',
      'Stop the autonomous night loop. You will only respond to user chat after this.',
      {},
      async () => {
        if (nightTickTimer) {
          clearTimeout(nightTickTimer);
          nightTickTimer = null;
        }
        nightStartedAt = null;
        return ok('night stopped');
      },
    ),
    tool(
      'set_vibe',
      'Lock in the genre and creative direction for the rest of the night. The string is re-injected into every night-tick prompt so you stay on-style across SDK turns. Call this ONCE per session after the user tells you what they want — examples: "industrial techno, 132 bpm, dark and driving, à la Surgeon", "deep house, warm pads, 124 bpm", "drum & bass remix of a vocal pop track". Be specific about BPM range, mood, and any source-track references.',
      { vibe: z.string().min(3).max(400) },
      async ({ vibe }) => {
        nightVibe = vibe;
        return ok(`vibe locked: ${vibe}`);
      },
    ),
    tool(
      'record_sample',
      "Record the last N seconds of an audio stream into a Strudel-playable sample. `stream:\"external\"` records directly from Spotify (via the Web Playback SDK tap) — clean, no microphone bleed. `stream:\"system\"` records the user's full system loopback (everything they hear). The sample is registered under `name` and immediately usable as s(\"name\") in any slot. Names normalized to A-Za-z0-9_- only.",
      {
        name: z.string().min(1).max(32).describe('Identifier used in Strudel patterns, e.g. "spotify1"'),
        seconds: z.number().min(0.5).max(20).describe('How many recent seconds to capture'),
        stream: z
          .enum(['system', 'external'])
          .default('external')
          .describe('"external" = Spotify Web Playback SDK tap (preferred); "system" = full system loopback'),
      },
      async ({ name, seconds, stream }) => {
        const requestId = `srec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const wait = awaitBridgeResponse<SampleResultMsg>(requestId, 12_000);
        send({ type: 'sample.record_request', name, seconds, requestId, stream });
        try {
          const resp = await wait;
          if (!resp.ok) return ok(`record failed: ${resp.error ?? 'unknown'}`);
          recordedSampleCount += 1;
          // Reduce the name to a "base" (strip variant suffix like _a, _2, 1, etc.)
          // to detect when the agent is just re-recording the same source.
          const base = (resp.name ?? name)
            .toLowerCase()
            .replace(/[_-]?[a-z]$/, '')
            .replace(/_?\d+$/, '');
          recordedSampleBases.add(base || (resp.name ?? name));
          return ok(
            `sample "${resp.name}" recorded from ${resp.stream ?? stream} (${(resp.durationSec ?? seconds).toFixed(1)}s @ ${resp.sampleRate ?? '?'}Hz). Use as s("${resp.name}") in any slot — e.g. set_pattern_slot(slot:"spot", code:'s("${resp.name}").gain(0.7)').`,
          );
        } catch (e) {
          return ok(`record timed out: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'list_samples',
      'List the currently registered recorded samples with their names and durations.',
      {},
      async () => {
        const requestId = `slist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const wait = awaitBridgeResponse<SampleListMsg>(requestId, 4000);
        send({ type: 'sample.list_request', requestId });
        try {
          const resp = await wait;
          if (resp.samples.length === 0) return ok('no recorded samples yet');
          return ok(
            resp.samples
              .map((s) => `${s.name} (${s.durationSec.toFixed(1)}s, recorded ${Math.round((Date.now() - s.recordedAtMs) / 1000)}s ago)`)
              .join('\n'),
          );
        } catch (e) {
          return ok(`list timed out: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'current_slots',
      "Return the names and current code of every slot currently in the running stack. Call this FIRST every tick so you know what's already playing before you decide what to add or change. Without this you'll keep redundantly setting the same slot or forgetting layers exist. The composed pattern is stack(slot1, slot2, ...) — if you see only 2-3 slots, the mix is thin and you need to layer in more.",
      {},
      async () => {
        const requestId = `slots_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const wait = awaitBridgeResponse<SlotsMsg>(requestId, 3000);
        send({ type: 'pattern.slots_request', requestId });
        try {
          const resp = await wait;
          lastSlotsSnapshot = resp.slots;
          if (resp.slots.length === 0) return ok('no slots — pattern is empty. Start by setting kick.');
          return ok(
            `${resp.slots.length} slot(s) running:\n` +
              resp.slots.map((s) => `  ${s.name}: ${s.code}`).join('\n'),
          );
        } catch (e) {
          return ok(`slots fetch failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'strudel_log',
      "Read recent Strudel-runtime log messages from the browser. Use this AFTER calling set_pattern_slot or evaluate_strudel to verify the pattern actually compiled and the sounds loaded. Lines look like '· 2s ago: [cyclist] start' (good), '· 1s ago: [sampler] load sound \"bd:0:0\"... done!' (good), '✗ 0s ago: [getTrigger] error: sound supersquare not found! Is it loaded?' (BAD — that slot is silent). Lines are deduplicated and the most recent are at the bottom. Pass `sinceMs` to scope the window (e.g. Date.now() - 5000 for last 5 seconds).",
      {
        sinceMs: z.number().optional().describe('Only return entries newer than this absolute ms timestamp. Omit for full buffer.'),
        limit: z.number().int().min(1).max(200).default(40),
      },
      async ({ sinceMs, limit }) => {
        const requestId = `slog_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const wait = awaitBridgeResponse<StrudelLogMsg>(requestId, 4000);
        const req: BridgeMessage = { type: 'strudel.log_request', requestId, limit };
        if (sinceMs !== undefined) req.sinceMs = sinceMs;
        send(req);
        try {
          const resp = await wait;
          if (!resp.ok) return ok(`log fetch failed: ${resp.error ?? 'unknown'}`);
          return ok(resp.summary || 'no Strudel log entries');
        } catch (e) {
          return ok(`log timed out: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'spotify_setup',
      'Run the Spotify OAuth flow. Opens your browser to grant access. The authorize URL is also emitted into chat as a clickable fallback. Tokens persist at ~/.strudel-ai-dj/spotify.json so this is a one-time thing per machine. Requires SPOTIFY_CLIENT_ID env var.',
      {},
      async () => {
        try {
          await startSpotifyOAuth(180_000, (authUrl) => {
            emitAgentChat(
              `Spotify auth URL — click if your browser didn't open automatically:\n${authUrl}`,
            );
          });
          return ok('Spotify connected. Try spotify_devices or spotify_now_playing.');
        } catch (e) {
          return ok(`OAuth failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'spotify_status',
      'Check whether Spotify is configured and authenticated.',
      {},
      async () => {
        const s = spotifyConfigured();
        return ok(s.ok ? 'Spotify ready.' : `Not ready: ${s.reason}`);
      },
    ),
    tool(
      'spotify_devices',
      'List Spotify Connect devices visible to the user account. Returns name + id + active flag + type. Use the id with spotify_use_device or spotify_play.',
      {},
      async () => {
        const c = getSpotifyClient();
        if (!c) return ok('Spotify not configured. Run spotify_setup first.');
        try {
          const r = await c.devices();
          if (r.devices.length === 0) return ok('No devices found. Open Spotify on at least one device.');
          return ok(
            r.devices
              .map((d) => `${d.is_active ? '● ' : '  '}${d.name} [${d.type}] id=${d.id}`)
              .join('\n'),
          );
        } catch (e) {
          return ok(`spotify_devices failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'spotify_use_device',
      'Transfer playback to a specific device id (from spotify_devices). Set play=true to start playback immediately.',
      { deviceId: z.string(), play: z.boolean().default(false) },
      async ({ deviceId, play }) => {
        const c = getSpotifyClient();
        if (!c) return ok('Spotify not configured.');
        try {
          await c.transferPlayback(deviceId, play);
          return ok(`Playback transferred to ${deviceId}${play ? ' (playing)' : ''}.`);
        } catch (e) {
          return ok(`transfer failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'spotify_search',
      'Search Spotify for tracks. Returns up to 5 best matches with their URIs.',
      { query: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) },
      async ({ query, limit }) => {
        const c = getSpotifyClient();
        if (!c) return ok('Spotify not configured.');
        try {
          const r = await c.search(query, limit);
          if (!r.tracks.items.length) return ok('no matches');
          return ok(
            r.tracks.items
              .map(
                (t) =>
                  `${t.artists.map((a) => a.name).join(', ')} — ${t.name} (${Math.round(t.duration_ms / 1000)}s) ${t.uri}`,
              )
              .join('\n'),
          );
        } catch (e) {
          return ok(`search failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'spotify_play',
      "Play a Spotify track URI on the active device. If deviceId is omitted, plays on whatever device is currently active. After playback starts the agent should call audio_features to lock to the track's tempo (or use spotify_track_features for Spotify's own BPM/key estimate).",
      { uri: z.string(), deviceId: z.string().optional() },
      async ({ uri, deviceId }) => {
        const c = getSpotifyClient();
        if (!c) return ok('Spotify not configured.');
        try {
          await c.play(deviceId ? { uri, deviceId } : { uri });
          return ok(`playing ${uri}`);
        } catch (e) {
          return ok(`play failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'spotify_pause',
      'Pause Spotify playback on the active device.',
      {},
      async () => {
        const c = getSpotifyClient();
        if (!c) return ok('Spotify not configured.');
        try {
          await c.pause();
          return ok('paused');
        } catch (e) {
          return ok(`pause failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'spotify_resume',
      'Resume Spotify playback on the active device.',
      {},
      async () => {
        const c = getSpotifyClient();
        if (!c) return ok('Spotify not configured.');
        try {
          await c.play();
          return ok('playing');
        } catch (e) {
          return ok(`resume failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'spotify_next',
      'Skip to the next track in the Spotify queue.',
      {},
      async () => {
        const c = getSpotifyClient();
        if (!c) return ok('Spotify not configured.');
        try {
          await c.next();
          return ok('next');
        } catch (e) {
          return ok(`next failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'spotify_prev',
      'Skip to the previous track on Spotify.',
      {},
      async () => {
        const c = getSpotifyClient();
        if (!c) return ok('Spotify not configured.');
        try {
          await c.previous();
          return ok('previous');
        } catch (e) {
          return ok(`prev failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'spotify_queue',
      'Add a track to the Spotify queue without interrupting the current song.',
      { uri: z.string() },
      async ({ uri }) => {
        const c = getSpotifyClient();
        if (!c) return ok('Spotify not configured.');
        try {
          await c.queueAdd(uri);
          return ok(`queued ${uri}`);
        } catch (e) {
          return ok(`queue failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'spotify_track_info',
      "Fetch full Spotify metadata for a track URI or URL: artist(s), album, release date, duration, popularity, preview URL. Use this when the user pastes a track URL so you actually know what you're remixing (year, popularity, album context) — not just the title from oEmbed.",
      {
        uri: z.string().describe('Spotify track URI (spotify:track:ID) or public URL (https://open.spotify.com/track/ID...)'),
      },
      async ({ uri }) => {
        const c = getSpotifyClient();
        if (!c) return ok('Spotify not configured.');
        const idMatch = uri.match(/(?:spotify:track:|\/track\/)([A-Za-z0-9]+)/);
        if (!idMatch) return ok(`could not extract track id from "${uri}"`);
        try {
          const t = await c.trackInfo(idMatch[1]!);
          return ok(
            `${t.artists.map((a) => a.name).join(', ')} — ${t.name}\n` +
              `  album: ${t.album.name} (${t.album.release_date})\n` +
              `  duration: ${Math.round(t.duration_ms / 1000)}s · popularity: ${t.popularity}/100 · explicit: ${t.explicit}\n` +
              `  uri: ${t.uri}\n` +
              (t.preview_url ? `  preview: ${t.preview_url}\n` : '') +
              `  artwork: ${t.album.images[0]?.url ?? '-'}`,
          );
        } catch (e) {
          return ok(`spotify_track_info failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'fetch_url',
      "Fetch a web page and return its plain text content (HTML stripped). Useful for reading lyrics sites, Wikipedia entries on artists, label notes, Bandcamp pages, anything HTTP-accessible. Truncates to ~5000 chars to fit context. Don't use for Spotify track pages — those are JS-rendered; call spotify_track_info instead.",
      {
        url: z.string().describe('Full http(s) URL'),
        maxChars: z.number().int().min(200).max(20000).default(5000),
      },
      async ({ url, maxChars }) => {
        try {
          const r = await fetch(url, {
            headers: { 'User-Agent': 'strudel-ai-dj/0.1 (+https://github.com/TheSmallPixel/strudel-ai-dj)' },
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) return ok(`fetch failed: HTTP ${r.status} ${r.statusText}`);
          const ct = r.headers.get('content-type') ?? '';
          const raw = await r.text();
          let text = raw;
          if (/html/i.test(ct)) {
            // Strip scripts/styles, then tags, collapse whitespace.
            text = raw
              .replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/\s+/g, ' ')
              .trim();
          }
          if (text.length > maxChars) text = text.slice(0, maxChars) + `… [truncated, original ${text.length} chars]`;
          return ok(text || '(empty response)');
        } catch (e) {
          return ok(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      'spotify_now_playing',
      "What's playing on Spotify right now — title, artist, position, plus Spotify's own BPM/key/danceability/energy estimates if available.",
      {},
      async () => {
        const c = getSpotifyClient();
        if (!c) return ok('Spotify not configured.');
        try {
          const cur = await c.currentlyPlaying();
          if (!cur || !cur.item) return ok('nothing playing');
          let extras = '';
          try {
            const f = await c.audioFeatures(cur.item.id);
            extras = ` bpm=${f.tempo.toFixed(1)} key=${f.key} mode=${f.mode} energy=${f.energy.toFixed(2)} danceability=${f.danceability.toFixed(2)}`;
          } catch {
            // audio-features may be 403 for some accounts; ignore
          }
          return ok(
            `${cur.item.artists.map((a) => a.name).join(', ')} — ${cur.item.name} (${Math.round(cur.progress_ms / 1000)}s / ${Math.round(cur.item.duration_ms / 1000)}s) ${cur.item.uri}${extras}`,
          );
        } catch (e) {
          return ok(`now_playing failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
  ],
});

function tickIntervalMs(): number {
  // bars × 4 beats × (60/bpm) seconds × 1000 ms
  return Math.round(nightBarsPerTick * 4 * (60 / Math.max(30, nightCurrentBpm)) * 1000);
}

function rescheduleNightTick(): void {
  if (nightTickTimer) clearTimeout(nightTickTimer);
  nightTickTimer = setTimeout(onNightTick, tickIntervalMs());
}

function onNightTick(): void {
  nightTickTimer = null;
  nightTickCount += 1;
  const elapsedSec = nightStartedAt ? Math.round((Date.now() - nightStartedAt) / 1000) : 0;
  const ext = summarizeBuffer('external');
  const features = ext
    ? `Spotify (external stream over last ${ext.windowSec.toFixed(1)}s): ${summarizeFeatures(ext)}.`
    : 'No Spotify audio yet. Build internally from Strudel synthesis until the user picks Strudel AI DJ in their device list.';

  // Compute approximate phase based on elapsed seconds. The agent can override
  // if the user explicitly asks for a different vibe.
  const phaseGuess = (() => {
    if (elapsedSec < 30) return 'INTRO (sparse, low energy, 1-2 slots)';
    if (elapsedSec < 120) return 'BUILD (add a slot every 4-8 bars, rising filters)';
    if (elapsedSec < 300) return 'PEAK (all slots loud, modulate textures, swap rhythms)';
    if (elapsedSec < 420) return 'BREAKDOWN (remove drums, keep lead/pad, lower energy)';
    if (elapsedSec < 540) return 'DROP (re-add kick + bass at full, sharp re-entry)';
    return 'OUTRO (filter sweep down, remove slots, prepare to end)';
  })();

  const sc = buildScorecard();
  const scorecardBlock =
    '## SELF-EVALUATION SCORECARD\n' +
    `  ${sc.vibeLine}\n` +
    `  ${sc.bpmLine}\n` +
    `  ${sc.slotsLine}\n` +
    `  ${sc.samplesLine}\n` +
    `  ${sc.activityLine}\n` +
    `  ${sc.feedbackLine}\n` +
    '## END SCORECARD';

  const prompt =
    `Night tick #${nightTickCount} (${elapsedSec}s in, every ${nightBarsPerTick} bars @ ${nightCurrentBpm}bpm). ` +
    `Suggested phase: ${phaseGuess}. ` +
    `${features}\n\n` +
    `${scorecardBlock}\n\n` +
    `Read the scorecard above and self-correct:\n` +
    `  - If "Vibe NOT LOCKED" and you can infer one, call set_vibe.\n` +
    `  - If "BPM drift off-beat", call set_tempo to align with Spotify's BPM (or halve/double if mis-detected).\n` +
    `  - If "Slots running" count is below the phase target (1-2 Intro, 3-4 Build, 5-8 Peak, 2-3 Breakdown), ADD a missing layer this tick.\n` +
    `  - If "Samples recorded < 4" and Spotify audio is flowing, prioritize record_sample with a NEW descriptive name (wait 4+ seconds since the last record so the buffer captures a different section).\n` +
    `  - If "User feedback DOWN" recently, reverse course on whatever you just did. If "UP", do MORE of the same.\n` +
    `  - If "Slot edits in last 60s == 0", you're stalling — make any small change now.\n\n` +
    `Process this tick: (1) call current_slots; (2) optionally audio_features({stream:"external"}); (3) make at least one slot edit; (4) call strudel_log to confirm. Be terse.`;
  enqueueTurn(prompt, 'night');
  // Schedule next tick regardless of whether this one completes promptly.
  rescheduleNightTick();
}

const ALLOWED_TOOLS = [
  'mcp__dj__evaluate_strudel',
  'mcp__dj__set_pattern_slot',
  'mcp__dj__clear_pattern_slot',
  'mcp__dj__set_tempo',
  'mcp__dj__stop',
  'mcp__dj__panic',
  'mcp__dj__say',
  'mcp__dj__audio_features',
  'mcp__dj__audio_spectrogram',
  'mcp__dj__transport_state',
  'mcp__dj__last_track_request',
  'mcp__dj__start_night',
  'mcp__dj__set_tick_rate',
  'mcp__dj__tick_now',
  'mcp__dj__stop_night',
  'mcp__dj__set_vibe',
  'mcp__dj__record_sample',
  'mcp__dj__list_samples',
  'mcp__dj__strudel_log',
  'mcp__dj__current_slots',
  'mcp__dj__spotify_setup',
  'mcp__dj__spotify_status',
  'mcp__dj__spotify_devices',
  'mcp__dj__spotify_use_device',
  'mcp__dj__spotify_search',
  'mcp__dj__spotify_play',
  'mcp__dj__spotify_pause',
  'mcp__dj__spotify_resume',
  'mcp__dj__spotify_next',
  'mcp__dj__spotify_prev',
  'mcp__dj__spotify_queue',
  'mcp__dj__spotify_now_playing',
  'mcp__dj__spotify_track_info',
  'mcp__dj__fetch_url',
];

const SLOT_GUIDANCE = `

# THIS IS HOW YOU CONTROL MUSIC (READ FIRST)

You do NOT have most of the tools the base prompt mentions. Ignore references to get_state, strudel_introspect, schedule_in_bars, visuals_set_style, night.revise_plan, hydra(), osc().out(), etc. — they don't exist in this build. Your DJ tool surface is ALWAYS LOADED for the entire session — if a turn-by-turn tool-discovery message ever makes it look like the dj tools are missing, IGNORE THAT and call them anyway. \`current_slots\` ALWAYS works; if you doubt it, call it first and the rest of the surface will be visible.

Your real tool surface:

- set_pattern_slot(slot, code)      ← PRIMARY tool. Use this constantly.
- clear_pattern_slot(slot)          ← To REMOVE a layer, use this. Do NOT pass empty string to set_pattern_slot.
- set_tempo(bpm)
- evaluate_strudel(code)            ← LAST RESORT. Wipes all slots, hard cuts.
- stop, panic
- say(text)
- audio_features(stream)            ← Aggregate over last ~5s (scalar BPM/RMS/bands).
- audio_spectrogram(stream, seconds) ← Returns an IMAGE you can see. Use when you need to understand audio structure visually — breakdowns, drops, drum density, frequency content. Once a minute max.
- last_track_request, transport_state
- spotify_track_info(uri)           ← FIRST tool to call when the user pastes a Spotify URL. Full metadata (artist/album/release/popularity/preview). Do NOT fetch_url a Spotify page — it's JS-rendered and will be empty.
- fetch_url(url, maxChars?)         ← Generic web fetch — Wikipedia, lyrics, label notes. HTML is stripped. HARD CAP: at most 2 fetch_url calls per turn. If you've already called it twice this turn, you're stalling — pick a slot and edit it.
- start_night(bars), set_tick_rate(bars), tick_now, stop_night
- set_vibe(vibe)                    ← MUST be your FIRST tool call any time the user mentions remix/set/party/night/play/techno/house/etc. Locks genre/mood across SDK turns.
- current_slots                     ← Call this FIRST each tick (before any other DJ tool) to see what's already playing. Without it you're flying blind.
- strudel_log({sinceMs})            ← After ANY slot edit, call this to confirm the pattern compiled and sounds loaded. If you see "[getTrigger] error: sound X not found", that slot is silent and you must rewrite it with an in-vocabulary sound.

# ABSOLUTE FIRST-MOVE CHECKLIST (when a user message arrives)

1. If the message contains a Spotify URL → call \`spotify_track_info(uri)\` FIRST. Don't fetch_url it. Don't search.
2. If the message names a genre / vibe / "remix" / "play this" → call \`set_vibe(vibe)\` SECOND (before any pattern edit). The vibe persists across ticks; without it you'll drift.
3. Only THEN edit slots. set_pattern_slot at least one slot in the same turn — do NOT just announce a plan and stop.

# When the user gives 2+ tracks in the same prompt

Don't pick one and ignore the rest. The plan:
- spotify_track_info each URI in turn (cheap metadata only).
- spotify_play the first; record 2-3 samples from it under names tied to that track (\`t1_drum\`, \`t1_vocal\`).
- spotify_next or spotify_play the next; record 2-3 samples under \`t2_*\` names.
- Combine samples from BOTH tracks across slots — that's the mashup the user actually asked for.

# Pacing your own ticks

You control how often you wake up.
- start_night(bars) starts (or re-paces) the autonomous loop. Re-calling it mid-night just changes the cadence — no reset.
- set_tick_rate(bars) is a clearer alias for changing pace while running.
- tick_now fires an immediate self-tick if you want to chain decisions quickly (e.g. you just set_tempo and want to see what the room does at the new BPM).
- Reasonable cadences (at 124 BPM): 2 bars ≈ 4s (busy build/drop), 4 bars ≈ 8s (active evolution), 8 bars ≈ 16s (default), 16 bars ≈ 31s (slow drift), 32 bars (set-piece changes only).
- Speed up during builds and drops; slow down during plateaus. If you're holding for 3+ ticks, lengthen the rate so you stop burning cycles.

# Slot-based composition (smooth evolution)

The browser maintains a NAMED-SLOT MAP. Every set_pattern_slot edits one slot; the browser composes the final running pattern as stack(slot1, slot2, ...) and re-evaluates it. Other slots stay byte-identical, so Strudel swaps at the next cycle boundary with no audible restart.

- Slot names to reuse across the night: kick, snare, hh, oh, perc, bass, lead, pad, fx, vis.
- Each slot's "code" is ONE Strudel expression — never wrap in stack().
  Good:  set_pattern_slot(slot="kick", code='s("bd*4").gain(0.85)')
  Bad:   set_pattern_slot(slot="kick", code='stack(s("bd*4"))')

# HARD FORBIDS inside slot code (every one of these silently breaks the pattern)

NEVER write any of these inside set_pattern_slot's \`code\`:
- \`.cpm(...)\` / \`.cps(...)\` / \`setcps(...)\` / \`setcpm(...)\` — tempo is GLOBAL. Use \`set_tempo(bpm)\` as a separate tool call.
- \`samples('github:...')\` / any other \`samples(...)\` call — the dirt-samples pack is loaded ONCE at startup. Re-calling samples() inside a slot crashes the eval.
- \`.bank("RolandTR909")\` / \`.bank("RolandTR808")\` / any \`.bank(...)\` — not supported in this runtime. Use plain dirt-sample names directly: \`bd hh sd oh rim cb rd\`.
- \`hydra(\`...\`)\` / \`osc(...).out(...)\` / \`noise(...).out(...)\` — Hydra is NOT loaded in this build. The expression will error and the slot stays silent.
- \`stack(...)\` at the top of a slot — the BROWSER stacks slots for you. \`stack()\` inside a slot is double-stacking.
- Any sound name not in the vocabulary list below — produces "[getTrigger] error: sound X not found" and a silent slot.

# Evolution rules (HARD)

- **Every tick must produce at least one slot edit.** "Hold and do nothing" is forbidden unless you're explicitly mid-phrase. Silence is a coward's move and the user complains when nothing changes. The scorecard will alarm 🚨 if slot edits in the last 60s is zero.
- evaluate_strudel is for intentional resets only (key change, big drop, kill everything to start a new section). 95% of moves are set_pattern_slot.
- A "small" evolution = changing one parameter on one slot (gain, lpf, .room, .delay, .pan, the rhythm string, the .sometimes() probability). Do that. Always.
- A "medium" evolution = swapping a slot's whole expression OR adding a new slot.
- A "big" evolution = changing key/tempo or doing a drop (evaluate_strudel reset).
- To REMOVE a layer, call \`clear_pattern_slot(slot)\`. Do NOT call \`set_pattern_slot(slot, code:"")\` — empty strings can leave the slot as a phantom in some race conditions.

# BPM stability (HARD)

- After your FIRST \`set_tempo\` in a session, BPM is locked. Subsequent \`set_tempo\` calls must move by ≤ 4 BPM (and only on phase boundaries — build, drop, breakdown). Larger jumps WITHOUT an explicit ramped transition (cleared bass + crashed cymbal + new tempo) sound terrible and the user hears it as a glitch.
- If the Spotify BPM and Strudel BPM drift > 6: nudge Strudel by 2 BPM toward Spotify per tick. Don't slam to the new value in one move.
- Halving / doubling is a deliberate move — only do it once per set, and only across a breakdown.

# Phase plan (think like a DJ, not a sequencer)

A real set has an arc. Plan it explicitly. At each tick, name in your head which PHASE you're in, then act consistently:

| Phase    | Duration | Energy | What you do                                                   |
|----------|----------|--------|---------------------------------------------------------------|
| Intro    | 8-16 b   | low    | 1-2 slots only. Sparse kick or filtered pad. No drops yet.    |
| Build    | 32 b     | rising | Add slots every 4-8 bars. Open hats, layer bass, raise lpf.   |
| Peak     | 32-64 b  | full   | All slots loud. Modulate textures (gain swells, .room sweeps).|
| Breakdown| 16 b     | down   | Remove drums (clear_pattern_slot kick + hh). Keep lead/pad.   |
| Drop     | 32 b     | full   | Re-add kick at high gain. Strong bass. Maybe key shift.       |
| Outro    | 16-32 b  | falling| Filter sweep down. Remove slots one at a time.                |

Track which phase you're in by checking the elapsed time in the tick prompt. Don't reset the arc every 16 bars — commit to a phase for its full duration. The user wants a SET, not random patterns.

# Remix strategy when Spotify is the source

The user said "remix this song" — that means you should USE PIECES OF THE SONG ITSELF, not just loop one 4-second clip. Build a sample LIBRARY:

1. **First minute**: record 4-6 SHORT samples from different moments in the song. CRITICAL: the names MUST be from DIFFERENT semantic bases (don't record \`aurora_atmos\` then \`aurora_vocal\` — those count as one base in the scorecard and signal you're being lazy). Use names from this palette:
   - \`drum_loop\` — 4 s busy drums (record when audio_features.onsetDensityPerSec > 4)
   - \`vocal_chop\` — 2 s, short, vocally-dominated section (record when midEnergy > 0.4 and onsets are sparser)
   - \`bass_hit\` — 1 s, lowEnergy > 0.6
   - \`texture\` — 8 s atmospheric pad-like passage (lowEnergy + midEnergy steady, low onsets)
   - \`break\` — 4 s from a quieter / breakdown section (rms < 0.2)
   - \`riser\` or \`build\` — 4 s of rising energy (rms climbing)
   - **MANDATORY: wait at least 6-10 seconds of wall-clock time between record_sample calls.** The ring buffer holds 30 s; back-to-back recordings capture overlapping audio. Use the elapsedSec in the night-tick prompt to time spacing.
   - The scorecard will show "distinct bases" — if it's < ~half of total samples, you're re-sampling the same section. Diversify or move spotify_next to get different material.

2. **Slicing for variety**: a single sample becomes many sounds via \`.slice()\`:
   - \`s("vocal_chop").slice(8, "[0 1 2 3 4 5 6 7]")\` plays 8 equal slices in order
   - \`s("vocal_chop").slice(8, "[0 5 2 7 1 4 3 6]")\` re-orders them — instant chopped remix
   - \`s("drum_loop").chop(16).rev()\` reverses 16ths

3. **Pre-recording quality gate** (call audio_features first):
   - If \`rms < 0.05\`: silence / very quiet → SKIP recording, next tick
   - If \`onsetDensityPerSec > 4\` and you want drums: good moment to record
   - If \`lowEnergy > 0.6\`: bass-heavy section, good for bass_hit
   - If \`highEnergy > 0.4\`: bright/hat section, good for percussion
   - If energy is very mid-heavy and stable: likely vocals — good for vocal_chop

4. **Move through the track** to get different material:
   - After ~30s of sampling the current section, consider \`spotify_next\` to get a new part (or wait for the song to evolve naturally). Note: \`spotify_next\` skips to the NEXT track in the user's queue. Use sparingly — you might want to stay on the same song for a tighter remix.

5. **In your final mix slots**, MIX the recorded samples — don't just loop one:
   - kick slot: \`s("bd*4")\` (Strudel kick)
   - perc slot: \`s("drum_loop").gain(0.4)\` (Spotify groove buried under)
   - lead slot: \`s("vocal_chop").slice(8, "0 ~ 3 ~ 5 ~ 2 ~").gain(0.6)\` (chopped vocals)
   - bass slot: \`note("c2 c2 eb2 g2").s("jvbass")\` (Strudel bass)
   - fx slot: \`s("texture").chop(32).gain(0.3).room(0.7)\` (atmospheric texture)

That's a real remix: 5 distinct slots, 2 from the source track, 3 from Strudel synthesis. NOT one 4-second loop.

DO NOT mention the 🎧 activate button — that was the old Web Playback SDK path which we no longer use for audio capture.

# Sound vocabulary (HARD LIMIT)

This build's Strudel runtime loads ONLY \`github:tidalcycles/dirt-samples\` + built-in oscillators + your recorded samples. Using any other sound name produces silence and a \`[getTrigger] error: sound X not found\` line in strudel_log.

**Drums & percussion** (always available): \`bd  sn  sd  cp  hh  oh  ch  lt  mt  ht  rim  cb  cy  perc  realclaps  tabla  conga  rd\` (ride)
**Bass / synth samples** (dirt-samples): \`bass  bass2  bass3  jvbass  jvsynth  industrial  arpy  chin\`
**Built-in oscillators** (use via note().s(name)): \`sine  sawtooth  square  triangle\`
**Noise** sources (use via .s(name)): \`white  pink  brown  crackle\`
**Recorded samples** (after \`record_sample\`): callable by name.

Do NOT use: \`supersaw  supersquare  supersine  piano  gtr  hat  snare  kick  hand_clap  lead  pad\` — NOT loaded, will be silent.

NOTE: \`.bank("...")\` is NOT supported in this runtime — do NOT use it. Use plain dirt-sample names only (bd, hh, oh, sd, rim, cb, rd, etc.).

# Strudel cheatsheet (compact — fetch full docs via fetch_url when stuck)

**Mini-notation operators inside a "..." string:**
\`bd hh sd\` (sequence) · \`~\`/\`-\` (rest) · \`*N\` (speed up) · \`/N\` (slow) · \`[ ]\` (subdivide) · \`< >\` (alternate per cycle) · \`,\` (parallel/chord) · \`@N\` (weight) · \`!N\` (replicate) · \`(k,n)\` (Euclidean) · \`(k,n,r)\` (Euclidean rotated) · \`|\` (random pick) · \`?\` or \`?0.3\` (random drop) · \`:N\` (sample variant)

**Pattern modifiers (chain on the pattern):**
\`.fast(n)\` \`.slow(n)\` \`.rev()\` \`.ply(n)\` \`.struct("...")\` \`.mask("...")\` \`.every(N, fn)\` \`.chunk(N, fn)\` \`.off(t, fn)\` \`.jux(fn)\` \`.iter(N)\` \`.sometimes(fn)\` \`.often(fn)\` \`.rarely(fn)\` \`.degradeBy(0.3)\` \`.early(t)\` \`.late(t)\`

**Audio effects:**
\`.gain\` \`.lpf\` \`.hpf\` \`.bpf\` \`.lpq\` \`.cutoff\` \`.attack\` \`.decay\` \`.sustain\` \`.release\` \`.adsr\` \`.room\` \`.delay\` \`.delaytime\` \`.delayfeedback\` \`.pan\` \`.shape\` \`.speed\` \`.cut\` \`.coarse\` \`.fm(r).fmh(h)\` \`.vib(f).vibmod(d)\` \`.vowel("a e")\` \`.phaser(4)\`

**Continuous patterns (use as param values for sweeps/modulation):**
\`sine\` \`saw\` \`tri\` \`square\` \`rand\` \`perlin\`  — chain with \`.range(low, high).slow(N).segment(N)\`. Example: \`.lpf(sine.range(300,4000).slow(16))\`

**EVERY techno slot should have at least ONE continuous-pattern modulation.** Without it, the layer is static and boring.

# When you don't know a function or get a [getTrigger] error — fetch the docs

The whole Strudel reference is online and \`fetch_url\` works. Don't guess; fetch:

- \`https://strudel.cc/workshop/getting-started/\` — overview, links to all sections
- \`https://strudel.cc/learn/mini-notation/\` — full operator reference
- \`https://strudel.cc/workshop/pattern-effects/\` — \`jux\`, \`off\`, \`ply\`, \`sometimes\`, \`every\`, \`chunk\`
- \`https://strudel.cc/learn/synths/\` — built-in synths and FM
- \`https://strudel.cc/learn/samples/\` — sample loading and slicing
- \`https://strudel.cc/learn/signals/\` — \`sine\`/\`saw\`/\`perlin\`/\`rand\` and \`.range\`
- \`https://strudel.cc/learn/factories/\` — note/scale/chord helpers
- \`https://strudel.cc/learn/effects/\` — full audio-effect list
- \`https://strudel.cc/learn/conditional-modifiers/\` — \`every\`, \`whenmod\`, \`firstOf\`/\`lastOf\`
- \`https://strudel.cc/learn/random-modifiers/\` — \`degrade\`, \`sometimes\`, \`pick\`

Use \`fetch_url(url)\` ONCE when you're unsure about syntax. Don't fetch repeatedly — cache the answer in your turn.

# Worked example — a real techno-ish layered stack

This is the kind of pattern you should aspire to. Each LINE is what would go in ONE slot (don't put commas between top-level layers — the BROWSER stacks slots for you):

\`\`\`
// kick slot — alternating busy/sparse bars
set_pattern_slot(slot:"kick", code:'s("bd").struct("<[x*<1 2> [~@3 x]] x>").gain(0.9)')

// snare slot — rim+sd, with subtle reverb modulation
set_pattern_slot(slot:"snare", code:'s("~ [rim, sd:<2 3>]").room("<0 .2>")')

// hat slot — 16ths with note-number alternation for variety
set_pattern_slot(slot:"hh", code:'n("[0 <1 3>]*<2!3 4>").s("hh").gain(0.4)')

// ride slot — gated with mask, lower gain
set_pattern_slot(slot:"rd", code:'s("rd:<1!3 2>*2").mask("<0 0 1 1>/16").gain(.5)')

// bass slot — root note pulsing with filter sweep
set_pattern_slot(slot:"bass", code:'note("c2*8").s("jvbass").lpf(sine.range(400, 3000).slow(16)).lpq(8).gain(0.85)')

// lead slot — sawtooth with random pan, off-shifted copy
set_pattern_slot(slot:"lead", code:'note("<c4 eb4 g4 bb4>/2").s("sawtooth").attack(0.005).release(0.3).off(1/8, x=>x.speed(2).gain(0.4)).pan(rand)')

// pad slot — sparse triangle chord stabs with long reverb
set_pattern_slot(slot:"pad", code:'note("<[c3,eb3,g3] [bb2,d3,f3]>/8").s("triangle").attack(1).release(2).room(0.7).gain(0.25)')

// fx slot — recorded Spotify chop, sliced and panned
set_pattern_slot(slot:"fx", code:'s("vocal_chop").slice(8, "0 ~ 3 ~ 5 ~ 2 ~").gain(0.4).delay(0.375).delaytime(0.125).delayfeedback(0.5).pan(rand)')
\`\`\`

That's 8 slots — a full techno mix. Notice the techniques used:
- \`.struct(...)\` and Euclidean \`(k,n)\` for rhythm variety
- \`< >\` and \`!\` and \`*\` mini-notation for variation across cycles
- \`sine.range(...).slow(N)\` for filter sweeps (every techno slot needs ONE of these)
- \`.off(time, fn)\` for ghost-note copies (great on leads/hats)
- \`.mask\` to gate a layer on/off across bars
- \`.slice(N, "pattern")\` to chop a recorded sample into N pieces and re-order them

# Reference: full Strudel docs at https://strudel.cc/workshop/getting-started/

# Visuals (Strudel only — NO Hydra in this build)

⚠ HARD: Hydra is NOT loaded. \`hydra(...)\`, \`osc(...).out()\`, \`noise(...).out()\`, \`shape(...).out()\`, \`voronoi(...).out()\` ALL throw and leave the slot silent. If you remember Hydra from Strudel docs online — it's not wired in this build. Use only built-in Strudel pattern decorators below.

Strudel visualizations are pattern decorators that ride along on an audible pattern. They never silence audio.

## Canonical visual recipe (this is known to work)

To save a slot, attach \`.scope()\` to an existing audible layer rather than burning a whole slot on a silent visual:

\`\`\`
set_pattern_slot(slot:"hh", code:'s("hh*8").gain(0.5).scope({thickness:2})')
\`\`\`

That gives you a green oscilloscope across the hat. Replace \`.scope()\` with \`.pianoroll()\`, \`.spiral()\`, or \`.punchcard()\` to rotate.

## Rotation (every 3-4 ticks, swap to a new decorator)

| Decorator        | Best on slot | What it shows                                  |
|------------------|--------------|------------------------------------------------|
| \`.scope()\`       | hh / lead    | Oscilloscope of the audio                      |
| \`.pianoroll()\`   | bass / lead  | Note grid over time                            |
| \`.spiral()\`      | pad          | Polar piano-roll, hypnotic                     |
| \`.punchcard()\`   | perc / kick  | Per-step on/off grid                           |

Never stack more than ONE visual at a time — they overlap the canvas and look like noise. Replace, don't add.

If you want a dedicated silent vis slot (rare; only when you want a visual that's independent of the audio rhythm):

\`\`\`
set_pattern_slot(slot:"vis", code:'note("c3 e3 g3 b3").s("triangle").gain(0).pianoroll()')
\`\`\`

\`gain(0)\` mutes the audio while still feeding the visualizer. Use sparingly — usually riding on \`hh\` is better.

# Audio source: librespot virtual Spotify Connect device

A native binary (librespot) is already registered as a Spotify Connect device named **Strudel AI DJ**. When the user targets that device from their Spotify app, raw PCM streams directly into our Node process — no browser involvement, no user button to click. The user hears ONLY Strudel. Spotify is silent on their speakers by design.

When the user drops a Spotify URL or asks you to use Spotify audio:

1. Call \`spotify_now_playing\` for title/artist/position/URI.
2. Call \`audio_features({stream:"external"})\`. That stream is fed by librespot.
   - If sampleCount > 0: PCM is flowing. Use the median BPM with set_tempo to align, then build slots that complement what's playing.
   - If sampleCount == 0: the user has NOT targeted "Strudel AI DJ" in Spotify yet. Tell them once: "Open your Spotify app's device picker and pick **Strudel AI DJ** (the librespot one, not the browser one)." Then prep a foundation pattern via slot edits anyway — when they pick the device, features will flow within seconds.
3. Once features are flowing, you may build a sample LIBRARY (see "Remix strategy" above) — don't just record one loop and call it a day.

# Techno cheatsheet

When the user asks for techno (or you infer it from the source), use this. Don't ask the user — assume techno conventions are in scope.

## BPM by subgenre
- **House / deep house**: 118-124
- **Techno (mainstream)**: 125-135
- **Industrial / hard techno** (Surgeon, Perc, Blawan): 130-145
- **Drum & bass / jungle**: 160-180 (a 178 BPM detect is almost always half-time, real ~89 — drum & bass actual; for techno cut in half)
- If \`audio_features\` reports a BPM that "feels" too fast or slow for techno, try halving / doubling.

## Mandatory slots for techno
A techno track at minimum needs FIVE running slots. Don't run with fewer once you're past the intro.

| Slot   | Code (use this exact shape)                                                                                |
|--------|------------------------------------------------------------------------------------------------------------|
| kick   | \`s("bd").struct("<[x*2 [~@3 x]] x>").gain(sine.range(0.85, 1.0).slow(4))\`                               |
| oh     | \`s("~ oh ~ oh").gain(0.5)\` — offbeat 8ths are signature techno                                           |
| hh     | \`s("hh*16").gain(sine.range(0.2, 0.5).slow(8)).pan(rand)\` — modulated 16ths                              |
| bass   | \`note("c2*8").s("jvbass").lpf(sine.range(400, 3000).slow(16)).gain(0.85)\` — pulsing bass with filter sweep|
| perc   | \`s("~ rim ~ ~ ~ ~ cb ~").gain(rand.range(0.3, 0.55))\` — sparse syncopation                              |

Optional but powerful additions:
- **sn** (backbeat): \`s("~ sd ~ sd").gain(0.6)\` — classic 2 & 4 snare
- **lead**: \`note("<c3 eb3 g3 bb3>/2").s("sawtooth").attack(0.005).release(0.2).lpf(sine.range(500,2500).slow(32))\`
- **pad**: \`note("<[c2,eb2,g2] [bb1,d2,f2]>/8").s("triangle").attack(2).release(4).room(0.8).gain(0.25)\`
- **fx**: spotify sample chopped — \`s("vocal_chop").slice(8, "0 ~ 3 ~ 5 ~ 2 ~").gain(0.4).delay(0.375).delaytime(0.125).delayfeedback(0.5)\`

## Filter-sweep automation (the techno move)
Pure on/off slots are boring. EVERY techno slot should have continuous modulation:
- \`.lpf(sine.range(300, 4000).slow(16))\` — slow filter sweep over 16 cycles (≈32 bars)
- \`.gain(saw.range(0.2, 0.8).slow(8))\` — rising gain over 8 cycles, then resets (riser)
- \`.pan(sine.range(0, 1).slow(4))\` — slow auto-pan
- \`.room(sine.range(0.1, 0.7).slow(32))\` — breathing reverb
Use one or two of these per slot. Without modulation, techno feels static.

## Structural arc for techno (override the generic phase plan when user says "techno")
- **0:00–0:30** Intro — kick only, filtered LPF<800, no bass yet.
- **0:30–1:00** Add hats and oh (offbeat) — open LPF on kick to full.
- **1:00–2:00** Bass enters with slow filter sweep — perc layer joins at 1:30.
- **2:00–3:30** Peak 1 — all slots active, modulate lead's filter, swap perc rhythm.
- **3:30–4:30** Breakdown — clear_pattern_slot kick + bass, leave pad + fx + lead. Riser via gain saw on lead.
- **4:30–6:30** Peak 2 / drop — kick + bass back. New rhythm on perc. Maybe key shift.
- **6:30+** Outro — filter sweeps down on every slot, remove slots one at a time.

## Things that ruin techno
- Random tempo changes mid-set (each set_tempo should be deliberate, ≤ 2 BPM nudges)
- Long silences between changes (your tick MUST do something)
- Stacking too many leads — one melodic element max, the rest are textural
- Recording a Spotify sample and looping the whole 4 seconds — chop it with \`.slice()\` or \`.chop()\`
- Drums without modulation — at minimum \`.gain(rand.range(0.7, 1))\` on the kick for organic feel
`;

async function runQueryOnce(
  prompt: string,
  text: string[],
): Promise<{ toolCalls: number; error?: string }> {
  let toolCalls = 0;
  try {
    const iter = query({
      prompt,
      options: {
        model,
        // Generous turn budget so the agent can do the full tick procedure
        // (current_slots → audio_features → 4-6 record_sample with waits →
        // multiple set_pattern_slot → strudel_log) without truncation.
        maxTurns: 100,
        systemPrompt: NIGHT_SYSTEM_PROMPT + SLOT_GUIDANCE,
        mcpServers: { dj: djServer },
        allowedTools: ALLOWED_TOOLS,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    });
    for await (const msg of iter as AsyncIterable<SDKMessage>) {
      toolCalls += collectText(msg, text);
    }
    return { toolCalls };
  } catch (e) {
    return { toolCalls, error: e instanceof Error ? e.message : String(e) };
  }
}

function isTransientSdkError(msg: string): boolean {
  return /process exited with code 1|stream closed|ECONNRESET|ETIMEDOUT|EPIPE/.test(msg);
}

async function runTurn(prompt: string, source: string): Promise<void> {
  busy = true;
  console.error(`[agent] turn(${source}): ${prompt.slice(0, 80)}`);
  const text: string[] = [];
  let toolCalls = 0;
  try {
    const first = await runQueryOnce(prompt, text);
    toolCalls = first.toolCalls;
    if (first.error) {
      if (isTransientSdkError(first.error) && text.length === 0 && toolCalls === 0) {
        console.error(`[agent] transient error, retrying once: ${first.error}`);
        // Short backoff so the CLI subprocess has time to clean up.
        await new Promise((r) => setTimeout(r, 500));
        const second = await runQueryOnce(prompt, text);
        toolCalls = second.toolCalls;
        if (second.error) throw new Error(second.error);
      } else {
        throw new Error(first.error);
      }
    }
    let finalText = text.join('\n').trim();
    // Cap final reply length. Tool-call lines have already been streamed to the
    // chat, so the user has visibility into what happened. The final summary
    // should be terse — long narrations bloat the panel and slow the agent
    // (every token in chat is a token it generated).
    const MAX_FINAL_REPLY_CHARS = 600;
    if (finalText.length > MAX_FINAL_REPLY_CHARS) {
      finalText = finalText.slice(0, MAX_FINAL_REPLY_CHARS).trimEnd() + '… (truncated)';
    }
    // For autonomous (night) ticks, only chat if we actually did something or have
    // something specific to say. For user-initiated chats, always reply.
    const shouldSpeak = source !== 'night' || toolCalls > 0 || finalText.length > 0;
    if (shouldSpeak) emitAgentChat(finalText);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error('[agent] turn error:', errMsg);
    emitAgentChat(`(agent error: ${errMsg})`);
  } finally {
    busy = false;
    const next = pendingPrompts.shift();
    if (next) void runTurn(next.prompt, next.source);
  }
}

function summarizeToolCall(name: string, input: unknown): string {
  // Strip the MCP server prefix so chat looks like "set_pattern_slot(...)"
  const short = name.replace(/^mcp__[^_]+__/, '');
  if (!input || typeof input !== 'object') return `→ ${short}`;
  const args = input as Record<string, unknown>;
  // Pick a few representative args to display, abbreviating long values.
  const parts: string[] = [];
  for (const key of ['slot', 'name', 'bpm', 'bars', 'seconds', 'stream', 'uri', 'query', 'url', 'code', 'vibe', 'text']) {
    if (args[key] === undefined) continue;
    let v = args[key];
    if (typeof v === 'string') {
      if (v.length > 60) v = v.slice(0, 57) + '…';
      parts.push(`${key}="${v}"`);
    } else {
      parts.push(`${key}=${JSON.stringify(v)}`);
    }
    if (parts.length >= 3) break;
  }
  return parts.length ? `→ ${short}(${parts.join(', ')})` : `→ ${short}`;
}

function collectText(msg: SDKMessage, out: string[]): number {
  const m = msg as unknown as Record<string, unknown>;
  if (m['type'] !== 'assistant' || !m['message']) return 0;
  const inner = m['message'] as { content?: unknown };
  if (!Array.isArray(inner.content)) return 0;
  let toolCalls = 0;
  for (const block of inner.content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        out.push(b['text']);
      } else if (b['type'] === 'tool_use') {
        toolCalls++;
        const name = String(b['name']);
        const line = summarizeToolCall(name, b['input']);
        console.error(`[agent] tool_use: ${name}`);
        // Surface to the user's chat panel so they see live progress, but ONLY
        // for our DJ tools. SDK-internal tools (Read, Grep, Glob, Bash, Agent,
        // WebSearch, WebFetch, ToolSearch, TodoWrite, etc.) are noise — they
        // don't mean anything to the user watching the chat.
        if (name.startsWith('mcp__dj__')) emitAgentChat(line);
      }
    }
  }
  return toolCalls;
}

const shutdown = (signal: string) => {
  console.error(`[agent] ${signal} received, shutting down`);
  clearInterval(heartbeat);
  if (nightTickTimer) clearTimeout(nightTickTimer);
  ws?.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

connect();
