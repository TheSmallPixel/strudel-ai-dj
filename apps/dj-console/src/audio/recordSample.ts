import type { BrowserAudioPipeline } from '@strudel-ai-dj/audio-input';

/**
 * Singleton registry of named audio pipelines that the AudioPanel's
 * `sample.record_request` handler can pick from. Currently:
 *   - "system" — set when the user clicks "start system capture"
 *   - "external" — set when the Spotify Web Playback SDK tap is active
 */
const pipelineRegistry: Record<string, { pipeline: BrowserAudioPipeline; sampleRate: number } | null> = {};

export function registerPipeline(stream: string, p: { pipeline: BrowserAudioPipeline; sampleRate: number } | null): void {
  pipelineRegistry[stream] = p;
}

export function getRegisteredPipeline(stream: string): { pipeline: BrowserAudioPipeline; sampleRate: number } | null {
  return pipelineRegistry[stream] ?? null;
}

/** Encode 16-bit PCM mono WAV from a Float32 buffer. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numSamples = samples.length;
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export interface RecordedSample {
  name: string;
  url: string;
  blob: Blob;
  durationSec: number;
  sampleRate: number;
  recordedAtMs: number;
}

declare global {
  interface Window {
    __strudelSamples?: Record<string, RecordedSample>;
  }
}

function normalizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'sample';
}

/** Read the last N seconds from the pipeline's PCM ring buffer and encode as WAV. */
export function snapshotPcm(pipeline: BrowserAudioPipeline, sampleRate: number, seconds: number): Float32Array {
  const wanted = Math.max(1, Math.floor(sampleRate * seconds));
  return pipeline.buffer.readLast(wanted);
}

/** Register a recorded sample with Strudel so it's playable via s("name"). */
export async function registerSample(name: string, blob: Blob, sampleRate: number, durationSec: number): Promise<RecordedSample> {
  const normalized = normalizeName(name);
  const url = URL.createObjectURL(blob);
  // Strudel's `samples()` accepts an object {name: url}. We expose it via window.strudel
  // which our StrudelPanel populates on init.
  const samples = (window as unknown as { strudel?: { samples?: (src: unknown) => Promise<void> | void } })
    .strudel?.samples;
  if (typeof samples !== 'function') throw new Error('Strudel samples() not available');
  await samples({ [normalized]: url });

  const record: RecordedSample = {
    name: normalized,
    url,
    blob,
    durationSec,
    sampleRate,
    recordedAtMs: Date.now(),
  };
  if (!window.__strudelSamples) window.__strudelSamples = {};
  // Revoke previous URL for the same name to avoid leak.
  const prev = window.__strudelSamples[normalized];
  if (prev) URL.revokeObjectURL(prev.url);
  window.__strudelSamples[normalized] = record;
  return record;
}

export function listSamples(): RecordedSample[] {
  return Object.values(window.__strudelSamples ?? {});
}

/**
 * Register a sample given an externally-hosted WAV URL (e.g. served by the
 * librespot-host's local HTTP server at http://127.0.0.1:7779). The browser
 * does not need to fetch the bytes — Strudel will fetch on demand via the URL.
 */
export async function registerSampleFromUrl(
  name: string,
  url: string,
  sampleRate: number,
  durationSec: number,
): Promise<RecordedSample> {
  const normalized = normalizeName(name);
  const samples = (window as unknown as { strudel?: { samples?: (src: unknown) => Promise<void> | void } })
    .strudel?.samples;
  if (typeof samples !== 'function') throw new Error('Strudel samples() not available');
  await samples({ [normalized]: url });

  // For listSamples()/diagnostic purposes only — we store a minimal record. We
  // don't have the actual Blob since the URL is external.
  const record: RecordedSample = {
    name: normalized,
    url,
    blob: new Blob([], { type: 'audio/wav' }),
    durationSec,
    sampleRate,
    recordedAtMs: Date.now(),
  };
  if (!window.__strudelSamples) window.__strudelSamples = {};
  window.__strudelSamples[normalized] = record;
  return record;
}
