use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Settings and sign-in for this machine. Holds tokens, so it is only readable by the owner.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub server: Option<String>,
    /// Signs this machine in to the server. Can only report usage; it can't read GitHub.
    pub token: Option<String>,
    pub login: Option<String>,
    pub machine_name: Option<String>,
    pub timezone: Option<String>,
    /// Optional, for collecting GitHub stats without the GitHub CLI. It never leaves this machine.
    pub github_token: Option<String>,
    pub github_client_id: Option<String>,
    pub named_coauthors: Vec<String>,
    pub agent_coauthors: Vec<String>,
    pub exclude_languages: Vec<String>,
    pub max_commit_lines: Option<i64>,
    pub max_file_lines: Option<i64>,
    pub max_requests_per_run: Option<usize>,
}

pub fn home_dir() -> Result<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).context("HOME is not set")
}

/// Where this agent keeps its state. Override with OMS_HOME.
pub fn state_dir() -> Result<PathBuf> {
    let dir = match std::env::var_os("OMS_HOME").filter(|value| !value.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => home_dir()?.join(".oh-my-stats"),
    };
    fs::create_dir_all(&dir).with_context(|| format!("could not create {}", dir.display()))?;
    restrict(&dir, 0o700);
    Ok(dir)
}

#[cfg(unix)]
fn restrict(path: &std::path::Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn restrict(_path: &std::path::Path, _mode: u32) {}

impl Config {
    pub fn load() -> Result<Self> {
        let path = state_dir()?.join("config.json");
        if !path.exists() {
            return Ok(Self::default());
        }
        let text = fs::read_to_string(&path).with_context(|| format!("could not read {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("{} is not valid JSON", path.display()))
    }

    pub fn save(&self) -> Result<()> {
        let dir = state_dir()?;
        let temp = dir.join("config.json.tmp");
        fs::write(&temp, serde_json::to_string_pretty(self)?)?;
        restrict(&temp, 0o600);
        fs::rename(&temp, dir.join("config.json"))?;
        Ok(())
    }

    pub fn timezone_name(&self) -> String {
        std::env::var("OMS_TIMEZONE")
            .ok()
            .filter(|value| !value.is_empty())
            .or_else(|| self.timezone.clone())
            .or_else(|| iana_time_zone::get_timezone().ok())
            .unwrap_or_else(|| "UTC".to_string())
    }

    pub fn timezone(&self) -> chrono_tz::Tz {
        self.timezone_name().parse().unwrap_or(chrono_tz::UTC)
    }
}
