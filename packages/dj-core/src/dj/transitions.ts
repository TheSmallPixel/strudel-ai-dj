export interface TransitionPlan {
  toCode: string;
  durationBars: number;
  style: TransitionStyle;
  startAtBar: number;
}

export type TransitionStyle = 'filter_sweep' | 'cut' | 'drop' | 'roll_in' | 'backspin' | 'fade';

export interface LayerInPlan {
  slot: string;
  code: string;
  rampBars: number;
  startAtBar: number;
}

export interface DropPlan {
  preDropBars: number;
  postDropBars: number;
  startAtBar: number;
}

export function nextPhraseBoundary(currentBar: number, phraseLength = 16): number {
  return Math.ceil((currentBar + 1) / phraseLength) * phraseLength;
}

export function alignToPhrase(targetBar: number, phraseLength = 16): number {
  return Math.ceil(targetBar / phraseLength) * phraseLength;
}

export function planTransition(args: {
  currentBar: number;
  toCode: string;
  durationBars?: number;
  style?: TransitionStyle;
  phraseLength?: number;
}): TransitionPlan {
  const durationBars = args.durationBars ?? 16;
  const style = args.style ?? 'filter_sweep';
  const startAtBar = nextPhraseBoundary(args.currentBar, args.phraseLength ?? 16);
  return { toCode: args.toCode, durationBars, style, startAtBar };
}

export function planLayerIn(args: {
  currentBar: number;
  slot: string;
  code: string;
  rampBars?: number;
  phraseLength?: number;
}): LayerInPlan {
  const rampBars = args.rampBars ?? 8;
  const startAtBar = nextPhraseBoundary(args.currentBar, args.phraseLength ?? 8);
  return { slot: args.slot, code: args.code, rampBars, startAtBar };
}

export function planDrop(args: {
  currentBar: number;
  preDropBars?: number;
  postDropBars?: number;
}): DropPlan {
  const preDropBars = args.preDropBars ?? 4;
  const postDropBars = args.postDropBars ?? 32;
  const startAtBar = nextPhraseBoundary(args.currentBar, 16);
  return { preDropBars, postDropBars, startAtBar };
}
