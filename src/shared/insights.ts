import type { Metrics, TokenMetrics } from './metrics.ts';
import { lastMonths } from './time.ts';

export function weeklyUsage(tokens: TokenMetrics) {
  let total = 0;
  let previous = 0;
  let topIncrease: { tool: string; tokens: number } | null = null;
  for (const { tool, activity } of tokens.tools) {
    total += activity.last7;
    previous += activity.previous7;
    const gain = activity.last7 - activity.previous7;
    if (gain > (topIncrease?.tokens ?? 0)) topIncrease = { tool, tokens: gain };
  }
  return {
    total, previous, changePercent: previous ? 100 * (total - previous) / previous : null, topIncrease,
    days: tokens.daily.slice(-7).map(({ date, total }) => ({ date, total })),
  };
}

export function providerMix(tokens: TokenMetrics) {
  const today = tokens.daily.at(-1)!.date;
  const [previousMonth, currentMonth] = lastMonths(today.slice(0, 7), 2);
  const prior = tokens.monthly.find(row => row.month === previousMonth);
  // Machine reporting dates may run ahead of the profile timezone. Stop at today.
  const current = new Map<string, number>();
  let currentTotal = 0;
  for (const day of tokens.daily) {
    if (!day.date.startsWith(currentMonth)) continue;
    currentTotal += day.total;
    for (const [tool, count] of Object.entries(day.byTool)) current.set(tool, (current.get(tool) ?? 0) + count);
  }
  const rows = tokens.tools.map(({ tool }) => {
    const previous = prior?.byTool[tool] ?? 0;
    const now = current.get(tool) ?? 0;
    return { tool, now, previous, share: currentTotal ? now / currentTotal : null, priorShare: prior?.total ? previous / prior.total : null };
  }).filter(row => row.now || row.previous).sort((a, b) => b.now - a.now || b.previous - a.previous);
  return { previousMonth, today, rows };
}

/** The last complete calendar month in the profile timezone. Missing sources have no value. */
export function monthlyRecap({ generatedDate, tokens, github }: Metrics) {
  const [month] = lastMonths(generatedDate.slice(0, 7), 2);
  const index = github?.months.indexOf(month) ?? -1;
  const dated = tokens?.firstDay && tokens.firstDay.slice(0, 7) <= month;
  return {
    month,
    tokens: dated ? (tokens?.monthly.find(row => row.month === month)?.total ?? 0) : null,
    commits: github?.monthly.commits[index] ?? null,
    pulls: github?.monthly.pulls[index] ?? null,
    reviews: github?.monthly.reviews[index] ?? null,
  };
}
