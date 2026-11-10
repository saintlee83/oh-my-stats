//! Lifetime figures reported by the tools themselves. Logs get deleted and only cover one
//! machine, so counting them alone under-reports badly. These readers return None on any
//! problem: a missing figure must never stop a sync, and the last known value is kept.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::home_dir;
use crate::store::Store;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolTotals {
    /// "machine" covers this computer. "account" covers every device on the account.
    pub scope: String,
    pub total: i64,
    #[serde(rename = "asOf")]
    pub as_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<BTreeMap<String, [i64; 4]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daily: Option<BTreeMap<String, i64>>,
}

pub type Totals = BTreeMap<String, ToolTotals>;

fn is_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10 && bytes[4] == b'-' && bytes[7] == b'-' && text.chars().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn number(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0).map_or(0, |n| n as i64)
}

pub fn default_claude_dirs() -> Result<Vec<PathBuf>> {
    let home = home_dir()?;
    Ok(match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty()) {
        Some(dir) => vec![PathBuf::from(dir)],
        None => vec![home.join(".claude"), home.join(".config/claude")],
    })
}

/// Claude Code keeps running statistics in stats-cache.json, which its usage view reads.
/// They outlive transcript cleanup, but the format isn't a public contract, so anything
/// unexpected counts as unavailable.
pub fn read_claude_stats(dirs: &[PathBuf]) -> Option<ToolTotals> {
    for dir in dirs {
        let Ok(text) = fs::read_to_string(dir.join("stats-cache.json")) else { continue };
        let stats: Value = serde_json::from_str(&text).ok()?;
        let usage = stats.get("modelUsage")?.as_object()?;

        let mut models = BTreeMap::new();
        let mut total = 0;
        for (model, row) in usage {
            let values = [
                number(row.get("inputTokens")),
                number(row.get("outputTokens")),
                number(row.get("cacheReadInputTokens")),
                number(row.get("cacheCreationInputTokens")),
            ];
            let sum: i64 = values.iter().sum();
            if sum > 0 {
                models.insert(model.clone(), values);
                total += sum;
            }
        }
        if total == 0 {
            return None;
        }

        let mut daily = BTreeMap::new();
        for entry in stats.get("dailyModelTokens").and_then(Value::as_array).into_iter().flatten() {
            let Some(date) = entry.get("date").and_then(Value::as_str).filter(|date| is_date(date)) else { continue };
            let sum: i64 = entry.get("tokensByModel").and_then(Value::as_object).into_iter().flatten().map(|(_, value)| number(Some(value))).sum();
            if sum > 0 {
                daily.insert(date.to_string(), sum);
            }
        }
        let as_of = stats
            .get("lastComputedDate")
            .and_then(Value::as_str)
            .filter(|date| is_date(date))
            .map(str::to_string)
            .or_else(|| daily.keys().next_back().cloned());
        return Some(ToolTotals { scope: "machine".into(), total, as_of, models: Some(models), daily: Some(daily) });
    }
    None
}

fn parse_account_usage(result: &Value) -> Option<ToolTotals> {
    let total = number(result.pointer("/summary/lifetimeTokens"));
    if total == 0 {
        return None;
    }
    let mut daily = BTreeMap::new();
    for bucket in result.get("dailyUsageBuckets").and_then(Value::as_array).into_iter().flatten() {
        let date: String = bucket.get("startDate").and_then(Value::as_str).unwrap_or("").chars().take(10).collect();
        let tokens = number(bucket.get("tokens"));
        if is_date(&date) && tokens > 0 {
            *daily.entry(date).or_insert(0) += tokens;
        }
    }
    let as_of = daily.keys().next_back().cloned();
    Some(ToolTotals { scope: "account".into(), total, as_of, models: None, daily: Some(daily) })
}

fn codex_command(program: &str, args: &[String]) -> Command {
    let mut command = Command::new(program);
    // Codex has no use for the token that reads this user's repositories.
    command.args(args).env_remove("OMS_GITHUB_TOKEN").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    command
}

fn spawn_codex(program: &str, args: &[String]) -> Option<Child> {
    match codex_command(program, args).spawn() {
        Ok(child) => Some(child),
        // npm installs Codex on Windows as codex.cmd, which the bare name doesn't find.
        Err(error) if cfg!(windows) && error.kind() == ErrorKind::NotFound && Path::new(program).extension().is_none() => {
            codex_command(&format!("{program}.cmd"), args).spawn().ok()
        }
        Err(_) => None,
    }
}

/// The figure behind Codex's `/usage`: the account's lifetime total, across every device.
/// It comes from the user's own CLI over its documented app-server protocol, so this agent
/// never touches Codex credentials. Accounts without usage analytics report nothing.
pub fn read_codex_account(command: &[String], timeout: Duration) -> Option<ToolTotals> {
    let (program, args) = command.split_first()?;
    let mut child = spawn_codex(program, args)?;
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;

    let (sender, receiver) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { return };
            if let Ok(message) = serde_json::from_str::<Value>(&line)
                && sender.send(message).is_err()
            {
                return;
            }
        }
    });

    let mut send = |message: Value| writeln!(stdin, "{message}").and_then(|()| stdin.flush()).is_ok();
    let hello = json!({ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "oh_my_stats", "title": "oh-my-stats", "version": env!("CARGO_PKG_VERSION") } } });
    let mut result = None;
    if send(hello) {
        let deadline = Instant::now() + timeout;
        loop {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else { break };
            let Ok(message) = receiver.recv_timeout(left) else { break };
            match message.get("id").and_then(Value::as_i64) {
                Some(1) => {
                    if message.get("error").is_some() || !send(json!({ "method": "initialized" })) || !send(json!({ "id": 2, "method": "account/usage/read" })) {
                        break;
                    }
                }
                Some(2) => {
                    if message.get("error").is_none() {
                        result = message.get("result").and_then(parse_account_usage);
                    }
                    break;
                }
                _ => {}
            }
        }
    }
    // Closing its input lets Codex exit by itself, including from behind codex.cmd on Windows.
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    result
}

/// Lifetime totals only grow, so the larger figure wins and known days are kept.
pub fn merge(known: &Totals, fresh: &Totals) -> Totals {
    let mut merged = known.clone();
    for (tool, next) in fresh {
        let entry = match merged.get(tool) {
            Some(current) if current.total > next.total => {
                let mut kept = current.clone();
                merge_daily(&mut kept, next);
                kept
            }
            Some(current) => {
                let mut kept = next.clone();
                merge_daily(&mut kept, current);
                kept
            }
            None => next.clone(),
        };
        merged.insert(tool.clone(), entry);
    }
    merged
}

fn merge_daily(target: &mut ToolTotals, other: &ToolTotals) {
    let Some(days) = &other.daily else { return };
    let daily = target.daily.get_or_insert_with(BTreeMap::new);
    for (date, value) in days {
        let slot = daily.entry(date.clone()).or_insert(0);
        *slot = (*slot).max(*value);
    }
}

const TOTALS_KEY: &str = "totals";
const CODEX_CHECKED_KEY: &str = "codex:checked";
const CODEX_INTERVAL_SECS: i64 = 3600;

/// Refreshes this machine's figures and returns the best known. Codex is asked at most
/// hourly, because that starts a process and calls its servers.
pub fn collect(store: &Store, now_secs: i64, force: bool) -> Result<Totals> {
    let known: Totals = store.get(TOTALS_KEY)?.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    let mut fresh = Totals::new();
    if let Some(claude) = read_claude_stats(&default_claude_dirs()?) {
        fresh.insert("claude".into(), claude);
    }
    let checked: i64 = store.get(CODEX_CHECKED_KEY)?.and_then(|value| value.parse().ok()).unwrap_or(0);
    if force || now_secs - checked >= CODEX_INTERVAL_SECS {
        store.set(CODEX_CHECKED_KEY, &now_secs.to_string())?;
        let command = vec!["codex".to_string(), "app-server".to_string()];
        if let Some(codex) = read_codex_account(&command, Duration::from_secs(30)) {
            fresh.insert("codex".into(), codex);
        }
    }
    let merged = merge(&known, &fresh);
    store.set(TOTALS_KEY, &serde_json::to_string(&merged)?)?;
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("oms-totals-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn claude_statistics_give_lifetime_totals_per_model_and_day() {
        let dir = temp_dir("stats");
        fs::write(
            dir.join("stats-cache.json"),
            r#"{"lastComputedDate":"2026-11-08","dailyModelTokens":[{"date":"2026-10-01","tokensByModel":{"a":100,"b":50}},{"date":"bad","tokensByModel":{"a":9}}],
                "modelUsage":{"a":{"inputTokens":1,"outputTokens":2,"cacheReadInputTokens":3,"cacheCreationInputTokens":4},"empty":{"inputTokens":0}}}"#,
        )
        .unwrap();
        let totals = read_claude_stats(&[dir]).unwrap();
        assert_eq!(totals.scope, "machine");
        assert_eq!(totals.total, 10);
        assert_eq!(totals.as_of.as_deref(), Some("2026-11-08"));
        assert_eq!(totals.models.unwrap()["a"], [1, 2, 3, 4]);
        assert_eq!(totals.daily.unwrap(), BTreeMap::from([("2026-10-01".to_string(), 150)]));
    }

    #[test]
    fn an_unusable_statistics_file_counts_as_unavailable() {
        assert_eq!(read_claude_stats(&[temp_dir("missing")]), None);
        for (label, content) in [("corrupt", "{nope"), ("format", r#"{"version":99}"#), ("empty", r#"{"modelUsage":{"a":{"inputTokens":"lots"}}}"#)] {
            let dir = temp_dir(label);
            fs::write(dir.join("stats-cache.json"), content).unwrap();
            assert_eq!(read_claude_stats(&[dir]), None, "{label}");
        }
    }

    fn fake_codex(label: &str, body: &str) -> Vec<String> {
        let script = temp_dir(label).join("fake-codex.sh");
        fs::write(&script, body).unwrap();
        vec!["sh".to_string(), script.to_string_lossy().to_string()]
    }

    const GOOD: &str = r#"read line; echo 'not json'; echo '{"id":1,"result":{}}'; read line; read line;
echo '{"id":2,"result":{"summary":{"lifetimeTokens":26308612616},"dailyUsageBuckets":[{"startDate":"2026-07-11","tokens":100},{"startDate":"2026-11-08","tokens":200},{"startDate":"x","tokens":5}]}}'"#;

    #[test]
    fn codex_does_not_inherit_the_github_token() {
        let command = codex_command("codex", &[]);
        assert!(command.get_envs().any(|(key, value)| key.to_str() == Some("OMS_GITHUB_TOKEN") && value.is_none()));
    }

    #[test]
    fn codex_account_usage_comes_through_its_protocol() {
        let totals = read_codex_account(&fake_codex("good", GOOD), Duration::from_secs(5)).unwrap();
        assert_eq!(totals.scope, "account");
        assert_eq!(totals.total, 26308612616);
        assert_eq!(totals.as_of.as_deref(), Some("2026-11-08"));
        assert_eq!(totals.daily.unwrap().len(), 2);
    }

    #[test]
    fn codex_problems_count_as_unavailable_and_never_hang() {
        let timeout = Duration::from_secs(3);
        assert_eq!(read_codex_account(&["/nonexistent/codex".to_string()], timeout), None);
        assert_eq!(read_codex_account(&fake_codex("exit", "exit 0"), timeout), None);
        let init_error = r#"read line; echo '{"id":1,"error":{"message":"no"}}'"#;
        assert_eq!(read_codex_account(&fake_codex("init", init_error), timeout), None);
        let signed_out = r#"read line; echo '{"id":1,"result":{}}'; read line; read line; echo '{"id":2,"error":{"message":"sign in"}}'"#;
        assert_eq!(read_codex_account(&fake_codex("signedout", signed_out), timeout), None);
        let no_data = r#"read line; echo '{"id":1,"result":{}}'; read line; read line; echo '{"id":2,"result":{"summary":{"lifetimeTokens":null}}}'"#;
        assert_eq!(read_codex_account(&fake_codex("nodata", no_data), timeout), None);
        let started = Instant::now();
        assert_eq!(read_codex_account(&fake_codex("hang", "sleep 30"), Duration::from_millis(300)), None);
        assert!(started.elapsed() < Duration::from_secs(5), "a stuck process is killed");
    }

    #[test]
    fn totals_only_grow_and_known_days_survive() {
        let figure = |total: i64, date: &str, value: i64| ToolTotals {
            scope: "machine".into(),
            total,
            as_of: Some(date.into()),
            models: None,
            daily: Some(BTreeMap::from([(date.to_string(), value)])),
        };
        let known = Totals::from([("claude".to_string(), figure(100, "2026-09-01", 40))]);
        let fresh = Totals::from([("claude".to_string(), figure(150, "2026-11-01", 50))]);
        let merged = merge(&known, &fresh);
        assert_eq!(merged["claude"].total, 150);
        assert_eq!(merged["claude"].as_of.as_deref(), Some("2026-11-01"));
        assert_eq!(merged["claude"].daily.as_ref().unwrap().len(), 2);
        assert_eq!(merge(&fresh, &known)["claude"].total, 150, "never shrinks");
        assert_eq!(merge(&known, &Totals::new())["claude"].total, 100, "a missing source changes nothing");
    }
}
