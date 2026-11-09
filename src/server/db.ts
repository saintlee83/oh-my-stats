import type { GitHubMetrics } from '../shared/metrics.ts';
import type { MachineUsage, ToolTotals, UsageTuple } from '../shared/types.ts';
import type { MachineInfo, UsageUpload } from './wire.ts';

/** The small part of D1 this app uses, so tests can run against plain SQLite. */
export interface Statement {
  bind(...values: unknown[]): Statement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface Db {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}

export interface UserRow {
  id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
  is_public: number;
  timezone: string;
  created_at: string;
}

export interface MachineRow {
  id: string;
  name: string;
  platform: string | null;
  agent_version: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface GitHubIdentity {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
}

export async function upsertUser(db: Db, identity: GitHubIdentity, now: string): Promise<UserRow> {
  const id = String(identity.id);
  const statements = [
    // A login can be reused after a rename; the old owner's row gives it up.
    db.prepare('UPDATE users SET login = ? WHERE login = ? COLLATE NOCASE AND id <> ?').bind(`renamed-${crypto.randomUUID()}`, identity.login, id),
    db
      .prepare(
        `INSERT INTO users (id, login, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`,
      )
      .bind(id, identity.login, identity.name ?? null, identity.avatar_url ?? null, now, now),
  ];
  await db.batch(statements);
  return (await userById(db, id)) as UserRow;
}

export const userById = (db: Db, id: string) => db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();

export const userByLogin = (db: Db, login: string) =>
  db.prepare('SELECT * FROM users WHERE login = ? COLLATE NOCASE').bind(login).first<UserRow>();

export async function setPublic(db: Db, userId: string, isPublic: boolean, now: string): Promise<void> {
  await db.prepare('UPDATE users SET is_public = ?, updated_at = ? WHERE id = ?').bind(isPublic ? 1 : 0, now, userId).run();
}

export async function deleteUser(db: Db, userId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM usage_daily WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM tool_totals WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM github_stats WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM machines WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM kv WHERE key = ?').bind(`github-lease:${userId}`),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

export interface SessionRow {
  user_id: string;
  kind: 'web' | 'agent';
  machine_id: string | null;
  expires_at: string | null;
}

export async function createSession(
  db: Db,
  tokenHash: string,
  userId: string,
  kind: 'web' | 'agent',
  machineId: string | null,
  expiresAt: string | null,
  now: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, kind, machine_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(tokenHash, userId, kind, machineId, now, expiresAt)
    .run();
}

export async function findSession(db: Db, tokenHash: string, now: string): Promise<SessionRow | null> {
  const row = await db.prepare('SELECT user_id, kind, machine_id, expires_at FROM sessions WHERE token_hash = ?').bind(tokenHash).first<SessionRow>();
  if (!row) return null;
  return row.expires_at && row.expires_at <= now ? null : row;
}

export async function deleteSession(db: Db, tokenHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export async function upsertMachine(db: Db, userId: string, machine: MachineInfo, now: string): Promise<void> {
  // An agent reports its hostname, but must not undo a name the user chose on the website.
  await db
    .prepare(
      `INSERT INTO machines (user_id, id, name, platform, agent_version, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, id) DO UPDATE SET platform = excluded.platform, agent_version = excluded.agent_version, last_seen_at = excluded.last_seen_at`,
    )
    .bind(userId, machine.id, machine.name, machine.platform, machine.agentVersion, now, now)
    .run();
}

export async function listMachines(db: Db, userId: string): Promise<MachineRow[]> {
  const { results } = await db
    .prepare('SELECT id, name, platform, agent_version, created_at, last_seen_at FROM machines WHERE user_id = ? ORDER BY last_seen_at DESC')
    .bind(userId)
    .all<MachineRow>();
  return results;
}

export async function renameMachine(db: Db, userId: string, machineId: string, name: string): Promise<void> {
  await db.prepare('UPDATE machines SET name = ? WHERE user_id = ? AND id = ?').bind(name, userId, machineId).run();
}

/** Removes a machine, its data and its sign-in. A running agent is signed out on its next sync. */
export async function deleteMachine(db: Db, userId: string, machineId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM usage_daily WHERE user_id = ? AND machine_id = ?').bind(userId, machineId),
    db.prepare('DELETE FROM tool_totals WHERE user_id = ? AND machine_id = ?').bind(userId, machineId),
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND machine_id = ?').bind(userId, machineId),
    db.prepare('DELETE FROM machines WHERE user_id = ? AND id = ?').bind(userId, machineId),
  ]);
}

/** Each uploaded day replaces that machine's rows for the day, so a retried upload changes nothing. */
export async function saveUsage(db: Db, userId: string, upload: UsageUpload, now: string): Promise<void> {
  const machineId = upload.machine.id;
  const statements: Statement[] = [];
  for (const [day, rows] of Object.entries(upload.days)) {
    statements.push(db.prepare('DELETE FROM usage_daily WHERE user_id = ? AND machine_id = ? AND day = ?').bind(userId, machineId, day));
    for (const [key, row] of Object.entries(rows)) {
      const slash = key.indexOf('/');
      statements.push(
        db
          .prepare(
            'INSERT INTO usage_daily (user_id, machine_id, day, tool, model, input, output, cache_read, cache_write, messages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(userId, machineId, day, key.slice(0, slash), key.slice(slash + 1), row[0], row[1], row[2], row[3], row[4]),
      );
    }
  }
  for (const [tool, figure] of Object.entries(upload.totals)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO tool_totals (user_id, machine_id, tool, payload, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (user_id, machine_id, tool) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
        )
        .bind(userId, machineId, tool, JSON.stringify(figure), now),
    );
  }
  if (upload.timezone) {
    statements.push(db.prepare('UPDATE users SET timezone = ? WHERE id = ?').bind(upload.timezone, userId));
  }
  if (statements.length) await db.batch(statements);
}

export async function loadUsage(db: Db, userId: string): Promise<MachineUsage[]> {
  const machines = new Map<string, MachineUsage>();
  const machine = (id: string) => {
    let found = machines.get(id);
    if (!found) machines.set(id, (found = { id, days: {} }));
    return found;
  };
  const { results: rows } = await db
    .prepare('SELECT machine_id, day, tool, model, input, output, cache_read, cache_write, messages FROM usage_daily WHERE user_id = ?')
    .bind(userId)
    .all<{ machine_id: string; day: string; tool: string; model: string; input: number; output: number; cache_read: number; cache_write: number; messages: number }>();
  for (const row of rows) {
    const day = (machine(row.machine_id).days[row.day] ??= {});
    day[`${row.tool}/${row.model}`] = [row.input, row.output, row.cache_read, row.cache_write, row.messages] as UsageTuple;
  }
  const { results: totals } = await db
    .prepare('SELECT machine_id, tool, payload FROM tool_totals WHERE user_id = ?')
    .bind(userId)
    .all<{ machine_id: string; tool: string; payload: string }>();
  for (const row of totals) {
    const target = machine(row.machine_id);
    (target.totals ??= {})[row.tool] = JSON.parse(row.payload) as ToolTotals;
  }
  return [...machines.values()];
}

export async function saveGitHubStats(db: Db, userId: string, metrics: GitHubMetrics, now: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO github_stats (user_id, payload, collected_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET payload = excluded.payload, collected_at = excluded.collected_at`,
    )
    .bind(userId, JSON.stringify(metrics), now)
    .run();
}

export async function loadGitHubStats(db: Db, userId: string): Promise<{ metrics: GitHubMetrics; collectedAt: string } | null> {
  const row = await db.prepare('SELECT payload, collected_at FROM github_stats WHERE user_id = ?').bind(userId).first<{ payload: string; collected_at: string }>();
  return row ? { metrics: JSON.parse(row.payload) as GitHubMetrics, collectedAt: row.collected_at } : null;
}

const GITHUB_STALE_MS = 6 * 3_600_000;
const LEASE_MS = 30 * 60_000;

/**
 * Only one machine should collect GitHub stats at a time, because a first run costs
 * thousands of API calls. The first agent to sync once they're stale gets a short lease.
 */
export async function claimGitHubCollection(db: Db, userId: string, now: Date): Promise<boolean> {
  const stats = await db.prepare('SELECT collected_at FROM github_stats WHERE user_id = ?').bind(userId).first<{ collected_at: string }>();
  if (stats && now.getTime() - new Date(stats.collected_at).getTime() < GITHUB_STALE_MS) return false;
  const key = `github-lease:${userId}`;
  const lease = await db.prepare('SELECT updated_at FROM kv WHERE key = ?').bind(key).first<{ updated_at: string }>();
  if (lease && now.getTime() - new Date(lease.updated_at).getTime() < LEASE_MS) return false;
  await db
    .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at')
    .bind(key, '1', now.toISOString())
    .run();
  return true;
}
