export class FloatRingBuffer {
  private buffer: Float32Array;
  private writeIdx = 0;
  private filled = false;

  constructor(public readonly capacity: number) {
    this.buffer = new Float32Array(capacity);
  }

  write(samples: Float32Array): void {
    const n = samples.length;
    if (n >= this.capacity) {
      this.buffer.set(samples.subarray(n - this.capacity));
      this.writeIdx = 0;
      this.filled = true;
      return;
    }
    const space = this.capacity - this.writeIdx;
    if (n <= space) {
      this.buffer.set(samples, this.writeIdx);
      this.writeIdx += n;
      if (this.writeIdx === this.capacity) {
        this.writeIdx = 0;
        this.filled = true;
      }
    } else {
      this.buffer.set(samples.subarray(0, space), this.writeIdx);
      this.buffer.set(samples.subarray(space), 0);
      this.writeIdx = n - space;
      this.filled = true;
    }
  }

  readLast(n: number, out?: Float32Array): Float32Array {
    const count = Math.min(n, this.length);
    const dst = out ?? new Float32Array(count);
    const start = (this.writeIdx - count + this.capacity) % this.capacity;
    if (start + count <= this.capacity) {
      dst.set(this.buffer.subarray(start, start + count));
    } else {
      const firstPart = this.capacity - start;
      dst.set(this.buffer.subarray(start), 0);
      dst.set(this.buffer.subarray(0, count - firstPart), firstPart);
    }
    return dst;
  }

  get length(): number {
    return this.filled ? this.capacity : this.writeIdx;
  }

  clear(): void {
    this.buffer.fill(0);
    this.writeIdx = 0;
    this.filled = false;
  }
}
