import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardSort, CHANGE_BASE, costBoard, modelBoard, providerBoard } from '../src/server/boards.ts';
import { rankBoard, rankingPeriod } from '../src/server/rankings.ts';
import type { PriceTable } from '../src/shared/types.ts';
import { BadRequest } from '../src/server/wire.ts';
import { api, app, countingDb, MACHINE_A, MACHINE_B, machine, mark, octo, signIn, upload, webLogin } from './harness.ts';
import { testDb } from './sqlite-d1.ts';

const NOW = new Date('2026-11-09T05:00:00Z');
const WEEK = rankingPeriod('7', NOW);
const LIFETIME = rankingPeriod('all', NOW);

/** Prices per token that are easy to work out by hand. Gemini's is listed under its vendor, and Codex has no cache prices. */
const PRICES: PriceTable = {
  'claude-opus-5-5': { input: 0.01, output: 0.05, cacheRead: 0.001, cacheWrite: 0.02 },
  'claude-sonnet-5-5': { input: 0.003, output: 0.015, cacheRead: null, cacheWrite: null },
  'gpt-5.5-codex': { input: 0.002, output: 0.01, cacheRead: null, cacheWrite: null },
  'gemini/gemini-3-pro': { input: 0.004, output: 0.02, cacheRead: null, cacheWrite: null },
};

type TestDb = ReturnType<typeof testDb>;
type Tuple = [input: number, output: number, cacheRead: number, cacheWrite: number];

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Profiles with one machine each, written straight to the database. */
function people(db: TestDb, rows: [id: number, login: string, name?: string | null, isPublic?: boolean][]) {
  const user = db.raw.prepare("INSERT INTO users (id, login, name, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-10-01', '2026-10-01')");
  const device = db.raw.prepare("INSERT INTO machines (user_id, id, name, created_at, last_seen_at) VALUES (?, 'a', 'secret-laptop', '2026-10-01', '2026-10-01')");
  for (const [id, login, name = null, isPublic = true] of rows) {
    user.run(String(id), login, name, isPublic ? 1 : 0);
    device.run(String(id));
  }
}

/** The same logged usage for each of some profiles. */
function logged(db: TestDb, ids: number[], day: string, tool: string, model: string, [input, output, cacheRead, cacheWrite]: Tuple) {
  const row = db.raw.prepare("INSERT INTO usage_daily VALUES (?, 'a', ?, ?, ?, ?, ?, ?, ?, 1)");
  for (const id of ids) row.run(String(id), day, tool, model, input, output, cacheRead, cacheWrite);
}

/** A stored price table, fresh enough that no page asks the network for one. */
function priced(db: TestDb, prices: PriceTable = PRICES) {
  db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('prices', ?, '2026-11-09T00:00:00.000Z')").run(JSON.stringify(prices));
}

const rawDb = (context: ReturnType<typeof app>) => context.deps.db as TestDb;

/** Six profiles whose logged usage is worked out by hand in the cost tests. */
function costFixture(db: TestDb) {
  people(db, [[1, 'octo', 'Octo Cat'], [2, 'beta'], [3, 'gamma'], [4, 'delta'], [5, 'hidden', 'Hidden One', false], [6, 'epsilon', 'Eve <img src=x> & co'], [7, 'zeta']]);
  // octo: 1000 x 0.01 + 200 x 0.05 + 5000 x 0.001 + 100 x 0.02 = $27 for 6,300 tokens.
  logged(db, [1], '2026-11-08', 'claude', 'claude-opus-5-5', [1000, 200, 5000, 100]);
  // A dated name is priced as the model it is a release of: 100 x 0.01 = $1.
  logged(db, [1], '2026-11-07', 'claude', 'claude-opus-5-5-20261101', [100, 0, 0, 0]);
  // Without a cache price, cache reads cost what input costs: 500 x 0.002 + 100 x 0.01 + 1000 x 0.002 = $4 for 1,600 tokens.
  logged(db, [1], '2026-11-08', 'codex', 'gpt-5.5-codex', [500, 100, 1000, 0]);
  // No list price: 9,000 tokens that cost nothing.
  logged(db, [1], '2026-11-08', 'local-ai', 'my-model', [9000, 0, 0, 0]);
  // Before the week: 10,000 x 0.01 = $100.
  logged(db, [1], '2026-10-20', 'claude', 'claude-opus-5-5', [10000, 0, 0, 0]);
  // beta and epsilon both come to $5: 1000 x 0.002 + 300 x 0.01, and 500 x 0.01.
  logged(db, [2], '2026-11-05', 'codex', 'gpt-5.5-codex', [1000, 300, 0, 0]);
  logged(db, [6], '2026-11-06', 'claude', 'claude-opus-5-5', [500, 0, 0, 0]);
  // gamma: 250 x 0.004 + 50 x 0.02 = $2.
  logged(db, [3], '2026-11-09', 'gemini', 'gemini-3-pro', [250, 50, 0, 0]);
  // delta only used a model without a price, and hidden is private.
  logged(db, [4], '2026-11-08', 'kimi-cli', 'kimi-k2', [50000, 0, 0, 0]);
  logged(db, [5], '2026-11-08', 'claude', 'claude-opus-5-5', [1_000_000, 0, 0, 0]);
  // zeta: one token, a fifth of a cent.
  logged(db, [7], '2026-11-08', 'codex', 'gpt-5.5-codex', [1, 0, 0, 0]);
}

test('the order of the profiles board is tokens unless cost is asked for', () => {
  assert.equal(boardSort(null), 'tokens');
  assert.equal(boardSort(''), 'tokens');
  assert.equal(boardSort('tokens'), 'tokens');
  assert.equal(boardSort('cost'), 'cost');
  for (const value of ['price', 'COST', 'cost ', 'tokens,cost']) assert.throws(() => boardSort(value), BadRequest, value);
});

test('cost is the logged usage of public profiles at list prices, and equal costs share a place', async () => {
  const db = testDb();
  costFixture(db);
  const week = await costBoard(db, PRICES, WEEK, { viewerId: '6' });
  assert.deepEqual(week.users, [
    { rank: 1, label: 'octo', name: 'Octo Cat', tokens: 17000, cost: 32 },
    { rank: 2, label: 'beta', name: null, tokens: 1300, cost: 5 },
    { rank: 2, label: 'epsilon', name: 'Eve <img src=x> & co', tokens: 500, cost: 5 },
    { rank: 4, label: 'gamma', name: null, tokens: 300, cost: 2 },
    { rank: 5, label: 'zeta', name: null, tokens: 1, cost: 0.002 },
  ], 'a model without a price adds tokens but no cost, and a profile with no priced usage is not ranked');
  assert.deepEqual(week.position, { days: 7, rank: 2, participants: 5 });
  assert.deepEqual([week.cost, week.tokens, week.page, week.pages, week.viewerPage], [44.002, 19101, 1, 1, 1]);
  assert.deepEqual(week.providers, [
    { tool: 'kimi-cli', tokens: 50000, profiles: 1 }, { tool: 'local-ai', tokens: 9000, profiles: 1 },
    { tool: 'claude', tokens: 6900, profiles: 2 }, { tool: 'codex', tokens: 2901, profiles: 3 }, { tool: 'gemini', tokens: 300, profiles: 1 },
  ], 'the providers on offer are those in the logs of public profiles, most used first');

  const lifetime = await costBoard(db, PRICES, LIFETIME);
  assert.deepEqual(lifetime.users[0], { rank: 1, label: 'octo', name: 'Octo Cat', tokens: 27000, cost: 132 }, 'all time is every logged row');
  assert.deepEqual([lifetime.position, lifetime.cost], [{ days: 'all', rank: null, participants: 5 }, 144.002]);

  const claude = await costBoard(db, PRICES, WEEK, { provider: 'claude', viewerId: '2' });
  assert.deepEqual(claude.users, [
    { rank: 1, label: 'octo', name: 'Octo Cat', tokens: 6400, cost: 28 },
    { rank: 2, label: 'epsilon', name: 'Eve <img src=x> & co', tokens: 500, cost: 5 },
  ]);
  assert.deepEqual([claude.position, claude.viewerPage], [{ days: 7, rank: null, participants: 2 }, null], 'beta has no usage of this provider');
  assert.deepEqual(claude.providers, week.providers, 'the providers on offer do not depend on the one chosen');
  assert.deepEqual((await costBoard(db, PRICES, WEEK, { provider: 'local-ai' })).users, [], 'usage without a price ranks nobody');
  assert.deepEqual((await costBoard(db, {}, WEEK)).position.participants, 0, 'without a price table nothing has a cost');
});

test('the board by cost shows the cost, the logged tokens and what the estimate is', async () => {
  const context = app();
  costFixture(rawDb(context));
  priced(rawDb(context));
  const cookie = await webLogin(context);
  const response = await context.call('/rankings?days=7&sort=cost', { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.match(html, /<a href="\/rankings\?days=7">By tokens<\/a><a href="\/rankings\?days=7&amp;sort=cost" aria-current="page">By estimated cost<\/a>/);
  assert.match(html, /<th class="num">Estimated cost<\/th><th class="num wide">Logged tokens<\/th>/);
  assert.match(html, /Places 1–5<\/h2><p class="muted">\$44 at list prices for 19\.1k logged tokens, from 5 ranked public profiles · You are <strong>#1<\/strong><\/p>/);
  assert.match(html, /<tr class="me"><td class="rank"><span class="place" data-place="1">1<\/span>[\s\S]*?<b>Octo Cat<\/b><small>@octo<\/small><\/span><\/a><span class="badge">You<\/span><\/td>\n[^\n]*\n<td class="num"><strong>\$32<\/strong><small class="narrow">17k tokens<\/small><small>\$32\.00<\/small><\/td><td class="num wide"><strong>17k<\/strong><small>17,000<\/small><\/td><\/tr>/);
  assert.deepEqual([...html.matchAll(/<span class="place"[^>]*>(\d+)<\/span><\/td><td class="who"><a href="\/u\/([a-z]+)"/g)].map(([, rank, login]) => `${rank} ${login}`),
    ['1 octo', '2 beta', '2 epsilon', '4 gamma', '5 zeta']);
  assert.match(html, /<strong>\$5<\/strong><small class="narrow">1\.3k tokens<\/small><small>\$5\.00<\/small>/);
  assert.match(html, /<strong>&lt;\$0\.01<\/strong><small class="narrow">1 token<\/small><\/td>/, 'under a cent, the amount itself would read as nothing');
  assert.match(html, /at public API list prices\. It is not what anyone paid[\s\S]*lower than the cost on a profile’s own page when a tool reports more usage than its logs hold[\s\S]*A model without a list price adds its tokens here, but no cost\./);
  assert.match(html, /<b>Eve &lt;img src=x&gt; &amp; co<\/b><small>@epsilon<\/small>/, 'a name is text from GitHub, so it is escaped');
  assert.doesNotMatch(html, /<img src=x>|@delta|@hidden|Hidden One|secret-laptop|local-ai/);
  assert.ok(html.includes(`<nav class="filters" aria-label="Providers"><a href="/rankings?days=7&amp;sort=cost" aria-current="page">All providers</a><a href="/rankings?days=7&amp;provider=kimi-cli&amp;sort=cost">${mark('kimi-cli')}Kimi Code CLI</a><a href="/rankings?days=7&amp;provider=claude&amp;sort=cost">${mark('claude')}Claude Code</a>`));
  assert.match(html, /<a href="\/rankings\?days=30&amp;sort=cost">Last 30 days<\/a>/, 'changing the period keeps the order');

  const codex = await (await context.call('/rankings?days=7&provider=codex&sort=cost')).text();
  assert.match(codex, /Places 1–3 · Codex<\/h2><p class="muted">\$9 at list prices for 2\.9k logged tokens, from 3 ranked public profiles<\/p>/);
  assert.match(codex, /<a href="\/rankings\?days=7&amp;provider=codex">By tokens<\/a>/, 'changing the order keeps the provider');
  const none = await (await context.call('/rankings?days=7&provider=kimi-cli&sort=cost')).text();
  assert.match(none, /Places · Kimi Code CLI<\/h2><p class="muted">0 ranked public profiles<\/p><\/div>\n<p>No logged usage with a list price for this period\.<\/p>/);

  const tokens = await (await context.call('/rankings?days=7')).text();
  assert.match(tokens, /@delta<\/a>[\s\S]*<strong>50k<\/strong>/, 'by tokens, usage without a price still ranks');
  assert.doesNotMatch(tokens, /Estimated cost<\/th>|not what anyone paid/);
});

/** 205 profiles with 999, 998, ... tokens on one day of the week. The last one is private. */
function crowd(db: TestDb, model = 'm') {
  db.raw.exec(`
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<205)
    INSERT INTO users (id, login, name, is_public, created_at, updated_at)
    SELECT i, printf('member-%03d', i), CASE WHEN i % 2 THEN printf('Member %d', i) END, i <> 205, '2026-11-01', '2026-11-01' FROM n;
    INSERT INTO machines (user_id,id,name,created_at,last_seen_at) SELECT id,'a','Primary','2026-11-01','2026-11-01' FROM users;
    INSERT INTO usage_daily SELECT id,'a','2026-11-08','codex','${model}',1000 - id,0,0,0,1 FROM users;
  `);
}

test('the profiles board is read a page at a time, and says which places it shows', async () => {
  const context = app({}, { 'web-token': { id: 150, login: 'member-150', name: 'Member 150' } });
  const db = rawDb(context);
  crowd(db);
  const cookie = await webLogin(context);
  const get = async (path: string, signedIn = false) => (await context.call(path, signedIn ? { headers: { cookie } } : {})).text();
  const rows = (html: string) => html.match(/<tr[ >]/g)!.length - 1;

  const first = await get('/rankings?days=7', true);
  assert.equal(rows(first), 100);
  assert.match(first, /Places 1–100<\/h2><p class="muted"><span title="183,090 tokens">183k tokens<\/span> from 204 ranked public profiles · You are <strong>#150<\/strong>, <a href="\/rankings\?days=7&amp;page=2">on page 2<\/a><\/p>/, 'the totals are of the whole board, and the viewer is told where their row is');
  assert.match(first, /<nav class="board-pager" aria-label="Pages"><span><\/span><span>1–100 of 204<\/span><a class="button" href="\/rankings\?days=7&amp;page=2" rel="next">Next<\/a><\/nav>/);
  assert.match(first, /<b>Member 1<\/b><small>@member-001<\/small><\/span><\/a><\/td>/, 'a profile with a name shows it with the login');
  assert.match(first, /loading="lazy">@member-002<\/a><\/td>/, 'one without shows the login alone');
  assert.doesNotMatch(first, /class="me"/);

  const second = await get('/rankings?days=7&page=2', true);
  assert.equal(rows(second), 100);
  assert.match(second, /Places 101–200<\/h2><p class="muted"><span title="183,090 tokens">183k tokens<\/span> from 204 ranked public profiles · You are <strong>#150<\/strong><\/p>/);
  assert.match(second, /<nav class="board-pager" aria-label="Pages"><a class="button" href="\/rankings\?days=7" rel="prev">Previous<\/a><span>101–200 of 204<\/span><a class="button" href="\/rankings\?days=7&amp;page=3" rel="next">Next<\/a><\/nav>/);
  assert.match(second, /<tr class="me"><td class="rank"><span class="place">150<\/span>/);

  const last = await get('/rankings?days=7&page=3');
  assert.equal(rows(last), 4);
  assert.match(last, /Places 201–204<\/h2><p class="muted"><span title="183,090 tokens">183k tokens<\/span> from 204 ranked public profiles<\/p>/);
  assert.match(last, /<a class="button" href="\/rankings\?days=7&amp;page=2" rel="prev">Previous<\/a><span>201–204 of 204<\/span><span><\/span><\/nav>/);
  assert.doesNotMatch(last, /member-205/, 'the private profile is on no page');

  const beyond = await context.call('/rankings?days=7&page=9');
  assert.equal(beyond.status, 200, 'a page past the end is an ordinary page');
  const empty = await beyond.text();
  assert.match(empty, /Page 9<\/h2><p class="muted"><span title="183,090 tokens">183k tokens<\/span> from 204 ranked public profiles<\/p><\/div>\n<p>There is no page 9\. This board has 3 pages\.<\/p>\n<p><a class="button" href="\/rankings\?days=7">Back to the first page<\/a><\/p>/);
  assert.doesNotMatch(empty, /<table|class="board-pager"/);
  assert.match(await get('/rankings?days=30&page=2&provider=pi'), /There is no page 2\. This board has 1 page\.<\/p>\n<p><a class="button" href="\/rankings\?days=30&amp;provider=pi">Back to the first page<\/a>/);

  db.raw.exec("UPDATE users SET is_public = 0 WHERE CAST(id AS INTEGER) > 101");
  assert.match(await get('/rankings?days=7&page=2'), /Place 101<\/h2>[\s\S]*<span>101–101 of 101<\/span><span><\/span><\/nav>/, 'one profile past a full page gets a page of its own');
  db.raw.exec("UPDATE users SET is_public = 0 WHERE CAST(id AS INTEGER) > 100");
  const full = await get('/rankings?days=7');
  assert.equal(rows(full), 100);
  assert.doesNotMatch(full, /class="board-pager"/, 'a board that fits one page has no pager');
});

test('the board by cost is paged like the board by tokens', async () => {
  const context = app({}, { 'web-token': { id: 150, login: 'member-150' } });
  crowd(rawDb(context), 'claude-opus-5-5');
  priced(rawDb(context));
  const cookie = await webLogin(context);
  const second = await (await context.call('/rankings?days=7&sort=cost&page=2', { headers: { cookie } })).text();
  assert.match(second, /Places 101–200<\/h2><p class="muted">\$1\.8k at list prices for 183k logged tokens, from 204 ranked public profiles · You are <strong>#150<\/strong><\/p>/);
  assert.match(second, /<a class="button" href="\/rankings\?days=7&amp;sort=cost" rel="prev">Previous<\/a><span>101–200 of 204<\/span><a class="button" href="\/rankings\?days=7&amp;sort=cost&amp;page=3" rel="next">Next<\/a>/);
  assert.match(second, /<tr class="me"><td class="rank"><span class="place">150<\/span>[\s\S]*?<strong>\$9<\/strong><small class="narrow">850 tokens<\/small><small>\$8\.50<\/small><\/td>/);
  const first = await (await context.call('/rankings?days=7&sort=cost', { headers: { cookie } })).text();
  assert.match(first, /You are <strong>#150<\/strong>, <a href="\/rankings\?days=7&amp;sort=cost&amp;page=2">on page 2<\/a>/);
  const board = await costBoard(rawDb(context), PRICES, WEEK, { viewerId: '150', page: 3 });
  assert.deepEqual(board.users.map((row) => [row.rank, row.cost]), [[201, 7.99], [202, 7.98], [203, 7.97], [204, 7.96]]);
  assert.deepEqual([board.position, board.pages, board.viewerPage], [{ days: 7, rank: 150, participants: 204 }, 3, 2]);
  const tokens = await rankBoard(rawDb(context), WEEK, { kind: 'public' }, { viewerId: '150', page: 3 });
  assert.deepEqual([tokens.position, tokens.pages, tokens.viewerPage], [board.position, 3, 2], 'the same pages and the same place by either order');
});

test('boards cover this month and last month, and the agent API keeps its three periods', async () => {
  const context = app();
  const db = rawDb(context);
  people(db, [[1, 'octo', 'Octo Cat'], [2, 'beta'], [3, 'gamma']]);
  logged(db, [1], '2026-10-31', 'claude', 'm', [700, 0, 0, 0]);
  logged(db, [1, 2], '2026-11-01', 'claude', 'm', [40, 0, 0, 0]);
  logged(db, [2], '2026-10-01', 'codex', 'm', [300, 0, 0, 0]);
  logged(db, [3], '2026-09-30', 'codex', 'm', [9000, 0, 0, 0]);
  const cookie = await webLogin(context);

  const month = await (await context.call('/rankings?days=month', { headers: { cookie } })).text();
  assert.match(month, /<a href="\/rankings\?days=month" aria-current="page">This month<\/a><a href="\/rankings\?days=last-month">Last month<\/a><\/nav>/);
  assert.match(month, /<p class="muted">2026-11-01 through 2026-11-09 · Reporting dates through today in UTC\.<\/p>/);
  assert.match(month, /Places 1–2<\/h2><p class="muted"><span title="80 tokens">80 tokens<\/span> from 2 ranked public profiles · You are <strong>#1<\/strong><\/p>/);
  assert.match(month, /<th class="num">Tokens \(this month\)<\/th>/);
  assert.match(month, /<a href="\/me\/rankings\?days=month">Mine<\/a>/);

  const last = await (await context.call('/rankings?days=last-month')).text();
  assert.match(last, /<p class="muted">2026-10-01 through 2026-10-31 · Reporting dates in UTC\.<\/p>/, 'last month is over, so it does not run through today');
  assert.match(last, /<span title="1,000 tokens">1k tokens<\/span> from 2 ranked public profiles<\/p>/);
  assert.match(last, /<b>Octo Cat<\/b>[\s\S]*<strong>700<\/strong>[\s\S]*@beta<\/a>[\s\S]*<strong>300<\/strong>/);
  assert.doesNotMatch(last, /@gamma/, 'the day before the month began is not in it');
  for (const path of ['/rankings/providers', '/rankings/models']) {
    assert.match(await (await context.call(`${path}?days=last-month`)).text(), new RegExp(`<a href="${path.replaceAll('/', '\\/')}\\?days=last-month" aria-current="page">Last month</a>`));
  }

  const mine = await (await context.call('/me/rankings?days=last-month', { headers: { cookie } })).text();
  assert.match(mine, /All time<\/span><strong>#2<\/strong><span>of 3 ranked public profiles/);
  assert.match(mine, /Last 7 days<\/span><strong>—<\/strong><span>Unranked · 0 ranked public profiles/);
  assert.match(mine, /Last month<\/span><strong>#1<\/strong><span>of 2 ranked public profiles/);
  assert.match(mine, /Tokens \(last month\)[\s\S]*secret-laptop[\s\S]*<strong>700<\/strong>/);
  assert.match(mine, /<a href="\/rankings\?days=last-month">Everyone<\/a><a href="\/me\/rankings\?days=last-month" aria-current="page">Mine<\/a>/);
  assert.equal((await (await context.call('/me/rankings?days=month', { headers: { cookie } })).text()).match(/class="tile"/g)?.length, 3);
  assert.equal((await (await context.call('/me/rankings?days=7', { headers: { cookie } })).text()).match(/class="tile"/g)?.length, 2);

  const token = await signIn(context);
  for (const days of ['month', 'last-month']) {
    const refused = await context.call(`/v1/rankings?days=${days}`, api(token, 'GET'));
    assert.deepEqual([refused.status, await refused.text()], [400, '{"error":"Choose all time, 7 days or 30 days."}']);
  }
});

/**
 * Forty public profiles and one private one. This week and the week before:
 * Codex 30 after 25, Claude Code 20 after 24, Pi 3 after none, OpenCode and Qwen Code 2 after 2,
 * Amp 2 after none, Gemini CLI none after 26. Everyone also uses a provider only they named.
 */
function providerFixture(db: TestDb) {
  people(db, [...range(1, 40).map((id): [number, string] => [id, `member-${id}`]), [41, 'hidden', null, false]]);
  logged(db, range(1, 30), '2026-11-05', 'codex', 'm', [10, 0, 0, 0]);
  logged(db, range(1, 25), '2026-10-30', 'codex', 'm', [10, 0, 0, 0]);
  logged(db, range(1, 20), '2026-11-03', 'claude', 'm', [20, 0, 0, 0]);
  logged(db, range(1, 24), '2026-11-02', 'claude', 'm', [20, 0, 0, 0]);
  logged(db, range(31, 33), '2026-11-09', 'pi', 'm', [5, 0, 0, 0]);
  logged(db, range(1, 26), '2026-10-27', 'gemini', 'm', [1, 0, 0, 0]);
  logged(db, [5, 6], '2026-11-04', 'opencode', 'm', [7, 0, 0, 0]);
  logged(db, [5, 6], '2026-10-28', 'opencode', 'm', [7, 0, 0, 0]);
  logged(db, [37, 38], '2026-11-04', 'qwen-code', 'm', [7, 0, 0, 0]);
  logged(db, [37, 38], '2026-10-28', 'qwen-code', 'm', [7, 0, 0, 0]);
  logged(db, [35, 36], '2026-11-06', 'amp', 'm', [50, 0, 0, 0]);
  logged(db, range(1, 40), '2026-11-07', 'local-ai', 'm', [1, 0, 0, 0]);
  for (const day of ['2026-11-05', '2026-10-30']) {
    logged(db, [41], day, 'codex', 'm', [1e9, 0, 0, 0]);
    logged(db, [41], day, 'cline-cli', 'm', [1e9, 0, 0, 0]);
  }
}

test('providers are ranked by active profiles, with the change from the period before', async () => {
  const db = testDb();
  providerFixture(db);
  assert.equal(CHANGE_BASE, 25);
  const week = await providerBoard(db, WEEK);
  assert.deepEqual(week.providers, [
    { rank: 1, tool: 'codex', profiles: 30, tokens: 300, share: 0.75, change: { before: 25, by: 5, rate: 0.2 } },
    { rank: 2, tool: 'claude', profiles: 20, tokens: 400, share: 0.5, change: { before: 24, by: -4, rate: null } },
    { rank: 3, tool: 'pi', profiles: 3, tokens: 15, share: 0.075, change: { before: 0, by: 3, rate: null } },
    { rank: 4, tool: 'amp', profiles: 2, tokens: 100, share: 0.05, change: { before: 0, by: 2, rate: null } },
    { rank: 5, tool: 'opencode', profiles: 2, tokens: 14, share: 0.05, change: { before: 2, by: 0, rate: null } },
    { rank: 5, tool: 'qwen-code', profiles: 2, tokens: 14, share: 0.05, change: { before: 2, by: 0, rate: null } },
  ], 'a percentage needs 25 profiles in the period before, and neither an unknown provider nor a private profile is listed');
  assert.deepEqual([week.profiles, week.tokens, week.compared], [40, 883, { days: 7, start: '2026-10-27', end: '2026-11-02' }], 'adoption is a share of every ranked profile');

  const lifetime = await providerBoard(db, LIFETIME);
  assert.deepEqual(lifetime.providers.map(({ rank, tool, profiles, change }) => [rank, tool, profiles, change]), [
    [1, 'codex', 30, null], [2, 'gemini', 26, null], [3, 'claude', 24, null], [4, 'pi', 3, null], [5, 'amp', 2, null], [6, 'opencode', 2, null], [6, 'qwen-code', 2, null],
  ], 'all time has no period before it');
  assert.equal(lifetime.compared, null);

  const month = await providerBoard(db, rankingPeriod('month', NOW, true));
  assert.deepEqual(month.compared, { days: 'last-month', start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(month.providers.find((row) => row.tool === 'claude'), { rank: 2, tool: 'claude', profiles: 24, tokens: 880, share: 0.6, change: { before: 0, by: 24, rate: null } });
  assert.deepEqual(month.providers.find((row) => row.tool === 'codex')?.change, { before: 25, by: 5, rate: 0.2 });
});

test('the providers board lists the known tools, and writes each change plainly', async () => {
  const context = app();
  providerFixture(rawDb(context));
  const response = await context.call('/rankings/providers?days=7');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.match(html, /<nav class="board-tabs" aria-label="Boards"><a href="\/rankings\?days=7">Profiles<\/a><a href="\/rankings\/providers\?days=7" aria-current="page">Providers<\/a><a href="\/rankings\/models\?days=7">Models<\/a><\/nav>/);
  assert.match(html, /Providers by active profiles<\/h2><p class="muted">883 tokens from 40 ranked public profiles<\/p>/);
  assert.match(html, /<th class="num wide">Active profiles<\/th><th class="num wide">Adoption<\/th><th class="num">Tokens \(7 days\)<\/th><th class="num wide">Change in profiles<\/th>/);
  const row = (name: string) => html.slice(html.indexOf(`>${name}</a>`)).split('</tr>')[0];
  assert.match(row('Codex'), /^>Codex<\/a><small class="narrow">30 profiles \(75\.0%\) · <span class="up">\+5<\/span><\/small><\/td>\n<td class="meter" aria-hidden="true"><span style="--share:75\.0%"><\/span><\/td>\n<td class="num wide"><strong>30<\/strong><\/td><td class="num wide"><strong>75\.0%<\/strong><\/td><td class="num"><strong>300<\/strong><\/td><td class="num wide"><strong class="up">\+5<\/strong><small>\+20\.0%<\/small><\/td>$/);
  assert.match(row('Claude Code'), /<strong>20<\/strong><\/td><td class="num wide"><strong>50\.0%<\/strong><\/td><td class="num"><strong>400<\/strong><\/td><td class="num wide"><strong class="down">−4<\/strong><\/td>$/, 'no percentage on a base under 25');
  assert.match(row('Pi'), /3 profiles \(7\.5%\) · <span class="up">new<\/span>[\s\S]*<strong class="up">new<\/strong><\/td>$/);
  assert.match(row('OpenCode'), /2 profiles \(5\.0%\)<\/small>[\s\S]*<td class="num wide"><strong>0<\/strong><\/td>$/);
  assert.ok(html.includes(`<span class="place">1</span></td><td class="who"><a href="/rankings?days=7&amp;provider=codex">${mark('codex')}Codex</a>`), 'a provider leads to the profiles that use it');
  assert.deepEqual([...html.matchAll(/<span class="place">(\d+)<\/span>/g)].map(([, rank]) => Number(rank)), [1, 2, 3, 4, 5, 5]);
  assert.doesNotMatch(html, /local-ai|Cline CLI|cline-cli|Gemini CLI|\/u\/| data-place=/, 'no unknown provider, nothing only a private profile used, no provider without usage, no profiles, no medals');
  assert.match(html, /Adoption is their share of all 40 ranked public profiles\. Change is the difference in active profiles from 2026-10-27 through 2026-11-02\. It comes with a percentage when the provider had at least 25 active profiles then\. Only the tools <code>oms<\/code> reads on its own are listed/);

  const lifetime = await (await context.call('/rankings/providers')).text();
  assert.match(lifetime, /<a href="\/rankings\/providers\?days=all" aria-current="page">All time<\/a>/);
  assert.match(lifetime, /<th class="num">Lifetime tokens<\/th><\/tr>/);
  assert.doesNotMatch(lifetime, /Change in profiles|Change is the difference|class="(up|down)"/, 'all time has nothing to compare with');
  assert.match(await (await context.call('/rankings/providers?days=month')).text(), /from 2026-10-01 through 2026-10-31, the whole of last month\./);
  assert.match(await (await app().call('/rankings/providers?days=7')).text(), /Providers by active profiles<\/h2><p class="muted">0 ranked public profiles<\/p><\/div>\n<p>No token usage for this period\.<\/p>/);
});

/**
 * Forty public profiles and one private one, this week and the week before.
 * Opus: 28 through Claude Code and 11 under a dated name through OpenCode, 30 in all, after 26.
 * Codex's model: 10 through Codex and 2 through a provider only they named, after 10.
 * Gemini's: 2 after none. Sonnet: only the week before. The rest use models without a price.
 */
function modelFixture(db: TestDb) {
  people(db, [...range(1, 40).map((id): [number, string] => [id, `member-${id}`]), [41, 'hidden', null, false]]);
  logged(db, range(1, 28), '2026-11-05', 'claude', 'claude-opus-5-5', [100, 0, 0, 0]);
  logged(db, range(20, 30), '2026-11-06', 'opencode', 'claude-opus-5-5-20261101', [10, 0, 0, 0]);
  logged(db, range(1, 26), '2026-10-30', 'claude', 'claude-opus-5-5', [100, 0, 0, 0]);
  logged(db, range(1, 10), '2026-11-04', 'codex', 'gpt-5.5-codex', [50, 0, 0, 0]);
  logged(db, [11, 12], '2026-11-04', 'local-ai', 'gpt-5.5-codex', [1000, 0, 0, 0]);
  logged(db, range(1, 10), '2026-10-28', 'codex', 'gpt-5.5-codex', [50, 0, 0, 0]);
  logged(db, [31, 32], '2026-11-09', 'gemini', 'gemini-3-pro', [250, 50, 0, 0]);
  logged(db, range(1, 9), '2026-11-01', 'claude', 'claude-sonnet-5-5', [100, 0, 0, 0]);
  logged(db, range(33, 40), '2026-11-08', 'kimi-cli', 'kimi-k2', [5000, 0, 0, 0]);
  logged(db, [1], '2026-11-08', 'local-ai', 'my-model', [5000, 0, 0, 0]);
  for (const day of ['2026-11-05', '2026-10-30']) logged(db, [41], day, 'claude', 'claude-opus-5-5', [1e9, 0, 0, 0]);
}

test('models are ranked by the profiles that logged them, under the name their price is found under', async () => {
  const db = testDb();
  modelFixture(db);
  const week = await modelBoard(db, PRICES, WEEK);
  assert.deepEqual(week.models, [
    { rank: 1, model: 'claude-opus-5-5', provider: 'claude', providerShare: 2800 / 2910, profiles: 30, share: 0.75, tokens: 2910, cost: 29.1, change: { before: 26, by: 4, rate: 4 / 26 } },
    { rank: 2, model: 'gpt-5.5-codex', provider: null, providerShare: 0.8, profiles: 12, share: 0.3, tokens: 2500, cost: 5, change: { before: 10, by: 2, rate: null } },
    { rank: 3, model: 'gemini-3-pro', provider: 'gemini', providerShare: 1, profiles: 2, share: 0.05, tokens: 600, cost: 4, change: { before: 0, by: 2, rate: null } },
  ], 'a profile that used a dated and an undated name counts once, and a provider only its uploader named is not named here');
  assert.deepEqual([week.priced, week.profiles, week.tokens, week.cost], [3, 40, 6010, 38.1], 'adoption is a share of every profile with logged usage, priced or not');
  assert.deepEqual(week.compared, { days: 7, start: '2026-10-27', end: '2026-11-02' });

  const lifetime = await modelBoard(db, PRICES, LIFETIME);
  assert.deepEqual(lifetime.models.map(({ rank, model, profiles, tokens, cost, change }) => [rank, model, profiles, tokens, cost, change]), [
    [1, 'claude-opus-5-5', 30, 5510, 55.1, null], [2, 'gpt-5.5-codex', 12, 3000, 6, null], [3, 'claude-sonnet-5-5', 9, 900, 2.7, null], [4, 'gemini-3-pro', 2, 600, 4, null],
  ]);
  assert.equal(lifetime.compared, null);
  const before = await modelBoard(db, PRICES, { days: 7, start: '2026-10-27', end: '2026-11-02' });
  assert.deepEqual(before.models.map(({ model, profiles }) => [model, profiles]), [['claude-opus-5-5', 26], ['gpt-5.5-codex', 10], ['claude-sonnet-5-5', 9]], 'the period before, read on its own, has the counts the change starts from');
  assert.deepEqual(await modelBoard(db, {}, WEEK), { models: [], priced: 0, profiles: 40, tokens: 0, cost: 0, compared: week.compared }, 'without prices no model is listed');

  // A dated name that has a price of its own is a model of its own.
  const dated = await modelBoard(db, { ...PRICES, 'claude-opus-5-5-20261101': PRICES['claude-sonnet-5-5'] }, WEEK);
  assert.deepEqual(dated.models.map(({ model, profiles }) => [model, profiles]), [['claude-opus-5-5', 28], ['gpt-5.5-codex', 12], ['claude-opus-5-5-20261101', 11], ['gemini-3-pro', 2]]);

  const many = testDb();
  people(many, range(1, 105).map((id): [number, string] => [id, `member-${id}`]));
  const prices: PriceTable = {};
  for (const id of range(1, 105)) {
    prices[`gpt-${String(id).padStart(3, '0')}`] = PRICES['gpt-5.5-codex'];
    logged(many, [id], '2026-11-05', 'codex', `gpt-${String(id).padStart(3, '0')}`, [1000 - id, 0, 0, 0]);
  }
  const top = await modelBoard(many, prices, WEEK);
  assert.deepEqual([top.models.length, top.priced, top.models[0].model, top.models[99].model, top.models[99].rank], [100, 105, 'gpt-001', 'gpt-100', 100], 'at most a hundred are listed');
  assert.equal(top.tokens, range(1, 105).reduce((sum, id) => sum + 1000 - id, 0), 'the totals are of every priced model');
});

test('the models board lists priced models only, with the provider that carries each', async () => {
  const context = app();
  modelFixture(rawDb(context));
  priced(rawDb(context));
  const response = await context.call('/rankings/models?days=7');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.match(html, /<a href="\/rankings\/providers\?days=7">Providers<\/a><a href="\/rankings\/models\?days=7" aria-current="page">Models<\/a><\/nav>/);
  assert.match(html, /Models by active profiles<\/h2><p class="muted">3 priced models · 6k logged tokens · \$38 at list prices<\/p>/);
  assert.match(html, /<th class="num wide">Active profiles<\/th><th class="num wide">Adoption<\/th><th class="num">Logged tokens<\/th><th class="num wide">Cost at list price<\/th><th class="num wide">Change in profiles<\/th>/);
  const row = (name: string) => html.slice(html.indexOf(`<b>${name}</b>`)).split('</tr>')[0];
  assert.match(row('claude-opus-5-5'), /^<b>claude-opus-5-5<\/b><small>96% via Claude Code<\/small><small class="narrow">30 profiles \(75\.0%\) · <span class="up">\+4<\/span><\/small><\/td>\n<td class="meter" aria-hidden="true"><span style="--share:75\.0%"><\/span><\/td>\n<td class="num wide"><strong>30<\/strong><\/td><td class="num wide"><strong>75\.0%<\/strong><\/td><td class="num"><strong>2\.9k<\/strong><small class="narrow">\$29<\/small><small>2,910<\/small><\/td><td class="num wide"><strong>\$29<\/strong><small>\$29\.10<\/small><\/td><td class="num wide"><strong class="up">\+4<\/strong><small>\+15\.4%<\/small><\/td>$/);
  assert.match(row('gpt-5.5-codex'), /^<b>gpt-5\.5-codex<\/b><small>80% via other tools<\/small>[\s\S]*<strong>\$5<\/strong><small>\$5\.00<\/small><\/td><td class="num wide"><strong class="up">\+2<\/strong><\/td>$/, 'no percentage on a base of ten');
  assert.match(row('gemini-3-pro'), /^<b>gemini-3-pro<\/b><small>100% via Gemini CLI<\/small>[\s\S]*<strong class="up">new<\/strong><\/td>$/);
  assert.deepEqual([...html.matchAll(/<td class="who"><b>([^<]+)<\/b>/g)].map(([, model]) => model), ['claude-opus-5-5', 'gpt-5.5-codex', 'gemini-3-pro']);
  assert.doesNotMatch(html, /kimi-k2|my-model|local-ai|20261101|claude-sonnet|\/u\/| data-place=/, 'no model without a price, no dated name, no unknown provider, no model used only before, no profiles');
  assert.match(html, /only models with a public list price are listed, and a dated name counts as the model it is priced as\. Under each model[\s\S]*share of the 40 published profiles with logged usage in the period\. Change is the difference in active profiles from 2026-10-27 through 2026-11-02\. It comes with a percentage when the model had at least 25 active profiles then\. Cost is at public API list prices, not what anyone paid\./);

  const lifetime = await (await context.call('/rankings/models')).text();
  assert.match(lifetime, /<b>claude-sonnet-5-5<\/b><small>100% via Claude Code<\/small>/);
  assert.doesNotMatch(lifetime, /Change in profiles|Change is the difference|class="(up|down)"/);
  const empty = await (await app().call('/rankings/models?days=30')).text();
  assert.match(empty, /Models by active profiles<\/h2><p class="muted">No priced models<\/p><\/div>\n<p>No logged usage of a model with a list price for this period\.<\/p>/);
});

test('a private profile changes nothing on any board', async () => {
  const db = testDb();
  costFixture(db);
  db.raw.exec("DELETE FROM usage_daily WHERE user_id = '5'");
  const month = rankingPeriod('30', NOW);
  const boards = async () => ({
    tokens: await rankBoard(db, month, { kind: 'public' }),
    cost: await costBoard(db, PRICES, month),
    providers: [await providerBoard(db, WEEK), await providerBoard(db, LIFETIME)],
    models: [await modelBoard(db, PRICES, WEEK), await modelBoard(db, PRICES, LIFETIME)],
  });
  const before = await boards();
  assert.equal(before.cost.position.participants, 5);
  for (const day of ['2026-11-08', '2026-10-30', '2026-10-01']) {
    logged(db, [5], day, 'claude', 'claude-opus-5-5', [1e9, 1e9, 1e9, 1e9]);
    logged(db, [5], day, 'amp', 'gpt-5.5-codex', [1e9, 0, 0, 0]);
    logged(db, [5], day, 'hermes-agent', 'claude-sonnet-5-5', [1e9, 0, 0, 0]);
  }
  db.raw.exec(`INSERT INTO tool_totals VALUES ('5','a','claude','{"scope":"machine","total":900000000000,"asOf":"2026-11-08","daily":{"2026-11-08":5000000}}','2026-11-09')`);
  assert.deepEqual(await boards(), before);
  db.raw.exec("UPDATE users SET is_public = 1 WHERE id = '5'");
  const after = await boards();
  assert.equal(after.cost.users[0].label, 'hidden', 'published, the same usage leads the boards');
  assert.deepEqual([after.providers[0].providers.some((row) => row.tool === 'amp'), after.models[0].models.some((row) => row.model === 'claude-sonnet-5-5')], [true, true]);
});

test('the default board reads the usage once, and only the boards that price read the prices', async () => {
  const db = countingDb();
  const context = app({ db });
  costFixture(db as unknown as TestDb);
  priced(db as unknown as TestDb);
  const reads = async (path: string) => {
    db.sql.length = 0;
    assert.equal((await context.call(path)).status, 200, path);
    return [db.sql.filter((sql) => sql.includes('WITH members')).length, db.sql.filter((sql) => sql.includes('JOIN usage_daily l ON l.user_id = u.id')).length, db.sql.filter((sql) => sql.includes('FROM kv')).length];
  };
  assert.deepEqual(await reads('/rankings'), [1, 0, 0], 'by tokens: one ranking read, no logs, no prices');
  assert.deepEqual(await reads('/rankings?days=7&provider=codex&page=2'), [1, 0, 0]);
  assert.deepEqual(await reads('/rankings?days=7&sort=cost'), [0, 1, 1], 'by cost: one grouped read of the logs, and the prices');
  assert.deepEqual(await reads('/rankings/models?days=7'), [0, 1, 1], 'models and their change come from one read');
  assert.deepEqual(await reads('/rankings/providers?days=7'), [2, 0, 0], 'providers: this period and the one before');
  assert.deepEqual(await reads('/rankings/providers'), [1, 0, 0]);
});

test('the boards share the site’s frame, and say how to join', async () => {
  const context = app();
  costFixture(rawDb(context));
  priced(rawDb(context));
  const paths = ['/rankings?days=month', '/rankings?sort=cost', '/rankings?page=4', '/rankings/providers', '/rankings/providers?days=last-month', '/rankings/models', '/rankings/models?days=7'];
  const titles = new Set<string>();
  for (const path of paths) {
    const response = await context.call(path);
    const text = await response.text();
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/, path);
    assert.doesNotMatch(text, /<script|<link rel="stylesheet"|@import|url\((?!#)|<iframe|\son[a-z]+=/i, `${path} needs only what the policy allows`);
    for (const [, source] of text.matchAll(/<img src="([^"]+)"/g)) assert.match(source, /^(\/(?!\/)|https:\/\/avatars\.githubusercontent\.com\/)/, `${path} loads ${source}`);
    assert.equal(text.match(/<h1[ >]/g)?.length, 1, `${path} has one main heading`);
    assert.match(text, /<meta name="description" content="[^"]{40,}">/, path);
    assert.match(text, /<meta property="og:image" content="https:\/\/stats\.example\/og\.png">/, path);
    assert.equal(text.match(/<nav class="board-tabs" aria-label="Boards">[\s\S]*?<\/nav>/)?.[0].match(/aria-current="page"/g)?.length, 1, `${path} marks its own tab`);
    assert.match(text, /<h2>Appear on the boards<\/h2>\n<p>The boards count published profiles only\.[\s\S]*<pre><code>oms publish<\/code><\/pre>[\s\S]*<a class="button primary" href="\/login">[\s\S]*Sign in with GitHub<\/a><a class="button" href="https:\/\/github\.com\/saintlee83\/oh-my-stats#get-started">Read the guide<\/a>/, `${path} tells a visitor where to start`);
    assert.doesNotMatch(text, /Ranking views|secret-laptop/, path);
    titles.add(text.match(/<title>([^<]+)<\/title>/)![1]);
  }
  assert.deepEqual([...titles], ['Public token rankings · oh-my-stats', 'Provider rankings · oh-my-stats', 'Model rankings · oh-my-stats']);

  const cookie = await webLogin(context);
  const mine = await (await context.call('/rankings/models?days=7', { headers: { cookie } })).text();
  assert.match(mine, /<h2>Your profile is counted<\/h2>\n<p>Your profile is public[\s\S]*<code>oms sync<\/code>/);
  assert.doesNotMatch(mine, /Appear on the boards|href="\/login"/);
  rawDb(context).raw.exec("UPDATE users SET is_public = 0 WHERE id = '1'");
  const hidden = await (await context.call('/rankings/providers?days=7', { headers: { cookie } })).text();
  assert.match(hidden, /<h2>Appear on the boards<\/h2>\n<p>Your profile is private, so it is not counted here\. To publish it, use <a href="\/me">your dashboard<\/a>[\s\S]*<pre><code>oms publish<\/code><\/pre>/);
  assert.doesNotMatch(hidden, /href="\/login"|New here\?/, 'someone signed in is not sent to sign in');
});

test('a board answers 400 to a period, page, order or provider it does not know', async () => {
  const context = app();
  const cookie = await webLogin(context);
  const bad = [
    '/rankings?days=0', '/rankings?days=8', '/rankings?days=week', '/rankings?days=', '/rankings?days=Month',
    '/rankings?page=0', '/rankings?page=-1', '/rankings?page=1.5', '/rankings?page=two', '/rankings?page=01', '/rankings?page=10000',
    '/rankings?sort=price', '/rankings?sort=COST', '/rankings?sort=cost&page=x', '/rankings?sort=cost&provider=Codex',
    '/rankings?provider=%3Cb%3E', '/rankings?provider=codex%20',
    '/rankings/providers?days=0', '/rankings/providers?days=14', '/rankings/models?days=yesterday', '/rankings/models?days=31',
    '/me/rankings?days=2', '/me/rankings?days=this-month',
  ];
  for (const path of bad) {
    const response = await context.call(path, { headers: { cookie } });
    assert.equal(response.status, 400, path);
    assert.match(await response.text(), /<p class="code">400<\/p><h1>Choose /, path);
  }
  for (const path of ['/rankings?page=1', '/rankings?page=', '/rankings?sort=', '/rankings?sort=tokens', '/rankings?provider=', '/rankings/providers?page=x&sort=y', '/rankings/models?provider=%3Cb%3E']) {
    assert.equal((await context.call(path)).status, 200, `${path} asks for nothing unusual of its board`);
  }
  for (const path of ['/rankings/', '/rankings/providers/', '/rankings/profiles', '/rankings/models/claude']) assert.equal((await context.call(path)).status, 404, path);
  for (const path of ['/rankings/providers', '/rankings/models']) assert.equal((await app({ allow: async () => false }).call(path)).status, 429, path);
});

test('the agent API answers exactly as it did before the boards grew', async () => {
  const context = app({}, { 'gh-token': octo, 'web-token': octo, alpha: { id: 2, login: 'alpha', name: 'Alpha <b>' }, beta: { id: 3, login: 'beta' }, hidden: { id: 4, login: 'secret-user' } });
  const a = await signIn(context, MACHINE_A, 'office-laptop');
  const b = await signIn(context, MACHINE_B, 'studio-mac');
  const put = async (token: string, id: string, days: object, totals: object = {}) => {
    assert.equal((await context.call('/v1/usage', api(token, 'PUT', { ...upload(id), days, totals }))).status, 200);
  };
  await put(a, MACHINE_A, {
    '2026-10-12': { 'claude/claude-opus-5-5': [300, 20, 0, 0, 2] },
    '2026-11-02': { 'pi/m': [40, 0, 0, 0, 1] },
    '2026-11-03': { 'codex/m': [11, 0, 0, 0, 1], 'claude/claude-opus-5-5': [1, 0, 0, 0, 1] },
    '2026-11-09': { 'codex/m': [5, 0, 0, 0, 1], 'pi/m': [1, 1, 2, 2, 1], 'claude/claude-opus-5-5': [2, 0, 0, 0, 1] },
  }, {
    codex: { scope: 'account', total: 1000, asOf: '2026-11-08', daily: { '2026-11-03': 70, '2026-11-04': 11 } },
    claude: { scope: 'machine', total: 20, asOf: '2026-11-04', daily: { '2026-11-03': 20 } },
  });
  await put(b, MACHINE_B, { '2026-11-03': { 'codex/m': [7, 0, 0, 0, 1] }, '2026-11-09': { 'codex/m': [4, 0, 0, 0, 1] } },
    { codex: { scope: 'account', total: 500, asOf: '2026-11-05', daily: { '2026-11-03': 55, '2026-11-04': 16 } } });
  await context.call('/v1/me', api(a, 'PATCH', { public: true }));
  for (const [login, tokens] of [['alpha', 123], ['beta', 21], ['hidden', 9999]] as const) {
    const response = await context.call('/v1/auth/token', api(null, 'POST', { githubToken: login, machine: machine(MACHINE_A, login + '-device') }));
    const { token } = await response.json() as { token: string };
    await put(token, MACHINE_A, { '2026-11-09': { 'copilot-cli/m': [tokens, 0, 0, 0, 1] } });
    if (login !== 'hidden') await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  }
  // Recorded from the server as it was before this file existed, for these same uploads.
  const week = '{"period":{"days":7,"start":"2026-11-03","end":"2026-11-09"},"users":[{"rank":1,"label":"alpha","tokens":123},{"rank":1,"label":"octo","tokens":123},{"rank":3,"label":"beta","tokens":21}],"position":{"days":7,"rank":1,"participants":3},"machines":[{"rank":1,"label":"office-laptop","tokens":44},{"rank":2,"label":"studio-mac","tokens":11}],"providers":[{"rank":1,"label":"Codex","tokens":95},{"rank":2,"label":"Claude Code","tokens":22},{"rank":3,"label":"Pi","tokens":6}]}';
  const recorded: Record<string, string> = {
    '': week,
    '?days=7': week,
    '?days=30': '{"period":{"days":30,"start":"2026-10-11","end":"2026-11-09"},"users":[{"rank":1,"label":"octo","tokens":163},{"rank":2,"label":"alpha","tokens":123},{"rank":3,"label":"beta","tokens":21}],"position":{"days":30,"rank":1,"participants":3},"machines":[{"rank":1,"label":"office-laptop","tokens":84},{"rank":2,"label":"studio-mac","tokens":11}],"providers":[{"rank":1,"label":"Codex","tokens":95},{"rank":2,"label":"Pi","tokens":46},{"rank":3,"label":"Claude Code","tokens":22}]}',
    '?days=all': '{"period":{"days":"all","start":null,"end":null},"users":[{"rank":1,"label":"octo","tokens":1378},{"rank":2,"label":"alpha","tokens":123},{"rank":3,"label":"beta","tokens":21}],"position":{"days":"all","rank":1,"participants":3},"machines":[{"rank":1,"label":"office-laptop","tokens":385},{"rank":2,"label":"studio-mac","tokens":11}],"providers":[{"rank":1,"label":"Codex","tokens":1009},{"rank":2,"label":"Claude Code","tokens":323},{"rank":3,"label":"Pi","tokens":46}]}',
  };
  for (const [query, body] of Object.entries(recorded)) {
    const response = await context.call('/v1/rankings' + query, api(a, 'GET'));
    assert.deepEqual([response.status, response.headers.get('content-type'), await response.text()], [200, 'application/json; charset=utf-8', body], `/v1/rankings${query}`);
  }
  // The same profiles on the website, where the names and the new periods are.
  const board = await (await context.call('/rankings?days=all')).text();
  assert.match(board, /<b>Octo Cat<\/b><small>@octo<\/small>[\s\S]*<b>Alpha &lt;b&gt;<\/b><small>@alpha<\/small>[\s\S]*@beta<\/a>/);
  assert.match(board, /Places 1–3<\/h2><p class="muted"><span title="1,522 tokens">1\.5k tokens<\/span> from 3 ranked public profiles<\/p>/);
  assert.doesNotMatch(board, /secret-user|office-laptop|studio-mac|-device/);
});
