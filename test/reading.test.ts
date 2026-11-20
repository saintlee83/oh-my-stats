import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDER_ICONS } from '../src/server/provider-icons.ts';
import { PROVIDERS } from '../src/shared/format.ts';
import { api, app, countingDb, fakeCache, MACHINE_A, machine, mark, octo, ORIGIN, published, SECRET_NAME, upload, webLogin, webPost } from './harness.ts';

const READING = ['/how-we-count', '/privacy', '/terms'];
const NOINDEX = '<meta name="robots" content="noindex">';

const PEOPLE = {
  'gh-token': octo, 'web-token': octo,
  alpha: { id: 2, login: 'alpha' }, beta: { id: 3, login: 'beta' }, hidden: { id: 4, login: 'secret-user' },
};

/** Signs an account's machine in and uploads ten tokens. */
async function join(context: ReturnType<typeof app>, githubToken: string, isPublic: boolean): Promise<string> {
  const response = await context.call('/v1/auth/token', api(null, 'POST', { githubToken, machine: machine(MACHINE_A) }));
  const { token } = (await response.json()) as { token: string };
  assert.equal((await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)))).status, 200);
  if (isPublic) await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  return token;
}

const text = async (context: ReturnType<typeof app>, path: string, init: RequestInit = {}) => (await context.call(path, init)).text();

const addresses = (sitemap: string) => [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, address]) => address);

test('each reading page answers, shares the frame, and can be shared and indexed', async () => {
  const { context } = await published();
  const session = await webLogin(context);
  for (const path of READING) {
    for (const init of [{}, { headers: { cookie: session } }]) {
      const response = await context.call(path, init);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'no-store', 'the header names whoever is signed in');
      assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/, path);
      const page = await response.text();
      assert.doesNotMatch(page, /<script|<link rel="stylesheet"|@import|url\((?!#)|<iframe|<img (?!src="\/favicon\.svg"|src="https:\/\/avatars\.githubusercontent\.com\/)/i, `${path} needs only what the policy allows`);
      assert.match(page, /<a class="skip" href="#main">Skip to content<\/a>[\s\S]*<main id="main">/, path);
      assert.match(page, /<meta name="description" content="[^"]{40,}">/, path);
      assert.equal(page.match(/<h1[ >]/g)?.length, 1, `${path} has one main heading`);
      assert.match(page, /<meta property="og:image" content="https:\/\/stats\.example\/og\.png">/, path);
      assert.ok(!page.includes(NOINDEX), `${path} is for everyone`);
      // Every jump at the top of the page lands on a section of it.
      const jumps = [...page.matchAll(/<a href="#([a-z-]+)">/g)].map(([, id]) => id);
      assert.ok(jumps.length >= 6, path);
      for (const id of jumps) assert.ok(page.includes(`<section id="${id}"><h2>`), `${path}#${id}`);
    }
    assert.match(await text(context, path, { headers: { cookie: session } }), /<a class="button" href="\/me">.*@octo<\/a>/);
  }
  assert.equal((await context.call('/how-we-count/')).status, 404);

  // A link into a reading page, from anywhere, names a section that page has.
  const pages = new Map<string, string>();
  for (const path of ['/', ...READING]) pages.set(path, await text(context, path));
  const deep = [...pages.values()].flatMap((page) => [...page.matchAll(/href="(\/[a-z-]+)#([a-z-]+)"/g)].map(([, path, id]) => [path, id]));
  assert.ok(deep.length >= 3);
  for (const [path, id] of deep) assert.ok(pages.get(path)?.includes(`<section id="${id}"><h2>`), `${path}#${id}`);
});

test('the footer of every page leads to the reading pages', async () => {
  const { context } = await published();
  const session = await webLogin(context);
  const footer = '<nav aria-label="Footer"><a href="/rankings">Rankings</a><a href="/how-we-count">How we count</a>'
    + '<a href="https://github.com/saintlee83/oh-my-stats#get-started">Install</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a>'
    + '<a href="https://github.com/saintlee83/oh-my-stats">GitHub</a></nav>';
  for (const path of ['/', '/rankings', '/u/octo', '/nope', ...READING]) assert.ok((await text(context, path)).includes(footer), path);
  for (const path of ['/me', '/me/rankings']) assert.ok((await text(context, path, { headers: { cookie: session } })).includes(footer), path);
});

test('how we count says what each number is and where it stops being reliable', async () => {
  const page = await text(app(), '/how-we-count');
  for (const fact of [
    'input, output, cache reads and cache writes',
    'Adding across machines', 'Counting once',
    'The rest is undated',
    'at public API list prices', 'It is not what was paid', 'Cost is a minimum, marked ≥',
    'Private work is included because only numbers are uploaded',
    'Rankings list published profiles only', 'positive usage', '1, 1, 3', 'today’s date in UTC',
    'uploads once a day', 'cached for 5 minutes',
    'It cannot check that the usage happened',
    '20,000 changed rows per account per day',
  ]) assert.ok(page.includes(fact), fact);
  assert.ok(page.includes(`<code>oms</code> finds ${PROVIDERS.size} tools on its own`));
  for (const name of PROVIDERS.values()) assert.ok(page.includes(name), name);
  assert.doesNotMatch(page, /Last updated/, 'only the two pages kept as a record carry a date');
});

test('the privacy page names the cookies the server sets, and how long each lasts', async () => {
  const context = app();
  const start = await context.call('/login');
  const state = start.headers.get('set-cookie') as string;
  const done = await context.call(`/auth/callback?code=good-code&state=${new URL(start.headers.get('location') as string).searchParams.get('state')}`, { headers: { cookie: state.split(';')[0] } });
  const set = [state, ...done.headers.getSetCookie()];
  assert.deepEqual(set.map((cookie) => cookie.split('=')[0]).sort(), ['oms_session', 'oms_state', 'oms_state'], 'two cookies, and the second is cleared on the way in');

  const page = await text(context, '/privacy');
  assert.match(page, /sets two cookies/);
  assert.match(set.find((cookie) => cookie.startsWith('oms_session=')) as string, /Max-Age=2592000; Secure$/);
  assert.match(page, /<code>oms_session<\/code> keeps you signed in\. .* It lasts 30 days/);
  assert.match(state, /^oms_state=[a-f0-9]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  assert.match(page, /<code>oms_state<\/code> is set when you start signing in and removed when you finish, or after 10 minutes/);
  assert.match(page, /<code>HttpOnly<\/code>[\s\S]*<code>SameSite=Lax<\/code>/);

  // What the page says of visitors who never sign in.
  const { context: other } = await published();
  for (const path of ['/', '/rankings', '/u/octo', '/privacy', '/sitemap.xml', '/robots.txt', '/nope']) {
    assert.equal((await other.call(path)).headers.get('set-cookie'), null, path);
  }
  assert.match(page, /A visitor who never signs in gets none/);
  assert.match(page, /Public pages run no scripts/);
  assert.match(page, /signed-in dashboard loads a script from this server/);
});

test('the privacy page says what is stored and public, how to delete it, and invents no contact', async () => {
  const { context } = await published();
  const page = await text(context, '/privacy');
  assert.match(page, /<p class="muted">Last updated <time datetime="(\d{4}-\d{2}-\d{2})">\1<\/time><\/p>/);
  for (const fact of [
    'Prompts, responses and code', 'Commit messages and file paths', 'Private repository and organization names', 'The token that reads your repositories',
    'no place for an email address, a password or an IP address',
    'a hash of its token',
    'Machine names and ids are never public',
    '<a href="/sitemap.xml">sitemap</a>',
    'The server uses it once and doesn’t store it',
    'cached for 5 minutes', 'up to five minutes',
    'deleted from the database at once', 'Everything this server holds about the account is deleted at once',
    'expires after 180 days without an upload', 'A website sign-in lasts 30 days',
    'whoever runs this server',
  ]) assert.ok(page.includes(fact), fact);

  // The page sends people to controls the dashboard really has, by the names it gives them.
  const dashboard = await text(context, '/me', { headers: { cookie: await webLogin(context) } });
  assert.match(page, /under Machines, choose Remove\./);
  assert.match(dashboard, /<h2>Machines<\/h2>[\s\S]*<summary class="danger">Remove<\/summary>/);
  assert.match(page, /under Account, choose “Delete my account and data” and type your GitHub username/);
  assert.match(dashboard, /<h2>Account<\/h2>[\s\S]*<summary class="danger">Delete my account and data<\/summary>/);

  for (const path of ['/privacy', '/terms']) {
    const words = await text(context, path);
    assert.ok(words.includes('href="https://github.com/saintlee83/oh-my-stats/issues"'), `${path} sends questions to the issue tracker`);
    assert.doesNotMatch(words, /mailto:|[\w.+-]+@[\w-]+\.[a-z]{2,}/i, `${path} gives no email address`);
  }
});

test('the terms are short: no warranty, your own real usage, and publishing by choice', async () => {
  const page = await text(app(), '/terms');
  assert.match(page, /<p class="muted">Last updated <time datetime="\d{4}-\d{2}-\d{2}">/);
  for (const fact of [
    '<a href="https://github.com/saintlee83/oh-my-stats/blob/main/LICENSE">MIT license</a>',
    'without warranty of any kind',
    'Upload only your own real usage',
    'may remove an account or a group that abuses the service or the rankings',
    'publishing is your choice',
    'The service may change or stop',
  ]) assert.ok(page.includes(fact), fact);
  assert.ok(page.length < (await text(app(), '/privacy')).length, 'shorter than the page that has to be thorough');
});

test('robots.txt keeps crawlers out of private pages, the API and sign-in, and names the sitemap', async () => {
  const response = await app().call('/robots.txt');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  const lines = (await response.text()).trim().split('\n');
  assert.equal(lines[0], 'User-agent: *');
  assert.deepEqual(lines.filter((line) => line.startsWith('Disallow:')), ['Disallow: /me', 'Disallow: /v1/', 'Disallow: /login', 'Disallow: /auth/'], 'everything else is allowed');
  assert.equal(lines.at(-1), `Sitemap: ${ORIGIN}/sitemap.xml`);
});

test('the sitemap lists the pages for everyone and every public profile, and never a private one', async () => {
  const context = app({}, PEOPLE);
  const fixed = ['/', '/rankings', '/rankings/providers', '/rankings/models', '/groups', ...READING].map((path) => `${ORIGIN}${path}`);
  assert.deepEqual(addresses(await text(context, '/sitemap.xml')), fixed, 'a new server has no profiles');

  await join(context, 'gh-token', true);
  await join(context, 'alpha', true);
  await join(context, 'hidden', false);
  const response = await context.call('/sitemap.xml');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  const sitemap = await response.text();
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\n/);
  assert.deepEqual(addresses(sitemap), [...fixed, `${ORIGIN}/u/alpha`, `${ORIGIN}/u/octo`]);
  assert.ok(!sitemap.includes('secret-user') && !sitemap.includes(SECRET_NAME) && !sitemap.includes(MACHINE_A));
});

test('a profile made private or deleted leaves the sitemap at once, where it was kept', async () => {
  const cache = fakeCache();
  const db = countingDb();
  const { context, token } = await published({ cache, db });
  const key = `${ORIGIN}/sitemap.xml`;
  const reads = () => db.sql.filter((sql) => sql.includes('SELECT login FROM users WHERE is_public = 1')).length;
  const listed = async () => addresses(await text(context, '/sitemap.xml')).includes(`${ORIGIN}/u/octo`);

  assert.ok(await listed());
  assert.ok(cache.store.has(key), 'kept like a public page');
  assert.ok(await listed());
  assert.ok(addresses(await text(context, '/sitemap.xml?fresh=1')).includes(`${ORIGIN}/u/octo`));
  assert.equal(reads(), 1, 'profiles are listed once, however the address is written');

  await context.call('/v1/me', api(token, 'PATCH', { public: false }));
  assert.ok(!cache.store.has(key), 'unpublishing removes the kept copy');
  assert.ok(!(await listed()), 'and the next one is made without the profile');

  const session = await webLogin(context);
  await context.call('/me/visibility', webPost(session, 'public=1'));
  cache.store.clear();
  assert.ok(await listed());
  await context.call('/me/visibility', webPost(session, 'public=0'));
  assert.ok(!cache.store.has(key) && !(await listed()), 'the same from the website');

  await context.call('/me/visibility', webPost(session, 'public=1'));
  cache.store.clear();
  assert.ok(await listed());
  await context.call('/me/delete', webPost(session, 'confirm=octo'));
  assert.ok(!cache.store.has(key) && !(await listed()), 'and when the account is deleted');
});

test('an account whose login passed to someone else is left out of the sitemap, having no address', async () => {
  const context = app({}, { 'gh-token': octo, 'web-token': octo, taker: { id: 9, login: 'octo' } });
  await join(context, 'gh-token', true);
  assert.ok(addresses(await text(context, '/sitemap.xml')).includes(`${ORIGIN}/u/octo`));
  await join(context, 'taker', false);
  const listed = addresses(await text(context, '/sitemap.xml'));
  assert.ok(listed.every((address) => !address.includes('/u/')), 'the old owner has no page to list, and the new one is private');
  assert.ok(!(await text(context, '/sitemap.xml')).includes('renamed-'));
});

test('pages only their owner sees, and errors, ask search engines to leave them out', async () => {
  const { context } = await published();
  const session = await webLogin(context);
  for (const path of ['/', '/rankings', '/rankings?days=7', '/u/octo', ...READING]) {
    assert.ok(!(await text(context, path)).includes(NOINDEX), `${path} is public`);
    assert.ok(!(await text(context, path, { headers: { cookie: session } })).includes(NOINDEX), `${path} is public, whoever reads it`);
  }
  for (const path of ['/me', '/me/rankings']) assert.ok((await text(context, path, { headers: { cookie: session } })).includes(NOINDEX), path);
  for (const path of ['/nope', '/u/nobody', '/rankings?days=8']) assert.ok((await text(context, path)).includes(NOINDEX), `${path} is an error`);
  assert.equal((await text(context, '/nope')).match(/<meta name="robots"/g)?.length, 1);
});

test('the landing page explains how it works in three steps and answers questions without scripts', async () => {
  const page = await text(app(), '/');
  const [, steps] = /<ol class="steps">(.*?)<\/ol>/s.exec(page) ?? [];
  assert.equal(steps.match(/<li><h3>[^<]+<\/h3><p>/g)?.length, 3);
  assert.match(steps, /Only totals are uploaded/);

  const [, questions] = /<div class="panel faq">(.*?)<\/div>/s.exec(page) ?? [];
  const asked = [...questions.matchAll(/<details><summary>([^<]+)<\/summary><p>.+?<\/p><\/details>/gs)].map(([, question]) => question);
  assert.ok(asked.length >= 6 && asked.length <= 8, `${asked.length} questions`);
  assert.ok(asked.every((question) => question.endsWith('?')));
  for (const answer of [
    'Your profile stays hidden until you publish it',
    'Run <code>oms preview</code> to see exactly what would be uploaded',
    'At public API list prices',
    'an account-wide total, such as Codex’s, is counted once',
    'uploads once a day',
    'Deleting your account removes everything on the server, after you confirm with your username',
    'a single Cloudflare Worker with a D1 database',
  ]) assert.ok(questions.includes(answer), answer);
  assert.doesNotMatch(page, /<script/i);
  assert.equal(page.match(/<h1[ >]/g)?.length, 1);
  assert.match(page, /<h2>Numbers you can stand behind<\/h2>[\s\S]*<h2>Reads the tools you already use<\/h2>[\s\S]*<h2>What leaves your machine<\/h2>/, 'the sections it had are still there');
});

test('the landing page shows the mark of every tool oms reads beside its name', async () => {
  const page = await text(app(), '/');
  assert.deepEqual([...PROVIDER_ICONS.keys()].sort(), [...PROVIDERS.keys()].sort(), 'each tool has a mark, and each mark a tool');
  for (const [id, name] of PROVIDERS) {
    assert.ok(page.includes(`<li>${mark(id)}${name}</li>`), name);
    assert.equal(page.split(`<symbol id="provider-${id}" viewBox="0 0 24 24">${PROVIDER_ICONS.get(id)}</symbol>`).length - 1, 1, `${name}’s mark is drawn once`);
  }
  // A mark takes the color of the name beside it, so it reads in light and in dark.
  for (const [id, drawing] of PROVIDER_ICONS) assert.doesNotMatch(drawing, /fill=|stroke=|style=|<script|href=/, id);
});

test('the figures strip counts profiles and their tokens only once three are ranked', async () => {
  const context = app({}, PEOPLE);
  const strip = async () => (/<ul class="tally wrap">(.*?)<\/ul>/s.exec(await text(context, '/')) ?? [])[1];
  const tools = `<li><strong>${PROVIDERS.size}</strong> <span>AI tools read automatically</span></li>`;
  assert.equal(await strip(), tools, 'a new server still says how many tools are read');

  await join(context, 'gh-token', true);
  await join(context, 'alpha', true);
  await join(context, 'hidden', false);
  assert.equal(await strip(), tools, 'two profiles are too few to sum up');

  await join(context, 'beta', true);
  assert.equal(
    await strip(),
    `<li><strong>3</strong> <span>ranked public profiles</span></li><li><strong>30</strong> <span>AI tokens between them, all time</span></li>${tools}`,
    'the private account adds neither a profile nor its tokens',
  );
});
