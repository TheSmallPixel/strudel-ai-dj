import { useCallback, useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge/BridgeProvider.js';
import { startAudioCapture, type CaptureHandle } from '../audio/captureStrudel.js';

declare global {
  interface Window {
    strudel?: {
      initStrudel?: (opts?: unknown) => Promise<void> | void;
      evaluate?: (code: string) => Promise<void> | void;
      hush?: () => void;
      setCps?: (cps: number) => void;
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
  const captureRef = useRef<CaptureHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus('loading');
      try {
        const mod = (await import(/* @vite-ignore */ '@strudel/web')) as Record<string, unknown>;
        if (cancelled) return;
        const initStrudel = mod['initStrudel'] as ((opts?: unknown) => Promise<void> | void) | undefined;
        const evaluate = mod['evaluate'] as ((code: string) => Promise<void> | void) | undefined;
        const hush = mod['hush'] as (() => void) | undefined;
        const setCps = mod['setCps'] as ((cps: number) => void) | undefined;
        if (initStrudel) {
          await initStrudel();
          window.strudel = {
            ...(initStrudel !== undefined ? { initStrudel } : {}),
            ...(evaluate !== undefined ? { evaluate } : {}),
            ...(hush !== undefined ? { hush } : {}),
            ...(setCps !== undefined ? { setCps } : {}),
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
        setCode(msg.code);
        void window.strudel?.evaluate?.(msg.code);
      } else if (msg.type === 'pattern.hush' || msg.type === 'panic') {
        window.strudel?.hush?.();
      } else if (msg.type === 'pattern.set_tempo') {
        window.strudel?.setCps?.(msg.bpm / 60 / 4);
      }
    });
    return off;
  }, [bridge]);

  const evaluate = useCallback(async () => {
    if (!window.strudel?.evaluate) return;
    try {
      await window.strudel.evaluate(code);
      bridge.send({ type: 'pattern.evaluate', code });
      const ctx = window.strudel.audioContext;
      if (ctx && !captureRef.current) {
        captureRef.current = await startAudioCapture(ctx, (features) => {
          bridge.send({ type: 'audio.features', features });
        });
      }
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
