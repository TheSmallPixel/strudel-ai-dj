import { useCallback, useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge/BridgeProvider.js';
import type { BridgeMessage } from '@strudel-ai-dj/dj-core';
import { BrowserAudioPipeline, WORKLET_SRC } from '@strudel-ai-dj/audio-input';
import { registerPipeline } from '../audio/recordSample.js';

const SDK_SRC = 'https://sdk.scdn.co/spotify-player.js';
// Distinct name so the user can tell it apart from the librespot device (which
// also advertises as a Connect device named "Strudel AI DJ"). The librespot
// path is preferred because it gives the agent raw PCM access.
const DEVICE_NAME = 'Strudel AI DJ (browser)';

type Status = 'idle' | 'loading-sdk' | 'fetching-token' | 'initializing' | 'ready' | 'error';

interface SpotifyPlayerLike {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (...args: unknown[]) => void): boolean;
  setVolume(v: number): Promise<void>;
  getVolume(): Promise<number>;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: {
      Player: new (opts: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume?: number;
      }) => SpotifyPlayerLike;
    };
  }
}

let sdkPromise: Promise<void> | null = null;
function loadSdkOnce(): Promise<void> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    if (window.Spotify) {
      resolve();
      return;
    }
    const ready = new Promise<void>((r) => {
      window.onSpotifyWebPlaybackSDKReady = () => r();
    });
    const script = document.createElement('script');
    script.src = SDK_SRC;
    script.async = true;
    script.onload = () => {
      // The SDK calls onSpotifyWebPlaybackSDKReady after it finishes loading.
      void ready.then(() => resolve());
    };
    script.onerror = () => reject(new Error('Failed to load Spotify Web Playback SDK'));
    document.head.appendChild(script);
  });
  return sdkPromise;
}

interface TapResult {
  stop(): void;
  path: 'mediaElement' | 'captureStream' | 'volume-only';
  diagnostic: string;
}

async function findMediaElement(): Promise<HTMLMediaElement | null> {
  // The Web Playback SDK may use either <audio> or <video> and may take a few
  // hundred ms to attach the element after `ready` fires. Try both, poll
  // generously, log what we find.
  for (let i = 0; i < 50; i++) {
    const all = [
      ...Array.from(document.querySelectorAll<HTMLMediaElement>('audio')),
      ...Array.from(document.querySelectorAll<HTMLMediaElement>('video')),
    ];
    if (all.length > 0) {
      console.error('[spotify-tap] found media elements:', all.map((el) => ({
        tag: el.tagName,
        src: el.src?.slice(0, 80),
        id: el.id,
      })));
      return all[0]!;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function tryMediaElementSourceTap(
  ctx: AudioContext,
  el: HTMLMediaElement,
  bridge: { send: (m: BridgeMessage) => void },
): Promise<TapResult | null> {
  let source: MediaElementAudioSourceNode;
  try {
    source = ctx.createMediaElementSource(el);
  } catch (e) {
    console.warn('[spotify-tap] createMediaElementSource failed:', e);
    return null;
  }
  const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(ctx, 'strudel-ai-dj-capture');
  const pipeline = new BrowserAudioPipeline({ stream: 'external', sampleRate: ctx.sampleRate });
  node.port.onmessage = (ev) => {
    const buf = ev.data as Float32Array;
    const features = pipeline.pushChunk(buf);
    if (features) bridge.send({ type: 'audio.features', features });
  };
  source.connect(node);
  const silent = ctx.createGain();
  silent.gain.value = 0;
  node.connect(silent).connect(ctx.destination);
  registerPipeline('external', { pipeline, sampleRate: ctx.sampleRate });
  return {
    path: 'mediaElement',
    diagnostic: `MediaElementSource tap active on <${el.tagName.toLowerCase()}>`,
    stop() {
      try { source.disconnect(); } catch {}
      try { node.disconnect(); } catch {}
      try { silent.disconnect(); } catch {}
      URL.revokeObjectURL(url);
      registerPipeline('external', null);
    },
  };
}

async function tryCaptureStreamTap(
  ctx: AudioContext,
  el: HTMLMediaElement,
  bridge: { send: (m: BridgeMessage) => void },
): Promise<TapResult | null> {
  const maybeEl = el as HTMLMediaElement & { captureStream?: () => MediaStream };
  if (typeof maybeEl.captureStream !== 'function') return null;
  let stream: MediaStream;
  try {
    stream = maybeEl.captureStream();
  } catch (e) {
    console.warn('[spotify-tap] captureStream failed:', e);
    return null;
  }
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) return null;
  const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(url);
  const source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
  const node = new AudioWorkletNode(ctx, 'strudel-ai-dj-capture');
  const pipeline = new BrowserAudioPipeline({ stream: 'external', sampleRate: ctx.sampleRate });
  node.port.onmessage = (ev) => {
    const buf = ev.data as Float32Array;
    const features = pipeline.pushChunk(buf);
    if (features) bridge.send({ type: 'audio.features', features });
  };
  source.connect(node);
  const silent = ctx.createGain();
  silent.gain.value = 0;
  node.connect(silent).connect(ctx.destination);
  registerPipeline('external', { pipeline, sampleRate: ctx.sampleRate });
  return {
    path: 'captureStream',
    diagnostic: 'captureStream() tap active',
    stop() {
      try { source.disconnect(); } catch {}
      try { node.disconnect(); } catch {}
      try { silent.disconnect(); } catch {}
      URL.revokeObjectURL(url);
      registerPipeline('external', null);
    },
  };
}

async function tapSpotifyAudioElement(
  player: SpotifyPlayerLike,
  bridge: { send: (m: BridgeMessage) => void },
): Promise<TapResult> {
  const el = await findMediaElement();
  if (!el) {
    // No element accessible — the SDK is using a cross-origin iframe. We can't
    // tap, but we can still guarantee silence via the SDK's own volume control.
    try { await player.setVolume(0); } catch {}
    return {
      path: 'volume-only',
      diagnostic:
        'No <audio>/<video> element found in document — SDK is using a cross-origin iframe. Tap not possible. Silenced via player.setVolume(0).',
      stop() {
        void player.setVolume(0.7).catch(() => undefined);
      },
    };
  }
  const ctx = window.strudel?.audioContext ?? new AudioContext();
  const meSrc = await tryMediaElementSourceTap(ctx, el, bridge);
  if (meSrc) return meSrc;
  const cs = await tryCaptureStreamTap(ctx, el, bridge);
  if (cs) return cs;
  // Both taps failed. Fall back to volume mute.
  try { await player.setVolume(0); } catch {}
  return {
    path: 'volume-only',
    diagnostic:
      `Found <${el.tagName.toLowerCase()}> but both createMediaElementSource and captureStream failed (DRM blocking Web Audio tap). Silenced via player.setVolume(0).`,
    stop() {
      void player.setVolume(0.7).catch(() => undefined);
    },
  };
}

export function SpotifyConnectPanel() {
  const bridge = useBridge();
  const [status, setStatus] = useState<Status>('idle');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tapState, setTapState] = useState<'off' | 'mediaElement' | 'captureStream' | 'volume-only'>('off');
  const [tapDiagnostic, setTapDiagnostic] = useState<string>('');
  const playerRef = useRef<SpotifyPlayerLike | null>(null);
  const tapRef = useRef<TapResult | null>(null);

  const fetchToken = useCallback((): Promise<string> => {
    return new Promise((resolve, reject) => {
      const requestId = `tok_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      let off: (() => void) | null = null;
      const timer = window.setTimeout(() => {
        off?.();
        reject(new Error('Token request timed out — is the agent running?'));
      }, 5000);
      off = bridge.on((msg) => {
        if (msg.type === 'spotify.token_response' && msg.requestId === requestId) {
          window.clearTimeout(timer);
          off?.();
          if (msg.ok && msg.accessToken) resolve(msg.accessToken);
          else reject(new Error(msg.error ?? 'no token'));
        }
      });
      bridge.send({ type: 'spotify.token_request', requestId });
    });
  }, [bridge]);

  const activate = useCallback(async () => {
    setError(null);
    try {
      setStatus('loading-sdk');
      await loadSdkOnce();
      if (!window.Spotify) throw new Error('Spotify SDK did not initialize');
      setStatus('fetching-token');
      const initialToken = await fetchToken();
      setStatus('initializing');
      const player = new window.Spotify.Player({
        name: DEVICE_NAME,
        getOAuthToken: (cb) => {
          // The SDK calls this on initial connect and again when the token nears expiry.
          fetchToken()
            .then((t) => cb(t))
            .catch((e) => {
              console.error('[spotify-connect] token refresh failed', e);
              cb(initialToken); // best effort
            });
        },
        volume: 0.8,
      });
      player.addListener('ready', (...args: unknown[]) => {
        const ev = args[0] as { device_id?: string } | undefined;
        const id = ev?.device_id ?? '';
        setDeviceId(id);
        setStatus('ready');
        bridge.send({ type: 'spotify.device_ready', deviceId: id, deviceName: DEVICE_NAME });
        // Try to mute Spotify on main output and tap its audio for analysis.
        // The function tries createMediaElementSource → captureStream → setVolume(0)
        // and tells us which path worked. If the SDK uses a cross-origin iframe,
        // tap is impossible but silence is still guaranteed by setVolume(0).
        // Small delay so the SDK has time to wire its media element.
        setTimeout(() => {
          void tapSpotifyAudioElement(player, bridge).then((tap) => {
            tapRef.current = tap;
            setTapState(tap.path);
            setTapDiagnostic(tap.diagnostic);
            console.error('[spotify-tap]', tap.path, '-', tap.diagnostic);
          });
        }, 500);
      });
      player.addListener('not_ready', (...args: unknown[]) => {
        const ev = args[0] as { device_id?: string } | undefined;
        console.warn('[spotify-connect] not ready', ev?.device_id);
      });
      player.addListener('initialization_error', (...args: unknown[]) => {
        const ev = args[0] as { message?: string } | undefined;
        setError(`init error: ${ev?.message ?? 'unknown'}`);
        setStatus('error');
      });
      player.addListener('authentication_error', (...args: unknown[]) => {
        const ev = args[0] as { message?: string } | undefined;
        setError(`auth error: ${ev?.message ?? 'unknown'} — try spotify_setup again`);
        setStatus('error');
      });
      player.addListener('account_error', (...args: unknown[]) => {
        const ev = args[0] as { message?: string } | undefined;
        setError(`account error: ${ev?.message ?? 'unknown'} — Spotify Premium required`);
        setStatus('error');
      });
      player.addListener('playback_error', (...args: unknown[]) => {
        const ev = args[0] as { message?: string } | undefined;
        console.warn('[spotify-connect] playback error', ev?.message);
      });
      const connected = await player.connect();
      if (!connected) throw new Error('player.connect() returned false');
      playerRef.current = player;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, [bridge, fetchToken]);

  const deactivate = useCallback(() => {
    tapRef.current?.stop();
    tapRef.current = null;
    setTapState('off');
    setTapDiagnostic('');
    playerRef.current?.disconnect();
    playerRef.current = null;
    setStatus('idle');
    setDeviceId(null);
  }, []);

  useEffect(() => () => {
    tapRef.current?.stop();
    playerRef.current?.disconnect();
  }, []);

  const isActive = status === 'ready';
  const isBusy = status === 'loading-sdk' || status === 'fetching-token' || status === 'initializing';

  return (
    <div
      style={{
        background: '#101018',
        borderTop: '1px solid #1a1a22',
        padding: 8,
        fontSize: 12,
        color: '#d8d8e0',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong>spotify connect</strong>
        {isActive ? (
          <>
            <span style={{ color: '#7cffaf', fontSize: 11 }}>● Strudel AI DJ</span>
            <button onClick={deactivate} style={btn}>stop</button>
          </>
        ) : (
          <button onClick={activate} disabled={isBusy} style={btn}>
            {isBusy ? status + '…' : '🎧 activate'}
          </button>
        )}
      </div>
      {isActive && deviceId && (
        <div style={{ marginTop: 4, fontSize: 10, color: '#a0a0a8' }}>
          <div>
            Open Spotify → device picker → <strong>Strudel AI DJ</strong>. Audio status:{' '}
            {tapState === 'mediaElement' || tapState === 'captureStream' ? (
              <span style={{ color: '#7cffaf' }}>
                ● muted + tapped via <code>{tapState}</code>, features streaming as{' '}
                <code>external</code>
              </span>
            ) : tapState === 'volume-only' ? (
              <span style={{ color: '#ffd47c' }}>
                ◐ muted via setVolume(0) — Web Audio tap unavailable (cross-origin / DRM). Agent
                cannot hear via this path.
              </span>
            ) : (
              <span style={{ color: '#ffaf7c' }}>○ tap not yet active</span>
            )}
          </div>
          {tapDiagnostic && (
            <div style={{ marginTop: 4, fontSize: 10, color: '#7c8a9a', fontFamily: 'monospace' }}>
              {tapDiagnostic}
            </div>
          )}
        </div>
      )}
      {error && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#ff8a7c', whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  background: '#1f1f2a',
  color: '#d8d8e0',
  border: '1px solid #2a2a35',
  padding: '2px 8px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 11,
};
