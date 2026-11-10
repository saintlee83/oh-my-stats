use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};

use crate::api::{Api, ApiError};
use crate::config::Config;
use crate::machine::{MachineInfo, machine_info, sha256_hex};
use crate::store::{Rollup, Store};
use crate::totals::{self, Totals};

const MAX_DAYS_PER_UPLOAD: usize = 90;
const MAX_BYTES_PER_UPLOAD: usize = 1_500_000;
const LAST_UPLOAD_KEY: &str = "sync:last";
const TOTALS_HASH_KEY: &str = "sync:totals";

/// Based on elapsed clock time, so a laptop that slept through its upload catches up on
/// waking. A failed upload isn't recorded, so it's simply tried again.
pub fn upload_due(last: i64, now: i64, interval: i64, force: bool) -> bool {
    force || now < last || now - last >= interval
}

pub fn last_upload(store: &Store) -> Result<i64, SyncError> {
    Ok(store.get(LAST_UPLOAD_KEY).map_err(SyncError::Local)?.and_then(|value| value.parse().ok()).unwrap_or(0))
}

pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_secs() as i64)
}

fn day_json(rows: &std::collections::BTreeMap<String, [i64; 5]>) -> Value {
    json!(rows)
}

/// Splits changed days into uploads the server will accept.
pub fn plan_uploads(rollup: &Rollup, synced: &std::collections::BTreeMap<String, String>) -> Vec<Vec<(String, Value, String)>> {
    let mut batches = Vec::new();
    let mut current = Vec::new();
    let mut bytes = 0;
    for (day, rows) in rollup {
        let value = day_json(rows);
        let text = value.to_string();
        let hash = sha256_hex(&text);
        if synced.get(day) == Some(&hash) {
            continue;
        }
        if current.len() >= MAX_DAYS_PER_UPLOAD || (bytes + text.len() > MAX_BYTES_PER_UPLOAD && !current.is_empty()) {
            batches.push(std::mem::take(&mut current));
            bytes = 0;
        }
        bytes += text.len();
        current.push((day.clone(), value, hash));
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

pub fn build_body(machine: &MachineInfo, timezone: &str, days: &[(String, Value, String)], totals: Option<&Totals>, can_collect_github: bool) -> Value {
    let mut day_map = Map::new();
    for (day, value, _) in days {
        day_map.insert(day.clone(), value.clone());
    }
    json!({
        "machine": machine,
        "timezone": timezone,
        "days": day_map,
        "totals": totals.map_or_else(|| json!({}), |totals| json!(totals)),
        "canCollectGitHub": can_collect_github,
    })
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SyncOutcome {
    pub uploads: usize,
    pub days: usize,
    pub totals_sent: bool,
    pub collect_github: bool,
}

/// Sends what changed. Each day replaces the server's copy for this machine, so a failed
/// upload is simply tried again, and a day is only marked done once the server accepted it.
pub fn sync(store: &mut Store, config: &Config, api: &Api, totals: &Totals) -> Result<SyncOutcome, SyncError> {
    let machine = machine_info(config).map_err(SyncError::Local)?;
    let timezone = config.timezone_name();
    let rollup = store.rollup().map_err(SyncError::Local)?;
    let synced = store.synced_hashes().map_err(SyncError::Local)?;
    let batches = plan_uploads(&rollup, &synced);
    let can_collect_github = crate::github::has_access(config);

    let totals_text = serde_json::to_string(totals).unwrap_or_default();
    let totals_hash = sha256_hex(&totals_text);
    let totals_changed = store.get(TOTALS_HASH_KEY).map_err(SyncError::Local)?.as_deref() != Some(totals_hash.as_str());
    let now = now_secs();
    let mut outcome = SyncOutcome::default();

    let mut send = |days: &[(String, Value, String)], with_totals: bool| -> Result<(), SyncError> {
        let body = build_body(&machine, &timezone, days, with_totals.then_some(totals), can_collect_github);
        let reply = api.send("PUT", "/v1/usage", &body).map_err(SyncError::Api)?;
        outcome.uploads += 1;
        outcome.days += days.len();
        outcome.collect_github = outcome.collect_github || reply.get("collectGitHub").and_then(Value::as_bool).unwrap_or(false);
        let done: Vec<(String, String)> = days.iter().map(|(day, _, hash)| (day.clone(), hash.clone())).collect();
        store.mark_synced(&done).map_err(SyncError::Local)?;
        if with_totals {
            outcome.totals_sent = true;
            store.set(TOTALS_HASH_KEY, &totals_hash).map_err(SyncError::Local)?;
        }
        Ok(())
    };

    if batches.is_empty() {
        send(&[], totals_changed)?;
    } else {
        for (index, batch) in batches.iter().enumerate() {
            send(batch, index == 0 && totals_changed)?;
        }
    }
    store.set(LAST_UPLOAD_KEY, &now.to_string()).map_err(SyncError::Local)?;
    Ok(outcome)
}

#[derive(Debug)]
pub enum SyncError {
    Api(ApiError),
    Local(anyhow::Error),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Api(error) => write!(f, "{error}"),
            SyncError::Local(error) => write!(f, "{error:#}"),
        }
    }
}

impl std::error::Error for SyncError {}

pub fn signed_in_api(config: &Config) -> Result<Api> {
    let server = config.server.as_deref().context("Not signed in. Run `oms login`.")?;
    let token = config.token.clone().context("Not signed in. Run `oms login`.")?;
    Ok(Api::new(server, Some(token)))
}

pub fn run_once(store: &mut Store, config: &Config, api: &Api, roots: &crate::scan::LogRoots, force: bool) -> Result<(crate::scan::ScanReport, SyncOutcome), SyncError> {
    // Recording is continuous. Uploading, and asking the tools for their totals, is not.
    let report = crate::scan::scan(store, roots, config.timezone()).map_err(SyncError::Local)?;
    if !upload_due(last_upload(store)?, now_secs(), config.upload_interval_secs(), force) {
        return Ok((report, SyncOutcome::default()));
    }
    let totals = totals::collect(store, now_secs(), force).map_err(SyncError::Local)?;
    let outcome = sync(store, config, api, &totals)?;
    Ok((report, outcome))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn rollup(days: usize) -> Rollup {
        (0..days)
            .map(|index| (format!("2026-{:02}-{:02}", index / 28 + 1, index % 28 + 1), BTreeMap::from([("claude/opus".to_string(), [1, 2, 3, 4, 5])])))
            .collect()
    }

    #[test]
    fn uploads_follow_elapsed_time_and_can_be_forced() {
        let day = 86_400;
        assert!(upload_due(0, 1_800_000_000, day, false), "never uploaded");
        assert!(!upload_due(1_000, 1_000 + day - 1, day, false));
        assert!(upload_due(1_000, 1_000 + day, day, false));
        assert!(upload_due(1_000, 1_000 + 3 * day, day, false), "a machine that slept catches up");
        assert!(upload_due(1_000, 1_001, day, true), "oms sync goes right away");
        assert!(upload_due(5_000, 1_000, day, false), "a clock moved backwards can't stall uploads");
    }

    #[test]
    fn the_default_is_once_a_day_with_a_sensible_minimum() {
        assert_eq!(Config::default().upload_interval_secs(), 86_400);
        let hourly = Config { upload_interval_minutes: Some(60), ..Default::default() };
        assert_eq!(hourly.upload_interval_secs(), 3_600);
        let reckless = Config { upload_interval_minutes: Some(0), ..Default::default() };
        assert_eq!(reckless.upload_interval_secs(), 300);
    }

    #[test]
    fn only_changed_days_are_planned() {
        let mut days = rollup(3);
        let first = plan_uploads(&days, &BTreeMap::new());
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].len(), 3);

        let synced: BTreeMap<String, String> = first[0].iter().map(|(day, _, hash)| (day.clone(), hash.clone())).collect();
        assert!(plan_uploads(&days, &synced).is_empty(), "nothing changed");

        days.get_mut("2026-01-02").unwrap().get_mut("claude/opus").unwrap()[0] = 99;
        let next = plan_uploads(&days, &synced);
        assert_eq!(next[0].iter().map(|(day, _, _)| day.as_str()).collect::<Vec<_>>(), vec!["2026-01-02"]);
    }

    #[test]
    fn a_long_history_is_split_into_uploads_the_server_accepts() {
        let batches = plan_uploads(&rollup(250), &BTreeMap::new());
        assert_eq!(batches.len(), 3);
        assert!(batches.iter().all(|batch| batch.len() <= MAX_DAYS_PER_UPLOAD));
        assert_eq!(batches.iter().map(Vec::len).sum::<usize>(), 250);
    }

    #[test]
    fn the_upload_matches_the_servers_format() {
        let machine = MachineInfo { id: "a".repeat(32), name: "Mac".into(), platform: "macos".into(), agent_version: "0.1.0".into() };
        let days = plan_uploads(&rollup(1), &BTreeMap::new()).remove(0);
        let body = build_body(&machine, "Asia/Seoul", &days, None, false);
        assert_eq!(body["machine"]["agentVersion"], "0.1.0");
        assert_eq!(body["timezone"], "Asia/Seoul");
        assert_eq!(body["days"]["2026-01-01"]["claude/opus"], json!([1, 2, 3, 4, 5]));
        assert_eq!(body["totals"], json!({}));
        assert_eq!(body["canCollectGitHub"], false);
    }
}
