import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import {
  SpotifyClient,
  type SpotifyTokens,
  buildAuthorizeUrl,
  codeChallengeFromVerifier,
  generateCodeVerifier,
} from '@strudel-ai-dj/provider-spotify';
import { SPOTIFY_OAUTH_CALLBACK_PORT } from '@strudel-ai-dj/dj-core';

const SCOPES = [
  // Playback control / inspection
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  // Web Playback SDK requirements
  'streaming',
  'user-read-email',
  'user-read-private',
];

const TOKENS_PATH = join(homedir(), '.strudel-ai-dj', 'spotify.json');
const REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_OAUTH_CALLBACK_PORT}/callback`;

let client: SpotifyClient | null = null;

function loadTokens(): SpotifyTokens | null {
  try {
    if (!existsSync(TOKENS_PATH)) return null;
    return JSON.parse(readFileSync(TOKENS_PATH, 'utf8')) as SpotifyTokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: SpotifyTokens): void {
  mkdirSync(dirname(TOKENS_PATH), { recursive: true });
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

function openBrowser(url: string): void {
  // On Windows, NEVER pipe URLs through cmd.exe — its `start` builtin treats `&`
  // as a command separator, which truncates OAuth URLs at the first parameter
  // boundary. Use rundll32 to invoke the FileProtocolHandler directly.
  if (platform() === 'win32') {
    spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } else if (platform() === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

export function getSpotifyClient(): SpotifyClient | null {
  if (client && client.isAuthenticated()) return client;
  const clientId = process.env['SPOTIFY_CLIENT_ID'];
  if (!clientId) return null;
  const tokens = loadTokens();
  if (!tokens) return null;
  client = new SpotifyClient({
    clientId,
    redirectUri: REDIRECT_URI,
    tokens,
    onTokenRefresh: (t) => saveTokens(t),
  });
  return client;
}

export function spotifyConfigured(): { ok: true } | { ok: false; reason: string } {
  if (!process.env['SPOTIFY_CLIENT_ID']) {
    return {
      ok: false,
      reason:
        'SPOTIFY_CLIENT_ID env var is not set. Register an app at https://developer.spotify.com/dashboard, add redirect URI ' +
        REDIRECT_URI +
        ', then set SPOTIFY_CLIENT_ID before starting the agent.',
    };
  }
  if (!getSpotifyClient()) {
    return { ok: false, reason: 'Not authenticated. Call spotify_setup to start the OAuth flow.' };
  }
  return { ok: true };
}

interface OauthAttempt {
  verifier: string;
  state: string;
  resolve: (tokens: SpotifyTokens) => void;
  reject: (e: Error) => void;
  server: ReturnType<typeof createServer>;
}

let inFlight: OauthAttempt | null = null;

export async function startSpotifyOAuth(
  timeoutMs = 180_000,
  onUrl?: (url: string) => void,
): Promise<SpotifyTokens> {
  const clientId = process.env['SPOTIFY_CLIENT_ID'];
  if (!clientId) {
    throw new Error(
      'SPOTIFY_CLIENT_ID env var is not set. Register an app at https://developer.spotify.com/dashboard, add redirect URI ' +
        REDIRECT_URI +
        ', then export SPOTIFY_CLIENT_ID=<id> before starting the agent.',
    );
  }
  if (inFlight) {
    throw new Error('Spotify OAuth already in progress. Visit the URL printed earlier, or wait for timeout.');
  }
  const verifier = generateCodeVerifier();
  const challenge = await codeChallengeFromVerifier(verifier);
  const state = generateCodeVerifier(48);
  const authUrl = buildAuthorizeUrl({
    clientId,
    redirectUri: REDIRECT_URI,
    scope: SCOPES,
    state,
    codeChallenge: challenge,
  });

  return await new Promise<SpotifyTokens>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (inFlight?.server) inFlight.server.close();
      inFlight = null;
      reject(new Error('Spotify OAuth timed out'));
    }, timeoutMs);

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${SPOTIFY_OAUTH_CALLBACK_PORT}`);
      if (!reqUrl.pathname.endsWith('/callback')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const code = reqUrl.searchParams.get('code');
      const returnedState = reqUrl.searchParams.get('state');
      const errorParam = reqUrl.searchParams.get('error');
      if (errorParam) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>Spotify auth failed</h1><p>${errorParam}</p><p>You can close this tab.</p>`);
        clearTimeout(timer);
        server.close();
        inFlight = null;
        reject(new Error(`Spotify returned error: ${errorParam}`));
        return;
      }
      if (!code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad OAuth callback');
        return;
      }
      const c = new SpotifyClient({
        clientId,
        redirectUri: REDIRECT_URI,
        onTokenRefresh: (t) => saveTokens(t),
      });
      c.exchangeCode(code, verifier)
        .then((tokens) => {
          saveTokens(tokens);
          client = c;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>Strudel AI DJ is now connected to Spotify</h1><p>You can close this tab.</p>');
          clearTimeout(timer);
          server.close();
          inFlight = null;
          resolve(tokens);
        })
        .catch((e: Error) => {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Exchange failed: ${e.message}`);
          clearTimeout(timer);
          server.close();
          inFlight = null;
          reject(e);
        });
    });

    server.on('error', (e) => {
      clearTimeout(timer);
      inFlight = null;
      reject(e);
    });

    server.listen(SPOTIFY_OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
      inFlight = { verifier, state, resolve, reject, server };
      console.error(`[spotify] OAuth listening on ${REDIRECT_URI}`);
      console.error(`[spotify] If a browser tab didn't open, visit: ${authUrl}`);
      onUrl?.(authUrl);
      openBrowser(authUrl);
    });
  });
}
