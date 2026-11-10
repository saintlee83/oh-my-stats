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
fn local_github_token(config: &Config) -> Option<String> {
    std::env::var("OMS_GITHUB_TOKEN").ok().filter(|token| !token.is_empty()).or_else(|| config.github_token.clone()).or_else(gh_cli_token)
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
