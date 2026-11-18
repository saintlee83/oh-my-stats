pub mod churn;
pub mod classify;
pub mod client;
pub mod coauthors;
pub mod collect;
pub mod metrics;

use anyhow::{Context, Result, bail};
use chrono::Utc;

use crate::config::Config;
use crate::login::gh_cli_token;
use crate::store::Store;
use crate::sync::signed_in_api;

pub type Log<'a> = &'a (dyn Fn(&str) + Sync);

/// A token that can read private repositories stays on this machine: it is only used here,
/// and only the aggregated result is uploaded.
fn configured_github_token(config: &Config) -> Option<String> {
    std::env::var("OMS_GITHUB_TOKEN").ok().filter(|token| !token.is_empty()).or_else(|| config.github_token.clone().filter(|token| !token.is_empty()))
}

fn local_github_token(config: &Config) -> Option<String> {
    configured_github_token(config).or_else(gh_cli_token)
}

pub fn print_setup_hint(config: &Config) {
    println!("\nGitHub repository stats are optional. Set them up on one machine.");
    if configured_github_token(config).is_some() {
        println!("Run `oms sync --github` to collect stats with your configured GitHub token.");
    } else {
        println!("Check `gh auth status`. If signed out, run `gh auth login` with the same GitHub account.");
        println!("Run `oms sync --github`. If it reports missing scopes for your GitHub CLI login, run `gh auth refresh -s repo,read:org` and retry.");
        println!("Without GitHub CLI, you can set OMS_GITHUB_TOKEN for the sync instead.");
    }
}

/// Told to the server with each upload, so a machine without access isn't asked to collect.
pub fn has_access(config: &Config) -> bool {
    local_github_token(config).is_some()
}

pub fn collect_and_upload(store: &mut Store, config: &Config, log: Log<'_>) -> Result<()> {
    let token = local_github_token(config).context("No GitHub access for stats. Run `gh auth login`, or set OMS_GITHUB_TOKEN.")?;
    let api = signed_in_api(config)?;
    let gh = client::Gh::new(token);
    let settings = collect::Settings {
        expected_login: config.login.clone(),
        named_coauthors: config.named_coauthors.clone(),
        agent_coauthors: config.agent_coauthors.clone(),
        exclude_languages: config.exclude_languages.clone(),
        max_requests: config.max_requests_per_run.unwrap_or(4000),
        max_file_lines: config.max_file_lines.unwrap_or(5000),
    };
    log("Collecting GitHub stats");
    let now = Utc::now();
    let snapshot = collect::collect(&gh, store, &settings, log, now)?;
    let metrics = metrics::compute(&snapshot, config.timezone(), now, config.max_commit_lines.unwrap_or(metrics::DEFAULT_MAX_COMMIT_LINES), &config.exclude_languages);
    if let Err(error) = api.send("PUT", "/v1/github", &metrics) {
        bail!("could not upload GitHub stats: {error}");
    }
    log(&format!(
        "GitHub stats uploaded: {} commits, {} PRs, {} reviews, {} issues.",
        snapshot.commits.len(),
        snapshot.pulls.len(),
        snapshot.reviews.len(),
        snapshot.issues.len()
    ));
    Ok(())
}
