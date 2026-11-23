// Exercise the real preview command, including default discovery, SQLite WALs,
// timezone bucketing and resuming JSONL files. No installed CLIs are invoked.
use rusqlite::Connection;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Home(PathBuf);

/// Tests run side by side in one process, and the clock can give two of them the same
/// instant. The count keeps each one's folder its own.
static HOMES: AtomicUsize = AtomicUsize::new(0);

impl Home {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = HOMES.fetch_add(1, Ordering::Relaxed);
        Self(std::env::temp_dir().join(format!(
            "oms-native-{}-{nonce}-{count}",
            std::process::id()
        )))
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write(home: &Path, file: &str, records: &[Value]) {
    let path = home.join(file);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        records.iter().map(|v| format!("{v}\n")).collect::<String>(),
    )
    .unwrap();
}

fn database(home: &Path, file: &str, schema: &str) -> Connection {
    let path = home.join(file);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    conn.execute_batch(schema).unwrap();
    conn
}

fn preview(home: &Path) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_oms"))
        .arg("preview")
        .env_clear()
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("PATH", home.join("no-tools"))
        .env("OMS_TIMEZONE", "Asia/Seoul")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let s = String::from_utf8(output.stdout).unwrap();
    assert!(!s.contains("PRIVATE"));
    serde_json::from_str::<Value>(&s).unwrap()["days"].clone()
}

#[test]
fn native_history_replays_once_and_picks_up_new_usage() {
    let home = Home::new();
    let at = "2025-01-01T18:00:00Z";
    let ms = at
        .parse::<chrono::DateTime<chrono::Utc>>()
        .unwrap()
        .timestamp_millis();
    let path = &home.0;
    let pi = json!({"type":"message","id":"1234abcd","timestamp":at,"message":{"role":"assistant","model":"m","content":"PRIVATE","usage":{"input":8,"output":3,"cacheRead":4,"cacheWrite":5}}});
    write(
        path,
        ".pi/agent/sessions/project/live.jsonl",
        &[pi.clone(), pi],
    );
    let qwen = json!({"type":"assistant","uuid":"a","timestamp":at,"model":"m","usageMetadata":{"promptTokenCount":20,"cachedContentTokenCount":3,"candidatesTokenCount":9,"thoughtsTokenCount":5,"totalTokenCount":29}});
    write(
        path,
        ".qwen/projects/p/chats/s.jsonl",
        std::slice::from_ref(&qwen),
    );
    write(path, ".qwen/projects/p/chats/archive/s.jsonl", &[qwen]);
    write(
        path,
        ".copilot/session-state/s/events.jsonl",
        &[
            json!({"type":"session.usage_record","id":"x","timestamp":at,"data":{"usage":{"accounting":{"usageId":"r"},"model":"m","inputTokens":30,"outputTokens":2,"cacheReadTokens":9,"cacheWriteTokens":6}}}),
            json!({"type":"session.shutdown","timestamp":at,"data":{"modelMetrics":{"m":{"usage":{"inputTokens":30,"outputTokens":2}}}}}),
        ],
    );
    let kimi = json!({"type":"usage.record","time":ms,"model":"m","usage":{"inputOther":1,"output":2,"inputCacheRead":3,"inputCacheCreation":4}});
    let wire = ".kimi-code/sessions/p/s/agents/main/wire.jsonl";
    write(
        path,
        wire,
        &[
            json!({"type":"context.append_loop_event","event":kimi}),
            kimi.clone(),
        ],
    );
    let msg = json!({"role":"assistant","id":"a","ts":ms,"modelInfo":{"id":"m"},"metrics":{"inputTokens":12,"outputTokens":3,"cacheReadTokens":5,"cacheWriteTokens":2}});
    write(
        path,
        ".cline/data/sessions/s/s.messages.json",
        &[
            json!({"version":1,"sessionId":"s","messages":[{"role":"assistant","content":"PRIVATE"},msg]}),
        ],
    );
    write(
        path,
        ".local/share/amp/threads/T-test.json",
        &[
            json!({"id":"T-test","created":ms,"messages":[{"role":"user","meta":{"sentAt":ms}},{"role":"assistant","messageId":1,"usage":{"model":"m","inputTokens":8,"outputTokens":4,"cacheReadInputTokens":9,"cacheCreationInputTokens":5}}]}),
        ],
    );
    let oc = database(
        path,
        ".local/share/opencode/opencode.db",
        "CREATE TABLE session_message (id TEXT, type TEXT, time_created INTEGER, data TEXT);
         CREATE TABLE message (id TEXT, time_created INTEGER, data TEXT);",
    );
    let v2 = json!({"model":{"id":"m"},"tokens":{"input":9,"output":3,"reasoning":2,"cache":{"read":2,"write":1}}});
    let v1 = json!({"role":"assistant","modelID":"m","tokens":{"total":17,"input":9,"output":5,"reasoning":2,"cache":{"read":2,"write":1}}});
    oc.execute(
        "INSERT INTO session_message VALUES ('a','assistant',?1,?2)",
        rusqlite::params![ms, v2.to_string()],
    )
    .unwrap();
    oc.execute(
        "INSERT INTO message VALUES ('a',?1,?2)",
        rusqlite::params![ms, v1.to_string()],
    )
    .unwrap();
    let mut old = v1.clone();
    old["id"] = json!("a");
    old["time"] = json!({"created": ms});
    write(
        path,
        ".local/share/opencode/storage/message/s/msg_a.json",
        &[old],
    );
    let hermes = database(
        path,
        ".hermes/state.db",
        "CREATE TABLE session_model_usage (session_id TEXT,model TEXT,first_seen REAL,last_seen REAL,input_tokens INT,output_tokens INT,cache_read_tokens INT,cache_write_tokens INT,api_call_count INT);",
    );
    hermes
        .execute(
            "INSERT INTO session_model_usage VALUES ('s','m',?1,?1,10,5,3,2,4)",
            [ms / 1000],
        )
        .unwrap();

    let first = preview(path);
    assert_eq!(
        first,
        json!({"2025-01-02":{
            "pi/m":[8,3,4,5,1],"copilot-cli/m":[15,2,9,6,1],"qwen-code/m":[17,9,3,0,1],
            "cline-cli/m":[5,3,5,2,1],"kimi-cli/m":[1,2,3,4,1],"amp/m":[8,4,9,5,1],
            "opencode/m":[9,5,2,1,1],"hermes-agent/m":[10,5,3,2,4]
        }})
    );
    assert_eq!(preview(path), first);

    // The database writers stay open, and only the WAL grows.
    oc.execute(
        "INSERT INTO session_message VALUES ('b','assistant',?1,?2)",
        rusqlite::params![ms, v2.to_string()],
    )
    .unwrap();
    hermes.execute("UPDATE session_model_usage SET input_tokens=13,api_call_count=5,last_seen=last_seen+86400", []).unwrap();
    use std::io::Write;
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(path.join(wire))
            .unwrap(),
        "{kimi}"
    )
    .unwrap();
    let updated = preview(path);
    assert_eq!(
        updated["2025-01-02"]["opencode/m"],
        json!([18, 10, 4, 2, 2])
    );
    assert_eq!(
        updated["2025-01-02"]["hermes-agent/m"],
        json!([10, 5, 3, 2, 4])
    );
    assert_eq!(
        updated["2025-01-03"]["hermes-agent/m"],
        json!([3, 0, 0, 0, 1])
    );
    assert_eq!(updated["2025-01-02"]["kimi-cli/m"], json!([2, 4, 6, 8, 2]));
    assert_eq!(preview(path), updated);
}

#[test]
fn old_responses_survive_upgrade_and_export_only_histories_are_collected_once() {
    let home = Home::new();
    let path = &home.0;
    drop(database(path, ".oh-my-stats/agent.db",
        "CREATE TABLE events (key TEXT PRIMARY KEY,file TEXT NOT NULL,tool TEXT NOT NULL,model TEXT NOT NULL,
         day TEXT NOT NULL,input INTEGER NOT NULL,output INTEGER NOT NULL,cache_read INTEGER NOT NULL,cache_write INTEGER NOT NULL) WITHOUT ROWID;
         INSERT INTO events VALUES ('old','file','claude','m','2025-01-02',9,2,3,4);"));
    write(
        path,
        ".oh-my-stats/config.json",
        &[json!({"skipNativeLogs":["pi"]})],
    );
    write(
        path,
        ".pi/agent/sessions/p/a.jsonl",
        &[
            json!({"type":"message","id":"native","timestamp":"2025-01-02T00:00:00Z",
        "message":{"role":"assistant","model":"m","usage":{"input":3,"output":4}}}),
        ],
    );
    write(
        path,
        ".oh-my-stats/imports/pi.jsonl",
        &[
            json!({"provider":"pi","id":"exported","model":"m","timestamp":"2025-01-02T00:00:00Z",
        "input":3,"output":4}),
        ],
    );
    assert_eq!(
        preview(path),
        json!({"2025-01-02":{"claude/m":[9,2,3,4,1],"pi/m":[3,4,0,0,1]}})
    );
}

#[test]
fn editor_task_logs_count_each_request_once_and_cached_input_once() {
    let home = Home::new();
    let path = &home.0;
    let ms: i64 = 1_735_754_400_000;
    let request = |sent: i64, text: Value| json!({"ts":sent,"type":"say","say":"api_req_started","text":text.to_string()});
    let chat = json!({"ts":ms,"type":"say","say":"text","text":"PRIVATE"});
    let log = ".vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks/task-1/ui_messages.json";
    let rows = vec![
        chat.clone(),
        // The whole prompt, as Roo Code has stored it since 3.29.5.
        request(
            ms + 1,
            json!({"apiProtocol":"anthropic","request":"PRIVATE","tokensIn":100,"tokensOut":7,"cacheWrites":20,"cacheReads":70,"cost":0.01}),
        ),
        // Only the uncached part, as older versions stored it for some providers.
        request(
            ms + 2,
            json!({"request":"PRIVATE","tokensIn":4,"tokensOut":5,"cacheWrites":0,"cacheReads":90}),
        ),
        // A request that is still running has no counts yet.
        request(ms + 3, json!({"apiProtocol":"openai","request":"PRIVATE"})),
        json!({"ts":ms + 4,"type":"say","say":"api_req_deleted","text":json!({"tokensIn":50,"tokensOut":50}).to_string()}),
        json!({"ts":ms + 5,"type":"ask","ask":"followup","text":"PRIVATE"}),
    ];
    let save = |rows: &[Value]| {
        let file = path.join(log);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, Value::from(rows.to_vec()).to_string()).unwrap();
    };
    save(&rows);
    // A task folder also holds checkpoints, which are never opened.
    write(
        path,
        ".vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks/task-1/checkpoints/ui_messages.json",
        &[json!([request(
            ms,
            json!({"tokensIn":999,"tokensOut":999})
        )])],
    );
    // Kilo Code keeps the same kind of log, also for its earlier CLI.
    write(
        path,
        ".kilocode/cli/global/tasks/task-2/ui_messages.json",
        &[json!([request(
            ms + 1,
            json!({"apiProtocol":"openai","tokensIn":50,"tokensOut":4,"cacheReads":30,"usageMissing":false})
        )])],
    );
    let kilo = json!([20, 4, 30, 0, 1]);

    let first = preview(path);
    assert_eq!(
        first,
        json!({"2025-01-02":{"roo-code/unknown":[14,12,160,20,2],"kilo-code/unknown":kilo}})
    );
    assert_eq!(preview(path), first);

    // The extension rewrites the whole file as the task goes on.
    let mut grown = rows.clone();
    grown[3] = request(
        ms + 3,
        json!({"apiProtocol":"openai","request":"PRIVATE","tokensIn":30,"tokensOut":2,"cacheReads":10}),
    );
    save(&grown);
    let updated = preview(path);
    assert_eq!(
        updated,
        json!({"2025-01-02":{"roo-code/unknown":[34,14,170,20,3],"kilo-code/unknown":kilo}})
    );
    assert_eq!(preview(path), updated);
}

#[test]
fn goose_ledger_rows_count_once_and_leave_out_what_other_readers_cover() {
    let home = Home::new();
    let path = &home.0;
    let seconds: i64 = 1_735_754_400;
    let file = if cfg!(windows) {
        "AppData/Roaming/Block/goose/data/sessions/sessions.db"
    } else {
        ".local/share/goose/sessions/sessions.db"
    };
    let goose = database(
        path,
        file,
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, provider_name TEXT, model_config_json TEXT,
           accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER);
         CREATE TABLE usage_ledger (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
           created_timestamp INTEGER NOT NULL, model TEXT,
           input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
           cache_read_tokens INTEGER, cache_write_tokens INTEGER,
           cost REAL, cost_source TEXT, is_compaction INTEGER DEFAULT 0);
         INSERT INTO sessions (id, provider_name) VALUES
           ('20250101_1','anthropic'), ('20250101_2','claude-code'), ('20250101_3','codex-acp'), ('20250101_4',NULL);",
    );
    // Goose stamps a row with strftime('%s','now'), and leaves out what a provider did not report.
    let ledger = |rows: &str| {
        goose
            .execute_batch(&format!(
                "INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens,
                 cache_read_tokens, cache_write_tokens, cost_source, is_compaction) VALUES {rows}"
            ))
            .unwrap();
    };
    let at = format!("strftime('%s', {seconds}, 'unixepoch')");
    // In order: a prompt count that holds its cached parts, a compaction call, session totals
    // from before the ledger that Goose restated later, a provider that reported nothing, two
    // sessions that ran Claude Code and Codex, which keep their own logs, and a session whose
    // provider is not recorded.
    ledger(&format!(
        "('20250101_1', {at}, 'm', 100, 7, 60, 10, 'estimated', 0),
         ('20250101_1', {at}, 'm', 40, 3, NULL, NULL, NULL, 1),
         ('20250101_1', {at}, NULL, 900, 90, 0, 0, 'carried_forward', 0),
         ('20250101_1', {at}, 'm', NULL, NULL, NULL, NULL, NULL, 0),
         ('20250101_2', {at}, 'm', 50, 5, 0, 0, NULL, 0),
         ('20250101_3', {at}, 'm', 50, 5, NULL, NULL, NULL, 0),
         ('20250101_4', {at}, 'n', 8, 2, 9, 0, NULL, 0)"
    ));

    let first = preview(path);
    assert_eq!(
        first,
        json!({"2025-01-02":{"goose/m":[70,10,60,10,2],"goose/n":[0,2,9,0,1]}})
    );
    assert_eq!(preview(path), first);

    // Goose keeps the database open, and only the WAL grows.
    ledger(&format!(
        "('20250101_1', strftime('%s', {}, 'unixepoch'), 'm', 5, 1, 0, 0, NULL, 0)",
        seconds + 86_400
    ));
    let updated = preview(path);
    assert_eq!(updated["2025-01-02"], first["2025-01-02"]);
    assert_eq!(updated["2025-01-03"], json!({"goose/m":[5,1,0,0,1]}));
    assert_eq!(preview(path), updated);
}

#[test]
fn oh_my_pi_sessions_count_each_model_call_once() {
    let home = Home::new();
    let path = &home.0;
    let at = "2025-01-01T18:00:00.000Z";
    let ms: i64 = 1_735_754_400_000;
    let usage = |input: u64, output: u64, read: u64, write: u64| json!({"input":input,"output":output,"cacheRead":read,"cacheWrite":write,"totalTokens":input + output + read + write});
    let reply = |id: &str, sent: i64, model: &str, usage: Value| {
        json!({"type":"message","id":id,"parentId":null,"timestamp":at,
        "message":{"role":"assistant","content":"PRIVATE","provider":"p","model":model,"usage":usage,"timestamp":sent}})
    };
    let title = json!({"type":"title","v":1,"title":"PRIVATE","updatedAt":at,"pad":""});
    let header = json!({"type":"session","version":3,"id":"s","timestamp":at,"cwd":"/PRIVATE"});
    let turn = reply("aaaa1111", ms, "m", usage(8, 3, 4, 5));
    let sessions = ".omp/agent/sessions/-project";
    write(
        path,
        &format!("{sessions}/2025-01-01T18-00-00-000Z_s.jsonl"),
        &[
            title.clone(),
            header.clone(),
            turn.clone(),
            json!({"type":"model_usage","id":"bbbb2222","parentId":"aaaa1111","timestamp":at,"purpose":"title",
                "api":"a","provider":"p","model":"tiny","usage":usage(2, 1, 0, 0),"stopReason":"stop"}),
            // A turn taken back is logged again under a new ID.
            json!({"type":"model_usage","id":"cccc3333","parentId":null,"timestamp":at,"purpose":"discarded-turn",
                "api":"a","provider":"p","model":"m","usage":usage(8, 3, 4, 5),"stopReason":"stop"}),
            // The task tool repeats what its subagents used, and they have files of their own.
            json!({"type":"message","id":"dddd0000","parentId":null,"timestamp":at,
                "message":{"role":"toolResult","toolName":"task","details":{"usage":usage(1, 1, 0, 0)},"timestamp":ms}}),
        ],
    );
    write(
        path,
        &format!("{sessions}/2025-01-01T18-00-00-000Z_s/agent-1.jsonl"),
        &[
            header.clone(),
            reply("dddd4444", ms, "m", usage(1, 1, 0, 0)),
        ],
    );
    // A fork starts as a copy of the session it left.
    write(
        path,
        &format!("{sessions}/2025-01-01T19-00-00-000Z_fork.jsonl"),
        &[title.clone(), header.clone(), turn],
    );
    write(
        path,
        &format!("{sessions}/.omp-gc-compress-a1b2c3/copy.jsonl"),
        &[reply("eeee5555", ms, "m", usage(900, 900, 0, 0))],
    );
    // A session brought over from Claude Code holds usage that Claude Code logged.
    write(
        path,
        &format!("{sessions}/2025-01-01T20-00-00-000Z_imported.jsonl"),
        &[
            title,
            header,
            reply("ffff6666", ms, "claude", usage(100, 10, 0, 0)),
            json!({"type":"custom","id":"abab0000","parentId":"ffff6666","timestamp":at,
                "customType":"foreign_session_import","data":{"source":"claude","sourcePath":"/PRIVATE"}}),
            reply("abcd7777", 0, "m", usage(5, 2, 0, 0)),
        ],
    );

    let first = preview(path);
    assert_eq!(
        first,
        json!({"2025-01-02":{"oh-my-pi/m":[14,6,4,5,3],"oh-my-pi/tiny":[2,1,0,0,1]}})
    );
    assert_eq!(preview(path), first);
}

#[test]
fn kilo_steps_count_once_across_forks_and_long_turns() {
    let home = Home::new();
    let path = &home.0;
    let ms: i64 = 1_735_754_400_000;
    let kilo = database(
        path,
        ".local/share/kilo/kilo.db",
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
         CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
    );
    let message = |id: &str, session: &str, sent: i64, data: Value| {
        kilo.execute(
            "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
            rusqlite::params![id, session, sent, data.to_string()],
        )
        .unwrap();
    };
    let part = |id: &str, message: &str, session: &str, written: i64, data: Value| {
        kilo.execute(
            "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            rusqlite::params![id, message, session, written, data.to_string()],
        )
        .unwrap();
    };
    let tokens = |input: u64, output: u64, reasoning: u64, read: u64, write: u64| json!({"input":input,"output":output,"reasoning":reasoning,"cache":{"read":read,"write":write}});
    let step =
        |tokens: &Value| json!({"type":"step-finish","reason":"stop","cost":0.1,"tokens":tokens});
    let first_step = tokens(9, 3, 2, 2, 1);
    let last_step = tokens(4, 1, 0, 20, 0);
    // The message keeps only its last step's counts.
    let turn = json!({"role":"assistant","modelID":"m","providerID":"p","time":{"created":ms},"cost":0.2,"tokens":last_step});
    message("msg_1", "ses_1", ms, turn.clone());
    part(
        "prt_0",
        "msg_1",
        "ses_1",
        ms,
        json!({"type":"text","text":"PRIVATE"}),
    );
    part("prt_1", "msg_1", "ses_1", ms + 1, step(&first_step));
    part("prt_2", "msg_1", "ses_1", ms + 2, step(&last_step));
    // A fork copies the turn under new IDs and keeps its counts.
    message("msg_2", "ses_2", ms, turn);
    part("prt_3", "msg_2", "ses_2", ms + 900, step(&first_step));
    part("prt_4", "msg_2", "ses_2", ms + 900, step(&last_step));
    // A step names the model that served it when a router chose one.
    let routed = tokens(6, 2, 0, 0, 0);
    message(
        "msg_3",
        "ses_2",
        ms + 5,
        json!({"role":"assistant","modelID":"router/auto","time":{"created":ms + 5},"tokens":routed}),
    );
    let mut served = step(&routed);
    served["model"] = json!({"providerID":"p","modelID":"served"});
    part("prt_5", "msg_3", "ses_2", ms + 6, served);
    // A task brought over from the earlier extension has no usage of its own.
    message(
        "msg_migrated_1",
        "ses_migrated_1",
        ms,
        json!({"role":"assistant","modelID":"legacy","providerID":"legacy","time":{"created":ms},"cost":0,"tokens":tokens(0, 0, 0, 0, 0)}),
    );
    message(
        "msg_4",
        "ses_1",
        ms,
        json!({"role":"user","time":{"created":ms}}),
    );

    let first = preview(path);
    assert_eq!(
        first,
        json!({"2025-01-02":{"kilo-code/m":[13,6,22,1,2],"kilo-code/served":[6,2,0,0,1]}})
    );
    assert_eq!(preview(path), first);
}

#[test]
fn openclaw_entries_count_once_across_files_databases_and_forks() {
    let home = Home::new();
    let path = &home.0;
    let at = "2025-01-01T18:00:00.000Z";
    let ms: i64 = 1_735_754_400_000;
    let usage = |input: u64, output: u64, read: u64, write: u64| json!({"input":input,"output":output,"cacheRead":read,"cacheWrite":write,"totalTokens":input + output + read + write,"cost":{"total":0.01}});
    let reply = |id: &str, sent: Option<i64>, model: &str, usage: Value| {
        let mut message = json!({"role":"assistant","content":[{"type":"text","text":"PRIVATE"}],
            "api":"anthropic-messages","provider":"anthropic","model":model,"usage":usage});
        if let Some(sent) = sent {
            message["timestamp"] = json!(sent);
        }
        json!({"type":"message","id":id,"parentId":null,"timestamp":at,"message":message})
    };
    let lines = |entries: &[Value]| entries.iter().map(|v| format!("{v}\n")).collect::<String>();
    let header = json!({"type":"session","version":3,"id":"s1","timestamp":at,"cwd":"/PRIVATE"});
    let prompt = json!({"type":"message","id":"u0000001","timestamp":at,
        "message":{"role":"user","content":"PRIVATE, with \"usage\" in it","timestamp":ms}});
    let turn = reply("aaaa1111", Some(ms), "m", usage(8, 3, 4, 5));
    // OpenClaw writes the record of a delivered reply itself.
    let mut delivered = reply("dddd0000", Some(ms), "delivery-mirror", usage(7, 7, 7, 7));
    delivered["message"]["provider"] = json!("openclaw");
    delivered["message"]["api"] = json!("openclaw-transcript");
    // A turn run through Codex is mirrored with its last response only.
    let mut mirrored = reply("cccc0000", Some(ms), "gpt", usage(50, 5, 0, 0));
    mirrored["message"]["idempotencyKey"] = json!("codex-app-server:thread-1:turn-1:assistant");
    let sessions = ".openclaw/agents/main/sessions";
    let live = format!("{sessions}/s1.jsonl");
    write(
        path,
        &live,
        &[header.clone(), prompt, turn.clone(), delivered, mirrored],
    );
    // A fork starts as a copy of the session it left.
    write(
        path,
        &format!("{sessions}/fork.jsonl"),
        &[header.clone(), turn.clone()],
    );
    // A checkpoint, a backup and a trajectory are not sessions of their own.
    let other = [reply("eeee0000", Some(ms), "m", usage(900, 900, 0, 0))];
    for name in [
        "s1.checkpoint.0b0f3a52-6c1e-4d57-9d0a-3c1f2f4a5b6c.jsonl",
        "s1.trajectory.jsonl",
        "s1.jsonl.bak.2025-01-01T18-00-00.000Z",
    ] {
        write(path, &format!("{sessions}/{name}"), &other);
    }
    // A deleted session keeps its file under a longer name. This entry has no time in its
    // message, so the time of the entry is used.
    write(
        path,
        &format!("{sessions}/gone.jsonl.deleted.2025-01-01T18-00-00.000Z"),
        &[reply("bbbb2222", None, "m", usage(1, 1, 0, 0))],
    );
    // A reset session's file can be compressed.
    let reset = lines(&[reply("cccc3333", Some(ms), "n", usage(2, 2, 0, 0))]);
    fs::write(
        path.join(format!(
            "{sessions}/old.jsonl.reset.2025-01-01T18-00-00.000Z.zst"
        )),
        zstd::stream::encode_all(reset.as_bytes(), 0).unwrap(),
    )
    .unwrap();
    // A named profile has a folder of its own.
    write(
        path,
        ".openclaw-work/agents/helper/sessions/p.jsonl",
        &[reply("abab7777", Some(ms), "n", usage(5, 5, 0, 0))],
    );
    // Codex logs every response of the turns an agent runs through it.
    write(
        path,
        ".openclaw/agents/main/agent/codex-home/sessions/2025/01/02/rollout-2025-01-02T03-00-00-thread-1.jsonl",
        &[
            json!({"type":"turn_context","payload":{"model":"gpt"}}),
            json!({"type":"token_usage_record","timestamp":at,"payload":{"response_id":"r1",
                "usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":1}}}),
        ],
    );

    let agent = database(
        path,
        ".openclaw/agents/main/agent/openclaw-agent.sqlite",
        "CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT,
           created_at INTEGER NOT NULL, event_zstd BLOB, event_utf8_bytes INTEGER, PRIMARY KEY (session_id, seq)) STRICT;
         CREATE TABLE session_transcript_archives (session_id TEXT NOT NULL, generation TEXT NOT NULL,
           encoding TEXT NOT NULL, archive_blob BLOB NOT NULL, archive_sha256 TEXT NOT NULL,
           created_at INTEGER NOT NULL, PRIMARY KEY (session_id, generation)) STRICT;",
    );
    // The database stamps an entry when it takes it in, here a day after it was written.
    let taken = ms + 86_400_000;
    let event = |session: &str, seq: i64, entry: &Value| {
        agent
            .execute(
                "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![session, seq, entry.to_string(), taken],
            )
            .unwrap();
    };
    // A session brought over from its file is in both places.
    event("s1", 1, &turn);
    event("s2", 1, &reply("dddd4444", Some(ms), "m", usage(10, 2, 0, 0)));
    event(
        "s2",
        2,
        &json!({"type":"message","id":"u0000002","timestamp":at,
            "message":{"role":"user","content":"PRIVATE \"usage\"","timestamp":ms}}),
    );
    // A long entry is stored compressed, and one in cold storage is not stored here at all.
    let long = reply("eeee5555", None, "m", usage(3, 1, 0, 0)).to_string();
    agent
        .execute(
            "INSERT INTO transcript_events (session_id, seq, created_at, event_zstd, event_utf8_bytes)
             VALUES ('s2', 3, ?1, ?2, ?3), ('s3', 1, ?1, NULL, NULL)",
            rusqlite::params![
                taken,
                zstd::bulk::compress(long.as_bytes(), 0).unwrap(),
                long.len() as i64
            ],
        )
        .unwrap();
    // Deleted and reset sessions are kept whole, and one of them was a fork.
    let kept = lines(&[
        header.clone(),
        reply("ffff6666", Some(ms), "m", usage(4, 1, 0, 0)),
    ]);
    agent
        .execute(
            "INSERT INTO session_transcript_archives VALUES
             ('s4', 'g1', 'identity', ?1, 'x', ?3), ('s5', 'g1', 'zstd', ?2, 'x', ?3)",
            rusqlite::params![
                kept.as_bytes(),
                zstd::stream::encode_all(lines(&[header, turn]).as_bytes(), 0).unwrap(),
                taken
            ],
        )
        .unwrap();

    let first = preview(path);
    assert_eq!(
        first,
        json!({"2025-01-02":{"openclaw/m":[26,8,4,5,5],"openclaw/n":[7,7,0,0,2],"codex/gpt":[6,1,4,0,1]}})
    );
    assert_eq!(preview(path), first);

    // OpenClaw keeps the database open, and only the WAL grows. The file grows too.
    let next = taken;
    event("s2", 4, &reply("9999aaaa", Some(next), "m", usage(5, 1, 0, 0)));
    use std::io::Write;
    write!(
        fs::OpenOptions::new()
            .append(true)
            .open(path.join(&live))
            .unwrap(),
        "{}",
        lines(&[reply("8888bbbb", Some(next), "m", usage(6, 2, 0, 0))])
    )
    .unwrap();
    let updated = preview(path);
    assert_eq!(updated["2025-01-02"], first["2025-01-02"]);
    assert_eq!(updated["2025-01-03"], json!({"openclaw/m":[11,3,0,0,2]}));
    assert_eq!(preview(path), updated);
}

#[test]
fn zed_threads_count_their_growth_once_and_keep_what_a_cut_back_thread_used() {
    let home = Home::new();
    let path = &home.0;
    let file = if cfg!(windows) {
        "AppData/Local/Zed/threads/threads.db"
    } else if cfg!(target_os = "macos") {
        "Library/Application Support/Zed/threads/threads.db"
    } else {
        ".local/share/zed/threads/threads.db"
    };
    let zed = database(
        path,
        file,
        "CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL,
           data_type TEXT NOT NULL, data BLOB NOT NULL);",
    );
    let usage = |input: u64, output: u64, read: u64, write: u64| json!({"input_tokens":input,"output_tokens":output,"cache_creation_input_tokens":write,"cache_read_input_tokens":read});
    let thread = |total: Value, replies: usize, model: &str| {
        let mut messages = vec![json!({"User":{"id":"u1","content":[{"Text":"PRIVATE"}]}})];
        messages.extend(std::iter::repeat_n(
            json!({"Agent":{"content":[{"Text":"PRIVATE"}],"tool_results":{}}}),
            replies,
        ));
        messages.push(json!("Resume"));
        // Zed also keeps the last request of each turn, which is less than the turn used.
        json!({"title":"PRIVATE","messages":messages,"updated_at":"2025-01-01T18:00:00Z",
            "cumulative_token_usage":total,"request_token_usage":{"u1":usage(40, 5, 100, 0)},
            "model":{"provider":"anthropic","model":model}})
    };
    let packed = |thread: &Value| zstd::stream::encode_all(thread.to_string().as_bytes(), 0).unwrap();
    let save = |id: &str, updated: &str, kind: &str, data: Vec<u8>| {
        zed.execute(
            "INSERT OR REPLACE INTO threads VALUES (?1, 'PRIVATE', ?2, ?3, ?4)",
            rusqlite::params![id, updated, kind, data],
        )
        .unwrap();
    };
    let day = "2025-01-01T18:00:00+00:00";
    save(
        "t1",
        day,
        "zstd",
        packed(&thread(usage(100, 20, 300, 5), 2, "m")),
    );
    // An earlier thread is plain JSON, and a count of zero is left out of it.
    let plain = thread(json!({"input_tokens":7,"output_tokens":1}), 1, "n");
    save("t2", day, "json", plain.to_string().into_bytes());
    // A thread that has not called a model yet, and one that cannot be read.
    save("t3", day, "zstd", packed(&thread(json!({}), 0, "m")));
    save("t4", day, "zstd", b"not a thread".to_vec());
    // A thread saved before version 0.3.0 gives each message a role. Zed loads an assistant's
    // message as a reply and leaves out a system message.
    let message = |role: &str| json!({"id":0,"role":role,"segments":[{"type":"text","text":"PRIVATE"}],
        "tool_uses":[],"tool_results":[],"context":"","creases":[],"is_hidden":false});
    let legacy = json!({"version":"0.2.0","summary":"PRIVATE","updated_at":"2025-01-01T18:00:00Z",
        "messages":[message("system"),message("user"),message("assistant"),message("user"),message("assistant")],
        "cumulative_token_usage":usage(9, 2, 0, 0),"request_token_usage":[],
        "detailed_summary_state":"NotGenerated","model":{"provider":"anthropic","model":"l"}});
    save("t5", day, "zstd", packed(&legacy));

    let first = preview(path);
    assert_eq!(
        first,
        json!({"2025-01-02":{"zed/l":[9,2,0,0,2],"zed/m":[100,20,300,5,2],"zed/n":[7,1,0,0,1]}})
    );
    assert_eq!(preview(path), first);

    // The next day the thread is cut back to its first reply, and goes on from there.
    save(
        "t1",
        "2025-01-02T18:00:00+00:00",
        "zstd",
        packed(&thread(usage(150, 30, 300, 5), 1, "m")),
    );
    let cut = preview(path);
    assert_eq!(cut["2025-01-02"], first["2025-01-02"]);
    assert_eq!(cut["2025-01-03"], json!({"zed/m":[50,10,0,0,0]}));
    // Later that day it is switched to another model.
    save(
        "t1",
        "2025-01-02T19:00:00+00:00",
        "zstd",
        packed(&thread(usage(160, 31, 300, 5), 3, "o")),
    );
    let grown = preview(path);
    assert_eq!(
        grown["2025-01-03"],
        json!({"zed/m":[50,10,0,0,0],"zed/o":[10,1,0,0,1]})
    );
    assert_eq!(preview(path), grown);
}
