import type { Provider, ProviderNowPlaying, ProviderTrack } from '@strudel-ai-dj/dj-core';

export interface YouTubeProviderOptions {
  apiKey?: string;
  manualNowPlaying?: () => ProviderNowPlaying | null;
}

export class YouTubeProvider implements Provider {
  readonly id = 'youtube' as const;
  private apiKey?: string;
  private getManual?: () => ProviderNowPlaying | null;

  constructor(opts: YouTubeProviderOptions = {}) {
    if (opts.apiKey !== undefined) this.apiKey = opts.apiKey;
    if (opts.manualNowPlaying !== undefined) this.getManual = opts.manualNowPlaying;
  }

  isConnected(): boolean {
    return this.apiKey !== undefined || this.getManual !== undefined;
  }

  async nowPlaying(): Promise<ProviderNowPlaying | null> {
    if (this.getManual) return this.getManual();
    return null;
  }

  async search(query: string, limit = 10): Promise<ProviderTrack[]> {
    if (!this.apiKey) return [];
    const u = new URL('https://www.googleapis.com/youtube/v3/search');
    u.searchParams.set('part', 'snippet');
    u.searchParams.set('type', 'video');
    u.searchParams.set('maxResults', String(limit));
    u.searchParams.set('q', query);
    u.searchParams.set('key', this.apiKey);
    const res = await fetch(u);
    if (!res.ok) return [];
    const json = (await res.json()) as {
      items: { id: { videoId: string }; snippet: { title: string; channelTitle: string; thumbnails: Record<string, { url: string }> } }[];
    };
    return json.items.map((it) => ({
      uri: `https://www.youtube.com/watch?v=${it.id.videoId}`,
      title: parseTitle(it.snippet.title).title,
      artist: parseTitle(it.snippet.title).artist ?? it.snippet.channelTitle,
      durationMs: 0,
      ...(it.snippet.thumbnails.high?.url !== undefined
        ? { artworkUrl: it.snippet.thumbnails.high.url }
        : {}),
    }));
  }
}

function parseTitle(raw: string): { title: string; artist?: string } {
  const m = raw.match(/^\s*(.+?)\s*[-–—]\s*(.+?)\s*$/);
  if (m) return { artist: m[1]!.trim(), title: m[2]!.trim() };
  return { title: raw.trim() };
}
