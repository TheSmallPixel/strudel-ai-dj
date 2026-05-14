export interface TempoEstimate {
  bpm: number | null;
  confidence: number;
}

export class TempoEstimator {
  private onsetTimes: number[] = [];
  private minBpm = 70;
  private maxBpm = 200;

  addOnset(timeSec: number): void {
    this.onsetTimes.push(timeSec);
    const windowStart = timeSec - 8;
    while (this.onsetTimes.length > 0 && this.onsetTimes[0]! < windowStart) {
      this.onsetTimes.shift();
    }
  }

  estimate(): TempoEstimate {
    if (this.onsetTimes.length < 4) return { bpm: null, confidence: 0 };
    const intervals: number[] = [];
    for (let i = 1; i < this.onsetTimes.length; i++) {
      intervals.push(this.onsetTimes[i]! - this.onsetTimes[i - 1]!);
    }
    const binWidth = 0.01;
    const histogram = new Map<number, number>();
    for (const iv of intervals) {
      if (iv <= 0) continue;
      const bpm = 60 / iv;
      if (bpm < this.minBpm || bpm > this.maxBpm) continue;
      const bin = Math.round(bpm / binWidth) * binWidth;
      histogram.set(bin, (histogram.get(bin) ?? 0) + 1);
    }
    if (histogram.size === 0) return { bpm: null, confidence: 0 };
    let bestBpm = 0;
    let bestCount = 0;
    for (const [bpm, count] of histogram) {
      if (count > bestCount) {
        bestBpm = bpm;
        bestCount = count;
      }
    }
    const confidence = Math.min(1, bestCount / Math.max(1, intervals.length));
    return { bpm: bestBpm, confidence };
  }
}
