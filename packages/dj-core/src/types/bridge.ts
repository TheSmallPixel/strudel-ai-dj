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
  | { type: 'audio.spectrogram.request'; stream: AudioFeatures['stream']; seconds: number }
  | { type: 'audio.spectrogram.response'; image: SpectrogramImage }
  | { type: 'chat.message'; message: ChatMessage }
  | { type: 'feedback.signal'; signal: FeedbackSignal }
  | { type: 'track.request'; request: TrackRequest }
  | { type: 'visual.reference'; image: VisualReferenceImage }
  | { type: 'visual.style'; description: string }
  | { type: 'provider.play'; uri: string }
  | { type: 'provider.pause' }
  | { type: 'provider.seek'; positionMs: number }
  | { type: 'panic' }
  | { type: 'ping' }
  | { type: 'pong' };

export interface BridgeClient {
  id: string;
  role: 'controller' | 'console';
  send(msg: BridgeMessage): void;
  close(): void;
}
