import type { AudioFeatures, SpectrogramImage } from './audio.js';
import type { ChatMessage, FeedbackSignal, TrackRequest, VisualReferenceImage } from './feedback.js';
import type { ProviderAnalysis, ProviderNowPlaying } from './provider.js';
import type { ScheduledCallback } from './scheduler.js';
import type { Bookmark, SetPlan, VibeJournalEntry } from './set-plan.js';
import type { StrudelIntrospection } from './pattern.js';
import type { Transport } from './transport.js';

export interface TickContext {
  reason: string;
  firedAtMs: number;

  transport: Transport;
  setPlan: SetPlan | null;
  currentPhaseName: string | null;
  vibeJournalRecent: VibeJournalEntry[];
  bookmarks: Bookmark[];

  introspect: StrudelIntrospection | null;
  audio: {
    strudel: AudioFeatures;
    system: AudioFeatures;
    external: AudioFeatures;
    spectrogram?: SpectrogramImage;
  };

  provider: {
    nowPlaying: ProviderNowPlaying | null;
    analysis: ProviderAnalysis | null;
  };

  chatQueue: ChatMessage[];
  feedbackQueue: FeedbackSignal[];
  trackRequestQueue: TrackRequest[];

  visualStyle: string;
  visualReferences: VisualReferenceImage[];

  scheduledPending: ScheduledCallback[];
}
