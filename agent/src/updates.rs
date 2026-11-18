use std::fs;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::config::{home_dir, state_dir};
use crate::store::Store;
use crate::sync::now_secs;

const LATEST_RELEASE: &str = "https://api.github.com/repos/saintlee83/oh-my-stats/releases/latest";
const RELEASES: &str = "https://github.com/saintlee83/oh-my-stats/releases/download";
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

fn github(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .user_agent(concat!("oh-my-stats/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

/// The tag of the newest stable release. `OMS_RELEASE_API` asks somewhere else, which the tests use.
fn latest_tag(timeout: Duration) -> Result<String> {
    let url = std::env::var("OMS_RELEASE_API").unwrap_or_else(|_| LATEST_RELEASE.into());
    let mut response = github(timeout).get(&url).header("accept", "application/vnd.github+json").call()?;
    let release: Release = response.body_mut().read_json()?;
    Ok(release.tag_name)
}

fn available_update() -> Option<Version> {
    let store = Store::open(&state_dir().ok()?.join("agent.db")).ok()?;
    if !store.claim_update_check(now_secs()).ok()? {
        return None;
    }
    newer_release(&latest_tag(Duration::from_secs(2)).ok()?, INSTALLED)
}

/// What to run by hand when `oms update` can't finish: the install command for this installation.
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
    eprintln!("\noms {latest} is available (installed {INSTALLED}). To update, run\n  oms update");
}

/// The folder this program runs from, which is where its replacement goes.
fn installed_dir() -> Result<PathBuf> {
    let binary = std::env::current_exe().context("could not find where oms is installed")?;
    // A link on the PATH leads to the real file. Windows gives a plain path already, and
    // resolving it there would add a prefix the install script can't compare with.
    let binary = if cfg!(windows) { binary } else { fs::canonicalize(&binary).unwrap_or(binary) };
    binary.parent().map(Path::to_path_buf).context("could not find the folder oms is installed in")
}

/// The checksum a release lists for one of its files, in the form `sha256sum` writes.
fn listed_checksum<'a>(sums: &'a str, file: &str) -> Option<&'a str> {
    sums.lines().find_map(|line| {
        let (hash, name) = line.split_once(char::is_whitespace)?;
        (name.trim().trim_start_matches('*') == file).then_some(hash)
    })
}

fn checksum(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A release's own install script, checked against that release's checksums before it is run.
fn install_script(base: &str) -> Result<Vec<u8>> {
    let name = if cfg!(windows) { "install.ps1" } else { "install.sh" };
    let agent = github(Duration::from_secs(30));
    let script = agent.get(&format!("{base}/{name}")).call()?.body_mut().read_to_vec()?;
    let sums = agent.get(&format!("{base}/SHA256SUMS")).call()?.body_mut().read_to_string()?;
    let expected = listed_checksum(&sums, name).with_context(|| format!("{name} isn't in the release's checksums"))?;
    ensure!(expected.eq_ignore_ascii_case(&checksum(&script)), "{name} doesn't match its checksum, so it wasn't run");
    Ok(script)
}

/// Runs the install script the way a person would, with this program's folder as the place to install to.
fn run_installer(script: &[u8], dir: &Path, tag: &str) -> Result<()> {
    let file = std::env::temp_dir().join(format!("oms-install-{}.{}", std::process::id(), if cfg!(windows) { "ps1" } else { "sh" }));
    fs::write(&file, script).with_context(|| format!("could not write {}", file.display()))?;
    let mut installer = if cfg!(windows) {
        // Read whole and then run, as `irm ... | iex` does. The script removes its own copy first,
        // because it stops this program to replace it and so nothing here runs afterwards.
        let mut command = Command::new("powershell");
        command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]);
        command.arg("$script = Get-Content -Raw -LiteralPath $env:OMS_INSTALL_SCRIPT; Remove-Item -LiteralPath $env:OMS_INSTALL_SCRIPT; Invoke-Expression $script");
        command.env("OMS_INSTALL_SCRIPT", &file);
        command
    } else {
        let mut command = Command::new("sh");
        command.arg(&file);
        command
    };
    let status = installer.env("OMS_INSTALL_DIR", dir).env("OMS_VERSION", tag).env("OMS_UPDATING", "1").status();
    let _ = fs::remove_file(&file);
    ensure!(status.context("could not start the installer")?.success(), "the installer stopped before it finished");
    Ok(())
}

/// `oms update`: puts the newest release where this program is, with the release's own install script.
pub fn update(check_only: bool) -> Result<()> {
    let tag = latest_tag(Duration::from_secs(15)).context("couldn't ask GitHub for the latest release")?;
    let Some(latest) = newer_release(&tag, INSTALLED) else {
        println!("oms {INSTALLED} is up to date.");
        return Ok(());
    };
    if check_only {
        println!("oms {latest} is available (installed {INSTALLED}). To install it, run\n  oms update");
        return Ok(());
    }
    let dir = installed_dir()?;
    println!("Updating oms {INSTALLED} to {latest}");
    // A copy of the release's files stands in for GitHub here too, as it does for the install script.
    let base = match std::env::var("OMS_DOWNLOAD_URL") {
        Ok(copy) if !copy.is_empty() => copy.trim_end_matches('/').to_string(),
        _ => format!("{RELEASES}/{tag}"),
    };
    let script = install_script(&base).context("couldn't download the release's install script")?;
    if cfg!(windows) {
        println!("Windows can't replace a program while it runs, so the installer stops this one and finishes on its own.");
    }
    if let Err(error) = run_installer(&script, &dir, &tag) {
        let default_dir = home_dir().ok().map(|home| home.join(".local").join("bin"));
        let custom_dir = Some(dir.as_path()).filter(|dir| Some(*dir) != default_dir.as_deref());
        bail!("{error}. To install it yourself, run\n  {}", install_command(custom_dir));
    }
    Ok(())
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
    fn a_release_file_is_checked_against_the_checksum_listed_for_it() {
        let sums = "aaaa  oms-x86_64-apple-darwin.tar.gz\nBBBB *install.sh\ncccc\tinstall.ps1\n\nnot-a-line\n";
        assert_eq!(listed_checksum(sums, "install.sh"), Some("BBBB"));
        assert_eq!(listed_checksum(sums, "install.ps1"), Some("cccc"));
        assert_eq!(listed_checksum(sums, "install"), None, "a name is matched whole");
        assert_eq!(listed_checksum(sums, "SHA256SUMS"), None);
        assert_eq!(checksum(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn the_command_to_run_by_hand_names_a_folder_that_is_not_the_usual_one() {
        let command = install_command(Some(Path::new("/opt/it's here")));
        if cfg!(windows) {
            assert_eq!(command, "$env:OMS_INSTALL_DIR = '/opt/it''s here'\n  irm https://ohmystats.dev/install.ps1 | iex");
            assert_eq!(install_command(None), "irm https://ohmystats.dev/install.ps1 | iex");
        } else {
            assert_eq!(command, "curl -fsSL https://ohmystats.dev/install.sh | OMS_INSTALL_DIR='/opt/it'\\''s here' sh");
            assert_eq!(install_command(None), "curl -fsSL https://ohmystats.dev/install.sh | sh");
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
