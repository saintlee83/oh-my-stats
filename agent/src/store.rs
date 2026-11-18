use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::machine::sha256_hex;
use crate::parse::{CodexState, UsageEvent};

/// date -> "tool/model" -> [input, output, cacheRead, cacheWrite, messages]
pub type Rollup = BTreeMap<String, BTreeMap<String, [i64; 5]>>;

/// The local record of usage. Each model response is kept here once, so history survives
/// when AI tools delete their logs. It holds only numbers, model names and opaque hashes.
pub struct Store {
    conn: Connection,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Cursor {
    #[serde(flatten)]
    pub codex: CodexState,
    pub identity: String,
    pub boundary: String,
}

#[derive(Default)]
pub struct FileRow {
    pub size: i64,
    pub mtime: i64,
    pub offset: i64,
    pub state: Cursor,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS files (
               path_hash TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
               offset INTEGER NOT NULL, state TEXT NOT NULL DEFAULT '{}');
             CREATE TABLE IF NOT EXISTS events (
               key TEXT PRIMARY KEY, file TEXT NOT NULL, tool TEXT NOT NULL, model TEXT NOT NULL,
               day TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
               cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
               responses INTEGER NOT NULL DEFAULT 1) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS events_file ON events (file);
             CREATE TABLE IF NOT EXISTS usage_counters (
               key TEXT PRIMARY KEY, input INTEGER NOT NULL, output INTEGER NOT NULL,
               cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, responses INTEGER NOT NULL) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS synced_days (day TEXT PRIMARY KEY, hash TEXT NOT NULL) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS churn (oid TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID;",
        )?;
        // A daemon and a foreground preview can open an older database together.
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('events') WHERE name = 'responses')", [], |r| r.get::<_, bool>(0))? {
            tx.execute("ALTER TABLE events ADD COLUMN responses INTEGER NOT NULL DEFAULT 1", [])?;
        }
        tx.commit()?;
        Ok(Self { conn })
    }

    pub fn file(&self, path_hash: &str) -> Result<Option<FileRow>> {
        Ok(self
            .conn
            .query_row("SELECT size, mtime, offset, state FROM files WHERE path_hash = ?1", [path_hash], |row| {
                let state: String = row.get(3)?;
                Ok(FileRow {
                    size: row.get(0)?,
                    mtime: row.get(1)?,
                    offset: row.get(2)?,
                    state: serde_json::from_str(&state).unwrap_or_default(),
                })
            })
            .optional()?)
    }

    /// Saves a file's new position together with its events, so a crash can't skip or
    /// half-apply a read. Returns how many events were new or more complete than before.
    pub fn save_read(
        &mut self,
        path_hash: &str,
        file: &FileRow,
        old_paths: &[String],
        events: &[(UsageEvent, String)],
        first_model: Option<&str>,
    ) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let mut changed = 0;
        {
            let mut insert = tx.prepare_cached(
                "INSERT INTO events (key, file, tool, model, day, input, output, cache_read, cache_write, responses)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT (key) DO UPDATE SET
                   model = excluded.model, day = excluded.day, input = excluded.input, output = excluded.output,
                   cache_read = excluded.cache_read, cache_write = excluded.cache_write, responses = excluded.responses
                 WHERE excluded.output > events.output
                    OR (excluded.output = events.output AND events.model = 'unknown' AND excluded.model <> 'unknown')",
            )?;
            // An old path may have since been reused by a different session.
            let old_row = "key = ?1 AND file = ?2 AND day = ?3 AND input = ?4 AND output = ?5 AND cache_read = ?6 AND cache_write = ?7";
            let mut move_key = tx.prepare_cached(&format!("UPDATE OR IGNORE events SET key = ?8, file = ?9 WHERE {old_row}"))?;
            let mut remove_duplicate = tx.prepare_cached(&format!("DELETE FROM events WHERE {old_row}"))?;
            for (event, day) in events {
                // Keys come from response ids; hashing keeps the table small and opaque.
                let key = &sha256_hex(&event.key)[..24];
                if let Some(responses) = event.cumulative_responses {
                    // Hermes stores cumulative session/model counters. Add only the
                    // growth since the last scan, on the latest recorded call's day.
                    let current = [event.input, event.output, event.cache_read, event.cache_write, responses];
                    let previous: [i64; 5] = tx.query_row(
                        "SELECT input, output, cache_read, cache_write, responses FROM usage_counters WHERE key=?1",
                        [key], |r| Ok([r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?])
                    ).optional()?.unwrap_or_default();
                    if current == previous || current.iter().zip(previous).any(|(now, old)| *now < old) {
                        continue;
                    }
                    let delta: [i64; 5] = std::array::from_fn(|i| current[i] - previous[i]);
                    tx.execute("INSERT OR REPLACE INTO usage_counters VALUES (?1,?2,?3,?4,?5,?6)",
                        params![key, current[0], current[1], current[2], current[3], current[4]])?;
                    changed += tx.execute(
                        "INSERT INTO events (key,file,tool,model,day,input,output,cache_read,cache_write,responses)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
                         ON CONFLICT(key) DO UPDATE SET input=input+excluded.input, output=output+excluded.output,
                         cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write,
                         responses=responses+excluded.responses",
                        params![format!("{key}:{day}"), path_hash, event.tool, event.model, day,
                            delta[0], delta[1], delta[2], delta[3], delta[4]])?;
                    continue;
                }
                if let Some(total) = event.legacy_total {
                    for file in old_paths {
                        let old_key = sha256_hex(&format!("codex:{file}:{total}"));
                        let moved = move_key.execute(params![
                            &old_key[..24], file, day, event.input, event.output, event.cache_read, event.cache_write, key, path_hash
                        ])?;
                        if moved == 0 {
                            remove_duplicate.execute(params![&old_key[..24], file, day, event.input, event.output, event.cache_read, event.cache_write])?;
                        }
                    }
                }
                changed += insert.execute(params![
                    key,
                    path_hash,
                    event.tool,
                    event.model,
                    day,
                    event.input,
                    event.output,
                    event.cache_read,
                    event.cache_write,
                    1
                ])?;
            }
            if let Some(model) = first_model {
                tx.execute("UPDATE events SET model = ?1 WHERE file = ?2 AND model = 'unknown'", params![model, path_hash])?;
            }
            tx.execute(
                "INSERT INTO files (path_hash, size, mtime, offset, state) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (path_hash) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
                   offset = excluded.offset, state = excluded.state",
                params![path_hash, file.size, file.mtime, file.offset, serde_json::to_string(&file.state)?],
            )?;
        }
        tx.commit()?;
        Ok(changed)
    }

    pub fn rollup(&self) -> Result<Rollup> {
        let mut statement = self.conn.prepare(
            "SELECT day, tool, model, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), SUM(responses)
             FROM events GROUP BY day, tool, model",
        )?;
        let rows = statement.query_map([], |row| {
            let values: [i64; 5] = [row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?];
            Ok((row.get::<_, String>(0)?, format!("{}/{}", row.get::<_, String>(1)?, row.get::<_, String>(2)?), values))
        })?;
        let mut out = Rollup::new();
        for row in rows {
            let (day, key, values) = row?;
            out.entry(day).or_default().insert(key, values);
        }
        Ok(out)
    }

    pub fn event_count(&self) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COALESCE(SUM(responses),0) FROM events", [], |row| row.get(0))?)
    }

    pub fn synced_hashes(&self) -> Result<BTreeMap<String, String>> {
        let mut statement = self.conn.prepare("SELECT day, hash FROM synced_days")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn mark_synced(&mut self, days: &[(String, String)]) -> Result<()> {
        let tx = self.conn.transaction()?;
        for (day, hash) in days {
            tx.execute(
                "INSERT INTO synced_days (day, hash) VALUES (?1, ?2) ON CONFLICT (day) DO UPDATE SET hash = excluded.hash",
                params![day, hash],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Forgets what the server has, so the next sync re-sends everything. Local history stays.
    pub fn reset_sync(&self) -> Result<()> {
        self.conn.execute_batch("DELETE FROM synced_days; DELETE FROM kv WHERE key LIKE 'sync:%';")?;
        Ok(())
    }

    pub fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| row.get(0)).optional()?)
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn churn_for(&self, oid: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT data FROM churn WHERE oid = ?1", [oid], |row| row.get(0)).optional()?)
    }

    pub fn save_churn(&mut self, rows: &[(String, String)]) -> Result<()> {
        let tx = self.conn.transaction()?;
        for (oid, data) in rows {
            tx.execute(
                "INSERT INTO churn (oid, data) VALUES (?1, ?2) ON CONFLICT (oid) DO UPDATE SET data = excluded.data",
                params![oid, data],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
pub fn temp_store() -> Store {
    Store::open(Path::new(":memory:")).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::CLAUDE;

    fn event(key: &str, output: i64) -> (UsageEvent, String) {
        (
            UsageEvent { key: key.into(), at: "t".into(), tool: CLAUDE.into(), legacy_total: None, cumulative_responses: None, model: "m".into(), input: 1, output, cache_read: 2, cache_write: 3 },
            "2026-11-09".to_string(),
        )
    }

    fn save(store: &mut Store, file: &str, events: &[(UsageEvent, String)]) {
        store.save_read(file, &FileRow::default(), &[], events, None).unwrap();
    }

    #[test]
    fn a_repeated_response_counts_once_and_keeps_its_finished_row() {
        let mut store = temp_store();
        save(&mut store, "a", &[event("k", 5), event("k", 40), event("k", 7)]);
        save(&mut store, "b", &[event("k", 9)]); // Copied into a resumed session.
        assert_eq!(store.event_count().unwrap(), 1);
        assert_eq!(store.rollup().unwrap()["2026-11-09"]["claude/m"], [1, 40, 2, 3, 1]);
    }

    #[test]
    fn distinct_responses_add_up() {
        let mut store = temp_store();
        save(&mut store, "a", &[event("k1", 5), event("k2", 7)]);
        assert_eq!(store.rollup().unwrap()["2026-11-09"]["claude/m"], [2, 12, 4, 6, 2]);
    }

    #[test]
    fn a_later_model_name_backfills_this_file_only() {
        let mut store = temp_store();
        let unknown = |key: &str| {
            let (mut usage, day) = event(key, 1);
            usage.model = "unknown".into();
            (usage, day)
        };
        save(&mut store, "a", &[unknown("k1")]);
        save(&mut store, "b", &[unknown("k2")]);
        store.save_read("a", &FileRow::default(), &[], &[], Some("gpt-6")).unwrap();
        let rollup = store.rollup().unwrap();
        assert_eq!(rollup["2026-11-09"]["claude/gpt-6"][4], 1);
        assert_eq!(rollup["2026-11-09"]["claude/unknown"][4], 1);
    }

    #[test]
    fn resetting_sync_keeps_history() {
        let mut store = temp_store();
        save(&mut store, "a", &[event("k", 1)]);
        store.mark_synced(&[("2026-11-09".into(), "h".into())]).unwrap();
        store.set("sync:totals", "x").unwrap();
        store.set("codex:checked", "y").unwrap();
        store.reset_sync().unwrap();
        assert!(store.synced_hashes().unwrap().is_empty());
        assert_eq!(store.get("sync:totals").unwrap(), None);
        assert_eq!(store.get("codex:checked").unwrap().as_deref(), Some("y"));
        assert_eq!(store.event_count().unwrap(), 1);
    }
}
