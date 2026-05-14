import { useEffect, useState } from 'react';
import { useBridge } from '../bridge/BridgeProvider.js';
import type { BridgeMessage, Transport } from '@strudel-ai-dj/dj-core';

interface Props {
  connected: boolean;
}

export function TransportBar({ connected }: Props) {
  const bridge = useBridge();
  const [transport, setTransport] = useState<Transport | null>(null);

  useEffect(() => {
    const off = bridge.on((msg: BridgeMessage) => {
      if (msg.type === 'transport.update') setTransport(msg.transport);
    });
    return off;
  }, [bridge]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 16px',
        background: '#15151c',
        borderBottom: '1px solid #1a1a22',
        fontSize: 13,
      }}
    >
      <strong style={{ color: connected ? '#7cffaf' : '#ff7c7c' }}>
        {connected ? '● bridge' : '○ bridge'}
      </strong>
      {transport ? (
        <>
          <span>bar {transport.bar}</span>
          <span>beat {transport.beat + 1}/{transport.beatsPerBar}</span>
          <span>{transport.bpm.toFixed(1)} bpm</span>
          <span>{(transport.elapsedMs / 60_000).toFixed(1)} min</span>
        </>
      ) : (
        <span style={{ opacity: 0.5 }}>transport idle</span>
      )}
      <button
        style={btn}
        onClick={() => bridge.send({ type: 'panic' })}
        title="Panic (Space)"
      >
        ⏸ Panic
      </button>
    </div>
  );
}

const btn: React.CSSProperties = {
  marginLeft: 'auto',
  background: '#2a1a1a',
  color: '#ff9090',
  border: '1px solid #ff7c7c',
  padding: '4px 12px',
  borderRadius: 4,
  cursor: 'pointer',
};
