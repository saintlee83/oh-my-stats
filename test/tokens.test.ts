import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCards, CARD_LINES, CARD_WIDTH, cardContent } from '../src/shared/render/cards.ts';
import { renderDashboard } from '../src/shared/render/svg.ts';
import { computeTokens } from '../src/shared/tokens.ts';
import { monthlyRecap, providerMix, weeklyUsage } from '../src/shared/insights.ts';
import { usageBetween, usageWindow } from '../src/shared/usage.ts';
import type { MachineUsage, PriceTable, ToolTotals } from '../src/shared/types.ts';
import { displayWidth } from '../src/shared/format.ts';
import { githubMetrics } from './fixtures.ts';

const NOW = new Date('2026-11-09T05:00:00Z');
const TZ = 'Asia/Seoul';
const PRICES: PriceTable = {
  'claude-opus-5-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  'gpt-6-astra': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};

const compute = (machines: MachineUsage[], commits: number | null = null) => {
  const tokens = computeTokens(machines, PRICES, TZ, NOW, commits);
  assert.ok(tokens);
  return tokens;
};
const tool = (tokens: NonNullable<ReturnType<typeof computeTokens>>, name: string) => tokens.tools.find((row) => row.tool === name)!;

const laptop = (): MachineUsage => ({
  id: 'a'.repeat(16),
  days: {
    '2026-10-20': { 'claude/claude-opus-5-5': [1, 1, 8, 0, 3], 'codex/gpt-6-astra': [2, 2, 6, 0, 4] },
    '2026-11-09': { 'claude/claude-opus-5-5': [5, 0, 0, 0, 1], 'codex/gpt-6-astra': [7, 0, 0, 0, 1] },
  },
  totals: {
    claude: { scope: 'machine', total: 1000, asOf: '2026-11-08', models: { 'claude-opus-5-5': [100, 100, 800, 0] }, daily: { '2026-10-20': 600 } },
    codex: { scope: 'account', total: 500, asOf: '2026-11-08', daily: { '2026-10-20': 400, '2026-08-01': 100 } },
  },
});

const desktop = (): MachineUsage => ({
  id: 'b'.repeat(16),
  days: {
    '2026-10-20': { 'codex/gpt-6-astra': [1, 1, 8, 0, 2] },
    '2026-11-09': { 'claude/claude-opus-5-5': [3, 0, 0, 0, 1], 'codex/gpt-6-astra': [4, 0, 0, 0, 1] },
  },
  totals: {
    claude: { scope: 'machine', total: 200, asOf: '2026-11-08', models: { 'claude-opus-5-5': [10, 10, 180, 0] }, daily: { '2026-10-20': 150 } },
    // Same Codex account, reporting the same number from another machine.
    codex: { scope: 'account', total: 500, asOf: '2026-11-08', daily: { '2026-10-20': 400, '2026-08-01': 100 } },
  },
});

test('per-machine figures add up across machines', () => {
  const tokens = compute([laptop(), desktop()]);
  assert.equal(tool(tokens, 'claude').total, 1208, '1000 + 200, plus 8 logged since');
  assert.equal(tool(tokens, 'claude').scope, 'machine');
  assert.equal(tool(tokens, 'claude').machines, 2);
  assert.equal(tokens.models.find((row) => row.model === 'claude-opus-5-5')?.total, 1208);
});

test('an account figure counts once, however many machines report it', () => {
  const tokens = compute([laptop(), desktop()]);
  assert.equal(tool(tokens, 'codex').total, 511, '500 once, plus 11 logged since on both machines');
  assert.equal(tool(tokens, 'codex').scope, 'account');
  assert.equal(tokens.monthly.find((row) => row.month === '2026-08')?.byTool.codex, 100, 'daily figures are not doubled');
  assert.equal(tokens.total, 1719);
});

test('a machine that lags behind cannot lower an account figure', () => {
  const behind = desktop();
  behind.totals!.codex = { scope: 'account', total: 300, asOf: '2026-10-01', daily: { '2026-08-01': 90 } };
  const tokens = compute([laptop(), behind]);
  assert.equal(tool(tokens, 'codex').total, 511);
  assert.equal(tokens.monthly.find((row) => row.month === '2026-08')?.byTool.codex, 100);
});

test('model split comes from logs on every machine, and the rest has no known model', () => {
  const tokens = compute([laptop(), desktop()]);
  assert.equal(tokens.models.find((row) => row.model === 'gpt-6-astra')?.total, 31, '10 + 7 + 10 + 4');
  assert.equal(tool(tokens, 'codex').unattributed, 480);
  assert.equal(tokens.unattributed, 480);
  assert.equal(tool(tokens, 'claude').unattributed, 0);
});

test('a machine without a figure still counts through its logs', () => {
  const logsOnly: MachineUsage = { id: 'c'.repeat(16), days: { '2026-11-01': { 'claude/claude-opus-5-5': [10, 10, 0, 0, 1] } } };
  const tokens = compute([laptop(), logsOnly]);
  assert.equal(tool(tokens, 'claude').total, 1025, '1005 from the figure machine, 20 from logs');
  assert.equal(tool(tokens, 'claude').machines, 2);
});

test('tokens per machine add up for the owner view', () => {
  const tokens = compute([laptop(), desktop()]);
  const ids = tokens.machines.map((row) => row.id);
  assert.deepEqual(ids.sort(), ['a'.repeat(16), 'b'.repeat(16)]);
  assert.equal(tokens.machines.find((row) => row.id === 'a'.repeat(16))?.total, 1022, 'its Claude figure, its Codex logs');
});

test('months and undated usage add up to the total', () => {
  const tokens = compute([laptop(), desktop()]);
  const months = tokens.monthly.reduce((sum, row) => sum + row.total, 0);
  assert.equal(months + tokens.undated, tokens.total);
  assert.deepEqual(tokens.monthly.find((row) => row.month === '2026-10')?.byTool, { claude: 750, codex: 400 });
});

test('cost covers what is known, and an account total adds no invented cost', () => {
  const tokens = compute([laptop(), desktop()]);
  assert.equal(tokens.cost, 228 + 17, 'tokens with a known model and price only');
  assert.deepEqual(tokens.unpricedModels, []);
});

test('with logs alone, machines simply add up', () => {
  const machine = (id: string): MachineUsage => ({ id, days: { '2026-11-01': { 'claude/claude-opus-5-5': [1, 2, 3, 4, 1] } } });
  const tokens = compute([machine('a'.repeat(16)), machine('b'.repeat(16))]);
  assert.equal(tokens.total, 20);
  assert.equal(tool(tokens, 'claude').scope, 'logs');
  assert.equal(tokens.undated, 0);
});

test('no data at all means no token metrics', () => {
  assert.equal(computeTokens([], PRICES, TZ, NOW, null), null);
  assert.equal(computeTokens([{ id: 'a'.repeat(16), days: {} }], PRICES, TZ, NOW, null), null);
});

test('weekly change and calendar-month comparisons follow the profile date across New Year', () => {
  // Already Jan 2 in Seoul. The uploaded Jan 3 row must not influence month-to-date shares.
  const data: MachineUsage = { id: 'mac', days: {
    '2026-12-20': { 'pi/m': [100, 0, 0, 0, 1] },
    '2026-12-31': { 'pi/m': [50, 0, 0, 0, 1] },
    '2027-01-01': { 'pi/m': [20, 0, 0, 0, 1] },
    '2027-01-02': { 'codex/m': [80, 0, 0, 0, 1] },
    '2027-01-03': { 'codex/m': [1000, 0, 0, 0, 1] },
  } };
  const tokens = computeTokens([data], {}, TZ, new Date('2027-01-01T16:00:00Z'), null)!;
  const week = weeklyUsage(tokens);
  assert.deepEqual([week.total, week.previous, week.changePercent, week.topIncrease], [150, 100, 50, { tool: 'codex', tokens: 80 }]);
  assert.deepEqual(week.days.map(d => d.total), [0, 0, 0, 0, 50, 20, 80]);
  assert.deepEqual(providerMix(tokens), { previousMonth: '2026-12', today: '2027-01-02', rows: [
    { tool: 'codex', now: 80, previous: 0, share: 0.8, priorShare: 0 },
    { tool: 'pi', now: 20, previous: 150, share: 0.2, priorShare: 1 },
  ] });
  const metrics = { ...metricsFor([]), generatedDate: '2027-01-02', tokens };
  assert.deepEqual(monthlyRecap(metrics), { month: '2026-12', tokens: 150, commits: 5, pulls: 1, reviews: 0 });
  assert.equal(monthlyRecap({ ...metrics, github: null }).commits, null);
});

test('every day with usage is kept, and each year is summed up on its own', () => {
  const days = (dates: string[], tuple: number[]) => Object.fromEntries(dates.map((date) => [date, { 'claude/claude-opus-5-5': tuple }]));
  const tokens = compute([{
    id: 'a'.repeat(16),
    days: {
      ...days(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-03-10'], [1, 1, 8, 0, 2]),
      '2026-03-11': { 'claude/claude-opus-5-5': [2, 2, 16, 0, 3], 'codex/gpt-6-astra': [5, 0, 0, 0, 1], 'local-ai/unpriced': [70, 0, 0, 0, 1] },
    },
    // Dated by the tool itself, with no log behind it: it counts toward the year, but names no model.
    totals: { gemini: { scope: 'machine', total: 300, asOf: '2024-05-02', daily: { '2024-05-01': 100, '2024-05-02': 200, '2024-05-03': 0 } } },
  }]);
  assert.deepEqual(tokens.dated.map((day) => [day.date, day.total]), [
    ['2024-05-01', 100], ['2024-05-02', 200], ['2025-12-30', 10], ['2025-12-31', 10],
    ['2026-01-01', 10], ['2026-01-02', 10], ['2026-01-03', 10], ['2026-03-10', 10], ['2026-03-11', 95],
  ], 'days without usage are left out');
  assert.deepEqual(tokens.dated.at(-1)?.byTool, { claude: 20, codex: 5, 'local-ai': 70 });
  assert.equal(tokens.dated.reduce((sum, day) => sum + day.total, 0), tokens.monthly.reduce((sum, month) => sum + month.total, 0));

  assert.deepEqual(tokens.years.map((row) => row.year), [2026, 2025, 2024], 'newest first');
  const [y2026, y2025, y2024] = tokens.years;
  assert.deepEqual([y2026.total, y2026.activeDays, y2026.bestStreak, y2026.messages], [135, 5, 3, 13]);
  assert.deepEqual(y2026.peak, { date: '2026-03-11', total: 95 });
  assert.deepEqual(y2026.byTool, { claude: 60, codex: 5, 'local-ai': 70 });
  assert.deepEqual(y2026.models, [
    { tool: 'local-ai', model: 'unpriced', total: 70 }, { tool: 'claude', model: 'claude-opus-5-5', total: 60 }, { tool: 'codex', model: 'gpt-6-astra', total: 5 },
  ]);
  assert.equal(y2026.cost, 12 + 5, 'input and output of the priced models; the unpriced one adds nothing');
  assert.deepEqual([y2025.total, y2025.activeDays, y2025.bestStreak], [20, 2, 2], 'a run across New Year is cut at the year');
  assert.deepEqual([y2024.total, y2024.activeDays, y2024.bestStreak, y2024.messages, y2024.models.length, y2024.cost], [300, 2, 2, 0, 0, 0]);
});

test('each day names the models its logs name, and a model reached through two tools counts once', () => {
  const tokens = compute([laptop(), desktop()]);
  const day = (date: string) => tokens.dated.find((row) => row.date === date)!;
  // October 20 is counted by the tools themselves: 600 and 150 by Claude Code on two machines, 400 by Codex.
  // Its models come from the logs, which hold less.
  assert.deepEqual([day('2026-10-20').total, day('2026-10-20').byTool], [1150, { claude: 750, codex: 400 }]);
  assert.deepEqual(day('2026-10-20').byModel, { 'claude-opus-5-5': 10, 'gpt-6-astra': 20 });
  assert.deepEqual(day('2026-11-09').byModel, { 'claude-opus-5-5': 8, 'gpt-6-astra': 11 }, 'both machines’ logs together');
  assert.deepEqual(day('2026-08-01').byModel, {}, 'a day only a tool’s own figure covers names no model');
  assert.deepEqual(tokens.daily.at(-1), { date: '2026-11-09', total: 19, byTool: { claude: 8, codex: 11 }, byModel: { 'claude-opus-5-5': 8, 'gpt-6-astra': 11 } });

  // A name from an upload may be one that every object has. It is counted like any other.
  const odd = compute([{ id: 'c'.repeat(16), days: { '2026-11-09': { 'claude/constructor': [1, 0, 0, 0, 1], 'amp/constructor': [2, 0, 0, 0, 1], 'amp/toString': [4, 0, 0, 0, 1] } } }]);
  assert.deepEqual(Object.entries(odd.dated[0].byModel), [['constructor', 3], ['toString', 4]]);
});

test('a logged response keeps its model when the tool’s own figures put its tokens on the day before', () => {
  // Claude counted 1,000 tokens on the 8th, through the 9th. Its log dates 100 of them on the 9th.
  const tokens = compute([{
    id: 'a'.repeat(16),
    days: { '2026-11-09': { 'claude/claude-opus-5-5': [100, 0, 0, 0, 1] } },
    totals: { claude: { scope: 'machine', total: 1000, asOf: '2026-11-09', daily: { '2026-11-08': 1000 } } },
  }]);
  assert.deepEqual(tokens.dated.map((day) => [day.date, day.total, day.byModel]), [['2026-11-08', 1000, {}]], 'the figure wins, so the 9th has no usage of its own');
  assert.deepEqual(tokens.modelOnly, [{ date: '2026-11-09', byModel: { 'claude-opus-5-5': 100 } }]);

  const week = usageWindow(tokens, 7);
  assert.deepEqual([week.total, week.activeDays, week.named], [1000, 1, 100], 'the period’s tokens and days are the figure’s');
  assert.deepEqual(week.models, [{ key: 'claude-opus-5-5', tokens: 100, share: 1 }], 'and its logged response still names its model');
  assert.deepEqual(usageBetween(tokens, 'before', 'Before', '2026-11-01', '2026-11-08').models, [], 'only in a period that holds the log’s date');
  // A day with usage keeps its models on the day itself, and is not listed twice.
  assert.deepEqual(compute([laptop()]).modelOnly, []);
});

test('undated account totals do not invent weekly growth or monthly activity', () => {
  const tokens = compute([{ id: 'one', days: {}, totals: { codex: { scope: 'account', total: 12345, asOf: null } } }]);
  assert.equal(weeklyUsage(tokens).changePercent, null);
  assert.equal(weeklyUsage(tokens).topIncrease, null);
  assert.deepEqual(providerMix(tokens).rows, []);
  assert.equal(monthlyRecap({ ...metricsFor([]), tokens }).tokens, null);
  assert.deepEqual(tokens.unassigned, { total: 12345, last30: 0, last7: 0 });
});

test('uncached tokens per commit use the last 30 days of logs', () => {
  assert.equal(compute([laptop()], 5).last30.perCommit, (2 + 4 + 5 + 7) / 5);
  assert.equal(compute([laptop()], 0).last30.perCommit, null);
});

const metricsFor = (machines: MachineUsage[], github = githubMetrics()) => ({
  generatedDate: '2026-11-09',
  timezone: TZ,
  profile: { login: 'octo', name: null, title: null, company: null, location: null, bio: null, status: null, avatar: null },
  github,
  tokens: computeTokens(machines, PRICES, TZ, NOW, github.commitsLast30),
});

test('every card fits the pinned preview, at any scale', () => {
  const huge: ToolTotals = { scope: 'machine', total: 40_660_000_000_000, asOf: null, models: { 'claude-opus-5-5-with-a-long-suffix': [1e12, 1e12, 3e13, 1e12] } };
  const cards = buildCards(metricsFor([{ id: 'a'.repeat(16), days: {}, totals: { claude: huge, codex: { scope: 'account', total: 26_310_000_000_000, asOf: null } } }]));
  assert.equal(cards.length, 7);
  for (const card of cards) {
    assert.ok(card.hero.length <= CARD_LINES, card.key);
    for (const line of card.hero) assert.ok(displayWidth(line) <= CARD_WIDTH, `${card.key}: ${line}`);
    assert.ok(card.title.length <= 60, card.title);
  }
});

test('cards and the dashboard state how far each number reaches', () => {
  const metrics = metricsFor([laptop(), desktop()]);
  const tokensCard = buildCards(metrics).find((card) => card.key === 'tokens')!;
  const text = cardContent(tokensCard, '2026-11-09');
  assert.match(text, /its own statistics, 2 machines/);
  assert.match(text, /your account, every device/);
  assert.match(text, /Model unknown/);
  const svg = renderDashboard(metrics);
  assert.ok(svg.includes('Claude Code on 2 machines, Codex across the account'));
  assert.ok(!/NaN|undefined|Infinity/.test(svg));
});

test('the headline is this year, with lifetime beneath it', () => {
  const svg = renderDashboard(metricsFor([]));
  assert.ok(svg.includes('>3,729</text>'));
  assert.ok(svg.includes('contributions in 2026'));
  assert.ok(svg.includes('4,671 lifetime contributions'));
  const [card] = buildCards(metricsFor([]));
  assert.equal(card.title, '⚡ Contributions: 3.7k in 2026 · 4.7k lifetime');
});

test('text from an upload is escaped in the dashboard', () => {
  const github = githubMetrics({ languages: [{ name: 'A<script>&"', lines: 5, bytes: 1, share: 1, personal: 5, org: 0, external: 0, gist: 0 }] });
  const svg = renderDashboard(metricsFor([], github));
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('A&lt;script&gt;&amp;&quot;'));
});

test('provider activity compares disjoint weeks and averages only logged responses', () => {
  const sample: MachineUsage = {
    id: 'one',
    days: {
      '2026-11-09': { 'gemini/gemini-flash': [20, 1, 4, 0, 1] },
      '2026-11-03': { 'gemini/gemini-flash': [10, 0, 0, 0, 1] },
      '2026-11-02': { 'gemini/gemini-flash': [1, 1, 0, 0, 1] },
      '2026-10-27': { 'gemini/gemini-flash': [3, 0, 0, 0, 1] },
      '2026-10-10': { 'gemini/gemini-flash': [100, 0, 0, 0, 1] },
    },
    totals: { codex: { scope: 'account', total: 50, asOf: '2026-11-09', daily: { '2026-11-09': 50 } } },
  };
  const metrics = computeTokens([sample], { 'gemini/gemini-flash': PRICES['gpt-6-astra'] }, TZ, NOW, null)!;
  assert.deepEqual(tool(metrics, 'gemini').activity, { last7: 35, previous7: 5, activeDays30: 4, responses30: 4, tokensPerResponse30: 10 });
  assert.equal(tool(metrics, 'gemini').cost, 136);
  assert.equal(tool(metrics, 'codex').activity.tokensPerResponse30, null);
  assert.equal(tool(metrics, 'codex').activity.last7, 50);
  const other: MachineUsage = { id: 'two', days: { '2026-11-09': {
    'local/one': [1, 0, 0, 0, 1], 'second/two': [2, 0, 0, 0, 1], 'third/three': [3, 0, 0, 0, 1],
  } } };
  const rendered = metricsFor([sample, other]);
  assert.match(renderDashboard(rendered), /Others/);
  assert.match(buildCards(rendered).find(c => c.key === 'tokens')!.details.join('\n'), /PROVIDER ACTIVITY[\s\S]*Gemini CLI/);
});

test('device periods use local Codex logs and each machine’s own Claude daily figures', () => {
  const a = laptop();
  a.days['2026-10-01'] = { 'pi/local': [50, 0, 0, 0, 1] };
  a.days['2026-11-10'] = { 'pi/local': [9, 0, 0, 0, 1] };
  const b = desktop();
  // A machine-wide lifetime figure without a model split still belongs to it.
  b.totals!.claude = { scope: 'machine', asOf: '2026-11-08', total: 200, daily: { '2026-10-20': 150 } };
  const metrics = compute([a, b]);
  assert.deepEqual(metrics.machines, [
    { id: a.id, total: 1081, last7: 12, last30: 622 },
    { id: b.id, total: 217, last7: 7, last30: 167 },
  ]);
  assert.equal(metrics.total - metrics.machines.reduce((s, row) => s + row.total, 0), 480);
});
