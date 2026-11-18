//! Readers for additional providers. All readers produce the same local usage event.
use std::io::Read;

use serde::Deserialize;

use crate::parse::UsageEvent;

pub mod native;

const MAX_TOKENS: u64 = 1_000_000_000_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reader {
    Claude,
    Codex,
    Gemini,
    Pi,
    OhMyPi,
    Qwen,
    Copilot,
    Kimi,
    Cline,
    Amp,
    OpenCode,
    OpenCodeJson,
    Hermes,
    Goose,
    RooCode,
    KiloCode,
    Kilo,
    Export,
}

impl Reader {
    pub fn provider(self) -> Option<&'static str> {
        Some(match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::Amp => "amp",
            Self::Cline => "cline-cli",
            Self::Copilot => "copilot-cli",
            Self::Goose => "goose",
            Self::Hermes => "hermes-agent",
            Self::KiloCode | Self::Kilo => "kilo-code",
            Self::Kimi => "kimi-cli",
            Self::OhMyPi => "oh-my-pi",
            Self::OpenCode | Self::OpenCodeJson => "opencode",
            Self::Pi => "pi",
            Self::Qwen => "qwen-code",
            Self::RooCode => "roo-code",
            Self::Export => return None,
        })
    }

    pub fn accepts(self, path: &std::path::Path) -> bool {
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            return false;
        };
        match self {
            Self::Claude | Self::Pi | Self::Export => name.ends_with(".jsonl"),
            // Its cleanup leaves copies of sessions in scratch folders while it compresses them.
            Self::OhMyPi => {
                name.ends_with(".jsonl")
                    && !path.components().any(|part| {
                        part.as_os_str()
                            .to_string_lossy()
                            .starts_with(".omp-gc-compress-")
                    })
            }
            Self::Qwen => {
                let dir = path.parent();
                let chats = |p: &std::path::Path| p.file_name().is_some_and(|n| n == "chats");
                name.ends_with(".jsonl")
                    && dir.is_some_and(|p| {
                        chats(p) || (p.ends_with("archive") && p.parent().is_some_and(chats))
                    })
            }
            Self::Copilot => name == "events.jsonl",
            Self::Kimi => {
                name == "wire.jsonl"
                    && path
                        .ancestors()
                        .nth(2)
                        .is_some_and(|p| p.ends_with("agents"))
            }
            Self::Amp => name.starts_with("T-") && name.ends_with(".json"),
            Self::Cline => name.ends_with(".messages.json"),
            Self::OpenCode => name == "opencode.db",
            Self::OpenCodeJson => name.starts_with("msg_") && name.ends_with(".json"),
            Self::Hermes => name == "state.db",
            Self::Goose => name == "sessions.db",
            Self::Kilo => name == "kilo.db",
            Self::RooCode | Self::KiloCode => name == "ui_messages.json",
            Self::Codex => name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"),
            Self::Gemini => {
                name.starts_with("session-")
                    && matches!(
                        path.extension().and_then(|v| v.to_str()),
                        Some("json" | "jsonl")
                    )
                    && path
                        .parent()
                        .and_then(|p| p.file_name())
                        .is_some_and(|v| v == "chats")
            }
        }
    }

    pub fn database(self) -> bool {
        matches!(
            self,
            Self::OpenCode | Self::Hermes | Self::Goose | Self::Kilo
        )
    }

    /// An editor extension that keeps one folder per task, with the task's messages in
    /// `ui_messages.json`.
    pub fn task_log(self) -> bool {
        matches!(self, Self::RooCode | Self::KiloCode)
    }
}

fn model_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=120).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"._:@+-/".contains(b))
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct GeminiTokens {
    input: u64,
    cached: u64,
    tool: u64,
    output: u64,
    thoughts: u64,
}

#[derive(Deserialize)]
struct GeminiMessage {
    id: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    model: Option<String>,
    tokens: Option<GeminiTokens>,
    #[serde(rename = "$set")]
    checkpoint: Option<GeminiCheckpoint>,
}

#[derive(Deserialize)]
struct GeminiCheckpoint {
    #[serde(default)]
    messages: Vec<GeminiMessage>,
}

impl GeminiMessage {
    fn into_event(self) -> Option<UsageEvent> {
        if self.kind.as_deref() != Some("gemini") {
            return None;
        }
        let id = self.id.filter(|v| !v.is_empty())?;
        let tokens = self.tokens?;
        let cached = tokens.cached.min(tokens.input);
        let input = (tokens.input - cached).checked_add(tokens.tool)?;
        let output = tokens.output.checked_add(tokens.thoughts)?;
        if [input, output, cached].into_iter().any(|v| v > MAX_TOKENS) {
            return None;
        }
        Some(UsageEvent {
            key: format!("gemini:{id}"),
            at: self.timestamp?,
            tool: "gemini".into(),
            model: self
                .model
                .filter(|m| model_name(m))
                .unwrap_or_else(|| "unknown".into()),
            input: input as i64,
            cache_read: cached as i64,
            cache_write: 0,
            output: output as i64,
            legacy_total: None,
            cumulative_responses: None,
        })
    }
}

pub fn read_gemini_line(line: &str, events: &mut Vec<UsageEvent>) {
    let Ok(mut record) = serde_json::from_str::<GeminiMessage>(line) else {
        return;
    };
    if let Some(checkpoint) = record.checkpoint.take() {
        events.extend(
            checkpoint
                .messages
                .into_iter()
                .filter_map(GeminiMessage::into_event),
        );
    } else {
        events.extend(record.into_event());
    }
}

pub fn gemini_snapshot(reader: impl Read) -> serde_json::Result<Vec<UsageEvent>> {
    #[derive(Deserialize)]
    struct Session {
        messages: Vec<GeminiMessage>,
    }
    let session: Session = serde_json::from_reader(reader)?;
    Ok(session
        .messages
        .into_iter()
        .filter_map(GeminiMessage::into_event)
        .collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Export {
    provider: String,
    id: String,
    timestamp: String,
    model: String,
    input: u64,
    output: u64,
    #[serde(default)]
    cache_read: u64,
    #[serde(default)]
    cache_write: u64,
}

pub fn export_line(line: &str) -> Option<UsageEvent> {
    let row: Export = serde_json::from_str(line).ok()?;
    let id = row.provider.as_bytes();
    if !(1..=32).contains(&id.len())
        || !id[0].is_ascii_lowercase()
        || !id
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(b))
        || matches!(
            row.provider.as_str(),
            "claude" | "codex" | "gemini" | "constructor"
        )
        || row.id.is_empty()
        || !model_name(&row.model)
        || [row.input, row.output, row.cache_read, row.cache_write]
            .into_iter()
            .any(|n| n > MAX_TOKENS)
    {
        return None;
    }
    Some(UsageEvent {
        key: format!("export:{}:{}", row.provider, row.id),
        tool: row.provider,
        at: row.timestamp,
        model: row.model,
        input: row.input as i64,
        output: row.output as i64,
        cache_read: row.cache_read as i64,
        cache_write: row.cache_write as i64,
        legacy_total: None,
        cumulative_responses: None,
    })
}
