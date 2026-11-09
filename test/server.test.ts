import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handle, type Deps } from '../src/server/app.ts';
import { testDb } from './sqlite-d1.ts';
import { githubMetrics } from './fixtures.ts';

const ORIGIN = 'https://stats.example';
const MACHINE_A = 'a'.repeat(32);
const MACHINE_B = 'b'.repeat(32);
const SECRET_NAME = 'jays-secret-macbook';

interface GitHubUser {
  id: number;
  login: string;
  name?: string;
  avatar_url?: string;
}

/** A fake GitHub. `tokens` maps a token to its owner; `appTokens` are those issued to this app. */
function fakeGitHub(tokens: Record<string, GitHubUser>, appTokens: string[] = []) {
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

const octo: GitHubUser = { id: 1, login: 'octo', name: 'Octo Cat', avatar_url: 'https://avatars.githubusercontent.com/u/1' };

function app(overrides: Partial<Deps> = {}, tokens: Record<string, GitHubUser> = { 'gh-token': octo, 'web-token': octo }) {
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
  const call = (path: string, init: RequestInit = {}) => handle(new Request(`${ORIGIN}${path}`, init), deps);
  return { deps, call, github, setTime: (next: string) => (time = new Date(next)) };
}

const api = (token: string | null, method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const machine = (id: string, name = SECRET_NAME) => ({ id, name, platform: 'macos', agentVersion: '0.1.0' });

async function signIn(context: ReturnType<typeof app>, machineId = MACHINE_A, name = SECRET_NAME): Promise<string> {
  const response = await context.call('/v1/auth/token', api(null, 'POST', { githubToken: 'gh-token', machine: machine(machineId, name) }));
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}

const upload = (machineId: string, day = '2026-11-08', tuple = [1, 2, 3, 4, 5]) => ({
  machine: machine(machineId),
  timezone: 'Asia/Seoul',
  days: { [day]: { 'claude/claude-opus-5-5': tuple } },
  totals: {},
});

test('signing in returns a token that is stored only as a hash', async () => {
  const context = app();
  const token = await signIn(context);
  assert.match(token, /^omsa_[a-f0-9]{64}$/);
  const dump = JSON.stringify((context.deps.db as ReturnType<typeof testDb>).raw.prepare('SELECT * FROM sessions').all());
  assert.ok(!dump.includes(token));
  assert.ok(!dump.includes('gh-token'), 'the GitHub token is never stored');
});

test('production accepts only tokens issued to this app', async () => {
  const github = fakeGitHub({ 'our-token': octo, 'other-app-token': octo }, ['our-token']);
  const context = app({ allowAnyGitHubToken: false, fetch: github.impl });
  const attempt = (githubToken: string) => context.call('/v1/auth/token', api(null, 'POST', { githubToken, machine: machine(MACHINE_A) }));
  assert.equal((await attempt('other-app-token')).status, 401, 'a valid token from another app is refused');
  assert.equal((await attempt('our-token')).status, 200);
});

test('a bad GitHub token and malformed requests are refused', async () => {
  const context = app();
  const post = (body: unknown) => context.call('/v1/auth/token', api(null, 'POST', body));
  assert.equal((await post({ githubToken: 'nope', machine: machine(MACHINE_A) })).status, 401);
  assert.equal((await post({ machine: machine(MACHINE_A) })).status, 400);
  assert.equal((await post({ githubToken: 'gh-token', machine: { id: 'not-hex' } })).status, 400);
  assert.equal((await context.call('/v1/auth/token', { method: 'POST', body: '{nope' })).status, 400);
});

test('the API requires a valid agent token', async () => {
  const context = app();
  assert.equal((await context.call('/v1/me', api(null, 'GET'))).status, 401);
  assert.equal((await context.call('/v1/me', api('omsa_wrong', 'GET'))).status, 401);
  assert.equal((await context.call('/v1/usage', api(null, 'PUT', upload(MACHINE_A)))).status, 401);
});

test('an agent can only write as its own machine', async () => {
  const context = app();
  const token = await signIn(context, MACHINE_A);
  assert.equal((await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_B)))).status, 403);
});

test('re-uploading a day replaces it, so a retry changes nothing', async () => {
  const context = app();
  const token = await signIn(context);
  const me = async () => ((await (await context.call('/v1/me', api(token, 'GET'))).json()) as { tokens: { total: number } }).tokens.total;
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  assert.equal(await me(), 10);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  assert.equal(await me(), 10);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A, '2026-11-08', [10, 0, 0, 0, 1])));
  assert.equal(await me(), 10);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A, '2026-11-08', [20, 0, 0, 0, 1])));
  assert.equal(await me(), 20);
});

test('two machines on one account combine correctly', async () => {
  const context = app();
  const laptop = await signIn(context, MACHINE_A);
  const desktop = await signIn(context, MACHINE_B, 'desktop');
  const figure = { scope: 'account', total: 500, asOf: '2026-11-08', daily: { '2026-11-01': 500 } };
  await context.call('/v1/usage', api(laptop, 'PUT', { ...upload(MACHINE_A), totals: { codex: figure, claude: { scope: 'machine', total: 100, asOf: '2026-11-08' } } }));
  await context.call('/v1/usage', api(desktop, 'PUT', { ...upload(MACHINE_B), totals: { codex: figure, claude: { scope: 'machine', total: 50, asOf: '2026-11-08' } } }));
  const me = (await (await context.call('/v1/me', api(laptop, 'GET'))).json()) as { tokens: { total: number; tools: { tool: string; total: number; machines: number }[] }; machines: unknown[] };
  assert.equal(me.machines.length, 2);
  assert.equal(me.tokens.tools.find((row) => row.tool === 'claude')?.total, 150);
  assert.equal(me.tokens.tools.find((row) => row.tool === 'codex')?.total, 500, 'counted once');
  assert.equal(me.tokens.total, 650);
});

test('uploads are validated, because model names reach public pages', async () => {
  const context = app();
  const token = await signIn(context);
  const send = (body: unknown) => context.call('/v1/usage', api(token, 'PUT', body));
  const base = upload(MACHINE_A);
  assert.equal((await send({ ...base, days: { '2026-11-08': { 'claude/<script>alert(1)</script>': [1, 1, 1, 1, 1] } } })).status, 400);
  assert.equal((await send({ ...base, days: { 'not-a-date': {} } })).status, 400);
  assert.equal((await send({ ...base, days: { '2031-01-01': {} } })).status, 400, 'no future dates');
  assert.equal((await send({ ...base, days: { '2026-11-08': { 'claude/m': [1, 1, 1, 1] } } })).status, 400);
  assert.equal((await send({ ...base, days: { '2026-11-08': { 'claude/m': [-1, 1, 1, 1, 1] } } })).status, 400);
  assert.equal((await send({ ...base, totals: { claude: { scope: 'everywhere', total: 1 } } })).status, 400);
  assert.equal((await send({ ...base, totals: { claude: { scope: 'machine', total: 1, models: { 'a b': [1, 1, 1, 1] } } } })).status, 400);
});

test('an oversized body is refused without being read', async () => {
  const context = app();
  const token = await signIn(context);
  const response = await context.call('/v1/usage', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-length': '99999999' }, body: '{}' });
  assert.equal(response.status, 400);
});

test('a profile is private until published, and looks the same as a missing one', async () => {
  const context = app();
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  for (const path of ['/u/octo', '/u/octo/dashboard.svg', '/u/octo/cards/tokens.txt']) {
    assert.equal((await context.call(path)).status, 404, path);
  }
  assert.equal((await context.call('/u/nobody/dashboard.svg')).status, 404);

  assert.equal((await context.call('/v1/me', api(token, 'PATCH', { public: true }))).status, 200);
  for (const path of ['/u/octo', '/u/OCTO', '/u/octo/dashboard.svg', '/u/octo/cards/tokens.txt']) {
    assert.equal((await context.call(path)).status, 200, path);
  }
  await context.call('/v1/me', api(token, 'PATCH', { public: false }));
  assert.equal((await context.call('/u/octo/dashboard.svg')).status, 404, 'unpublishing works');
});

test('public pages never show machine names or ids', async () => {
  const context = app();
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  await context.call('/v1/github', api(token, 'PUT', githubMetrics()));
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  for (const path of ['/u/octo', '/u/octo/dashboard.svg', '/u/octo/cards/tokens.txt', '/u/octo/cards/contributions.txt']) {
    const text = await (await context.call(path)).text();
    assert.ok(!text.includes(SECRET_NAME), `${path} leaks the machine name`);
    assert.ok(!text.includes(MACHINE_A), `${path} leaks the machine id`);
  }
});

test('the public dashboard is a locked-down, cacheable image', async () => {
  const context = app();
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  const response = await context.call('/u/octo/dashboard.svg');
  assert.match(response.headers.get('content-type') ?? '', /image\/svg\+xml/);
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  assert.ok((await response.text()).includes('</svg>'));
});

test('only the account that owns the stats can upload them', async () => {
  const context = app();
  const token = await signIn(context);
  assert.equal((await context.call('/v1/github', api(token, 'PUT', githubMetrics({ login: 'someone-else' })))).status, 403);
  assert.equal((await context.call('/v1/github', api(token, 'PUT', { login: 'octo' }))).status, 400, 'malformed metrics');
  assert.equal((await context.call('/v1/github', api(token, 'PUT', githubMetrics()))).status, 200);
});

test('one machine at a time collects GitHub stats, about every six hours', async () => {
  const context = app();
  const laptop = await signIn(context, MACHINE_A);
  const desktop = await signIn(context, MACHINE_B, 'desktop');
  const sync = async (token: string, id: string) => ((await (await context.call('/v1/usage', api(token, 'PUT', upload(id)))).json()) as { collectGitHub: boolean }).collectGitHub;

  assert.equal(await sync(laptop, MACHINE_A), true, 'nothing collected yet');
  assert.equal(await sync(desktop, MACHINE_B), false, 'another machine holds the lease');
  await context.call('/v1/github', api(laptop, 'PUT', githubMetrics()));
  assert.equal(await sync(desktop, MACHINE_B), false, 'fresh');
  context.setTime('2026-11-09T12:00:00Z');
  assert.equal(await sync(desktop, MACHINE_B), true, 'stale');
  assert.equal(await sync(laptop, MACHINE_A), false);
  context.setTime('2026-11-09T12:45:00Z');
  assert.equal(await sync(laptop, MACHINE_A), true, 'a lease expires if its holder never finishes');
});

test('prices are fetched once and stored', async () => {
  const context = app();
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  await context.call('/v1/me', api(token, 'GET'));
  await context.call('/v1/me', api(token, 'GET'));
  assert.equal(context.github.calls.filter((url) => url.includes('model_prices')).length, 1);
});

async function webLogin(context: ReturnType<typeof app>): Promise<string> {
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

const webPost = (cookie: string, body = '', origin = ORIGIN): RequestInit => ({
  method: 'POST',
  headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
  body,
});

test('website sign-in checks its state, so a forged callback fails', async () => {
  const context = app();
  await webLogin(context);
  assert.equal((await context.call('/auth/callback?code=good-code&state=forged', { headers: { cookie: 'oms_state=real' } })).status, 400);
  assert.equal((await context.call('/auth/callback?code=good-code&state=x')).status, 400);
  const start = await context.call('/login');
  const state = new URL(start.headers.get('location') as string).searchParams.get('state');
  const stateCookie = (start.headers.get('set-cookie') as string).split(';')[0];
  assert.equal((await context.call(`/auth/callback?code=bad&state=${state}`, { headers: { cookie: stateCookie } })).status, 401);
});

test('the dashboard requires sign-in and shows the owner their machines', async () => {
  const context = app();
  assert.equal((await context.call('/me')).status, 303);
  const agent = await signIn(context);
  await context.call('/v1/usage', api(agent, 'PUT', upload(MACHINE_A)));
  const session = await webLogin(context);
  const page = await context.call('/me', { headers: { cookie: session } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const text = await page.text();
  assert.ok(text.includes(SECRET_NAME), 'the owner sees machine names');
  assert.ok(text.includes('Publish profile'));
});

test('an agent token cannot open the website, nor a web session the API', async () => {
  const context = app();
  const agent = await signIn(context);
  const session = await webLogin(context);
  assert.equal((await context.call('/me', { headers: { cookie: `oms_session=${agent}` } })).status, 303);
  const webToken = session.split('=')[1];
  assert.equal((await context.call('/v1/me', api(webToken, 'GET'))).status, 401);
});

test('forms posted from another site are refused', async () => {
  const context = app();
  const session = await webLogin(context);
  const attack = await context.call('/me/visibility', webPost(session, 'public=1', 'https://evil.example'));
  assert.equal(attack.status, 403);
  const noOrigin = await context.call('/me/visibility', { method: 'POST', headers: { cookie: session }, body: 'public=1' });
  assert.equal(noOrigin.status, 403);
  assert.equal((await context.call('/u/octo')).status, 404, 'nothing changed');
});

test('the owner can publish, rename and remove a machine from the website', async () => {
  const context = app();
  const agent = await signIn(context);
  await context.call('/v1/usage', api(agent, 'PUT', upload(MACHINE_A)));
  const session = await webLogin(context);

  assert.equal((await context.call('/me/visibility', webPost(session, 'public=1'))).status, 303);
  assert.equal((await context.call('/u/octo')).status, 200);

  await context.call(`/me/machines/${MACHINE_A}/rename`, webPost(session, 'name=Work%20%3Cb%3ELaptop'));
  const page = await (await context.call('/me', { headers: { cookie: session } })).text();
  assert.ok(page.includes('Work bLaptop'), 'markup is stripped from names');
  assert.ok(!page.includes('<b>Laptop'));

  // An agent's next sync must not undo a name chosen on the website.
  await context.call('/v1/usage', api(agent, 'PUT', upload(MACHINE_A)));
  assert.ok((await (await context.call('/me', { headers: { cookie: session } })).text()).includes('Work bLaptop'));

  await context.call(`/me/machines/${MACHINE_A}/delete`, webPost(session));
  const removed = await context.call('/v1/usage', api(agent, 'PUT', upload(MACHINE_A)));
  assert.equal(removed.status, 401, 'removing a machine signs it out');
  const rows = (context.deps.db as ReturnType<typeof testDb>).raw.prepare('SELECT COUNT(*) AS n FROM usage_daily').get() as { n: number };
  assert.equal(rows.n, 0, 'and deletes its data');
});

test('a user cannot touch another user\'s machine', async () => {
  const other: GitHubUser = { id: 2, login: 'mallory' };
  const context = app({}, { 'gh-token': octo, 'web-token': other });
  const victim = await signIn(context);
  await context.call('/v1/usage', api(victim, 'PUT', upload(MACHINE_A)));
  const session = await webLogin(context);
  await context.call(`/me/machines/${MACHINE_A}/delete`, webPost(session));
  const raw = (context.deps.db as ReturnType<typeof testDb>).raw;
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM usage_daily').get() as { n: number }).n, 1);
});

test('deleting an account removes everything', async () => {
  const context = app();
  const agent = await signIn(context);
  await context.call('/v1/usage', api(agent, 'PUT', upload(MACHINE_A)));
  await context.call('/v1/github', api(agent, 'PUT', githubMetrics()));
  const session = await webLogin(context);
  assert.equal((await context.call('/me/delete', webPost(session))).status, 303);
  const raw = (context.deps.db as ReturnType<typeof testDb>).raw;
  for (const table of ['users', 'sessions', 'machines', 'usage_daily', 'tool_totals', 'github_stats']) {
    assert.equal((raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  }
  assert.equal((await context.call('/v1/me', api(agent, 'GET'))).status, 401);
});

test('a renamed GitHub account keeps its data, and a reused login gets none of it', async () => {
  const renamed: GitHubUser = { id: 1, login: 'octo-new' };
  const newcomer: GitHubUser = { id: 3, login: 'octo' };
  const tokens = { 'gh-token': octo, renamed, newcomer };
  const context = app({}, tokens);
  const first = await signIn(context);
  await context.call('/v1/usage', api(first, 'PUT', upload(MACHINE_A)));
  await context.call('/v1/me', api(first, 'PATCH', { public: true }));

  const signInAs = (githubToken: string, id: string) => context.call('/v1/auth/token', api(null, 'POST', { githubToken, machine: machine(id) }));
  assert.equal((await signInAs('renamed', MACHINE_A)).status, 200);
  assert.equal((await context.call('/u/octo-new')).status, 200);
  assert.equal((await context.call('/u/octo')).status, 404);

  assert.equal((await signInAs('newcomer', MACHINE_B)).status, 200);
  assert.equal((await context.call('/u/octo')).status, 404, 'the newcomer starts private and empty');
});

test('unknown pages, methods and servers without sign-in configured fail cleanly', async () => {
  const context = app();
  assert.equal((await context.call('/nope')).status, 404);
  assert.equal((await context.call('/', { method: 'DELETE' })).status, 405);
  assert.equal((await context.call('/healthz')).status, 200);
  assert.equal((await app({ githubClientId: '' }).call('/login')).status, 503);
});
