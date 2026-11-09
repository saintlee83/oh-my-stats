use std::fmt;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};
use std::thread::sleep;
use std::time::Duration;

use serde_json::{Value, json};

#[derive(Debug)]
pub enum GhError {
    RateLimited,
    /// Quotes from API errors can name private repositories, so they only go to local logs.
    Failed(String),
    NotFound,
}

impl fmt::Display for GhError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GhError::RateLimited => write!(f, "GitHub's rate limit is used up; the next run continues"),
            GhError::Failed(message) => write!(f, "{message}"),
            GhError::NotFound => write!(f, "not found"),
        }
    }
}

impl std::error::Error for GhError {}

const MAX_ATTEMPTS: u32 = 5;

/// Talks to GitHub with a token that stays on this machine.
pub struct Gh {
    agent: ureq::Agent,
    token: String,
    base: String,
    /// REST budget left, or -1 before the first response.
    pub rest_remaining: AtomicI64,
    scopes: Mutex<Option<String>>,
}

impl Gh {
    pub fn new(token: String) -> Self {
        Self::with_base(token, "https://api.github.com")
    }

    pub fn with_base(token: String, base: &str) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(90)))
            .user_agent("oh-my-stats")
            .build()
            .into();
        Self { agent, token, base: base.to_string(), rest_remaining: AtomicI64::new(-1), scopes: Mutex::new(None) }
    }

    fn request(&self, method: &str, path: &str, body: Option<&Value>, is_rest: bool) -> Result<Value, GhError> {
        let url = format!("{}{path}", self.base);
        let mut last_error = String::from("no response");
        for attempt in 1..=MAX_ATTEMPTS {
            if attempt > 1 {
                sleep(Duration::from_millis((1000 * 2u64.pow(attempt - 2)).min(30_000)));
            }
            let builder = ureq::http::Request::builder()
                .method(method)
                .uri(&url)
                .header("authorization", format!("Bearer {}", self.token))
                .header("accept", "application/vnd.github+json")
                .header("x-github-api-version", "2022-11-28");
            let request = match body {
                Some(value) => builder.header("content-type", "application/json").body(value.to_string()),
                None => builder.body(String::new()),
            }
            .map_err(|error| GhError::Failed(error.to_string()))?;

            let mut response = match self.agent.run(request) {
                Ok(response) => response,
                Err(error) => {
                    last_error = error.to_string();
                    continue;
                }
            };
            let status = response.status().as_u16();
            let header = |name: &str| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_string);
            if let Some(scopes) = header("x-oauth-scopes") {
                *self.scopes.lock().unwrap() = Some(scopes);
            }
            let remaining = header("x-ratelimit-remaining");
            if is_rest && let Some(value) = remaining.as_deref().and_then(|value| value.parse().ok()) {
                self.rest_remaining.store(value, Ordering::Relaxed);
            }
            if status == 403 || status == 429 {
                if let Some(wait) = header("retry-after").and_then(|value| value.parse::<u64>().ok()).filter(|wait| *wait > 0) {
                    last_error = "secondary rate limit".into();
                    sleep(Duration::from_secs(wait.min(120)));
                    continue;
                }
                if remaining.as_deref() == Some("0") {
                    return Err(GhError::RateLimited);
                }
            }
            if status >= 500 {
                last_error = format!("GitHub {status}");
                continue;
            }
            if status == 404 || status == 409 || status == 422 {
                return Err(GhError::NotFound);
            }
            let text = response.body_mut().with_config().limit(64 * 1024 * 1024).read_to_string().map_err(|error| GhError::Failed(error.to_string()))?;
            if !(200..300).contains(&status) {
                return Err(GhError::Failed(format!("GitHub {status}")));
            }
            return serde_json::from_str(&text).map_err(|error| GhError::Failed(error.to_string()));
        }
        Err(GhError::Failed(last_error))
    }

    pub fn rest(&self, path: &str) -> Result<Value, GhError> {
        self.request("GET", path, None, true)
    }

    pub fn graphql(&self, query: &str, variables: Value) -> Result<Value, GhError> {
        let body = self.request("POST", "/graphql", Some(&json!({ "query": query, "variables": variables })), false)?;
        if let Some(errors) = body.get("errors").and_then(Value::as_array).filter(|errors| !errors.is_empty()) {
            if errors.iter().any(|error| error.get("type").and_then(Value::as_str) == Some("RATE_LIMITED")) {
                return Err(GhError::RateLimited);
            }
            let message = errors.iter().filter_map(|error| error.get("message").and_then(Value::as_str)).collect::<Vec<_>>().join("; ");
            return Err(GhError::Failed(format!("GitHub GraphQL: {message}")));
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    }

    /// Classic and OAuth tokens report their scopes on every response. Fine-grained ones
    /// report none, so they can't be checked and count as having everything.
    pub fn missing_scopes(&self, required: &[&str]) -> Vec<String> {
        let scopes = self.scopes.lock().unwrap();
        let Some(scopes) = scopes.as_deref() else { return Vec::new() };
        if self.token.starts_with("github_pat_") || self.token.starts_with("ghs_") {
            return Vec::new();
        }
        let granted: Vec<&str> = scopes.split(',').map(str::trim).collect();
        required
            .iter()
            .filter(|scope| {
                let implied: &[&str] = if **scope == "read:org" { &["write:org", "admin:org"] } else { &[] };
                !granted.contains(scope) && !implied.iter().any(|broader| granted.contains(broader))
            })
            .map(|scope| (*scope).to_string())
            .collect()
    }

    #[cfg(test)]
    pub fn set_scopes(&self, scopes: &str) {
        *self.scopes.lock().unwrap() = Some(scopes.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(token: &str, scopes: Option<&str>) -> Vec<String> {
        let gh = Gh::new(token.to_string());
        if let Some(scopes) = scopes {
            gh.set_scopes(scopes);
        }
        gh.missing_scopes(&["repo", "read:org"])
    }

    #[test]
    fn a_token_that_cannot_see_private_work_is_caught() {
        assert!(with("ghp_x", Some("gist, read:org, repo")).is_empty());
        assert_eq!(with("gho_x", Some("gist")), vec!["repo", "read:org"]);
        assert_eq!(with("ghp_x", Some("")), vec!["repo", "read:org"]);
        assert!(with("ghp_x", Some("repo, admin:org")).is_empty(), "admin:org includes read:org");
        assert!(with("github_pat_x", Some("")).is_empty(), "fine-grained tokens can't be checked");
        assert!(with("ghp_x", None).is_empty());
    }
}
