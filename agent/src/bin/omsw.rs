//! Runs the agent in the background on Windows, the way `pythonw` runs Python.
//!
//! `oms service install` makes this a startup app. It has no console window, so nothing
//! appears on screen at login. It starts `oms daemon` with a hidden console, so the tools
//! the agent runs, such as `gh` and `codex`, stay hidden too. Like launchd and systemd do
//! elsewhere, it restarts the agent a minute after it stops.

#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    use std::fs::OpenOptions;
    use std::io::ErrorKind;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

    // The only argument is the log file, chosen by `oms service install`.
    let Some(log_file) = std::env::args_os().nth(1) else { std::process::exit(2) };
    let Ok(agent) = std::env::current_exe().map(|path| path.with_file_name("oms.exe")) else { std::process::exit(1) };
    loop {
        let run = OpenOptions::new().create(true).append(true).open(&log_file).and_then(|log| {
            Command::new(&agent)
                .arg("daemon")
                .stdin(Stdio::null())
                .stdout(log.try_clone()?)
                .stderr(log)
                .creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS)
                .status()
        });
        // The agent or its folder was removed, so there is nothing left to run.
        if run.is_err_and(|error| error.kind() == ErrorKind::NotFound) {
            return;
        }
        std::thread::sleep(Duration::from_secs(60));
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("omsw runs the agent in the background on Windows. Use `oms service install` instead.");
    std::process::exit(2);
}
