#!/usr/bin/env node
/**
 * librespot-host
 *
 * Spawns the librespot binary as a Spotify Connect device named "Strudel AI DJ",
 * reads its raw PCM output (S16LE stereo 44.1kHz via `--backend pipe`), feeds
 * the audio into our existing browser-side pipeline (running in Node — it's
 * pure JS) for feature extraction, and forwards results over the WebSocket
 * bridge as `audio.features` with stream='external'.
 *
 * Also maintains a ~30 second rolling PCM buffer (mono mix-down). When the
 * agent calls `record_sample({stream:'external', ...})`, the request reaches
 * this host via the bridge, we encode WAV in-memory, serve it on a local HTTP
 * port, and reply with the URL. The browser then registers it with Strudel's
 * `samples()` function.
 */
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { BRIDGE_DEFAULT_PORT, type BridgeMessage } from '@strudel-ai-dj/dj-core';
import { BrowserAudioPipeline } from '@strudel-ai-dj/audio-input';

const DEVICE_NAME = process.env['LIBRESPOT_DEVICE_NAME'] ?? 'Strudel AI DJ';
const BITRATE = process.env['LIBRESPOT_BITRATE'] ?? '320';
const SAMPLE_RATE = 44100;
const SAMPLE_HTTP_PORT = Number(process.env['SAMPLE_HTTP_PORT'] ?? 7779);
const BRIDGE_PORT = Number(process.env['BRIDGE_PORT'] ?? BRIDGE_DEFAULT_PORT);
const BRIDGE_URL = `ws://localhost:${BRIDGE_PORT}`;

// --- locate librespot binary ----------------------------------------------------
function findBinary(): string {
  if (process.env['LIBRESPOT_PATH'] && existsSync(process.env['LIBRESPOT_PATH'])) {
    return process.env['LIBRESPOT_PATH'];
  }
  const exe = platform() === 'win32' ? 'librespot.exe' : 'librespot';
  // cargo install --root ./bin places the binary at ./bin/bin/<name>
  const cargoRoot = join(process.cwd(), 'bin', 'bin', exe);
  if (existsSync(cargoRoot)) return cargoRoot;
  const direct = join(process.cwd(), 'bin', exe);
  if (existsSync(direct)) return direct;
  return exe;
}

// --- in-memory WAV store served over HTTP --------------------------------------
const wavStore = new Map<string, Buffer>();

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  // CORS so the browser can fetch from a different origin (vite at :5173).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${SAMPLE_HTTP_PORT}`);
  const match = url.pathname.match(/^\/samples\/([A-Za-z0-9_-]+)\.wav$/);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const buf = wavStore.get(match[1]!);
  if (!buf) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('no such sample');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(buf.length) });
  res.end(buf);
});
httpServer.listen(SAMPLE_HTTP_PORT, '127.0.0.1', () => {
  console.error(`[librespot-host] sample server listening on http://127.0.0.1:${SAMPLE_HTTP_PORT}/samples/<name>.wav`);
});

// --- WAV encoder (16-bit mono) -------------------------------------------------
function encodeWavMono(pcm: Float32Array, sampleRate: number): Buffer {
  const dataSize = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  let o = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i] ?? 0));
    const v = s < 0 ? s * 0x8000 : s * 0x7fff;
    buf.writeInt16LE(v | 0, o);
    o += 2;
  }
  return buf;
}

// --- WebSocket client to bridge -----------------------------------------------
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
function bridgeSend(msg: BridgeMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connectBridge(): void {
  console.error(`[librespot-host] connecting to ${BRIDGE_URL}`);
  const sock = new WebSocket(BRIDGE_URL);
  ws = sock;
  sock.on('open', () => {
    console.error('[librespot-host] connected to bridge');
    bridgeSend({ type: 'hello', role: 'controller', clientId: 'librespot_host' });
  });
  sock.on('message', (data) => {
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(data.toString()) as BridgeMessage;
    } catch {
      return;
    }
    if (msg.type === 'sample.record_request' && (msg.stream ?? 'external') === 'external') {
      handleRecord(msg);
    } else if (msg.type === 'audio.spectrogram.request' && msg.stream === 'external') {
      handleSpectrogram(msg);
    } else if (msg.type === 'service.restart_request' && msg.target === 'librespot') {
      handleRestart(msg.requestId);
    }
  });
  sock.on('close', () => {
    if (ws === sock) ws = null;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectBridge();
      }, 1500);
    }
  });
  sock.on('error', (e) => {
    const m = (e as Error).message;
    if (m) console.error('[librespot-host] ws error:', m);
  });
}

// --- librespot spawn + PCM ingest ---------------------------------------------
const pipeline = new BrowserAudioPipeline({ stream: 'external', sampleRate: SAMPLE_RATE });

// Track silence-streaming behaviour: librespot streams silence when no track is
// playing. We log RMS occasionally so users can sanity-check the pipe.
let chunkCount = 0;

// librespot's --backend pipe writes PCM at "as-fast-as-the-receiver-reads"
// rate. If we read it as fast as Node allows, librespot's internal clock
// thinks the track is playing back ~10x faster than realtime and advances to
// the next song almost immediately. So we PACE the consumer at exactly real
// time (44100 frames/sec) by draining a queue every 50 ms and applying
// backpressure to stdout when the queue grows.

const STEREO_BYTES_PER_FRAME = 4;
const TICK_MS = 50;
const FRAMES_PER_TICK = Math.round((SAMPLE_RATE * TICK_MS) / 1000);
const BYTES_PER_TICK = FRAMES_PER_TICK * STEREO_BYTES_PER_FRAME;
const HIGH_WATER_BYTES = SAMPLE_RATE * STEREO_BYTES_PER_FRAME * 4; // ~4s
const LOW_WATER_BYTES = SAMPLE_RATE * STEREO_BYTES_PER_FRAME * 1; // ~1s

let queue: Buffer[] = [];
let queueBytes = 0;
let paused = false;
let leftover: Buffer = Buffer.alloc(0);

function enqueueFromStdout(child: ReturnType<typeof spawn>, chunk: Buffer): void {
  queue.push(chunk);
  queueBytes += chunk.length;
  if (!paused && queueBytes > HIGH_WATER_BYTES) {
    paused = true;
    child.stdout?.pause();
  }
}

function drainOneTick(child: ReturnType<typeof spawn>): void {
  if (queueBytes === 0) return;

  // Collect exactly BYTES_PER_TICK bytes (or all available) into a single buf,
  // prepending whatever leftover bytes we still owe from a previous partial frame.
  const wanted = BYTES_PER_TICK;
  const collected: Buffer[] = leftover.length > 0 ? [leftover] : [];
  let collectedBytes = leftover.length;
  leftover = Buffer.alloc(0);

  while (queue.length > 0 && collectedBytes < wanted) {
    const head = queue[0]!;
    if (collectedBytes + head.length <= wanted) {
      collected.push(head);
      collectedBytes += head.length;
      queue.shift();
      queueBytes -= head.length;
    } else {
      const need = wanted - collectedBytes;
      collected.push(head.subarray(0, need));
      queue[0] = head.subarray(need);
      collectedBytes += need;
      queueBytes -= need;
      break;
    }
  }

  if (collectedBytes === 0) return;
  const buf = Buffer.concat(collected, collectedBytes);
  const usable = buf.length - (buf.length % STEREO_BYTES_PER_FRAME);
  if (usable === 0) {
    leftover = buf;
    return;
  }
  if (usable < buf.length) leftover = Buffer.from(buf.subarray(usable));

  const samples = usable / STEREO_BYTES_PER_FRAME;
  const mono = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const offs = i * STEREO_BYTES_PER_FRAME;
    const l = buf.readInt16LE(offs);
    const r = buf.readInt16LE(offs + 2);
    mono[i] = ((l + r) * 0.5) / 0x8000;
  }
  const features = pipeline.pushChunk(mono);
  if (features) bridgeSend({ type: 'audio.features', features });

  chunkCount++;
  if (chunkCount % 40 === 0) {
    let max = 0;
    for (let i = 0; i < mono.length; i++) {
      const v = Math.abs(mono[i] ?? 0);
      if (v > max) max = v;
    }
    console.error(
      `[librespot-host] ticks=${chunkCount} peak=${max.toFixed(3)} queue=${(queueBytes / 1024).toFixed(0)}KiB`,
    );
  }

  if (paused && queueBytes < LOW_WATER_BYTES) {
    paused = false;
    child.stdout?.resume();
  }
}

function handleSpectrogram(req: Extract<BridgeMessage, { type: 'audio.spectrogram.request' }>): void {
  const seconds = Math.max(1, Math.min(30, req.seconds));
  const availableSec = pipeline.buffer.length / SAMPLE_RATE;
  if (availableSec < 0.5) {
    bridgeSend({
      type: 'audio.spectrogram.response',
      requestId: req.requestId,
      ok: false,
      error: `not enough audio buffered yet (${availableSec.toFixed(1)}s)`,
    });
    return;
  }
  try {
    const image = pipeline.renderSpectrogram(Math.min(seconds, availableSec));
    bridgeSend({
      type: 'audio.spectrogram.response',
      requestId: req.requestId,
      ok: true,
      image,
    });
    console.error(`[librespot-host] spectrogram rendered (${image.width}x${image.height}px, ${image.seconds.toFixed(1)}s)`);
  } catch (e) {
    bridgeSend({
      type: 'audio.spectrogram.response',
      requestId: req.requestId,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function handleRecord(req: Extract<BridgeMessage, { type: 'sample.record_request' }>): void {
  const name = req.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'sample';
  const wantedSamples = Math.max(1, Math.floor(SAMPLE_RATE * req.seconds));
  const available = pipeline.buffer.length;
  if (available < wantedSamples) {
    bridgeSend({
      type: 'sample.record_result',
      requestId: req.requestId,
      ok: false,
      stream: 'external',
      error: `not enough audio buffered yet (${(available / SAMPLE_RATE).toFixed(1)}s buffered, ${req.seconds}s requested) — start playback on the Strudel AI DJ device first`,
    });
    return;
  }
  const pcm = pipeline.buffer.readLast(wantedSamples);
  const wav = encodeWavMono(pcm, SAMPLE_RATE);
  wavStore.set(name, wav);
  const wavUrl = `http://127.0.0.1:${SAMPLE_HTTP_PORT}/samples/${name}.wav`;
  bridgeSend({
    type: 'sample.record_result',
    requestId: req.requestId,
    ok: true,
    stream: 'external',
    name,
    durationSec: req.seconds,
    sampleRate: SAMPLE_RATE,
    wavUrl,
  });
  console.error(`[librespot-host] sample "${name}" recorded (${req.seconds}s, ${wav.length} bytes) -> ${wavUrl}`);
}

// --- bootstrap -----------------------------------------------------------------
function loadSpotifyAccessToken(): string | null {
  try {
    const tokens = JSON.parse(
      readFileSync(join(homedir(), '.strudel-ai-dj', 'spotify.json'), 'utf8'),
    ) as { accessToken?: string; expiresAtMs?: number };
    if (tokens.accessToken && (tokens.expiresAtMs ?? 0) > Date.now() + 60_000) {
      return tokens.accessToken;
    }
  } catch {
    // no tokens, fall through
  }
  return null;
}

let currentChild: ReturnType<typeof spawn> | null = null;
let currentTicker: ReturnType<typeof setInterval> | null = null;
let expectingRestart = false;

function startLibrespot(): void {
  const bin = findBinary();
  // Discovery mode (default). Auth comes from the Spotify Connect handshake.
  // --disable-gapless: some users report this avoids the "alternatives not
  // found" error when Spotify tries to pre-stage the next track.
  const args = [
    '--name', DEVICE_NAME,
    '--bitrate', BITRATE,
    '--backend', 'pipe',
    '--format', 'S16',
    '--disable-gapless',
    '--zeroconf-port', '53092',
    '--cache', join(process.cwd(), 'bin', 'librespot-cache'),
  ];
  // mDNS announces on all interfaces by default. Caller can override via
  // LIBRESPOT_ZEROCONF_INTERFACE if Tailscale or other virtual interfaces
  // cause trouble.
  if (process.env['LIBRESPOT_ZEROCONF_INTERFACE']) {
    args.push('--zeroconf-interface', process.env['LIBRESPOT_ZEROCONF_INTERFACE']);
  }
  console.error(`[librespot-host] spawning ${bin} ${args.join(' ')}`);
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  currentChild = child;
  child.on('error', (e) => {
    console.error(`[librespot-host] failed to start librespot: ${e.message}`);
    console.error('[librespot-host] install instructions:');
    console.error('  cargo install librespot --version 0.7.1 --root ./bin');
    console.error('  or download a release at https://github.com/librespot-org/librespot/releases');
    if (!expectingRestart) process.exit(127);
  });
  child.on('exit', (code) => {
    console.error(`[librespot-host] librespot exited (code=${code})`);
    if (currentTicker) clearInterval(currentTicker);
    currentTicker = null;
    if (currentChild === child) currentChild = null;
    if (expectingRestart) {
      expectingRestart = false;
      // Reset audio state so the new child starts with an empty buffer.
      pipeline.buffer.clear();
      wavStore.clear();
      queue = [];
      queueBytes = 0;
      paused = false;
      leftover = Buffer.alloc(0);
      chunkCount = 0;
      setTimeout(() => startLibrespot(), 200);
    } else {
      process.exit(code ?? 0);
    }
  });
  child.stdout.on('data', (chunk: Buffer) => enqueueFromStdout(child, chunk));
  currentTicker = setInterval(() => drainOneTick(child), TICK_MS);
}

function handleRestart(requestId: string): void {
  console.error('[librespot-host] restart requested');
  expectingRestart = true;
  if (currentChild && !currentChild.killed) {
    currentChild.kill();
    bridgeSend({
      type: 'service.restart_result',
      requestId,
      ok: true,
      target: 'librespot',
      message: 'librespot restarting — Connect device will reappear in ~3-5 seconds',
    });
  } else {
    // No child running; start one now.
    startLibrespot();
    bridgeSend({
      type: 'service.restart_result',
      requestId,
      ok: true,
      target: 'librespot',
      message: 'librespot started',
    });
  }
}

const shutdown = (signal: string) => {
  console.error(`[librespot-host] ${signal} received, shutting down`);
  expectingRestart = false; // ensure exit
  if (currentChild && !currentChild.killed) currentChild.kill(signal as NodeJS.Signals);
  httpServer.close();
  ws?.close();
  setTimeout(() => process.exit(0), 250);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

connectBridge();
startLibrespot();
