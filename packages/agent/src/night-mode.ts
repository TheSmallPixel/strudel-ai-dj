import type { BridgeServer } from '@strudel-ai-dj/bridge';
import { Scheduler } from '@strudel-ai-dj/scheduler';
import type { Provider, SetPlan } from '@strudel-ai-dj/dj-core';
import { AgentRuntime } from './agent-runtime.js';
import { defaultSetPlan, selectPhaseForElapsed, type SetPlanInputs } from './set-plan-generator.js';
import { buildTickContext, renderTickContextAsText } from './tick-context-builder.js';

export interface NightModeOptions {
  bridge: BridgeServer;
  scheduler: Scheduler;
  agent: AgentRuntime;
  provider: Provider;
}

export class NightMode {
  private running = false;
  private opts: NightModeOptions;
  private tickInProgress = false;

  constructor(opts: NightModeOptions) {
    this.opts = opts;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(input: SetPlanInputs): Promise<{ ok: true; plan: SetPlan }> {
    if (this.running) throw new Error('Night already running');
    const plan = defaultSetPlan(input);
    this.opts.bridge.state.setPlan = plan;
    this.running = true;
    this.opts.scheduler.start();

    this.opts.scheduler.scheduleRecurringEveryBars(32, 'recurring review');
    this.opts.scheduler.scheduleInBars(8, 'open ceremony: first review');

    this.opts.scheduler.onTick(async (tick) => {
      if (!this.running) return;
      await this.runTick(tick.reason);
    });

    void this.runTick('open ceremony: generate opening pattern');

    return { ok: true, plan };
  }

  stop(): void {
    this.running = false;
    this.opts.scheduler.stop();
  }

  private async runTick(reason: string): Promise<void> {
    if (this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      const tick = {
        callbackId: 'manual',
        kind: 'in_bars' as const,
        reason,
        firedAtBar: this.opts.scheduler.clock.state.bar,
        firedAtMs: Date.now(),
      };
      const ctx = await buildTickContext({
        store: this.opts.bridge.state,
        tick,
        provider: this.opts.provider,
        scheduledPending: this.opts.scheduler.registry.list(),
      });

      const plan = this.opts.bridge.state.setPlan;
      if (plan && plan.setPlanElapsedAtUpdate === undefined) {
        const elapsedMin = ctx.transport.elapsedMs / 60_000;
        const idx = selectPhaseForElapsed(plan, elapsedMin);
        if (idx !== plan.currentPhaseIndex) plan.currentPhaseIndex = idx;
      }

      const promptText = renderTickContextAsText(ctx);
      const result = await this.opts.agent.turn(promptText);

      if (result.text) this.opts.agent.emitAgentChat(result.text);

      this.opts.agent.journal({
        timestampMs: Date.now(),
        bar: ctx.transport.bar,
        decision: result.text.slice(0, 280),
        reason,
        toolCalls: result.toolCalls,
        ...(result.error !== undefined ? { outcomeNote: `error: ${result.error}` } : {}),
      });
    } finally {
      this.tickInProgress = false;
    }
  }
}

declare module '@strudel-ai-dj/dj-core' {
  interface SetPlan {
    setPlanElapsedAtUpdate?: number;
  }
}
