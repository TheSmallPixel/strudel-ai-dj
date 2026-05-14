import type {
  Provider,
  ProviderAnalysis,
  ProviderNowPlaying,
  ProviderTrack,
} from '@strudel-ai-dj/dj-core';
import { SpotifyClient } from './client.js';

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export class SpotifyProvider implements Provider {
  readonly id = 'spotify' as const;
  constructor(private client: SpotifyClient) {}

  isConnected(): boolean {
    return this.client.isAuthenticated();
  }

  async nowPlaying(): Promise<ProviderNowPlaying | null> {
    if (!this.client.isAuthenticated()) return null;
    const np = await this.client.currentlyPlaying();
    if (!np || !np.item) return { provider: 'spotify', track: null, positionMs: 0, isPlaying: false };
    const track: ProviderTrack = {
      uri: np.item.uri,
      title: np.item.name,
      artist: np.item.artists.map((a) => a.name).join(', '),
      album: np.item.album.name,
      durationMs: np.item.duration_ms,
      ...(np.item.album.images[0]?.url !== undefined ? { artworkUrl: np.item.album.images[0]!.url } : {}),
    };
    return {
      provider: 'spotify',
      track,
      positionMs: np.progress_ms,
      isPlaying: np.is_playing,
    };
  }

  async analysis(uri: string): Promise<ProviderAnalysis | null> {
    if (!this.client.isAuthenticated()) return null;
    const id = extractSpotifyId(uri);
    if (!id) return null;
    const [an, feat] = await Promise.all([
      this.client.audioAnalysis(id),
      this.client.audioFeatures(id),
    ]);
    return {
      provider: 'spotify',
      uri,
      bpm: an.track.tempo,
      key: KEY_NAMES[an.track.key] ?? 'C',
      mode: an.track.mode === 1 ? 'major' : an.track.mode === 0 ? 'minor' : 'unknown',
      timeSignature: an.track.time_signature,
      sections: an.sections.map((s) => ({
        startMs: s.start * 1000,
        durationMs: s.duration * 1000,
        label: `loudness=${s.loudness.toFixed(1)} tempo=${s.tempo.toFixed(1)}`,
      })),
      bars: an.bars.map((b) => ({
        startMs: b.start * 1000,
        durationMs: b.duration * 1000,
        confidence: b.confidence,
      })),
      beats: an.beats.map((b) => ({
        startMs: b.start * 1000,
        durationMs: b.duration * 1000,
        confidence: b.confidence,
      })),
      energy: feat.energy,
      danceability: feat.danceability,
      valence: feat.valence,
    };
  }

  async search(query: string, limit = 10): Promise<ProviderTrack[]> {
    if (!this.client.isAuthenticated()) return [];
    const res = await this.client.search(query, limit);
    return res.tracks.items.map((t) => ({
      uri: t.uri,
      title: t.name,
      artist: t.artists.map((a) => a.name).join(', '),
      album: t.album.name,
      durationMs: t.duration_ms,
      ...(t.album.images[0]?.url !== undefined ? { artworkUrl: t.album.images[0]!.url } : {}),
    }));
  }
}

function extractSpotifyId(uri: string): string | null {
  const m1 = uri.match(/^spotify:track:([A-Za-z0-9]+)$/);
  if (m1) return m1[1]!;
  const m2 = uri.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
  if (m2) return m2[1]!;
  return null;
}
