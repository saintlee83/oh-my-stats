use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::Result;
use chrono::{DateTime, Utc};
use chrono_tz::Tz;

use crate::config::{home_dir, state_dir};
use crate::machine::sha256_hex;
use crate::parse::{CodexChunk, UsageEvent, parse_claude_line, parse_codex_line};
use crate::providers::{self, Reader};
use crate::store::{Cursor, FileRow, Store};

pub type LogRoots = Vec<(Reader, PathBuf)>;

pub fn default_roots(skip_native_logs: &[String]) -> Result<LogRoots> {
    let home = home_dir()?;
    let mut claude = match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty()) {
        Some(dir) => vec![PathBuf::from(dir).join("projects")],
        None => vec![home.join(".claude/projects"), home.join(".config/claude/projects")],
    };
    // Claude Desktop keeps agent sessions of its own, in the same format.
    claude.extend(claude_desktop_dirs(&home).into_iter().map(|dir| dir.join("local-agent-mode-sessions")));
    let codex_base = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".codex"));
    let setting = |key: &str, default: PathBuf| std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or(default);
    let data = setting("XDG_DATA_HOME", home.join(".local/share"));
    let qwen = setting("QWEN_RUNTIME_DIR", setting("QWEN_HOME", home.join(".qwen")));
    let hermes = setting("HERMES_HOME", home.join(".hermes"));
    let cline = setting("CLINE_DATA_DIR", setting("CLINE_DIR", home.join(".cline")).join("data"));
    let roaming = setting("APPDATA", home.join("AppData/Roaming"));
    // Goose keeps to ~/.local/share on macOS too, and only an absolute GOOSE_PATH_ROOT moves it.
    let goose = match std::env::var_os("GOOSE_PATH_ROOT").map(PathBuf::from).filter(|root| root.is_absolute()) {
        Some(root) => root.join("data"),
        None if cfg!(windows) => roaming.join("Block/goose/data"),
        None => data.join("goose"),
    };
    let pi = setting("PI_CODING_AGENT_DIR", home.join(".pi/agent")).join("sessions");
    // Zed keeps its threads with its other data, which each system puts somewhere else.
    let zed = if cfg!(windows) {
        setting("LOCALAPPDATA", home.join("AppData/Local")).join("Zed")
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Zed")
    } else {
        data.join("zed")
    };
    let mut roots: LogRoots = claude.into_iter().map(|path| (Reader::Claude, path)).collect();
    roots.extend([
        (Reader::Codex, codex_base.join("sessions")),
        (Reader::Codex, codex_base.join("archived_sessions")),
        (Reader::Gemini, home.join(".gemini/tmp")),
        (Reader::Pi, pi.clone()),
        (Reader::Qwen, qwen.join("projects")),
        (Reader::Copilot, setting("COPILOT_HOME", home.join(".copilot")).join("session-state")),
        (Reader::Kimi, setting("KIMI_CODE_HOME", home.join(".kimi-code")).join("sessions")),
        (Reader::Cline, setting("CLINE_SESSION_DATA_DIR", cline.join("sessions"))),
        (Reader::Amp, data.join("amp/threads")),
        (Reader::OpenCode, data.join("opencode/opencode.db")),
        (Reader::OpenCodeJson, data.join("opencode/storage/message")),
        (Reader::Hermes, hermes.join("state.db")),
        (Reader::Goose, goose.join("sessions/sessions.db")),
        (Reader::Kilo, data.join("kilo/kilo.db")),
        (Reader::Zed, zed.join("threads/threads.db")),
        (Reader::Export, state_dir()?.join("imports")),
    ]);
    if let Ok(profiles) = fs::read_dir(hermes.join("profiles")) {
        for profile in profiles.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())) {
            roots.push((Reader::Hermes, profile.path().join("state.db")));
        }
    }
    // Oh My Pi can be moved with the variables Pi reads too, so only its own folders are read:
    // the default one, the one it uses when the data folder already has one, and each profile's.
    let mut oh_my_pi = vec![home.join(".omp/agent/sessions"), data.join("omp/sessions")];
    for profiles in [home.join(".omp/profiles"), data.join("omp/profiles")] {
        for profile in fs::read_dir(profiles).into_iter().flatten().flatten() {
            oh_my_pi.extend([profile.path().join("agent/sessions"), profile.path().join("sessions")]);
        }
    }
    roots.extend(oh_my_pi.into_iter().filter(|sessions| *sessions != pi).map(|sessions| (Reader::OhMyPi, sessions)));
    // OpenClaw keeps a folder per agent, under ~/.openclaw, under ~/.openclaw-<profile> for
    // a named profile, and under ~/.clawdbot from before it was renamed.
    let mut openclaw = vec![setting("OPENCLAW_STATE_DIR", home.join(".openclaw")), home.join(".clawdbot")];
    openclaw.extend(fs::read_dir(&home).into_iter().flatten().flatten().filter(|entry| entry.file_name().to_string_lossy().starts_with(".openclaw-")).map(|entry| entry.path()));
    for state in openclaw {
        for agent in fs::read_dir(state.join("agents")).into_iter().flatten().flatten().map(|agent| agent.path()) {
            roots.push((Reader::OpenClaw, agent.join("sessions")));
            roots.push((Reader::OpenClawDb, agent.join("agent/openclaw-agent.sqlite")));
            // Codex keeps its own log of the turns an agent runs through it, in a folder the agent owns.
            roots.extend(["sessions", "archived_sessions"].map(|logs| (Reader::Codex, agent.join("agent/codex-home").join(logs))));
        }
    }
    for storage in editor_storage_dirs(&home, roaming, setting("XDG_CONFIG_HOME", home.join(".config"))) {
        roots.push((Reader::RooCode, storage.join("rooveterinaryinc.roo-cline/tasks")));
        roots.push((Reader::KiloCode, storage.join("kilocode.kilo-code/tasks")));
    }
    // Kilo Code's earlier JetBrains plugin and CLI ran the same extension outside an editor.
    for tasks in ["globalStorage/tasks", "globalStorage/kilo code.kilo-code/tasks", "cli/global/tasks"] {
        roots.push((Reader::KiloCode, home.join(".kilocode").join(tasks)));
    }
    roots.retain(|(reader, _)| !reader.provider().is_some_and(|id| skip_native_logs.iter().any(|skip| skip == id)));
    Ok(roots)
}

/// Claude Desktop's own folder. On Windows, a packaged (MSIX) install keeps it inside its package.
fn claude_desktop_dirs(home: &Path) -> Vec<PathBuf> {
    if !cfg!(windows) {
        return vec![home.join("Library/Application Support/Claude")];
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join("Claude")).into_iter().collect();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        for package in fs::read_dir(PathBuf::from(local).join("Packages")).into_iter().flatten().flatten() {
            if package.file_name().to_string_lossy().starts_with("Claude_") {
                dirs.push(package.path().join(r"LocalCache\Roaming\Claude"));
            }
        }
    }
    dirs
}

/// Where VS Code, and every editor built on it, lets extensions keep their own files. An
/// editor that is reached remotely runs its extensions, and keeps their files, on the remote side.
fn editor_storage_dirs(home: &Path, roaming: PathBuf, config: PathBuf) -> Vec<PathBuf> {
    let editors = if cfg!(windows) {
        roaming
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else {
        config
    };
    let mut dirs: Vec<PathBuf> = fs::read_dir(editors).into_iter().flatten().flatten().map(|editor| editor.path().join("User/globalStorage")).collect();
    dirs.extend([".vscode-server", ".vscode-server-insiders", ".cursor-server", ".windsurf-server"].map(|server| home.join(server).join("data/User/globalStorage")));
    dirs.retain(|dir| dir.is_dir());
    dirs
}

#[derive(Debug, Clone)]
pub struct LogFile {
    pub path: PathBuf,
    pub reader: Reader,
    pub identity: String,
    pub size: i64,
    pub mtime: i64,
}

fn walk(dir: &Path, reader: Reader, out: &mut Vec<LogFile>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            walk(&path, reader, out);
        } else if kind.is_file() && reader.accepts(&path) {
            let Ok(meta) = entry.metadata() else { continue };
            out.push(log_file(path, reader, &meta));
        }
    }
}

fn log_file(path: PathBuf, reader: Reader, meta: &fs::Metadata) -> LogFile {
    let mtime = meta.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0, |time| time.as_nanos() as i64);
    LogFile { path, reader, identity: file_identity(meta), size: meta.len() as i64, mtime }
}

pub fn discover(roots: &LogRoots) -> Vec<LogFile> {
    let mut out = Vec::new();
    for (reader, path) in roots {
        if reader.database() {
            if let Ok(meta) = fs::metadata(path) {
                // SQLite can commit usage to the WAL without touching the main file.
                let stamp = |m: &fs::Metadata| m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |t| t.as_nanos() as i64);
                let mut identity = file_identity(&meta);
                // The WAL has the database's whole name, which does not always end in `.db`.
                let mut wal = path.clone().into_os_string();
                wal.push("-wal");
                if let Ok(wal) = fs::metadata(wal) {
                    identity.push_str(&format!(":{}:{}:{}", file_identity(&wal), wal.len(), stamp(&wal)));
                }
                out.push(LogFile { path: path.clone(), reader: *reader, identity, size: meta.len() as i64, mtime: stamp(&meta) });
            }
        } else if reader.task_log() {
            // A task's folder also holds checkpoints of the workspace, so only its message log is looked at.
            for task in fs::read_dir(path).into_iter().flatten().flatten() {
                let log = task.path().join("ui_messages.json");
                if let Ok(meta) = fs::metadata(&log) && meta.is_file() {
                    out.push(log_file(log, *reader, &meta));
                }
            }
        } else {
            walk(path, *reader, &mut out);
        }
    }
    out
}

/// The server refuses dates from before AI tools existed, so a corrupt timestamp is skipped
/// here rather than holding up every upload after it.
const EARLIEST_DAY: &str = "2020-01-01";

fn day_of(at: &str, tz: Tz) -> Option<String> {
    let time: DateTime<Utc> = at.parse().ok()?;
    let day = time.with_timezone(&tz).date_naive();
    let latest = Utc::now().date_naive() + chrono::Duration::days(2);
    let label = day.to_string();
    (label.as_str() >= EARLIEST_DAY && day <= latest).then_some(label)
}

/// Hands complete lines to `on_line` and returns how many bytes they took, so a line still
/// being written is read again next time rather than parsed half-finished.
fn read_lines<R: Read>(reader: R, mut on_line: impl FnMut(&str, u64), last_line_may_be_open: bool) -> Result<u64> {
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
            on_line(line.trim_end(), consumed - read as u64);
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ScanReport {
    pub files: usize,
    pub read: usize,
    pub failed: usize,
    pub new_events: usize,
    pub invalid_exports: usize,
}

#[cfg(unix)]
fn file_identity(meta: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}:{}", meta.dev(), meta.ino())
}

#[cfg(not(unix))]
fn file_identity(_: &fs::Metadata) -> String { "file".into() }

/// Fingerprint the bytes just before the committed offset. Only the hash reaches SQLite.
fn boundary(source: &mut File, offset: i64) -> Result<String> {
    let length = offset.min(256);
    source.seek(SeekFrom::Start((offset - length) as u64))?;
    let mut bytes = [0; 256];
    source.read_exact(&mut bytes[..length as usize])?;
    Ok(crate::machine::hash_bytes(&bytes[..length as usize]))
}

fn path_key(path: &Path) -> String {
    sha256_hex(&path.to_string_lossy())[..24].to_string()
}

// Previous versions keyed legacy events by absolute path. Recognize the standard active,
// archived and compressed locations even when the file moved before the first upgrade scan.
fn old_codex_paths(path: &Path, roots: &LogRoots) -> Vec<String> {
    let plain = if path.extension().is_some_and(|e| e == "zst") { path.with_extension("") } else { path.to_owned() };
    let mut paths = vec![plain.clone()];
    if let Some(name) = plain.file_name().and_then(|n| n.to_str()) {
        for (_, root) in roots.iter().filter(|(reader, _)| *reader == Reader::Codex) {
            if let Some(date) = name.strip_prefix("rollout-").and_then(|n| n.get(..10))
                && let Ok(date) = date.parse::<chrono::NaiveDate>() {
                paths.push(root.join(name));
                paths.push(root.join(date.format("%Y/%m/%d").to_string()).join(name));
            }
        }
    }
    let mut keys: Vec<_> = paths.iter().flat_map(|p| [path_key(p), path_key(&p.with_extension("jsonl.zst"))]).collect();
    keys.sort();
    keys.dedup();
    keys
}

fn read_file(store: &mut Store, file: &LogFile, path_hash: &str, tz: Tz, saved: Option<FileRow>, roots: &LogRoots) -> Result<(usize, usize)> {
    if file.reader.database() {
        let events = providers::native::database(file.reader, &file.path)?.into_iter()
            .filter_map(|event| day_of(&event.at, tz).map(|day| (event, day))).collect::<Vec<_>>();
        let checkpoint = FileRow { size: file.size, mtime: file.mtime, offset: 0,
            state: Cursor { identity: file.identity.clone(), ..Default::default() } };
        return Ok((store.save_read(path_hash, &checkpoint, &[], &events, None)?, 0));
    }
    let mut source = File::open(&file.path)?;
    let meta = source.metadata()?;
    let size = i64::try_from(meta.len())?;
    let identity = file_identity(&meta);
    let compressed = file.path.extension().is_some_and(|e| e == "zst");
    let snapshot = (file.reader.task_log() || matches!(file.reader, Reader::Gemini | Reader::Amp | Reader::Cline | Reader::OpenCodeJson)) && file.path.extension().is_some_and(|e| e == "json");
    let mut start = 0;
    let mut cursor = Cursor::default();
    if let Some(row) = saved && !snapshot && !compressed && row.state.identity == identity
        && row.offset <= size && row.size < size && row.state.boundary == boundary(&mut source, row.offset)? {
        start = row.offset;
        cursor = row.state;
    }
    source.seek(SeekFrom::Start(start as u64))?;
    let mut events: Vec<UsageEvent> = Vec::new();
    let mut chunk = CodexChunk::default();
    let mut invalid_exports = 0;
    let mut handle = |line: &str, position: u64| match file.reader {
        Reader::Claude => events.extend(parse_claude_line(line)),
        Reader::Codex => parse_codex_line(line, &mut cursor.codex, &mut chunk),
        Reader::Gemini => providers::read_gemini_line(line, &mut events),
        Reader::Pi | Reader::Qwen | Reader::Kimi | Reader::Copilot | Reader::OpenClaw =>
            events.extend(providers::native::line(file.reader, line, &file.path, start as u64 + position)),
        Reader::OhMyPi if providers::native::import_marker(line) => events.clear(),
        Reader::OhMyPi => events.extend(providers::native::line(file.reader, line, &file.path, start as u64 + position)),
        Reader::Cline | Reader::Amp | Reader::OpenCode | Reader::OpenCodeJson | Reader::Hermes | Reader::Goose | Reader::RooCode | Reader::KiloCode | Reader::Kilo | Reader::OpenClawDb | Reader::Zed => unreachable!("snapshot reader"),
        Reader::Export => match providers::export_line(line) {
            Some(event) => events.push(event),
            None => invalid_exports += 1,
        },
    };
    let input = (&mut source).take((size - start) as u64);
    let offset = if snapshot {
        events = if file.reader == Reader::Gemini { providers::gemini_snapshot(BufReader::new(input))? }
            else { providers::native::snapshot(file.reader, BufReader::new(input), &file.path)? };
        size
    } else if compressed {
        read_lines(zstd::stream::read::Decoder::new(input)?, &mut handle, false)?;
        size
    } else {
        start + read_lines(input, &mut handle, true)? as i64
    };
    cursor.boundary = boundary(&mut source, offset)?;
    cursor.identity = identity;
    let first_model = chunk.first_model.clone();
    events.extend(chunk.into_events(&cursor.codex));
    let with_days: Vec<(UsageEvent, String)> = events
        .into_iter()
        .filter_map(|event| {
            let day = day_of(&event.at, tz);
            if day.is_none() && file.reader == Reader::Export {
                invalid_exports += 1;
            }
            let day = day?;
            Some((event, day))
        })
        .collect();
    let mut old_paths = Vec::new();
    if start == 0 && with_days.iter().any(|(event, _)| event.legacy_total.is_some()) {
        for candidate in old_codex_paths(&file.path, roots) {
            if store.file(&candidate)?.is_some_and(|row| row.state.identity.is_empty()) {
                old_paths.push(candidate);
            }
        }
    }
    let checkpoint = FileRow { size, mtime: file.mtime, offset, state: cursor };
    let added = store.save_read(path_hash, &checkpoint, &old_paths, &with_days, first_model.as_deref())?;
    Ok((added, invalid_exports))
}

/// Reads only what's new: untouched files cost a `stat`, and a growing one is read from
/// where it was left. One unreadable log never stops the rest.
pub fn scan(store: &mut Store, roots: &LogRoots, tz: Tz) -> Result<ScanReport> {
    let files = discover(roots);
    let mut report = ScanReport { files: files.len(), ..Default::default() };
    for file in &files {
        let path_hash = path_key(&file.path);
        let saved = store.file(&path_hash)?;
        if let Some(row) = &saved
            && row.state.identity == file.identity
            && row.size == file.size
            && row.mtime == file.mtime
        {
            continue;
        }
        report.read += 1;
        match read_file(store, file, &path_hash, tz, saved, roots) {
            Ok((events, invalid)) => {
                report.new_events += events;
                report.invalid_exports += invalid;
            }
            Err(_) => report.failed += 1,
        }
    }
    if report.invalid_exports > 0 {
        eprintln!("Skipped {} invalid provider export rows. Check the JSONL usage format.", report.invalid_exports);
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
        vec![(Reader::Claude, dir.join("claude")), (Reader::Codex, dir.join("codex")), (Reader::Gemini, dir.join("gemini")), (Reader::Export, dir.join("imports"))]
    }

    fn append(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    const SEOUL: Tz = chrono_tz::Asia::Seoul;

    #[test]
    fn a_corrupt_old_timestamp_has_no_day() {
        assert_eq!(day_of("1970-01-01T00:00:00Z", SEOUL), None);
        assert_eq!(day_of("2026-11-08T23:30:00Z", SEOUL).as_deref(), Some("2026-11-09"));
    }

    #[test]
    fn extension_folders_are_found_for_every_editor_and_for_remote_hosts() {
        let dir = TempDir::new("editors");
        let home = &dir.0;
        let config = home.join(".config");
        let roaming = home.join("AppData/Roaming");
        let editors = if cfg!(windows) { roaming.clone() } else if cfg!(target_os = "macos") { home.join("Library/Application Support") } else { config.clone() };
        let remote = home.join(".vscode-server/data/User/globalStorage");
        let cursor = editors.join("Cursor/User/globalStorage");
        for storage in [&remote, &cursor, &editors.join("Code - Insiders/User/globalStorage")] {
            fs::create_dir_all(storage).unwrap();
        }
        fs::create_dir_all(editors.join("Some other app")).unwrap();
        let found = editor_storage_dirs(home, roaming, config);
        assert!(found.contains(&remote) && found.contains(&cursor));
        assert_eq!(found.len(), 3, "an app without extension storage is left out");
    }

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
    fn repeated_rows_do_not_count_as_new_responses() {
        let dir = TempDir::new("repeat");
        let mut store = temp_store();
        let path = dir.0.join("claude/p/a.jsonl");
        append(&path, &row("m1", 5));
        assert_eq!(scan(&mut store, &roots(&dir.0), SEOUL).unwrap().new_events, 1);
        append(&path, &(row("m1", 5) + &row("m1", 5)));
        assert_eq!(scan(&mut store, &roots(&dir.0), SEOUL).unwrap().new_events, 0);
        append(&path, &row("m1", 9));
        assert_eq!(scan(&mut store, &roots(&dir.0), SEOUL).unwrap().new_events, 1, "a more complete row does count");
    }

    #[test]
    fn replacing_or_overwriting_a_log_with_a_larger_file_restarts_the_reader() {
        let dir = TempDir::new("rotation");
        let mut store = temp_store();
        let path = dir.0.join("claude/a.jsonl");
        append(&path, &row("m1", 5));
        scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        let replacement = dir.0.join("replacement");
        fs::write(&replacement, row("m2", 5) + &row("m3", 5)).unwrap();
        fs::rename(replacement, &path).unwrap();
        scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        assert_eq!(store.event_count().unwrap(), 3);
        fs::write(&path, row("m4", 5) + &row("m5", 5) + &row("m6", 5)).unwrap();
        scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        assert_eq!(store.event_count().unwrap(), 6);
    }

    #[test]
    fn archived_legacy_sessions_reconcile_pre_upgrade_rows_and_compressed_copies() {
        use crate::parse::CODEX;
        let dir = TempDir::new("archive");
        let mut store = temp_store();
        let active = dir.0.join("sessions");
        let archive = dir.0.join("archived_sessions");
        let name = "rollout-2026-11-08T10-00-00-sample.jsonl";
        let old_file = path_key(&active.join("2026/11/08").join(name));
        let event = UsageEvent {
            key: format!("codex:{old_file}:25"), at: "2026-11-08T10:00:00Z".into(),
            tool: CODEX.into(), model: "unknown".into(), input: 20, output: 5,
            cache_read: 0, cache_write: 0, legacy_total: None, cumulative_responses: None,
        };
        store.save_read(&old_file, &FileRow::default(), &[], &[(event, "2026-11-08".into())], None).unwrap();
        let lines = concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"session-id\"}}\n",
            "{\"type\":\"event_msg\",\"timestamp\":\"2026-11-08T10:00:00Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"total_tokens\":25},\"last_token_usage\":{\"input_tokens\":20,\"output_tokens\":5}}}}\n"
        );
        append(&archive.join(name), lines);
        let sources = vec![(Reader::Codex, active.clone()), (Reader::Codex, archive)];
        scan(&mut store, &sources, SEOUL).unwrap();
        fs::create_dir_all(&active).unwrap();
        fs::write(active.join("renamed.jsonl.zst"), zstd::stream::encode_all(lines.as_bytes(), 0).unwrap()).unwrap();
        scan(&mut store, &sources, SEOUL).unwrap();
        assert_eq!(store.rollup().unwrap()["2026-11-08"]["codex/unknown"], [20, 5, 0, 0, 1]);
    }

    #[test]
    fn gemini_and_export_readers_share_the_rollup_and_preserve_response_identity() {
        use serde_json::json;
        let dir = TempDir::new("providers");
        let mut store = temp_store();
        let gemini = dir.0.join("gemini/project/chats");
        let message = json!({
            "type": "gemini", "id": "abc", "timestamp": "2026-11-08T23:00:00Z", "model": "gemini-2.5-pro",
            "content": "PRIVATE", "tokens": {"input": 20, "cached": 5, "output": 6, "thoughts": 4, "tool": 2}
        });
        append(&gemini.join("session-a.jsonl"), &(message.to_string() + "\n"));
        append(&gemini.join("session-old.json"), &json!({"messages": [message]}).to_string());
        let mut queued = message.clone();
        queued["id"] = json!("checkpoint-only");
        append(&gemini.join("session-a.jsonl"), &(json!({"$set": {"messages": [message, queued]}}).to_string() + "\n"));
        let path = dir.0.join("imports/usage.jsonl");
        let export = json!({"provider":"local-ai","id":"abc","model":"my-model","timestamp":"2026-11-08T23:00:00Z","input":9,"output":2});
        append(&path, &(export.to_string() + "\n" + &export.to_string() + "\n"));
        let mut invalid = export.clone();
        invalid["id"] = json!("different");
        invalid["model"] = json!("bad model");
        append(&path, &(invalid.to_string() + "\n"));
        let report = scan(&mut store, &roots(&dir.0), SEOUL).unwrap();
        assert_eq!((report.new_events, report.failed, report.invalid_exports), (3, 0, 1));
        let day = &store.rollup().unwrap()["2026-11-09"];
        assert_eq!(day["gemini/gemini-2.5-pro"], [34, 20, 10, 0, 2]);
        assert_eq!(day["local-ai/my-model"], [9, 2, 0, 0, 1]);
        assert_eq!(day.len(), 2);
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
