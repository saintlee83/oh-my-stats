import type { TokenMetrics } from './metrics.ts';
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
  byTool: Record<string, number>;
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

/** The days from `start` through `end` as whole weeks, with room left up to `last`. */
function calendarView(key: string, label: string, start: string, end: string, last: string, usage: Map<string, Day>): CalendarView {
  const used = lastDays(end, (time(end) - time(start)) / 86_400_000 + 1).map((date) => usage.get(date)).filter((day) => day !== undefined);
  // Usage spans orders of magnitude. The square root keeps a light day visible beside the busiest one.
  const peak = Math.max(1, ...used.map((day) => day.total));
  const weeks: CalendarWeek[] = [];
  const opens: { column: number; month: string }[] = [];
  for (let monday = addDays(start, -weekday(start)); monday <= last; monday = addDays(monday, 7)) {
    const days = lastDays(addDays(monday, 6), 7).map((date) => {
      if (date < start || date > end) return null;
      const day = usage.get(date);
      return { date, total: day?.total ?? 0, byTool: day?.byTool ?? {}, level: day ? Math.ceil(Math.sqrt(day.total / peak) * 4) : 0 };
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

/** The last 53 weeks, then each calendar year with usage, newest first and four at most. */
export function usageCalendar(tokens: TokenMetrics): CalendarView[] {
  const today = todayOf(tokens);
  const usage = new Map(tokens.dated.map((day) => [day.date, day]));
  const views = [calendarView('recent', 'Last 12 months', addDays(today, -weekday(today) - 52 * 7), today, today, usage)];
  for (const { year } of tokens.years.filter((row) => row.year <= Number(today.slice(0, 4))).slice(0, 4)) {
    const last = `${year}-12-31`;
    views.push(calendarView(String(year), String(year), `${year}-01-01`, last < today ? last : today, last, usage));
  }
  return views;
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
}

function largest(counts: [tool: string, count: number][], total: number): UsagePeriod['top'] {
  const [first] = counts.filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return first && total > 0 ? { tool: first[0], share: first[1] / total } : null;
}

function summed(days: Day[]) {
  const byTool: Record<string, number> = {};
  let total = 0;
  let busiest: UsagePeriod['busiest'] = null;
  for (const day of days) {
    total += day.total;
    if (day.total > (busiest?.total ?? 0)) busiest = { date: day.date, total: day.total };
    for (const [tool, count] of Object.entries(day.byTool)) byTool[tool] = (byTool[tool] ?? 0) + count;
  }
  return { total, byTool, busiest, activeDays: days.length };
}

/**
 * Lifetime, then four stretches ending today. Lifetime takes each tool's own total, which
 * includes usage from before its daily records begin. The others can only add up dated days.
 */
export function usagePeriods(tokens: TokenMetrics): UsagePeriod[] {
  const today = todayOf(tokens);
  const [lastMonth, month] = lastMonths(today.slice(0, 7), 2);
  const between = (key: string, label: string, start: string, end: string): UsagePeriod => {
    const { total, byTool, busiest, activeDays } = summed(tokens.dated.filter((day) => day.date >= start && day.date <= end));
    return { key, label, range: { start, end, days: (time(end) - time(start)) / 86_400_000 + 1 }, total, activeDays, top: largest(Object.entries(byTool), total), busiest };
  };
  const all = summed(tokens.dated);
  return [
    {
      key: 'all', label: 'Lifetime', range: null, total: tokens.total, activeDays: all.activeDays,
      top: largest(tokens.tools.map((row) => [row.tool, row.total]), tokens.total), busiest: all.busiest, firstDay: tokens.dated[0]?.date ?? null,
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
