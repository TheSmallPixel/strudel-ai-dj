import type { ScheduledCallback, ScheduledEventKind, Transport } from '@strudel-ai-dj/dj-core';

let nextId = 1;

export class CallbackRegistry {
  private callbacks = new Map<string, ScheduledCallback>();

  add(input: Omit<ScheduledCallback, 'id'> & { id?: string }): ScheduledCallback {
    const id = input.id ?? `cb_${nextId++}`;
    const cb: ScheduledCallback = { ...input, id };
    this.callbacks.set(id, cb);
    return cb;
  }

  remove(id: string): boolean {
    return this.callbacks.delete(id);
  }

  list(): ScheduledCallback[] {
    return Array.from(this.callbacks.values());
  }

  get(id: string): ScheduledCallback | undefined {
    return this.callbacks.get(id);
  }

  drainFiring(transport: Transport): ScheduledCallback[] {
    const fired: ScheduledCallback[] = [];
    const now = Date.now();
    for (const cb of this.callbacks.values()) {
      if (this.shouldFire(cb, transport, now)) {
        fired.push(cb);
        if (!cb.recurring) {
          this.callbacks.delete(cb.id);
        } else {
          this.rearm(cb, transport);
        }
      }
    }
    return fired;
  }

  fireByKind(kind: ScheduledEventKind): ScheduledCallback[] {
    const fired: ScheduledCallback[] = [];
    for (const cb of this.callbacks.values()) {
      if (cb.kind === kind) {
        fired.push(cb);
        if (!cb.recurring) this.callbacks.delete(cb.id);
      }
    }
    return fired;
  }

  private shouldFire(cb: ScheduledCallback, t: Transport, nowMs: number): boolean {
    if (cb.fireAtBar !== undefined && t.bar >= cb.fireAtBar) return true;
    if (cb.fireAtMs !== undefined && nowMs >= cb.fireAtMs) return true;
    return false;
  }

  private rearm(cb: ScheduledCallback, t: Transport): void {
    if (cb.kind === 'in_bars' && cb.fireAtBar !== undefined) {
      const stride = cb.fireAtBar - cb.createdAtBar;
      cb.createdAtBar = t.bar;
      cb.fireAtBar = t.bar + stride;
    } else if (cb.kind === 'in_minutes' && cb.fireAtMs !== undefined) {
      const stride = cb.fireAtMs - cb.createdAtBar;
      cb.fireAtMs = Date.now() + stride;
    }
  }

  clear(): void {
    this.callbacks.clear();
  }
}
