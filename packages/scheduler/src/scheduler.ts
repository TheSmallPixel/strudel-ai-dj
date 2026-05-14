import type {
  ScheduledCallback,
  ScheduledEventKind,
  SchedulerTick,
  Transport,
} from '@strudel-ai-dj/dj-core';
import { BarClock } from './bar-clock.js';
import { CallbackRegistry } from './callback-registry.js';
import { EventBus } from './event-bus.js';

export type TickListener = (tick: SchedulerTick, callback: ScheduledCallback) => void;

export class Scheduler {
  readonly clock: BarClock;
  readonly registry: CallbackRegistry;
  readonly bus: EventBus;
  private tickListeners = new Set<TickListener>();
  private watchdogHandle: ReturnType<typeof setInterval> | null = null;
  private lastTickMs = Date.now();

  constructor(clock?: BarClock) {
    this.clock = clock ?? new BarClock();
    this.registry = new CallbackRegistry();
    this.bus = new EventBus();
    this.clock.onTick((t) => this.onTransportTick(t));
    this.bus.on('*', () => {
      this.lastTickMs = Date.now();
    });
  }

  start(): void {
    this.clock.start();
    this.startWatchdog();
  }

  stop(): void {
    this.clock.stop();
    if (this.watchdogHandle !== null) {
      clearInterval(this.watchdogHandle);
      this.watchdogHandle = null;
    }
  }

  scheduleInBars(bars: number, reason: string, metadata?: Record<string, unknown>): ScheduledCallback {
    const t = this.clock.state;
    return this.registry.add({
      kind: 'in_bars',
      reason,
      createdAtBar: t.bar,
      fireAtBar: t.bar + Math.max(1, Math.floor(bars)),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }

  scheduleAtBar(bar: number, reason: string, metadata?: Record<string, unknown>): ScheduledCallback {
    const t = this.clock.state;
    return this.registry.add({
      kind: 'at_bar',
      reason,
      createdAtBar: t.bar,
      fireAtBar: bar,
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }

  scheduleInMinutes(min: number, reason: string, metadata?: Record<string, unknown>): ScheduledCallback {
    return this.registry.add({
      kind: 'in_minutes',
      reason,
      createdAtBar: this.clock.state.bar,
      fireAtMs: Date.now() + min * 60_000,
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }

  scheduleRecurringEveryBars(
    bars: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): ScheduledCallback {
    const t = this.clock.state;
    return this.registry.add({
      kind: 'in_bars',
      reason,
      createdAtBar: t.bar,
      fireAtBar: t.bar + Math.max(1, Math.floor(bars)),
      recurring: true,
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }

  cancel(id: string): boolean {
    return this.registry.remove(id);
  }

  emitEvent<P>(kind: ScheduledEventKind, payload: P): void {
    this.bus.emit(kind, payload);
    const callbacks = this.registry.fireByKind(kind);
    for (const cb of callbacks) {
      this.dispatch(cb);
    }
  }

  onTick(fn: TickListener): () => void {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  private onTransportTick(t: Transport): void {
    const firing = this.registry.drainFiring(t);
    for (const cb of firing) this.dispatch(cb);
  }

  private dispatch(cb: ScheduledCallback): void {
    const tick: SchedulerTick = {
      callbackId: cb.id,
      kind: cb.kind,
      reason: cb.reason,
      firedAtBar: this.clock.state.bar,
      firedAtMs: Date.now(),
      ...(cb.metadata !== undefined ? { metadata: cb.metadata } : {}),
    };
    this.lastTickMs = Date.now();
    for (const fn of this.tickListeners) fn(tick, cb);
  }

  private startWatchdog(): void {
    const WATCHDOG_MS = 60_000;
    this.watchdogHandle = setInterval(() => {
      if (Date.now() - this.lastTickMs > WATCHDOG_MS) {
        this.scheduleInBars(8, 'watchdog: no tick in 60s');
        this.lastTickMs = Date.now();
      }
    }, 10_000);
  }
}
