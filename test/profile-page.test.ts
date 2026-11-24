import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STYLE } from '../src/server/style.ts';
import { computeTokens } from '../src/shared/tokens.ts';
import type { MachineUsage, UsageTuple } from '../src/shared/types.ts';
import { tokenMix, usageCalendar, usagePeriods } from '../src/shared/usage.ts';
import { api, app, MACHINE_A, mark, octo, ORIGIN, SECRET_NAME, signIn, upload, webLogin, webPost } from './harness.ts';

const TZ = 'Asia/Seoul';

/** One row of input tokens per day, as "tool" -> count, so a day's total is easy to read off. */
const day = (counts: Record<string, number>): Record<string, UsageTuple> =>
  Object.fromEntries(Object.entries(counts).map(([tool, count]) => [`${tool}/m`, [count, 0, 0, 0, 1]]));

const days = (usage: Record<string, Record<string, number>>) => Object.fromEntries(Object.entries(usage).map(([date, counts]) => [date, day(counts)]));

function tokensFor(machine: Omit<MachineUsage, 'id'>, now: string) {
  const tokens = computeTokens([{ id: MACHINE_A, ...machine }], {}, TZ, new Date(now), null);
  assert.ok(tokens);
  return tokens;
}

/** A published profile with these days, and the public and private pages that show it. */
async function pages(usage: Record<string, unknown>) {
  const context = app();
  const token = await signIn(context);
  assert.equal((await context.call('/v1/usage', api(token, 'PUT', { ...upload(MACHINE_A), days: {}, ...usage }))).status, 200);
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  const cookie = await webLogin(context);
  const profile = await (await context.call('/u/octo')).text();
  const dashboard = await (await context.call('/me', { headers: { cookie } })).text();
  return { context, cookie, profile, dashboard };
}

/** The panel that starts at `opening`, up to the next panel. */
function panel(page: string, opening: string): string {
  const start = page.indexOf(opening);
  assert.notEqual(start, -1, `the page has ${opening}`);
  const end = page.indexOf('<section class="panel', start + opening.length);
  return page.slice(start, end === -1 ? undefined : end);
}

test('the private overview charts dated tokens and provider shares for the same window', async () => {
  const { dashboard, profile, context, cookie } = await pages({
    days: days({ '2026-09-12': { pi: 500 }, '2026-10-20': { codex: 200 }, '2026-11-09': { claude: 50 } }),
    totals: { claude: { scope: 'machine', total: 1000, asOf: '2026-09-01' } },
  });
  const windows = [...dashboard.matchAll(/<div class="usage-window" data-window="(\d+)">([\s\S]*?)<\/section><\/div>/g)];
  assert.deepEqual(windows.map(match => Number(match[1])), [7, 30, 60]);
  for (const [index, expected] of [50, 250, 750].entries()) {
    const [, size, body] = windows[index];
    assert.ok(body.includes(`title="${expected} tokens"`));
    assert.equal(count(body, /class="plot-slot"/g), Number(size));
    assert.match(body, /title="2026-11-09 · 50 tokens"/);
  }
  assert.ok(windows[1][2].includes(`<strong>${mark('codex')}Codex</strong><span>80.0%</span>`));
  assert.match(windows[1][2], /-50.0%<\/strong> vs prior 30 days/, 'compares dated tokens across adjacent windows');
  assert.doesNotMatch(windows[0][2], /vs prior 7 days/, 'a missing baseline has no percent change');
  assert.doesNotMatch(windows[1][2], /<strong>Pi<\/strong>/);
  assert.ok(dashboard.includes('title="1,750"'), 'undated usage still counts in lifetime');
  assert.doesNotMatch(profile, /dashboard\.js|me\/report\.svg|usage-window/);
  await context.call('/me/visibility', webPost(cookie, 'public=0'));
  assert.equal((await context.call('/me/report.svg')).headers.get('location'), '/login');
  const report = await context.call('/me/report.svg', { headers: { cookie } });
  assert.equal(report.status, 200);
  assert.equal(report.headers.get('cache-control'), 'no-store');
  assert.match(report.headers.get('content-type') ?? '', /image\/svg\+xml/);
  assert.match(await report.text(), /@octo/);
});

const calendarOf = (page: string) => panel(page, '<section class="panel panes" role="group" aria-label="AI usage calendar">');
const periodsOf = (page: string) => panel(page, '<section class="panel panes" id="periods"');
const panesOf = (section: string) => section.split('<div class="pane">').slice(1);
const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;

test('the newest calendar view is the last 53 weeks, Monday first, through today', () => {
  // A Wednesday in Seoul.
  const tokens = tokensFor({ days: days({ '2026-11-11': { claude: 1600 }, '2026-11-10': { claude: 100 }, '2026-11-02': { claude: 1 } }) }, '2026-11-11T05:00:00Z');
  const [recent] = usageCalendar(tokens);
  assert.deepEqual([recent.key, recent.label, recent.start, recent.end], ['recent', 'Last 12 months', '2025-11-10', '2026-11-11']);
  assert.equal(recent.weeks.length, 53);
  assert.ok(recent.weeks.every((week) => week.days.length === 7));
  assert.equal(recent.weeks[0].days[0]?.date, '2025-11-10', 'the first column starts on a Monday');
  assert.deepEqual(recent.weeks.at(-1)!.days.map((slot) => slot?.date ?? null), ['2026-11-09', '2026-11-10', '2026-11-11', null, null, null, null]);
  assert.equal(recent.weeks.flatMap((week) => week.days).filter(Boolean).length, 52 * 7 + 3);
  assert.deepEqual([recent.total, recent.activeDays], [1701, 3]);

  const level = (date: string) => recent.weeks.flatMap((week) => week.days).find((slot) => slot?.date === date)!.level;
  assert.deepEqual(['2026-11-11', '2026-11-10', '2026-11-02', '2026-11-03'].map(level), [4, 1, 1, 0], 'levels follow the square root, and any usage shows');
});

test('a month is named above its first week, unless the name would run into the next or off the edge', () => {
  const months = (now: string) => {
    const [recent] = usageCalendar(tokensFor({ days: days({ '2026-11-02': { claude: 1 } }) }, now));
    return recent.weeks.map((week) => week.month);
  };
  const named = (labels: (string | null)[]) => labels.filter(Boolean).join(' ');
  // From Monday 2025-11-10: December's first Monday is three columns on, so November keeps its name.
  const wide = months('2026-11-11T05:00:00Z');
  assert.equal(named(wide), 'Nov Dec Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov');
  assert.deepEqual([wide[0], wide[3], wide[51], wide[52]], ['Nov', 'Dec', 'Nov', null]);
  // From Monday 2025-11-17, December is two columns on, and its name would overlap November's.
  const tight = months('2026-11-18T05:00:00Z');
  assert.equal(named(tight), 'Dec Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov');
  assert.deepEqual([tight[0], tight[2]], [null, 'Dec']);
  // December 2026 has its first Monday in the last column, where its name would stick out.
  const edge = months('2026-12-08T05:00:00Z');
  assert.equal(named(edge), 'Dec Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov');
  assert.equal(edge.at(-1), null);
});

test('each calendar year with usage gets its own view, the newest four at most', () => {
  const tokens = tokensFor({ days: days({
    '2021-06-01': { claude: 1 }, '2022-06-01': { claude: 2 }, '2023-06-01': { claude: 3 }, '2024-02-29': { claude: 4 },
    '2025-12-31': { claude: 5 }, '2026-01-01': { claude: 6 }, '2026-11-09': { claude: 7 }, '2026-11-10': { claude: 800 },
  }) }, '2026-11-09T05:00:00Z');
  const views = usageCalendar(tokens);
  assert.deepEqual(views.map((view) => view.key), ['recent', '2026', '2025', '2024', '2023']);

  const drawn = (key: string) => views.find((view) => view.key === key)!.weeks.flatMap((week) => week.days).filter((slot) => slot !== null);
  const [, thisYear, lastYear, leapYear] = views;
  assert.deepEqual([lastYear.start, lastYear.end, lastYear.weeks.length, drawn('2025').length], ['2025-01-01', '2025-12-31', 53, 365]);
  assert.deepEqual(lastYear.weeks[0].days.map((slot) => slot?.date ?? null), [null, null, '2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04', '2025-01-05']);
  assert.deepEqual([lastYear.total, lastYear.activeDays, lastYear.weeks[0].month], [5, 1, 'Jan']);
  assert.deepEqual([leapYear.weeks.length, drawn('2024').length, leapYear.total], [53, 366, 4]);

  // The year in progress stops at today, and keeps the room for the rest of it.
  assert.deepEqual([thisYear.start, thisYear.end, thisYear.weeks.length, drawn('2026').length], ['2026-01-01', '2026-11-09', 53, 313]);
  assert.deepEqual([thisYear.total, thisYear.activeDays], [13, 2], 'a date a machine is already on, ahead of the profile, is left for tomorrow');
  assert.equal(drawn('recent').some((slot) => slot.date > '2026-11-09'), false);
  assert.equal(thisYear.weeks.at(-1)!.month, null);
});

test('a day with usage in the last 12 months opens its providers, and every other day only has a title', async () => {
  const { profile, dashboard } = await pages({ days: days({
    '2026-11-09': { codex: 125, pi: 75 }, '2026-03-04': { claude: 50 }, '2025-11-10': { claude: 40 }, '2025-11-09': { claude: 30 },
  }) });
  for (const page of [profile, dashboard]) {
    const calendar = calendarOf(page);
    const [recent, thisYear, lastYear] = panesOf(calendar);

    // Today is a Monday: 52 whole weeks and one day, three of them with usage.
    assert.equal(count(recent, /<div class="weeks">/g), 1);
    const grid = recent.slice(recent.indexOf('<div class="weeks">'), recent.indexOf('<p class="scale"'));
    assert.equal(count(grid, /class="day"/g), 365);
    assert.equal(count(grid, /<button class="day"/g), 3);
    assert.equal(count(recent, /<section popover(?:="")? class="day-details"/g), 3);
    assert.match(recent, /<button class="day" popover[tT]arget="day-2026-11-09" data-level="4" aria-label="2026-11-09 · 200 tokens" title="2026-11-09 · 200 tokens"><\/button>/);
    assert.match(recent, /<section popover(?:="")? class="day-details" id="day-2026-11-09" aria-label="AI usage on 2026-11-09"><h2>2026-11-09<\/h2><p>200 tokens<\/p><ul><li>Codex · 125<\/li><li>Pi · 75<\/li><\/ul>/);
    assert.match(recent, /popover[tT]arget="day-2025-11-10"[^>]*aria-label="2025-11-10 · 40 tokens"/, 'the first day of the 53 weeks');
    assert.match(recent, /<span class="day" title="2026-11-08 · 0 tokens"><\/span>/, 'a day without usage');
    assert.doesNotMatch(recent, /2025-11-09/, 'the day before the 53 weeks begin');
    assert.match(recent, /2025-11-10 – 2026-11-09 · 290 tokens on 3 days · Select a day for its providers\./);
    assert.match(recent, /<a class="sr" href="#periods">Skip the calendar<\/a>/, 'a keyboard can pass the days that open');

    // The calendar years show the same days, with a title and nothing to open.
    for (const year of [thisYear, lastYear]) assert.doesNotMatch(year, /<button|popover|Select a day|Skip the calendar/);
    assert.match(thisYear, /<span class="day" data-level="4" title="2026-11-09 · 200 tokens"><\/span>/);
    assert.match(thisYear, /2026-01-01 – 2026-11-09 · 250 tokens on 2 days/);
    assert.equal(count(thisYear, /class="day" (data-level="\d" )?title=/g), 313, 'the year in progress stops at today');
    assert.match(lastYear, /<span class="day" data-level="4" title="2025-11-09 · 30 tokens"><\/span>/, 'a day the 53 weeks no longer reach');
    assert.match(lastYear, /<span class="day" data-level="4" title="2025-11-10 · 40 tokens"><\/span>/);
    assert.match(lastYear, /2025-01-01 – 2025-12-31 · 70 tokens on 2 days/);
    assert.equal(count(page, /id="day-2026-11-09"/g), 1, 'an id appears once however many views show the day');
  }
});

test('the calendar switches between the last 12 months and the years with radio inputs the stylesheet pairs with panes', async () => {
  const everyYear = days({ '2021-06-01': { claude: 1 }, '2022-06-01': { claude: 1 }, '2023-06-01': { claude: 1 }, '2024-06-01': { claude: 1 }, '2025-06-01': { claude: 1 }, '2026-06-01': { claude: 1 } });
  const { profile } = await pages({ days: everyYear });
  const calendar = calendarOf(profile);
  // React writes a radio's name after its id, and closes the tag; the server's own pages did neither.
  const radio = (name: string, key: string, checked = false) =>
    `<input type="radio" (?:name="${name}" id="${name}-${key}"|id="${name}-${key}" name="${name}")${checked ? ' checked(?:="")?' : ''}\\/?>`;
  assert.match(calendar, new RegExp(`<section class="panel panes" role="group" aria-label="AI usage calendar">${radio('range', 'recent', true)}${['2026', '2025', '2024', '2023'].map((year) => radio('range', year)).join('')}\\n?<header`));
  assert.deepEqual([...calendar.matchAll(/<label for="range-([^"]+)" data-label="([^"]+)">([^<]+)<\/label>/g)].map((match) => match.slice(1)),
    [['recent', 'Last 12 months', 'Last 12 months'], ['2026', '2026', '2026'], ['2025', '2025', '2025'], ['2024', '2024', '2024'], ['2023', '2023', '2023']]);
  assert.equal(panesOf(calendar).length, 5);
  assert.equal(count(calendar, /<p class="scale" aria-hidden="true"><small>Less<\/small>/g), 5);
  assert.equal(count(periodsOf(profile), /<input type="radio" (?:id="period-[^"]+" )?name="period"/g), 5);
  // Neither panel may hold more panes than the stylesheet has rules for.
  for (const index of [1, 2, 3, 4, 5]) {
    assert.ok(STYLE.includes(`.panes > input:nth-of-type(${index}):checked ~ .pane:nth-of-type(${index})`));
    assert.ok(STYLE.includes(`.panes > input:nth-of-type(${index}):checked ~ .panel-head label:nth-of-type(${index})`));
    assert.ok(STYLE.includes(`.panes > input:nth-of-type(${index}):focus-visible ~ .panel-head label:nth-of-type(${index})`));
  }
  assert.doesNotMatch(profile, /<script/i);
});

const KNOWN: Omit<MachineUsage, 'id'> = {
  days: days({
    '2026-09-30': { codex: 500 },
    '2026-10-01': { codex: 3 }, '2026-10-10': { claude: 1000 }, '2026-10-11': { claude: 20 }, '2026-10-31': { pi: 100 },
    '2026-11-01': { pi: 7 }, '2026-11-02': { codex: 5 }, '2026-11-03': { codex: 40 }, '2026-11-09': { claude: 10 },
    '2026-11-10': { claude: 9999 },
  }),
  // Claude Code's own total: 5,000 tokens from before its logs begin, which have no date.
  totals: { claude: { scope: 'machine', total: 5000, asOf: '2026-09-01' } },
};

test('each period adds up the dated days inside it, and lifetime takes the tools’ own totals', () => {
  const [lifetime, last30, last7, month, lastMonth] = usagePeriods(tokensFor(KNOWN, '2026-11-09T05:00:00Z'));
  assert.deepEqual(lifetime, {
    key: 'all', label: 'Lifetime', range: null, total: 16_684, activeDays: 10,
    top: { tool: 'claude', share: 16_029 / 16_684 }, busiest: { date: '2026-11-10', total: 9999 }, firstDay: '2026-09-30',
  });
  assert.deepEqual(last30, {
    key: '30', label: 'Last 30 days', range: { start: '2026-10-11', end: '2026-11-09', days: 30 }, total: 182, activeDays: 6,
    top: { tool: 'pi', share: 107 / 182 }, busiest: { date: '2026-10-31', total: 100 },
  });
  assert.deepEqual(last7, {
    key: '7', label: 'Last 7 days', range: { start: '2026-11-03', end: '2026-11-09', days: 7 }, total: 50, activeDays: 2,
    top: { tool: 'codex', share: 0.8 }, busiest: { date: '2026-11-03', total: 40 },
  });
  assert.deepEqual(month, {
    key: 'month', label: 'This month', range: { start: '2026-11-01', end: '2026-11-09', days: 9 }, total: 62, activeDays: 4,
    top: { tool: 'codex', share: 45 / 62 }, busiest: { date: '2026-11-03', total: 40 },
  });
  assert.deepEqual(lastMonth, {
    key: 'last-month', label: 'Last month', range: { start: '2026-10-01', end: '2026-10-31', days: 31 }, total: 1123, activeDays: 4,
    top: { tool: 'claude', share: 1020 / 1123 }, busiest: { date: '2026-10-10', total: 1000 },
  });
});

test('periods follow the profile’s date across New Year and a leap day', () => {
  const ranges = (now: string) => usagePeriods(tokensFor({ days: days({ '2026-11-02': { claude: 1 } }) }, now)).map((period) => period.range);
  // Already January 2 in Seoul.
  assert.deepEqual(ranges('2027-01-01T16:00:00Z'), [
    null,
    { start: '2026-12-04', end: '2027-01-02', days: 30 }, { start: '2026-12-27', end: '2027-01-02', days: 7 },
    { start: '2027-01-01', end: '2027-01-02', days: 2 }, { start: '2026-12-01', end: '2026-12-31', days: 31 },
  ]);
  assert.deepEqual(ranges('2028-03-01T05:00:00Z').slice(3), [
    { start: '2028-03-01', end: '2028-03-01', days: 1 }, { start: '2028-02-01', end: '2028-02-29', days: 29 },
  ]);
});

test('the period tiles show each number on the public and the private page', async () => {
  const { profile, dashboard } = await pages(KNOWN);
  const tiles = (pane: string) => [...pane.matchAll(/<div class="figure"><span>([^<]+)<\/span><strong>([^<]*)<\/strong><span>([^<]*)<\/span><\/div>/g)].map((match) => match.slice(1));
  for (const page of [profile, dashboard]) {
    const periods = periodsOf(page);
    assert.deepEqual([...periods.matchAll(/<label for="period-([^"]+)" data-label="[^"]+">([^<]+)<\/label>/g)].map((match) => match.slice(1)),
      [['all', 'Lifetime'], ['30', 'Last 30 days'], ['7', 'Last 7 days'], ['month', 'This month'], ['last-month', 'Last month']]);
    // React writes the name after the id, and `checked=""`.
    assert.match(periods, /<input type="radio" (?:name="period" id="period-all"|id="period-all" name="period") checked(?:="")?\/?>/);
    const [lifetime, last30, last7, month, lastMonth] = panesOf(periods);
    assert.deepEqual(tiles(lifetime), [
      ['Tokens', '16.7k', '16,684'], ['Active days', '10', 'since 2026-09-30'], ['Most used provider', 'Claude Code', '96.1% of tokens'],
      ['Busiest day', '2026-11-10', '10k tokens'],
    ]);
    assert.match(lifetime, /Includes 5k tokens from before a tool’s daily records begin\./);
    assert.deepEqual(tiles(last30), [
      ['Tokens', '182', ''], ['Active days', '6', 'of 30 days'], ['Most used provider', 'Pi', '58.8% of tokens'], ['Busiest day', '2026-10-31', '100 tokens'],
    ]);
    assert.match(last30, /<p class="muted">2026-10-11 – 2026-11-09<\/p>/);
    assert.deepEqual(tiles(last7), [
      ['Tokens', '50', ''], ['Active days', '2', 'of 7 days'], ['Most used provider', 'Codex', '80.0% of tokens'], ['Busiest day', '2026-11-03', '40 tokens'],
    ]);
    assert.deepEqual(tiles(month), [
      ['Tokens', '62', ''], ['Active days', '4', 'of 9 days so far'], ['Most used provider', 'Codex', '72.6% of tokens'], ['Busiest day', '2026-11-03', '40 tokens'],
    ]);
    assert.deepEqual(tiles(lastMonth), [
      ['Tokens', '1.1k', '1,123'], ['Active days', '4', 'of 31 days'], ['Most used provider', 'Claude Code', '90.8% of tokens'], ['Busiest day', '2026-10-10', '1k tokens'],
    ]);
    assert.match(lastMonth, /<p class="muted">2026-10-01 – 2026-10-31<\/p>/);
  }
});

test('usage that is all undated counts for lifetime only', async () => {
  const undated: Omit<MachineUsage, 'id'> = { days: {}, totals: { claude: { scope: 'machine', total: 5000, asOf: '2026-01-01' } } };
  const tokens = tokensFor(undated, '2026-11-09T05:00:00Z');
  const [lifetime, ...others] = usagePeriods(tokens);
  assert.deepEqual([lifetime.total, lifetime.activeDays, lifetime.top, lifetime.busiest, lifetime.firstDay], [5000, 0, { tool: 'claude', share: 1 }, null, null]);
  for (const period of others) assert.deepEqual([period.total, period.activeDays, period.top, period.busiest], [0, 0, null, null], period.label);
  const views = usageCalendar(tokens);
  assert.deepEqual(views.map((view) => [view.key, view.total, view.activeDays, view.weeks.length]), [['recent', 0, 0, 53]]);
  assert.deepEqual(tokenMix(tokens), { known: 0, parts: [
    { key: 'input', label: 'Input', tokens: 0, share: 0 }, { key: 'output', label: 'Output', tokens: 0, share: 0 },
    { key: 'cache-read', label: 'Cache reads', tokens: 0, share: 0 }, { key: 'cache-write', label: 'Cache writes', tokens: 0, share: 0 },
  ] });

  const { profile } = await pages(undated);
  const calendar = panel(profile, '<h2>AI usage calendar</h2>');
  assert.match(calendar, /2025-11-10 – 2026-11-09 · No dated usage\./);
  assert.doesNotMatch(calendar, /<input|<button|popover|class="pane"/, 'one view needs no switch, and no day opens');
  const [first, last30] = panesOf(periodsOf(profile));
  assert.match(first, /<strong>5k<\/strong><span>5,000<\/span>/);
  assert.match(first, /Most used provider<\/span><strong>Claude Code<\/strong><span>100\.0% of tokens/);
  assert.match(first, /Active days<\/span><strong>0<\/strong><span>No dated usage<\/span>.*Busiest day<\/span><strong>—<\/strong><span>No dated usage<\/span>/);
  assert.match(first, /Includes 5k tokens from before a tool’s daily records begin\. They have no date, so the calendar and the other periods leave them out\./);
  assert.match(last30, /Tokens<\/span><strong>0<\/strong>.*Active days<\/span><strong>0<\/strong><span>of 30 days<\/span>.*Most used provider<\/span><strong>—<\/strong><span>No usage/);
  assert.match(profile, /<h2>Token mix<\/h2><p>No tokens with a known breakdown yet\.<\/p>/);
});

test('the token mix splits the tokens with a known breakdown, and says how many those are', async () => {
  const mixed: Omit<MachineUsage, 'id'> = {
    days: { '2026-11-09': { 'claude/m': [100, 50, 800, 50, 3] }, '2026-11-08': { 'codex/m': [600, 400, 0, 0, 2] } },
    // 3,000 more that Codex reports as one number.
    totals: { codex: { scope: 'machine', total: 3000, asOf: '2026-11-01' } },
  };
  const { known, parts } = tokenMix(tokensFor(mixed, '2026-11-09T05:00:00Z'));
  assert.equal(known, 2000);
  assert.deepEqual(parts.map((part) => [part.key, part.tokens, part.share]), [['input', 700, 0.35], ['output', 450, 0.225], ['cache-read', 800, 0.4], ['cache-write', 50, 0.025]]);

  const { profile, dashboard } = await pages(mixed);
  for (const page of [profile, dashboard]) {
    const mix = panel(page, '<section class="panel mix">');
    assert.match(mix, /Covers tokens with a known breakdown: 2k of 5k lifetime tokens\./);
    assert.match(mix, /<div class="mix-bar" role="img" aria-label="Input 35\.0%, Output 22\.5%, Cache reads 40\.0%, Cache writes 2\.5%">/);
    assert.deepEqual([...mix.matchAll(/<span style="flex-grow:([\d.]+);background:var\(--([a-z-]+)\)" title="([^"]+)"><\/span>/g)].map((match) => match.slice(1)),
      [['35.00', 'input', 'Input · 35.0%'], ['22.50', 'output', 'Output · 22.5%'], ['40.00', 'cache-read', 'Cache reads · 40.0%'], ['2.50', 'cache-write', 'Cache writes · 2.5%']]);
    // Each part is named beside its swatch, so the colors are never the only way to tell them apart.
    assert.deepEqual([...mix.matchAll(/<tr><td><i style="background:var\(--([a-z-]+)\)"><\/i>([^<]+)<\/td><td class="num">([^<]+)<\/td><td class="num">([^<]+)<\/td><\/tr>/g)].map((match) => match.slice(1)),
      [['input', 'Input', '35.0%', '700'], ['output', 'Output', '22.5%', '450'], ['cache-read', 'Cache reads', '40.0%', '800'], ['cache-write', 'Cache writes', '2.5%', '50']]);
  }
  for (const name of ['input', 'output', 'cache-read', 'cache-write']) assert.equal(count(STYLE, new RegExp(`--${name}:#[0-9a-f]{6}`, 'g')), 2, `${name} has a color for light and for dark`);
});

test('a part with no tokens keeps its row and draws no segment', async () => {
  const { profile } = await pages({ days: { '2026-11-09': { 'claude/m': [300, 100, 0, 0, 1] } } });
  const mix = panel(profile, '<section class="panel mix">');
  assert.equal(count(mix, /<span style="flex-grow:/g), 2);
  assert.doesNotMatch(mix, /var\(--cache-read\)" title/);
  assert.match(mix, /<\/i>Cache reads<\/td><td class="num">0\.0%<\/td><td class="num">0<\/td>/);
});

test('a profile’s heading says when it joined, and links to its embed code and to sharing it', async () => {
  const named = { ...octo, name: 'Octo <Cat>' };
  const context = app({}, { 'gh-token': named, 'web-token': named });
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  // Looked at in a later month than the account was made in.
  context.setTime('2027-02-03T05:00:00Z');
  const visitor = await (await context.call('/u/octo')).text();
  assert.match(visitor, /<h1>@octo<\/h1><p>Octo &lt;Cat&gt; · Joined Nov 2026<\/p>/);
  assert.match(visitor, /<a class="button" href="https:\/\/github\.com\/octo" rel="noopener">.*GitHub<\/a><a class="button" href="#embed">Embed<\/a><a class="button" href="https:\/\/x\.com\/intent\/post\?[^"]+" rel="noopener" title="Share on X">Share<\/a><\/div>/);
  assert.match(visitor, /<div class="panel" id="embed">\s*<h2>Add this to your GitHub profile<\/h2>/);
  assert.equal(count(visitor, /id="embed"/g), 1);
  const shared = (page: string) => new URL(page.match(/href="(https:\/\/x\.com\/intent\/post\?[^"]+)"/)![1].replaceAll('&amp;', '&')).searchParams;
  assert.deepEqual([...shared(visitor)], [['text', 'octo’s developer stats on oh-my-stats'], ['url', `${ORIGIN}/u/octo`]]);
  assert.doesNotMatch(visitor, /Edit profile/);

  const cookie = await webLogin(context);
  const owner = await (await context.call('/u/octo', { headers: { cookie } })).text();
  assert.match(owner, /<a class="button" href="\/me#profile-header">Edit profile<\/a><a class="button" href="https:\/\/github\.com\/octo"/);
  assert.equal(shared(owner).get('text'), 'My developer stats on oh-my-stats');
});

test('a profile without a name still says when it joined', async () => {
  const context = app({}, { 'gh-token': { id: 1, login: 'octo' }, 'web-token': { id: 1, login: 'octo' } });
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  assert.match(await (await context.call('/u/octo')).text(), /<h1>@octo<\/h1><p>Joined Nov 2026<\/p>/);
});

test('a page draws each mark it shows once, and a made-up provider gets the mark for other tools', async () => {
  const { context, profile, dashboard } = await pages({ days: days({ '2026-11-08': { claude: 30, 'local-ai': 20 }, '2026-11-09': { claude: 50 } }) });
  const drawn = (page: string, id: string) => page.split(`<symbol id="provider-${id}" viewBox="0 0 24 24">`).length - 1;
  for (const [name, page] of Object.entries({ profile, dashboard })) {
    assert.ok(page.split(`${mark('claude')}Claude Code`).length > 2, `${name}: more than one table names the tool`);
    assert.ok(page.includes(`${mark('other')}local-ai`), `${name}: a made-up provider has a mark too`);
    assert.deepEqual([drawn(page, 'claude'), drawn(page, 'other'), drawn(page, 'codex')], [1, 1, 0], `${name}: only the marks it shows, once each`);
    assert.ok(!page.includes('provider-local-ai'), `${name}: an ID from an upload is never part of a reference`);
  }
  assert.ok(dashboard.includes(`<strong>${mark('claude')}Claude Code</strong>`), 'the breakdown on the private overview');
  assert.doesNotMatch(await (await context.call('/privacy')).text(), /<symbol|class="marks"/, 'a page that names no tool draws none');
});

test('the public page shows nothing private, and a private profile shows none of the panels', async () => {
  const { context, cookie, profile, dashboard } = await pages(KNOWN);
  assert.ok(dashboard.includes(SECRET_NAME), 'the owner sees the machine’s name');
  assert.ok(dashboard.includes(MACHINE_A));
  for (const secret of [SECRET_NAME, MACHINE_A, 'Machine name', 'No matching device']) assert.ok(!profile.includes(secret), secret);
  for (const title of ['AI usage calendar', 'Usage by period', 'Token mix', 'Provider share of tokens', 'Provider activity']) {
    assert.ok(profile.includes(`<h2>${title}</h2>`), title);
    assert.ok(dashboard.includes(`<h2>${title}</h2>`), title);
  }
  await context.call('/me/visibility', webPost(cookie, 'public=0'));
  const hidden = await context.call('/u/octo');
  assert.equal(hidden.status, 404);
  assert.doesNotMatch(await hidden.text(), /Usage by period|AI usage calendar|Token mix|popover/);
});
