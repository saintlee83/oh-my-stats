import type { GitHubMetrics, Metrics } from '../shared/metrics.ts';
import { buildCards, cardContent, type Card } from '../shared/render/cards.ts';
import { renderDashboard } from '../shared/render/svg.ts';
import { zoned } from '../shared/time.ts';
import { computeTokens } from '../shared/tokens.ts';
import {
  AuthError,
  cookie,
  hashToken,
  identityFromAgentToken,
  identityFromCode,
  isSameOrigin,
  randomToken,
  readCookie,
  safeEqual,
  type GitHubAuthConfig,
} from './auth.ts';
import {
  claimGitHubCollection,
  createSession,
  deleteMachine,
  deleteSession,
  deleteUser,
  findSession,
  listMachines,
  loadGitHubStats,
  loadUsage,
  OverQuota,
  renameMachine,
  renewSession,
  saveGitHubStats,
  saveUsage,
  setPublic,
  upsertMachine,
  upsertUser,
  userById,
  userByLogin,
  type Db,
  type SessionRow,
  type UserRow,
} from './db.ts';
import { dashboardPage, errorPage, landingPage, profilePage } from './pages.ts';
import { loadPrices } from './prices.ts';
import { BadRequest, cleanMachineName, parseGitHubMetrics, parseMachine, parseUsageUpload } from './wire.ts';

export interface Deps {
  db: Db;
  githubClientId: string;
  githubClientSecret: string;
  allowAnyGitHubToken: boolean;
  fetch: typeof fetch;
  waitUntil(work: Promise<unknown>): void;
  now(): Date;
  /** Cloudflare's edge cache. Public pages are served from it for up to five minutes. */
  cache?: EdgeCache;
  /** Rate limiting. Without it, every request is allowed. */
  allow?: (kind: 'public' | 'strict', key: string) => Promise<boolean>;
}

export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

const SESSION_COOKIE = 'oms_session';
const STATE_COOKIE = 'oms_state';
const WEB_SESSION_SECONDS = 30 * 86_400;
const AGENT_SESSION_DAYS = 180;
/** A machine's sign-in is extended about once a month, rather than written on every upload. */
const AGENT_SESSION_RENEW_DAYS = 150;
const MAX_MACHINES_PER_ACCOUNT = 50;
const MAX_USAGE_BYTES = 2_000_000;
const MAX_GITHUB_BYTES = 256_000;
const PUBLIC_CACHE = 'public, max-age=300';
const CARD_KEYS = ['contributions', 'rhythm', 'languages', 'churn', 'tokens', 'coauthors', 'pulse'];

const HTML_CSP =
  "default-src 'none'; img-src 'self' data: https://avatars.githubusercontent.com; style-src 'unsafe-inline'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'";

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': HTML_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

const redirect = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', ...headers } });

/** Reads a body up to a limit, so an oversized upload can't exhaust the Worker's memory. */
async function readLimited(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > limit) throw new BadRequest('body is too large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new BadRequest('body is too large');
    }
    text += decoder.decode(value, { stream: true });
  }
}

async function readJson(request: Request, limit: number): Promise<unknown> {
  try {
    return JSON.parse(await readLimited(request, limit));
  } catch (error) {
    if (error instanceof BadRequest) throw error;
    throw new BadRequest('body must be JSON');
  }
}

const authConfig = (deps: Deps): GitHubAuthConfig => ({
  clientId: deps.githubClientId,
  clientSecret: deps.githubClientSecret,
  allowAnyToken: deps.allowAnyGitHubToken,
  fetch: deps.fetch,
});

async function viewerFromCookie(request: Request, deps: Deps): Promise<UserRow | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const session = await findSession(deps.db, await hashToken(token), deps.now().toISOString());
  return session?.kind === 'web' ? userById(deps.db, session.user_id) : null;
}

async function agentSession(request: Request, deps: Deps): Promise<SessionRow | null> {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const session = await findSession(deps.db, await hashToken(header.slice(7)), deps.now().toISOString());
  return session?.kind === 'agent' ? session : null;
}

async function buildMetrics(user: UserRow, deps: Deps): Promise<{ metrics: Metrics; github: GitHubMetrics | null }> {
  const now = deps.now();
  const [machines, stats, prices] = await Promise.all([
    loadUsage(deps.db, user.id),
    loadGitHubStats(deps.db, user.id),
    loadPrices(deps.db, deps.fetch, deps.waitUntil, now),
  ]);
  const github = stats?.metrics ?? null;
  const tokens = computeTokens(machines, prices, user.timezone, now, github?.commitsLast30 ?? null);
  return { metrics: { generatedDate: zoned(now, user.timezone).date, timezone: user.timezone, github, tokens }, github };
}

const hasData = (metrics: Metrics) => Boolean(metrics.github || metrics.tokens);

const daysFrom = (now: Date, days: number) => new Date(now.getTime() + days * 86_400_000).toISOString();

const clientIp = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'unknown';

const tooMany = () => new Response('Too many requests', { status: 429, headers: { 'retry-after': '60', 'cache-control': 'no-store' } });

/** Query strings and letter case can't be used to get around the cache. */
const publicKey = (request: Request) => {
  const url = new URL(request.url);
  return new Request(`${url.origin}${url.pathname.toLowerCase()}`);
};

/**
 * Drawing a dashboard is the most expensive thing this service does, so public pages come
 * from the edge cache. Only pages with data are cached, so publishing and a first upload
 * show at once.
 * The limit applies to cache misses, by address and page: GitHub's image proxy fetches
 * everyone's dashboards from a few addresses, and must not be blocked for that.
 */
async function cachedPublic(request: Request, deps: Deps, render: () => Promise<Response>): Promise<Response> {
  const key = publicKey(request);
  const hit = await deps.cache?.match(key);
  if (hit) {
    // Cloudflare raises the lifetime on what it stores to the zone's browser setting, which
    // would keep a page in browsers for hours after it was made private.
    const response = new Response(hit.body, hit);
    response.headers.set('cache-control', PUBLIC_CACHE);
    return response;
  }
  if (deps.allow && !(await deps.allow('public', `${clientIp(request)}:${new URL(request.url).pathname.toLowerCase()}`))) return tooMany();
  const response = await render();
  if (deps.cache && response.headers.get('cache-control') === PUBLIC_CACHE) deps.waitUntil(deps.cache.put(key, response.clone()));
  return response;
}

/**
 * Removes a profile from this location's cache. Other locations let it expire, so a page
 * made private can stay visible there for up to five minutes.
 */
async function purgeProfile(request: Request, deps: Deps, login: string): Promise<void> {
  const { cache } = deps;
  if (!cache) return;
  const base = `${new URL(request.url).origin}/u/${login.toLowerCase()}`;
  const urls = [base, `${base}/dashboard.svg`, ...CARD_KEYS.map((key) => `${base}/cards/${key}.txt`)];
  await Promise.all(urls.map((url) => cache.delete(new Request(url))));
}

// Public pages. A private or missing profile answers the same way, so neither is revealed.

async function publicProfile(login: string, deps: Deps): Promise<UserRow | null> {
  const user = await userByLogin(deps.db, login);
  return user?.is_public === 1 ? user : null;
}

async function serveDashboardSvg(login: string, deps: Deps): Promise<Response> {
  const user = await publicProfile(login, deps);
  if (!user) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const { metrics } = await buildMetrics(user, deps);
  return new Response(renderDashboard(metrics), {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': hasData(metrics) ? PUBLIC_CACHE : 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
    },
  });
}

async function serveCard(login: string, key: string, deps: Deps): Promise<Response> {
  const notFound = () => new Response('Not found', { status: 404 });
  const user = await publicProfile(login, deps);
  if (!user) return notFound();
  const { metrics } = await buildMetrics(user, deps);
  const card = buildCards(metrics).find((item: Card) => item.key === key);
  if (!card) return notFound();
  return new Response(cardContent(card, metrics.generatedDate), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': hasData(metrics) ? PUBLIC_CACHE : 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

async function renderProfile(login: string, request: Request, deps: Deps, viewer: UserRow | null): Promise<Response> {
  const user = await publicProfile(login, deps);
  if (!user) return html(errorPage(404, 'This profile is private or does not exist.', viewer), 404);
  const { metrics } = await buildMetrics(user, deps);
  const origin = new URL(request.url).origin;
  // The page names whoever is signed in, so only signed-out visits share a cached copy.
  const shared = !viewer && hasData(metrics);
  return html(profilePage(user, renderDashboard(metrics), buildCards(metrics), origin, viewer), 200, shared ? { 'cache-control': PUBLIC_CACHE } : {});
}

async function serveProfile(login: string, request: Request, deps: Deps): Promise<Response> {
  // A cookie alone proves nothing, so it can't be used to skip the cache or the limit.
  if (readCookie(request, SESSION_COOKIE)) {
    if (deps.allow && !(await deps.allow('public', `session:${clientIp(request)}`))) return tooMany();
    const viewer = await viewerFromCookie(request, deps);
    if (viewer) return renderProfile(login, request, deps, viewer);
  }
  return cachedPublic(request, deps, () => renderProfile(login, request, deps, null));
}

// Website sign-in.

async function startLogin(request: Request, deps: Deps): Promise<Response> {
  if (deps.allow && !(await deps.allow('strict', clientIp(request)))) return tooMany();
  if (!deps.githubClientId) return html(errorPage(503, 'GitHub sign-in is not configured on this server.', null), 503);
  const url = new URL(request.url);
  const state = randomToken('');
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', deps.githubClientId);
  authorize.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
  authorize.searchParams.set('scope', 'read:user');
  authorize.searchParams.set('state', state);
  return redirect(authorize.toString(), { 'set-cookie': cookie(request, STATE_COOKIE, state, 600) });
}

async function finishLogin(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = readCookie(request, STATE_COOKIE);
  if (!code || !state || !expected || !(await safeEqual(state, expected))) {
    return html(errorPage(400, 'That sign-in link expired. Please try again.', null), 400);
  }
  const identity = await identityFromCode(authConfig(deps), code, `${url.origin}/auth/callback`);
  const now = deps.now();
  const user = await upsertUser(deps.db, identity, now.toISOString());
  const token = randomToken('omsw_');
  const expires = new Date(now.getTime() + WEB_SESSION_SECONDS * 1000).toISOString();
  await createSession(deps.db, await hashToken(token), user.id, 'web', null, expires, now.toISOString());
  const headers = new Headers({ location: '/me', 'cache-control': 'no-store' });
  headers.append('set-cookie', cookie(request, SESSION_COOKIE, token, WEB_SESSION_SECONDS));
  headers.append('set-cookie', cookie(request, STATE_COOKIE, '', 0));
  return new Response(null, { status: 303, headers });
}

// The signed-in dashboard.

async function serveMe(request: Request, deps: Deps): Promise<Response> {
  const viewer = await viewerFromCookie(request, deps);
  if (!viewer) return redirect('/login');
  const [machines, { metrics }] = await Promise.all([listMachines(deps.db, viewer.id), buildMetrics(viewer, deps)]);
  const tokensByMachine = new Map((metrics.tokens?.machines ?? []).map((row) => [row.id, row.total]));
  const svg = hasData(metrics) ? renderDashboard(metrics) : null;
  return html(dashboardPage(viewer, machines, tokensByMachine, svg, new URL(request.url).origin));
}

async function handleWebPost(request: Request, path: string, deps: Deps): Promise<Response> {
  if (!isSameOrigin(request)) return html(errorPage(403, 'That request came from another site.', null), 403);
  const viewer = await viewerFromCookie(request, deps);
  if (!viewer) return redirect('/login');
  const now = deps.now().toISOString();
  const form = new URLSearchParams(await readLimited(request, 4096));

  if (path === '/logout') {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) await deleteSession(deps.db, await hashToken(token));
    return redirect('/', { 'set-cookie': cookie(request, SESSION_COOKIE, '', 0) });
  }
  if (path === '/me/visibility') {
    const isPublic = form.get('public') === '1';
    await setPublic(deps.db, viewer.id, isPublic, now);
    if (!isPublic) await purgeProfile(request, deps, viewer.login);
    return redirect('/me');
  }
  if (path === '/me/delete') {
    await deleteUser(deps.db, viewer.id);
    await purgeProfile(request, deps, viewer.login);
    return redirect('/', { 'set-cookie': cookie(request, SESSION_COOKIE, '', 0) });
  }
  const machineAction = /^\/me\/machines\/([a-f0-9]{16,64})\/(rename|delete)$/.exec(path);
  if (machineAction) {
    const [, machineId, action] = machineAction;
    if (action === 'delete') await deleteMachine(deps.db, viewer.id, machineId);
    else await renameMachine(deps.db, viewer.id, machineId, cleanMachineName(form.get('name')));
    return redirect('/me');
  }
  return html(errorPage(404, 'Page not found.', viewer), 404);
}

// The API agents use.

async function handleApi(request: Request, path: string, deps: Deps): Promise<Response> {
  const now = deps.now();
  if (path === '/v1/config' && request.method === 'GET') {
    return json({ githubClientId: deps.githubClientId || null, allowAnyGitHubToken: deps.allowAnyGitHubToken });
  }
  if (path === '/v1/auth/token' && request.method === 'POST') {
    if (deps.allow && !(await deps.allow('strict', clientIp(request)))) return json({ error: 'Too many sign-in attempts. Try again in a minute.' }, 429);
    const body = (await readJson(request, 8192)) as { githubToken?: unknown; machine?: unknown };
    if (typeof body?.githubToken !== 'string' || !body.githubToken) throw new BadRequest('githubToken is required');
    const machine = parseMachine(body.machine);
    const identity = await identityFromAgentToken(authConfig(deps), body.githubToken);
    const user = await upsertUser(deps.db, identity, now.toISOString());
    const machines = await listMachines(deps.db, user.id);
    if (machines.length >= MAX_MACHINES_PER_ACCOUNT && !machines.some((row) => row.id === machine.id)) {
      return json({ error: 'This account has too many machines. Remove one on your dashboard.' }, 403);
    }
    await upsertMachine(deps.db, user.id, machine, now.toISOString());
    const token = randomToken('omsa_');
    await createSession(deps.db, await hashToken(token), user.id, 'agent', machine.id, daysFrom(now, AGENT_SESSION_DAYS), now.toISOString());
    return json({ token, user: { login: user.login, public: user.is_public === 1 } });
  }

  const session = await agentSession(request, deps);
  if (!session) return json({ error: 'Sign in again with `oms login`.' }, 401);
  // Writing costs far more than reading, and an agent only has a few uploads to make.
  const kind = request.method === 'GET' ? 'public' : 'strict';
  if (deps.allow && !(await deps.allow(kind, `agent:${session.user_id}`))) return json({ error: 'Too many requests. Try again in a minute.' }, 429);

  if (path === '/v1/usage' && request.method === 'PUT') {
    const upload = parseUsageUpload(await readJson(request, MAX_USAGE_BYTES), now);
    if (upload.machine.id !== session.machine_id) return json({ error: 'This token belongs to another machine.' }, 403);
    await upsertMachine(deps.db, session.user_id, upload.machine, now.toISOString());
    await saveUsage(deps.db, session.user_id, upload, now.toISOString());
    if (!session.expires_at || session.expires_at < daysFrom(now, AGENT_SESSION_RENEW_DAYS)) {
      await renewSession(deps.db, session.token_hash, daysFrom(now, AGENT_SESSION_DAYS));
    }
    return json({ ok: true, collectGitHub: await claimGitHubCollection(deps.db, session.user_id, now) });
  }
  if (path === '/v1/github' && request.method === 'PUT') {
    const metrics = parseGitHubMetrics(await readJson(request, MAX_GITHUB_BYTES));
    const user = await userById(deps.db, session.user_id);
    if (metrics.login.toLowerCase() !== user?.login.toLowerCase()) return json({ error: 'These stats belong to another GitHub account.' }, 403);
    await saveGitHubStats(deps.db, session.user_id, metrics, now.toISOString());
    return json({ ok: true });
  }
  if (path === '/v1/me' && request.method === 'GET') {
    const user = await userById(deps.db, session.user_id);
    if (!user) return json({ error: 'Account not found.' }, 401);
    const [machines, { metrics }] = await Promise.all([listMachines(deps.db, user.id), buildMetrics(user, deps)]);
    const totals = new Map((metrics.tokens?.machines ?? []).map((row) => [row.id, row.total]));
    return json({
      login: user.login,
      public: user.is_public === 1,
      profileUrl: `${new URL(request.url).origin}/u/${encodeURIComponent(user.login)}`,
      machine: session.machine_id,
      tokens: metrics.tokens ? { total: metrics.tokens.total, tools: metrics.tokens.tools.map(({ tool, total, scope, machines: count }) => ({ tool, total, scope, machines: count })) } : null,
      github: metrics.github ? { commits: metrics.github.counts.commits, pulls: metrics.github.counts.pulls } : null,
      machines: machines.map((machine) => ({ id: machine.id, name: machine.name, platform: machine.platform, lastSeenAt: machine.last_seen_at, tokens: totals.get(machine.id) ?? 0 })),
    });
  }
  if (path === '/v1/me' && request.method === 'PATCH') {
    const body = (await readJson(request, 1024)) as { public?: unknown };
    if (typeof body?.public !== 'boolean') throw new BadRequest('public must be true or false');
    await setPublic(deps.db, session.user_id, body.public, now.toISOString());
    if (!body.public) {
      const user = await userById(deps.db, session.user_id);
      if (user) await purgeProfile(request, deps, user.login);
    }
    return json({ ok: true, public: body.public });
  }
  if (path === '/v1/auth/logout' && request.method === 'POST') {
    const header = request.headers.get('authorization') as string;
    await deleteSession(deps.db, await hashToken(header.slice(7)));
    return json({ ok: true });
  }
  return json({ error: 'Not found.' }, 404);
}

async function route(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith('/v1/')) {
    try {
      return await handleApi(request, path, deps);
    } catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, 400);
      if (error instanceof AuthError) return json({ error: error.message }, 401);
      if (error instanceof OverQuota) return json({ error: error.message }, 429);
      throw error;
    }
  }
  if (request.method === 'POST') return handleWebPost(request, path, deps);
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });

  if (path === '/healthz') return json({ ok: true });
  if (path === '/') return html(landingPage(url.origin, await viewerFromCookie(request, deps)));
  if (path === '/login') return startLogin(request, deps);
  if (path === '/auth/callback') return finishLogin(request, deps);
  if (path === '/me') return serveMe(request, deps);

  const profile = /^\/u\/([A-Za-z0-9-]{1,39})(?:\/(dashboard\.svg|cards\/([a-z]+)\.txt))?$/.exec(path);
  if (profile) {
    const [, login, resource, cardKey] = profile;
    if (resource === 'dashboard.svg') return cachedPublic(request, deps, () => serveDashboardSvg(login, deps));
    if (cardKey) return cachedPublic(request, deps, () => serveCard(login, cardKey, deps));
    return serveProfile(login, request, deps);
  }
  return html(errorPage(404, 'Page not found.', await viewerFromCookie(request, deps)), 404);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Development shortcuts apply only on this computer, whatever the settings say. */
export const isLocalRequest = (request: Request) => LOCAL_HOSTS.has(new URL(request.url).hostname);

export async function handle(request: Request, deps: Deps): Promise<Response> {
  try {
    // Sign-in tokens must not cross the network in the clear. 308 keeps the method and body.
    const url = new URL(request.url);
    if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
      url.protocol = 'https:';
      return new Response(null, { status: 308, headers: { location: url.toString(), 'cache-control': 'no-store' } });
    }
    return await route(request, deps);
  } catch (error) {
    if (error instanceof BadRequest) return html(errorPage(400, error.message, null), 400);
    if (error instanceof AuthError) return html(errorPage(401, error.message, null), 401);
    console.error(JSON.stringify({ message: 'unhandled error', path: new URL(request.url).pathname, error: String(error) }));
    return html(errorPage(500, 'Something went wrong on our side.', null), 500);
  }
}
