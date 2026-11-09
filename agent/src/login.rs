use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};

use crate::api::{Api, check_server_url, is_local_server};
use crate::config::{Config, state_dir};
use crate::machine::machine_info;
use crate::store::Store;

/// The hosted service. Pass `--server` to use your own.
pub const DEFAULT_SERVER: &str = "https://ohmystats.dev";

/// All a server needs is proof of who you are. This is the only GitHub token that ever
/// leaves this machine.
const SIGN_IN_SCOPE: &str = "read:user";

/// GitHub can return scopes approved earlier, whatever was asked for this time. A GitHub App
/// returns none at all.
fn is_sign_in_only(granted: &str) -> bool {
    granted.split([',', ' ']).filter(|scope| !scope.is_empty()).all(|scope| scope == SIGN_IN_SCOPE)
}

pub fn gh_cli_token() -> Option<String> {
    let output = Command::new("gh").args(["auth", "token"]).stderr(Stdio::null()).output().ok()?;
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !token.is_empty()).then_some(token)
}

fn form_post(url: &str, fields: &[(&str, &str)]) -> Result<Value> {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(30))).build().into();
    let mut response = agent.post(url).header("accept", "application/json").send_form(fields.iter().copied())?;
    Ok(serde_json::from_str(&response.body_mut().read_to_string()?)?)
}

/// GitHub's device flow: the user approves a short code in their browser, so no secret
/// ships with this agent and no password is ever typed here.
fn device_flow(client_id: &str) -> Result<String> {
    let start = form_post("https://github.com/login/device/code", &[("client_id", client_id), ("scope", SIGN_IN_SCOPE)])?;
    let device_code = start.get("device_code").and_then(Value::as_str).context("GitHub did not start the sign-in. Is device flow enabled for this OAuth App?")?;
    let user_code = start.get("user_code").and_then(Value::as_str).context("GitHub sent no code")?;
    let uri = start.get("verification_uri").and_then(Value::as_str).unwrap_or("https://github.com/login/device");
    let mut interval = start.get("interval").and_then(Value::as_u64).unwrap_or(5);
    let expires = start.get("expires_in").and_then(Value::as_u64).unwrap_or(900);

    println!("\nOpen {uri} and enter this code:\n\n    {user_code}\n\nWaiting for you to approve it...");
    let deadline = Instant::now() + Duration::from_secs(expires);
    while Instant::now() < deadline {
        sleep(Duration::from_secs(interval));
        let poll = form_post(
            "https://github.com/login/oauth/access_token",
            &[("client_id", client_id), ("device_code", device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")],
        )?;
        if let Some(token) = poll.get("access_token").and_then(Value::as_str) {
            let granted = poll.get("scope").and_then(Value::as_str).unwrap_or("");
            if !is_sign_in_only(granted) {
                bail!("GitHub granted more than sign-in needs ({granted}), so nothing was sent. Revoke this app at https://github.com/settings/applications and try again.");
            }
            return Ok(token.to_string());
        }
        match poll.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => {}
            Some("slow_down") => interval += 5,
            Some("access_denied") => bail!("The sign-in was declined."),
            Some("expired_token") => break,
            Some(other) => bail!("GitHub refused the sign-in: {other}"),
            None => {}
        }
    }
    bail!("The code expired. Run the command again.")
}

#[derive(Debug, PartialEq, Eq)]
enum SignIn<'a> {
    GitHubCli,
    DeviceFlow(&'a str),
}

/// A GitHub CLI login can read and change every repository, so it goes only to a server on
/// this computer, and only when asked. Nothing a server replies can change that.
fn choose_sign_in<'a>(server: &str, client_id: Option<&'a str>, any_token: bool, use_gh: bool) -> Result<SignIn<'a>> {
    if use_gh {
        if !is_local_server(server) {
            bail!("--gh only works with a server on this computer, because it hands over your full GitHub CLI login.");
        }
        if !any_token {
            bail!("This server only accepts its own sign-in, so --gh can't be used.");
        }
        return Ok(SignIn::GitHubCli);
    }
    client_id.map(SignIn::DeviceFlow).context("This server has no GitHub sign-in configured. A development server on this computer needs --gh.")
}

pub fn login(server: Option<&str>, name: Option<&str>, use_gh: bool) -> Result<()> {
    let mut config = Config::load()?;
    let server = server
        .map(str::to_string)
        .or_else(|| std::env::var("OMS_SERVER").ok().filter(|value| !value.is_empty()))
        .or_else(|| config.server.clone())
        .unwrap_or_else(|| DEFAULT_SERVER.to_string());
    let server = check_server_url(&server).map_err(|message| anyhow!(message))?;
    if let Some(name) = name {
        config.machine_name = Some(name.to_string());
    }

    let anonymous = Api::new(&server, None);
    let remote = anonymous.get("/v1/config").with_context(|| format!("could not reach {server}"))?;
    let client_id = remote.get("githubClientId").and_then(Value::as_str).filter(|id| !id.is_empty());
    let any_token = remote.get("allowAnyGitHubToken").and_then(Value::as_bool).unwrap_or(false);

    let github_token = match choose_sign_in(&server, client_id, any_token, use_gh)? {
        SignIn::GitHubCli => {
            println!("Using your GitHub CLI login (this is a development server).");
            gh_cli_token().context("`gh auth token` failed. Run `gh auth login` first.")?
        }
        SignIn::DeviceFlow(id) => device_flow(id)?,
    };

    let machine = machine_info(&config)?;
    let reply = anonymous.send("POST", "/v1/auth/token", &json!({ "githubToken": github_token, "machine": machine }))?;
    let token = reply.get("token").and_then(Value::as_str).context("the server returned no token")?;
    let user = reply.pointer("/user/login").and_then(Value::as_str).unwrap_or("?").to_string();

    config.server = Some(server.clone());
    config.token = Some(token.to_string());
    config.login = Some(user.clone());
    config.save()?;

    // A new sign-in may mean a new account, so everything local is sent again.
    Store::open(&state_dir()?.join("agent.db"))?.reset_sync()?;

    println!("\nSigned in as @{user}, on {} ({}).", machine.name, machine.platform);
    println!("Next: `oms sync` to send your usage now, then `oms service install` to keep it running.");
    println!("Your profile stays private until you run `oms publish`.");
    Ok(())
}

pub fn logout() -> Result<()> {
    let mut config = Config::load()?;
    if let (Some(server), Some(token)) = (&config.server, &config.token) {
        // Best effort: the local sign-in is removed either way.
        let _ = Api::new(server, Some(token.clone())).send("POST", "/v1/auth/logout", &json!({}));
    }
    config.token = None;
    config.login = None;
    config.save()?;
    println!("Signed out. Your local history is kept; run `oms login` to continue.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_remote_server_can_never_get_a_github_cli_login() {
        // A hostile server can claim to be in development mode with no sign-in of its own.
        assert!(choose_sign_in("https://evil.example", None, true, false).is_err());
        assert!(choose_sign_in("https://evil.example", Some("id"), true, true).is_err());
        assert!(choose_sign_in("http://localhost:1@evil.example", None, true, true).is_err());
        assert_eq!(choose_sign_in("https://evil.example", Some("id"), true, false).unwrap(), SignIn::DeviceFlow("id"));
    }

    #[test]
    fn the_github_cli_login_is_for_a_development_server_on_this_computer() {
        assert_eq!(choose_sign_in("http://localhost:8787", None, true, true).unwrap(), SignIn::GitHubCli);
        assert!(choose_sign_in("http://localhost:8787", Some("id"), false, true).is_err());
        assert!(choose_sign_in("http://localhost:8787", None, true, false).is_err(), "it has to be asked for");
    }

    #[test]
    fn only_a_sign_in_token_may_leave_this_machine() {
        for granted in ["", "read:user", "read:user,read:user", "read:user read:user"] {
            assert!(is_sign_in_only(granted), "{granted}");
        }
        for granted in ["repo", "read:user,repo", "read:user read:org", "user", "workflow"] {
            assert!(!is_sign_in_only(granted), "{granted}");
        }
    }
}
