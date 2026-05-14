export interface Transport {
  bpm: number;
  beatsPerBar: number;
  bar: number;
  beat: number;
  phase: number;
  setStartedAtMs: number | null;
  elapsedMs: number;
  isPlaying: boolean;
}

export function makeTransport(bpm = 120, beatsPerBar = 4): Transport {
  return {
    bpm,
    beatsPerBar,
    bar: 0,
    beat: 0,
    phase: 0,
    setStartedAtMs: null,
    elapsedMs: 0,
    isPlaying: false,
  };
}

export function barDurationMs(bpm: number, beatsPerBar: number): number {
  return (60_000 / bpm) * beatsPerBar;
}
