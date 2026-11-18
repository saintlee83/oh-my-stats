use anyhow::{Context, Result};
use serde::Deserialize;

use crate::{config::Config, sync::signed_in_api};

#[derive(Deserialize)]
struct Standing {
    rank: usize,
    label: String,
    tokens: f64,
}

#[derive(Deserialize)]
struct Period {
    start: Option<String>,
    end: Option<String>,
}

#[derive(Deserialize)]
struct Rankings {
    period: Period,
    position: Option<PublicPosition>,
    users: Vec<Standing>,
    machines: Vec<Standing>,
    providers: Vec<Standing>,
}

#[derive(Deserialize)]
struct PublicPosition {
    rank: Option<usize>,
    participants: usize,
}

pub fn show(days: &str) -> Result<()> {
    let api = signed_in_api(&Config::load()?)?;
    let response = api.get(&format!("/v1/rankings?days={days}"))?;
    let rankings: Rankings =
        serde_json::from_value(response).context("Invalid rankings response")?;
    match (rankings.period.start, rankings.period.end) {
        (Some(start), Some(end)) => println!("Token rankings   {start} through {end} (UTC)"),
        _ => println!("Token rankings   All time"),
    }
    if let Some(position) = rankings.position {
        match position.rank {
            Some(rank) => println!("Your public position   #{rank} of {}", position.participants),
            None => println!("Unranked   {} public profiles with usage", position.participants),
        }
    }
    for (title, rows) in [
        ("Top public profiles", rankings.users),
        ("My devices", rankings.machines),
        ("My providers", rankings.providers),
    ] {
        println!("\n{title}");
        if rows.is_empty() {
            println!("  No token usage for this period.");
        }
        for row in rows {
            println!(
                "  #{:<3} {:<24} {:.0} tokens",
                row.rank, row.label, row.tokens
            );
        }
    }
    Ok(())
}
