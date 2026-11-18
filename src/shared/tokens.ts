import type { ModelUsage, TokenMetrics, TokenToolRow } from './metrics.ts';
import { costOf, findPrice } from './pricing.ts';
import { lastDays, zoned } from './time.ts';
import type { MachineUsage, PriceTable, TokenBreakdown, ToolTotals } from './types.ts';

const totalOf = (usage: TokenBreakdown) => usage[0] + usage[1] + usage[2] + usage[3];

const addInto = (target: TokenBreakdown, values: readonly number[]) => {
  for (let index = 0; index < 4; index++) target[index] += values[index];
};

interface LoggedModel {
  tool: string;
  model: string;
  usage: TokenBreakdown;
  /** The part dated after this machine's own figure for the tool. */
  newer: TokenBreakdown;
  messages: number;
}

function splitKey(key: string): [string, string] {
  const slash = key.indexOf('/');
  return [key.slice(0, slash), key.slice(slash + 1)];
}

/** The account-wide figure for a tool: machines report the same number, so the largest is newest. */
function accountFigure(machines: MachineUsage[], tool: string): ToolTotals | null {
  let best: ToolTotals | null = null;
  const daily: Record<string, number> = {};
  for (const machine of machines) {
    const figure = machine.totals?.[tool];
    if (figure?.scope !== 'account') continue;
    if (!best || figure.total > best.total) best = figure;
    for (const [date, value] of Object.entries(figure.daily ?? {})) daily[date] = Math.max(daily[date] ?? 0, value);
  }
  return best ? { ...best, daily } : null;
}

/**
 * Combines every machine into one picture. The rule that matters: a per-machine figure
 * (Claude Code's statistics) is added across machines, while an account figure (Codex
 * /usage) already covers them all and must count only once.
 */
export function computeTokens(
  machines: MachineUsage[],
  prices: PriceTable,
  timezone: string,
  now: Date,
  commitsLast30: number | null,
): TokenMetrics | null {
  const toolNames = new Set<string>();
  for (const machine of machines) {
    for (const rows of Object.values(machine.days)) for (const key of Object.keys(rows)) toolNames.add(splitKey(key)[0]);
    for (const tool of Object.keys(machine.totals ?? {})) toolNames.add(tool);
  }
  if (toolNames.size === 0) return null;

  const today = zoned(now, timezone).date;
  const dates30 = lastDays(today, 30);
  const window30 = new Set(dates30);
  const window7 = new Set(dates30.slice(-7));
  const responseUsage = new Map<string, { responses: number; tokens: number }>();
  const accounts = new Map<string, ToolTotals>();
  for (const tool of toolNames) {
    const figure = accountFigure(machines, tool);
    if (figure) accounts.set(tool, figure);
  }

  const rows = new Map<string, ModelUsage>();
  const days = new Map<string, Record<string, number>>();
  const addDay = (date: string, tool: string, value: number) => {
    const day = days.get(date) ?? {};
    day[tool] = (day[tool] ?? 0) + value;
    days.set(date, day);
  };
  const perMachine: TokenMetrics['machines'] = [];
  const toolKnownPerMachine = new Map<string, number>(); // machine-scope totals, summed
  const accountNewer = new Map<string, number>();
  const figureTools = new Set<string>();
  let last30Fresh = 0;

  const addRow = (tool: string, model: string, usage: TokenBreakdown, messages: number) => {
    const key = `${tool}/${model}`;
    const row = rows.get(key) ?? { tool, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, total: 0, cost: null };
    row.input += usage[0];
    row.output += usage[1];
    row.cacheRead += usage[2];
    row.cacheWrite += usage[3];
    row.messages += messages;
    row.total += totalOf(usage);
    rows.set(key, row);
  };

  for (const machine of machines) {
    const summary = { id: machine.id, total: 0, last7: 0, last30: 0 };
    const addMachineDay = (date: string, value: number) => {
      if (window7.has(date)) summary.last7 += value;
      if (window30.has(date)) summary.last30 += value;
    };
    const logged = new Map<string, LoggedModel>();
    const logDays = new Map<string, Record<string, number>>();

    for (const [date, entries] of Object.entries(machine.days)) {
      for (const [key, tuple] of Object.entries(entries)) {
        const [tool, model] = splitKey(key);
        const row = logged.get(key) ?? { tool, model, usage: [0, 0, 0, 0] as TokenBreakdown, newer: [0, 0, 0, 0] as TokenBreakdown, messages: 0 };
        addInto(row.usage, tuple);
        row.messages += tuple[4];
        const asOf = accounts.get(tool)?.asOf ?? machine.totals?.[tool]?.asOf;
        if (asOf && date > asOf) addInto(row.newer, tuple);
        logged.set(key, row);

        const day = logDays.get(date) ?? {};
        const sum = tuple[0] + tuple[1] + tuple[2] + tuple[3];
        day[tool] = (day[tool] ?? 0) + sum;
        logDays.set(date, day);
        if (window30.has(date)) {
          last30Fresh += tuple[0] + tuple[1] + tuple[3];
          const usage = responseUsage.get(tool) ?? { responses: 0, tokens: 0 };
          usage.responses += tuple[4];
          usage.tokens += sum;
          responseUsage.set(tool, usage);
        }
      }
    }

    // Per model: a machine's lifetime figure when it has one, otherwise its logs.
    const handled = new Set<string>();
    const knownByTool: Record<string, number> = {};
    for (const [tool, figure] of Object.entries(machine.totals ?? {})) {
      if (figure.scope === 'account' || !figure.models) continue;
      for (const [model, usage] of Object.entries(figure.models)) {
        const key = `${tool}/${model}`;
        const log = logged.get(key);
        const combined: TokenBreakdown = [...usage];
        if (log) addInto(combined, log.newer);
        const best = log && totalOf(log.usage) > totalOf(combined) ? log.usage : combined;
        addRow(tool, model, best, log?.messages ?? 0);
        knownByTool[tool] = (knownByTool[tool] ?? 0) + totalOf(best);
        handled.add(key);
      }
    }
    for (const [key, log] of logged) {
      if (handled.has(key)) continue;
      addRow(log.tool, log.model, log.usage, log.messages);
      knownByTool[log.tool] = (knownByTool[log.tool] ?? 0) + totalOf(log.usage);
    }

    // Per tool: machine figures add up across machines; account figures are handled once, below.
    for (const tool of toolNames) {
      const newer = [...logged.values()].filter((row) => row.tool === tool).reduce((sum, row) => sum + totalOf(row.newer), 0);
      if (accounts.has(tool)) {
        accountNewer.set(tool, (accountNewer.get(tool) ?? 0) + newer);
        summary.total += knownByTool[tool] ?? 0;
        continue;
      }
      const figure = machine.totals?.[tool];
      if (figure) figureTools.add(tool);
      const known = knownByTool[tool] ?? 0;
      const total = figure ? Math.max(figure.total + newer, known) : known;
      summary.total += total;
      toolKnownPerMachine.set(tool, (toolKnownPerMachine.get(tool) ?? 0) + total);
    }

    // A tool's own daily figures win up to their last date. Mixing in logs would count
    // usage twice whenever the two sources put it on neighbouring days.
    for (const [date, day] of logDays) {
      for (const [tool, value] of Object.entries(day)) {
        const figure = accounts.get(tool) ?? machine.totals?.[tool];
        const covered = figure?.asOf && Object.keys(figure.daily ?? {}).length > 0 && date <= figure.asOf;
        if (!covered) addDay(date, tool, value);
        // Account-wide daily totals carry no machine identity. Keep the local
        // log breakdown for the owner even when an account total covers the day.
        if (!covered || figure?.scope === 'account') addMachineDay(date, value);
      }
    }
    for (const [tool, figure] of Object.entries(machine.totals ?? {})) {
      if (accounts.has(tool)) continue;
      for (const [date, value] of Object.entries(figure.daily ?? {})) {
        addDay(date, tool, value);
        addMachineDay(date, value);
      }
    }
    perMachine.push(summary);
  }
  for (const [tool, figure] of accounts) {
    for (const [date, value] of Object.entries(figure.daily ?? {})) addDay(date, tool, value);
  }

  const modelRows = [...rows.values()]
    .map((row) => {
      const price = findPrice(prices, row.model);
      return { ...row, cost: price ? costOf(price, row) : null };
    })
    .sort((a, b) => b.total - a.total);

  const toolRows: TokenToolRow[] = [...toolNames]
    .map((tool) => {
      const own = modelRows.filter((row) => row.tool === tool);
      const known = own.reduce((sum, row) => sum + row.total, 0);
      const account = accounts.get(tool);
      const total = account ? Math.max(account.total + (accountNewer.get(tool) ?? 0), known) : Math.max(toolKnownPerMachine.get(tool) ?? 0, known);
      const reporting = machines.filter(
        (machine) => machine.totals?.[tool] || Object.values(machine.days).some((entries) => Object.keys(entries).some((key) => key.startsWith(`${tool}/`))),
      ).length;
      const asOfs = machines.map((machine) => machine.totals?.[tool]?.asOf).filter((date): date is string => Boolean(date)).sort();
      const recent = dates30.map((date) => days.get(date)?.[tool] ?? 0);
      const weekTotal = (week: number[]) => week.reduce((sum, count) => sum + count, 0);
      const logged = responseUsage.get(tool);
      const scope: TokenToolRow['scope'] = account ? 'account' : figureTools.has(tool) ? 'machine' : 'logs';
      return {
        tool,
        total,
        fresh: own.reduce((sum, row) => sum + row.input + row.output + row.cacheWrite, 0),
        cost: own.reduce((sum, row) => sum + (row.cost ?? 0), 0),
        unattributed: Math.max(0, total - known),
        scope,
        asOf: account?.asOf ?? asOfs.at(-1) ?? null,
        machines: reporting,
        activity: {
          last7: weekTotal(recent.slice(-7)),
          previous7: weekTotal(recent.slice(-14, -7)),
          activeDays30: recent.filter((tokens) => tokens > 0).length,
          responses30: logged?.responses ?? 0,
          tokensPerResponse30: logged?.responses ? logged.tokens / logged.responses : null,
        },
      };
    })
    .sort((a, b) => b.total - a.total);

  const allDates = [...days.keys()].sort();
  const dayTotal = (date: string) => Object.values(days.get(date) ?? {}).reduce((sum, value) => sum + value, 0);
  const monthly = new Map<string, { month: string; total: number; byTool: Record<string, number> }>();
  const datedByTool: Record<string, number> = {};
  for (const date of allDates) {
    const month = date.slice(0, 7);
    const row = monthly.get(month) ?? { month, total: 0, byTool: {} };
    for (const [tool, value] of Object.entries(days.get(date) ?? {})) {
      row.total += value;
      row.byTool[tool] = (row.byTool[tool] ?? 0) + value;
      datedByTool[tool] = (datedByTool[tool] ?? 0) + value;
    }
    monthly.set(month, row);
  }

  let peak: TokenMetrics['peak'] = null;
  for (const date of allDates) {
    const total = dayTotal(date);
    if (total > (peak?.total ?? 0)) peak = { date, total };
  }

  const sum = (pick: (row: ModelUsage) => number) => modelRows.reduce((total, row) => total + pick(row), 0);
  const input = sum((row) => row.input);
  const cacheRead = sum((row) => row.cacheRead);
  const cacheWrite = sum((row) => row.cacheWrite);
  const output = sum((row) => row.output);
  return {
    total: toolRows.reduce((total, row) => total + row.total, 0),
    fresh: input + output + cacheWrite,
    input,
    output,
    cacheRead,
    cacheWrite,
    messages: sum((row) => row.messages),
    cost: sum((row) => row.cost ?? 0),
    unpricedModels: modelRows.filter((row) => row.cost === null).map((row) => row.model),
    unattributed: toolRows.reduce((total, row) => total + row.unattributed, 0),
    models: modelRows,
    tools: toolRows,
    machines: perMachine.sort((a, b) => b.total - a.total),
    daily: lastDays(today, 60).map((date) => ({ date, total: dayTotal(date), byTool: { ...days.get(date) } })),
    monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
    undated: toolRows.reduce((total, row) => total + Math.max(0, row.total - (datedByTool[row.tool] ?? 0)), 0),
    last30: {
      total: [...window30].reduce((total, date) => total + dayTotal(date), 0),
      fresh: last30Fresh,
      perCommit: commitsLast30 ? last30Fresh / commitsLast30 : null,
    },
    firstDay: allDates[0] ?? null,
    activeDays: allDates.filter((date) => dayTotal(date) > 0).length,
    peak,
    cacheShare: input + cacheRead + cacheWrite ? cacheRead / (input + cacheRead + cacheWrite) : 0,
  };
}
