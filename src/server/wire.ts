import type { GitHubMetrics } from '../shared/metrics.ts';
import { cleanGitHubProfile } from '../shared/profile.ts';
import type { TokenBreakdown, TokenTotals, ToolTotals, UsageTuple } from '../shared/types.ts';

/** Validates everything agents send. Model names end up on public pages, so they stay strict. */

export class BadRequest extends Error {}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** No AI tool logged usage before this, so an earlier date can't be real. */
const EARLIEST_DAY = '2020-01-01';
const MAX_MODELS_PER_DAY = 200;
const MAX_TOOLS_PER_UPLOAD = 20;
/** Far beyond any real profile. Pages draw all of this, so it can't grow without limit. */
const MAX_METRICS_ITEMS = 500;
const MAX_METRICS_TEXT = 200;
const MAX_METRICS_DEPTH = 8;
const TOOL = /^[a-z][a-z0-9_-]{0,31}$/;
export const isToolName = (value: string) => TOOL.test(value);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@+\-/]{0,119}$/;
const MACHINE_ID = /^[a-f0-9]{16,64}$/;
const MAX_TOKENS = 1e15;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TOKENS;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BadRequest(message);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export interface MachineInfo {
  id: string;
  name: string;
  platform: string | null;
  agentVersion: string | null;
}

/** Control characters and markup have no place in a machine's name. */
const cleanLabel = (value: string, max: number) =>
  value.replace(/[\u0000-\u001f\u007f<>&"']/g, '').trim().slice(0, max);

export function parseMachine(value: unknown): MachineInfo {
  assert(isObject(value), 'machine must be an object');
  assert(typeof value.id === 'string' && MACHINE_ID.test(value.id), 'machine.id is invalid');
  const name = typeof value.name === 'string' ? cleanLabel(value.name, 64) : '';
  return {
    id: value.id,
    name: name || 'Unnamed machine',
    platform: typeof value.platform === 'string' ? cleanLabel(value.platform, 32) : null,
    agentVersion: typeof value.agentVersion === 'string' ? cleanLabel(value.agentVersion, 32) : null,
  };
}

export function cleanMachineName(value: unknown): string {
  assert(typeof value === 'string', 'name must be text');
  const name = cleanLabel(value, 64);
  assert(name, 'name is empty');
  return name;
}

function parseKey(key: string): void {
  const slash = key.indexOf('/');
  assert(slash > 0, `bad usage key: ${key.slice(0, 40)}`);
  assert(TOOL.test(key.slice(0, slash)), 'bad tool name');
  assert(MODEL.test(key.slice(slash + 1)), 'bad model name');
}

function parseDaily(value: unknown): Record<string, number> {
  assert(isObject(value), 'daily must be an object');
  const out: Record<string, number> = {};
  for (const [date, tokens] of Object.entries(value)) {
    assert(DATE.test(date), 'bad date');
    assert(isCount(tokens), 'bad daily value');
    out[date] = tokens;
  }
  return out;
}

function parseFigure(value: unknown): ToolTotals {
  assert(isObject(value), 'a tool total must be an object');
  assert(value.scope === 'machine' || value.scope === 'account', 'bad scope');
  assert(isCount(value.total), 'bad total');
  assert(value.asOf === null || value.asOf === undefined || (typeof value.asOf === 'string' && DATE.test(value.asOf)), 'bad asOf');
  const figure: ToolTotals = { scope: value.scope, total: value.total, asOf: (value.asOf as string | null | undefined) ?? null };
  if (value.models !== undefined && value.models !== null) {
    assert(isObject(value.models), 'bad models');
    figure.models = {};
    for (const [model, usage] of Object.entries(value.models)) {
      assert(MODEL.test(model), 'bad model name');
      assert(Array.isArray(usage) && usage.length === 4 && usage.every(isCount), 'bad model usage');
      figure.models[model] = usage as TokenBreakdown;
    }
  }
  if (value.daily !== undefined && value.daily !== null) figure.daily = parseDaily(value.daily);
  return figure;
}

export interface UsageUpload {
  machine: MachineInfo;
  timezone: string | null;
  days: Record<string, Record<string, UsageTuple>>;
  totals: TokenTotals;
  /** False when the machine has no GitHub access. Older agents don't say, and can. */
  canCollectGitHub: boolean;
}

/** Rejects dates in the future, allowing for the world's timezones. */
export function parseUsageUpload(value: unknown, now: Date): UsageUpload {
  assert(isObject(value), 'body must be an object');
  const machine = parseMachine(value.machine);
  const latest = new Date(now.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);

  const days: UsageUpload['days'] = {};
  assert(value.days === undefined || isObject(value.days), 'days must be an object');
  const dayEntries = Object.entries((value.days as Record<string, unknown> | undefined) ?? {});
  assert(dayEntries.length <= 400, 'too many days in one upload');
  for (const [date, rows] of dayEntries) {
    assert(DATE.test(date) && date >= EARLIEST_DAY && date <= latest, `bad date: ${date.slice(0, 12)}`);
    assert(isObject(rows), 'a day must be an object');
    assert(Object.keys(rows).length <= MAX_MODELS_PER_DAY, 'too many models in one day');
    const parsed: Record<string, UsageTuple> = {};
    for (const [key, tuple] of Object.entries(rows)) {
      parseKey(key);
      assert(Array.isArray(tuple) && tuple.length === 5 && tuple.every(isCount), 'bad usage row');
      parsed[key] = tuple as UsageTuple;
    }
    days[date] = parsed;
  }

  const totals: TokenTotals = {};
  assert(value.totals === undefined || isObject(value.totals), 'totals must be an object');
  const toolEntries = Object.entries((value.totals as Record<string, unknown> | undefined) ?? {});
  assert(toolEntries.length <= MAX_TOOLS_PER_UPLOAD, 'too many tools in one upload');
  for (const [tool, figure] of toolEntries) {
    assert(TOOL.test(tool), 'bad tool name');
    totals[tool] = parseFigure(figure);
  }

  return { machine, timezone: isValidTimezone(value.timezone) ? value.timezone : null, days, totals, canCollectGitHub: value.canCollectGitHub !== false };
}

function assertBounded(value: unknown, depth = 0): void {
  assert(depth <= MAX_METRICS_DEPTH, 'metrics are nested too deeply');
  if (typeof value === 'string') {
    assert(value.length <= MAX_METRICS_TEXT, 'a metrics label is too long');
  } else if (typeof value === 'object' && value !== null) {
    const items = Object.values(value);
    assert(items.length <= MAX_METRICS_ITEMS, 'metrics hold too many items');
    for (const item of items) assertBounded(item, depth + 1);
  }
}

type Guard<T> = (value: unknown) => value is T;

function fields<T>(checks: { [K in keyof T]: Guard<T[K]> }): Guard<T> {
  return (value): value is T => isObject(value) && Object.entries<Guard<unknown>>(checks)
    .every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
}

function list<T>(check: Guard<T>, length?: number): Guard<T[]> {
  return (value): value is T[] => Array.isArray(value) && (length === undefined || value.length === length) && value.every(check);
}

function nullable<T>(check: Guard<T>): Guard<T | null> {
  return (value): value is T | null => value === null || check(value);
}

function oneOf<const T extends string>(...choices: T[]): Guard<T> {
  return (value): value is T => choices.some((choice) => choice === value);
}

const string: Guard<string> = (v): v is string => typeof v === 'string';
const num: Guard<number> = isCount;
const net: Guard<number> = (v): v is number => typeof v === 'number' && isCount(Math.abs(v));
const index = (size: number): Guard<number> => (v): v is number => num(v) && Number.isInteger(v) && v < size;
const kinds = { commits: num, pulls: num, issues: num, reviews: num };
const changes = { add: num, del: num };
const namedCounts = list(fields({ name: string, count: num }));
const months = list(num, 12);

const githubShape = fields<Omit<GitHubMetrics, 'profile'>>({
  login: string, memberSince: string, commitsLast30: num,
  counts: fields({ ...kinds, merged: num, comments: num, calendar: num, attributed: num }),
  thisYear: fields({ ...kinds, year: num, calendar: num }),
  months: list(string, 12), monthly: fields({ commits: months, pulls: months, issues: months, reviews: months }),
  years: list(fields({ ...kinds, year: num, calendar: num, hidden: num })),
  yearGrid: list(fields({ year: num, months })),
  scopes: fields({ personal: fields(kinds), org: fields(kinds), external: fields(kinds) }),
  rhythm: fields({
    punch: list(list(num, 24), 7), weekdays: list(num, 7), persona: string, total: num,
    peak: nullable(fields({ weekday: index(7), hour: index(24), count: num })),
    buckets: list(fields({ key: oneOf('morning', 'daytime', 'evening', 'night'), label: string, emoji: string, range: string, count: num, share: num }), 4),
  }),
  coauthors: fields({
    rows: list(fields({ label: string, kind: oneOf('ai', 'bot', 'person', 'private'), commits: num, share: num })),
    coauthored: num, solo: num, soloShare: num, privatePeople: num, byKind: fields({ ai: num, bot: num, person: num }),
  }),
  languages: list(fields({ name: string, lines: num, bytes: num, share: num, personal: num, org: num, external: num, gist: num })),
  languageTotals: fields({ personal: num, org: num, external: num, gist: num }),
  churn: fields({
    ...changes, skipped: num, rows: list(fields({ name: string, ...changes, net })), docs: fields(changes),
    bulk: fields({ commits: num, lines: num }), monthly: list(fields({ month: string, ...changes })),
  }),
  pulse: fields({
    streak: num, bestStreak: num, activeDaysYear: num, busiest: nullable(fields({ date: string, count: num })),
    aiCommits: num, aiShare: num, aiAgents: namedCounts, aiShareRecent: num, mergeRate: num, mergeHours: nullable(num),
    reviewHours: nullable(num), kinds: namedCounts, avgCommitSize: nullable(num), stars: num, followers: num, organizations: num,
  }),
  coverage: fields({ reposListed: num, reposWalked: num, reposFailed: num, reposWithCommits: num, churnDone: num, churnPending: num, churnFailed: num, gists: num }),
});

export function parseGitHubMetrics(value: unknown): GitHubMetrics {
  assertBounded(value);
  assert(isObject(value), 'metrics must be an object');
  const profile = cleanGitHubProfile(value.profile);
  assert(githubShape(value), 'GitHub metrics have missing or invalid fields');
  return { ...value, profile };
}
