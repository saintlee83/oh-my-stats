import type { GitHubMetrics } from '../shared/metrics.ts';
import type { TokenBreakdown, TokenTotals, ToolTotals, UsageTuple } from '../shared/types.ts';

/** Validates everything agents send. Model names end up on public pages, so they stay strict. */

export class BadRequest extends Error {}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** No AI tool logged usage before this, so an earlier date can't be real. */
const EARLIEST_DAY = '2020-01-01';
const MAX_MODELS_PER_DAY = 200;
const MAX_TOOLS_PER_UPLOAD = 20;
const TOOL = /^[a-z][a-z0-9_-]{0,31}$/;
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

  return { machine, timezone: isValidTimezone(value.timezone) ? value.timezone : null, days, totals };
}

/**
 * GitHub metrics are the user's own aggregates, drawn into the user's own pages. The
 * renderers escape all text, so this checks shape: a malformed upload must fail here
 * rather than break a public page later.
 */
export function parseGitHubMetrics(value: unknown): GitHubMetrics {
  assert(isObject(value), 'metrics must be an object');
  assert(typeof value.login === 'string', 'metrics.login is missing');
  for (const key of ['counts', 'thisYear', 'monthly', 'scopes', 'rhythm', 'coauthors', 'languageTotals', 'churn', 'pulse', 'coverage']) {
    assert(isObject(value[key]), `metrics.${key} is missing`);
  }
  for (const key of ['months', 'years', 'yearGrid', 'languages']) {
    assert(Array.isArray(value[key]), `metrics.${key} is missing`);
  }
  const rhythm = value.rhythm as Record<string, unknown>;
  assert(Array.isArray(rhythm.punch) && rhythm.punch.length === 7, 'metrics.rhythm.punch is invalid');
  assert(Array.isArray(rhythm.buckets) && rhythm.buckets.length === 4, 'metrics.rhythm.buckets is invalid');
  return value as unknown as GitHubMetrics;
}
