import {
  DEFAULT_BEATS_PER_BAR,
  DEFAULT_BPM,
  barDurationMs,
  makeTransport,
  type Transport,
} from '@strudel-ai-dj/dj-core';

export class BarClock {
  private transport: Transport;
  private listeners = new Set<(t: Transport) => void>();
  private rafHandle: ReturnType<typeof setInterval> | null = null;

  constructor(bpm = DEFAULT_BPM, beatsPerBar = DEFAULT_BEATS_PER_BAR) {
    this.transport = makeTransport(bpm, beatsPerBar);
  }

  get state(): Transport {
    return { ...this.transport };
  }

  start(): void {
    if (this.transport.isPlaying) return;
    this.transport.isPlaying = true;
    this.transport.setStartedAtMs = Date.now();
    this.tick();
    this.rafHandle = setInterval(() => this.tick(), 25);
  }

  stop(): void {
    this.transport.isPlaying = false;
    if (this.rafHandle !== null) {
      clearInterval(this.rafHandle);
      this.rafHandle = null;
    }
  }

  setBpm(bpm: number): void {
    if (bpm < 30 || bpm > 240) {
      throw new Error(`BPM out of range: ${bpm}`);
    }
    this.transport.bpm = bpm;
  }

  setBeatsPerBar(beats: number): void {
    if (beats < 1 || beats > 16) throw new Error(`Bad beatsPerBar: ${beats}`);
    this.transport.beatsPerBar = beats;
  }

  externalTransportUpdate(partial: Partial<Transport>): void {
    Object.assign(this.transport, partial);
    this.emit();
  }

  onTick(fn: (t: Transport) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private tick(): void {
    if (!this.transport.isPlaying || this.transport.setStartedAtMs === null) return;
    const now = Date.now();
    this.transport.elapsedMs = now - this.transport.setStartedAtMs;
    const barMs = barDurationMs(this.transport.bpm, this.transport.beatsPerBar);
    const totalBars = this.transport.elapsedMs / barMs;
    this.transport.bar = Math.floor(totalBars);
    const fracBar = totalBars - this.transport.bar;
    this.transport.beat = Math.floor(fracBar * this.transport.beatsPerBar);
    this.transport.phase = fracBar;
    this.emit();
  }

  private emit(): void {
    const snap = this.state;
    for (const fn of this.listeners) fn(snap);
  }
}
