use std::fs;
use std::io::Read;
use std::process::Command;

use anyhow::Result;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::config::{Config, state_dir};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineInfo {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub agent_version: String,
}

pub fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hardware_id() -> Option<String> {
    if cfg!(target_os = "macos") {
        let output = Command::new("ioreg").args(["-rd1", "-c", "IOPlatformExpertDevice"]).output().ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let line = text.lines().find(|line| line.contains("IOPlatformUUID"))?;
        return line.split('"').nth(3).map(str::to_string);
    }
    fs::read_to_string("/etc/machine-id").ok().map(|id| id.trim().to_string()).filter(|id| !id.is_empty())
}

fn random_id() -> Result<String> {
    let mut bytes = [0u8; 32];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Derived from the hardware, so reinstalling can't register this computer twice and
/// double its numbers. Only the hash leaves the machine, never the hardware id.
pub fn machine_id() -> Result<String> {
    let path = state_dir()?.join("machine-id");
    if let Ok(saved) = fs::read_to_string(&path) {
        let saved = saved.trim();
        if !saved.is_empty() {
            return Ok(saved.to_string());
        }
    }
    let source = match hardware_id() {
        Some(id) => id,
        None => random_id()?,
    };
    let id = sha256_hex(&format!("oh-my-stats:{source}"))[..32].to_string();
    fs::write(&path, &id)?;
    Ok(id)
}

fn hostname() -> String {
    let attempts: &[(&str, &[&str])] = if cfg!(target_os = "macos") {
        &[("scutil", &["--get", "ComputerName"]), ("hostname", &[])]
    } else {
        &[("hostname", &[])]
    };
    for (program, args) in attempts {
        if let Ok(output) = Command::new(program).args(*args).output() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if output.status.success() && !name.is_empty() {
                return name;
            }
        }
    }
    "This machine".to_string()
}

pub fn machine_info(config: &Config) -> Result<MachineInfo> {
    Ok(MachineInfo {
        id: machine_id()?,
        name: config.machine_name.clone().unwrap_or_else(hostname),
        platform: std::env::consts::OS.to_string(),
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
    })
}
