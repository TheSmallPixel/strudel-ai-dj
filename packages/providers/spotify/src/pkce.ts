const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

export function generateCodeVerifier(length = 64): string {
  if (length < 43 || length > 128) throw new Error('PKCE verifier length 43..128');
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CHARS[bytes[i]! % CHARS.length];
  return out;
}

export async function codeChallengeFromVerifier(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await sha256(data);
  return base64urlNoPad(digest);
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge: string;
}): string {
  const u = new URL('https://accounts.spotify.com/authorize');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('scope', opts.scope.join(' '));
  u.searchParams.set('state', opts.state);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('code_challenge', opts.codeChallenge);
  return u.toString();
}

function randomBytes(n: number): Uint8Array {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return crypto.getRandomValues(new Uint8Array(n));
  }
  throw new Error('crypto.getRandomValues unavailable');
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(buf);
  }
  throw new Error('crypto.subtle.digest unavailable');
}

function base64urlNoPad(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
