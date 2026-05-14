export interface SpotifyTokens {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

export interface SpotifyClientOptions {
  clientId: string;
  redirectUri: string;
  tokens?: SpotifyTokens;
  onTokenRefresh?: (tokens: SpotifyTokens) => void;
}

export class SpotifyClient {
  private clientId: string;
  private redirectUri: string;
  private tokens: SpotifyTokens | null = null;
  private onTokenRefresh?: (tokens: SpotifyTokens) => void;

  constructor(opts: SpotifyClientOptions) {
    this.clientId = opts.clientId;
    this.redirectUri = opts.redirectUri;
    if (opts.tokens) this.tokens = opts.tokens;
    if (opts.onTokenRefresh) this.onTokenRefresh = opts.onTokenRefresh;
  }

  setTokens(tokens: SpotifyTokens): void {
    this.tokens = tokens;
  }

  isAuthenticated(): boolean {
    return this.tokens !== null;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<SpotifyTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: codeVerifier,
    });
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`Spotify token exchange failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const tokens: SpotifyTokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAtMs: Date.now() + json.expires_in * 1000,
    };
    this.tokens = tokens;
    this.onTokenRefresh?.(tokens);
    return tokens;
  }

  async refresh(): Promise<SpotifyTokens> {
    if (!this.tokens) throw new Error('No refresh token available');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
      client_id: this.clientId,
    });
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`Spotify token refresh failed: ${res.status}`);
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    const tokens: SpotifyTokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? this.tokens.refreshToken,
      expiresAtMs: Date.now() + json.expires_in * 1000,
    };
    this.tokens = tokens;
    this.onTokenRefresh?.(tokens);
    return tokens;
  }

  private async ensureFreshToken(): Promise<string> {
    if (!this.tokens) throw new Error('Not authenticated with Spotify');
    if (Date.now() > this.tokens.expiresAtMs - 30_000) await this.refresh();
    return this.tokens.accessToken;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.ensureFreshToken();
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    if (res.status === 204) return null as unknown as T;
    if (!res.ok) throw new Error(`Spotify API ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  currentlyPlaying(): Promise<SpotifyCurrentlyPlaying | null> {
    return this.api<SpotifyCurrentlyPlaying | null>('/me/player/currently-playing');
  }

  audioAnalysis(trackId: string): Promise<SpotifyAudioAnalysis> {
    return this.api(`/audio-analysis/${trackId}`);
  }

  audioFeatures(trackId: string): Promise<SpotifyAudioFeatures> {
    return this.api(`/audio-features/${trackId}`);
  }

  search(query: string, limit = 10): Promise<SpotifySearchResult> {
    const q = new URLSearchParams({ q: query, type: 'track', limit: String(limit) });
    return this.api(`/search?${q.toString()}`);
  }
}

export interface SpotifyCurrentlyPlaying {
  is_playing: boolean;
  progress_ms: number;
  item: {
    uri: string;
    id: string;
    name: string;
    duration_ms: number;
    artists: { name: string }[];
    album: { name: string; images: { url: string; width: number; height: number }[] };
  } | null;
}

export interface SpotifyAudioAnalysis {
  track: { tempo: number; key: number; mode: number; time_signature: number };
  bars: { start: number; duration: number; confidence: number }[];
  beats: { start: number; duration: number; confidence: number }[];
  sections: { start: number; duration: number; tempo: number; key: number; loudness: number }[];
}

export interface SpotifyAudioFeatures {
  energy: number;
  valence: number;
  danceability: number;
  tempo: number;
  key: number;
  mode: number;
}

export interface SpotifySearchResult {
  tracks: {
    items: {
      uri: string;
      id: string;
      name: string;
      duration_ms: number;
      artists: { name: string }[];
      album: { name: string; images: { url: string }[] };
    }[];
  };
}
