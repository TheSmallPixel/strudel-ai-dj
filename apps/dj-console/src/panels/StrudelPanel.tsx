import { useCallback, useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge/BridgeProvider.js';

// Module-level snapshot of the current slot map so AudioPanel can answer
// pattern.slots_request without crossing React component boundaries.
let currentSlots: Map<string, string> = new Map();
export function getCurrentSlots(): { name: string; code: string }[] {
  return Array.from(currentSlots.entries()).map(([name, code]) => ({ name, code }));
}

declare global {
  interface Window {
    strudel?: {
      initStrudel?: (opts?: unknown) => Promise<void> | void;
      evaluate?: (code: string) => Promise<void> | void;
      hush?: () => void;
      setCps?: (cps: number) => void;
      samples?: (src: unknown) => Promise<void> | void;
      audioContext?: AudioContext;
    };
  }
}

export function StrudelPanel() {
  const bridge = useBridge();
  const [code, setCode] = useState(
    `// Welcome to Strudel AI DJ. Type a pattern and press Cmd/Ctrl+Enter, or let the agent take over.\nstack(\n  s("bd*4"),\n  s("hh*8").gain(0.5)\n).cpm(120)`,
  );
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  // Named-slot composition. Keys preserve insertion order in JS Maps, which
  // gives the agent a stable layer ordering for stack().
  const slotsRef = useRef<Map<string, string>>(new Map());

  const composeFromSlots = useCallback((): string | null => {
    const exprs = Array.from(slotsRef.current.values()).filter((s) => s.trim().length > 0);
    if (exprs.length === 0) return null;
    if (exprs.length === 1) return exprs[0]!;
    return `stack(\n  ${exprs.join(',\n  ')}\n)`;
  }, []);

  const recompose = useCallback(async () => {
    const composed = composeFromSlots();
    if (!composed) {
      window.strudel?.hush?.();
      setCode('');
      return;
    }
    setCode(composed);
    try {
      await window.strudel?.evaluate?.(composed);
    } catch (e) {
      console.error('Recompose eval error', e);
    }
  }, [composeFromSlots]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus('loading');
      try {
        const mod = (await import(/* @vite-ignore */ '@strudel/web')) as Record<string, unknown>;
        if (cancelled) return;
        const initStrudel = mod['initStrudel'] as
          | ((opts?: { prebake?: () => Promise<void> | void }) => Promise<void> | void)
          | undefined;
        const evaluate = mod['evaluate'] as ((code: string) => Promise<void> | void) | undefined;
        const hush = mod['hush'] as (() => void) | undefined;
        const setCps = mod['setCps'] as ((cps: number) => void) | undefined;
        const samples = mod['samples'] as ((src: string) => Promise<void> | void) | undefined;
        const getAudioContext = mod['getAudioContext'] as (() => AudioContext) | undefined;
        if (initStrudel) {
          await initStrudel({
            prebake: async () => {
              await samples?.('github:tidalcycles/dirt-samples');
            },
          });
          window.strudel = {
            ...(initStrudel !== undefined ? { initStrudel } : {}),
            ...(evaluate !== undefined ? { evaluate } : {}),
            ...(hush !== undefined ? { hush } : {}),
            ...(setCps !== undefined ? { setCps } : {}),
            ...(samples !== undefined ? { samples } : {}),
            ...(getAudioContext !== undefined ? { audioContext: getAudioContext() } : {}),
          };
          setStatus('ready');
        } else {
          throw new Error('@strudel/web does not expose initStrudel');
        }
      } catch (e) {
        console.error('Failed to init Strudel', e);
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const off = bridge.on((msg) => {
      if (msg.type === 'pattern.evaluate') {
        // Full replace — wipes the slot map so subsequent slot edits start fresh.
        slotsRef.current.clear();
        currentSlots = new Map();
        setCode(msg.code);
        void window.strudel?.evaluate?.(msg.code);
      } else if (msg.type === 'pattern.set_slot') {
        // Layer edit — most expressions land here for smooth evolution.
        if (msg.code.trim().length === 0) {
          slotsRef.current.delete(msg.slot);
        } else {
          slotsRef.current.set(msg.slot, msg.code);
        }
        currentSlots = new Map(slotsRef.current);
        void recompose();
      } else if (msg.type === 'pattern.hush' || msg.type === 'panic') {
        slotsRef.current.clear();
        currentSlots = new Map();
        window.strudel?.hush?.();
      } else if (msg.type === 'pattern.set_tempo') {
        window.strudel?.setCps?.(msg.bpm / 60 / 4);
      }
    });
    return off;
  }, [bridge, recompose]);

  const evaluate = useCallback(async () => {
    if (!window.strudel?.evaluate) return;
    try {
      await window.strudel.evaluate(code);
      bridge.send({ type: 'pattern.evaluate', code });
    } catch (e) {
      console.error('Eval error', e);
    }
  }, [code, bridge]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          padding: '6px 12px',
          background: '#15151c',
          borderBottom: '1px solid #1a1a22',
          fontSize: 12,
          color: '#a0a0a8',
        }}
      >
        Strudel — status: <strong>{status}</strong> · ⌘/Ctrl+Enter to evaluate
      </div>
      <textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void evaluate();
          }
        }}
        spellCheck={false}
        style={{
          flex: 1,
          background: '#0a0a0e',
          color: '#d8d8e0',
          border: 'none',
          outline: 'none',
          padding: 12,
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          fontSize: 13,
          lineHeight: 1.5,
          resize: 'none',
        }}
      />
    </div>
  );
}
