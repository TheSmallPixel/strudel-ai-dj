import type { ScheduledEventKind } from '@strudel-ai-dj/dj-core';

export type EventHandler<P = unknown> = (payload: P) => void;

export class EventBus {
  private handlers = new Map<ScheduledEventKind | '*', Set<EventHandler>>();

  on<P = unknown>(kind: ScheduledEventKind | '*', fn: EventHandler<P>): () => void {
    let set = this.handlers.get(kind);
    if (!set) {
      set = new Set();
      this.handlers.set(kind, set);
    }
    set.add(fn as EventHandler);
    return () => set!.delete(fn as EventHandler);
  }

  emit<P = unknown>(kind: ScheduledEventKind, payload: P): void {
    const set = this.handlers.get(kind);
    if (set) for (const fn of set) fn(payload);
    const star = this.handlers.get('*');
    if (star) for (const fn of star) fn(payload);
  }
}
