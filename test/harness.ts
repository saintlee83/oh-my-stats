import assert from 'node:assert/strict';
import type { Deps } from '../src/server/app.ts';
import { site } from './site.tsx';
import { testDb } from './sqlite-d1.ts';

/** What the server tests share: a server over a fresh database, a fake GitHub, and the usual sign-ins. */

export const ORIGIN = 'https://stats.example';

export const MACHINE_A = 'a'.repeat(32);

export const MACHINE_B = 'b'.repeat(32);

export const SECRET_NAME = 'jays-secret-macbook';

export interface GitHubUser {
  id: number;
  login: string;
  name?: string;
  avatar_url?: string;
}

/** A fake GitHub. `tokens` maps a token to its owner; `appTokens` are those issued to this app. */
export function fakeGitHub(tokens: Record<string, GitHubUser>, appTokens: string[] = []) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://api.github.com/user') {
      const token = String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '');
      return tokens[token] ? reply(tokens[token]) : reply({ message: 'Bad credentials' }, 401);
    }
    if (url.includes('/applications/') && url.endsWith('/token')) {
      assert.match(String((init?.headers as Record<string, string>).Authorization), /^Basic /);
      const token = JSON.parse(String(init?.body)).access_token as string;
      return appTokens.includes(token) ? reply({ user: tokens[token] }) : reply({ message: 'Not Found' }, 404);
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      const code = JSON.parse(String(init?.body)).code as string;
      return code === 'good-code' ? reply({ access_token: 'web-token' }) : reply({ error: 'bad_verification_code' });
    }
    if (url.includes('model_prices')) return reply({ 'claude-opus-5-5': { input_cost_per_token: 1, output_cost_per_token: 1 } });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  return { impl, calls };
}

export const octo: GitHubUser = { id: 1, login: 'octo', name: 'Octo Cat', avatar_url: 'https://avatars.githubusercontent.com/u/1' };

export function app(overrides: Partial<Deps> = {}, tokens: Record<string, GitHubUser> = { 'gh-token': octo, 'web-token': octo }) {
  const github = fakeGitHub(tokens);
  let time = new Date('2026-11-09T05:00:00Z');
  const deps: Deps = {
    db: testDb(),
    githubClientId: 'client-id',
    githubClientSecret: 'client-secret',
    allowAnyGitHubToken: true,
    fetch: github.impl,
    waitUntil: () => {},
    now: () => time,
    ...overrides,
  };
  const call = (path: string, init: RequestInit = {}) => site(new Request(`${ORIGIN}${path}`, init), deps);
  return { deps, call, github, setTime: (next: string) => (time = new Date(next)) };
}

/** A tool's mark as a page writes it, before the tool's name. `other` is the mark of a tool `oms` doesn't read on its own. */
export const mark = (id: string) => `<svg class="provider-icon" aria-hidden="true"><use href="#provider-${id}"/></svg>`;

export const api = (token: string | null, method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const machine = (id: string, name = SECRET_NAME) => ({ id, name, platform: 'macos', agentVersion: '0.1.0' });

export async function signIn(context: ReturnType<typeof app>, machineId = MACHINE_A, name = SECRET_NAME): Promise<string> {
  const response = await context.call('/v1/auth/token', api(null, 'POST', { githubToken: 'gh-token', machine: machine(machineId, name) }));
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}

export const upload = (machineId: string, day = '2026-11-08', tuple = [1, 2, 3, 4, 5]) => ({
  machine: machine(machineId),
  timezone: 'Asia/Seoul',
  days: { [day]: { 'claude/claude-opus-5-5': tuple } },
  totals: {},
});

export async function webLogin(context: ReturnType<typeof app>): Promise<string> {
  const start = await context.call('/login');
  assert.equal(start.status, 303);
  const location = new URL(start.headers.get('location') as string);
  assert.equal(location.searchParams.get('scope'), 'read:user', 'the website asks for identity only');
  const state = location.searchParams.get('state') as string;
  const stateCookie = (start.headers.get('set-cookie') as string).split(';')[0];
  const done = await context.call(`/auth/callback?code=good-code&state=${state}`, { headers: { cookie: stateCookie } });
  assert.equal(done.status, 303);
  assert.equal(done.headers.get('location'), '/me');
  const session = done.headers.getSetCookie().find((value) => value.startsWith('oms_session=')) as string;
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Lax/);
  assert.match(session, /Secure/);
  return session.split(';')[0];
}

export const webPost = (cookie: string, body = '', origin = ORIGIN): RequestInit => ({
  method: 'POST',
  headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
  body,
});

export function fakeCache() {
  const store = new Map<string, Response>();
  return {
    store,
    match: async (request: Request) => store.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => void store.set(request.url, response),
    delete: async (request: Request) => store.delete(request.url),
  };
}

export function countingDb() {
  const db = testDb();
  const sql: string[] = [];
  return {
    sql,
    raw: db.raw,
    batch: db.batch,
    prepare: (text: string) => {
      sql.push(text);
      return db.prepare(text);
    },
  };
}

export async function published(overrides: Partial<Deps> = {}) {
  const context = app(overrides);
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  return { context, token };
}
