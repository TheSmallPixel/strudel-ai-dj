import { WebSocket } from 'ws';
import { BRIDGE_DEFAULT_PORT, type BridgeMessage } from '@strudel-ai-dj/dj-core';

export interface BridgeClientOptions {
  port?: number;
  host?: string;
  clientId?: string;
}

type Pending = {
  match: (msg: BridgeMessage) => boolean;
  resolve: (msg: BridgeMessage) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class BridgeClient {
  private ws: WebSocket | null = null;
  private pending: Pending[] = [];
  private url: string;
  private clientId: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(m: BridgeMessage) => void>();

  constructor(opts: BridgeClientOptions = {}) {
    const port = opts.port ?? BRIDGE_DEFAULT_PORT;
    const host = opts.host ?? 'localhost';
    this.url = `ws://${host}:${port}`;
    this.clientId = opts.clientId ?? `controller_${Math.random().toString(36).slice(2, 8)}`;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.on('open', () => {
        this.ws = ws;
        ws.send(
          JSON.stringify({ type: 'hello', role: 'controller', clientId: this.clientId } as BridgeMessage),
        );
        resolve();
      });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as BridgeMessage;
          this.handleIncoming(msg);
        } catch {
          // ignore
        }
      });
      ws.on('close', () => {
        this.ws = null;
        this.scheduleReconnect();
      });
      ws.on('error', (e) => {
        reject(e);
      });
    });
  }

  onMessage(fn: (m: BridgeMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(msg: BridgeMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Bridge not connected');
    }
    this.ws.send(JSON.stringify(msg));
  }

  request<T extends BridgeMessage>(
    msg: BridgeMessage,
    matchResponse: (m: BridgeMessage) => m is T,
    timeoutMs = 5000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removePending(pending);
        reject(new Error(`Bridge request timed out: ${msg.type}`));
      }, timeoutMs);
      const pending: Pending = {
        match: matchResponse as (m: BridgeMessage) => boolean,
        resolve: (m) => resolve(m as T),
        reject,
        timeout,
      };
      this.pending.push(pending);
      try {
        this.send(msg);
      } catch (e) {
        this.removePending(pending);
        clearTimeout(timeout);
        reject(e as Error);
      }
    });
  }

  close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private removePending(p: Pending): void {
    const i = this.pending.indexOf(p);
    if (i >= 0) this.pending.splice(i, 1);
    clearTimeout(p.timeout);
  }

  private handleIncoming(msg: BridgeMessage): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p && p.match(msg)) {
        clearTimeout(p.timeout);
        this.pending.splice(i, 1);
        p.resolve(msg);
      }
    }
    for (const fn of this.listeners) fn(msg);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, 1000);
  }
}
