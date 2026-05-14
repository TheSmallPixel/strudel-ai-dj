import { z } from 'zod';
import type { AudioStreamId, BridgeMessage } from '@strudel-ai-dj/dj-core';
import { SPECTROGRAM_DEFAULT_SECONDS } from '@strudel-ai-dj/dj-core';
import type { BridgeClient } from './bridge-client.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: unknown) => Promise<unknown>;
}

const StreamArg = z.enum(['strudel', 'system', 'external']);

export function makeTools(bridge: BridgeClient): ToolDefinition[] {
  return [
    {
      name: 'evaluate_strudel',
      description:
        'Replace the currently running Strudel pattern with new code. Code may include audio (note, s, stack) and visuals (.scope, .pianoroll, hydra blocks).',
      inputSchema: z.object({ code: z.string().describe('Strudel pattern source code') }),
      handler: async ({ code }) => {
        bridge.send({ type: 'pattern.evaluate', code });
        return { ok: true };
      },
    },
    {
      name: 'set_pattern_slot',
      description:
        'Edit one named layer (e.g. "drums", "bass") without replacing the whole pattern.',
      inputSchema: z.object({ slot: z.string(), code: z.string() }),
      handler: async ({ slot, code }) => {
        bridge.send({ type: 'pattern.set_slot', slot, code });
        return { ok: true };
      },
    },
    {
      name: 'set_tempo',
      description: 'Set BPM, optionally ramping over a number of bars.',
      inputSchema: z.object({
        bpm: z.number().min(30).max(240),
        rampBars: z.number().int().min(0).max(64).optional(),
      }),
      handler: async ({ bpm, rampBars }) => {
        const msg: BridgeMessage = { type: 'pattern.set_tempo', bpm };
        if (rampBars !== undefined) msg.rampBars = rampBars;
        bridge.send(msg);
        return { ok: true };
      },
    },
    {
      name: 'stop',
      description: 'Silence Strudel immediately (hush).',
      inputSchema: z.object({}),
      handler: async () => {
        bridge.send({ type: 'pattern.hush' });
        return { ok: true };
      },
    },
    {
      name: 'get_state',
      description:
        'Return current pattern code, transport (bar/beat/BPM), and latest audio features per stream.',
      inputSchema: z.object({}),
      handler: async () => {
        return await bridge.request(
          { type: 'pattern.introspect.request' },
          (m): m is BridgeMessage & { type: 'pattern.introspect.response' } =>
            m.type === 'pattern.introspect.response',
          5000,
        );
      },
    },
    {
      name: 'strudel_introspect',
      description:
        'Read the running pattern structurally: scheduled events for the next N bars, active layers, note density, predicted band energy.',
      inputSchema: z.object({ bars: z.number().int().min(1).max(64).default(8) }),
      handler: async () => {
        return await bridge.request(
          { type: 'pattern.introspect.request' },
          (m): m is BridgeMessage & { type: 'pattern.introspect.response' } =>
            m.type === 'pattern.introspect.response',
          5000,
        );
      },
    },
    {
      name: 'audio_features',
      description:
        'Return current audio features for a stream: strudel (own output), system (everything mixed), external (system minus strudel).',
      inputSchema: z.object({ stream: StreamArg.default('strudel') }),
      handler: async ({ stream }) => ({ requestedStream: stream as AudioStreamId }),
    },
    {
      name: 'audio_spectrogram',
      description:
        'Request a mel-spectrogram PNG of the last N seconds of a stream. Returns a base64-encoded image. Expensive; call sparingly.',
      inputSchema: z.object({
        stream: StreamArg.default('strudel'),
        seconds: z.number().min(1).max(30).default(SPECTROGRAM_DEFAULT_SECONDS),
      }),
      handler: async ({ stream, seconds }) => {
        return await bridge.request(
          { type: 'audio.spectrogram.request', stream, seconds },
          (m): m is BridgeMessage & { type: 'audio.spectrogram.response' } =>
            m.type === 'audio.spectrogram.response',
          15_000,
        );
      },
    },
    {
      name: 'schedule_in_bars',
      description:
        'Schedule a callback to fire in N bars. Used by the agent to ask itself to revisit a decision on a phrase boundary.',
      inputSchema: z.object({
        bars: z.number().int().min(1).max(256),
        reason: z.string(),
      }),
      handler: async ({ bars, reason }) => ({ ok: true, bars, reason }),
    },
    {
      name: 'schedule_at_bar',
      description: 'Schedule a callback to fire at an absolute bar number.',
      inputSchema: z.object({ bar: z.number().int().min(0), reason: z.string() }),
      handler: async ({ bar, reason }) => ({ ok: true, bar, reason }),
    },
    {
      name: 'schedule_in_minutes',
      description: 'Schedule a callback to fire in N minutes of wall-clock time.',
      inputSchema: z.object({ minutes: z.number().min(0.1).max(360), reason: z.string() }),
      handler: async ({ minutes, reason }) => ({ ok: true, minutes, reason }),
    },
    {
      name: 'visuals_set_style',
      description:
        'Set the persistent visual-style description (free text) that the agent should honor in future evaluate_strudel calls.',
      inputSchema: z.object({ description: z.string().min(1) }),
      handler: async ({ description }) => {
        bridge.send({ type: 'visual.style', description });
        return { ok: true };
      },
    },
    {
      name: 'provider_play',
      description: 'Play an external track via the active provider (e.g. Spotify URI).',
      inputSchema: z.object({ uri: z.string() }),
      handler: async ({ uri }) => {
        bridge.send({ type: 'provider.play', uri });
        return { ok: true };
      },
    },
    {
      name: 'provider_pause',
      description: 'Pause the external provider.',
      inputSchema: z.object({}),
      handler: async () => {
        bridge.send({ type: 'provider.pause' });
        return { ok: true };
      },
    },
    {
      name: 'panic',
      description: 'Emergency hush + pause everything.',
      inputSchema: z.object({}),
      handler: async () => {
        bridge.send({ type: 'panic' });
        return { ok: true };
      },
    },
  ];
}
