use std::fs;
use std::process::Command;

use anyhow::{Context, Result};
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
    if cfg!(windows) {
        // Set when Windows is installed. `/reg:64` finds it from a 32-bit build too.
        let output = Command::new("reg").args(["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid", "/reg:64"]).output().ok()?;
        return machine_guid(&String::from_utf8_lossy(&output.stdout));
    }
    fs::read_to_string("/etc/machine-id").ok().map(|id| id.trim().to_string()).filter(|id| !id.is_empty())
}

/// The value in `reg query` output, from its line "    MachineGuid    REG_SZ    <id>".
fn machine_guid(output: &str) -> Option<String> {
    output.lines().find_map(|line| match line.split_whitespace().collect::<Vec<_>>()[..] {
        ["MachineGuid", "REG_SZ", id] => Some(id.to_string()),
        _ => None,
    })
}

fn random_id() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).context("could not get random numbers from the system")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_windows_machine_id_comes_out_of_the_registry_listing() {
        let output = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    4f1c2a9e-7b3d-4c11-9e2f-0a1b2c3d4e5f\r\n\r\n";
        assert_eq!(machine_guid(output).as_deref(), Some("4f1c2a9e-7b3d-4c11-9e2f-0a1b2c3d4e5f"));
        assert_eq!(machine_guid("ERROR: The system was unable to find the specified registry key or value."), None);
    }

    #[test]
    fn a_random_id_is_new_each_time() {
        let (a, b) = (random_id().unwrap(), random_id().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }
}
