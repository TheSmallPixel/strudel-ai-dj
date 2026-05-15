import type { AudioFeatures, SpectrogramImage } from './audio.js';
import type { ChatMessage, FeedbackSignal, TrackRequest, VisualReferenceImage } from './feedback.js';
import type { StrudelIntrospection } from './pattern.js';
import type { Transport } from './transport.js';

export type BridgeMessage =
  | { type: 'hello'; role: 'controller' | 'console'; clientId: string }
  | { type: 'transport.update'; transport: Transport }
  | { type: 'pattern.evaluate'; code: string }
  | { type: 'pattern.set_slot'; slot: string; code: string }
  | { type: 'pattern.hush' }
  | { type: 'pattern.set_tempo'; bpm: number; rampBars?: number }
  | { type: 'pattern.introspect.request' }
  | { type: 'pattern.introspect.response'; introspection: StrudelIntrospection }
  | { type: 'audio.features'; features: AudioFeatures }
  | { type: 'audio.spectrogram.request'; stream: AudioFeatures['stream']; seconds: number; requestId: string }
  | { type: 'audio.spectrogram.response'; requestId: string; ok: boolean; image?: SpectrogramImage; error?: string }
  | { type: 'chat.message'; message: ChatMessage }
  | { type: 'feedback.signal'; signal: FeedbackSignal }
  | { type: 'track.request'; request: TrackRequest }
  | { type: 'visual.reference'; image: VisualReferenceImage }
  | { type: 'visual.style'; description: string }
  | { type: 'provider.play'; uri: string }
  | { type: 'provider.pause' }
  | { type: 'provider.seek'; positionMs: number }
  | { type: 'panic' }
  | {
      type: 'sample.record_request';
      name: string;
      seconds: number;
      requestId: string;
      stream?: 'system' | 'external';
    }
  | {
      type: 'sample.record_result';
      requestId: string;
      ok: boolean;
      name?: string;
      durationSec?: number;
      sampleRate?: number;
      stream?: 'system' | 'external';
      /** Optional: URL the browser can fetch to register the sample with Strudel. Used by the librespot host. */
      wavUrl?: string;
      error?: string;
    }
  | { type: 'sample.list_request'; requestId: string }
  | {
      type: 'sample.list_response';
      requestId: string;
      samples: { name: string; durationSec: number; recordedAtMs: number }[];
    }
  | { type: 'strudel.log_request'; requestId: string; sinceMs?: number; limit?: number }
  | { type: 'strudel.log_response'; requestId: string; ok: boolean; summary?: string; error?: string }
  | { type: 'pattern.slots_request'; requestId: string }
  | { type: 'pattern.slots_response'; requestId: string; slots: { name: string; code: string }[] }
  | { type: 'service.restart_request'; requestId: string; target: 'agent' | 'librespot' }
  | { type: 'service.restart_result'; requestId: string; ok: boolean; target: 'agent' | 'librespot'; message: string }
  | { type: 'spotify.token_request'; requestId: string }
  | {
      type: 'spotify.token_response';
      requestId: string;
      ok: boolean;
      accessToken?: string;
      expiresAtMs?: number;
      error?: string;
    }
  | { type: 'spotify.device_ready'; deviceId: string; deviceName: string }
  | { type: 'ping' }
  | { type: 'pong' };

export interface BridgeClient {
  id: string;
  role: 'controller' | 'console';
  send(msg: BridgeMessage): void;
  close(): void;
}
