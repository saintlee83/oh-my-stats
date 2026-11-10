use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};

use crate::config::{home_dir, state_dir};
use crate::daemon::windows_processes;

const LABEL: &str = "dev.oh-my-stats.agent";
const SYSTEMD_UNIT: &str = "oh-my-stats.service";

/// Windows starts what's listed here when you log in, and shows it under Startup apps.
/// Unlike a scheduled task or a service, it needs no administrator rights.
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "oh-my-stats";
/// Installed next to oms.exe. It runs the agent with no console window: see src/bin/omsw.rs.
const LAUNCHER: &str = "omsw.exe";

/// Services start with a minimal PATH, which usually lacks `gh` and `codex`.
fn service_path() -> String {
    std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_string())
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn launchd_plist(binary: &str, log_file: &str, path: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>{}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>{}</string>
  <key>StandardErrorPath</key><string>{}</string>
</dict>
</plist>
"#,
        xml_escape(binary),
        xml_escape(path),
        xml_escape(log_file),
        xml_escape(log_file),
    )
}

pub fn systemd_unit(binary: &str, path: &str) -> String {
    format!(
        "[Unit]\nDescription=oh-my-stats agent\nAfter=network-online.target\n\n[Service]\nExecStart=\"{binary}\" daemon\nEnvironment=\"PATH={path}\"\nRestart=always\nRestartSec=60\nNice=10\n\n[Install]\nWantedBy=default.target\n"
    )
}

/// What Windows runs at login: the launcher, and the log file it writes to.
pub fn run_entry(launcher: &str, log_file: &str) -> String {
    format!("\"{launcher}\" \"{log_file}\"")
}

fn plist_path() -> Result<PathBuf> {
    Ok(home_dir()?.join("Library/LaunchAgents").join(format!("{LABEL}.plist")))
}

fn unit_path() -> Result<PathBuf> {
    Ok(home_dir()?.join(".config/systemd/user").join(SYSTEMD_UNIT))
}

fn uid() -> Result<String> {
    let output = Command::new("id").arg("-u").output().context("could not run `id -u`")?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_quietly(program: &str, args: &[&str]) -> bool {
    Command::new(program).args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|status| status.success())
}

/// Starts the launcher outside this terminal's job where Windows allows it, so closing the
/// terminal doesn't stop the agent. At the next login, Windows starts it anyway.
fn start_launcher(launcher: &Path, log_file: &Path) -> std::io::Result<()> {
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let start = |flags: u32| {
        let mut command = Command::new(launcher);
        command.arg(log_file).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, flags);
        let _ = flags;
        command.spawn().map(drop)
    };
    start(CREATE_BREAKAWAY_FROM_JOB).or_else(|_| start(0))
}

/// Ends the launcher and the agent it started, with anything the agent was running.
fn stop_launcher() {
    run_quietly("taskkill", &["/IM", LAUNCHER, "/T", "/F"]);
}

pub fn install() -> Result<()> {
    let binary = std::env::current_exe()?.to_string_lossy().to_string();
    let path = service_path();
    if cfg!(target_os = "macos") {
        let plist = plist_path()?;
        let log_file = state_dir()?.join("agent.log");
        fs::create_dir_all(plist.parent().context("no parent")?)?;
        fs::write(&plist, launchd_plist(&binary, &log_file.to_string_lossy(), &path))?;
        let target = format!("gui/{}", uid()?);
        let plist_text = plist.to_string_lossy().to_string();
        run_quietly("launchctl", &["bootout", &target, &plist_text]);
        if !run_quietly("launchctl", &["bootstrap", &target, &plist_text]) {
            bail!("launchctl could not start the agent. See {plist_text}");
        }
        println!("The agent now runs in the background and starts when you log in.\nLogs: {}", log_file.display());
    } else if cfg!(target_os = "linux") {
        let unit = unit_path()?;
        fs::create_dir_all(unit.parent().context("no parent")?)?;
        fs::write(&unit, systemd_unit(&binary, &path))?;
        run_quietly("systemctl", &["--user", "daemon-reload"]);
        if !run_quietly("systemctl", &["--user", "enable", "--now", SYSTEMD_UNIT]) {
            bail!("systemctl could not start the agent. See {}", unit.display());
        }
        println!("The agent now runs in the background.\nLogs: journalctl --user -u {SYSTEMD_UNIT}");
    } else if cfg!(windows) {
        let launcher = std::env::current_exe()?.with_file_name(LAUNCHER);
        if !launcher.exists() {
            bail!("{LAUNCHER} should be next to oms.exe, where `cargo install` puts it. Install the agent again.");
        }
        let log_file = state_dir()?.join("agent.log");
        let entry = run_entry(&launcher.to_string_lossy(), &log_file.to_string_lossy());
        if !run_quietly("reg", &["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &entry, "/f"]) {
            bail!("Windows didn't accept the startup entry under {RUN_KEY}.");
        }
        stop_launcher();
        start_launcher(&launcher, &log_file).with_context(|| format!("could not start {}", launcher.display()))?;
        println!("The agent now runs in the background and starts when you log in.\nLogs: {}", log_file.display());
    } else {
        bail!("Background service isn't supported on this platform yet. Run `oms daemon` yourself.");
    }
    Ok(())
}

pub fn uninstall() -> Result<()> {
    if cfg!(target_os = "macos") {
        let plist = plist_path()?;
        if plist.exists() {
            run_quietly("launchctl", &["bootout", &format!("gui/{}", uid()?), &plist.to_string_lossy()]);
            fs::remove_file(&plist)?;
        }
    } else if cfg!(target_os = "linux") {
        run_quietly("systemctl", &["--user", "disable", "--now", SYSTEMD_UNIT]);
        let unit = unit_path()?;
        if unit.exists() {
            fs::remove_file(&unit)?;
        }
    } else if cfg!(windows) {
        run_quietly("reg", &["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
        stop_launcher();
    }
    println!("Removed the background service. Your local history is kept.");
    Ok(())
}

pub fn status() -> Result<()> {
    let running = if cfg!(target_os = "macos") {
        run_quietly("launchctl", &["print", &format!("gui/{}/{LABEL}", uid()?)])
    } else if cfg!(windows) {
        windows_processes(&format!("IMAGENAME eq {LAUNCHER}")).iter().any(|(program, _)| program.eq_ignore_ascii_case(LAUNCHER))
    } else {
        run_quietly("systemctl", &["--user", "is-active", "--quiet", SYSTEMD_UNIT])
    };
    println!("Background service: {}", if running { "running" } else { "not running. Install it with `oms service install`." });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launchd_restarts_the_agent_and_finds_its_tools() {
        let plist = launchd_plist("/opt/oms", "/tmp/a&b.log", "/opt/homebrew/bin:/usr/bin");
        assert!(plist.contains("<string>/opt/oms</string>"));
        assert!(plist.contains("<key>KeepAlive</key><true/>"));
        assert!(plist.contains("/opt/homebrew/bin:/usr/bin"));
        assert!(plist.contains("a&amp;b.log"), "paths are escaped");
    }

    #[test]
    fn the_launchd_file_is_valid_for_macos_itself() {
        let Ok(probe) = Command::new("plutil").arg("-help").stdout(Stdio::null()).stderr(Stdio::null()).status() else { return };
        let _ = probe;
        let path = std::env::temp_dir().join(format!("oms-plist-{}.plist", std::process::id()));
        fs::write(&path, launchd_plist("/opt/my tools/oms", "/tmp/a&b.log", "/usr/bin")).unwrap();
        let status = Command::new("plutil").arg("-lint").arg(&path).stdout(Stdio::null()).status().unwrap();
        let _ = fs::remove_file(&path);
        assert!(status.success());
    }

    #[test]
    fn windows_starts_the_launcher_with_quoted_paths() {
        let entry = run_entry(r"C:\Users\Jane Doe\.cargo\bin\omsw.exe", r"C:\Users\Jane Doe\.oh-my-stats\agent.log");
        assert_eq!(entry, r#""C:\Users\Jane Doe\.cargo\bin\omsw.exe" "C:\Users\Jane Doe\.oh-my-stats\agent.log""#);
    }

    #[test]
    fn systemd_restarts_the_agent() {
        let unit = systemd_unit("/opt/oms", "/usr/bin");
        assert!(unit.contains("ExecStart=\"/opt/oms\" daemon"));
        assert!(unit.contains("Restart=always"));
    }
}
