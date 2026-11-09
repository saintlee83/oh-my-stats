import { PRICES_URL, trimPrices } from '../shared/pricing.ts';
import type { PriceTable } from '../shared/types.ts';
import type { Db } from './db.ts';

const KEY = 'prices';
const MAX_AGE_MS = 24 * 3_600_000;
/** Only families this platform tracks, so the table fits comfortably in one database row. */
const RELEVANT = /^(anthropic\/|openai\/)?(claude|gpt|o\d|codex|chatgpt)/i;

async function refresh(db: Db, fetchImpl: typeof fetch, now: Date): Promise<PriceTable | null> {
  try {
    const response = await fetchImpl(PRICES_URL, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const raw = (await response.json()) as Parameters<typeof trimPrices>[0];
    const table = trimPrices(Object.fromEntries(Object.entries(raw).filter(([model]) => RELEVANT.test(model))));
    await db
      .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .bind(KEY, JSON.stringify(table), now.toISOString())
      .run();
    return table;
  } catch {
    return null;
  }
}

/**
 * Serves stored prices and refreshes them in the background once a day. With no stored
 * copy and no network, costs show as unknown rather than wrong.
 */
export async function loadPrices(db: Db, fetchImpl: typeof fetch, waitUntil: (work: Promise<unknown>) => void, now: Date): Promise<PriceTable> {
  const row = await db.prepare('SELECT value, updated_at FROM kv WHERE key = ?').bind(KEY).first<{ value: string; updated_at: string }>();
  if (!row) return (await refresh(db, fetchImpl, now)) ?? {};
  if (now.getTime() - new Date(row.updated_at).getTime() > MAX_AGE_MS) waitUntil(refresh(db, fetchImpl, now));
  return JSON.parse(row.value) as PriceTable;
}
