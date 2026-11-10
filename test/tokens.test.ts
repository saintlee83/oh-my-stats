import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCards, CARD_LINES, CARD_WIDTH, cardContent } from '../src/shared/render/cards.ts';
import { renderDashboard } from '../src/shared/render/svg.ts';
import { computeTokens } from '../src/shared/tokens.ts';
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
