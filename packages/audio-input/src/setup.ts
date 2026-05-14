import type { AudioStreamId } from '@strudel-ai-dj/dj-core';
import { FeatureExtractor } from './feature-extractor.js';
import { FloatRingBuffer } from './ring-buffer.js';
import { SpectrogramRenderer } from './spectrogram.js';

export interface AudioPipelineHandlers {
  onFeatures(features: ReturnType<FeatureExtractor['push']>): void;
}

export interface BrowserAudioPipelineOptions {
  stream: AudioStreamId;
  sampleRate: number;
  bufferSeconds?: number;
  fftSize?: number;
  hopSize?: number;
}

export class BrowserAudioPipeline {
  readonly buffer: FloatRingBuffer;
  readonly extractor: FeatureExtractor;
  readonly spectrogram: SpectrogramRenderer;
  readonly stream: AudioStreamId;

  constructor(opts: BrowserAudioPipelineOptions) {
    const seconds = opts.bufferSeconds ?? 30;
    const capacity = Math.ceil(opts.sampleRate * seconds);
    this.buffer = new FloatRingBuffer(capacity);
    const extractorOpts: ConstructorParameters<typeof FeatureExtractor>[0] = {
      stream: opts.stream,
      sampleRate: opts.sampleRate,
    };
    if (opts.fftSize !== undefined) extractorOpts.fftSize = opts.fftSize;
    if (opts.hopSize !== undefined) extractorOpts.hopSize = opts.hopSize;
    this.extractor = new FeatureExtractor(extractorOpts);
    this.spectrogram = new SpectrogramRenderer({ sampleRate: opts.sampleRate });
    this.stream = opts.stream;
  }

  pushChunk(chunk: Float32Array) {
    this.buffer.write(chunk);
    return this.extractor.push(chunk);
  }

  renderSpectrogram(seconds: number) {
    return this.spectrogram.render(this.stream, this.buffer, seconds);
  }
}

/**
 * AudioWorklet processor source. Stringified for inline registration
 * via `URL.createObjectURL(new Blob([WORKLET_SRC], {type:'application/javascript'}))`.
 */
export const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._collected = new Float32Array(0);
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;
    this.port.postMessage(channel.slice(), [channel.buffer]);
    return true;
  }
}
registerProcessor('strudel-ai-dj-capture', CaptureProcessor);
`;
