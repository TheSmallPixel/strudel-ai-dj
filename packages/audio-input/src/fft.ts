export class RealFFT {
  private readonly n: number;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly reversed: Uint32Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.n = size;
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.reversed = new Uint32Array(size);
    let logN = 0;
    for (let s = size; s > 1; s >>>= 1) logN++;
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let j = 0; j < logN; j++) if (i & (1 << j)) r |= 1 << (logN - 1 - j);
      this.reversed[i] = r;
    }
  }

  forward(real: Float32Array, imag: Float32Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.reversed[i]!;
      if (j > i) {
        const tr = real[i]!;
        real[i] = real[j]!;
        real[j] = tr;
        const ti = imag[i]!;
        imag[i] = imag[j]!;
        imag[j] = ti;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >>> 1;
      const tableStride = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += tableStride) {
          const tre = this.cos[k]! * real[j + half]! - this.sin[k]! * imag[j + half]!;
          const tim = this.cos[k]! * imag[j + half]! + this.sin[k]! * real[j + half]!;
          real[j + half] = real[j]! - tre;
          imag[j + half] = imag[j]! - tim;
          real[j] = real[j]! + tre;
          imag[j] = imag[j]! + tim;
        }
      }
    }
  }

  magnitudes(real: Float32Array, imag: Float32Array, out?: Float32Array): Float32Array {
    const n = this.n / 2;
    const mag = out ?? new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const re = real[i]!;
      const im = imag[i]!;
      mag[i] = Math.sqrt(re * re + im * im);
    }
    return mag;
  }

  get size(): number {
    return this.n;
  }
}
