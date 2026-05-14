import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BridgeMessage } from '@strudel-ai-dj/dj-core';
import { BRIDGE_DEFAULT_PORT } from '@strudel-ai-dj/dj-core';

type Handler = (m: BridgeMessage) => void;
type StatusHandler = (connected: boolean) => void;

interface BridgeAPI {
  send(msg: BridgeMessage): void;
  on(handler: Handler): () => void;
  onStatus(handler: StatusHandler): () => void;
}

const Ctx = createContext<BridgeAPI | null>(null);

export function BridgeProvider({ children }: { children: ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(new Set<Handler>());
  const statusRef = useRef(new Set<StatusHandler>());
  const [, force] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const ws = new WebSocket(`ws://localhost:${BRIDGE_DEFAULT_PORT}`);
      wsRef.current = ws;
      ws.onopen = () => {
        if (cancelled) {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: 'hello', role: 'console', clientId: 'console_main' } satisfies BridgeMessage));
        for (const h of statusRef.current) h(true);
        force((x) => x + 1);
      };
      ws.onmessage = (ev) => {
        let msg: BridgeMessage;
        try {
          msg = JSON.parse(ev.data) as BridgeMessage;
        } catch {
          return;
        }
        for (const h of handlersRef.current) h(msg);
      };
      ws.onclose = () => {
        for (const h of statusRef.current) h(false);
        wsRef.current = null;
        if (!cancelled) reconnectTimer = setTimeout(connect, 1500);
      };
      ws.onerror = () => {
        ws.close();
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  const api = useMemo<BridgeAPI>(
    () => ({
      send(msg) {
        const ws = wsRef.current;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
        else console.warn('[bridge] send dropped (not open):', msg.type);
      },
      on(handler) {
        handlersRef.current.add(handler);
        return () => handlersRef.current.delete(handler);
      },
      onStatus(handler) {
        statusRef.current.add(handler);
        return () => statusRef.current.delete(handler);
      },
    }),
    [],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useBridge(): BridgeAPI {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBridge outside BridgeProvider');
  return v;
}
