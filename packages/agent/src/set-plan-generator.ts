import type { SetPhase, SetPlan } from '@strudel-ai-dj/dj-core';

export interface SetPlanInputs {
  totalDurationMin: number;
  seedVibe: string;
  constraints?: SetPlan['constraints'];
}

/**
 * Fallback set plan when the LLM-driven generator isn't available.
 * A reasonable 3-hour arc; phases scale to the requested duration.
 */
export function defaultSetPlan(inputs: SetPlanInputs): SetPlan {
  const total = inputs.totalDurationMin;
  const scale = total / 180;
  const phases: SetPhase[] = [
    {
      name: 'warmup',
      targetBpmRange: [88, 100],
      targetEnergy: 0.35,
      keyPlan: 'Am modal',
      mood: 'warm, sparse, deep',
      visualMood: 'liquid gradients, deep purples',
      expectedDurationMin: 30 * scale,
    },
    {
      name: 'groove',
      targetBpmRange: [110, 124],
      targetEnergy: 0.55,
      keyPlan: 'Am -> Dm modulation',
      mood: 'rolling, percussive, hypnotic',
      visualMood: 'rotating geometry, slow strobing',
      expectedDurationMin: 50 * scale,
    },
    {
      name: 'peak',
      targetBpmRange: [128, 138],
      targetEnergy: 0.85,
      keyPlan: 'Dm minor pentatonic',
      mood: 'driving, dense, payoff',
      visualMood: 'sharp white-on-black strobing, fast modulation',
      expectedDurationMin: 60 * scale,
    },
    {
      name: 'comedown',
      targetBpmRange: [90, 110],
      targetEnergy: 0.4,
      keyPlan: 'Am modal -> C major',
      mood: 'ambient, lush, resolving',
      visualMood: 'soft gradients, no strobe',
      expectedDurationMin: 40 * scale,
    },
  ];
  return {
    totalDurationMin: total,
    seedVibe: inputs.seedVibe,
    constraints: inputs.constraints ?? {},
    phases,
    generatedAtMs: Date.now(),
    currentPhaseIndex: 0,
  };
}

export function selectPhaseForElapsed(plan: SetPlan, elapsedMin: number): number {
  let acc = 0;
  for (let i = 0; i < plan.phases.length; i++) {
    acc += plan.phases[i]!.expectedDurationMin;
    if (elapsedMin < acc) return i;
  }
  return plan.phases.length - 1;
}

export function parseSetPlanJson(text: string, defaults: SetPlanInputs): SetPlan {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return defaultSetPlan(defaults);
  try {
    const json = JSON.parse(match[0]) as Partial<SetPlan> & { phases?: SetPhase[] };
    if (!json.phases || !Array.isArray(json.phases) || json.phases.length === 0) {
      return defaultSetPlan(defaults);
    }
    return {
      totalDurationMin: json.totalDurationMin ?? defaults.totalDurationMin,
      seedVibe: json.seedVibe ?? defaults.seedVibe,
      constraints: defaults.constraints ?? {},
      phases: json.phases,
      generatedAtMs: Date.now(),
      currentPhaseIndex: 0,
    };
  } catch {
    return defaultSetPlan(defaults);
  }
}
