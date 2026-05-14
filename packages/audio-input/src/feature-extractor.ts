import { emptyFeatures, type AudioFeatures, type AudioStreamId } from '@strudel-ai-dj/dj-core';
import { RealFFT } from './fft.js';
import { OnsetDetector } from './onset-detector.js';
import { TempoEstimator } from './tempo-estimator.js';

export interface FeatureExtractorOptions {
  stream: AudioStreamId;
  sampleRate: number;
  fftSize?: number;
  hopSize?: number;
}

export class FeatureExtractor {
  private fft: RealFFT;
  private fftSize: number;
  private hopSize: number;
  private real: Float32Array;
  private imag: Float32Array;
  private magnitudes: Float32Array;
  private window: Float32Array;
  private inputBuffer: Float32Array;
  private inputFill = 0;
  private onsetDetector: OnsetDetector;
  private tempoEstimator = new TempoEstimator();
  private elapsedSamples = 0;
  private peak = 0;
  private peakDecay = 0.995;
  private readonly options: FeatureExtractorOptions;

  constructor(options: FeatureExtractorOptions) {
    this.options = options;
    this.fftSize = options.fftSize ?? 2048;
    this.hopSize = options.hopSize ?? 512;
    this.fft = new RealFFT(this.fftSize);
    this.real = new Float32Array(this.fftSize);
    this.imag = new Float32Array(this.fftSize);
    this.magnitudes = new Float32Array(this.fftSize / 2);
    this.window = makeHannWindow(this.fftSize);
    this.inputBuffer = new Float32Array(this.fftSize);
    this.onsetDetector = new OnsetDetector(this.fftSize / 2);
  }

  push(chunk: Float32Array, perSampleResult?: (features: AudioFeatures) => void): AudioFeatures | null {
    let last: AudioFeatures | null = null;
    let i = 0;
    while (i < chunk.length) {
      const space = this.fftSize - this.inputFill;
      const take = Math.min(space, chunk.length - i);
      this.inputBuffer.set(chunk.subarray(i, i + take), this.inputFill);
      this.inputFill += take;
      i += take;
      this.elapsedSamples += take;
      if (this.inputFill >= this.fftSize) {
        const features = this.computeFrame();
        last = features;
        if (perSampleResult) perSampleResult(features);
        this.inputBuffer.copyWithin(0, this.hopSize);
        this.inputFill = this.fftSize - this.hopSize;
      }
    }
    return last;
  }

  private computeFrame(): AudioFeatures {
    const sr = this.options.sampleRate;
    let sumSq = 0;
    let frameMax = 0;
    for (let n = 0; n < this.fftSize; n++) {
      const sample = this.inputBuffer[n]!;
      sumSq += sample * sample;
      const abs = Math.abs(sample);
      if (abs > frameMax) frameMax = abs;
      this.real[n] = sample * this.window[n]!;
      this.imag[n] = 0;
    }
    this.peak = Math.max(this.peak * this.peakDecay, frameMax);
    const rms = Math.sqrt(sumSq / this.fftSize);

    this.fft.forward(this.real, this.imag);
    this.fft.magnitudes(this.real, this.imag, this.magnitudes);

    const binHz = sr / this.fftSize;
    let weighted = 0;
    let total = 0;
    let lowSum = 0;
    let midSum = 0;
    let highSum = 0;
    let logProdSum = 0;
    let validBins = 0;
    for (let k = 0; k < this.magnitudes.length; k++) {
      const m = this.magnitudes[k]!;
      const f = k * binHz;
      weighted += f * m;
      total += m;
      if (f < 200) lowSum += m;
      else if (f < 2000) midSum += m;
      else highSum += m;
      if (m > 1e-6) {
        logProdSum += Math.log(m);
        validBins++;
      }
    }
    const centroid = total > 0 ? weighted / total : 0;
    const bandTotal = lowSum + midSum + highSum + 1e-9;
    const lowEnergy = lowSum / bandTotal;
    const midEnergy = midSum / bandTotal;
    const highEnergy = highSum / bandTotal;
    const geomMean = validBins > 0 ? Math.exp(logProdSum / validBins) : 0;
    const arithMean = total / this.magnitudes.length;
    const flatness = arithMean > 0 ? geomMean / arithMean : 0;

    const timeSec = this.elapsedSamples / sr;
    const frameDurSec = this.hopSize / sr;
    const isOnset = this.onsetDetector.process(this.magnitudes, timeSec, frameDurSec);
    if (isOnset) this.tempoEstimator.addOnset(timeSec);
    const tempo = this.tempoEstimator.estimate();

    const features: AudioFeatures = {
      stream: this.options.stream,
      timestampMs: timeSec * 1000,
      rms,
      peak: this.peak,
      spectralCentroidHz: centroid,
      spectralFlatness: flatness,
      onsetDensityPerSec: this.onsetDetector.onsetsPerSecond,
      tempoEstimateBpm: tempo.bpm,
      tempoConfidence: tempo.confidence,
      keyEstimate: null,
      lowEnergy,
      midEnergy,
      highEnergy,
    };
    return features;
  }

  reset(): void {
    this.inputBuffer.fill(0);
    this.inputFill = 0;
    this.elapsedSamples = 0;
    this.peak = 0;
  }

  static makeEmpty(stream: AudioStreamId): AudioFeatures {
    return emptyFeatures(stream);
  }
}

function makeHannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}
