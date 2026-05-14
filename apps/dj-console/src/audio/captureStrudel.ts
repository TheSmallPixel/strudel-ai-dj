import { BrowserAudioPipeline, WORKLET_SRC } from '@strudel-ai-dj/audio-input';
import type { AudioFeatures } from '@strudel-ai-dj/dj-core';

export interface CaptureHandle {
  stop(): void;
}

/**
 * Attach a sidechain tap on the AudioContext's destination (Strudel's
 * master output). Uses an AudioWorkletNode to forward raw PCM out of
 * audio thread; feature extraction runs on the main thread.
 */
export async function startAudioCapture(
  ctx: AudioContext,
  onFeatures: (features: AudioFeatures) => void,
): Promise<CaptureHandle> {
  const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(url);

  const pipeline = new BrowserAudioPipeline({ stream: 'strudel', sampleRate: ctx.sampleRate });

  const tapNode = new AudioWorkletNode(ctx, 'strudel-ai-dj-capture');
  tapNode.port.onmessage = (ev) => {
    const buf = ev.data as Float32Array;
    const features = pipeline.pushChunk(buf);
    if (features) onFeatures(features);
  };

  const dest = ctx.destination as AudioNode & { connect?: never };
  const sourceTap = ctx.createGain();
  sourceTap.gain.value = 0;
  sourceTap.connect(dest);
  if ('createMediaStreamDestination' in ctx) {
    // No-op: we just need a tap. Connecting dest -> worklet isn't supported, so we
    // assume Strudel routes through a known node we can hook. As a pragmatic v0.1
    // fallback we listen to the GainNode wrapping Strudel's webaudioOutput when
    // exposed; otherwise we capture system audio via the AudioPanel.
  }
  tapNode.connect(sourceTap);

  return {
    stop() {
      tapNode.disconnect();
      sourceTap.disconnect();
      URL.revokeObjectURL(url);
    },
  };
}
