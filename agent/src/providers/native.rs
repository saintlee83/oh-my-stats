//! Persisted CLI formats. Terminal streams and session summaries can describe the
//! same calls as these records, so each reader uses one source of usage.
use std::io::Read;
use std::path::Path;

use anyhow::Result;
use chrono::DateTime;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::Value;

use super::{MAX_TOKENS, Reader, model_name};
use crate::parse::UsageEvent;

fn timestamp(v: &Value) -> Option<String> {
    if let Some(text) = v.as_str() {
        return Some(text.to_owned());
    }
    Some(DateTime::from_timestamp_millis(v.as_i64()?)?.to_rfc3339())
}

fn id(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}

#[derive(Clone, Copy)]
struct Tokens {
    input: u64,
    output: u64,
    read: u64,
    write: u64,
}

impl Tokens {
    fn parse(v: &Value, fields: [&str; 4]) -> Option<Self> {
        let [input, output, read, write] = fields;
        Some(Self {
            input: v[input].as_u64()?,
            output: v[output].as_u64()?,
            read: optional_count(v, read)?,
            write: optional_count(v, write)?,
        })
    }

    fn inclusive_input(mut self) -> Option<Self> {
        self.input = self.input.checked_sub(self.read)?.checked_sub(self.write)?;
        Some(self)
    }

    fn event(self, reader: Reader, key: String, at: String, model: &Value) -> Option<UsageEvent> {
        let provider = reader.provider()?;
        let buckets = [self.input, self.output, self.read, self.write];
        if buckets.iter().all(|&n| n == 0) || buckets.iter().any(|&n| n > MAX_TOKENS) {
            return None;
        }
        Some(UsageEvent {
            key: format!("{provider}:{key}"),
            tool: provider.into(),
            at,
            model: model
                .as_str()
                .filter(|m| model_name(m))
                .unwrap_or("unknown")
                .into(),
            input: self.input as i64,
            output: self.output as i64,
            cache_read: self.read as i64,
            cache_write: self.write as i64,
            cumulative_responses: None,
            legacy_total: None,
        })
    }
}

fn optional_count(v: &Value, key: &str) -> Option<u64> {
    match v.get(key) {
        None | Some(Value::Null) => Some(0),
        Some(n) => n.as_u64(),
    }
}

const CAMEL: [&str; 4] = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
];

pub fn line(reader: Reader, line: &str, path: &Path, offset: u64) -> Option<UsageEvent> {
    let row: Value = serde_json::from_str(line).ok()?;
    match (reader, row["type"].as_str()?) {
        (Reader::Pi, "message") if row["message"]["role"] == "assistant" => {
            let msg = &row["message"];
            let at = timestamp(&msg["timestamp"]).or_else(|| timestamp(&row["timestamp"]))?;
            let key = format!("{}:{}", at, id(&row["id"])?);
            Tokens::parse(
                &msg["usage"],
                ["input", "output", "cacheRead", "cacheWrite"],
            )?
            .event(reader, key, at, &msg["model"])
        }
        (Reader::Qwen, "assistant") => {
            let u = &row["usageMetadata"];
            let prompt = u["promptTokenCount"].as_u64()?;
            let read = optional_count(u, "cachedContentTokenCount")?;
            let tool = optional_count(u, "toolUsePromptTokenCount")?;
            let candidates = u["candidatesTokenCount"].as_u64()?;
            // OpenAI-compatible backends include reasoning in completion tokens.
            // A Gemini-style total can also contain separately reported thoughts.
            let extra = u["totalTokenCount"]
                .as_u64()
                .unwrap_or(0)
                .saturating_sub(prompt.checked_add(tool)?.checked_add(candidates)?)
                .min(optional_count(u, "thoughtsTokenCount")?);
            Tokens {
                input: prompt.checked_sub(read)?.checked_add(tool)?,
                output: candidates.checked_add(extra)?,
                read,
                write: 0,
            }
            .event(
                reader,
                id(&row["uuid"])?.into(),
                timestamp(&row["timestamp"])?,
                &row["model"],
            )
        }
        (Reader::Copilot, "session.usage_record") => {
            let u = &row["data"]["usage"];
            let key = id(&u["accounting"]["usageId"])
                .or_else(|| id(&u["apiCallId"]))
                .or_else(|| id(&row["id"]))?;
            let model = if id(&u["responseModel"]).is_some() {
                &u["responseModel"]
            } else {
                &u["model"]
            };
            Tokens::parse(u, CAMEL)?.inclusive_input()?.event(
                reader,
                key.into(),
                timestamp(&row["timestamp"])?,
                model,
            )
        }
        (Reader::Kimi, "usage.record") => {
            // Wire records have no response ID. An agent's append-only wire file
            // has its own sequence, including for multiple records in one ms.
            let session = path.ancestors().nth(3)?.file_name()?.to_str()?;
            let agent = path.parent()?.file_name()?.to_str()?;
            let at = timestamp(&row["time"])?;
            let key = format!("{session}:{agent}:{at}:{offset}");
            Tokens::parse(
                &row["usage"],
                [
                    "inputOther",
                    "output",
                    "inputCacheRead",
                    "inputCacheCreation",
                ],
            )?
            .event(reader, key, at, &row["model"])
        }
        _ => None,
    }
}

// Ignore message bodies during snapshot deserialization. One rewritten snapshot
// may contain an entire conversation, attachments and tool results.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    #[serde(default)]
    id: String,
    #[serde(default)]
    session_id: String,
    version: Option<u64>,
    #[serde(default)]
    created: Value,
    messages: Vec<Message>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Message {
    role: String,
    id: Value,
    ts: Value,
    model_info: Value,
    metrics: Value,
    message_id: Value,
    meta: Value,
    usage: Value,
}

pub fn snapshot(reader: Reader, input: impl Read) -> Result<Vec<UsageEvent>> {
    if reader == Reader::OpenCodeJson {
        let row: Value = serde_json::from_reader(input)?;
        let event = || {
            if row["role"] != "assistant" {
                return None;
            }
            opencode(
                &row["tokens"],
                id(&row["id"])?.into(),
                timestamp(&row["time"]["created"])?,
                row["modelID"].clone(),
            )
        };
        return Ok(event().into_iter().collect());
    }
    let session: Session = serde_json::from_reader(input)?;
    let mut recent_time = timestamp(&session.created);
    let events = session
        .messages
        .into_iter()
        .filter_map(|m| match reader {
            Reader::Cline
                if session.version == Some(1)
                    && !session.session_id.is_empty()
                    && m.role == "assistant" =>
            {
                let key = format!("{}:{}", session.session_id, id(&m.id)?);
                Tokens::parse(&m.metrics, CAMEL)?.inclusive_input()?.event(
                    reader,
                    key,
                    timestamp(&m.ts)?,
                    &m.model_info["id"],
                )
            }
            Reader::Amp if session.id.starts_with("T-") => {
                if m.role == "user" {
                    if let Some(at) = timestamp(&m.meta["sentAt"]) {
                        recent_time = Some(at);
                    }
                    return None;
                }
                if m.role != "assistant" {
                    return None;
                }
                let message_id = match &m.message_id {
                    Value::Number(n) => n.as_u64()?.to_string(),
                    v => id(v)?.into(),
                };
                let at = timestamp(&m.usage["timestamp"]).or_else(|| recent_time.clone())?;
                Tokens::parse(
                    &m.usage,
                    [
                        "inputTokens",
                        "outputTokens",
                        "cacheReadInputTokens",
                        "cacheCreationInputTokens",
                    ],
                )?
                .event(
                    reader,
                    format!("{}:{message_id}", session.id),
                    at,
                    &m.usage["model"],
                )
            }
            _ => None,
        })
        .collect();
    Ok(events)
}

fn has_table(db: &Connection, name: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )
}

pub fn database(reader: Reader, path: &Path) -> Result<Vec<UsageEvent>> {
    let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let tx = db.transaction()?;
    let mut events = Vec::new();
    if reader == Reader::Hermes {
        if has_table(&tx, "session_model_usage")? {
            let mut stmt = tx.prepare("SELECT session_id, model, CAST(MAX(COALESCE(last_seen,first_seen)) * 1000 AS INTEGER),
                SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(api_call_count)
                FROM session_model_usage GROUP BY session_id, model")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let (Some(at), Some(model)) = (
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(1)?,
                ) else {
                    continue;
                };
                let Some(at) = DateTime::from_timestamp_millis(at) else {
                    continue;
                };
                let counts = [row.get::<_, i64>(3)?, row.get(4)?, row.get(5)?, row.get(6)?];
                let responses: i64 = row.get(7)?;
                if responses <= 0 || counts.iter().any(|&n| n < 0) {
                    continue;
                }
                let [input, output, read, write] = counts.map(|n| n as u64);
                let key = format!("{}:{model}", row.get::<_, String>(0)?);
                if let Some(mut event) = (Tokens {
                    input,
                    output,
                    read,
                    write,
                })
                .event(reader, key, at.to_rfc3339(), &Value::String(model))
                {
                    event.cumulative_responses = Some(responses);
                    events.push(event);
                }
            }
        }
    } else {
        // Select just the usage metadata from the v1 and v2 message projections.
        for (table, role, model) in [
            ("session_message", "type", "$.model.id"),
            ("message", "json_extract(data,'$.role')", "$.modelID"),
        ] {
            if !has_table(&tx, table)? {
                continue;
            }
            let mut stmt = tx.prepare(&format!("SELECT id, time_created, json_extract(data,'{model}'), json_extract(data,'$.tokens')
                FROM {table} WHERE json_valid(data) AND {role} = 'assistant' AND json_type(data,'$.tokens') = 'object'"))?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let Some(at) = DateTime::from_timestamp_millis(row.get(1)?) else {
                    continue;
                };
                let data: String = row.get(3)?;
                let tokens: Value = serde_json::from_str(&data)?;
                let model: Option<String> = row.get(2)?;
                if let Some(event) = opencode(&tokens, row.get(0)?, at.to_rfc3339(), model.into()) {
                    events.push(event);
                }
            }
        }
    }
    tx.commit()?;
    Ok(events)
}

fn opencode(u: &Value, id: String, at: String, model: Value) -> Option<UsageEvent> {
    let input = u["input"].as_u64()?;
    let output = u["output"].as_u64()?;
    let read = optional_count(&u["cache"], "read")?;
    let write = optional_count(&u["cache"], "write")?;
    let reasoning = optional_count(u, "reasoning")?;
    // Older v1 releases included reasoning in output. When a native total
    // exists, add only the part of reasoning outside the other buckets.
    let extra = match u["total"].as_u64() {
        Some(total) => total
            .saturating_sub(
                input
                    .checked_add(output)?
                    .checked_add(read)?
                    .checked_add(write)?,
            )
            .min(reasoning),
        None => reasoning,
    };
    Tokens {
        input,
        output: output.checked_add(extra)?,
        read,
        write,
    }
    .event(Reader::OpenCode, id, at, &model)
}
