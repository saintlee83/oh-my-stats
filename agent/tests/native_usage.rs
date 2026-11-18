// Exercise the real preview command, including default discovery, SQLite WALs,
// timezone bucketing and resuming JSONL files. No installed CLIs are invoked.
use rusqlite::Connection;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Home(PathBuf);

impl Home {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self(std::env::temp_dir().join(format!("oms-native-{}-{nonce}", std::process::id())))
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
