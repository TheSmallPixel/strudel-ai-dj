export class OnsetDetector {
  private prevSpectrum: Float32Array;
  private threshold: number;
  private adaptiveMean = 0.001;
  private adaptiveVar = 0.001;
  private cooldownFrames = 0;
  private recentOnsetTimes: number[] = [];

  constructor(spectrumSize: number, threshold = 1.6) {
    this.prevSpectrum = new Float32Array(spectrumSize);
    this.threshold = threshold;
  }

  process(spectrum: Float32Array, timeSec: number, frameDurSec: number): boolean {
    let flux = 0;
    for (let i = 0; i < spectrum.length; i++) {
      const diff = spectrum[i]! - this.prevSpectrum[i]!;
      if (diff > 0) flux += diff;
      this.prevSpectrum[i] = spectrum[i]!;
    }

    const alpha = 0.05;
    this.adaptiveMean = this.adaptiveMean * (1 - alpha) + flux * alpha;
    const sqDev = (flux - this.adaptiveMean) ** 2;
    this.adaptiveVar = this.adaptiveVar * (1 - alpha) + sqDev * alpha;
    const std = Math.sqrt(this.adaptiveVar);
    const dynamicThreshold = this.adaptiveMean + this.threshold * std;

    if (this.cooldownFrames > 0) {
      this.cooldownFrames--;
      return false;
    }
    if (flux > dynamicThreshold && flux > 0.01) {
      this.cooldownFrames = Math.max(2, Math.round(0.04 / frameDurSec));
      this.recentOnsetTimes.push(timeSec);
      const windowStart = timeSec - 1.0;
      while (this.recentOnsetTimes.length > 0 && this.recentOnsetTimes[0]! < windowStart) {
        this.recentOnsetTimes.shift();
      }
      return true;
    }
    return false;
  }

  get onsetsPerSecond(): number {
    return this.recentOnsetTimes.length;
  }

  get recentOnsetTimestamps(): readonly number[] {
    return this.recentOnsetTimes;
  }
}
