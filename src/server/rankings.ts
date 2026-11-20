import { providerName } from '../shared/format.ts';
import { lastDays, lastMonths } from '../shared/time.ts';
import type { Db } from './db.ts';
import { BadRequest, isToolName } from './wire.ts';

/** Days are reporting dates in UTC. The two calendar months are for the website only. */
export type RankingPeriod =
  | { days: 'all'; start: null; end: null }
  | { days: 7 | 30 | 'month' | 'last-month'; start: string; end: string };

const lastDayOf = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);

/** A period from an address. The agent's API takes all time, 7 days or 30 days; pages also take the two months. */
export function rankingPeriod(value: string | null, now: Date, months = false): RankingPeriod {
  if (value === null || value === 'all') return { days: 'all', start: null, end: null };
  const end = now.toISOString().slice(0, 10);
  if (value === '7' || value === '30') {
    const days = value === '30' ? 30 : 7;
    return { days, start: lastDays(end, days)[0], end };
  }
  if (months && value === 'month') return { days: 'month', start: `${end.slice(0, 7)}-01`, end };
  if (months && value === 'last-month') {
    const [month] = lastMonths(end.slice(0, 7), 2);
    return { days: 'last-month', start: `${month}-01`, end: lastDayOf(month) };
  }
  throw new BadRequest(months ? 'Choose all time, 7 days, 30 days, this month or last month.' : 'Choose all time, 7 days or 30 days.');
}

/** The stretch right before a period, to compare it with: as many days, or the month before. All time has none. */
export function previousPeriod(period: RankingPeriod): RankingPeriod | null {
  if (period.days === 'all') return null;
  if (period.days === 7 || period.days === 30) {
    const end = lastDays(period.start, 2)[0];
    return { days: period.days, start: lastDays(end, period.days)[0], end };
  }
  // A month is compared with the whole month before it, however far into it today is.
  const [month] = lastMonths(period.start.slice(0, 7), 2);
  return { days: 'last-month', start: `${month}-01`, end: lastDayOf(month) };
}

/** Which page of a board, from an address. */
export function rankingPage(value: string | null): number {
  if (value === null || value === '') return 1;
  if (!/^[1-9]\d{0,3}$/.test(value)) throw new BadRequest('Choose a page by its number.');
  return Number(value);
}

/** A provider to rank by, from a page address. None ranks by every provider together. */
export function rankingProvider(value: string | null): string | null {
  if (value === null || value === '') return null;
  if (!isToolName(value)) throw new BadRequest('Choose a provider by its ID, such as codex.');
  return value;
}

export interface Standing {
  rank: number;
  label: string;
  tokens: number;
}

type Score = Omit<Standing, 'rank'>;
export interface PersonalRankings {
  machines: Standing[];
  /** `label` is the provider's name. `tool` is its ID, which a page needs to draw its mark. */
  providers: (Standing & { tool: string })[];
}

// Queries already sort by score and a stable secondary key. Equal scores share a place.
function standings(rows: Score[]): Standing[] {
  let rank = 0;
  return rows.map(({ label, tokens }, i) => {
    if (i === 0 || rows[i - 1].tokens !== tokens) rank = i + 1;
    return { rank, label, tokens };
  });
}

/** Whose usage a query covers: every public profile, one account, or the members of a group. */
export type Membership =
  | { kind: 'public' }
  | { kind: 'user'; id: string }
  /** `publicOnly` leaves out members whose profiles are private, for a board anyone can open. */
  | { kind: 'group'; id: string; publicOnly: boolean };

/** Values for a query, each named by its number so a query can use one more than once. */
class Bindings {
  readonly values: (string | number | null)[] = [];
  add(value: string | number | null): string {
    this.values.push(value);
    return `?${this.values.length}`;
  }
}

function rankingUsage(period: RankingPeriod, members: Membership) {
  const lifetime = period.days === 'all';
  const bind = new Bindings();
  // The dated queries below name the period's first and last day as ?1 and ?2.
  if (!lifetime) {
    bind.add(period.start);
    bind.add(period.end);
  }
  const membership = members.kind === 'public' ? 'is_public = 1'
    : members.kind === 'user' ? `id = ${bind.add(members.id)}`
    : `id IN (SELECT user_id FROM group_members WHERE group_id = ${bind.add(members.id)})${members.publicOnly ? ' AND is_public = 1' : ''}`;
  const detail = lifetime ? 'models' : 'daily';
  const sql = `WITH members AS (
    SELECT id, login, name FROM users WHERE ${membership}
  ), figures AS (
    SELECT t.user_id, t.machine_id, t.tool, json_extract(payload, '$.scope') AS scope,
      json_extract(payload, '$.total') AS lifetime, json_extract(payload, '$.asOf') AS through_day,
      json_extract(payload, '$.${detail}') AS ${detail}
    FROM members JOIN tool_totals t ON t.user_id = members.id
  ), account_reports AS (
    SELECT user_id, tool, lifetime, through_day,
      ROW_NUMBER() OVER (PARTITION BY user_id, tool ORDER BY lifetime DESC, through_day DESC, machine_id) AS position
      ${lifetime ? '' : ", MAX(daily IS NOT NULL AND daily <> '{}') OVER (PARTITION BY user_id, tool) AS has_days"}
    FROM figures WHERE scope = 'account'
  ), accounts AS (
    SELECT user_id, tool, lifetime, ${lifetime ? 'through_day' : 'CASE WHEN has_days THEN through_day END AS through_day'}
    FROM account_reports WHERE position = 1
  ), ${lifetime ? lifetimeUsage : datedUsage}`;
  return { sql, bind };
}

// Use the same lifetime floors as computeTokens at each level: model, machine, then account.
// An account report can include usage that has no matching device or date.
const lifetimeUsage = `model_sources AS (
    SELECT l.user_id, l.machine_id, l.tool, l.model, TOTAL(l.input + l.output + l.cache_read + l.cache_write) AS logged,
      TOTAL(l.input + l.output + l.cache_read + l.cache_write) FILTER (WHERE l.day > COALESCE(a.through_day, f.through_day)) AS newer,
      0 AS reported, 0 AS machine_total
    FROM members JOIN usage_daily l ON l.user_id = members.id
    LEFT JOIN accounts a ON a.user_id = l.user_id AND a.tool = l.tool
    LEFT JOIN figures f ON f.user_id = l.user_id AND f.machine_id = l.machine_id AND f.tool = l.tool
    GROUP BY l.user_id, l.machine_id, l.tool, l.model
    UNION ALL
    SELECT f.user_id, f.machine_id, f.tool, m.key, 0, 0,
      json_extract(m.value, '$[0]') + json_extract(m.value, '$[1]') + json_extract(m.value, '$[2]') + json_extract(m.value, '$[3]'),
      f.lifetime
    FROM figures f LEFT JOIN json_each(f.models) m ON f.scope = 'machine'
  ), model_totals AS (
    SELECT user_id, machine_id, tool, model, MAX(TOTAL(logged), TOTAL(reported) + TOTAL(newer)) AS known,
      TOTAL(newer) AS newer, MAX(machine_total) AS machine_total
    FROM model_sources GROUP BY user_id, machine_id, tool, model
  ), device_totals AS (
    SELECT m.user_id, m.machine_id, m.tool, TOTAL(m.newer) AS newer,
      CASE WHEN a.user_id IS NULL THEN MAX(TOTAL(m.known), MAX(m.machine_total) + TOTAL(m.newer))
           ELSE TOTAL(m.known) END AS tokens
    FROM model_totals m LEFT JOIN accounts a ON a.user_id = m.user_id AND a.tool = m.tool
    GROUP BY m.user_id, m.machine_id, m.tool
  ), usage AS (
    SELECT user_id, tool, machine_id AS device, tokens, tokens AS device_tokens FROM device_totals
    UNION ALL
    SELECT a.user_id, a.tool, NULL, MAX(0, a.lifetime + TOTAL(d.newer) - TOTAL(d.tokens)), 0
    FROM accounts a JOIN device_totals d ON d.user_id = a.user_id AND d.tool = a.tool
    GROUP BY a.user_id, a.tool
  )`;

const datedUsage = `official_days AS (
    SELECT f.user_id, f.tool, CASE WHEN f.scope = 'machine' THEN f.machine_id END AS device,
      d.key AS day, MAX(d.value) AS tokens
    FROM figures f JOIN json_each(f.daily) d
    LEFT JOIN accounts a ON a.user_id = f.user_id AND a.tool = f.tool
    WHERE d.key BETWEEN ?1 AND ?2 AND (a.user_id IS NULL OR f.scope = 'account')
    GROUP BY f.user_id, f.tool, device, d.key
  ), logged_days AS (
    SELECT l.user_id, l.tool, l.machine_id AS device, l.day,
      TOTAL(l.input + l.output + l.cache_read + l.cache_write) AS tokens
    FROM members JOIN usage_daily l ON l.user_id = members.id
    WHERE l.day BETWEEN ?1 AND ?2
    GROUP BY l.user_id, l.tool, l.machine_id, l.day
  ), covered_logs AS (
    SELECT l.*, a.user_id IS NOT NULL AS account_wide,
      CASE WHEN a.user_id IS NOT NULL THEN a.through_day
           WHEN f.daily IS NOT NULL AND f.daily <> '{}' THEN f.through_day END AS through_day
    FROM logged_days l
    LEFT JOIN accounts a ON a.user_id = l.user_id AND a.tool = l.tool
    LEFT JOIN figures f ON f.user_id = l.user_id AND f.tool = l.tool AND f.machine_id = l.device
  ), usage AS (
    SELECT user_id, tool, device, day, tokens, CASE WHEN device IS NOT NULL THEN tokens ELSE 0 END AS device_tokens
    FROM official_days
    UNION ALL
    SELECT user_id, tool, device, day,
      CASE WHEN day <= through_day THEN 0 ELSE tokens END,
      CASE WHEN day <= through_day AND NOT account_wide THEN 0 ELSE tokens END
    FROM covered_logs
  )`;

export interface PublicPosition {
  days: RankingPeriod['days'];
  rank: number | null;
  participants: number;
}

/** A provider's usage across every public profile, and how many of them use it. */
export interface ProviderUsage {
  tool: string;
  tokens: number;
  profiles: number;
}

/** How many profiles a board shows at a time. */
export const BOARD_PAGE = 100;

export interface RankedProfile extends Standing {
  /** The name on the account, when it has one. `label` is the login. */
  name: string | null;
}

export interface Board {
  users: RankedProfile[];
  position: PublicPosition;
  /** The providers these members use, most used first, whichever provider the board ranks by. */
  providers: ProviderUsage[];
  /** What every ranked profile used together, whichever page is shown. */
  tokens: number;
  page: number;
  pages: number;
  /** The page the viewer's own row is on, when they are ranked. Equal scores can put it past the page their rank suggests. */
  viewerPage?: number | null;
}

/**
 * A board of members ranked by tokens, by every provider together or by one, a page at a time.
 * It also finds the viewer's place, wherever it is, and lists the providers the members use,
 * all from one read of the usage records.
 */
export async function rankBoard(
  db: Db,
  period: RankingPeriod,
  members: Membership,
  options: { viewerId?: string | null; provider?: string | null; page?: number } = {},
): Promise<Board & { viewerTokens: number }> {
  const { viewerId = null, provider = null, page = 1 } = options;
  const { sql, bind } = rankingUsage(period, members);
  const byOne = provider === null ? '' : `WHERE by_provider.tool = ${bind.add(provider)}`;
  const after = bind.add((page - 1) * BOARD_PAGE);
  const through = bind.add(page * BOARD_PAGE);
  // Usage is never negative, so leaving out a profile's unused providers changes no total.
  const { results } = await db.prepare(`${sql}, by_provider AS (
      SELECT user_id, tool, TOTAL(tokens) AS tokens FROM usage GROUP BY user_id, tool HAVING TOTAL(tokens) > 0
    ), scores AS (
      SELECT members.id, members.login AS label, members.name, TOTAL(by_provider.tokens) AS tokens
      FROM by_provider JOIN members ON members.id = by_provider.user_id
      ${byOne}
      GROUP BY members.id
    ), ranked AS (
      SELECT *, RANK() OVER (ORDER BY tokens DESC) AS rank,
        ROW_NUMBER() OVER (ORDER BY tokens DESC, label COLLATE NOCASE, id) AS row_num FROM scores
    )
    SELECT 'profile' AS kind, id, label, name, tokens, rank, 0 AS count, row_num FROM ranked
      WHERE (row_num > ${after} AND row_num <= ${through}) OR id = ${bind.add(viewerId)}
    UNION ALL
    SELECT 'provider', NULL, tool, NULL, TOTAL(tokens), 0, COUNT(*), 0 FROM by_provider GROUP BY tool
    UNION ALL
    SELECT 'total', NULL, '', NULL, TOTAL(tokens), 0, COUNT(*), 0 FROM scores
    ORDER BY kind, row_num, tokens DESC, label`)
    .bind(...bind.values)
    .all<RankedProfile & { kind: 'profile' | 'provider' | 'total'; id: string | null; count: number; row_num: number }>();
  const profiles = results.filter(row => row.kind === 'profile');
  const total = results.find(row => row.kind === 'total');
  const participants = total?.count ?? 0;
  const own = profiles.find(row => row.id === viewerId);
  return {
    users: profiles.filter(row => row.row_num > (page - 1) * BOARD_PAGE && row.row_num <= page * BOARD_PAGE)
      .map(({ rank, label, name, tokens }) => ({ rank, label, name, tokens })),
    position: { days: period.days, rank: own?.rank ?? null, participants },
    viewerTokens: own?.tokens ?? 0,
    providers: results.filter(row => row.kind === 'provider').map(({ label, tokens, count }) => ({ tool: label, tokens, profiles: count })),
    tokens: total?.tokens ?? 0,
    page,
    pages: Math.max(1, Math.ceil(participants / BOARD_PAGE)),
    viewerPage: own ? Math.ceil(own.row_num / BOARD_PAGE) : null,
  };
}

/** One public profile's 30 daily scores, using the same reconciliation as the token board. */
export async function recentRankingDays(db: Db, userId: string, now: Date) {
  const dates = lastDays(now.toISOString().slice(0, 10), 30);
  const { sql, bind } = rankingUsage({ days: 30, start: dates[0], end: dates[29] }, { kind: 'user', id: userId });
  const { results } = await db.prepare(`${sql} SELECT day, TOTAL(tokens) AS tokens FROM usage GROUP BY day`)
    .bind(...bind.values).all<{ day: string; tokens: number }>();
  const totals = new Map(results.map(row => [row.day, row.tokens]));
  return dates.map(date => ({ date, tokens: totals.get(date) ?? 0 }));
}

/** The first page of the public board, as the agent's API has always given it. */
export async function publicRankings(db: Db, period: RankingPeriod, viewerId: string | null = null, provider: string | null = null) {
  const { users, position, providers } = await rankBoard(db, period, { kind: 'public' }, { viewerId, provider });
  return { users: users.map(({ rank, label, tokens }): Standing => ({ rank, label, tokens })), position, providers };
}

export async function personalRankings(db: Db, userId: string, period: RankingPeriod): Promise<PersonalRankings> {
  const { sql, bind } = rankingUsage(period, { kind: 'user', id: userId });
  const { results } = await db.prepare(`${sql}
    SELECT 'machine' AS kind, m.id AS id, m.name AS label, TOTAL(u.device_tokens) AS tokens
    FROM usage u JOIN machines m ON m.user_id = u.user_id AND m.id = u.device
    GROUP BY m.id HAVING TOTAL(u.device_tokens) > 0
    UNION ALL
    SELECT 'provider' AS kind, tool AS id, tool AS label, TOTAL(tokens) AS tokens
    FROM usage GROUP BY tool HAVING TOTAL(tokens) > 0
    ORDER BY kind, tokens DESC, label COLLATE NOCASE, id`)
    .bind(...bind.values).all<Score & { kind: 'machine' | 'provider'; id: string }>();
  const tools = results.filter(row => row.kind === 'provider');
  return {
    machines: standings(results.filter(row => row.kind === 'machine')),
    providers: standings(tools.map(row => ({ ...row, label: providerName(row.label) }))).map((row, i) => ({ ...row, tool: tools[i].id })),
  };
}
