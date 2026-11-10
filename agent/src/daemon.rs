use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::Duration;

use anyhow::{Result, bail};
use serde_json::Value;

use crate::config::{Config, state_dir};
use crate::github;
use crate::scan::default_roots;
use crate::store::Store;
use crate::sync::{SyncError, last_upload, now_secs, run_once, signed_in_api};
use crate::api::ApiError;

fn log(message: &str) {
    eprintln!("[{}] {message}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
}

fn pid_alive(pid: &str) -> bool {
    if pid.is_empty() || !pid.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    if cfg!(windows) {
        return windows_processes(&format!("PID eq {pid}")).iter().any(|(_, found)| found == pid);
    }
    Command::new("kill").args(["-0", pid]).stderr(Stdio::null()).status().is_ok_and(|status| status.success())
}

/// The processes `tasklist` finds for a filter such as "PID eq 42", as (program, pid).
pub fn windows_processes(filter: &str) -> Vec<(String, String)> {
    let Ok(output) = Command::new("tasklist").args(["/FI", filter, "/FO", "CSV", "/NH"]).stderr(Stdio::null()).output() else { return Vec::new() };
    tasklist_rows(&String::from_utf8_lossy(&output.stdout))
}

/// Rows look like "oms.exe","42","Console","1","10,240 K". Finding nothing prints a message
/// in the system's language instead, so only rows count.
fn tasklist_rows(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim().strip_prefix('"')?.split("\",\"");
            Some((fields.next()?.to_string(), fields.next()?.to_string()))
        })
        .collect()
}

/// Two agents reading the same logs would be harmless but wasteful, so only one runs.
fn take_lock(path: &Path) -> Result<()> {
    if let Ok(pid) = fs::read_to_string(path) {
        let pid = pid.trim();
        if pid != std::process::id().to_string() && pid_alive(pid) {
            bail!("The agent is already running (pid {pid}).");
        }
    }
    fs::write(path, std::process::id().to_string())?;
    Ok(())
}

/// Collects GitHub stats on its own thread, so a long first run never delays token tracking.
fn collect_github_in_background(running: &Arc<AtomicBool>) {
    if running.swap(true, Ordering::SeqCst) {
        return;
    }
    let running = Arc::clone(running);
    std::thread::spawn(move || {
        let outcome = (|| -> Result<()> {
            let config = Config::load()?;
            let mut store = Store::open(&state_dir()?.join("agent.db"))?;
            github::collect_and_upload(&mut store, &config, &|message: &str| log(message))
        })();
        if let Err(error) = outcome {
            log(&format!("GitHub stats skipped: {error:#}"));
        }
        running.store(false, Ordering::SeqCst);
    });
}

/// Runs for as long as the machine is on: reads new log lines and uploads what changed.
/// Server outages only delay uploads, because everything is kept locally until accepted.
pub fn run(interval_secs: u64) -> Result<()> {
    let dir = state_dir()?;
    take_lock(&dir.join("agent.lock"))?;
    let roots = default_roots()?;
    let mut store = Store::open(&dir.join("agent.db"))?;
    let github_running = Arc::new(AtomicBool::new(false));
    let mut failures = 0u32;
    log(&format!("Recording usage every {interval_secs} seconds; uploading every {} minutes.", Config::load()?.upload_interval_secs() / 60));

    loop {
        // Reloaded each time, so `oms login` and settings changes apply without a restart.
        let config = Config::load()?;
        let wait = match signed_in_api(&config) {
            Err(error) => {
                log(&format!("{error}"));
                Duration::from_secs(300)
            }
            Ok(api) => match run_once(&mut store, &config, &api, &roots, false) {
                Ok((report, outcome)) => {
                    failures = 0;
                    if report.new_events > 0 {
                        log(&format!("Recorded {} new responses.", report.new_events));
                    }
                    if outcome.uploads > 0 {
                        log(&format!("Uploaded {} days{}.", outcome.days, if outcome.totals_sent { " and lifetime totals" } else { "" }));
                    }
                    if outcome.collect_github {
                        collect_github_in_background(&github_running);
                    }
                    Duration::from_secs(interval_secs)
                }
                Err(SyncError::Api(ApiError::Unauthorized(message))) => {
                    log(&format!("Signed out by the server: {message}"));
                    Duration::from_secs(300)
                }
                Err(error) => {
                    failures = (failures + 1).min(6);
                    log(&format!("Will retry: {error}"));
                    Duration::from_secs((interval_secs * 2u64.pow(failures)).min(1800))
                }
            },
        };
        sleep(wait);
    }
}

pub fn run_once_verbose(force_github: bool) -> Result<()> {
    let config = Config::load()?;
    let api = signed_in_api(&config)?;
    let mut store = Store::open(&state_dir()?.join("agent.db"))?;
    let started = now_secs();
    let (report, outcome) = run_once(&mut store, &config, &api, &default_roots()?, true)?;
    println!(
        "Read {} of {} log files: {} new responses{}.",
        report.read,
        report.files,
        report.new_events,
        if report.failed > 0 { format!(" ({} unreadable)", report.failed) } else { String::new() }
    );
    println!(
        "Uploaded {} days in {} requests{}. Took {}s.",
        outcome.days,
        outcome.uploads,
        if outcome.totals_sent { ", plus lifetime totals" } else { "" },
        now_secs() - started
    );
    if outcome.collect_github || force_github {
        github::collect_and_upload(&mut store, &config, &|message: &str| println!("  {message}"))?;
    }
    Ok(())
}

pub fn print_status() -> Result<()> {
    let config = Config::load()?;
    let store = Store::open(&state_dir()?.join("agent.db"))?;
    println!("Timezone      {}", config.timezone_name());
    println!("Local record  {} model responses", store.event_count()?);
    let Ok(api) = signed_in_api(&config) else {
        println!("Sign-in       not signed in. Run `oms login`.");
        return Ok(());
    };
    println!("Server        {}", config.server.as_deref().unwrap_or("?"));
    let last = last_upload(&store)?;
    if last > 0 {
        let hours = (now_secs() - last) as f64 / 3600.0;
        let next = ((last + config.upload_interval_secs() - now_secs()) as f64 / 3600.0).max(0.0);
        println!("Uploads       last {hours:.1}h ago, next in {next:.1}h. Run `oms sync` to upload now.");
    }
    let me = api.get("/v1/me")?;
    println!("Account       @{}", me.get("login").and_then(Value::as_str).unwrap_or("?"));
    let public = me.get("public").and_then(Value::as_bool).unwrap_or(false);
    let url = me.get("profileUrl").and_then(Value::as_str).unwrap_or("?");
    println!("Profile       {}", if public { format!("public at {url}") } else { "private. Run `oms publish` to share it.".to_string() });
    let billions = |value: Option<f64>| format!("{:.2}B", value.unwrap_or(0.0) / 1e9);
    if let Some(total) = me.pointer("/tokens/total").and_then(Value::as_f64) {
        println!("Tokens        {}", billions(Some(total)));
        for tool in me.pointer("/tokens/tools").and_then(Value::as_array).into_iter().flatten() {
            println!(
                "  {:<11} {} ({})",
                tool.get("tool").and_then(Value::as_str).unwrap_or("?"),
                billions(tool.get("total").and_then(Value::as_f64)),
                tool.get("scope").and_then(Value::as_str).unwrap_or("?")
            );
        }
    }
    println!("Machines");
    let this = me.get("machine").and_then(Value::as_str).unwrap_or("");
    for machine in me.get("machines").and_then(Value::as_array).into_iter().flatten() {
        let id = machine.get("id").and_then(Value::as_str).unwrap_or("");
        println!(
            "  {} {:<24} {:>9}  last sync {}",
            if id == this { "*" } else { " " },
            machine.get("name").and_then(Value::as_str).unwrap_or("?"),
            billions(machine.get("tokens").and_then(Value::as_f64)),
            machine.get("lastSeenAt").and_then(Value::as_str).unwrap_or("?").chars().take(16).collect::<String>()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_processes_are_read_from_tasklist_rows() {
        let found = "\"oms.exe\",\"4242\",\"Console\",\"1\",\"10,240 K\"\r\n";
        assert_eq!(tasklist_rows(found), vec![("oms.exe".to_string(), "4242".to_string())]);
        assert!(tasklist_rows("INFO: No tasks are running which match the specified criteria.\r\n").is_empty());
    }

    #[test]
    fn a_lock_without_a_process_number_is_stale() {
        for pid in ["", "abc", "1 2", "-1"] {
            assert!(!pid_alive(pid), "{pid:?}");
        }
    }
}
