import { useEffect, useState } from 'react';
import { useBridge } from '../bridge/BridgeProvider.js';
import type { AudioFeatures, AudioStreamId, BridgeMessage } from '@strudel-ai-dj/dj-core';
import {
  encodeWav,
  getRegisteredPipeline,
  listSamples,
  registerSample,
  registerSampleFromUrl,
  snapshotPcm,
} from '../audio/recordSample.js';
import { summarizeStrudelLog } from '../audio/strudelLog.js';
import { getCurrentSlots } from './StrudelPanel.js';

// The agent reads features from the `external` stream (librespot tap).
// The `strudel` stream is reserved for a future native tap of Strudel's master.
const VISIBLE_STREAMS: AudioStreamId[] = ['external', 'strudel'];

type RestartTarget = 'agent' | 'librespot';

export function AudioPanel() {
  const bridge = useBridge();
  const [features, setFeatures] = useState<Record<AudioStreamId, AudioFeatures | null>>({
    strudel: null,
    system: null,
    external: null,
  });
  const [restartStatus, setRestartStatus] = useState<Record<RestartTarget, string | null>>({
    agent: null,
    librespot: null,
  });

  useEffect(() => {
    const handleRecordRequest = async (req: Extract<BridgeMessage, { type: 'sample.record_request' }>) => {
      const streamId = req.stream ?? 'external';
      const fail = (error: string) => {
        const result: BridgeMessage = {
          type: 'sample.record_result',
          requestId: req.requestId,
          ok: false,
          stream: streamId,
          error,
        };
        bridge.send(result);
      };
      const cap = getRegisteredPipeline(streamId);
      if (!cap) {
        if (streamId === 'external')
          fail('librespot tap not running — restart the speaker (Strudel AI DJ) first');
        else fail(`no pipeline for stream "${streamId}"`);
        return;
      }
      const pipelineLengthSec = cap.pipeline.buffer.length / cap.sampleRate;
      if (pipelineLengthSec < req.seconds) {
        fail(`not enough audio captured yet (${pipelineLengthSec.toFixed(1)}s buffered, ${req.seconds}s requested)`);
        return;
      }
      try {
        const pcm = snapshotPcm(cap.pipeline, cap.sampleRate, req.seconds);
        const wav = encodeWav(pcm, cap.sampleRate);
        const rec = await registerSample(req.name, wav, cap.sampleRate, req.seconds);
        const result: BridgeMessage = {
          type: 'sample.record_result',
          requestId: req.requestId,
          ok: true,
          stream: streamId,
          name: rec.name,
          durationSec: rec.durationSec,
          sampleRate: rec.sampleRate,
        };
        bridge.send(result);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    };
    const off = bridge.on((msg) => {
      if (msg.type === 'audio.features') {
        setFeatures((prev) => ({ ...prev, [msg.features.stream]: msg.features }));
      } else if (msg.type === 'sample.record_request') {
        const streamId = msg.stream ?? 'external';
        if (streamId === 'external') return; // librespot host's job
        void handleRecordRequest(msg);
      } else if (msg.type === 'sample.record_result' && msg.ok && msg.wavUrl && msg.name) {
        void registerSampleFromUrl(msg.name, msg.wavUrl, msg.sampleRate ?? 44100, msg.durationSec ?? 0)
          .catch((e) => console.error('[audio-panel] registerSampleFromUrl failed', e));
      } else if (msg.type === 'sample.list_request') {
        const out: BridgeMessage = {
          type: 'sample.list_response',
          requestId: msg.requestId,
          samples: listSamples().map((s) => ({
            name: s.name,
            durationSec: s.durationSec,
            recordedAtMs: s.recordedAtMs,
          })),
        };
        bridge.send(out);
      } else if (msg.type === 'strudel.log_request') {
        const out: BridgeMessage = {
          type: 'strudel.log_response',
          requestId: msg.requestId,
          ok: true,
          summary: summarizeStrudelLog(msg.sinceMs, msg.limit ?? 40),
        };
        bridge.send(out);
      } else if (msg.type === 'pattern.slots_request') {
        const out: BridgeMessage = {
          type: 'pattern.slots_response',
          requestId: msg.requestId,
          slots: getCurrentSlots(),
        };
        bridge.send(out);
      } else if (msg.type === 'service.restart_result') {
        setRestartStatus((prev) => ({
          ...prev,
          [msg.target]: msg.ok ? `✓ ${msg.message}` : `✗ ${msg.message}`,
        }));
        // Auto-clear after 6 seconds.
        setTimeout(() => {
          setRestartStatus((prev) => ({ ...prev, [msg.target]: null }));
        }, 6000);
      }
    });
    return off;
  }, [bridge]);

  const requestRestart = (target: RestartTarget) => {
    setRestartStatus((prev) => ({ ...prev, [target]: '… restarting …' }));
    bridge.send({
      type: 'service.restart_request',
      requestId: `restart_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      target,
    });
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
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <strong>audio</strong>
        <span style={{ marginLeft: 4, fontSize: 11, color: '#a0a0a8', flex: 1 }}>
          Spotify routes through the librespot Connect device (Strudel AI DJ) — speakers stay clean,
          only Strudel is audible.
        </span>
        <button
          onClick={() => requestRestart('librespot')}
          style={btnRestart}
          title="Kill and respawn the librespot Connect device. Useful if Spotify can't connect or playback froze."
        >
          ⟳ restart speaker
        </button>
        <button
          onClick={() => requestRestart('agent')}
          style={btnRestart}
          title="Wipe the agent's in-memory state: vibe, scorecard, queued prompts, audio feature buffer. Keeps the WS connection live."
        >
          ⟳ restart agent
        </button>
      </div>
      {(restartStatus.agent || restartStatus.librespot) && (
        <div style={{ marginBottom: 8, fontSize: 11 }}>
          {restartStatus.librespot && (
            <div style={{ color: restartStatus.librespot.startsWith('✓') ? '#7cffaf' : '#ff7c7c' }}>
              speaker: {restartStatus.librespot}
            </div>
          )}
          {restartStatus.agent && (
            <div style={{ color: restartStatus.agent.startsWith('✓') ? '#7cffaf' : '#ff7c7c' }}>
              agent: {restartStatus.agent}
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
        {VISIBLE_STREAMS.map((stream) => (
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
            tempo: {features.tempoEstimateBpm?.toFixed(0) ?? '—'} · onsets/s:{' '}
            {features.onsetDensityPerSec.toFixed(1)}
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

const btnRestart: React.CSSProperties = {
  background: '#1f1f2a',
  color: '#d8d8e0',
  border: '1px solid #2a2a35',
  padding: '3px 10px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 11,
};
