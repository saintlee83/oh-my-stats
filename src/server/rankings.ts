import { providerName } from '../shared/format.ts';
import { lastDays } from '../shared/time.ts';
import type { Db } from './db.ts';
import { BadRequest, isToolName } from './wire.ts';

export type RankingPeriod =
  | { days: 'all'; start: null; end: null }
  | { days: 7 | 30; start: string; end: string };

export function rankingPeriod(value: string | null, now: Date): RankingPeriod {
  if (value === null || value === 'all') return { days: 'all', start: null, end: null };
  if (value !== '7' && value !== '30') throw new BadRequest('Choose all time, 7 days or 30 days.');
  const days = value === '30' ? 30 : 7;
  const end = now.toISOString().slice(0, 10);
  return { days, start: lastDays(end, days)[0], end };
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
  providers: Standing[];
}

// Queries already sort by score and a stable secondary key. Equal scores share a place.
function standings(rows: Score[]): Standing[] {
  let rank = 0;
  return rows.map(({ label, tokens }, i) => {
    if (i === 0 || rows[i - 1].tokens !== tokens) rank = i + 1;
    return { rank, label, tokens };
  });
}

function rankingUsage(period: RankingPeriod, userId?: string) {
  const lifetime = period.days === 'all';
  const params: string[] = lifetime ? [] : [period.start, period.end];
  const membership = userId === undefined ? 'is_public = 1' : `id = ?${params.length + 1}`;
  if (userId !== undefined) params.push(userId);
  const detail = lifetime ? 'models' : 'daily';
  const sql = `WITH members AS (
    SELECT id, login FROM users WHERE ${membership}
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
  return { sql, params };
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
    SELECT user_id, tool, device, tokens, CASE WHEN device IS NOT NULL THEN tokens ELSE 0 END AS device_tokens
    FROM official_days
    UNION ALL
    SELECT user_id, tool, device,
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

/**
 * The public board, by every provider together or by one. Either way it also lists the
 * providers that public profiles use, from the same read of the usage records.
 */
export async function publicRankings(db: Db, period: RankingPeriod, viewerId: string | null = null, provider: string | null = null) {
  const { sql, params } = rankingUsage(period);
  // Usage is never negative, so leaving out a profile's unused providers changes no total.
  const { results } = await db.prepare(`${sql}, by_provider AS (
      SELECT user_id, tool, TOTAL(tokens) AS tokens FROM usage GROUP BY user_id, tool HAVING TOTAL(tokens) > 0
    ), scores AS (
      SELECT members.id, members.login AS label, TOTAL(by_provider.tokens) AS tokens
      FROM by_provider JOIN members ON members.id = by_provider.user_id
      ${provider === null ? '' : 'WHERE by_provider.tool = ?'}
      GROUP BY members.id
    ), ranked AS (
      SELECT *, RANK() OVER (ORDER BY tokens DESC) AS rank, COUNT(*) OVER () AS participants,
        ROW_NUMBER() OVER (ORDER BY tokens DESC, label COLLATE NOCASE, id) AS row_num FROM scores
    )
    SELECT 'profile' AS kind, id, label, tokens, rank, participants, row_num FROM ranked WHERE row_num <= 100 OR id = ?
    UNION ALL
    SELECT 'provider', NULL, tool, TOTAL(tokens), 0, COUNT(*), 0 FROM by_provider GROUP BY tool
    ORDER BY kind, row_num, tokens DESC, label`)
    .bind(...params, ...(provider === null ? [] : [provider]), viewerId)
    .all<Standing & { kind: 'profile' | 'provider'; id: string | null; participants: number; row_num: number }>();
  const profiles = results.filter(row => row.kind === 'profile');
  const position: PublicPosition = {
    days: period.days, rank: profiles.find(row => row.id === viewerId)?.rank ?? null, participants: profiles[0]?.participants ?? 0,
  };
  const users = profiles.filter(row => row.row_num <= 100).map(({ rank, label, tokens }) => ({ rank, label, tokens }));
  const providers: ProviderUsage[] = results.filter(row => row.kind === 'provider')
    .map(({ label, tokens, participants }) => ({ tool: label, tokens, profiles: participants }));
  return { users, position, providers };
}

export async function personalRankings(db: Db, userId: string, period: RankingPeriod): Promise<PersonalRankings> {
  const { sql, params } = rankingUsage(period, userId);
  const { results } = await db.prepare(`${sql}
    SELECT 'machine' AS kind, m.id AS id, m.name AS label, TOTAL(u.device_tokens) AS tokens
    FROM usage u JOIN machines m ON m.user_id = u.user_id AND m.id = u.device
    GROUP BY m.id HAVING TOTAL(u.device_tokens) > 0
    UNION ALL
    SELECT 'provider' AS kind, tool AS id, tool AS label, TOTAL(tokens) AS tokens
    FROM usage GROUP BY tool HAVING TOTAL(tokens) > 0
    ORDER BY kind, tokens DESC, label COLLATE NOCASE, id`)
    .bind(...params).all<Score & { kind: 'machine' | 'provider' }>();
  return {
    machines: standings(results.filter(row => row.kind === 'machine')),
    providers: standings(results.filter(row => row.kind === 'provider').map(row => ({ ...row, label: providerName(row.label) }))),
  };
}
