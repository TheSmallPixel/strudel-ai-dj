export interface SetPhase {
  name: string;
  targetBpmRange: [number, number];
  targetEnergy: number;
  keyPlan: string;
  mood: string;
  visualMood: string;
  expectedDurationMin: number;
}

export interface SetPlan {
  totalDurationMin: number;
  seedVibe: string;
  constraints: {
    bpmRange?: [number, number];
    keyPreferences?: string[];
    bannedMoves?: string[];
    energyCeiling?: number;
  };
  phases: SetPhase[];
  generatedAtMs: number;
  currentPhaseIndex: number;
}

export interface VibeJournalEntry {
  timestampMs: number;
  bar: number;
  decision: string;
  reason: string;
  toolCalls: { tool: string; args: Record<string, unknown> }[];
  outcomeNote?: string;
}

export interface Bookmark {
  id: string;
  label: string;
  timestampMs: number;
  bar: number;
  patternCode: string;
  bpm: number;
  trackUri?: string;
}
