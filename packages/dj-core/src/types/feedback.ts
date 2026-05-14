export type FeedbackSignalKind = 'up' | 'down';

export interface FeedbackSignal {
  kind: FeedbackSignalKind;
  timestampMs: number;
  bar: number;
  context: string;
}

export type RequestWhen = 'now' | 'next' | 'next_phase' | 'at_peak' | `bar:${number}`;
export type RequestIntent = 'play_through' | 'transition_into' | 'sample_from';

export interface TrackRequest {
  id: string;
  timestampMs: number;
  uri: string;
  when: RequestWhen;
  intent: RequestIntent;
  note?: string;
}

export interface ChatMessage {
  id: string;
  timestampMs: number;
  role: 'user' | 'agent';
  text: string;
  attachedImageIds?: string[];
}

export interface VisualReferenceImage {
  id: string;
  uploadedAtMs: number;
  mimeType: string;
  base64: string;
  caption?: string;
}
