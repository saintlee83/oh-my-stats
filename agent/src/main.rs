mod api;
mod config;
mod daemon;
mod github;
mod login;
mod machine;
mod parse;
mod providers;
mod rankings;
mod scan;
mod service;
mod store;
mod sync;
mod totals;
mod updates;

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
        /// Use your GitHub CLI login (development servers on this computer only)
        #[arg(long)]
        gh: bool,
    },
    /// Sign this machine out, keeping its local history
    Logout,
    /// Show sign-in, totals and machines
    Status,
    /// Show the public token leaderboard and your own device and provider rankings
    #[command(visible_alias = "ranking")]
    Rankings {
        /// Rank lifetime tokens (all) or the last 7 or 30 reporting dates in UTC
        #[arg(long, default_value = "all", value_parser = ["all", "7", "30"])]
        days: String,
    },
    /// Read new logs and upload what changed, right now
    Sync {
        /// Collect GitHub stats now, even if they aren't due
        #[arg(long)]
        github: bool,
    },
    /// Keep tracking in the foreground. `oms service install` runs this for you
    Daemon {
        /// Seconds between reading new log lines
        #[arg(long, default_value_t = 300)]
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
    /// Install the newest release in place of this one
    Update {
        /// Only say whether a newer release is available
        #[arg(long)]
        check: bool,
    },
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
    scan::scan(&mut store, &scan::default_roots(&config.skip_native_logs)?, config.timezone())?;
    let totals = totals::collect(&store, sync::now_secs(), true)?;
    let requests = sync::preview(&store, &config, &totals)?;
    if let [only] = requests.as_slice() {
        println!("{}", serde_json::to_string_pretty(only)?);
    } else {
        println!("{}", serde_json::to_string_pretty(&requests)?);
    }
    Ok(())
}

fn main() -> Result<()> {
    let command = Cli::parse().command;
    let check_updates = matches!(command, Commands::Status | Commands::Rankings { .. } | Commands::Sync { .. });
    let result = match command {
        Commands::Login { server, name, gh } => login::login(server.as_deref(), name.as_deref(), gh),
        Commands::Logout => login::logout(),
        Commands::Status => daemon::print_status(),
        Commands::Rankings { days } => rankings::show(&days),
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
        Commands::Update { check } => updates::update(check),
    };
    if check_updates {
        updates::notify();
    }
    result
}
