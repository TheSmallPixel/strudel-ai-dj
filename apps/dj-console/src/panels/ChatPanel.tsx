import { useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge/BridgeProvider.js';
import type { ChatMessage } from '@strudel-ai-dj/dj-core';

export function ChatPanel() {
  const bridge = useBridge();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const off = bridge.on((msg) => {
      if (msg.type === 'chat.message') {
        setMessages((prev) => [...prev, msg.message]);
      }
    });
    return off;
  }, [bridge]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Defer one frame so the new message has laid out before we measure scrollHeight.
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [messages]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const msg: ChatMessage = {
      id: `user_${Date.now()}`,
      timestampMs: Date.now(),
      role: 'user',
      text: trimmed,
    };
    setMessages((prev) => [...prev, msg]);
    bridge.send({ type: 'chat.message', message: msg });

    // If the user pasted a Spotify/YouTube/SoundCloud/Bandcamp URL anywhere in
    // their text, also emit a track.request so the agent reacts the same way it
    // does when a URL is drag-dropped.
    const urlMatch = trimmed.match(
      /https?:\/\/(?:[\w-]+\.)?(?:spotify|youtube|youtu\.be|soundcloud|bandcamp)\.com\/[^\s]+/i,
    );
    if (urlMatch) {
      bridge.send({
        type: 'track.request',
        request: {
          id: `req_${Date.now()}`,
          timestampMs: Date.now(),
          uri: urlMatch[0],
          when: 'next_phase',
          intent: 'play_through',
        },
      });
    }

    setText('');
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const txt = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (txt) {
      bridge.send({
        type: 'track.request',
        request: {
          id: `req_${Date.now()}`,
          timestampMs: Date.now(),
          uri: txt.trim(),
          when: 'next_phase',
          intent: 'play_through',
        },
      });
    }
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1] ?? '';
        bridge.send({
          type: 'visual.reference',
          image: {
            id: `img_${Date.now()}`,
            uploadedAtMs: Date.now(),
            mimeType: file.type,
            base64,
            caption: file.name,
          },
        });
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0e0e14' }}
    >
      <div
        style={{
          padding: '6px 12px',
          background: '#15151c',
          borderBottom: '1px solid #1a1a22',
          fontSize: 12,
          color: '#a0a0a8',
        }}
      >
        chat — drop a URL or image to send to the agent
      </div>
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 }}>
        {messages.length === 0 ? (
          <div style={{ opacity: 0.4, fontSize: 13 }}>
            empty. Type a message to the agent or wait for the agent to greet.
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              style={{
                marginBottom: 10,
                paddingLeft: 8,
                borderLeft: `2px solid ${m.role === 'agent' ? '#7cffaf' : '#7cc6ff'}`,
              }}
            >
              <div style={{ fontSize: 10, opacity: 0.6, marginBottom: 2 }}>
                {m.role} · {new Date(m.timestampMs).toLocaleTimeString()}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{m.text}</div>
            </div>
          ))
        )}
      </div>
      <div style={{ borderTop: '1px solid #1a1a22', padding: 8, display: 'flex', gap: 6 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="say something to the agent…"
          style={{
            flex: 1,
            background: '#15151c',
            color: '#d8d8e0',
            border: '1px solid #2a2a35',
            padding: '6px 8px',
            borderRadius: 3,
            outline: 'none',
            fontSize: 13,
          }}
        />
        <button
          onClick={submit}
          style={{
            background: '#1f2a1f',
            color: '#7cffaf',
            border: '1px solid #2a3a2a',
            padding: '6px 12px',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          send
        </button>
      </div>
      <FeedbackBar />
    </div>
  );
}

function FeedbackBar() {
  const bridge = useBridge();
  const tap = (kind: 'up' | 'down') =>
    bridge.send({
      type: 'feedback.signal',
      signal: { kind, timestampMs: Date.now(), bar: 0, context: 'button' },
    });
  return (
    <div style={{ display: 'flex', gap: 4, padding: 8, borderTop: '1px solid #1a1a22' }}>
      <button onClick={() => tap('up')} style={reactBtn}>
        👍
      </button>
      <button onClick={() => tap('down')} style={reactBtn}>
        👎
      </button>
      <span style={{ marginLeft: 'auto', opacity: 0.4, fontSize: 11 }}>+/- hotkeys also work</span>
    </div>
  );
}

const reactBtn: React.CSSProperties = {
  background: '#15151c',
  color: '#d8d8e0',
  border: '1px solid #2a2a35',
  padding: '4px 10px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 14,
};
