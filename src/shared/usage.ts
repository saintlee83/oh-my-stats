import type { TokenMetrics } from './metrics.ts';
import { modelTotals, seriesOf, type Series } from './series.ts';
import { lastDays, lastMonths } from './time.ts';

/**
 * The numbers behind the usage panels of a profile: a year of days, totals by period, and
 * how tokens split. "Today" is the profile's own date, the last of its trailing days.
 * Machines may report a date that is still tomorrow there, so nothing here goes past it.
 */

type Day = TokenMetrics['dated'][number];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const todayOf = (tokens: TokenMetrics) => tokens.daily.at(-1)!.date;

const time = (date: string) => new Date(`${date}T00:00:00Z`).getTime();

const addDays = (date: string, count: number) => new Date(time(date) + count * 86_400_000).toISOString().slice(0, 10);

/** Monday = 0 ... Sunday = 6 */
const weekday = (date: string) => (new Date(time(date)).getUTCDay() + 6) % 7;

export interface CalendarDay {
  date: string;
  total: number;
  /** 0 for no usage, then 1 to 4 against the busiest day in view. */
  level: number;
}

export interface CalendarWeek {
  /** The month to name above this week, where one begins and its name has room. */
  month: string | null;
  /** Monday first. A day outside the view is null. */
  days: (CalendarDay | null)[];
}

export interface CalendarView {
  key: string;
  label: string;
  start: string;
  end: string;
  total: number;
  activeDays: number;
  weeks: CalendarWeek[];
}

/** A day as a calendar needs it. */
type Used = Pick<Day, 'date' | 'total'>;

/** The days from `start` through `end` as whole weeks, with room left up to `last`. */
function calendarView(key: string, label: string, start: string, end: string, last: string, usage: Map<string, Used>): CalendarView {
  const used = lastDays(end, (time(end) - time(start)) / 86_400_000 + 1).map((date) => usage.get(date)).filter((day) => day !== undefined);
  // Usage spans orders of magnitude. The square root keeps a light day visible beside the busiest one.
  const peak = Math.max(1, ...used.map((day) => day.total));
  const weeks: CalendarWeek[] = [];
  const opens: { column: number; month: string }[] = [];
  for (let monday = addDays(start, -weekday(start)); monday <= last; monday = addDays(monday, 7)) {
    const days = lastDays(addDays(monday, 6), 7).map((date) => {
      if (date < start || date > end) return null;
      const day = usage.get(date);
      return { date, total: day?.total ?? 0, level: day ? Math.ceil(Math.sqrt(day.total / peak) * 4) : 0 };
    });
    // A month is named above the first week whose top day is in it, so the name sits over its own days.
    const top = days.find((day) => day !== null);
    const month = top && MONTHS[Number(top.date.slice(5, 7)) - 1];
    if (month && month !== opens.at(-1)?.month) opens.push({ column: weeks.length, month });
    weeks.push({ month: null, days });
  }
  // A name is wider than a week. It is left out where the next one would run into it, and at the right edge.
  opens.forEach(({ column, month }, index) => {
    const next = opens[index + 1]?.column ?? Infinity;
    if (next - column >= 3 && column < weeks.length - 1) weeks[column].month = month;
  });
  return { key, label, start, end, total: used.reduce((sum, day) => sum + day.total, 0), activeDays: used.length, weeks };
}

/** The calendar years a profile's calendar offers besides the last 12 months: those with usage, newest first and four at most. */
const calendarYears = (tokens: TokenMetrics, today: string) =>
  tokens.years.map((row) => row.year).filter((year) => year <= Number(today.slice(0, 4))).slice(0, 4);

/** How many of a day's models its details name one by one. The rest are added up. */
export const DAY_MODELS = 5;

/**
 * Every day with usage, small enough to send to the browser, which draws the calendar and the
 * daily chart from it, and what a day says when it is pointed at. Names are sent once, with
 * their colors, and each day refers to them by their place in the list.
 */
export interface DayData {
  /** The profile's date. Nothing is drawn past it. */
  today: string;
  /** The calendar years the calendar offers, newest first. */
  years: number[];
  providers: Series[];
  models: Series[];
  /**
   * Oldest first: a date, its total, then its providers and its models, each as place and
   * tokens in turn, most used first. A day names its largest few models and every model with
   * a color of its own, so a color can be followed from day to day. A place of -1 is the rest.
   */
  days: [date: string, total: number, providers: number[], models: number[]][];
}

/** The calendar's views: the last 53 weeks, then each of the years it offers. The browser builds them from the days it is sent. */
export function usageCalendar({ today, years, days }: DayData): CalendarView[] {
  const usage = new Map(days.map(([date, total]) => [date, { date, total }]));
  const views = [calendarView('recent', 'Last 12 months', addDays(today, -weekday(today) - 52 * 7), today, today, usage)];
  for (const year of years) {
    const last = `${year}-12-31`;
    views.push(calendarView(String(year), String(year), `${year}-01-01`, last < today ? last : today, last, usage));
  }
  return views;
}

const descending = (counts: Record<string, number>) =>
  Object.entries(counts).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

export function dayData(tokens: TokenMetrics): DayData {
  const today = todayOf(tokens);
  const { providers, models } = seriesOf(tokens);
  const providerAt = new Map(providers.map(({ key }, index) => [key, index]));
  const modelAt = new Map(models.map(({ key }, index) => [key, index]));
  const colored = (model: string) => (models[modelAt.get(model) ?? -1]?.slot ?? 0) > 0;
  const days = tokens.dated.map(({ date, total, byTool, byModel }): DayData['days'][number] => {
    const named = descending(byModel);
    const kept = named.filter(([model], index) => index < DAY_MODELS || colored(model));
    const rest = named.reduce((sum, [, count]) => sum + count, 0) - kept.reduce((sum, [, count]) => sum + count, 0);
    return [
      date,
      total,
      descending(byTool).flatMap(([tool, count]) => [providerAt.get(tool) ?? -1, count]),
      [...kept.flatMap(([model, count]) => [modelAt.get(model) ?? -1, count]), ...(rest ? [-1, rest] : [])],
    ];
  });
  return { today, years: calendarYears(tokens, today), providers, models, days };
}

/** One name's part of a whole. */
export interface Share {
  /** A provider's ID, or a model's name. */
  key: string;
  tokens: number;
  /** Of all the tokens in its list. */
  share: number;
}

/** Most used first. A name is whatever an upload says, so the counts come as pairs and not as an object's keys. */
function shares(counts: Iterable<[key: string, count: number]>): Share[] {
  const rows = [...counts].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = rows.reduce((sum, [, count]) => sum + count, 0);
  return rows.map(([key, tokens]) => ({ key, tokens, share: tokens / total }));
}

export interface UsagePeriod {
  key: string;
  label: string;
  /** The dates a period covers. Lifetime has none: it also counts usage with no date. */
  range: { start: string; end: string; days: number } | null;
  total: number;
  activeDays: number;
  top: { tool: string; share: number } | null;
  busiest: { date: string; total: number } | null;
  /** The first day with usage, which only lifetime says. */
  firstDay?: string | null;
  /** Every provider used in the period, most used first. Their tokens add up to `total`. */
  providers: Share[];
  /**
   * Every model named in the period, most used first. Only logged responses name a model, so
   * these add up to `named`, which can fall short of `total`.
   */
  models: Share[];
  named: number;
}

const topOf = ([first]: Share[]): UsagePeriod['top'] => (first ? { tool: first.key, share: first.share } : null);

function summed(days: Day[], modelOnly: TokenMetrics['modelOnly'] = []) {
  const byTool = new Map<string, number>();
  const byModel = new Map<string, number>();
  let total = 0;
  let busiest: UsagePeriod['busiest'] = null;
  for (const day of days) {
    total += day.total;
    if (day.total > (busiest?.total ?? 0)) busiest = { date: day.date, total: day.total };
    for (const [tool, count] of Object.entries(day.byTool)) byTool.set(tool, (byTool.get(tool) ?? 0) + count);
    for (const [model, count] of Object.entries(day.byModel)) byModel.set(model, (byModel.get(model) ?? 0) + count);
  }
  for (const day of modelOnly) {
    for (const [model, count] of Object.entries(day.byModel)) byModel.set(model, (byModel.get(model) ?? 0) + count);
  }
  const models = shares(byModel);
  return { total, busiest, activeDays: days.length, providers: shares(byTool), models, named: models.reduce((sum, row) => sum + row.tokens, 0) };
}

/** The dated days from `start` through `end`, added up. */
export function usageBetween(tokens: TokenMetrics, key: string, label: string, start: string, end: string): UsagePeriod {
  const inside = (day: { date: string }) => day.date >= start && day.date <= end;
  const { total, busiest, activeDays, providers, models, named } = summed(tokens.dated.filter(inside), tokens.modelOnly.filter(inside));
  return { key, label, range: { start, end, days: (time(end) - time(start)) / 86_400_000 + 1 }, total, activeDays, top: topOf(providers), busiest, providers, models, named };
}

/** The trailing `size` days, through the profile's date. */
export function usageWindow(tokens: TokenMetrics, size: number): UsagePeriod {
  const today = todayOf(tokens);
  return usageBetween(tokens, String(size), `Last ${size} days`, addDays(today, 1 - size), today);
}

/**
 * Lifetime, then four stretches ending today. Lifetime takes each tool's own total, which
 * includes usage from before its daily records begin. The others can only add up dated days.
 */
export function usagePeriods(tokens: TokenMetrics): UsagePeriod[] {
  const today = todayOf(tokens);
  const [lastMonth, month] = lastMonths(today.slice(0, 7), 2);
  const between = (key: string, label: string, start: string, end: string) => usageBetween(tokens, key, label, start, end);
  const all = summed(tokens.dated);
  // Lifetime takes each tool's and each model's own total, which reach back before their dated days.
  const providers = shares(tokens.tools.map((row) => [row.tool, row.total]));
  const models = shares(modelTotals(tokens));
  return [
    {
      key: 'all', label: 'Lifetime', range: null, total: tokens.total, activeDays: all.activeDays,
      top: topOf(providers), busiest: all.busiest, firstDay: tokens.dated[0]?.date ?? null,
      providers, models, named: models.reduce((sum, row) => sum + row.tokens, 0),
    },
    between('30', 'Last 30 days', addDays(today, -29), today),
    between('7', 'Last 7 days', addDays(today, -6), today),
    between('month', 'This month', `${month}-01`, today),
    between('last-month', 'Last month', `${lastMonth}-01`, addDays(`${month}-01`, -1)),
  ];
}

/** How the tokens with a known breakdown split. Totals a tool reports without one are not in `known`. */
export function tokenMix(tokens: TokenMetrics) {
  const counts = [
    ['input', 'Input', tokens.input], ['output', 'Output', tokens.output],
    ['cache-read', 'Cache reads', tokens.cacheRead], ['cache-write', 'Cache writes', tokens.cacheWrite],
  ] as const;
  const known = counts.reduce((sum, [, , count]) => sum + count, 0);
  return { known, parts: counts.map(([key, label, count]) => ({ key, label, tokens: count, share: known ? count / known : 0 })) };
}
