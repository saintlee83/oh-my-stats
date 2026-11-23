//! Persisted CLI formats. Terminal streams and session summaries can describe the
//! same calls as these records, so each reader uses one source of usage.
use std::fmt;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use anyhow::{Context, Result};
use chrono::DateTime;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde::de::{Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
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
    if reader == Reader::OpenClaw {
        return openclaw(line, None);
    }
    let row: Value = serde_json::from_str(line).ok()?;
    match (reader, row["type"].as_str()?) {
        (Reader::Pi | Reader::OhMyPi, "message") if row["message"]["role"] == "assistant" => {
            let msg = &row["message"];
            // Oh My Pi stores zero for a time it does not know.
            let sent = Some(&msg["timestamp"]).filter(|at| reader == Reader::Pi || **at != 0);
            let at = sent
                .and_then(timestamp)
                .or_else(|| timestamp(&row["timestamp"]))?;
            let key = format!("{}:{}", at, id(&row["id"])?);
            Tokens::parse(
                &msg["usage"],
                ["input", "output", "cacheRead", "cacheWrite"],
            )?
            .event(reader, key, at, &msg["model"])
        }
        // Oh My Pi logs model calls made outside the conversation on their own. A turn it
        // discards is logged again this way under a new ID, after counting as a message.
        (Reader::OhMyPi, "model_usage") if row["purpose"] != "discarded-turn" => {
            let at = timestamp(&row["timestamp"])?;
            let key = format!("{}:{}", at, id(&row["id"])?);
            Tokens::parse(
                &row["usage"],
                ["input", "output", "cacheRead", "cacheWrite"],
            )?
            .event(reader, key, at, &row["model"])
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

/// One entry of an OpenClaw transcript. A session's file, its agent's database and the copy
/// a fork makes can all hold the same entry, so it is known by its own ID, time and counts,
/// wherever it is found. `stored` is when a database took the entry in.
fn openclaw(entry: &str, stored: Option<i64>) -> Option<UsageEvent> {
    // Most entries are prompts and tool results, which can be long.
    if !entry.contains("\"usage\"") {
        return None;
    }
    let row: Value = serde_json::from_str(entry).ok()?;
    let msg = &row["message"];
    if row["type"] != "message" || msg["role"] != "assistant" {
        return None;
    }
    // OpenClaw writes some assistant entries itself, such as the record of a delivered
    // reply. A turn it ran through Codex is mirrored with the counts of its last response
    // only, and Codex keeps every response in the agent's Codex folder, read as Codex.
    let mirrored = |key: &str| key.starts_with("codex-app-server:");
    if msg["provider"] == "openclaw" || msg["idempotencyKey"].as_str().is_some_and(mirrored) {
        return None;
    }
    let tokens = Tokens::parse(
        &msg["usage"],
        ["input", "output", "cacheRead", "cacheWrite"],
    )?;
    let sent = msg["timestamp"].as_i64();
    // A database stamps an entry when it takes it in, which for an imported session is later
    // than when the entry was written.
    let at = timestamp(&msg["timestamp"])
        .or_else(|| timestamp(&row["timestamp"]))
        .or_else(|| timestamp(&Value::from(stored?)))?;
    let key = format!(
        "{}:{}:{}:{}",
        id(&row["id"])?,
        sent.map(|ms| ms.to_string()).unwrap_or_default(),
        tokens.input,
        tokens.output
    );
    tokens.event(Reader::OpenClaw, key, at, &msg["model"])
}

/// A whole transcript, as OpenClaw keeps a deleted or reset session in its database.
fn openclaw_transcript(input: impl Read, stored: Option<i64>, events: &mut Vec<UsageEvent>) {
    for entry in BufReader::new(input).lines().map_while(|line| line.ok()) {
        events.extend(openclaw(&entry, stored));
    }
}

/// OpenClaw compresses no event past this size, and no transcript is read past it.
const OPENCLAW_EVENT_BYTES: usize = 4 << 20;
const OPENCLAW_TRANSCRIPT_BYTES: u64 = 1 << 30;

/// What a Zed thread keeps of its usage. The conversation itself is skipped.
#[derive(Deserialize)]
struct ZedThread {
    #[serde(default)]
    cumulative_token_usage: Value,
    #[serde(default)]
    model: Value,
    #[serde(default)]
    messages: Vec<ZedMessage>,
}

/// Whether a message of a Zed thread is one of the agent's replies.
struct ZedMessage(bool);

impl<'de> Deserialize<'de> for ZedMessage {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Kind;

        impl<'de> Visitor<'de> for Kind {
            type Value = ZedMessage;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a thread message")
            }

            // A message with nothing in it, such as `Resume`, is stored as its name alone.
            fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
                Ok(ZedMessage(false))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut kinds: A) -> Result<Self::Value, A::Error> {
                let mut reply = false;
                while let Some(kind) = kinds.next_key::<String>()? {
                    reply |= kind == "Agent";
                    kinds.next_value::<IgnoredAny>()?;
                }
                Ok(ZedMessage(reply))
            }
        }

        deserializer.deserialize_any(Kind)
    }
}

const ZED_THREAD_BYTES: u64 = 256 << 20;

impl ZedThread {
    fn read(kind: &str, data: &[u8]) -> Option<Self> {
        match kind {
            "zstd" => {
                let thread = zstd::stream::read::Decoder::new(data).ok()?;
                serde_json::from_reader(thread.take(ZED_THREAD_BYTES)).ok()
            }
            "json" => serde_json::from_slice(data).ok(),
            _ => None,
        }
    }

    /// Zed adds up every request of a thread here. It also keeps the last request of each
    /// turn, which leaves out the earlier requests of a turn that called tools.
    fn event(self, thread: String, updated: String) -> Option<UsageEvent> {
        let usage = &self.cumulative_token_usage;
        let tokens = Tokens {
            input: optional_count(usage, "input_tokens")?,
            output: optional_count(usage, "output_tokens")?,
            read: optional_count(usage, "cache_read_input_tokens")?,
            write: optional_count(usage, "cache_creation_input_tokens")?,
        };
        let mut event = tokens.event(Reader::Zed, thread, updated, &self.model["model"])?;
        let replies = self.messages.iter().filter(|message| message.0).count();
        event.cumulative_responses = Some(replies.max(1) as i64);
        Some(event)
    }
}

/// Oh My Pi ends a session it imported from Claude Code or Codex with this entry. The
/// usage before it is that tool's, which its own reader counts.
pub fn import_marker(line: &str) -> bool {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Entry {
        #[serde(rename = "type")]
        kind: String,
        custom_type: String,
    }
    line.contains("foreign_session_import")
        && serde_json::from_str::<Entry>(line)
            .is_ok_and(|e| e.kind == "custom" && e.custom_type == "foreign_session_import")
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

/// One row of a task's `ui_messages.json`. Most rows are chat text, so each row is
/// dropped as soon as it has been looked at.
#[derive(Default, Deserialize)]
#[serde(default)]
struct TaskRow {
    ts: Value,
    #[serde(rename = "type")]
    kind: Option<String>,
    say: Option<String>,
    text: Option<String>,
}

/// The counts an `api_req_started` row keeps as JSON in its text, next to the request
/// itself, which is skipped.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiRequest {
    tokens_in: u64,
    tokens_out: u64,
    cache_writes: Option<u64>,
    cache_reads: Option<u64>,
}

impl TaskRow {
    fn into_event(self, reader: Reader, task: &str) -> Option<UsageEvent> {
        if self.kind.as_deref() != Some("say") || self.say.as_deref() != Some("api_req_started") {
            return None;
        }
        let sent = self.ts.as_u64()?;
        let request: ApiRequest = serde_json::from_str(self.text.as_deref()?).ok()?;
        let read = request.cache_reads.unwrap_or(0);
        let write = request.cache_writes.unwrap_or(0);
        // Roo Code since 3.29.5 and Kilo Code since 4.119.0 store the whole prompt in
        // tokensIn, cached parts included. Before that it depended on the provider. A
        // count smaller than its cached parts can only be the uncached rest, and any
        // other count is read as the whole prompt, so cached input is never counted twice.
        let input = request
            .tokens_in
            .checked_sub(read.checked_add(write)?)
            .unwrap_or(request.tokens_in);
        Tokens {
            input,
            output: request.tokens_out,
            read,
            write,
        }
        .event(
            reader,
            format!("{task}:{sent}"),
            timestamp(&self.ts)?,
            &Value::Null,
        )
    }
}

/// Reads a task log one row at a time, so a long conversation is never held whole.
fn task_log(reader: Reader, input: impl Read, path: &Path) -> Result<Vec<UsageEvent>> {
    struct Rows<'a>(Reader, &'a str);

    impl<'de> Visitor<'de> for Rows<'_> {
        type Value = Vec<UsageEvent>;

        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a list of task messages")
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut rows: A) -> Result<Self::Value, A::Error> {
            let mut events = Vec::new();
            while let Some(row) = rows.next_element::<TaskRow>()? {
                events.extend(row.into_event(self.0, self.1));
            }
            Ok(events)
        }
    }

    let task = path
        .parent()
        .and_then(|dir| dir.file_name())
        .and_then(|name| name.to_str())
        .context("a task log sits in its task's folder")?;
    Ok(serde_json::Deserializer::from_reader(input).deserialize_seq(Rows(reader, task))?)
}

pub fn snapshot(reader: Reader, input: impl Read, path: &Path) -> Result<Vec<UsageEvent>> {
    if reader.task_log() {
        return task_log(reader, input, path);
    }
    if reader == Reader::OpenCodeJson {
        let row: Value = serde_json::from_reader(input)?;
        let event = || {
            if row["role"] != "assistant" {
                return None;
            }
            opencode(
                reader,
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

fn has_column(db: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
        [table, column],
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
    } else if reader == Reader::Goose {
        if has_table(&tx, "usage_ledger")? {
            // The ledger has a row per model call. A carried-forward row restates session
            // totals from before the ledger, which an imported transcript also has, and a
            // session that runs another tool's CLI repeats what that tool logged itself.
            let mut stmt = tx.prepare(
                "SELECT l.id, l.session_id, CAST(l.created_timestamp AS INTEGER), l.model,
                COALESCE(l.input_tokens,0), COALESCE(l.output_tokens,0),
                COALESCE(l.cache_read_tokens,0), COALESCE(l.cache_write_tokens,0)
                FROM usage_ledger l LEFT JOIN sessions s ON s.id = l.session_id
                WHERE l.cost_source IS NOT 'carried_forward'
                AND COALESCE(s.provider_name,'') NOT IN ('claude-code','codex','gemini-cli','cursor-agent')
                AND COALESCE(s.provider_name,'') NOT LIKE '%-acp'",
            )?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let Some(at) = row
                    .get::<_, Option<i64>>(2)?
                    .and_then(|seconds| DateTime::from_timestamp(seconds, 0))
                else {
                    continue;
                };
                let counts = [row.get::<_, i64>(4)?, row.get(5)?, row.get(6)?, row.get(7)?];
                if counts.iter().any(|&n| n < 0) {
                    continue;
                }
                let [prompt, output, read, write] = counts.map(|n| n as u64);
                let key = format!("{}:{}", row.get::<_, String>(1)?, row.get::<_, i64>(0)?);
                let model: Option<String> = row.get(3)?;
                // Goose stores the whole prompt and treats the cached parts as inside it.
                let tokens = Tokens {
                    input: prompt.saturating_sub(read).saturating_sub(write),
                    output,
                    read,
                    write,
                };
                events.extend(tokens.event(reader, key, at.to_rfc3339(), &model.into()));
            }
        }
    } else if reader == Reader::OpenClawDb {
        if has_table(&tx, "transcript_events")? {
            // A long event is stored compressed, in columns an earlier database lacks. An
            // event of a session moved to cold storage has neither form here.
            let packed = if has_column(&tx, "transcript_events", "event_zstd")? {
                "event_zstd, event_utf8_bytes"
            } else {
                "NULL, NULL"
            };
            let mut stmt = tx.prepare(&format!(
                "SELECT event_json, created_at, {packed} FROM transcript_events
                WHERE event_json IS NULL OR instr(event_json, '\"usage\"') > 0"
            ))?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let stored = row.get::<_, Option<i64>>(1).ok().flatten();
                let entry = match row.get::<_, Option<String>>(0)? {
                    Some(entry) => Some(entry),
                    None => {
                        let packed: Option<Vec<u8>> = row.get(2)?;
                        let size = row.get::<_, Option<i64>>(3)?.unwrap_or(0) as usize;
                        packed
                            .filter(|_| (1..=OPENCLAW_EVENT_BYTES).contains(&size))
                            .and_then(|bytes| zstd::bulk::decompress(&bytes, size).ok())
                            .and_then(|bytes| String::from_utf8(bytes).ok())
                    }
                };
                events.extend(entry.and_then(|entry| openclaw(&entry, stored)));
            }
        }
        if has_table(&tx, "session_transcript_archives")? {
            let mut stmt = tx.prepare(
                "SELECT encoding, archive_blob, created_at FROM session_transcript_archives",
            )?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let encoding: String = row.get(0)?;
                let transcript: Vec<u8> = row.get(1)?;
                let stored = row.get::<_, Option<i64>>(2).ok().flatten();
                if encoding == "identity" {
                    openclaw_transcript(&transcript[..], stored, &mut events);
                } else if encoding == "zstd"
                    && let Ok(plain) = zstd::stream::read::Decoder::new(&transcript[..])
                {
                    let plain = plain.take(OPENCLAW_TRANSCRIPT_BYTES);
                    openclaw_transcript(plain, stored, &mut events);
                }
            }
        }
    } else if reader == Reader::Zed {
        if has_table(&tx, "threads")? {
            let mut stmt = tx.prepare("SELECT id, updated_at, data_type, data FROM threads")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let kind: String = row.get(2)?;
                let data: Vec<u8> = row.get(3)?;
                // One thread that cannot be read is left out, and the rest still count.
                if let Some(thread) = ZedThread::read(&kind, &data) {
                    events.extend(thread.event(row.get(0)?, row.get(1)?));
                }
            }
        }
    } else if reader == Reader::Kilo {
        if has_table(&tx, "part")? && has_table(&tx, "message")? {
            // Kilo records each model call as a step under its assistant message, and counts
            // its own usage from those steps. A fork copies them under new IDs, so a step is
            // known by its message's time and its counts instead.
            let mut stmt = tx.prepare(
                "SELECT m.time_created, COALESCE(json_extract(p.data,'$.model.modelID'), json_extract(m.data,'$.modelID')),
                json_extract(p.data,'$.tokens')
                FROM part p JOIN message m ON m.id = p.message_id
                WHERE json_valid(p.data) AND json_valid(m.data) AND json_extract(m.data,'$.role') = 'assistant'
                AND json_extract(p.data,'$.type') = 'step-finish' AND json_type(p.data,'$.tokens') = 'object'",
            )?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let sent: i64 = row.get(0)?;
                let Some(at) = DateTime::from_timestamp_millis(sent) else {
                    continue;
                };
                let data: String = row.get(2)?;
                let tokens: Value = serde_json::from_str(&data)?;
                let counts = [
                    &tokens["input"],
                    &tokens["output"],
                    &tokens["reasoning"],
                    &tokens["cache"]["read"],
                    &tokens["cache"]["write"],
                ]
                .map(|n| n.as_u64().unwrap_or(0).to_string());
                let key = format!("{sent}:{}", counts.join(":"));
                let model: Option<String> = row.get(1)?;
                events.extend(opencode(
                    reader,
                    &tokens,
                    key,
                    at.to_rfc3339(),
                    model.into(),
                ));
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
                if let Some(event) =
                    opencode(reader, &tokens, row.get(0)?, at.to_rfc3339(), model.into())
                {
                    events.push(event);
                }
            }
        }
    }
    tx.commit()?;
    Ok(events)
}

fn opencode(reader: Reader, u: &Value, id: String, at: String, model: Value) -> Option<UsageEvent> {
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
    .event(reader, id, at, &model)
}
