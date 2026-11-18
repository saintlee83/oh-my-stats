import { providerName } from '../shared/format.ts';
import { lastDays } from '../shared/time.ts';
import type { Db } from './db.ts';
import { BadRequest } from './wire.ts';

export interface RankingPeriod {
  days: 7 | 30;
  start: string;
  end: string;
}

export function rankingPeriod(value: string | null, now: Date): RankingPeriod {
  if (value !== null && value !== '7' && value !== '30') throw new BadRequest('Choose a ranking period of 7 or 30 days.');
  const days = value === '30' ? 30 : 7;
  const end = now.toISOString().slice(0, 10);
  return { days, start: lastDays(end, days)[0], end };
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

// Match the dashboard's daily accounting without loading every profile's full history into
// the Worker. Account figures cover all machines, but only device-specific usage can rank a device.
function usageInPeriod(members: 'public' | 'owner'): string {
  return `WITH members AS (
    SELECT id, login FROM users WHERE ${members === 'public' ? 'is_public = 1' : 'id = ?3'}
  ), figures AS (
    SELECT t.user_id, t.machine_id, t.tool, json_extract(payload, '$.scope') AS scope,
      json_extract(payload, '$.total') AS lifetime, json_extract(payload, '$.asOf') AS through_day,
      json_extract(payload, '$.daily') AS daily
    FROM members JOIN tool_totals t ON t.user_id = members.id
  ), account_reports AS (
    SELECT user_id, tool, through_day,
      ROW_NUMBER() OVER (PARTITION BY user_id, tool ORDER BY lifetime DESC, through_day DESC, machine_id) AS position,
      MAX(daily IS NOT NULL AND daily <> '{}') OVER (PARTITION BY user_id, tool) AS has_days
    FROM figures WHERE scope = 'account'
  ), accounts AS (
    SELECT user_id, tool, CASE WHEN has_days THEN through_day END AS through_day
    FROM account_reports WHERE position = 1
  ), official_days AS (
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
}

export async function publicRankings(db: Db, period: RankingPeriod): Promise<Standing[]> {
  const { results } = await db.prepare(`${usageInPeriod('public')}
    SELECT members.login AS label, TOTAL(usage.tokens) AS tokens
    FROM usage JOIN members ON members.id = usage.user_id
    GROUP BY members.id HAVING TOTAL(usage.tokens) > 0
    ORDER BY tokens DESC, label COLLATE NOCASE, members.id LIMIT 100`)
    .bind(period.start, period.end).all<Score>();
  return standings(results);
}

export async function personalRankings(db: Db, userId: string, period: RankingPeriod): Promise<PersonalRankings> {
  const { results } = await db.prepare(`${usageInPeriod('owner')}
    SELECT 'machine' AS kind, m.id AS id, m.name AS label, TOTAL(u.device_tokens) AS tokens
    FROM usage u JOIN machines m ON m.user_id = u.user_id AND m.id = u.device
    GROUP BY m.id HAVING TOTAL(u.device_tokens) > 0
    UNION ALL
    SELECT 'provider' AS kind, tool AS id, tool AS label, TOTAL(tokens) AS tokens
    FROM usage GROUP BY tool HAVING TOTAL(tokens) > 0
    ORDER BY kind, tokens DESC, label COLLATE NOCASE, id`)
    .bind(period.start, period.end, userId).all<Score & { kind: 'machine' | 'provider' }>();
  return {
    machines: standings(results.filter(row => row.kind === 'machine')),
    providers: standings(results.filter(row => row.kind === 'provider').map(row => ({ ...row, label: providerName(row.label) }))),
  };
}
