export interface PatternSlot {
  id: string;
  code: string;
  gain: number;
  muted: boolean;
}

export interface ScheduledEvent {
  bar: number;
  beat: number;
  duration: number;
  voice: string;
  note?: string;
  sample?: string;
  gain?: number;
}

export interface StrudelIntrospection {
  patternCode: string;
  bpm: number;
  activeSlots: PatternSlot[];
  scheduledEvents: ScheduledEvent[];
  notesPerBar: number;
  voiceCount: number;
  predictedBandEnergy: { low: number; mid: number; high: number };
}
