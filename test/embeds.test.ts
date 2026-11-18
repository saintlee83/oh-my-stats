import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Metrics } from '../src/shared/metrics.ts';
import { BADGE_COLORS, BADGE_METRICS, badgeFor, badgeMetricNamed, renderBadge } from '../src/shared/render/badge.ts';
import { renderSmallCard } from '../src/shared/render/small-card.ts';
import { renderComponent, reviewYear, THEME_NAMES } from '../src/shared/render/svg.ts';
import { computeTokens } from '../src/shared/tokens.ts';
import type { MachineUsage } from '../src/shared/types.ts';
import { githubMetrics } from './fixtures.ts';
import { api, app, countingDb, fakeCache, MACHINE_A, ORIGIN, published, SECRET_NAME, signIn, upload, webLogin, webPost } from './harness.ts';

const SHARED = 'public, max-age=300';

/** A published profile with GitHub stats as well as usage. */
async function publishedWithGitHub(overrides: Parameters<typeof published>[0] = {}) {
  const profile = await published(overrides);
  assert.equal((await profile.context.call('/v1/github', api(profile.token, 'PUT', githubMetrics()))).status, 200);
  return profile;
}

/** Metrics for a profile whose one machine logged these days, as the server would build them. */
function metricsOf(days: MachineUsage['days'], now: string, totals: MachineUsage['totals'] = {}): Metrics {
  return {
    generatedDate: now.slice(0, 10),
    timezone: 'UTC',
    profile: { login: 'octo', name: null, title: null, company: null, location: null, bio: null, status: null, avatar: null },
    github: null,
    tokens: computeTokens([{ id: MACHINE_A, days, totals }], {}, 'UTC', new Date(now), null),
  };
}

/** A day of usage for every date from `from` through `to`. */
function everyDay(from: string, to: string): MachineUsage['days'] {
  const days: MachineUsage['days'] = {};
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${to}T00:00:00Z`); time += 86_400_000) {
    days[new Date(time).toISOString().slice(0, 10)] = { 'claude/claude-opus-5-5': [100, 0, 0, 0, 1] };
  }
  return days;
}

test('a badge shows the figure its metric names, as a locked-down, cacheable image', async () => {
  const { context } = await publishedWithGitHub();
  const expected: Record<string, string> = {
    '': 'AI tokens: 10',
    '?metric=tokens': 'AI tokens: 10',
    '?metric=cost': 'API list price: ≈$10',
    '?metric=rank': 'oh-my-stats rank: #1 of 1',
    '?metric=contributions': 'contributions: 4,671',
    '?metric=streak': 'streak: 3 days',
  };
  for (const [query, name] of Object.entries(expected)) {
    const response = await context.call(`/u/octo/badge.svg${query}`);
    assert.equal(response.status, 200, query);
    assert.match(response.headers.get('content-type') ?? '', /image\/svg\+xml/, query);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/, query);
    assert.equal(response.headers.get('cache-control'), SHARED, query);
    const svg = await response.text();
    assert.match(svg, /^<svg [^>]*height="20" role="img"/, `${query} is as tall as other badges`);
    assert.ok(svg.includes(`aria-label="${name}"`) && svg.includes(`<title>${name}</title>`), `${query} says ${name}`);
    assert.ok(svg.includes(`fill="${BADGE_COLORS.value}"`), query);
  }
  assert.deepEqual(Object.keys(expected).slice(1).map((query) => query.slice(8)), [...BADGE_METRICS], 'every metric is covered');
});

test('a badge without its figure says so, and is not cached until it has one', async () => {
  const cache = fakeCache();
  const context = app({ cache });
  const token = await signIn(context);
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  const badge = async (metric: string) => {
    const response = await context.call(`/u/octo/badge.svg?metric=${metric}`);
    const svg = await response.text();
    return [/aria-label="([^"]+)"/.exec(svg)?.[1], response.headers.get('cache-control'), svg.includes(`fill="${BADGE_COLORS.unknown}"`) ? 'gray' : 'blue'];
  };
  assert.deepEqual(await badge('tokens'), ['AI tokens: n/a', 'no-store', 'gray']);
  assert.deepEqual(await badge('cost'), ['API list price: n/a', 'no-store', 'gray']);
  assert.deepEqual(await badge('rank'), ['oh-my-stats rank: unranked', 'no-store', 'gray']);
  assert.deepEqual(await badge('contributions'), ['contributions: n/a', 'no-store', 'gray']);
  assert.deepEqual(await badge('streak'), ['streak: n/a', 'no-store', 'gray']);
  assert.equal(cache.store.size, 0);

  const days = { '2026-11-08': { 'claude/no-such-price': [1, 2, 3, 4, 5] } };
  await context.call('/v1/usage', api(token, 'PUT', { ...upload(MACHINE_A), days }));
  assert.deepEqual(await badge('tokens'), ['AI tokens: 10', SHARED, 'blue']);
  assert.deepEqual(await badge('rank'), ['oh-my-stats rank: #1 of 1', SHARED, 'blue']);
  assert.deepEqual(await badge('cost'), ['API list price: n/a', 'no-store', 'gray'], 'tokens, but no model with a list price');

  await context.call('/v1/usage', api(token, 'PUT', { ...upload(MACHINE_A), days: { '2026-11-07': { 'claude/claude-opus-5-5': [1, 2, 3, 4, 5] } } }));
  assert.deepEqual(await badge('cost'), ['API list price: ≥$10', SHARED, 'blue'], 'a minimum, as the tokens card words it');

  await context.call('/v1/github', api(token, 'PUT', githubMetrics({ pulse: { ...githubMetrics().pulse, streak: 1 } })));
  assert.deepEqual(await badge('streak'), ['streak: 1 day', SHARED, 'blue']);
  assert.deepEqual(await badge('contributions'), ['contributions: 4,671', SHARED, 'blue']);
});

test('a metric that does not exist is refused before the profile is read, and a private profile looks like a missing one', async () => {
  const db = countingDb();
  const { context, token } = await published({ db, cache: fakeCache() });
  const reads = db.sql.length;
  for (const metric of ['nope', 'tokens2', 'rank,cost', '%3Csvg%3E', '__proto__', 'constructor', 'toString']) {
    const response = await context.call(`/u/octo/badge.svg?metric=${metric}`);
    assert.equal(response.status, 404, metric);
    assert.equal(response.headers.get('cache-control'), 'no-store', metric);
  }
  assert.equal(db.sql.length, reads, 'nothing is read for a metric that cannot exist');
  for (const metric of [null, '', ' Tokens ', 'TOKENS']) assert.equal(badgeMetricNamed(metric), 'tokens', String(metric));
  for (const metric of ['nope', '__proto__', 'tokens cost']) assert.equal(badgeMetricNamed(metric), null, metric);

  const images = ['badge.svg', 'badge.svg?metric=rank', 'card.svg', 'card.svg?graph=1', 'components/year.svg', 'components/year.svg?year=2026'];
  for (const image of images) assert.equal((await context.call(`/u/octo/${image}`)).status, 200, image);
  for (const path of ['/u/octo/Badge.svg', '/u/octo/badge.png', '/u/octo/card.svg/x', '/u/octo/card']) assert.equal((await context.call(path)).status, 404, path);

  await context.call('/v1/me', api(token, 'PATCH', { public: false }));
  for (const image of images) {
    const [hidden, missing] = await Promise.all([context.call(`/u/octo/${image}`), context.call(`/u/nobody/${image}`)]);
    assert.equal(hidden.status, 404, image);
    assert.deepEqual([hidden.status, [...hidden.headers], await hidden.text()], [missing.status, [...missing.headers], await missing.text()], `${image} gives nothing away`);
  }
});

test('badge text is held to the length it was measured at in Verdana, with room on both sides', () => {
  const badges: [string, string][] = [['AI tokens', '115B'], ['API list price', '≥$999.9M'], ['oh-my-stats rank', '#1,204 of 12,345'], ['contributions', '1,234,567'], ['streak', 'n/a']];
  for (const [label, value] of badges) {
    const svg = renderBadge({ label, value, known: true });
    const width = Number(/ width="(\d+)"/.exec(svg)?.[1]);
    const lengths = [...svg.matchAll(/textLength="(\d+)"/g)].map((match) => Number(match[1]));
    assert.equal(lengths.length, 4, 'both texts and their shadows');
    assert.deepEqual([lengths[0], lengths[2]], [lengths[1], lengths[3]], 'a shadow is as long as its text');
    assert.equal(width, lengths[0] + lengths[2] + 24, `${label}: six pixels on each side of each text`);
    // Wider than the narrowest a line of this many characters could be, so never a guess of nothing.
    assert.ok(lengths[0] > label.length * 3 && lengths[2] > value.length * 3, label);
  }
  // A 684, I 421, space 352, t 394, o 607, k 592, e 596, n 633, s 521: 4.8 em at 11px.
  assert.match(renderBadge({ label: 'AI tokens', value: '1', known: true }), /textLength="53"[^>]*>AI tokens</);
  assert.match(renderBadge({ label: 'x', value: '한글', known: true }), /textLength="22"[^>]*>한글</, 'a character without a known width counts as a full em');
  assert.ok(renderBadge({ label: '<b>', value: '"&"', known: false }).includes('aria-label="&lt;b&gt;: &quot;&amp;&quot;"'), 'whatever it is given is escaped');
});

test('badge text is readable on its own boxes, on any page', () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const text = luminance(BADGE_COLORS.text);
  for (const box of ['label', 'value', 'unknown'] as const) {
    const ratio = (text + 0.05) / (luminance(BADGE_COLORS[box]) + 0.05);
    assert.ok(ratio >= 4.5, `${box} is ${ratio.toFixed(2)}:1`);
  }
  assert.ok(!renderBadge(badgeFor('tokens', { tokens: null, github: null, position: null })).includes('prefers-color-scheme'), 'the colors do not follow the page');
});

test('the rank badge reads only the ranking, and the other badges never rank anyone', async () => {
  const db = countingDb();
  const { context } = await publishedWithGitHub({ db });
  let from = db.sql.length;
  assert.equal((await context.call('/u/octo/badge.svg?metric=rank')).status, 200);
  assert.ok(db.sql.slice(from).some((sql) => sql.includes('RANK() OVER')));
  assert.ok(!db.sql.slice(from).some((sql) => sql.includes('github_stats')), 'no stats are loaded for a rank');
  from = db.sql.length;
  assert.equal((await context.call('/u/octo/badge.svg?metric=streak')).status, 200);
  assert.ok(!db.sql.slice(from).some((sql) => sql.includes('RANK() OVER')), 'ranking every profile is left to the badge that shows it');
});

test('the small card shows who it is, lifetime tokens, rank, this year on GitHub and the most used provider', async () => {
  const { context } = await publishedWithGitHub();
  const response = await context.call('/u/octo/card.svg');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /image\/svg\+xml/);
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(response.headers.get('cache-control'), SHARED);
  const svg = await response.text();
  assert.match(svg, /^<svg [^>]*viewBox="0 0 495 [\d.]+" width="495"/);
  const shown = ['>Octo Cat<tspan', '>@octo</tspan>', '>10</text>', '>lifetime AI tokens</text>', '>Rank</text>', '>#1 of 1</text>',
    '>Contributions in 2026</text>', '>3,729</text>', '>Current streak</text>', '>3 days</text>', '>Most used</text>', '>Claude Code</text>'];
  for (const piece of shown) assert.ok(svg.includes(piece), piece);
  assert.ok(svg.includes('--surface:#0d1117;') && !svg.includes('#1a1b26'), 'GitHub colors by default, light and dark');
  assert.ok(!svg.includes('last 26 weeks') && !svg.includes('<pattern'), 'no calendar unless it is asked for');

  const graph = await (await context.call('/u/octo/card.svg?graph=1&theme=tokyo-night')).text();
  assert.ok(graph.includes('>AI tokens per day, last 26 weeks</text>') && graph.includes('<title>2026-11-08 · 10 tokens</title>'));
  assert.ok(graph.includes('fill="var(--h5)"') && graph.includes('--surface:#1a1b26;'), 'in the heat ramp of the theme asked for');
  for (const piece of shown) assert.ok(graph.includes(piece), `${piece}, with the calendar`);
});

test('the small card still reads right with only tokens, only GitHub stats, or neither', async () => {
  const tokensOnly = await published();
  let svg = await (await tokensOnly.context.call('/u/octo/card.svg?graph=1')).text();
  for (const piece of ['>10</text>', '>lifetime AI tokens</text>', '>#1 of 1</text>', '>Active days</text>', '>Claude Code</text>', 'last 26 weeks']) assert.ok(svg.includes(piece), piece);
  assert.ok(!svg.includes('Contributions') && !svg.includes('streak'), 'no line stands empty for GitHub');

  const context = app({ cache: fakeCache() });
  const token = await signIn(context);
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  const empty = await context.call('/u/octo/card.svg');
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('cache-control'), 'no-store', 'so the first upload shows at once');
  svg = await empty.text();
  assert.ok(svg.includes('>No stats yet.</text>') && svg.includes('>Octo Cat<tspan'));

  await context.call('/v1/github', api(token, 'PUT', githubMetrics()));
  const githubOnly = await context.call('/u/octo/card.svg?graph=1');
  assert.equal(githubOnly.headers.get('cache-control'), SHARED);
  svg = await githubOnly.text();
  for (const piece of ['>3,729</text>', '>contributions in 2026</text>', '>Lifetime contributions</text>', '>4,671</text>', '>3 days</text>', '>Best streak</text>', '>9 days</text>']) {
    assert.ok(svg.includes(piece), piece);
  }
  assert.ok(!svg.includes('Rank') && !svg.includes('tokens') && !svg.includes('<pattern'), 'nothing about tokens, and no empty calendar');
});

test('the small card escapes the profile name, and holds a long name and login to its width', async () => {
  const { context } = await published();
  const session = await webLogin(context);
  await context.call('/me/profile', webPost(session, new URLSearchParams({ name: '<script>x</script> & "Cat"' }).toString()));
  for (const query of ['', '?graph=1']) {
    const svg = await (await context.call(`/u/octo/card.svg${query}`)).text();
    assert.ok(!svg.includes('<script>'), query);
    assert.ok(svg.includes('>&lt;script&gt;x&lt;/script&gt; &amp; &quot;Cat&quot;<tspan'), query);
    assert.ok(svg.includes('<title id="omg-title">oh-my-stats: &lt;script&gt;x&lt;/script&gt; &amp; &quot;Cat&quot; (@octo)</title>'), query);
  }

  const login = 'W'.repeat(39);
  const long = app({}, { 'gh-token': { id: 7, login, name: 'M'.repeat(60) } });
  const token = await signIn(long);
  await long.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  await long.call('/v1/me', api(token, 'PATCH', { public: true }));
  const svg = await (await long.call(`/u/${login}/card.svg`)).text();
  const [, length, name, handle] = /<text x="0" y="14" class="h1" textLength="([\d.]+)" lengthAdjust="spacingAndGlyphs">([^<]*)<tspan[^>]*>([^<]*)</.exec(svg) ?? [];
  assert.ok(Number(length) <= 495 - 2 * 24, 'the line is held inside the margins, whatever font draws it');
  assert.ok(name.endsWith('…') && handle.endsWith('…') && handle.startsWith('@WWW'), 'both are cut rather than run off the card');
  assert.ok(svg.includes(`(@${login})</title>`), 'and the whole of both is still in its description');

  const short = renderSmallCard(metricsOf({}, '2026-11-09'), null);
  assert.ok(!short.includes('textLength'), 'a short line is drawn as the font draws it');
});

test('the card’s calendar covers 26 weeks ending today, inside the card', () => {
  const metrics = metricsOf(everyDay('2026-01-01', '2026-11-09'), '2026-11-09T05:00:00Z');
  const svg = renderSmallCard(metrics, { rank: 1204, participants: 12345 }, 'github', true);
  const cells = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="\d+" rx="3" fill="var\(--h\d\)"><title>([\d-]+) /g)];
  // 2026-11-09 is a Monday, so the last of the 26 weeks has one day.
  assert.equal(cells.length, 25 * 7 + 1);
  assert.deepEqual([cells[0][4], cells.at(-1)?.[4]], ['2026-05-18', '2026-11-09']);
  assert.equal(new Set(cells.map(([, x]) => x)).size, 26);
  assert.ok(Math.max(...cells.map(([, x, , width]) => 30 + Number(x) + Number(width))) <= 495 - 2 * 24);
  assert.ok(svg.includes('>#1,204 of 12,345</text>'));
  assert.ok(!svg.includes('omg-ahead'), 'no day of it is still to come');
});

test('the year in review shows this year once it has usage, and the latest year with usage until then', async () => {
  const { context, token } = await published();
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A, '2025-03-01', [5, 5, 5, 5, 2])));
  const review = async (query = '') => {
    const response = await context.call(`/u/octo/components/year.svg${query}`);
    return [/>(\d+) in review<\/text>/.exec(await response.text())?.[1], response.headers.get('cache-control')];
  };
  assert.deepEqual(await review(), ['2026', SHARED]);
  assert.deepEqual(await review('?year=2025'), ['2025', SHARED]);
  assert.deepEqual(await review('?year=2026'), ['2026', SHARED]);
  for (const query of ['?year=2024', '?year=2027', '?year=1999', '?year=2999']) {
    assert.deepEqual(await review(query), ['2026', 'no-store'], `${query} has no usage, so it gets the default and is not kept under its own address`);
  }
  for (const query of ['?year=', '?year=abcd', '?year=20255', '?year=25', '?year=2025.0', '?year=-2025', '?year=0x7E9', '?year=%202025', '?Year=2025']) {
    assert.deepEqual(await review(query), ['2026', SHARED], `${query} is not a year, so it is the default`);
  }

  // The profile is in Seoul, which reaches the new year nine hours before UTC.
  context.setTime('2026-12-31T16:00:00Z');
  assert.deepEqual(await review(), ['2026', SHARED], 'nothing in 2027 yet');
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A, '2027-01-01')));
  assert.deepEqual(await review(), ['2027', SHARED]);
  assert.deepEqual(await review('?year=2026'), ['2026', SHARED], 'a year stays on show by its name');
});

test('the review picks the year asked for only when it has usage', () => {
  const days: MachineUsage['days'] = { '2024-02-29': { 'claude/a': [1, 0, 0, 0, 1] }, '2025-06-01': { 'claude/a': [1, 0, 0, 0, 1] } };
  const metrics = metricsOf(days, '2026-11-09T05:00:00Z');
  assert.equal(reviewYear(metrics), 2025, 'nothing this year: the latest year');
  assert.equal(reviewYear(metrics, 2024), 2024);
  assert.equal(reviewYear(metrics, 2023), 2025);
  assert.equal(reviewYear(metricsOf(days, '2025-01-01T00:00:00Z')), 2025);
  assert.equal(reviewYear(metricsOf(days, '2024-12-31T23:59:59Z')), 2024, 'this year, once it has usage');
  assert.equal(reviewYear({ ...metrics, tokens: null }, 2025), null);
});

test('a year in review counts that year alone: its tokens, models, providers, GitHub numbers and every day', async () => {
  const { context, token } = await publishedWithGitHub();
  const days = {
    '2025-06-01': { 'gemini/gemini-x': [1000, 0, 0, 0, 9] },
    '2026-11-06': { 'claude/claude-opus-5-5': [10, 0, 0, 0, 4], 'codex/gpt-9': [30, 0, 0, 0, 1] },
    '2026-11-07': { 'claude/claude-opus-5-5': [20, 0, 0, 0, 2] },
  };
  await context.call('/v1/usage', api(token, 'PUT', { ...upload(MACHINE_A), days }));
  const response = await context.call('/u/octo/components/year.svg');
  assert.equal(response.headers.get('cache-control'), SHARED);
  const svg = await response.text();
  assert.match(svg, /^<svg [^>]*viewBox="0 0 1000 [\d.]+"/, 'as wide as the dashboard, like every part');
  const shown = [
    '>2026 in review</text>', '>70</text>', '>AI tokens in 2026</text>', '>from 2026-11-06 to 2026-11-08</text>',
    '>Active days</text>', '>Longest streak</text>', '>days in a row</text>', '>Busiest day</text>', '>40</text>', '>on 2026-11-06</text>',
    '>Responses</text>', '>12</text>', '>At API list price</text>', '>≥$40</text>', '>a minimum</text>',
    '>Top models</text>', '>claude-opus-5-5</text>', '>40 · 57%</text>', '>gpt-9</text>', '>30 · 43%</text>',
    '>Providers</text>', '>Claude Code</text>', '>57%</text>', '>Codex</text>', '>43%</text>',
    '>On GitHub in 2026</text>', '>3,729</text>', '>2,382</text>', '>373</text>',
    '>Every day of the year</text>', '>AI tokens per day, through 2026-11-09</text>',
    '<title>2026-11-06 · 40 tokens</title>', '<title>2026-11-07 · 20 tokens</title>', '<title>2026-11-08 · 10 tokens</title>',
  ];
  for (const piece of shown) assert.ok(svg.includes(piece), piece);
  assert.equal(svg.match(/>3<\/text>/g)?.length, 2, 'three active days, all in a row');
  assert.ok(!svg.includes('2025') && !svg.includes('gemini') && !svg.includes('Gemini'), 'nothing of another year');
  assert.ok(svg.includes('id="omg-ahead"'), 'the days still to come are drawn apart from days without usage');
  assert.ok(svg.includes('<desc id="omg-desc">70 AI tokens on 3 days, longest streak 3 days. Busiest day 2026-11-06, 40 tokens.'), 'and it says so in words');

  const last = await (await context.call('/u/octo/components/year.svg?year=2025')).text();
  for (const piece of ['>2025 in review</text>', '>1k</text>', '>on 2025-06-01</text>', '>gemini-x</text>', '>Gemini CLI</text>', '>n/a</text>', '>no known price</text>', '>AI tokens per day</text>']) {
    assert.ok(last.includes(piece), piece);
  }
  assert.ok(!last.includes('On GitHub') && !last.includes('claude') && !last.includes('omg-ahead'), 'no GitHub numbers for a year GitHub has none for, and no day to come');

  const dashboard = await (await context.call('/u/octo/dashboard.svg')).text();
  assert.ok(!dashboard.includes('in review') && !dashboard.includes('Every day of the year'), 'it is a part of its own, not in the dashboard');
});

test('a year’s list price is a minimum when its logs fall short of what the tool counted', () => {
  const prices = { 'gpt-9': { input: 1, output: 1, cacheRead: null, cacheWrite: null } };
  const review = (logged: number) => {
    const machine: MachineUsage = {
      id: MACHINE_A,
      days: { '2026-03-02': { 'codex/gpt-9': [logged, 0, 0, 0, 1] } },
      totals: { codex: { scope: 'account', total: 100, asOf: '2026-03-02', daily: { '2026-03-02': 100 } } },
    };
    const metrics = { ...metricsOf({}, '2026-11-09T05:00:00Z'), tokens: computeTokens([machine], prices, 'UTC', new Date('2026-11-09T05:00:00Z'), null) };
    return renderComponent(metrics, 'year');
  };
  assert.ok(review(40).includes('>≥$40</text>'), 'sixty tokens have no log, so no model and no price');
  assert.ok(review(100).includes('>≈$100</text>'));
});

test('a year of 54 weeks still fits the width of a part, and days to come are told apart', () => {
  // 2040 is a leap year that starts on a Sunday.
  const whole = renderComponent(metricsOf(everyDay('2040-01-01', '2040-12-31'), '2041-02-01T00:00:00Z'), 'year', 'github', 2040);
  const cells = (svg: string) => [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="\d+" rx="3" fill="var\(--h\d\)"><title>/g)];
  assert.equal(cells(whole).length, 366);
  assert.equal(new Set(cells(whole).map(([, x]) => x)).size, 54);
  assert.ok(Math.max(...cells(whole).map(([, x, , width]) => 30 + Number(x) + Number(width))) <= 1000 - 2 * 32);
  assert.ok(whole.includes('>366</text>') && !whole.includes('omg-ahead'));

  const started = renderComponent(metricsOf(everyDay('2027-01-01', '2027-01-02'), '2027-01-02T12:00:00Z'), 'year');
  assert.equal(cells(started).length, 2);
  assert.ok(started.includes('id="omg-ahead"') && started.includes('>Dec</text>'), 'the whole year is laid out from its second day');
  assert.ok(started.length < whole.length / 4, 'days without usage are one shape, so a quiet year is a small image');

  const ahead = renderComponent(metricsOf(everyDay('2026-06-01', '2026-06-12'), '2026-06-10T12:00:00Z'), 'year');
  assert.ok(ahead.includes('>AI tokens per day, through 2026-06-12</text>'), 'a day a machine already reported has happened, whatever the profile’s clock says');
});

test('a year in review without dated usage says so, and is neither cached nor offered', async () => {
  const cache = fakeCache();
  const context = app({ cache });
  const token = await signIn(context);
  const totals = { claude: { scope: 'machine', total: 500, asOf: '2026-11-01' } };
  await context.call('/v1/usage', api(token, 'PUT', { ...upload(MACHINE_A), days: {}, totals }));
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  const empty = await context.call('/u/octo/components/year.svg?year=2026');
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('cache-control'), 'no-store');
  assert.ok((await empty.text()).includes('>No dated AI token usage yet.</text>'));
  assert.equal((await context.call('/u/octo/components/tokens.svg')).headers.get('cache-control'), SHARED, 'the lifetime total is there');
  let page = await (await context.call('/u/octo')).text();
  assert.ok(page.includes('/u/octo/components/tokens.svg') && !page.includes('/components/year.svg'));
  assert.ok(page.includes(`${ORIGIN}/u/octo/card.svg`) && page.includes(`${ORIGIN}/u/octo/badge.svg`), 'the card and the badge are offered beside the parts');

  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  cache.store.clear();
  page = await (await context.call('/u/octo')).text();
  assert.ok(page.includes(`![Year in review](${ORIGIN}/u/octo/components/year.svg)`));
  assert.equal((await context.call('/u/octo/components/year.svg')).headers.get('cache-control'), SHARED);
});

test('each image has one cached copy per choice it offers, however its address is written', async () => {
  const cache = fakeCache();
  const db = countingDb();
  const { context, token } = await published({ db, cache });
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A, '2025-03-01')));
  const groups = [
    ['/u/octo/badge.svg', '/u/OCTO/badge.svg?metric=tokens', '/u/octo/badge.svg?metric=TOKENS&v=2', '/u/octo/badge.svg?metric=', '/u/octo/badge.svg?theme=tokyo-night&label=hi&color=red'],
    ['/u/octo/badge.svg?metric=rank', '/u/octo/badge.svg?x=1&metric=Rank', '/u/octo/badge.svg?metric=rank&metric=cost'],
    ['/u/octo/card.svg', '/u/octo/card.svg?graph=0', '/u/octo/card.svg?graph=true', '/u/Octo/card.svg?theme=github&junk=1', '/u/octo/card.svg?year=2025&metric=rank'],
    ['/u/octo/card.svg?graph=1'],
    ['/u/octo/card.svg?graph=1&theme=tokyo-night', '/u/octo/card.svg?theme=TokyoNight&x=y&graph=1'],
    ['/u/octo/components/year.svg', '/u/octo/components/year.svg?year=abcd', '/u/octo/components/year.svg?year=20261', '/u/octo/components/year.svg?v=3&graph=1'],
    ['/u/octo/components/year.svg?year=2025', '/u/octo/components/year.svg?x=1&year=2025', '/u/OCTO/components/year.svg?year=2025&year=2026'],
    ['/u/octo/components/year.svg?year=2025&theme=tokyo-night', '/u/octo/components/year.svg?theme=tokyonight&year=2025'],
  ];
  for (const [index, [first, ...others]] of groups.entries()) {
    const body = await (await context.call(first)).text();
    const reads = db.sql.length;
    for (const path of others) assert.equal(await (await context.call(path)).text(), body, path);
    assert.equal(db.sql.length, reads, `${first}: other spellings come from its copy`);
    assert.equal(cache.store.size, index + 1, first);
  }
  // A year with no review draws the default one, and leaves no copy of it under its own address.
  assert.equal((await context.call('/u/octo/components/year.svg?year=2024')).status, 200);
  assert.deepEqual([...cache.store.keys()].sort(), [
    'badge.svg', 'badge.svg?metric=rank', 'card.svg', 'card.svg?graph=1', 'card.svg?graph=1&theme=tokyo-night',
    'components/year.svg', 'components/year.svg?theme=tokyo-night&year=2025', 'components/year.svg?year=2025',
  ].map((image) => `${ORIGIN}/u/octo/${image}`));
});

test('making a profile private removes every copy of the badge, the card and each year in review', async () => {
  const cache = fakeCache();
  const { context, token } = await publishedWithGitHub({ cache });
  // The profile is in Seoul, already in the last year a review is kept for: the one after this one in UTC.
  context.setTime('2026-12-31T16:00:00Z');
  const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027];
  const days = Object.fromEntries(years.map((year) => [`${year}-01-01`, { 'claude/claude-opus-5-5': [1, 2, 3, 4, 5] }]));
  assert.equal((await context.call('/v1/usage', api(token, 'PUT', { ...upload(MACHINE_A), days }))).status, 200);
  const paths = [
    ...BADGE_METRICS.map((metric) => `/u/octo/badge.svg?metric=${metric}`),
    ...THEME_NAMES.flatMap((theme) => [`/u/octo/card.svg?theme=${theme}`, `/u/octo/card.svg?theme=${theme}&graph=1`]),
    ...THEME_NAMES.flatMap((theme) => [`/u/octo/components/year.svg?theme=${theme}`, ...years.map((year) => `/u/octo/components/year.svg?theme=${theme}&year=${year}`)]),
  ];
  for (const path of paths) {
    const response = await context.call(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), SHARED, path);
  }
  assert.equal(cache.store.size, paths.length, 'every one of them is a copy of its own');
  await context.call('/v1/me', api(token, 'PATCH', { public: false }));
  assert.deepEqual([...cache.store.keys()], [], 'none is left');
  for (const path of paths) assert.equal((await context.call(path)).status, 404, path);
});

test('a review of a year that could not be removed from the cache later is drawn, but never kept there', async () => {
  const cache = fakeCache();
  const { context, token } = await published({ cache });
  // A tool's own daily figures can carry any date, unlike a logged day.
  const totals = { codex: { scope: 'account', total: 900, asOf: '2026-11-08', daily: { '2019-05-05': 400, '2031-01-01': 500 } } };
  await context.call('/v1/usage', api(token, 'PUT', { ...upload(MACHINE_A), totals }));
  for (const year of [2019, 2031]) {
    const response = await context.call(`/u/octo/components/year.svg?year=${year}`);
    assert.ok((await response.text()).includes(`>${year} in review</text>`), 'it has usage, so it is the year drawn');
    assert.equal(response.headers.get('cache-control'), 'no-store', `${year} is outside the years a review is kept for`);
  }
  assert.equal(cache.store.size, 0);
  assert.equal((await context.call('/u/octo/components/year.svg')).headers.get('cache-control'), SHARED);
  assert.equal((await context.call('/u/octo/components/year.svg?year=2026')).headers.get('cache-control'), SHARED);
  assert.equal(cache.store.size, 2);
});

test('a cache that allows only 50 calls still lets a profile go private, and loses the likeliest copies first', async (t) => {
  const cache = fakeCache();
  let calls = 0;
  const limited = {
    ...cache,
    delete: async (request: Request) => {
      if (++calls > 50) throw new Error('Too many subrequests.');
      return cache.delete(request);
    },
  };
  const { context, token } = await published({ cache: limited });
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A, '2020-06-01')));
  const kept = ['/u/octo', '/u/octo/dashboard.svg', '/u/octo/badge.svg?metric=rank', '/u/octo/card.svg?graph=1&theme=tokyo-night',
    '/u/octo/cards/tokens.txt', '/u/octo/components/tokens.svg', '/u/octo/components/year.svg', '/u/octo/components/year.svg?year=2026'];
  for (const path of [...kept, '/u/octo/components/year.svg?year=2020']) assert.equal((await context.call(path)).headers.get('cache-control'), SHARED, path);
  const logged = t.mock.method(console, 'error', () => {});

  const response = await context.call('/v1/me', api(token, 'PATCH', { public: false }));
  assert.equal(response.status, 200, 'the profile is private already, so a full cache call budget is not an error');
  assert.deepEqual([...cache.store.keys()], [`${ORIGIN}/u/octo/components/year.svg?year=2020`], 'only a review of a long past year is left to expire');
  assert.match(String(logged.mock.calls[0]?.arguments[0]), /profile cache purge incomplete/);
  assert.equal((await context.call('/u/octo/components/year.svg?year=2021')).status, 404, 'and nothing is drawn for it again');
});

test('the badge, the card and the year in review never show machine names or ids', async () => {
  const { context } = await publishedWithGitHub();
  const paths = [
    ...BADGE_METRICS.map((metric) => `/u/octo/badge.svg?metric=${metric}`),
    '/u/octo/card.svg', '/u/octo/card.svg?graph=1', '/u/octo/components/year.svg', '/u/octo/components/year.svg?year=2026&theme=tokyo-night',
  ];
  for (const path of paths) {
    const response = await context.call(path);
    assert.equal(response.status, 200, path);
    const text = await response.text();
    assert.ok(!text.includes(SECRET_NAME), `${path} leaks the machine name`);
    assert.ok(!text.includes(MACHINE_A), `${path} leaks the machine id`);
  }
});
