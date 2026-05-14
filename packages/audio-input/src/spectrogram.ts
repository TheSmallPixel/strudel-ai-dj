import { SPECTROGRAM_MEL_BINS, type AudioStreamId, type SpectrogramImage } from '@strudel-ai-dj/dj-core';
import { RealFFT } from './fft.js';
import { FloatRingBuffer } from './ring-buffer.js';

export interface SpectrogramOptions {
  sampleRate: number;
  fftSize?: number;
  hopSize?: number;
  melBins?: number;
  fMin?: number;
  fMax?: number;
}

export class SpectrogramRenderer {
  private fft: RealFFT;
  private fftSize: number;
  private hopSize: number;
  private melBins: number;
  private melFilters: Float32Array[];
  private window: Float32Array;
  private real: Float32Array;
  private imag: Float32Array;
  private mags: Float32Array;
  private sampleRate: number;

  constructor(opts: SpectrogramOptions) {
    this.sampleRate = opts.sampleRate;
    this.fftSize = opts.fftSize ?? 1024;
    this.hopSize = opts.hopSize ?? 256;
    this.melBins = opts.melBins ?? SPECTROGRAM_MEL_BINS;
    this.fft = new RealFFT(this.fftSize);
    this.real = new Float32Array(this.fftSize);
    this.imag = new Float32Array(this.fftSize);
    this.mags = new Float32Array(this.fftSize / 2);
    this.window = makeHann(this.fftSize);
    this.melFilters = makeMelFilters(
      this.melBins,
      this.fftSize,
      opts.sampleRate,
      opts.fMin ?? 60,
      opts.fMax ?? Math.min(opts.sampleRate / 2, 12000),
    );
  }

  render(stream: AudioStreamId, buffer: FloatRingBuffer, seconds: number): SpectrogramImage {
    const samples = Math.min(Math.floor(this.sampleRate * seconds), buffer.length);
    const data = buffer.readLast(samples);
    const frames = Math.max(1, Math.floor((data.length - this.fftSize) / this.hopSize) + 1);
    const mel = new Float32Array(frames * this.melBins);
    let maxVal = 1e-9;
    for (let f = 0; f < frames; f++) {
      const offset = f * this.hopSize;
      for (let i = 0; i < this.fftSize; i++) {
        const idx = offset + i;
        this.real[i] = idx < data.length ? data[idx]! * this.window[i]! : 0;
        this.imag[i] = 0;
      }
      this.fft.forward(this.real, this.imag);
      this.fft.magnitudes(this.real, this.imag, this.mags);
      for (let m = 0; m < this.melBins; m++) {
        const filter = this.melFilters[m]!;
        let sum = 0;
        for (let k = 0; k < this.mags.length; k++) sum += this.mags[k]! * filter[k]!;
        const v = Math.log(1e-6 + sum);
        mel[f * this.melBins + m] = v;
        if (v > maxVal) maxVal = v;
      }
    }
    return {
      stream,
      seconds,
      pngBase64: encodePng(mel, frames, this.melBins, maxVal),
      width: frames,
      height: this.melBins,
    };
  }
}

function makeHann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

function makeMelFilters(
  bins: number,
  fftSize: number,
  sampleRate: number,
  fMin: number,
  fMax: number,
): Float32Array[] {
  const melMin = hzToMel(fMin);
  const melMax = hzToMel(fMax);
  const melPoints = new Float32Array(bins + 2);
  for (let i = 0; i < bins + 2; i++) melPoints[i] = melMin + (i / (bins + 1)) * (melMax - melMin);
  const hzPoints = Array.from(melPoints).map(melToHz);
  const binHz = sampleRate / fftSize;
  const filters: Float32Array[] = [];
  const halfN = fftSize / 2;
  for (let m = 1; m <= bins; m++) {
    const filter = new Float32Array(halfN);
    const lower = hzPoints[m - 1]!;
    const center = hzPoints[m]!;
    const upper = hzPoints[m + 1]!;
    for (let k = 0; k < halfN; k++) {
      const f = k * binHz;
      if (f < lower || f > upper) continue;
      if (f <= center) filter[k] = (f - lower) / (center - lower + 1e-9);
      else filter[k] = (upper - f) / (upper - center + 1e-9);
    }
    filters.push(filter);
  }
  return filters;
}

function encodePng(
  mel: Float32Array,
  width: number,
  height: number,
  maxVal: number,
): string {
  const pixels = new Uint8Array(width * height * 4);
  for (let f = 0; f < width; f++) {
    for (let m = 0; m < height; m++) {
      const v = mel[f * height + m]!;
      const norm = Math.max(0, Math.min(1, (v + 6) / (maxVal + 6 + 1e-9)));
      const y = height - 1 - m;
      const [r, g, b] = viridis(norm);
      const i = (y * width + f) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }
  return encodePngFromRgba(pixels, width, height);
}

function viridis(t: number): [number, number, number] {
  const r = Math.round(255 * Math.max(0, Math.min(1, 0.267 + 0.005 * t + 0.700 * t * t)));
  const g = Math.round(255 * Math.max(0, Math.min(1, 0.005 + 0.940 * t - 0.150 * t * t)));
  const b = Math.round(255 * Math.max(0, Math.min(1, 0.330 + 0.450 * (1 - t) - 0.500 * t * t)));
  return [r, g, b];
}

function encodePngFromRgba(rgba: Uint8Array, width: number, height: number): string {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = chunk('IHDR', concatBytes([uint32(width), uint32(height), new Uint8Array([8, 6, 0, 0, 0])]));
  const filtered = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    filtered[y * (1 + width * 4)] = 0;
    filtered.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const idat = chunk('IDAT', zlibStore(filtered));
  const iend = chunk('IEND', new Uint8Array(0));
  const all = concatBytes([sig, ihdr, idat, iend]);
  return bytesToBase64(all);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new Uint8Array(4);
  for (let i = 0; i < 4; i++) t[i] = type.charCodeAt(i);
  const out = concatBytes([uint32(data.length), t, data]);
  const crc = crc32(concatBytes([t, data]));
  return concatBytes([out, uint32(crc)]);
}

function uint32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function zlibStore(data: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x01];
  const maxBlock = 65535;
  let i = 0;
  while (i < data.length) {
    const block = Math.min(maxBlock, data.length - i);
    const last = i + block >= data.length ? 1 : 0;
    out.push(last);
    out.push(block & 0xff, (block >>> 8) & 0xff);
    const nlen = ~block & 0xffff;
    out.push(nlen & 0xff, (nlen >>> 8) & 0xff);
    for (let j = 0; j < block; j++) out.push(data[i + j]!);
    i += block;
  }
  const adler = adler32(data);
  out.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);
  return new Uint8Array(out);
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return (b << 16) | a;
}

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = (CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bytes).toString('base64');
}
