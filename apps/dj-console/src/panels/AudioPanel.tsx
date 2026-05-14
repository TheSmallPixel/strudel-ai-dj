import { useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge/BridgeProvider.js';
import type { AudioFeatures, AudioStreamId } from '@strudel-ai-dj/dj-core';
import { startSystemCapture, type CaptureHandle } from '../audio/captureSystem.js';

export function AudioPanel() {
  const bridge = useBridge();
  const [features, setFeatures] = useState<Record<AudioStreamId, AudioFeatures | null>>({
    strudel: null,
    system: null,
    external: null,
  });
  const [capturing, setCapturing] = useState(false);
  const captureRef = useRef<CaptureHandle | null>(null);

  useEffect(() => {
    const off = bridge.on((msg) => {
      if (msg.type === 'audio.features') {
        setFeatures((prev) => ({ ...prev, [msg.features.stream]: msg.features }));
      }
    });
    return off;
  }, [bridge]);

  const startCapture = async () => {
    try {
      captureRef.current = await startSystemCapture((f) => {
        bridge.send({ type: 'audio.features', features: f });
      });
      setCapturing(true);
    } catch (e) {
      console.error('System capture failed', e);
      alert(`Couldn't start system audio capture: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const stopCapture = () => {
    captureRef.current?.stop();
    captureRef.current = null;
    setCapturing(false);
  };

  return (
    <div
      style={{
        background: '#101018',
        borderTop: '1px solid #1a1a22',
        padding: 12,
        fontSize: 12,
        overflow: 'auto',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>audio</strong>
        {capturing ? (
          <button onClick={stopCapture} style={btn}>stop system capture</button>
        ) : (
          <button onClick={startCapture} style={btn}>start system capture</button>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {(['strudel', 'system', 'external'] as AudioStreamId[]).map((stream) => (
          <FeatureCard key={stream} stream={stream} features={features[stream]} />
        ))}
      </div>
    </div>
  );
}

function FeatureCard({ stream, features }: { stream: AudioStreamId; features: AudioFeatures | null }) {
  return (
    <div style={{ background: '#15151c', padding: 8, borderRadius: 4 }}>
      <div style={{ color: '#7cffaf', marginBottom: 4 }}>{stream}</div>
      {features ? (
        <>
          <Bar label="rms" value={features.rms} />
          <Bar label="low" value={features.lowEnergy} />
          <Bar label="mid" value={features.midEnergy} />
          <Bar label="high" value={features.highEnergy} />
          <div style={{ marginTop: 4, opacity: 0.7 }}>
            tempo: {features.tempoEstimateBpm?.toFixed(0) ?? '—'} ·{' '}
            onsets/s: {features.onsetDensityPerSec.toFixed(1)}
          </div>
        </>
      ) : (
        <div style={{ opacity: 0.4 }}>no data</div>
      )}
    </div>
  );
}

function Bar({ label, value }: { label: string; value: number }) {
  const pct = Math.min(100, value * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
      <span style={{ width: 28, opacity: 0.6 }}>{label}</span>
      <div style={{ flex: 1, height: 6, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: '#7cffaf' }} />
      </div>
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
