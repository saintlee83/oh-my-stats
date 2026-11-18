import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { handle, isLocalRequest, LATEST_RELEASE, type Deps } from '../src/server/app.ts';
import { LOGO_SVG } from '../src/server/logo.ts';
import { COMPONENT_KEYS } from '../src/shared/render/svg.ts';
import { testDb } from './sqlite-d1.ts';
import { githubMetrics } from './fixtures.ts';
import {
  api, app, countingDb, fakeCache, fakeGitHub, MACHINE_A, MACHINE_B, machine, octo, ORIGIN, published, SECRET_NAME, signIn, upload, webLogin, webPost,
  type GitHubUser,
} from './harness.ts';

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
  for (const path of ['/u/octo', '/u/octo/dashboard.svg', '/u/octo/cards/tokens.txt', '/u/octo/components/tokens.svg']) {
    assert.equal((await context.call(path)).status, 404, path);
  }
  assert.equal((await context.call('/u/nobody/dashboard.svg')).status, 404);
  assert.equal((await context.call('/u/nobody/components/tokens.svg')).status, 404);

  assert.equal((await context.call('/v1/me', api(token, 'PATCH', { public: true }))).status, 200);
  for (const path of ['/u/octo', '/u/OCTO', '/u/octo/dashboard.svg', '/u/octo/cards/tokens.txt', '/u/octo/components/tokens.svg']) {
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
  const parts = COMPONENT_KEYS.map((key) => `/u/octo/components/${key}.svg`);
  for (const path of ['/u/octo', '/u/octo/dashboard.svg', '/u/octo/cards/tokens.txt', '/u/octo/cards/contributions.txt', ...parts]) {
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

test('each part of the dashboard is its own locked-down, cacheable image', async () => {
  const context = app();
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  await context.call('/v1/github', api(token, 'PUT', githubMetrics()));
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  const dashboard = await (await context.call('/u/octo/dashboard.svg')).text();
  const drawn: Record<string, string> = {};
  for (const key of COMPONENT_KEYS) {
    const response = await context.call(`/u/octo/components/${key}.svg`);
    assert.equal(response.status, 200, key);
    assert.match(response.headers.get('content-type') ?? '', /image\/svg\+xml/, key);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/, key);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300', key);
    drawn[key] = await response.text();
    assert.match(drawn[key], /^<svg [^>]*viewBox="0 0 1000 [\d.]+"/, `${key} is as wide as the dashboard`);
    assert.ok(drawn[key].length < dashboard.length, `${key} is smaller than the whole dashboard`);
  }
  assert.ok(drawn.languages.includes('Top languages') && !drawn.languages.includes('AI token trace'));
  assert.ok(drawn.tokens.includes('AI token trace') && !drawn.tokens.includes('Top languages'));
  assert.ok(drawn.rhythm.includes('When contributions happen'));
  assert.ok(!drawn.rhythm.includes('updated 2026'), 'only the whole dashboard has a footer');

  for (const path of ['/u/octo/components/nope.svg', '/u/octo/components/Tokens.svg', '/u/octo/components/tokens.png', '/u/octo/components/']) {
    assert.equal((await context.call(path)).status, 404, path);
  }
});

test('a part without its data says so, and is not cached until it has some', async () => {
  const cache = fakeCache();
  const { context, token } = await published({ cache });
  const empty = await context.call('/u/octo/components/languages.svg');
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('cache-control'), 'no-store');
  assert.ok((await empty.text()).includes('No GitHub stats yet.'));
  assert.equal((await context.call('/u/octo/components/tokens.svg')).headers.get('cache-control'), 'public, max-age=300');
  assert.equal(cache.store.size, 1);

  const page = await (await context.call('/u/octo')).text();
  assert.ok(page.includes('/u/octo/components/tokens.svg'), 'the profile lists the parts with data');
  assert.ok(!page.includes('/u/octo/components/languages.svg'), 'and only those');

  await context.call('/v1/github', api(token, 'PUT', githubMetrics()));
  const full = await context.call('/u/octo/components/languages.svg');
  assert.equal(full.headers.get('cache-control'), 'public, max-age=300');
  assert.ok((await full.text()).includes('TypeScript'));
});

test('an image can use the Tokyo Night theme, however the name is written', async () => {
  const cache = fakeCache();
  const { context } = await published({ cache });
  const github = await (await context.call('/u/octo/dashboard.svg')).text();
  const tokyo = await (await context.call('/u/octo/dashboard.svg?theme=tokyo-night')).text();
  assert.ok(github.includes('--surface:#0d1117;') && !github.includes('#1a1b26'), 'GitHub colors by default');
  assert.ok(tokyo.includes('--surface:#1a1b26;') && !tokyo.includes('#0d1117'), 'Tokyo Night when asked');
  assert.equal(cache.store.size, 2, 'one copy per theme');

  for (const query of ['?theme=tokyonight', '?theme=Tokyo-Night&v=2', '?v=1&theme=TOKYO_NIGHT']) {
    assert.equal(await (await context.call(`/u/octo/dashboard.svg${query}`)).text(), tokyo, query);
  }
  for (const query of ['?theme=github', '?theme=nope', '?theme=']) {
    assert.equal(await (await context.call(`/u/octo/dashboard.svg${query}`)).text(), github, query);
  }
  assert.equal(cache.store.size, 2, 'other spellings share those copies');

  const part = await (await context.call('/u/octo/components/tokens.svg?theme=tokyo-night')).text();
  assert.ok(part.includes('--surface:#1a1b26;'), 'parts take a theme too');
  await context.call('/u/octo?theme=tokyo-night');
  await context.call('/u/octo');
  assert.equal(cache.store.size, 4, 'pages other than images ignore the theme');
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

test('a machine without GitHub access leaves collecting to one that has it', async () => {
  const context = app();
  const laptop = await signIn(context, MACHINE_A);
  const desktop = await signIn(context, MACHINE_B, 'desktop');
  const sync = async (token: string, id: string, canCollectGitHub?: boolean) =>
    ((await (await context.call('/v1/usage', api(token, 'PUT', { ...upload(id), canCollectGitHub }))).json()) as { collectGitHub: boolean }).collectGitHub;

  assert.equal(await sync(desktop, MACHINE_B, false), false, 'no access, so it is never asked');
  assert.equal(await sync(laptop, MACHINE_A, true), true, 'and it took no lease');
  context.setTime('2026-11-09T12:45:00Z');
  assert.equal(await sync(desktop, MACHINE_B), true, 'an agent that does not say can still collect');
});

test('prices are fetched once and stored', async () => {
  const context = app();
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  await context.call('/v1/me', api(token, 'GET'));
  await context.call('/v1/me', api(token, 'GET'));
  assert.equal(context.github.calls.filter((url) => url.includes('model_prices')).length, 1);
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
  assert.equal((await context.call('/me/delete', webPost(session, 'confirm=octo'))).status, 303);
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

test('the install steps name the server, except on the hosted one the agent already defaults to', async () => {
  const context = app();
  assert.match(await (await context.call('/')).text(), /oms login --server https:\/\/stats\.example/);
  const hosted = await handle(new Request('https://ohmystats.dev/'), context.deps);
  const text = await hosted.text();
  assert.match(text, /oms login\n/);
  assert.ok(!text.includes('--server'));
});

test('public pages come from the cache, however the address is written', async () => {
  const db = countingDb();
  const { context } = await published({ db, cache: fakeCache() });
  const first = await (await context.call('/u/octo/dashboard.svg')).text();
  const reads = db.sql.length;
  for (const path of ['/u/octo/dashboard.svg', '/u/OCTO/dashboard.svg', '/u/octo/dashboard.svg?v=1']) {
    assert.equal(await (await context.call(path)).text(), first, path);
  }
  assert.equal(db.sql.length, reads, 'the database is not touched');
});

test('a missing or private profile is never cached, so publishing shows at once', async () => {
  const cache = fakeCache();
  const context = app({ cache });
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  assert.equal((await context.call('/u/octo/dashboard.svg')).status, 404);
  assert.equal(cache.store.size, 0);
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  assert.equal((await context.call('/u/octo/dashboard.svg')).status, 200);
});

test('making a profile private removes it from the cache', async () => {
  const cache = fakeCache();
  const { context, token } = await published({ cache });
  const paths = [
    '/u/octo',
    '/u/octo/dashboard.svg',
    '/u/octo/dashboard.svg?theme=tokyo-night',
    '/u/octo/components/tokens.svg',
    '/u/octo/components/tokens.svg?theme=tokyonight',
  ];
  // A text card is drawn each time it is asked for, so there is no copy of it to remove.
  const uncached = '/u/octo/cards/tokens.txt';
  for (const path of [...paths, uncached]) {
    assert.equal((await context.call(path)).status, 200, path);
  }
  assert.equal(cache.store.size, paths.length);
  await context.call('/v1/me', api(token, 'PATCH', { public: false }));
  assert.equal(cache.store.size, 0);
  for (const path of [...paths, uncached]) {
    assert.equal((await context.call(path)).status, 404, path);
  }
});

test('deleting an account removes its profile from the cache', async () => {
  const cache = fakeCache();
  const { context } = await published({ cache });
  await context.call('/u/octo/dashboard.svg');
  const session = await webLogin(context);
  await context.call('/me/delete', webPost(session, 'confirm=octo'));
  assert.equal(cache.store.size, 0);
  assert.equal((await context.call('/u/octo/dashboard.svg')).status, 404);
});

test('a signed-in visitor never gets or leaves a shared copy of a page', async () => {
  const cache = fakeCache();
  const { context } = await published({ cache });
  const session = await webLogin(context);
  const page = await context.call('/u/octo', { headers: { cookie: session } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(cache.store.size, 0);
  const anonymous = await context.call('/u/octo');
  assert.equal(anonymous.headers.get('cache-control'), 'public, max-age=300');
  assert.ok(!(await anonymous.text()).includes('href="/me"'), 'the shared copy names nobody');
});

test('limits apply to uncached pages, by address and page, and to sign-in and uploads', async () => {
  const seen: [string, string][] = [];
  let open = true;
  const cache = fakeCache();
  const { context, token } = await published({
    cache,
    allow: async (kind, key) => {
      seen.push([kind, key]);
      return open;
    },
  });
  const from = (ip: string): RequestInit => ({ headers: { 'cf-connecting-ip': ip } });
  await context.call('/u/octo/dashboard.svg', from('203.0.113.9'));
  assert.deepEqual(seen.at(-1), ['public', '203.0.113.9:/u/octo/dashboard.svg']);

  open = false;
  assert.equal((await context.call('/u/octo/dashboard.svg', from('203.0.113.9'))).status, 200, 'a cached page stays available');
  const blocked = await context.call('/u/octo/cards/tokens.txt', from('203.0.113.9'));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal((await context.call('/login', from('203.0.113.9'))).status, 429);
  assert.equal((await context.call('/v1/auth/token', api(null, 'POST', { githubToken: 'gh-token', machine: machine(MACHINE_B) }))).status, 429);
  assert.equal((await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)))).status, 429);
  assert.deepEqual(seen.at(-1), ['strict', 'agent:1'], 'uploads have the stricter limit');
  assert.equal((await context.call('/healthz')).status, 200);
});

test('an upload writes only the rows that changed', async () => {
  const db = countingDb();
  const context = app({ db });
  const token = await signIn(context);
  const writes = () => db.sql.filter((text) => /^\s*(INSERT|DELETE|UPDATE)[^]*usage_daily/.test(text)).length;
  const send = (days: unknown) => context.call('/v1/usage', api(token, 'PUT', { ...upload(MACHINE_A), days }));
  const two = { 'claude/a': [1, 1, 1, 1, 1], 'codex/b': [2, 2, 2, 2, 2] };

  await send({ '2026-11-07': two, '2026-11-08': two });
  assert.equal(writes(), 4, 'first upload: every row');
  await send({ '2026-11-07': two, '2026-11-08': two });
  assert.equal(writes(), 4, 'same again: nothing');
  await send({ '2026-11-08': { ...two, 'claude/a': [9, 1, 1, 1, 2] } });
  assert.equal(writes(), 5, 'one changed row');
  await send({ '2026-11-08': { 'claude/a': [9, 1, 1, 1, 2] } });
  assert.equal(writes(), 6, 'a removed model is deleted');

  const rows = db.raw.prepare('SELECT day, model, input FROM usage_daily ORDER BY day, model').all();
  assert.deepEqual(rows.map((row) => `${row.day} ${row.model} ${row.input}`), ['2026-11-07 a 1', '2026-11-07 b 2', '2026-11-08 a 9']);
});

test('a made-up session cookie gets the shared copy, and still counts against the limit', async () => {
  const keys: string[] = [];
  let open = true;
  const db = countingDb();
  const { context } = await published({
    db,
    cache: fakeCache(),
    allow: async (_kind, key) => {
      keys.push(key);
      return open;
    },
  });
  assert.equal((await context.call('/u/octo')).status, 200);
  const draws = () => db.sql.filter((text) => text.includes('FROM usage_daily')).length;
  const before = draws();
  const forged: RequestInit = { headers: { cookie: 'oms_session=made-up', 'cf-connecting-ip': '203.0.113.9' } };
  const page = await context.call('/u/octo', forged);
  assert.equal(page.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(draws(), before, 'the page is not drawn again');
  assert.ok(keys.includes('session:203.0.113.9'));
  open = false;
  assert.equal((await context.call('/u/octo', forged)).status, 429);
});

test('a card or part that does not exist is refused before the profile is read', async () => {
  const db = countingDb();
  const { context } = await published({ db, cache: fakeCache() });
  const reads = db.sql.length;
  // Each made-up name has its own rate limit and its 404 isn't cached, so it mustn't read the profile.
  for (const path of ['/u/octo/cards/nope.txt', '/u/octo/cards/aaa.txt', '/u/octo/components/nope.svg']) {
    assert.equal((await context.call(path)).status, 404, path);
  }
  assert.equal(db.sql.length, reads, 'nothing is read for a name that cannot exist');
  assert.equal((await context.call('/u/octo/cards/tokens.txt')).status, 200, 'a real card still works');
});

test('uploads with impossible dates or too many rows are refused', async () => {
  const context = app();
  const token = await signIn(context);
  const put = (body: object) => context.call('/v1/usage', api(token, 'PUT', { ...upload(MACHINE_A), ...body }));
  for (const day of ['0001-01-01', '2019-12-31', '2026-00-10', '2026-13-01', '2026-02-32']) {
    assert.equal((await put({ days: { [day]: { 'claude/a': [1, 1, 1, 1, 1] } } })).status, 400, day);
  }
  const models = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`claude/m${index}`, [1, 1, 1, 1, 1]]));
  assert.equal((await put({ days: { '2026-11-08': models(201) } })).status, 400);
  assert.equal((await put({ days: { '2026-11-08': models(200) } })).status, 200);
  const tools = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`tool${index}`, { scope: 'machine', total: 1 }]));
  assert.equal((await put({ totals: tools })).status, 400);
});

test('one account can write only so many rows a day, and what it stored stays intact', async () => {
  const context = app();
  const token = await signIn(context);
  const day = (index: number) => new Date(Date.UTC(2026, 6, 1) + index * 86_400_000).toISOString().slice(0, 10);
  const full = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [day(index), Object.fromEntries(Array.from({ length: 200 }, (_, model) => [`claude/m${model}`, [1, 1, 1, 1, 1]]))]),
  );
  const put = (days: object) => context.call('/v1/usage', api(token, 'PUT', { ...upload(MACHINE_A), days }));
  const count = () => (context.deps.db as ReturnType<typeof testDb>).raw.prepare('SELECT COUNT(*) AS rows, MAX(input) AS most FROM usage_daily').get();

  assert.equal((await put(full)).status, 200, 'exactly the budget');
  assert.equal((await put(full)).status, 200, 'unchanged rows cost nothing');
  const changed = { [day(0)]: { ...full[day(0)], 'claude/m0': [9, 1, 1, 1, 1] } };
  assert.equal((await put(changed)).status, 429);
  assert.deepEqual({ ...count() }, { rows: 20_000, most: 1 });

  context.setTime('2026-11-10T05:00:00Z');
  assert.equal((await put(changed)).status, 200, 'a new day, a new budget');
  assert.deepEqual({ ...count() }, { rows: 20_000, most: 9 });
});

test('signing a machine in again revokes its old token, and leaves other machines alone', async () => {
  const context = app();
  const old = await signIn(context, MACHINE_A);
  const other = await signIn(context, MACHINE_B, 'desktop');
  const fresh = await signIn(context, MACHINE_A);
  assert.equal((await context.call('/v1/me', api(old, 'GET'))).status, 401);
  assert.equal((await context.call('/v1/me', api(fresh, 'GET'))).status, 200);
  assert.equal((await context.call('/v1/me', api(other, 'GET'))).status, 200);
});

test('a machine stays signed in while it uploads, and expires after 180 quiet days', async () => {
  const context = app();
  const token = await signIn(context);
  const expiry = () => (context.deps.db as ReturnType<typeof testDb>).raw.prepare('SELECT expires_at FROM sessions').get()?.expires_at;
  assert.equal(expiry(), '2027-05-08T05:00:00.000Z');

  context.setTime('2027-05-01T05:00:00Z');
  assert.equal((await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)))).status, 200);
  assert.equal(expiry(), '2027-10-28T05:00:00.000Z', 'renewed');

  context.setTime('2027-05-02T05:00:00Z');
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  assert.equal(expiry(), '2027-10-28T05:00:00.000Z', 'not written on every upload');

  context.setTime('2027-10-29T05:00:00Z');
  assert.equal((await context.call('/v1/me', api(token, 'GET'))).status, 401);
});

test('a token from before expiry existed gets an expiry on its next upload', async () => {
  const context = app();
  const token = await signIn(context);
  const { raw } = context.deps.db as ReturnType<typeof testDb>;
  raw.exec('UPDATE sessions SET expires_at = NULL');
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  assert.equal(raw.prepare('SELECT expires_at FROM sessions').get()?.expires_at, '2027-05-08T05:00:00.000Z');
});

test('an account can only register so many machines', async () => {
  const context = app();
  const id = (index: number) => index.toString(16).padStart(32, '0');
  for (let index = 0; index < 50; index++) await signIn(context, id(index), `machine ${index}`);
  const again = (machineId: string) => context.call('/v1/auth/token', api(null, 'POST', { githubToken: 'gh-token', machine: machine(machineId) }));
  assert.equal((await again(id(50))).status, 403);
  assert.equal((await again(id(0))).status, 200, 'a machine it already has can sign in again');
});

test('GitHub stats of an impossible size are refused', async () => {
  const context = app();
  const token = await signIn(context);
  const put = (overrides: object) => context.call('/v1/github', api(token, 'PUT', { ...githubMetrics(), ...overrides }));
  assert.equal((await put({ languages: Array.from({ length: 501 }, () => ({ name: 'Rust' })) })).status, 400);
  assert.equal((await put({ languages: [{ name: 'x'.repeat(201) }] })).status, 400);
  let nested: unknown = 1;
  for (let depth = 0; depth < 10; depth++) nested = [nested];
  assert.equal((await put({ languages: nested })).status, 400);
  assert.equal((await put({})).status, 200);
});

test('development shortcuts only apply on this computer', () => {
  for (const url of ['http://localhost:8787/v1/config', 'http://127.0.0.1:8787/', 'http://[::1]:8787/']) assert.ok(isLocalRequest(new Request(url)), url);
  for (const url of ['https://ohmystats.dev/v1/config', 'http://localhost.evil.example/']) assert.ok(!isLocalRequest(new Request(url)), url);
});

test('a profile with no data yet is not cached, so the first upload shows at once', async () => {
  const cache = fakeCache();
  const context = app({ cache });
  const token = await signIn(context);
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  for (const path of ['/u/octo/dashboard.svg', '/u/octo']) {
    const empty = await context.call(path);
    assert.equal(empty.status, 200, path);
    assert.equal(empty.headers.get('cache-control'), 'no-store', path);
  }
  assert.equal(cache.store.size, 0);

  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  const full = await context.call('/u/octo/dashboard.svg');
  assert.equal(full.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(cache.store.size, 1);
});

test('a cached page keeps its five minutes, whatever lifetime the edge stored it with', async () => {
  const cache = fakeCache();
  const { context } = await published({ cache });
  const first = await (await context.call('/u/octo/dashboard.svg')).text();
  const key = `${ORIGIN}/u/octo/dashboard.svg`;
  const stored = cache.store.get(key) as Response;
  const headers = new Headers(stored.headers);
  headers.set('cache-control', 'public, max-age=14400');
  cache.store.set(key, new Response(first, { headers }));

  const hit = await context.call('/u/octo/dashboard.svg');
  assert.equal(hit.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(hit.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.equal(await hit.text(), first);
});

test('deleting an account takes typing its username, and a stray click deletes nothing', async () => {
  const context = app();
  const agent = await signIn(context);
  await context.call('/v1/usage', api(agent, 'PUT', upload(MACHINE_A)));
  const session = await webLogin(context);
  const { raw } = context.deps.db as ReturnType<typeof testDb>;
  for (const body of ['', 'confirm=', 'confirm=someone-else']) {
    const refused = await context.call('/me/delete', webPost(session, body));
    assert.equal(refused.status, 400, body);
    assert.match(await refused.text(), /Nothing was deleted/);
  }
  assert.equal(raw.prepare('SELECT COUNT(*) AS rows FROM usage_daily').get()?.rows, 1);
  assert.equal((await context.call('/v1/me', api(agent, 'GET'))).status, 200);

  assert.equal((await context.call('/me/delete', webPost(session, 'confirm=%20OCTO%20'))).status, 303, 'case and spaces do not matter');
  assert.equal(raw.prepare('SELECT COUNT(*) AS rows FROM usage_daily').get()?.rows, 0);
  assert.equal((await context.call('/v1/me', api(agent, 'GET'))).status, 401);
});

test('no destructive button is one click away on the dashboard', async () => {
  const context = app();
  const agent = await signIn(context);
  await context.call('/v1/usage', api(agent, 'PUT', upload(MACHINE_A)));
  const session = await webLogin(context);
  const page = await (await context.call('/me', { headers: { cookie: session } })).text();
  assert.match(page, /<details class="confirm"[^>]*>\s*<summary class="danger">Delete my account and data<\/summary>\s*<form method="post" action="\/me\/delete">/);
  assert.match(page, /name="confirm"[^>]*required/);
  assert.match(page, /<details class="confirm"><summary class="danger">Remove<\/summary><form class="inline" method="post" action="\/me\/machines\//);
  assert.ok(!page.includes('<details open'), 'closed until asked for');
});

test('plain http is sent to https, except on this computer', async () => {
  const { deps } = app();
  const redirected = await handle(new Request('http://ohmystats.dev/v1/usage?x=1', { method: 'PUT', body: '{}' }), deps);
  assert.equal(redirected.status, 308, 'keeps the method, and the body is never processed');
  assert.equal(redirected.headers.get('location'), 'https://ohmystats.dev/v1/usage?x=1');
  assert.equal((await handle(new Request('http://localhost:8787/healthz'), deps)).status, 200);
  assert.equal((await handle(new Request('http://127.0.0.1:8787/healthz'), deps)).status, 200);
});

test('unknown pages, methods and servers without sign-in configured fail cleanly', async () => {
  const context = app();
  assert.equal((await context.call('/nope')).status, 404);
  assert.equal((await context.call('/', { method: 'DELETE' })).status, 405);
  assert.equal((await context.call('/healthz')).status, 200);
  assert.equal((await app({ githubClientId: '' }).call('/login')).status, 503);
});

test('every page shows the logo as its icon, the same one the README shows', async () => {
  const context = app();
  assert.equal(LOGO_SVG, readFileSync(new URL('../.github/logo.svg', import.meta.url), 'utf8'));
  for (const path of ['/', '/nope']) assert.match(await (await context.call(path)).text(), /<link rel="icon" href="\/favicon\.svg"/, path);
  const icon = await context.call('/favicon.svg');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.equal(await icon.text(), LOGO_SVG);
  const legacy = await context.call('/favicon.ico');
  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get('location'), '/favicon.svg');
});

test('the install commands on the website lead to the scripts each release ships', async () => {
  const context = app();
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cp install\.sh install\.ps1 dist\//, 'each release uploads both scripts');
  const landing = await (await context.call('/')).text();
  for (const script of ['install.sh', 'install.ps1']) {
    const response = await context.call(`/${script}`);
    assert.equal(response.status, 302, script);
    assert.equal(response.headers.get('location'), `${LATEST_RELEASE}/${script}`);
    assert.ok(readFileSync(new URL(`../${script}`, import.meta.url), 'utf8').length > 0, `${script} is in the repository`);
    assert.ok(landing.includes(`${ORIGIN}/${script}`), `the landing page shows ${script}`);
  }
});

test('the profile header uses what the owner wrote on the website, and their GitHub profile for the rest', async () => {
  const { context, token } = await published();
  const profile = { name: 'Octo Cat', bio: 'Builds things', company: '@corp', location: 'Seoul', hireable: true, status: null };
  await context.call('/v1/github', api(token, 'PUT', githubMetrics({ profile })));
  const part = async () => (await context.call('/u/octo/components/profile.svg')).text();

  let svg = await part();
  assert.ok(svg.includes('>@corp · Seoul</text>'));
  assert.ok(svg.includes('>Builds things</text>'));
  assert.ok(svg.includes('>Available for hire</text>'), 'from GitHub');

  const session = await webLogin(context);
  const form = new URLSearchParams({ name: '', title: 'Staff engineer', company: 'Acme', location: '', bio: '', status: 'hiring' });
  assert.equal((await context.call('/me/profile', webPost(session, form.toString()))).status, 303);
  svg = await part();
  assert.ok(svg.includes('>Staff engineer at Acme · Seoul</text>'));
  assert.ok(svg.includes('>Hiring</text>') && !svg.includes('Available for hire'));
  assert.ok(svg.includes('Octo Cat') && svg.includes('>Builds things</text>'), 'empty fields still come from GitHub');

  const page = await (await context.call('/me', { headers: { cookie: session } })).text();
  assert.ok(page.includes('value="Staff engineer"'));
  assert.ok(page.includes('placeholder="Builds things"'), 'each field shows what it falls back to');
  assert.ok(page.includes('<option value="hiring" selected>'));
  assert.ok(page.includes('/components/profile.svg'), 'the part is offered for embedding');

  await context.call('/me/profile', webPost(session, 'status=none'));
  svg = await part();
  assert.ok(!svg.includes('Hiring') && !svg.includes('Available for hire'), 'a status can be hidden');
  assert.ok(!svg.includes('Staff engineer'), 'saving an empty field clears it');
});

test('profile text is cleaned and escaped, from the website and from an upload', async () => {
  const { context, token } = await published();
  const profile = { name: 'Mallory‮evil', bio: 'line one\nline two', company: null, location: null, hireable: false, status: { emoji: '🎯', message: 'Focusing', busy: true } };
  await context.call('/v1/github', api(token, 'PUT', githubMetrics({ profile })));
  const session = await webLogin(context);
  await context.call('/me/profile', webPost(session, new URLSearchParams({ title: '<script>alert(1)</script>', status: 'bogus' }).toString()));
  const svg = await (await context.call('/u/octo/components/profile.svg')).text();
  assert.ok(!svg.includes('<script>') && svg.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(svg.includes('Malloryevil'), 'characters that reorder text are removed');
  assert.ok(svg.includes('>line one line two</text>'));
  assert.ok(svg.includes('>🎯</text>') && svg.includes('>Focusing</text>'), 'an unknown choice falls back to the GitHub status');
  assert.ok(!(await (await context.call('/me', { headers: { cookie: session } })).text()).includes('<script>alert'));
});

test('a profile header saved from another site is refused', async () => {
  const { context } = await published();
  const session = await webLogin(context);
  const forged = await context.call('/me/profile', webPost(session, 'title=Hacked', 'https://evil.example'));
  assert.equal(forged.status, 403);
  assert.ok(!(await (await context.call('/u/octo/components/profile.svg')).text()).includes('Hacked'));
});

test('the avatar is drawn into the image, and an initial stands in without it', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const github = fakeGitHub({ 'gh-token': octo, 'web-token': octo });
  const avatars: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://avatars.githubusercontent.com/')) return github.impl(input, init);
    avatars.push(url);
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  }) as typeof globalThis.fetch;
  const { context } = await published({ fetch, cache: fakeCache() });
  const svg = await (await context.call('/u/octo/components/profile.svg')).text();
  assert.ok(svg.includes(`<image href="data:image/png;base64,${Buffer.from(png).toString('base64')}"`));
  assert.deepEqual(avatars, ['https://avatars.githubusercontent.com/u/1?s=144']);
  await context.call('/u/octo/dashboard.svg');
  assert.equal(avatars.length, 1, 'kept for the next drawing');

  const offline = await published();
  const plain = await (await offline.context.call('/u/octo/components/profile.svg')).text();
  assert.ok(plain.includes('class="initial"') && !plain.includes('<image'));
});

test('only GitHub\'s avatar server is asked for an avatar', async () => {
  const eve: GitHubUser = { id: 3, login: 'eve', avatar_url: 'https://internal.example/secret.png' };
  const context = app({}, { 'gh-token': eve, 'web-token': eve });
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  assert.equal((await context.call('/u/eve/components/profile.svg')).status, 200);
  assert.ok(!context.github.calls.some((url) => url.includes('internal.example')));
});

test('concurrent machines get one GitHub collection lease', async () => {
  const { claimGitHubCollection } = await import('../src/server/db.ts');
  const db = testDb();
  const claim = () => claimGitHubCollection(db, 'same-user', new Date('2026-11-09T00:00:00Z'));
  assert.equal((await Promise.all([claim(), claim()])).filter(Boolean).length, 1);
});

test('a malformed nested GitHub snapshot cannot replace the last renderable snapshot', async () => {
  const context = app();
  const token = await signIn(context);
  const valid = githubMetrics();
  const put = (value: unknown) => context.call('/v1/github', api(token, 'PUT', value));
  assert.equal((await put(valid)).status, 200);
  assert.equal((await put({ ...valid, rhythm: { ...valid.rhythm, weekdays: null } })).status, 400);
  assert.equal((await put({ ...valid, churn: { ...valid.churn, rows: [null] } })).status, 400);
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  assert.equal((await context.call('/u/octo/dashboard.svg')).status, 200);
});

test('the Rust-generated GitHub snapshot uploads and renders on public routes', async () => {
  const payload = JSON.parse(readFileSync(new URL('../agent/tests/fixtures/github-metrics.json', import.meta.url), 'utf8'));
  const context = app();
  const token = await signIn(context);
  assert.equal((await context.call('/v1/github', api(token, 'PUT', payload))).status, 200);
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  for (const path of ['/u/octo', '/u/octo/dashboard.svg', '/u/octo/cards/languages.txt']) {
    const response = await context.call(path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Rust/);
  }
});

test('custom provider usage reaches status, the private dashboard and the published table', async () => {
  const context = app();
  const token = await signIn(context);
  const usage = { ...upload(MACHINE_A), days: { '2026-11-09': { 'local-ai/my-model': [100, 50, 25, 0, 1] } } };
  assert.equal((await context.call('/v1/usage', api(token, 'PUT', usage))).status, 200);
  const me = await (await context.call('/v1/me', api(token, 'GET'))).json() as { tokens: { tools: { activity: unknown }[] } };
  assert.deepEqual(me.tokens.tools[0].activity, { last7: 175, previous7: 0, responses30: 1, activeDays30: 1, tokensPerResponse30: 175 });
  const session = await webLogin(context);
  const check = async (page: Response) => assert.match(await page.text(), /Provider activity[\s\S]*<td>local-ai<\/td>[\s\S]*>175<\/td>/);
  await check(await context.call('/me', { headers: { cookie: session } }));
  assert.equal((await context.call('/u/octo')).status, 404);
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  await check(await context.call('/u/octo'));
});

test('the owner can compare device periods and see lifetime usage with no matching device', async () => {
  const context = app();
  const a = await signIn(context);
  const b = await signIn(context, MACHINE_B, 'desktop-office');
  const totals = { codex: { scope: 'account', total: 1000, asOf: '2026-11-09', daily: { '2026-11-09': 1000 } } };
  for (const [id, token, day, used] of [[MACHINE_A, a, '2026-11-09', 100], [MACHINE_B, b, '2026-10-25', 50]] as const) {
    assert.equal((await context.call('/v1/usage', api(token, 'PUT', {
      ...upload(id), days: { [day]: { 'codex/model': [used, 0, 0, 0, 1] } }, totals,
    }))).status, 200);
  }
  const me = await (await context.call('/v1/me', api(a, 'GET'))).json() as {
    machines: { id: string; tokens: number; last7: number; last30: number }[];
  };
  assert.deepEqual(me.machines.map(m => [m.id, m.last7, m.last30, m.tokens]).sort(), [
    [MACHINE_A, 100, 100, 100], [MACHINE_B, 0, 50, 50],
  ]);
  const cookie = await webLogin(context);
  const owner = await (await context.call('/me', { headers: { cookie } })).text();
  assert.match(owner, /Lifetime tokens/);
  assert.match(owner, /No matching device[\s\S]*?>900<\/td><td class="num">850<\/td><td class="num">850<\/td>/);
  await context.call('/v1/me', api(a, 'PATCH', { public: true }));
  for (const path of ['/u/octo', '/u/octo/dashboard.svg', '/u/octo/cards/tokens.txt']) {
    const published = await (await context.call(path)).text();
    for (const privateValue of [SECRET_NAME, 'desktop-office', MACHINE_A, MACHINE_B, 'No matching device']) {
      assert.ok(!published.includes(privateValue));
    }
  }
});

test('the landing page shows the top of the public rankings, without ranking everyone on each visit', async () => {
  const db = countingDb();
  const context = app({ db, cache: fakeCache() });
  const empty = await (await context.call('/')).text();
  assert.doesNotMatch(empty, /Top of the rankings|dashboard\.svg/, 'a new server has nobody to show');

  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  assert.doesNotMatch(await (await context.call('/')).text(), /href="\/u\/octo"/, 'a private profile is never shown');
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));

  const rankingReads = () => db.sql.filter((sql) => sql.includes('WITH members')).length;
  const landing = await context.call('/');
  assert.equal(landing.headers.get('cache-control'), 'no-store');
  const text = await landing.text();
  assert.match(text, /<img src="\/u\/octo\/dashboard\.svg" alt="The developer dashboard of @octo"/);
  assert.match(text, /1 ranked public profile, by lifetime AI tokens/);
  assert.match(text, /<a href="\/u\/octo"><img src="https:\/\/avatars\.githubusercontent\.com\/octo\?s=56"[^>]*>@octo<\/a>/);
  assert.match(text, /<strong>10<\/strong><\/td>/);
  assert.ok(!text.includes(SECRET_NAME) && !text.includes(MACHINE_A));

  const reads = rankingReads();
  await context.call('/');
  await context.call('/', { headers: { cookie: await webLogin(context) } });
  assert.equal(rankingReads(), reads, 'the board is kept, not worked out again');

  await context.call('/v1/me', api(token, 'PATCH', { public: false }));
  assert.doesNotMatch(await (await context.call('/')).text(), /\/u\/octo/, 'going private takes the profile off the landing page at once');
});

test('pages load nothing the content policy would block, and share one frame', async () => {
  const { context } = await published();
  const session = await webLogin(context);
  const pages = ['/', '/rankings', '/rankings?days=7', '/u/octo', '/nope'];
  const signedIn = ['/', '/me', '/me/rankings', '/rankings', '/u/octo'];
  for (const [path, init] of [...pages.map((path) => [path, {}] as const), ...signedIn.map((path) => [path, { headers: { cookie: session } }] as const)]) {
    const response = await context.call(path, init);
    const text = await response.text();
    const policy = response.headers.get('content-security-policy') ?? '';
    assert.match(policy, /default-src 'none'/, path);
    // A drawing may point at its own patterns. Anything else named by address would be fetched.
    assert.doesNotMatch(text, /<script|<link rel="stylesheet"|@import|url\((?!#)|<iframe/i, `${path} needs only what the policy allows`);
    for (const [, source] of text.matchAll(/<img src="([^"]+)"/g)) {
      assert.match(source, /^(\/(?!\/)|https:\/\/avatars\.githubusercontent\.com\/)/, `${path} loads ${source}`);
    }
    assert.match(text, /<a class="skip" href="#main">Skip to content<\/a>[\s\S]*<main id="main"/, path);
    assert.match(text, /<meta name="description" content="[^"]{40,}">/, path);
    assert.match(text, /<footer class="bottom">[\s\S]*href="https:\/\/github\.com\/saintlee83\/oh-my-stats"/, path);
    assert.equal(text.match(/<h1[ >]/g)?.length, 1, `${path} has one main heading`);
  }
  const missing = await context.call('/nope');
  assert.match(await missing.text(), /<p class="code">404<\/p><h1>Page not found\.<\/h1>/);
  const own = await (await context.call('/u/octo', { headers: { cookie: session } })).text();
  assert.match(own, /href="\/me#profile-header">Edit profile<\/a>/, 'the owner can go and edit their header');
  assert.doesNotMatch(await (await context.call('/u/octo')).text(), /Edit profile/);
});

test('pages worth sharing name the preview image by its full address, and the image is there to serve', async () => {
  const { context } = await published();
  const session = await webLogin(context);
  for (const path of ['/', '/rankings', '/rankings?days=7&provider=codex', '/u/octo']) {
    const text = await (await context.call(path)).text();
    // A profile names its own picture, drawn from its numbers. Every other page names the site's.
    const image = path.startsWith('/u/') ? `${path.slice(1)}/og.png` : 'og.png';
    assert.ok(text.includes(`<meta property="og:image" content="https://stats.example/${image}">`), path);
    assert.match(text, /<meta name="twitter:card" content="summary_large_image">/, path);
  }
  for (const [path, init] of [['/nope', {}], ['/me', { headers: { cookie: session } }], ['/me/rankings', { headers: { cookie: session } }]] as const) {
    const text = await (await context.call(path, init)).text();
    assert.doesNotMatch(text, /og:image/, `${path} is not for sharing`);
    assert.match(text, /<meta name="twitter:card" content="summary">/, path);
  }
  // Wrangler serves this folder at the site's root, so the Worker never sees the request.
  assert.match(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'), /"assets": \{ "directory": "\.\/public" \}/);
  const image = readFileSync(new URL('../public/og.png', import.meta.url));
  assert.equal(image.subarray(1, 4).toString('latin1'), 'PNG');
  assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20)], [2400, 1260], 'the size the pages declare');
  assert.ok(image.length < 1_000_000, 'light enough for any site that draws link previews');
  assert.match(readFileSync(new URL('../.github/banner.svg', import.meta.url), 'utf8'), /^<svg [^>]*viewBox="0 0 1200 630"/, 'the drawing it is made from, at half the size');
});

test('install commands are shown per system, each with the same next steps', async () => {
  const context = app();
  const session = await webLogin(context);
  for (const page of [await context.call('/'), await context.call('/me', { headers: { cookie: session } })]) {
    const text = await page.text();
    assert.match(text, /<pre><code>curl -fsSL https:\/\/stats\.example\/install\.sh \| sh\noms login --server https:\/\/stats\.example\noms service install<\/code><\/pre>/);
    assert.match(text, /<pre><code>irm https:\/\/stats\.example\/install\.ps1 \| iex\noms login --server https:\/\/stats\.example\noms service install<\/code><\/pre>/);
    assert.equal(text.match(/type="radio" name="os"/g)?.length, 2);
    assert.equal(text.match(/type="radio" name="os"[^>]* checked/g)?.length, 1, 'one system is shown to start with');
  }
});

test('rankings reconcile tool figures, respect visibility, and keep device and provider ranks personal', async () => {
  const context = app({}, {
    'gh-token': octo, 'web-token': octo,
    alpha: { id: 2, login: 'alpha' }, beta: { id: 3, login: 'beta' }, hidden: { id: 4, login: 'secret-user' },
  });
  const a = await signIn(context, MACHINE_A, 'office-laptop');
  const b = await signIn(context, MACHINE_B, 'studio-mac');
  const put = async (token: string, id: string, days: object, totals: object = {}) => {
    assert.equal((await context.call('/v1/usage', api(token, 'PUT', { ...upload(id), days, totals }))).status, 200);
  };
  await put(a, MACHINE_A, {
    '2026-11-02': { 'pi/m': [40, 0, 0, 0, 1] },
    '2026-11-03': { 'codex/m': [11, 0, 0, 0, 1], 'claude/m': [1, 0, 0, 0, 1] },
    '2026-11-09': { 'codex/m': [5, 0, 0, 0, 1], 'pi/m': [1, 1, 2, 2, 1], 'claude/m': [2, 0, 0, 0, 1] },
    '2026-11-10': { 'pi/m': [999, 0, 0, 0, 1] },
  }, {
    codex: { scope: 'account', total: 1000, asOf: '2026-11-08', daily: { '2026-11-03': 70, '2026-11-04': 11 } },
    claude: { scope: 'machine', total: 20, asOf: '2026-11-04', daily: { '2026-11-03': 20 } },
  });
  await put(b, MACHINE_B, {
    '2026-11-03': { 'codex/m': [7, 0, 0, 0, 1] }, '2026-11-09': { 'codex/m': [4, 0, 0, 0, 1] },
  }, { codex: { scope: 'account', total: 500, asOf: '2026-11-05', daily: { '2026-11-03': 55, '2026-11-04': 16 } } });
  await context.call('/v1/me', api(a, 'PATCH', { public: true }));
  let betaToken = '';
  for (const [login, tokens] of [['alpha', 123], ['beta', 21], ['hidden', 9999]] as const) {
    // Reusing a machine ID on another account must never join private records across owners.
    const response = await context.call('/v1/auth/token', api(null, 'POST', { githubToken: login, machine: machine(MACHINE_A, login + '-device') }));
    const { token } = await response.json() as { token: string };
    await put(token, MACHINE_A, { '2026-11-09': { 'copilot-cli/m': [tokens, 0, 0, 0, 1] } });
    if (login !== 'hidden') await context.call('/v1/me', api(token, 'PATCH', { public: true }));
    if (login === 'beta') betaToken = token;
  }
  const get = async (token: string, query = '') => {
    const res = await context.call('/v1/rankings' + query, api(token, 'GET'));
    assert.equal(res.status, 200);
    return res.json() as Promise<{ period: object; users: object[]; machines: object[]; providers: object[] }>;
  };
  const week = await get(a);
  const row = (rank: number, label: string, tokens: number) => ({ rank, label, tokens });
  assert.deepEqual(week.period, { days: 7, start: '2026-11-03', end: '2026-11-09' });
  assert.deepEqual(week.users, [row(1, 'alpha', 123), row(1, 'octo', 123), row(3, 'beta', 21)]);
  assert.deepEqual(week.machines, [row(1, 'office-laptop', 44), row(2, 'studio-mac', 11)]);
  assert.deepEqual(week.providers, [row(1, 'Codex', 95), row(2, 'Claude Code', 22), row(3, 'Pi', 6)]);
  const lifetime = await get(a, '?days=all');
  const me = await (await context.call('/v1/me', api(a, 'GET'))).json() as { tokens: { total: number } };
  assert.deepEqual(lifetime.period, { days: 'all', start: null, end: null });
  assert.deepEqual(lifetime.users, [row(1, 'octo', me.tokens.total), row(2, 'alpha', 123), row(3, 'beta', 21)]);
  assert.deepEqual(lifetime.providers, [row(1, 'Pi', 1045), row(2, 'Codex', 1009), row(3, 'Claude Code', 22)]);
  assert.deepEqual(lifetime.machines, [row(1, 'office-laptop', 1083), row(2, 'studio-mac', 11)]);
  const month = await get(a, '?days=30');
  assert.deepEqual(month.users[0], row(1, 'octo', 163));
  assert.deepEqual(month.providers[1], row(2, 'Pi', 46));
  const beta = await get(betaToken, '?days=7&user=1');
  assert.deepEqual(beta.machines, [row(1, 'beta-device', 21)]);

  const board = await context.call('/rankings');
  assert.equal(board.headers.get('cache-control'), 'no-store');
  const html = await board.text();
  assert.match(html, /aria-current="page">All time/);
  assert.match(html, /Lifetime tokens/);
  assert.match(html, />2,076</);
  assert.match(html, /href="\/u\/octo"/);
  assert.doesNotMatch(html, /office-laptop|studio-mac|beta-device|secret-user/);
  assert.match(html, /3 ranked public profiles<\/p>/, 'signed out, the board names nobody');
  assert.match(html, /<tr><td class="rank"><span class="place" data-place="1">1<\/span><\/td><td class="who"><a href="\/u\/octo"><img src="https:\/\/avatars\.githubusercontent\.com\/octo\?s=56"/);
  assert.doesNotMatch(html, /class="me"|Ranking views/);
  const signedOut = await context.call('/me/rankings');
  assert.equal(signedOut.headers.get('location'), '/login');
  const cookie = await webLogin(context);
  const privatePage = await context.call('/me/rankings?days=30', { headers: { cookie } });
  assert.equal(privatePage.headers.get('cache-control'), 'no-store');
  const privateHtml = await privatePage.text();
  assert.match(privateHtml, /Tokens \(30 days\)/);
  assert.match(privateHtml, /All time<\/span><strong>#1<\/strong><span>of 3 ranked public profiles/);
  assert.match(privateHtml, /Last 7 days<\/span><strong>#1<\/strong><span>of 3 ranked public profiles/);
  assert.match(privateHtml, /office-laptop[\s\S]+studio-mac[\s\S]+My providers/);
  assert.doesNotMatch(privateHtml, /<span class="place" data-place|avatars\.githubusercontent\.com\/office/, 'devices and providers get no medals or avatars');
  assert.match(privateHtml, /<a href="\/rankings\?days=30">Everyone<\/a><a href="\/me\/rankings\?days=30" aria-current="page">Mine<\/a>/);
  const own = await (await context.call('/rankings?days=7', { headers: { cookie } })).text();
  assert.match(own, /3 ranked public profiles · You are <strong>#1<\/strong>/);
  assert.match(own, /<tr class="me">[\s\S]*?@octo<\/a><span class="badge">You<\/span>/, 'the viewer finds their own row');
  assert.equal(own.match(/class="me"/g)?.length, 1);
  assert.match(await (await context.call('/me/rankings', { headers: { cookie } })).text(), />1,083</);
  await context.call('/v1/me', api(a, 'PATCH', { public: false }));
  assert.doesNotMatch(await (await context.call('/rankings')).text(), /href="\/u\/octo"/);
  assert.match(await (await context.call('/rankings', { headers: { cookie } })).text(), /2 ranked public profiles · Your profile is private\./);
  assert.match(await (await context.call('/me/rankings', { headers: { cookie } })).text(), /<strong>—<\/strong><span>Unranked · 2 ranked public profiles[\s\S]*Your profile is private\./);
  assert.deepEqual((await get(a)).machines, week.machines, 'private owners keep their own rankings');
  await context.call('/me/machines/' + MACHINE_B + '/delete', webPost(cookie, ''));
  assert.deepEqual((await get(a)).machines, [row(1, 'office-laptop', 44)]);
});

test('weekly card, day drilldown and provider shares agree across private and public pages', async () => {
  const context = app();
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', { ...upload(MACHINE_A), days: {
    '2026-10-06': { 'codex/m': [1000, 0, 0, 0, 1] },
    '2026-11-02': { 'pi/m': [50, 0, 0, 0, 1] },
    '2026-11-09': { 'pi/m': [75, 0, 0, 0, 1], 'codex/m': [125, 0, 0, 0, 1] },
  } }));
  await context.call('/v1/github', api(token, 'PUT', githubMetrics()));
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  const cookie = await webLogin(context);
  for (const [path, headers] of [['/me', { cookie }], ['/u/octo', {}]] as const) {
    const page = await (await context.call(path, { headers })).text();
    assert.match(page, /popovertarget="day-2026-11-09"[^>]*aria-label="2026-11-09 · 200 tokens"/);
    assert.match(page, /<p>200 tokens<\/p><ul><li>Codex · 125<\/li><li>Pi · 75<\/li>/);
    assert.match(page, /Codex<\/td><td class="num">100.0%<\/td><td class="num">50.0%/);
  }
  const weekly = await (await context.call('/u/octo/components/weekly.svg')).text();
  assert.match(weekly, /\+300.0% from the prior week/);
  assert.match(weekly, /Largest increase · Codex \+125/);
  const recap = await (await context.call('/u/octo/components/recap.svg')).text();
  assert.match(recap, /Monthly recap · 2026-10/);
  assert.match(recap, /Dated AI tokens/);
  const me = await (await context.call('/v1/me', api(token, 'GET'))).json() as { tokens: { weekly: { total: number } } };
  assert.equal(me.tokens.weekly.total, 200);
});

test('the public board ranks one provider at a time, with the scores each profile sees for itself', async () => {
  const context = app({}, { 'gh-token': octo, 'web-token': octo, alpha: { id: 2, login: 'alpha' }, beta: { id: 3, login: 'beta' } });
  const personal: Record<string, { label: string; tokens: number }[]> = {};
  for (const [githubToken, login, day] of [
    ['gh-token', 'octo', { 'codex/m': [300, 0, 0, 0, 1], 'claude/m': [50, 0, 0, 0, 1], 'local-ai/m': [7, 0, 0, 0, 1] }],
    ['alpha', 'alpha', { 'codex/m': [500, 0, 0, 0, 1], 'pi/m': [20, 0, 0, 0, 1] }],
    ['beta', 'beta', { 'claude/m': [80, 0, 0, 0, 1] }],
  ] as const) {
    const response = await context.call('/v1/auth/token', api(null, 'POST', { githubToken, machine: machine(MACHINE_A) }));
    const { token } = await response.json() as { token: string };
    assert.equal((await context.call('/v1/usage', api(token, 'PUT', { ...upload(MACHINE_A), days: { '2026-11-09': day } }))).status, 200);
    await context.call('/v1/me', api(token, 'PATCH', { public: true }));
    personal[login] = (await (await context.call('/v1/rankings?days=all', api(token, 'GET'))).json() as { providers: { label: string; tokens: number }[] }).providers;
  }
  const { publicRankings, rankingPeriod } = await import('../src/server/rankings.ts');
  const lifetime = rankingPeriod('all', context.deps.now());
  const own = (login: string, provider: string) => personal[login].find((row) => row.label === provider)!.tokens;

  const everything = await publicRankings(context.deps.db, lifetime);
  assert.deepEqual(everything.users.map((row) => [row.label, row.tokens]), [['alpha', 520], ['octo', 357], ['beta', 80]]);
  assert.deepEqual(everything.providers, [
    { tool: 'codex', tokens: 800, profiles: 2 }, { tool: 'claude', tokens: 130, profiles: 2 },
    { tool: 'pi', tokens: 20, profiles: 1 }, { tool: 'local-ai', tokens: 7, profiles: 1 },
  ]);
  const codex = await publicRankings(context.deps.db, lifetime, '1', 'codex');
  assert.deepEqual(codex.users, [{ rank: 1, label: 'alpha', tokens: own('alpha', 'Codex') }, { rank: 2, label: 'octo', tokens: own('octo', 'Codex') }]);
  assert.deepEqual(codex.position, { days: 'all', rank: 2, participants: 2 });
  assert.deepEqual(codex.providers, everything.providers, 'the providers on offer do not depend on the one chosen');
  const week = await publicRankings(context.deps.db, rankingPeriod('7', context.deps.now()), '3', 'claude');
  assert.deepEqual(week.users, [{ rank: 1, label: 'beta', tokens: 80 }, { rank: 2, label: 'octo', tokens: 50 }]);
  assert.deepEqual(week.position, { days: 7, rank: 1, participants: 2 });

  const all = await (await context.call('/rankings')).text();
  assert.match(all, /<nav class="filters" aria-label="Providers"><a href="\/rankings\?days=all" aria-current="page">All providers<\/a><a href="\/rankings\?days=all&amp;provider=codex">Codex<\/a><a href="\/rankings\?days=all&amp;provider=claude">Claude Code<\/a><a href="\/rankings\?days=all&amp;provider=pi">Pi<\/a><\/nav>/);
  assert.doesNotMatch(all, /local-ai/, 'a provider ID someone made up is not offered to everyone');
  const board = await (await context.call('/rankings?days=7&provider=codex')).text();
  assert.match(board, /<a href="\/rankings\?days=7&amp;provider=codex" aria-current="page">Codex<\/a>/);
  assert.match(board, /<a href="\/rankings\?days=30&amp;provider=codex">Last 30 days<\/a>/, 'changing the period keeps the provider');
  assert.match(board, /Top 100 public profiles · Codex<\/h2><p class="muted">2 ranked public profiles<\/p>/);
  assert.match(board, /@alpha<\/a>[\s\S]*<strong>500<\/strong>[\s\S]*@octo<\/a>[\s\S]*<strong>300<\/strong>/);
  assert.doesNotMatch(board, /@beta/);
  const custom = await (await context.call('/rankings?provider=local-ai')).text();
  assert.match(custom, /aria-current="page">local-ai<\/a>[\s\S]*@octo<\/a>[\s\S]*<strong>7<\/strong>/, 'it can still be asked for by address');
  const unused = await context.call('/rankings?provider=amp');
  assert.match(await unused.text(), /aria-current="page">Amp<\/a>[\s\S]*0 ranked public profiles[\s\S]*No token usage for this period/);
  for (const bad of ['Codex', 'codex%20', '<b>', 'a'.repeat(33)]) assert.equal((await context.call(`/rankings?provider=${bad}`)).status, 400, bad);
  const cookie = await webLogin(context);
  assert.match(await (await context.call('/rankings?provider=pi', { headers: { cookie } })).text(), /1 ranked public profile · No ranked usage in these periods\./);

  const profile = await (await context.call('/u/octo')).text();
  assert.match(profile, /<a class="badge" href="\/rankings">#2 of 3 ranked public profiles, by lifetime AI tokens<\/a>/);
});

test('a profile can rank on lifetime figures even when it has no recent usage', async () => {
  const context = app();
  const token = await signIn(context);
  const uploadResult = await context.call('/v1/usage', api(token, 'PUT', {
    ...upload(MACHINE_A),
    days: {
      '2024-06-01': { 'claude/a': [9, 0, 1, 0, 1] },
      '2024-06-02': { 'claude/b': [1, 2, 3, 4, 1] },
    },
    totals: {
      claude: { scope: 'machine', total: 20, asOf: '2024-06-01', models: { a: [1, 0, 0, 0], b: [3, 5, 4, 3] } },
      codex: { scope: 'account', total: 99, asOf: null },
    },
  }));
  assert.equal(uploadResult.status, 200);
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  const me = await (await context.call('/v1/me', api(token, 'GET'))).json() as { tokens: { total: number } };
  const lifetime = await (await context.call('/v1/rankings?days=all', api(token, 'GET'))).json();
  assert.equal(me.tokens.total, 134);
  assert.deepEqual(lifetime, {
    period: { days: 'all', start: null, end: null },
    position: { days: 'all', rank: 1, participants: 1 },
    users: [{ rank: 1, label: 'octo', tokens: me.tokens.total }],
    providers: [{ rank: 1, label: 'Codex', tokens: 99 }, { rank: 2, label: 'Claude Code', tokens: 35 }],
    machines: [{ rank: 1, label: SECRET_NAME, tokens: 35 }],
  });
  assert.match(await (await context.call('/rankings?days=30')).text(), /No token usage for this period/);
});

test('empty ranking pages, invalid periods, and access limits', async () => {
  const context = app();
  assert.match(await (await context.call('/rankings')).text(), /No token usage for this period/);
  assert.equal((await context.call('/rankings?days=0')).status, 400);
  assert.equal((await context.call('/v1/rankings')).status, 401);
  const token = await signIn(context);
  assert.equal((await context.call('/v1/rankings?days=8', api(token, 'GET'))).status, 400);
  assert.equal((await app({ allow: async () => false }).call('/rankings')).status, 429);
});

test('public rankings limit tied profiles deterministically and use the latest cutoff for equal lifetime reports', async () => {
  const context = app();
  const db = context.deps.db as ReturnType<typeof testDb>;
  db.raw.exec(`
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<101)
    INSERT INTO users (id, login, is_public, created_at, updated_at)
    SELECT i, printf('member-%03d', i), 1, '2026-11-01', '2026-11-01' FROM n;
    INSERT INTO machines (user_id,id,name,created_at,last_seen_at)
    SELECT id,'a','Primary','2026-11-01','2026-11-01' FROM users;
    INSERT INTO usage_daily
    SELECT id,'a','2026-11-08','codex','m',25,0,0,0,1 FROM users;
    INSERT INTO machines (user_id,id,name,created_at,last_seen_at) VALUES ('1','b','Second','2026-11-01','2026-11-01');
    INSERT INTO tool_totals VALUES
      ('1','a','codex','{"scope":"account","total":200,"asOf":"2026-11-06","daily":{"2026-11-06":30}}','2026-11-09'),
      ('1','b','codex','{"scope":"account","total":200,"asOf":"2026-11-09","daily":{"2026-11-08":70}}','2026-11-09');
  `);
  const { publicRankings, rankingPeriod } = await import('../src/server/rankings.ts');
  const { computeTokens } = await import('../src/shared/tokens.ts');
  const { loadUsage } = await import('../src/server/db.ts');
  const period = rankingPeriod('7', context.deps.now());
  const { users: board, position } = await publicRankings(db, period, '101');
  assert.deepEqual(position, { days: 7, rank: 2, participants: 101 }, 'a tie beyond the display cutoff keeps its rank');
  const dashboard = computeTokens(await loadUsage(db, '1'), {}, 'UTC', context.deps.now(), null)!;
  assert.deepEqual(board[0], { rank: 1, label: 'member-001', tokens: 100 });
  assert.equal(board[0].tokens, dashboard.tools[0].activity.last7);
  assert.equal(board.length, 100);
  assert.deepEqual(board.at(-1), { rank: 2, label: 'member-100', tokens: 25 });
  const { users: lifetime } = await publicRankings(db, rankingPeriod(null, context.deps.now()));
  assert.equal(lifetime[0].tokens, dashboard.total);
  assert.deepEqual(lifetime.slice(1), board.slice(1));
  db.raw.exec("UPDATE usage_daily SET input=1 WHERE user_id='101'");
  assert.deepEqual((await publicRankings(db, period, '101')).position, { days: 7, rank: 101, participants: 101 });
  db.raw.exec("UPDATE users SET is_public=0 WHERE id='101'");
  assert.deepEqual((await publicRankings(db, period, '101')).position, { days: 7, rank: null, participants: 100 });
});
