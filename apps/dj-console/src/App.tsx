import { useEffect, useState } from 'react';
import { BridgeProvider, useBridge } from './bridge/BridgeProvider.js';
import { StrudelPanel } from './panels/StrudelPanel.js';
import { ChatPanel } from './panels/ChatPanel.js';
import { TransportBar } from './panels/TransportBar.js';
import { AudioPanel } from './panels/AudioPanel.js';
import { useHotkeys } from './hooks/useHotkeys.js';
import type { BridgeMessage } from '@strudel-ai-dj/dj-core';

export function App() {
  return (
    <BridgeProvider>
      <Layout />
    </BridgeProvider>
  );
}

function Layout() {
  const bridge = useBridge();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const off = bridge.onStatus((s) => setConnected(s));
    return off;
  }, [bridge]);

  useHotkeys({
    ' ': () => bridge.send({ type: 'panic' }),
    '+': () => sendFeedback(bridge.send, 'up'),
    '-': () => sendFeedback(bridge.send, 'down'),
  });

  return (
    <div style={{ display: 'grid', gridTemplateRows: '40px 1fr', height: '100vh' }}>
      <TransportBar connected={connected} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateRows: '1fr 200px', borderRight: '1px solid #1a1a22' }}>
          <StrudelPanel />
          <AudioPanel />
        </div>
        <ChatPanel />
      </div>
    </div>
  );
}

function sendFeedback(send: (m: BridgeMessage) => void, kind: 'up' | 'down') {
  send({
    type: 'feedback.signal',
    signal: {
      kind,
      timestampMs: Date.now(),
      bar: 0,
      context: 'hotkey',
    },
  });
}
