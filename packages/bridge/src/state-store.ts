import {
  emptyFeatures,
  makeTransport,
  type AudioFeatures,
  type AudioStreamId,
  type Bookmark,
  type ChatMessage,
  type FeedbackSignal,
  type ProviderAnalysis,
  type ProviderNowPlaying,
  type SetPlan,
  type StrudelIntrospection,
  type TrackRequest,
  type Transport,
  type VibeJournalEntry,
  type VisualReferenceImage,
  VIBE_JOURNAL_MAX_ENTRIES,
} from '@strudel-ai-dj/dj-core';

export class StateStore {
  transport: Transport = makeTransport();
  patternCode = '';
  introspection: StrudelIntrospection | null = null;
  audio: Record<AudioStreamId, AudioFeatures> = {
    strudel: emptyFeatures('strudel'),
    system: emptyFeatures('system'),
    external: emptyFeatures('external'),
  };

  provider: { nowPlaying: ProviderNowPlaying | null; analysis: ProviderAnalysis | null } = {
    nowPlaying: null,
    analysis: null,
  };

  setPlan: SetPlan | null = null;
  vibeJournal: VibeJournalEntry[] = [];
  bookmarks: Bookmark[] = [];

  chatQueue: ChatMessage[] = [];
  feedbackQueue: FeedbackSignal[] = [];
  trackRequestQueue: TrackRequest[] = [];

  visualStyle = '';
  visualReferences: VisualReferenceImage[] = [];

  pushChat(msg: ChatMessage): void {
    this.chatQueue.push(msg);
  }
  pushFeedback(sig: FeedbackSignal): void {
    this.feedbackQueue.push(sig);
  }
  pushTrackRequest(req: TrackRequest): void {
    this.trackRequestQueue.push(req);
  }
  pushVisualReference(img: VisualReferenceImage): void {
    this.visualReferences.push(img);
  }

  setVisualStyle(s: string): void {
    this.visualStyle = s;
  }

  setVisualReference(id: string): boolean {
    const idx = this.visualReferences.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    const [picked] = this.visualReferences.splice(idx, 1);
    if (picked) this.visualReferences.unshift(picked);
    return true;
  }

  appendJournal(entry: VibeJournalEntry): void {
    this.vibeJournal.push(entry);
    if (this.vibeJournal.length > VIBE_JOURNAL_MAX_ENTRIES) {
      this.vibeJournal.splice(0, this.vibeJournal.length - VIBE_JOURNAL_MAX_ENTRIES);
    }
  }

  drainChat(): ChatMessage[] {
    const out = this.chatQueue.slice();
    this.chatQueue.length = 0;
    return out;
  }
  drainFeedback(): FeedbackSignal[] {
    const out = this.feedbackQueue.slice();
    this.feedbackQueue.length = 0;
    return out;
  }
  drainTrackRequests(): TrackRequest[] {
    const out = this.trackRequestQueue.slice();
    this.trackRequestQueue.length = 0;
    return out;
  }

  updateTransport(t: Transport): void {
    this.transport = t;
  }
  updatePatternCode(code: string): void {
    this.patternCode = code;
  }
  updateIntrospection(intr: StrudelIntrospection): void {
    this.introspection = intr;
  }
  updateFeatures(features: AudioFeatures): void {
    this.audio[features.stream] = features;
  }
  updateNowPlaying(np: ProviderNowPlaying | null): void {
    this.provider.nowPlaying = np;
  }
  updateAnalysis(an: ProviderAnalysis | null): void {
    this.provider.analysis = an;
  }
}
