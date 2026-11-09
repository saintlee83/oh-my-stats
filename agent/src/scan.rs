use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::Result;
use chrono::{DateTime, Utc};
use chrono_tz::Tz;

use crate::config::home_dir;
use crate::machine::sha256_hex;
use crate::parse::{CLAUDE, CODEX, CodexChunk, CodexState, UsageEvent, parse_claude_line, parse_codex_line};
use crate::store::Store;

#[derive(Debug, Clone)]
pub struct LogRoots {
    pub claude: Vec<PathBuf>,
    pub codex: Vec<PathBuf>,
}

pub fn default_roots() -> Result<LogRoots> {
    let home = home_dir()?;
    let mut claude = match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty()) {
        Some(dir) => vec![PathBuf::from(dir).join("projects")],
        None => vec![home.join(".claude/projects"), home.join(".config/claude/projects")],
    };
    // Claude Desktop keeps agent sessions of its own, in the same format.
    claude.push(home.join("Library/Application Support/Claude/local-agent-mode-sessions"));
    let codex_base = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".codex"));
    Ok(LogRoots { claude, codex: vec![codex_base.join("sessions"), codex_base.join("archived_sessions")] })
}

#[derive(Debug, Clone)]
pub struct LogFile {
    pub path: PathBuf,
    pub tool: &'static str,
    pub size: i64,
    pub mtime: i64,
}

fn walk(dir: &Path, tool: &'static str, matches: fn(&str) -> bool, out: &mut Vec<LogFile>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            walk(&path, tool, matches, out);
        } else if kind.is_file() && path.file_name().and_then(|name| name.to_str()).is_some_and(matches) {
            let Ok(meta) = entry.metadata() else { continue };
            let mtime = meta.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0, |time| time.as_millis() as i64);
            out.push(LogFile { path, tool, size: meta.len() as i64, mtime });
        }
    }
}

pub fn discover(roots: &LogRoots) -> Vec<LogFile> {
    let mut out = Vec::new();
    for root in &roots.claude {
        walk(root, CLAUDE, |name| name.ends_with(".jsonl"), &mut out);
    }
    for root in &roots.codex {
        walk(root, CODEX, |name| name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"), &mut out);
    }
    out
}

fn day_of(at: &str, tz: Tz) -> Option<String> {
    let time: DateTime<Utc> = at.parse().ok()?;
    Some(time.with_timezone(&tz).format("%Y-%m-%d").to_string())
}

/// Hands complete lines to `on_line` and returns how many bytes they took, so a line still
/// being written is read again next time rather than parsed half-finished.
fn read_lines<R: Read>(reader: R, mut on_line: impl FnMut(&str), last_line_may_be_open: bool) -> Result<u64> {
    let mut reader = BufReader::with_capacity(1 << 16, reader);
    let mut buffer = Vec::new();
    let mut consumed = 0u64;
    loop {
        buffer.clear();
        let read = reader.read_until(b'\n', &mut buffer)?;
        if read == 0 {
            return Ok(consumed);
        }
        if buffer.last() != Some(&b'\n') && last_line_may_be_open {
            return Ok(consumed);
        }
        consumed += read as u64;
        if let Ok(line) = std::str::from_utf8(&buffer) {
            on_line(line.trim_end());
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ScanReport {
    pub files: usize,
    pub read: usize,
    pub failed: usize,
    pub new_events: usize,
}

fn read_file(store: &mut Store, file: &LogFile, path_hash: &str, tz: Tz) -> Result<usize> {
    let saved = store.file(path_hash)?;
    let compressed = file.path.extension().is_some_and(|extension| extension == "zst");
    // A log that shrank was rewritten, and a compressed one can only be read whole.
    let resume = saved.as_ref().filter(|row| !compressed && row.offset <= file.size);
    let start = resume.map_or(0, |row| row.offset);
    let mut state = resume.map_or_else(CodexState::default, |row| row.state.clone());

    let source = File::open(&file.path)?;
    let mut claude_events: Vec<UsageEvent> = Vec::new();
    let mut chunk = CodexChunk::default();
    let tool = file.tool;
    let key = path_hash.to_string();
    let mut handle = |line: &str| {
        if tool == CLAUDE {
            claude_events.extend(parse_claude_line(line));
        } else {
            parse_codex_line(line, &key, &mut state, &mut chunk);
        }
    };

    let offset = if compressed {
        read_lines(zstd::stream::read::Decoder::new(source)?, &mut handle, false)?;
        file.size
    } else {
        let mut source = source;
        source.seek(SeekFrom::Start(start as u64))?;
        start + read_lines(source, &mut handle, true)? as i64
    };

    let first_model = chunk.first_model.clone();
    let events = if tool == CLAUDE { claude_events } else { chunk.into_events(&state) };
    let with_days: Vec<(UsageEvent, String)> = events
        .into_iter()
        .filter_map(|event| {
            let day = day_of(&event.at, tz)?;
            Some((event, day))
        })
        .collect();
    store.save_read(path_hash, file.size, file.mtime, offset, &state, &with_days, first_model.as_deref())?;
    Ok(with_days.len())
}

/// Reads only what's new: untouched files cost a `stat`, and a growing one is read from
/// where it was left. One unreadable log never stops the rest.
pub fn scan(store: &mut Store, roots: &LogRoots, tz: Tz) -> Result<ScanReport> {
    let files = discover(roots);
    let mut report = ScanReport { files: files.len(), ..Default::default() };
    for file in &files {
        let path_hash = sha256_hex(&file.path.to_string_lossy())[..24].to_string();
        if let Some(row) = store.file(&path_hash)?
            && row.size == file.size
            && row.mtime == file.mtime
        {
            continue;
        }
        report.read += 1;
        match read_file(store, file, &path_hash, tz) {
            Ok(events) => report.new_events += events,
            Err(_) => report.failed += 1,
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;
    use std::io::Write;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let unique = format!("oms-{label}-{}-{:?}", std::process::id(), std::thread::current().id());
            let path = std::env::temp_dir().join(unique.replace(['(', ')'], ""));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn row(id: &str, output: i64) -> String {
        format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"2026-11-08T23:30:00Z\",\"requestId\":\"r\",\"message\":{{\"id\":\"{id}\",\"model\":\"opus\",\"content\":\"TOP-SECRET\",\"usage\":{{\"input_tokens\":1,\"output_tokens\":{output}}}}}}}\n"
        )
    }

    fn roots(dir: &Path) -> LogRoots {
        LogRoots { claude: vec![dir.join("claude")], codex: vec![dir.join("codex")] }
    }

    fn append(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    const SEOUL: Tz = chrono_tz::Asia::Seoul;

    #[test]
    fn days_use_the_local_timezone() {
        let dir = TempDir::new("tz");
        let mut store = temp_store();
        append(&dir.0.join("claude/p/a.jsonl"), &row("m1", 5));
        scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        assert!(store.rollup().unwrap().contains_key("2026-11-09"), "23:30 UTC is the next day in Seoul");
    }

    #[test]
    fn only_new_lines_are_read_as_a_file_grows() {
        let dir = TempDir::new("grow");
        let mut store = temp_store();
        let path = dir.0.join("claude/p/a.jsonl");
        append(&path, &row("m1", 5));
        assert_eq!(scan(&mut store, &roots(&dir.0), SEOUL).unwrap().new_events, 1);

        let idle = scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        assert_eq!((idle.read, idle.new_events), (0, 0), "an untouched file is not read");

        append(&path, &row("m2", 7));
        let grown = scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        assert_eq!(grown.new_events, 1, "only the appended line");
        assert_eq!(store.event_count().unwrap(), 2);
    }

    #[test]
    fn a_line_still_being_written_waits_for_its_end() {
        let dir = TempDir::new("partial");
        let mut store = temp_store();
        let path = dir.0.join("claude/p/a.jsonl");
        let whole = row("m1", 5);
        let (first, rest) = whole.split_at(40);
        append(&path, first);
        assert_eq!(scan(&mut store, &roots(&dir.0), SEOUL).unwrap().new_events, 0);
        append(&path, rest);
        assert_eq!(scan(&mut store, &roots(&dir.0), SEOUL).unwrap().new_events, 1);
        assert_eq!(store.event_count().unwrap(), 1);
    }

    #[test]
    fn a_rewritten_file_is_read_again_without_double_counting() {
        let dir = TempDir::new("shrink");
        let mut store = temp_store();
        let path = dir.0.join("claude/p/a.jsonl");
        append(&path, &(row("m1", 5) + &row("m2", 6)));
        scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        fs::write(&path, row("m1", 5)).unwrap();
        scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        assert_eq!(store.event_count().unwrap(), 2);
    }

    #[test]
    fn history_survives_when_a_tool_deletes_its_logs() {
        let dir = TempDir::new("deleted");
        let mut store = temp_store();
        let path = dir.0.join("claude/p/a.jsonl");
        append(&path, &row("m1", 5));
        scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        fs::remove_file(&path).unwrap();
        scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        assert_eq!(store.event_count().unwrap(), 1);
    }

    #[test]
    fn compressed_codex_logs_are_read() {
        let dir = TempDir::new("zst");
        let mut store = temp_store();
        let lines = concat!(
            "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-6\"}}\n",
            "{\"type\":\"token_usage_record\",\"timestamp\":\"2026-11-08T10:00:00Z\",\"payload\":{\"response_id\":\"r1\",\"usage\":{\"input_tokens\":10,\"cached_input_tokens\":4,\"output_tokens\":1}}}\n",
        );
        let compressed = zstd::stream::encode_all(lines.as_bytes(), 0).unwrap();
        fs::create_dir_all(dir.0.join("codex")).unwrap();
        fs::write(dir.0.join("codex/a.jsonl.zst"), compressed).unwrap();
        scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        assert_eq!(store.rollup().unwrap()["2026-11-08"]["codex/gpt-6"], [6, 1, 4, 0, 1]);
    }

    #[test]
    fn a_corrupt_log_fails_alone() {
        let dir = TempDir::new("corrupt");
        let mut store = temp_store();
        fs::create_dir_all(dir.0.join("codex")).unwrap();
        fs::write(dir.0.join("codex/bad.jsonl.zst"), "this is not zstd").unwrap();
        append(&dir.0.join("claude/p/a.jsonl"), &row("m1", 5));
        let report = scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        assert_eq!(report.failed, 1);
        assert_eq!(store.event_count().unwrap(), 1);
    }

    #[test]
    fn nothing_from_the_logs_except_numbers_and_model_names_is_stored() {
        let dir = TempDir::new("private");
        let db = dir.0.join("agent.db");
        let mut store = Store::open(&db).unwrap();
        append(&dir.0.join("claude/secret-client-project/a.jsonl"), &row("m1", 5));
        scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        drop(store);
        let bytes = fs::read(&db).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("TOP-SECRET"));
        assert!(!text.contains("secret-client-project"));
        assert!(text.contains("opus"));
    }
}
