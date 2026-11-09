import type { GitHubIdentity } from './db.ts';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'oh-my-stats';

export function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Tokens have 256 bits of entropy, so a plain hash is enough: nothing here can be guessed offline. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Compares digests of the inputs, so timing reveals nothing about the secret. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([hashToken(a), hashToken(b)]);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export class AuthError extends Error {}

export interface GitHubAuthConfig {
  clientId: string;
  clientSecret: string;
  allowAnyToken: boolean;
  fetch: typeof fetch;
}

const toIdentity = (body: unknown): GitHubIdentity => {
  const user = body as Partial<GitHubIdentity> | null;
  if (typeof user?.id !== 'number' || typeof user.login !== 'string') throw new AuthError('GitHub returned no user');
  return { id: user.id, login: user.login, name: user.name ?? null, avatar_url: user.avatar_url ?? null };
};

async function userFromToken(config: GitHubAuthConfig, token: string): Promise<GitHubIdentity> {
  const response = await config.fetch(`${GITHUB_API}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
  });
  if (!response.ok) throw new AuthError('GitHub rejected the token');
  return toIdentity(await response.json());
}

/**
 * Turns a device-flow token into an identity. Any app holding a user's token could
 * otherwise sign in as them here, so production only accepts tokens issued to this app.
 * The token is used once and never stored.
 */
export async function identityFromAgentToken(config: GitHubAuthConfig, token: string): Promise<GitHubIdentity> {
  if (config.allowAnyToken) return userFromToken(config, token);
  if (!config.clientId || !config.clientSecret) throw new AuthError('GitHub sign-in is not configured');
  const response = await config.fetch(`${GITHUB_API}/applications/${config.clientId}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ access_token: token }),
  });
  if (!response.ok) throw new AuthError('That token was not issued to this app');
  const body = (await response.json()) as { user?: unknown };
  return toIdentity(body.user);
}

/** The second half of the website's OAuth flow. Only `read:user` is requested. */
export async function identityFromCode(config: GitHubAuthConfig, code: string, redirectUri: string): Promise<GitHubIdentity> {
  const response = await config.fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri }),
  });
  const body = (await response.json().catch(() => null)) as { access_token?: string } | null;
  if (!response.ok || !body?.access_token) throw new AuthError('GitHub did not complete the sign-in');
  return userFromToken(config, body.access_token);
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

export function cookie(request: Request, name: string, value: string, maxAgeSeconds: number): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

/** Form posts must come from this site. SameSite cookies already block most forgery; this closes the rest. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}
