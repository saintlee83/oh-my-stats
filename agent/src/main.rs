mod api;
mod config;
mod daemon;
mod github;
mod login;
mod machine;
mod parse;
mod scan;
mod service;
mod store;
mod sync;
mod totals;

use anyhow::Result;
use clap::{Parser, Subcommand};
use serde_json::json;

use crate::config::{Config, state_dir};
use crate::store::Store;

#[derive(Parser)]
#[command(name = "oms", version, about = "Tracks your AI tokens and contributions, on every machine.")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Sign this machine in with GitHub
    Login {
        /// The server to use, if not the hosted one at ohmystats.dev
        #[arg(long)]
        server: Option<String>,
        /// How this machine appears on your dashboard
        #[arg(long)]
        name: Option<String>,
        /// Use your GitHub CLI login (development servers only)
        #[arg(long)]
        gh: bool,
    },
    /// Sign this machine out, keeping its local history
    Logout,
    /// Show sign-in, totals and machines
    Status,
    /// Read new logs and upload what changed, once
    Sync {
        /// Collect GitHub stats now, even if they aren't due
        #[arg(long)]
        github: bool,
    },
    /// Keep tracking in the foreground. `oms service install` runs this for you
    Daemon {
        /// Seconds between checks
        #[arg(long, default_value_t = 60)]
        interval: u64,
    },
    /// Manage the background service
    Service {
        #[command(subcommand)]
        action: ServiceAction,
    },
    /// Show your profile to everyone
    Publish,
    /// Make your profile private again
    Unpublish,
    /// Print exactly what this machine would upload, without sending anything
    Preview,
    /// Grant repository access for GitHub stats, if you don't use the GitHub CLI
    GithubLogin,
}

#[derive(Subcommand)]
enum ServiceAction {
    /// Run the agent in the background, starting at login
    Install,
    /// Stop and remove the background service
    Uninstall,
    /// Show whether the service is running
    Status,
}

fn set_public(public: bool) -> Result<()> {
    let config = Config::load()?;
    let api = sync::signed_in_api(&config)?;
    api.send("PATCH", "/v1/me", &json!({ "public": public }))?;
    let me = api.get("/v1/me")?;
    let url = me.get("profileUrl").and_then(serde_json::Value::as_str).unwrap_or("?");
    if public {
        println!("Your profile is public: {url}\nAdd it to your GitHub profile README:\n\n  ![Developer stats]({url}/dashboard.svg)");
    } else {
        println!("Your profile is private.");
    }
    Ok(())
}

fn preview() -> Result<()> {
    let config = Config::load()?;
    let mut store = Store::open(&state_dir()?.join("agent.db"))?;
    scan::scan(&mut store, &scan::default_roots()?, config.timezone())?;
    let totals = totals::collect(&store, sync::now_secs(), true)?;
    let rollup = store.rollup()?;
    let body = json!({ "machine": machine::machine_info(&config)?, "timezone": config.timezone_name(), "days": rollup, "totals": totals });
    println!("{}", serde_json::to_string_pretty(&body)?);
    Ok(())
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Commands::Login { server, name, gh } => login::login(server.as_deref(), name.as_deref(), gh),
        Commands::Logout => login::logout(),
        Commands::Status => daemon::print_status(),
        Commands::Sync { github } => daemon::run_once_verbose(github),
        Commands::Daemon { interval } => daemon::run(interval.max(10)),
        Commands::Service { action } => match action {
            ServiceAction::Install => service::install(),
            ServiceAction::Uninstall => service::uninstall(),
            ServiceAction::Status => service::status(),
        },
        Commands::Publish => set_public(true),
        Commands::Unpublish => set_public(false),
        Commands::Preview => preview(),
        Commands::GithubLogin => login::github_login(),
    }
}
