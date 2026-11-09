use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use anyhow::Result;
use serde_json::Value;

use super::Log;
use super::classify::{SKIPPED, classify_path};
use super::client::{Gh, GhError};
use crate::store::Store;

/// Stop while this much REST budget is left, so other tools on this token keep working.
const RESERVE: i64 = 200;
const BATCH: usize = 200;
const WORKERS: usize = 8;

#[derive(Debug, Clone)]
pub struct ChurnTarget {
    pub oid: String,
    pub repo: String,
    pub add: i64,
    pub del: i64,
    pub merge: bool,
}

/// Lines changed per language in one commit.
pub type CommitChurn = BTreeMap<String, (i64, i64)>;

pub fn summarize(files: &[Value], max_file_lines: i64) -> CommitChurn {
    let mut out = CommitChurn::new();
    for file in files {
        let add = file.get("additions").and_then(Value::as_i64).unwrap_or(0);
        let del = file.get("deletions").and_then(Value::as_i64).unwrap_or(0);
        let language = if add + del > max_file_lines { SKIPPED.to_string() } else { classify_path(file.get("filename").and_then(Value::as_str).unwrap_or("")) };
        let totals = out.entry(language).or_insert((0, 0));
        totals.0 += add;
        totals.1 += del;
    }
    out
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ChurnResult {
    pub done: usize,
    pub pending: usize,
    pub failed: usize,
}

/// Fetches per-file stats for commits not yet known. GitHub has no bulk form of this, so
/// it's one call per commit. Results are saved in batches, so a run that hits its budget
/// simply continues next time.
pub fn collect(gh: &Gh, store: &mut Store, targets: &[ChurnTarget], max_requests: usize, max_file_lines: i64, log: Log<'_>) -> Result<(ChurnResult, HashMap<String, CommitChurn>)> {
    let mut known: HashMap<String, CommitChurn> = HashMap::new();
    let mut queue: Vec<&ChurnTarget> = Vec::new();
    let mut empty: Vec<(String, String)> = Vec::new();
    for target in targets {
        if let Some(data) = store.churn_for(&target.oid)? {
            known.insert(target.oid.clone(), serde_json::from_str(&data).unwrap_or_default());
        } else if target.merge || target.add + target.del == 0 {
            // Merges would double-count their parents; empty commits have nothing to fetch.
            known.insert(target.oid.clone(), CommitChurn::new());
            empty.push((target.oid.clone(), "{}".to_string()));
        } else {
            queue.push(target);
        }
    }
    store.save_churn(&empty)?;

    if !queue.is_empty() {
        log(&format!("churn: {} commits to fetch (budget {max_requests})", queue.len()));
    }
    let requests = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let out_of_budget = || {
        let remaining = gh.rest_remaining.load(Ordering::Relaxed);
        stop.load(Ordering::Relaxed) || requests.load(Ordering::Relaxed) >= max_requests || (remaining >= 0 && remaining <= RESERVE)
    };

    for batch in queue.chunks(BATCH) {
        if out_of_budget() {
            break;
        }
        let next = AtomicUsize::new(0);
        let results: Mutex<Vec<(String, CommitChurn)>> = Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for _ in 0..WORKERS {
                scope.spawn(|| {
                    while !out_of_budget() {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(target) = batch.get(index) else { return };
                        requests.fetch_add(1, Ordering::Relaxed);
                        match gh.rest(&format!("/repos/{}/commits/{}", target.repo, target.oid)) {
                            Ok(commit) => {
                                let files = commit.get("files").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
                                results.lock().unwrap().push((target.oid.clone(), summarize(files, max_file_lines)));
                            }
                            Err(GhError::RateLimited) => stop.store(true, Ordering::Relaxed),
                            Err(_) => {
                                failed.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                });
            }
        });
        let rows = results.into_inner().unwrap();
        let encoded: Vec<(String, String)> = rows.iter().map(|(oid, churn)| (oid.clone(), serde_json::to_string(churn).unwrap_or_else(|_| "{}".into()))).collect();
        store.save_churn(&encoded)?;
        known.extend(rows);
        log(&format!("churn: {} of {} commits", requests.load(Ordering::Relaxed).min(queue.len()), queue.len()));
    }

    let done = targets.iter().filter(|target| known.contains_key(&target.oid)).count();
    let result = ChurnResult { done, pending: targets.len() - done, failed: failed.load(Ordering::Relaxed) };
    Ok((result, known))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::classify::DOCS_DATA;
    use serde_json::json;

    #[test]
    fn files_add_up_by_language_and_huge_diffs_count_as_generated() {
        let files = vec![
            json!({ "filename": "src/a.ts", "additions": 10, "deletions": 2 }),
            json!({ "filename": "src/b.ts", "additions": 3, "deletions": 1 }),
            json!({ "filename": "src/huge.ts", "additions": 9000, "deletions": 0 }),
            json!({ "filename": "README.md", "additions": 4, "deletions": 0 }),
        ];
        let summary = summarize(&files, 5000);
        assert_eq!(summary["TypeScript"], (13, 3));
        assert_eq!(summary[SKIPPED], (9000, 0));
        assert_eq!(summary[DOCS_DATA], (4, 0));
    }

    #[test]
    fn churn_round_trips_through_the_store_format() {
        let churn = CommitChurn::from([("Rust".to_string(), (5, 1))]);
        let text = serde_json::to_string(&churn).unwrap();
        assert_eq!(text, r#"{"Rust":[5,1]}"#);
        assert_eq!(serde_json::from_str::<CommitChurn>(&text).unwrap(), churn);
    }

    #[test]
    fn merge_and_empty_commits_cost_no_requests() {
        let gh = Gh::with_base("t".into(), "http://127.0.0.1:1");
        let mut store = crate::store::temp_store();
        let target = |oid: &str, add: i64, merge: bool| ChurnTarget { oid: oid.into(), repo: "o/r".into(), add, del: 0, merge };
        let targets = vec![target("merge", 5, true), target("empty", 0, false)];
        let (result, known) = collect(&gh, &mut store, &targets, 10, 5000, &|_| {}).unwrap();
        assert_eq!((result.done, result.pending, result.failed), (2, 0, 0));
        assert!(known["merge"].is_empty());
    }

    #[test]
    fn a_known_commit_is_never_fetched_again() {
        let gh = Gh::with_base("t".into(), "http://127.0.0.1:1");
        let mut store = crate::store::temp_store();
        store.save_churn(&[("sha".into(), r#"{"Go":[1,2]}"#.into())]).unwrap();
        let targets = vec![ChurnTarget { oid: "sha".into(), repo: "o/r".into(), add: 3, del: 0, merge: false }];
        let (result, known) = collect(&gh, &mut store, &targets, 10, 5000, &|_| {}).unwrap();
        assert_eq!(result.failed, 0);
        assert_eq!(known["sha"]["Go"], (1, 2));
    }

    #[test]
    fn the_budget_stops_fetching_and_leaves_the_rest_pending() {
        let gh = Gh::with_base("t".into(), "http://127.0.0.1:1");
        let mut store = crate::store::temp_store();
        let targets = vec![ChurnTarget { oid: "a".into(), repo: "o/r".into(), add: 3, del: 0, merge: false }];
        let (result, _) = collect(&gh, &mut store, &targets, 0, 5000, &|_| {}).unwrap();
        assert_eq!((result.done, result.pending), (0, 1));
    }
}
