use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};

use crate::api::{Api, check_server_url};
use crate::config::{Config, state_dir};
use crate::machine::machine_info;
use crate::store::Store;

/// The hosted service. Pass `--server` to use your own.
pub const DEFAULT_SERVER: &str = "https://ohmystats.dev";

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
pub fn device_flow(client_id: &str, scope: &str) -> Result<String> {
    let start = form_post("https://github.com/login/device/code", &[("client_id", client_id), ("scope", scope)])?;
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
    let client_id = remote.get("githubClientId").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string);
    let any_token = remote.get("allowAnyGitHubToken").and_then(Value::as_bool).unwrap_or(false);

    // Only `read:user`: proving who you are is all the server needs.
    let github_token = match (&client_id, use_gh, any_token) {
        (_, true, true) | (None, _, true) => {
            println!("Using your GitHub CLI login (this is a development server).");
            gh_cli_token().context("`gh auth token` failed. Run `gh auth login` first.")?
        }
        (_, true, false) => bail!("This server only accepts its own sign-in, so --gh can't be used."),
        (Some(id), false, _) => device_flow(id, "read:user")?,
        (None, false, false) => bail!("This server has no GitHub sign-in configured."),
    };

    let machine = machine_info(&config)?;
    let reply = anonymous.send("POST", "/v1/auth/token", &json!({ "githubToken": github_token, "machine": machine }))?;
    let token = reply.get("token").and_then(Value::as_str).context("the server returned no token")?;
    let user = reply.pointer("/user/login").and_then(Value::as_str).unwrap_or("?").to_string();

    config.server = Some(server.clone());
    config.token = Some(token.to_string());
    config.login = Some(user.clone());
    config.github_client_id = client_id;
    config.save()?;

    // A new sign-in may mean a new account, so everything local is sent again.
    Store::open(&state_dir()?.join("agent.db"))?.reset_sync()?;

    println!("\nSigned in as @{user}, on {} ({}).", machine.name, machine.platform);
    println!("Next: `oms sync` to send your usage now, then `oms service install` to keep it running.");
    println!("Your profile stays private until you run `oms publish`.");
    Ok(())
}

/// A separate grant for reading private repositories, which stays on this machine.
pub fn github_login() -> Result<()> {
    let mut config = Config::load()?;
    let client_id = config.github_client_id.clone().context("Sign in with `oms login` first.")?;
    println!("This grants read access to your repositories, to count your private work.\nThe token stays on this machine. Only aggregated numbers are ever uploaded.");
    config.github_token = Some(device_flow(&client_id, "repo read:org")?);
    config.save()?;
    println!("Done. GitHub stats will be collected on the next sync.");
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
