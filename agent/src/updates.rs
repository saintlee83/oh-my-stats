use std::io::{self, IsTerminal};
use std::path::Path;
use std::time::Duration;

use semver::Version;
use serde::Deserialize;

use crate::config::{home_dir, state_dir};
use crate::store::Store;
use crate::sync::now_secs;

const LATEST_RELEASE: &str = "https://api.github.com/repos/saintlee83/oh-my-stats/releases/latest";
const INSTALLED: &str = env!("CARGO_PKG_VERSION");

#[derive(Deserialize)]
struct Release {
    tag_name: String,
}

fn newer_release(tag: &str, installed: &str) -> Option<Version> {
    let latest = Version::parse(tag.strip_prefix('v')?).ok()?;
    let current = Version::parse(installed).ok()?;
    (latest.pre.is_empty() && latest.cmp_precedence(&current).is_gt()).then_some(latest)
}

fn available_update() -> Option<Version> {
    let store = Store::open(&state_dir().ok()?.join("agent.db")).ok()?;
    if !store.claim_update_check(now_secs()).ok()? {
        return None;
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(2)))
        .user_agent(concat!("oh-my-stats/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let mut response = agent.get(LATEST_RELEASE).header("accept", "application/vnd.github+json").call().ok()?;
    let release: Release = response.body_mut().read_json().ok()?;
    newer_release(&release.tag_name, INSTALLED)
}

fn install_command(custom_dir: Option<&Path>) -> String {
    if cfg!(windows) {
        let install = "irm https://ohmystats.dev/install.ps1 | iex";
        match custom_dir {
            Some(dir) => format!("$env:OMS_INSTALL_DIR = '{}'\n  {install}", dir.display().to_string().replace('\'', "''")),
            None => install.into(),
        }
    } else {
        let download = "curl -fsSL https://ohmystats.dev/install.sh";
        match custom_dir {
            Some(dir) => format!("{download} | OMS_INSTALL_DIR='{}' sh", dir.display().to_string().replace('\'', "'\\''")),
            None => format!("{download} | sh"),
        }
    }
}

pub fn notify() {
    if !io::stderr().is_terminal() || std::env::var_os("OMS_NO_UPDATE_CHECK").is_some() {
        return;
    }
    let Some(latest) = available_update() else { return };
    let binary = std::env::current_exe().ok();
    let default_dir = home_dir().ok().map(|home| home.join(".local").join("bin"));
    let custom_dir = binary.as_deref().and_then(Path::parent).filter(|dir| Some(*dir) != default_dir.as_deref());
    eprintln!("\noms {latest} is available (installed {INSTALLED}). To update, run\n  {}", install_command(custom_dir));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_newer_stable_version_prompts() {
        assert!(newer_release("v0.10.0", "0.9.8").is_some());
        assert!(newer_release("v1.0.0", "1.0.0-rc.1").is_some());
        for tag in ["v0.1.0", "v0.9.0+build.2", "v1.0.0-rc.1", "invalid"] {
            assert!(newer_release(tag, "0.9.0+build.1").is_none());
        }
    }

    #[test]
    fn checks_resume_after_a_day_or_clock_correction() {
        let store = crate::store::temp_store();
        assert!(store.claim_update_check(100_000).unwrap());
        assert!(!store.claim_update_check(186_399).unwrap());
        assert!(store.claim_update_check(186_400).unwrap());
        assert!(store.claim_update_check(100_000).unwrap());
    }
}
