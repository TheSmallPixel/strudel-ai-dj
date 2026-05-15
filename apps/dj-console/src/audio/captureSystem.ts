import { BrowserAudioPipeline, WORKLET_SRC } from '@strudel-ai-dj/audio-input';
import type { AudioFeatures } from '@strudel-ai-dj/dj-core';

export interface CaptureHandle {
  stop(): void;
  pipeline: BrowserAudioPipeline;
  sampleRate: number;
}

/**
 * Capture system audio via `getDisplayMedia({audio:true})`. The user picks
 * which tab/window/system source to share. Audio frames are RAM-only,
 * fed into the feature extractor; nothing is persisted.
 */
export async function startSystemCapture(
  onFeatures: (features: AudioFeatures) => void,
): Promise<CaptureHandle> {
  if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getDisplayMedia) {
    throw new Error('getDisplayMedia not supported in this browser');
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: { width: 1, height: 1 },
  });
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('No audio track in shared source. Pick "share tab audio" / "share system audio".');
  }
  for (const t of stream.getVideoTracks()) t.stop();

  const audioStream = new MediaStream(audioTracks);
  const ctx = new AudioContext();
  const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(url);

  const source = ctx.createMediaStreamSource(audioStream);
  const node = new AudioWorkletNode(ctx, 'strudel-ai-dj-capture');
  const pipeline = new BrowserAudioPipeline({ stream: 'system', sampleRate: ctx.sampleRate });
  node.port.onmessage = (ev) => {
    const buf = ev.data as Float32Array;
    const features = pipeline.pushChunk(buf);
    if (features) onFeatures(features);
  };
  source.connect(node);
  const silent = ctx.createGain();
  silent.gain.value = 0;
  node.connect(silent).connect(ctx.destination);

  return {
    pipeline,
    sampleRate: ctx.sampleRate,
    stop() {
      source.disconnect();
      node.disconnect();
      silent.disconnect();
      for (const t of audioStream.getTracks()) t.stop();
      void ctx.close();
      URL.revokeObjectURL(url);
    },
  };
}
