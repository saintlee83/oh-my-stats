import { PROVIDERS } from '../shared/format.ts';
import { costOf, findPrice } from '../shared/pricing.ts';
import type { Price, PriceTable } from '../shared/types.ts';
import type { Db } from './db.ts';
import { BOARD_PAGE, previousPeriod, rankBoard, type Board, type RankedProfile, type RankingPeriod } from './rankings.ts';
import { BadRequest } from './wire.ts';

/**
 * The boards beside the token board: profiles by estimated cost, providers and models.
 * They add up public profiles only. Provider IDs and model names are text chosen by whoever
 * uploads them, so a board lists only the known providers and the models with a list price.
 */

/** What the profiles board is ranked by. */
export type BoardSort = 'tokens' | 'cost';

/** How to rank the profiles board, from a page address. */
export function boardSort(value: string | null): BoardSort {
  if (value === null || value === '' || value === 'tokens') return 'tokens';
  if (value === 'cost') return 'cost';
  throw new BadRequest('Choose to rank by tokens or by cost.');
}

/** With fewer profiles than this in the period before, a percentage says little, so none is given. */
export const CHANGE_BASE = 25;

/** How a count of active profiles moved from the period before. */
export interface Change {
  /** Active profiles in the period before. With none, the row is new. */
  before: number;
  by: number;
  /** The move as a fraction of `before`, when that is enough profiles to divide by. */
  rate: number | null;
}

const changeFrom = (before: number, now: number): Change => ({ before, by: now - before, rate: before >= CHANGE_BASE ? (now - before) / before : null });

interface Reach {
  profiles: number;
  tokens: number;
}

/** The order of plain text, the same on every machine. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Most profiles first, then most tokens. Rows equal in both share a place. */
function byReach<Row extends Reach>(rows: Row[], name: (row: Row) => string): (Row & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => b.profiles - a.profiles || b.tokens - a.tokens || order(name(a), name(b)));
  let rank = 0;
  return sorted.map((row, i) => {
    if (i === 0 || sorted[i - 1].profiles !== row.profiles || sorted[i - 1].tokens !== row.tokens) rank = i + 1;
    return { ...row, rank };
  });
}

export interface ProviderStanding extends Reach {
  rank: number;
  tool: string;
  /** Its active profiles as a share of every ranked profile. */
  share: number;
  /** Against the period before. All time has no period before it. */
  change: Change | null;
}

export interface ProviderBoard {
  providers: ProviderStanding[];
  /** Every ranked profile in the period, whichever providers it uses. */
  profiles: number;
  tokens: number;
  compared: RankingPeriod | null;
}

/** The known providers, by how many public profiles used each one in a period. */
export async function providerBoard(db: Db, period: RankingPeriod): Promise<ProviderBoard> {
  const compared = previousPeriod(period);
  const [now, before] = await Promise.all([
    rankBoard(db, period, { kind: 'public' }),
    compared ? rankBoard(db, compared, { kind: 'public' }) : null,
  ]);
  const earlier = new Map<string, number>(before?.providers.map(({ tool, profiles }) => [tool, profiles]));
  const rows = now.providers.filter(({ tool }) => PROVIDERS.has(tool)).map(({ tool, tokens, profiles }) => ({
    tool,
    profiles,
    tokens,
    share: profiles / now.position.participants,
    change: before ? changeFrom(earlier.get(tool) ?? 0, profiles) : null,
  }));
  return { providers: byReach(rows, (row) => row.tool), profiles: now.position.participants, tokens: now.tokens, compared };
}

interface LoggedRow {
  id: string;
  label: string;
  name: string | null;
  tool: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** Tokens of the same profile, provider and model in the period before. */
  earlier: number;
}

const TOKENS = 'l.input + l.output + l.cache_read + l.cache_write';

/**
 * What public profiles logged in a period, added up per profile, provider and model in one
 * read. Logs are the only record that names a model for each token, so everything priced
 * starts here, and a tool's own larger figure is not part of it. `compared` also adds up the
 * period before, and `named` reads who each profile is.
 */
async function loggedUsage(db: Db, period: RankingPeriod, { compared = null, named = false }: { compared?: RankingPeriod | null; named?: boolean } = {}): Promise<LoggedRow[]> {
  const bind: string[] = [];
  let days = '';
  let during = '';
  let earlier = '0';
  if (period.days !== 'all') {
    bind.push(period.start, period.end);
    days = 'AND l.day BETWEEN ?1 AND ?2';
    if (compared?.start) {
      // The period before ends where this one starts, so one stretch of days covers both.
      bind.push(compared.start, compared.end);
      days = 'AND l.day BETWEEN ?3 AND ?2';
      during = ' FILTER (WHERE l.day BETWEEN ?1 AND ?2)';
      earlier = `TOTAL(${TOKENS}) FILTER (WHERE l.day BETWEEN ?3 AND ?4)`;
    }
  }
  const { results } = await db.prepare(`SELECT u.id, ${named ? 'u.login AS label, u.name' : "'' AS label, NULL AS name"}, l.tool, l.model,
      TOTAL(l.input)${during} AS input, TOTAL(l.output)${during} AS output,
      TOTAL(l.cache_read)${during} AS cache_read, TOTAL(l.cache_write)${during} AS cache_write, ${earlier} AS earlier
    FROM users u JOIN usage_daily l ON l.user_id = u.id
    WHERE u.is_public = 1 ${days}
    GROUP BY u.id, l.tool, l.model
    ORDER BY u.id, l.tool, l.model`)
    .bind(...bind)
    .all<LoggedRow>();
  return results;
}

const tokensOf = (row: LoggedRow) => row.input + row.output + row.cache_read + row.cache_write;

const costAt = (price: Price, row: LoggedRow) => costOf(price, { input: row.input, output: row.output, cacheRead: row.cache_read, cacheWrite: row.cache_write });

/**
 * Finds a model's list price and the name it is listed under. A dated name is a release of
 * the model its price is found under, so it takes that name.
 */
function priceList(prices: PriceTable) {
  const found = new Map<string, { name: string; price: Price } | null>();
  return (model: string) => {
    let entry = found.get(model);
    if (entry === undefined) {
      const price = findPrice(prices, model);
      entry = price ? { name: Object.hasOwn(prices, model) ? model : model.replace(/-\d{8}$/, ''), price } : null;
      found.set(model, entry);
    }
    return entry;
  };
}

/** Costs are compared to a millionth of a dollar, so sums that differ only in rounding share a place. */
const rounded = (cost: number) => Math.round(cost * 1e6) / 1e6;

export interface PricedProfile extends RankedProfile {
  /** What the profile's logged usage would cost at list prices. `tokens` are those same logged tokens. */
  cost: number;
}

export interface CostBoard extends Board {
  users: PricedProfile[];
  /** What every ranked profile's logged usage would cost together. */
  cost: number;
}

/**
 * Public profiles ranked by what their logged usage in a period would cost at list prices,
 * a page at a time like the token board. A model without a list price adds tokens but no
 * cost, and a profile with no priced usage is not ranked.
 */
export async function costBoard(
  db: Db,
  prices: PriceTable,
  period: RankingPeriod,
  options: { viewerId?: string | null; provider?: string | null; page?: number } = {},
): Promise<CostBoard> {
  const { viewerId = null, provider = null, page = 1 } = options;
  const priceOf = priceList(prices);
  const profiles = new Map<string, PricedProfile & { id: string }>();
  const tools = new Map<string, { tokens: number; profiles: Set<string> }>();
  for (const row of await loggedUsage(db, period, { named: true })) {
    const tokens = tokensOf(row);
    if (tokens <= 0) continue;
    const tool = tools.get(row.tool) ?? { tokens: 0, profiles: new Set<string>() };
    tools.set(row.tool, tool);
    tool.tokens += tokens;
    tool.profiles.add(row.id);
    if (provider !== null && row.tool !== provider) continue;
    const profile = profiles.get(row.id) ?? { id: row.id, rank: 0, label: row.label, name: row.name, tokens: 0, cost: 0 };
    profiles.set(row.id, profile);
    profile.tokens += tokens;
    const priced = priceOf(row.model);
    if (priced) profile.cost += costAt(priced.price, row);
  }
  const ranked = [...profiles.values()]
    .map((profile) => ({ ...profile, cost: rounded(profile.cost) }))
    .filter((profile) => profile.cost > 0)
    .sort((a, b) => b.cost - a.cost || order(a.label.toLowerCase(), b.label.toLowerCase()) || order(a.id, b.id));
  ranked.forEach((profile, i) => {
    profile.rank = i > 0 && ranked[i - 1].cost === profile.cost ? ranked[i - 1].rank : i + 1;
  });
  const own = ranked.findIndex((profile) => profile.id === viewerId);
  return {
    users: ranked.slice((page - 1) * BOARD_PAGE, page * BOARD_PAGE).map(({ rank, label, name, tokens, cost }) => ({ rank, label, name, tokens, cost })),
    position: { days: period.days, rank: own < 0 ? null : ranked[own].rank, participants: ranked.length },
    providers: [...tools]
      .map(([tool, usage]) => ({ tool, tokens: usage.tokens, profiles: usage.profiles.size }))
      .sort((a, b) => b.tokens - a.tokens || order(a.tool, b.tool)),
    tokens: ranked.reduce((sum, profile) => sum + profile.tokens, 0),
    cost: rounded(ranked.reduce((sum, profile) => sum + profile.cost, 0)),
    page,
    pages: Math.max(1, Math.ceil(ranked.length / BOARD_PAGE)),
    viewerPage: own < 0 ? null : Math.floor(own / BOARD_PAGE) + 1,
  };
}

export interface ModelStanding extends Reach {
  rank: number;
  /** The name the model's price is listed under. */
  model: string;
  /** The known provider most of its tokens came through. None when other tools carry more. */
  provider: string | null;
  providerShare: number;
  /** Its active profiles as a share of every profile with logged usage. */
  share: number;
  cost: number;
  change: Change | null;
}

export interface ModelBoard {
  /** The first hundred, by active profiles. */
  models: ModelStanding[];
  /** Every model with a list price that was used, listed or not. */
  priced: number;
  /** Public profiles with any logged usage in the period, priced or not. */
  profiles: number;
  /** Tokens and cost of every priced model together. */
  tokens: number;
  cost: number;
  compared: RankingPeriod | null;
}

/** The models with a list price, by how many public profiles logged usage of each one in a period. */
export async function modelBoard(db: Db, prices: PriceTable, period: RankingPeriod): Promise<ModelBoard> {
  const compared = previousPeriod(period);
  const priceOf = priceList(prices);
  const active = new Set<string>();
  const models = new Map<string, { tokens: number; cost: number; profiles: Set<string>; before: Set<string>; tools: Map<string | null, number> }>();
  for (const row of await loggedUsage(db, period, { compared })) {
    const tokens = tokensOf(row);
    if (tokens > 0) active.add(row.id);
    const priced = priceOf(row.model);
    if (!priced) continue;
    const model = models.get(priced.name) ?? { tokens: 0, cost: 0, profiles: new Set<string>(), before: new Set<string>(), tools: new Map<string | null, number>() };
    models.set(priced.name, model);
    if (row.earlier > 0) model.before.add(row.id);
    if (tokens <= 0) continue;
    model.profiles.add(row.id);
    model.tokens += tokens;
    model.cost += costAt(priced.price, row);
    // Usage through a provider only its uploader named is counted together, without the name.
    const tool = PROVIDERS.has(row.tool) ? row.tool : null;
    model.tools.set(tool, (model.tools.get(tool) ?? 0) + tokens);
  }
  const rows = [...models].filter(([, model]) => model.profiles.size > 0).map(([name, model]) => {
    const [[provider, most]] = [...model.tools].sort((a, b) => b[1] - a[1] || order(a[0] ?? '~', b[0] ?? '~'));
    return {
      model: name,
      provider,
      providerShare: most / model.tokens,
      profiles: model.profiles.size,
      share: model.profiles.size / active.size,
      tokens: model.tokens,
      cost: rounded(model.cost),
      change: compared ? changeFrom(model.before.size, model.profiles.size) : null,
    };
  });
  return {
    models: byReach(rows, (row) => row.model).slice(0, BOARD_PAGE),
    priced: rows.length,
    profiles: active.size,
    tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    cost: rounded(rows.reduce((sum, row) => sum + row.cost, 0)),
    compared,
  };
}
