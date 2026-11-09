//! Reads usage out of AI tool logs. Rows are deserialized into structs that have only
//! usage fields, so prompts, responses and paths are skipped rather than ever held.

use serde::Deserialize;

pub const CLAUDE: &str = "claude";
pub const CODEX: &str = "codex";

/// One billable model response, normalized across tools: `input` excludes cached tokens,
/// and `output` includes reasoning tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageEvent {
    pub key: String,
    pub at: String,
    pub tool: &'static str,
    pub model: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

#[derive(Deserialize)]
struct ClaudeRow {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    message: Option<ClaudeMessage>,
}

#[derive(Deserialize)]
struct ClaudeMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<ClaudeUsage>,
}

#[derive(Deserialize)]
struct ClaudeUsage {
    #[serde(default)]
    input_tokens: Option<i64>,
    #[serde(default)]
    output_tokens: Option<i64>,
    #[serde(default)]
    cache_read_input_tokens: Option<i64>,
    #[serde(default)]
    cache_creation_input_tokens: Option<i64>,
}

fn count(value: Option<i64>) -> i64 {
    value.unwrap_or(0).max(0)
}

/// Claude Code writes one row per content block and copies rows into resumed sessions, so
/// about half of all rows repeat. `message.id:requestId` identifies the response, and the
/// store keeps the row with the most output, because rows can differ while it streams.
pub fn parse_claude_line(line: &str) -> Option<UsageEvent> {
    if !line.contains("\"usage\"") {
        return None;
    }
    let row: ClaudeRow = serde_json::from_str(line).ok()?;
    if row.kind.as_deref() != Some("assistant") {
        return None;
    }
    let message = row.message?;
    let usage = message.usage?;
    let model = message.model?;
    let id = message.id?;
    if model == "<synthetic>" {
        return None;
    }
    Some(UsageEvent {
        key: format!("{id}:{}", row.request_id.unwrap_or_default()),
        at: row.timestamp?,
        tool: CLAUDE,
        model,
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cache_read: count(usage.cache_read_input_tokens),
        cache_write: count(usage.cache_creation_input_tokens),
    })
}

#[derive(Deserialize)]
struct CodexRow {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    payload: Option<CodexPayload>,
}

#[derive(Deserialize)]
struct CodexPayload {
    #[serde(rename = "type")]
    kind: Option<String>,
    model: Option<String>,
    response_id: Option<String>,
    usage: Option<CodexUsage>,
    info: Option<CodexInfo>,
}

#[derive(Deserialize)]
struct CodexInfo {
    total_token_usage: Option<CodexUsage>,
    last_token_usage: Option<CodexUsage>,
}

#[derive(Deserialize, Clone)]
struct CodexUsage {
    #[serde(default)]
    input_tokens: Option<i64>,
    #[serde(default)]
    cached_input_tokens: Option<i64>,
    #[serde(default)]
    cache_write_input_tokens: Option<i64>,
    #[serde(default)]
    output_tokens: Option<i64>,
    #[serde(default)]
    total_tokens: Option<i64>,
}

/// What must carry over between reads of a growing Codex log.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CodexState {
    pub model: Option<String>,
    pub last_total: i64,
    pub has_records: bool,
}

/// One read's worth of a Codex log.
#[derive(Debug, Default)]
pub struct CodexChunk {
    records: Vec<UsageEvent>,
    legacy: Vec<UsageEvent>,
    /// A model first named in this chunk, for usage logged before it.
    pub first_model: Option<String>,
}

const UNKNOWN_MODEL: &str = "unknown";

fn normalize(usage: &CodexUsage) -> (i64, i64, i64, i64) {
    let cache_read = count(usage.cached_input_tokens);
    let cache_write = count(usage.cache_write_input_tokens);
    // Unlike Claude, OpenAI's input_tokens already includes cached tokens.
    let input = (count(usage.input_tokens) - cache_read - cache_write).max(0);
    (input, count(usage.output_tokens), cache_read, cache_write)
}

/// Newer Codex logs have a `token_usage_record` per response with a unique id. Older ones
/// only have `token_count` events, which repeat when nothing changed, so those are
/// deduped on the session's running total.
pub fn parse_codex_line(line: &str, file_key: &str, state: &mut CodexState, chunk: &mut CodexChunk) {
    if !line.contains("token_usage_record") && !line.contains("\"token_count\"") && !line.contains("\"turn_context\"") {
        return;
    }
    let Ok(row) = serde_json::from_str::<CodexRow>(line) else { return };
    let Some(payload) = row.payload else { return };
    let kind = row.kind.as_deref();

    if kind == Some("turn_context") {
        if let Some(model) = payload.model.filter(|model| !model.is_empty()) {
            if state.model.is_none() {
                chunk.first_model = Some(model.clone());
            }
            state.model = Some(model);
        }
        return;
    }

    let Some(at) = row.timestamp else { return };
    let model = state.model.clone().unwrap_or_else(|| UNKNOWN_MODEL.to_string());

    if kind == Some("token_usage_record") {
        let (Some(usage), Some(id)) = (payload.usage, payload.response_id) else { return };
        let (input, output, cache_read, cache_write) = normalize(&usage);
        state.has_records = true;
        chunk.records.push(UsageEvent { key: format!("codex:{id}"), at, tool: CODEX, model, input, output, cache_read, cache_write });
    } else if payload.kind.as_deref() == Some("token_count") {
        let Some(info) = payload.info else { return };
        let Some(last) = info.last_token_usage else { return };
        let total = count(info.total_token_usage.and_then(|usage| usage.total_tokens));
        if total == state.last_total {
            return;
        }
        state.last_total = total;
        let (input, output, cache_read, cache_write) = normalize(&last);
        chunk.legacy.push(UsageEvent { key: format!("codex:{file_key}:{total}"), at, tool: CODEX, model, input, output, cache_read, cache_write });
    }
}

impl CodexChunk {
    /// Newer logs carry both forms for the same responses, so they are never added together.
    pub fn into_events(self, state: &CodexState) -> Vec<UsageEvent> {
        if state.has_records { self.records } else { self.legacy }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "TOP-SECRET-PROMPT";

    fn claude_row(id: &str, output: i64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"2026-11-08T23:30:00.000Z","requestId":"r1","cwd":"/private/client","message":{{"id":"{id}","model":"claude-opus-5-5","content":[{{"type":"text","text":"{SECRET}"}}],"usage":{{"input_tokens":2,"output_tokens":{output},"cache_read_input_tokens":100,"cache_creation_input_tokens":50}}}}}}"#
        )
    }

    #[test]
    fn claude_rows_give_usage_and_nothing_else() {
        let event = parse_claude_line(&claude_row("m1", 40)).unwrap();
        assert_eq!(event.key, "m1:r1");
        assert_eq!((event.input, event.output, event.cache_read, event.cache_write), (2, 40, 100, 50));
        assert!(!format!("{event:?}").contains(SECRET));
        assert!(!format!("{event:?}").contains("private"));
    }

    #[test]
    fn claude_ignores_other_rows() {
        assert!(parse_claude_line(r#"{"type":"user","message":{"content":"has \"usage\" in it"}}"#).is_none());
        assert!(parse_claude_line(r#"{"truncated line with "usage" in it"#).is_none());
        let synthetic = r#"{"type":"assistant","timestamp":"t","message":{"id":"x","model":"<synthetic>","usage":{"input_tokens":9}}}"#;
        assert!(parse_claude_line(synthetic).is_none());
    }

    fn turn_context(model: &str) -> String {
        format!(r#"{{"type":"turn_context","timestamp":"t","payload":{{"model":"{model}","cwd":"/private/client"}}}}"#)
    }

    fn record(id: &str, input: i64, cached: i64, output: i64) -> String {
        format!(
            r#"{{"type":"token_usage_record","timestamp":"2026-11-08T10:00:00Z","payload":{{"response_id":"{id}","usage":{{"input_tokens":{input},"cached_input_tokens":{cached},"cache_write_input_tokens":0,"output_tokens":{output},"total_tokens":{}}}}}}}"#,
            input + output
        )
    }

    fn token_count(total: i64, last: i64) -> String {
        format!(
            r#"{{"type":"event_msg","timestamp":"2026-11-08T10:00:00Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"total_tokens":{total}}},"last_token_usage":{{"input_tokens":{last},"cached_input_tokens":0,"output_tokens":0,"total_tokens":{last}}}}}}}}}"#
        )
    }

    fn run(lines: &[String]) -> (Vec<UsageEvent>, CodexState, Option<String>) {
        let mut state = CodexState::default();
        let mut chunk = CodexChunk::default();
        for line in lines {
            parse_codex_line(line, "file", &mut state, &mut chunk);
        }
        let first = chunk.first_model.clone();
        (chunk.into_events(&state), state, first)
    }

    #[test]
    fn codex_input_excludes_cached_tokens() {
        let (events, _, _) = run(&[turn_context("gpt-6-astra"), record("r1", 1000, 800, 50)]);
        assert_eq!(events[0].input, 200);
        assert_eq!(events[0].cache_read, 800);
        assert_eq!(events[0].output, 50);
        assert_eq!(events[0].model, "gpt-6-astra");
    }

    #[test]
    fn codex_usage_before_the_first_turn_context_can_be_backfilled() {
        let (events, _, first) = run(&[record("r1", 10, 0, 1), turn_context("gpt-6-astra"), record("r2", 10, 0, 1)]);
        assert_eq!(events[0].model, "unknown");
        assert_eq!(events[1].model, "gpt-6-astra");
        assert_eq!(first.as_deref(), Some("gpt-6-astra"));
    }

    #[test]
    fn codex_records_and_token_counts_are_never_added_together() {
        let (events, _, _) = run(&[turn_context("m"), record("r1", 100, 0, 1), token_count(101, 101)]);
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn older_codex_logs_dedupe_repeated_token_counts() {
        let (events, _, _) = run(&[turn_context("m"), token_count(100, 100), token_count(100, 100), token_count(150, 50)]);
        assert_eq!(events.iter().map(|event| event.input).collect::<Vec<_>>(), vec![100, 50]);
    }

    #[test]
    fn codex_state_carries_across_reads_of_a_growing_file() {
        let mut state = CodexState::default();
        let mut first = CodexChunk::default();
        parse_codex_line(&turn_context("m"), "file", &mut state, &mut first);
        parse_codex_line(&token_count(100, 100), "file", &mut state, &mut first);
        let _ = first.into_events(&state);

        let mut second = CodexChunk::default();
        parse_codex_line(&token_count(100, 100), "file", &mut state, &mut second);
        parse_codex_line(&token_count(130, 30), "file", &mut state, &mut second);
        let events = second.into_events(&state);
        assert_eq!(events.len(), 1, "the repeat from the previous read is recognized");
        assert_eq!(events[0].model, "m");
        assert_eq!(events[0].input, 30);
    }
}
