export type ProviderId = 'spotify' | 'youtube' | 'generic';

export interface ProviderTrack {
  uri: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  artworkUrl?: string;
}

export interface ProviderNowPlaying {
  provider: ProviderId;
  track: ProviderTrack | null;
  positionMs: number;
  isPlaying: boolean;
}

export interface ProviderAnalysis {
  provider: ProviderId;
  uri: string;
  bpm: number;
  key: string;
  mode: 'major' | 'minor' | 'unknown';
  timeSignature: number;
  sections: { startMs: number; durationMs: number; label: string }[];
  bars: { startMs: number; durationMs: number; confidence: number }[];
  beats: { startMs: number; durationMs: number; confidence: number }[];
  energy: number;
  danceability: number;
  valence: number;
}

export interface Provider {
  readonly id: ProviderId;
  isConnected(): boolean;
  nowPlaying?(): Promise<ProviderNowPlaying | null>;
  analysis?(uri: string): Promise<ProviderAnalysis | null>;
  search?(query: string, limit?: number): Promise<ProviderTrack[]>;
  play?(uri: string): Promise<void>;
  pause?(): Promise<void>;
  seek?(positionMs: number): Promise<void>;
}
