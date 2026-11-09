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
use crate::sync::{SyncError, now_secs, run_once, signed_in_api};
use crate::api::ApiError;

fn log(message: &str) {
    eprintln!("[{}] {message}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
}

fn pid_alive(pid: &str) -> bool {
    Command::new("kill").args(["-0", pid]).stderr(Stdio::null()).status().is_ok_and(|status| status.success())
}

/// Two agents reading the same logs would be harmless but wasteful, so only one runs.
fn take_lock(path: &Path) -> Result<()> {
    if let Ok(pid) = fs::read_to_string(path) {
        let pid = pid.trim();
        if !pid.is_empty() && pid != std::process::id().to_string() && pid_alive(pid) {
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
    log(&format!("Watching for token usage every {interval_secs} seconds."));

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
                    if report.new_events > 0 || outcome.uploads > 0 {
                        log(&format!(
                            "{} new responses from {} files; uploaded {} days{}.",
                            report.new_events,
                            report.read,
                            outcome.days,
                            if outcome.totals_sent { " and lifetime totals" } else { "" }
                        ));
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
        "Read {} of {} log files: {} responses{}.",
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
        println!("Sign-in       not signed in. Run `oms login --server <url>`.");
        return Ok(());
    };
    println!("Server        {}", config.server.as_deref().unwrap_or("?"));
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
