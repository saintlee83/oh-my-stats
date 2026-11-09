use std::fmt;
use std::time::Duration;

use serde_json::Value;

#[derive(Debug)]
pub enum ApiError {
    /// The server no longer accepts this machine's sign-in.
    Unauthorized(String),
    Http(u16, String),
    Network(String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Unauthorized(message) => write!(f, "not signed in: {message}"),
            ApiError::Http(status, message) => write!(f, "server said {status}: {message}"),
            ApiError::Network(message) => write!(f, "could not reach the server: {message}"),
        }
    }
}

impl std::error::Error for ApiError {}

pub struct Api {
    base: String,
    token: Option<String>,
    agent: ureq::Agent,
}

const LOCAL_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// Reads an address the way the HTTP client will, so `http://localhost:1@evil.example` can't
/// pass for this computer. An address with a username is never valid here.
fn scheme_and_host(url: &str) -> Option<(String, String)> {
    let uri: ureq::http::Uri = url.parse().ok()?;
    let authority = uri.authority()?;
    if authority.as_str().contains('@') {
        return None;
    }
    Some((uri.scheme_str()?.to_ascii_lowercase(), authority.host().to_ascii_lowercase()))
}

pub fn is_local_server(url: &str) -> bool {
    scheme_and_host(url).is_some_and(|(_, host)| LOCAL_HOSTS.contains(&host.as_str()))
}

/// A sign-in token must never cross the network unencrypted, except to this computer.
pub fn check_server_url(url: &str) -> Result<String, String> {
    let url = url.trim_end_matches('/').to_string();
    let allowed = scheme_and_host(&url).is_some_and(|(scheme, host)| scheme == "https" || (scheme == "http" && LOCAL_HOSTS.contains(&host.as_str())));
    if allowed {
        Ok(url)
    } else {
        Err(format!("{url} must be an https:// address (plain http is only allowed for localhost)"))
    }
}

impl Api {
    pub fn new(base: &str, token: Option<String>) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(120)))
            .user_agent(concat!("oh-my-stats-agent/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Self { base: base.trim_end_matches('/').to_string(), token, agent }
    }

    fn auth(&self) -> Option<String> {
        self.token.as_ref().map(|token| format!("Bearer {token}"))
    }

    fn finish(result: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<Value, ApiError> {
        let mut response = result.map_err(|error| ApiError::Network(error.to_string()))?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().map_err(|error| ApiError::Network(error.to_string()))?;
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            return Ok(body);
        }
        let message = body.get("error").and_then(Value::as_str).unwrap_or("unexpected response").to_string();
        Err(if status == 401 { ApiError::Unauthorized(message) } else { ApiError::Http(status, message) })
    }

    pub fn get(&self, path: &str) -> Result<Value, ApiError> {
        let mut request = self.agent.get(format!("{}{path}", self.base));
        if let Some(auth) = self.auth() {
            request = request.header("authorization", auth);
        }
        Self::finish(request.call())
    }

    pub fn send(&self, method: &str, path: &str, body: &Value) -> Result<Value, ApiError> {
        let url = format!("{}{path}", self.base);
        let text = body.to_string();
        let mut builder = ureq::http::Request::builder().method(method).uri(&url).header("content-type", "application/json");
        if let Some(auth) = self.auth() {
            builder = builder.header("authorization", auth);
        }
        let request = builder.body(text).map_err(|error| ApiError::Network(error.to_string()))?;
        Self::finish(self.agent.run(request))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_only_travel_over_https_or_to_this_computer() {
        assert_eq!(check_server_url("https://stats.example/").unwrap(), "https://stats.example");
        assert!(check_server_url("http://localhost:8787").is_ok());
        assert!(check_server_url("http://127.0.0.1:8787").is_ok());
        assert!(check_server_url("http://stats.example").is_err());
        assert!(check_server_url("http://localhost.evil.example").is_err());
        assert!(check_server_url("stats.example").is_err());
    }

    #[test]
    fn an_address_cannot_pass_for_this_computer() {
        for trick in [
            "http://localhost:1@evil.example",
            "http://localhost@evil.example",
            "http://127.0.0.1:80@evil.example",
            "http://[::1]:1@evil.example",
            "https://localhost:1@evil.example",
            "http://localhost:1\\@evil.example",
        ] {
            assert!(check_server_url(trick).is_err(), "{trick}");
            assert!(!is_local_server(trick), "{trick}");
        }
        assert!(!is_local_server("https://stats.example"));
        assert!(!is_local_server("http://localhost.evil.example"));
        for local in ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787", "HTTP://LOCALHOST:8787", "https://localhost:8787"] {
            assert!(is_local_server(local), "{local}");
            assert!(check_server_url(local).is_ok(), "{local}");
        }
    }
}
