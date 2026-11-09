//! Turns a Snapshot into the aggregated JSON the server stores and draws. Nothing below
//! this point can name a repository, and commit-level rows never leave this machine.
//! The output shape is the `GitHubMetrics` type in `src/shared/metrics.ts`.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde_json::{Value, json};

use super::classify::{DOCS_DATA, SKIPPED};
use super::collect::{Scope, Snapshot};

pub const DEFAULT_MAX_COMMIT_LINES: i64 = 20_000;

const BUCKETS: [(&str, &str, &str, &str, &str); 4] = [
    ("morning", "Morning", "🌅", "06-12", "early bird"),
    ("daytime", "Daytime", "🌞", "12-18", "day shift"),
    ("evening", "Evening", "🌆", "18-24", "evening hacker"),
    ("night", "Night", "🌙", "00-06", "night owl"),
];

fn bucket_index(hour: u32) -> usize {
    match hour {
        0..6 => 3,
        6..12 => 0,
        12..18 => 1,
        _ => 2,
    }
}

struct Zoned {
    date: String,
    month: String,
    year: i32,
    month_index: usize,
    hour: u32,
    /// Monday = 0
    weekday: usize,
}

fn zoned(at: &str, tz: Tz) -> Option<Zoned> {
    let time: DateTime<Utc> = at.parse().ok()?;
    let local = tz.from_utc_datetime(&time.naive_utc());
    Some(Zoned {
        date: local.format("%Y-%m-%d").to_string(),
        month: local.format("%Y-%m").to_string(),
        year: local.year(),
        month_index: local.month0() as usize,
        hour: local.hour(),
        weekday: local.weekday().num_days_from_monday() as usize,
    })
}

fn last_months(year: i32, month0: i32, count: i32) -> Vec<String> {
    (0..count)
        .rev()
        .map(|back| {
            let total = year * 12 + month0 - back;
            format!("{}-{:02}", total.div_euclid(12), total.rem_euclid(12) + 1)
        })
        .collect()
}

fn hours_between(from: &str, to: &str) -> Option<f64> {
    let start: DateTime<Utc> = from.parse().ok()?;
    let end: DateTime<Utc> = to.parse().ok()?;
    Some((end - start).num_seconds() as f64 / 3600.0)
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    Some(if values.len() % 2 == 1 { values[middle] } else { (values[middle - 1] + values[middle]) / 2.0 })
}

/// A streak survives until the end of today, so an empty today doesn't reset it.
pub fn streaks(calendar: &[(String, i64)], today: NaiveDate) -> (i64, i64) {
    let active: HashSet<NaiveDate> = calendar.iter().filter(|(_, count)| *count > 0).filter_map(|(date, _)| date.parse().ok()).collect();
    let mut sorted: Vec<NaiveDate> = active.iter().copied().collect();
    sorted.sort();
    let (mut best, mut run, mut previous) = (0, 0, None::<NaiveDate>);
    for date in sorted {
        run = if previous.is_some_and(|last| date - last == Duration::days(1)) { run + 1 } else { 1 };
        best = i64::max(best, run);
        previous = Some(date);
    }
    let mut cursor = if active.contains(&today) { today } else { today - Duration::days(1) };
    let mut current = 0;
    while active.contains(&cursor) {
        current += 1;
        cursor -= Duration::days(1);
    }
    (current, best)
}

#[derive(Default, Clone, Copy)]
struct Kinds {
    commits: i64,
    pulls: i64,
    issues: i64,
    reviews: i64,
}

impl Kinds {
    fn bump(&mut self, kind: usize) {
        match kind {
            0 => self.commits += 1,
            1 => self.pulls += 1,
            2 => self.issues += 1,
            _ => self.reviews += 1,
        }
    }

    fn sum(self) -> i64 {
        self.commits + self.pulls + self.issues + self.reviews
    }

    fn json(self) -> Value {
        json!({ "commits": self.commits, "pulls": self.pulls, "issues": self.issues, "reviews": self.reviews })
    }
}

fn scope_slot(scope: Scope) -> usize {
    match scope {
        Scope::Personal => 0,
        Scope::Org => 1,
        Scope::External => 2,
    }
}

fn ranked(map: HashMap<String, i64>) -> Vec<Value> {
    let mut rows: Vec<(String, i64)> = map.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    rows.into_iter().map(|(name, count)| json!({ "name": name, "count": count })).collect()
}

pub fn compute(snapshot: &Snapshot, tz: Tz, now: DateTime<Utc>, max_commit_lines: i64, excluded: &[String]) -> Value {
    let excluded: HashSet<String> = excluded.iter().map(|name| name.to_lowercase()).collect();
    let local_now = tz.from_utc_datetime(&now.naive_utc());
    let today = local_now.date_naive();
    let this_year = local_now.year();
    let months = last_months(this_year, local_now.month0() as i32, 12);
    let month_slot: HashMap<&str, usize> = months.iter().enumerate().map(|(index, month)| (month.as_str(), index)).collect();

    let mut monthly = [[0i64; 12]; 4];
    let mut punch = [[0i64; 24]; 7];
    let mut bucket_counts = [0i64; 4];
    let mut scopes = [Kinds::default(); 3];
    let mut yearly: BTreeMap<i32, Kinds> = BTreeMap::new();
    let mut grid: BTreeMap<i32, [i64; 12]> = BTreeMap::new();

    let mut record = |at: &str, kind: usize, scope: Scope| {
        let Some(when) = zoned(at, tz) else { return };
        punch[when.weekday][when.hour as usize] += 1;
        bucket_counts[bucket_index(when.hour)] += 1;
        scopes[scope_slot(scope)].bump(kind);
        yearly.entry(when.year).or_default().bump(kind);
        if let Some(slot) = month_slot.get(when.month.as_str()) {
            monthly[kind][*slot] += 1;
        }
        grid.entry(when.year).or_insert([0; 12])[when.month_index] += 1;
    };
    for commit in &snapshot.commits {
        record(&commit.at, 0, commit.scope);
    }
    for pull in &snapshot.pulls {
        record(&pull.created_at, 1, pull.scope);
    }
    for issue in &snapshot.issues {
        record(&issue.created_at, 2, issue.scope);
    }
    for review in &snapshot.reviews {
        record(&review.at, 3, review.scope);
    }

    let rhythm_total: i64 = bucket_counts.iter().sum();
    let share = |part: i64, whole: i64| if whole > 0 { part as f64 / whole as f64 } else { 0.0 };
    let buckets: Vec<Value> = BUCKETS
        .iter()
        .enumerate()
        .map(|(index, (key, label, emoji, range, _))| json!({ "key": key, "label": label, "emoji": emoji, "range": range, "count": bucket_counts[index], "share": share(bucket_counts[index], rhythm_total) }))
        .collect();
    let mut peak: Option<(usize, usize, i64)> = None;
    for (weekday, hours) in punch.iter().enumerate() {
        for (hour, count) in hours.iter().enumerate() {
            if *count > peak.map_or(0, |best| best.2) {
                peak = Some((weekday, hour, *count));
            }
        }
    }
    let top_bucket = (0..4).rev().max_by_key(|index| bucket_counts[*index]).unwrap_or(0);
    let persona = if rhythm_total > 0 { BUCKETS[top_bucket].4 } else { "just getting started" };

    // Churn, with bulk imports set aside: one commit touching this much is an import.
    let mut churn_rows: HashMap<String, (i64, i64)> = HashMap::new();
    let mut churn_months: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let mut written: HashMap<String, [i64; 3]> = HashMap::new();
    let (mut docs, mut skipped, mut bulk_commits, mut bulk_lines) = ((0, 0), 0, 0, 0);
    for commit in &snapshot.commits {
        let Some(entry) = snapshot.churn.get(&commit.oid) else { continue };
        let Some(when) = zoned(&commit.at, tz) else { continue };
        let (mut code_lines, mut doc_lines) = (0, 0);
        for (language, (add, del)) in entry {
            match language.as_str() {
                SKIPPED => skipped += add + del,
                DOCS_DATA => doc_lines += add + del,
                _ => code_lines += add + del,
            }
        }
        let (bulk_code, bulk_docs) = (code_lines > max_commit_lines, doc_lines > max_commit_lines);
        if bulk_code || bulk_docs {
            bulk_commits += 1;
            bulk_lines += if bulk_code { code_lines } else { 0 } + if bulk_docs { doc_lines } else { 0 };
        }
        for (language, (add, del)) in entry {
            match language.as_str() {
                SKIPPED => {}
                DOCS_DATA => {
                    if !bulk_docs {
                        docs.0 += add;
                        docs.1 += del;
                    }
                }
                _ => {
                    if bulk_code || excluded.contains(&language.to_lowercase()) {
                        continue;
                    }
                    let row = churn_rows.entry(language.clone()).or_default();
                    row.0 += add;
                    row.1 += del;
                    let bucket = churn_months.entry(when.month.clone()).or_default();
                    bucket.0 += add;
                    bucket.1 += del;
                    written.entry(language.clone()).or_default()[scope_slot(commit.scope)] += add;
                }
            }
        }
    }
    let mut churn_list: Vec<(String, (i64, i64))> = churn_rows.into_iter().collect();
    churn_list.sort_by(|a, b| (b.1.0 + b.1.1).cmp(&(a.1.0 + a.1.1)).then_with(|| a.0.cmp(&b.0)));
    let churn_add: i64 = churn_list.iter().map(|(_, row)| row.0).sum();
    let churn_del: i64 = churn_list.iter().map(|(_, row)| row.1).sum();

    // Languages rank by lines added, because bytes can't tell an import from code you wrote.
    let mut names: HashSet<&String> = written.keys().collect();
    names.extend(snapshot.languages.keys());
    let mut language_rows: Vec<(String, i64, f64, [i64; 3], i64)> = names
        .into_iter()
        .map(|name| {
            let lines = written.get(name).copied().unwrap_or_default();
            let raw = snapshot.languages.get(name);
            let gist = raw.map_or(0, |row| row.gist_lines);
            let bytes = raw.map_or(0.0, |row| row.personal + row.org + row.external + row.gist);
            (name.clone(), lines.iter().sum::<i64>() + gist, bytes, lines, gist)
        })
        .collect();
    language_rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.2.total_cmp(&a.2)).then_with(|| a.0.cmp(&b.0)));
    let total_lines: i64 = language_rows.iter().map(|row| row.1).sum();
    let mut language_totals = [0i64; 4];
    for (_, _, _, lines, gist) in &language_rows {
        for index in 0..3 {
            language_totals[index] += lines[index];
        }
        language_totals[3] += gist;
    }

    let merged: Vec<&str> = snapshot.pulls.iter().filter_map(|pull| pull.merged_at.as_deref()).collect();
    let merge_times: Vec<f64> = snapshot.pulls.iter().filter_map(|pull| hours_between(&pull.created_at, pull.merged_at.as_deref()?)).filter(|hours| *hours >= 0.0).collect();
    let review_times: Vec<f64> = snapshot.reviews.iter().filter_map(|review| hours_between(&review.pr_created_at, &review.at)).filter(|hours| *hours >= 0.0).collect();

    let authored: Vec<_> = snapshot.commits.iter().filter(|commit| !commit.merge).collect();
    let mut agents: HashMap<String, i64> = HashMap::new();
    let mut kinds: HashMap<String, i64> = HashMap::new();
    let mut ai_commits = 0;
    for commit in &authored {
        if let Some(agent) = &commit.ai {
            ai_commits += 1;
            *agents.entry(agent.clone()).or_default() += 1;
        }
        if let Some(kind) = &commit.kind {
            *kinds.entry(kind.clone()).or_default() += 1;
        }
    }
    let recent_cutoff = now - Duration::days(90);
    let recent: Vec<_> = authored.iter().filter(|commit| commit.at.parse::<DateTime<Utc>>().is_ok_and(|at| at >= recent_cutoff)).collect();
    let recent_ai = recent.iter().filter(|commit| commit.ai.is_some()).count() as i64;
    let sizes: Vec<f64> = authored.iter().map(|commit| (commit.add + commit.del) as f64).filter(|size| *size > 0.0).collect();

    let (streak, best_streak) = streaks(&snapshot.calendar, today);
    let year_window = today - Duration::days(364);
    let active_days_year = snapshot.calendar.iter().filter(|(date, count)| *count > 0 && date.parse::<NaiveDate>().is_ok_and(|day| day >= year_window && day <= today)).count();
    let busiest = snapshot.calendar.iter().fold(None::<&(String, i64)>, |top, day| if day.1 > top.map_or(0, |best| best.1) { Some(day) } else { top });
    let window30 = today - Duration::days(29);
    let commits_last30 = snapshot.commits.iter().filter(|commit| zoned(&commit.at, tz).and_then(|when| when.date.parse::<NaiveDate>().ok()).is_some_and(|day| day >= window30 && day <= today)).count();

    let official: HashMap<i32, (i64, i64)> = snapshot.years.iter().map(|(year, calendar, hidden)| (*year, (*calendar, *hidden))).collect();
    let mut all_years: Vec<i32> = yearly.keys().chain(official.keys()).copied().collect::<HashSet<_>>().into_iter().collect();
    all_years.sort_by(|a, b| b.cmp(a));
    let years: Vec<Value> = all_years
        .into_iter()
        .filter_map(|year| {
            let row = yearly.get(&year).copied().unwrap_or_default();
            let (calendar, hidden) = official.get(&year).copied().unwrap_or((0, 0));
            (row.sum() + calendar > 0).then(|| json!({ "year": year, "commits": row.commits, "pulls": row.pulls, "issues": row.issues, "reviews": row.reviews, "calendar": calendar, "hidden": hidden }))
        })
        .collect();

    let commits = snapshot.commits.len() as i64;
    let pulls = snapshot.pulls.len() as i64;
    let issues = snapshot.issues.len() as i64;
    let reviews = snapshot.reviews.len() as i64;
    let calendar_total: i64 = snapshot.calendar.iter().map(|(_, count)| count).sum();
    let calendar_year: i64 = snapshot.calendar.iter().filter(|(date, _)| date.starts_with(&format!("{this_year}-"))).map(|(_, count)| count).sum();
    let current = yearly.get(&this_year).copied().unwrap_or_default();

    let coauthors = &snapshot.coauthors;
    let denominator = coauthors.coauthored_commits;
    let mut coauthor_rows: Vec<(String, &str, i64)> = coauthors.named.iter().map(|row| (row.label.clone(), row.kind, row.commits)).collect();
    if coauthors.private_commits > 0 {
        let noun = if coauthors.private_people == 1 { "person" } else { "people" };
        coauthor_rows.push((format!("Private ({} {noun})", coauthors.private_people), "private", coauthors.private_commits));
    }
    coauthor_rows.sort_by(|a, b| b.2.cmp(&a.2));
    let solo_denominator = coauthors.solo_commits + coauthors.coauthored_commits;

    json!({
        "login": snapshot.login,
        "memberSince": snapshot.member_since,
        "counts": {
            "commits": commits, "pulls": pulls, "merged": merged.len(), "issues": issues, "reviews": reviews,
            "comments": snapshot.issue_comments, "calendar": calendar_total, "attributed": commits + pulls + issues + reviews,
        },
        "thisYear": { "year": this_year, "commits": current.commits, "pulls": current.pulls, "issues": current.issues, "reviews": current.reviews, "calendar": calendar_year },
        "commitsLast30": commits_last30,
        "months": months,
        "monthly": { "commits": monthly[0], "pulls": monthly[1], "issues": monthly[2], "reviews": monthly[3] },
        "years": years,
        "yearGrid": grid.iter().rev().map(|(year, values)| json!({ "year": year, "months": values })).collect::<Vec<_>>(),
        "scopes": { "personal": scopes[0].json(), "org": scopes[1].json(), "external": scopes[2].json() },
        "rhythm": {
            "buckets": buckets,
            "punch": punch,
            "weekdays": punch.iter().map(|hours| hours.iter().sum::<i64>()).collect::<Vec<_>>(),
            "peak": peak.map(|(weekday, hour, count)| json!({ "weekday": weekday, "hour": hour, "count": count })),
            "persona": persona,
            "total": rhythm_total,
        },
        "coauthors": {
            "rows": coauthor_rows.iter().map(|(label, kind, count)| json!({ "label": label, "kind": kind, "commits": count, "share": share(*count, denominator) })).collect::<Vec<_>>(),
            "coauthored": coauthors.coauthored_commits,
            "solo": coauthors.solo_commits,
            "soloShare": share(coauthors.solo_commits, solo_denominator),
            "privatePeople": coauthors.private_people,
            "byKind": { "ai": coauthors.by_ai, "bot": coauthors.by_bot, "person": coauthors.by_person },
        },
        "languages": language_rows.iter().map(|(name, lines, bytes, written, gist)| json!({
            "name": name, "lines": lines, "bytes": bytes.round(), "share": share(*lines, total_lines),
            "personal": written[0], "org": written[1], "external": written[2], "gist": gist,
        })).collect::<Vec<_>>(),
        "languageTotals": { "personal": language_totals[0], "org": language_totals[1], "external": language_totals[2], "gist": language_totals[3] },
        "churn": {
            "rows": churn_list.iter().map(|(name, (add, del))| json!({ "name": name, "add": add, "del": del, "net": add - del })).collect::<Vec<_>>(),
            "add": churn_add,
            "del": churn_del,
            "docs": { "add": docs.0, "del": docs.1 },
            "skipped": skipped,
            "bulk": { "commits": bulk_commits, "lines": bulk_lines },
            "monthly": churn_months.iter().map(|(month, (add, del))| json!({ "month": month, "add": add, "del": del })).collect::<Vec<_>>(),
        },
        "pulse": {
            "streak": streak,
            "bestStreak": best_streak,
            "activeDaysYear": active_days_year,
            "busiest": busiest.map(|(date, count)| json!({ "date": date, "count": count })),
            "aiCommits": ai_commits,
            "aiShare": share(ai_commits, authored.len() as i64),
            "aiAgents": ranked(agents),
            "aiShareRecent": share(recent_ai, recent.len() as i64),
            "mergeRate": share(merged.len() as i64, pulls),
            "mergeHours": median(merge_times),
            "reviewHours": median(review_times),
            "kinds": ranked(kinds),
            "avgCommitSize": median(sizes),
            "stars": snapshot.stars,
            "followers": snapshot.followers,
            "organizations": snapshot.organizations,
        },
        "coverage": {
            "reposListed": snapshot.coverage.repos_listed,
            "reposWalked": snapshot.coverage.repos_walked,
            "reposFailed": snapshot.coverage.repos_failed,
            "reposWithCommits": snapshot.coverage.repos_with_commits,
            "churnDone": snapshot.coverage.churn.done,
            "churnPending": snapshot.coverage.churn.pending,
            "churnFailed": snapshot.coverage.churn.failed,
            "gists": snapshot.coverage.gists,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::churn::CommitChurn;
    use crate::github::coauthors::CoauthorSummary;
    use crate::github::collect::{CommitRow, Coverage, IssueRow, LanguageBytes, PullRow, ReviewRow};

    fn empty() -> Snapshot {
        Snapshot {
            login: "octo".into(),
            member_since: "2020-01-01T00:00:00Z".into(),
            calendar: vec![],
            years: vec![],
            commits: vec![],
            pulls: vec![],
            issues: vec![],
            reviews: vec![],
            coauthors: CoauthorSummary::default(),
            languages: BTreeMap::new(),
            churn: HashMap::new(),
            issue_comments: 0,
            organizations: 0,
            stars: 0,
            followers: 0,
            coverage: Coverage::default(),
        }
    }

    fn commit(oid: &str, at: &str, scope: Scope) -> CommitRow {
        CommitRow { oid: oid.into(), at: at.into(), scope, add: 0, del: 0, merge: false, ai: None, kind: None }
    }

    fn now() -> DateTime<Utc> {
        "2026-11-09T05:00:00Z".parse().unwrap()
    }

    const SEOUL: Tz = chrono_tz::Asia::Seoul;

    fn date(text: &str) -> NaiveDate {
        text.parse().unwrap()
    }

    fn days(items: &[&str]) -> Vec<(String, i64)> {
        items.iter().map(|day| ((*day).to_string(), 1)).collect()
    }

    #[test]
    fn streaks_tolerate_an_empty_today_but_not_an_empty_yesterday() {
        let today = date("2026-11-09");
        assert_eq!(streaks(&days(&["2026-11-07", "2026-11-08"]), today).0, 2);
        assert_eq!(streaks(&days(&["2026-11-08", "2026-11-09"]), today).0, 2);
        assert_eq!(streaks(&days(&["2026-11-06", "2026-11-07"]), today).0, 0);
        assert_eq!(streaks(&days(&["2026-01-01", "2026-01-02", "2026-01-03", "2026-11-09"]), today).1, 3);
        assert_eq!(streaks(&[], today), (0, 0));
    }

    #[test]
    fn zero_count_days_do_not_extend_a_streak() {
        let calendar = vec![("2026-11-07".to_string(), 1), ("2026-11-08".to_string(), 0), ("2026-11-09".to_string(), 1)];
        assert_eq!(streaks(&calendar, date("2026-11-09")).0, 1);
    }

    #[test]
    fn rhythm_uses_local_time_and_adds_up() {
        let mut snapshot = empty();
        snapshot.commits = vec![commit("a", "2026-05-05T15:00:00Z", Scope::Personal), commit("b", "2026-05-05T00:00:00Z", Scope::Org)];
        snapshot.pulls = vec![PullRow { created_at: "2026-05-05T05:00:00Z".into(), merged_at: None, scope: Scope::Org }];
        snapshot.reviews = vec![ReviewRow { at: "2026-05-05T11:00:00Z".into(), pr_created_at: "2026-05-05T10:00:00Z".into(), scope: Scope::Org }];
        let metrics = compute(&snapshot, SEOUL, now(), DEFAULT_MAX_COMMIT_LINES, &[]);
        let counts: Vec<i64> = metrics["rhythm"]["buckets"].as_array().unwrap().iter().map(|bucket| bucket["count"].as_i64().unwrap()).collect();
        assert_eq!(counts, vec![1, 1, 1, 1], "15:00 UTC is midnight in Seoul, so night rather than daytime");
        assert_eq!(metrics["rhythm"]["total"], 4);
        assert_eq!(metrics["scopes"]["org"]["commits"], 1);
        assert_eq!(metrics["counts"]["attributed"], 4);
    }

    #[test]
    fn this_year_and_lifetime_are_kept_apart() {
        let mut snapshot = empty();
        snapshot.calendar = vec![("2025-12-31".to_string(), 361), ("2026-09-01".to_string(), 1933), ("2026-10-01".to_string(), 1202)];
        snapshot.commits = vec![commit("old", "2025-06-01T00:00:00Z", Scope::Org), commit("a", "2026-09-01T00:00:00Z", Scope::Org)];
        snapshot.issues = vec![IssueRow { created_at: "2024-01-01T00:00:00Z".into(), scope: Scope::External }];
        let metrics = compute(&snapshot, SEOUL, now(), DEFAULT_MAX_COMMIT_LINES, &[]);
        assert_eq!(metrics["thisYear"]["calendar"], 3135);
        assert_eq!(metrics["counts"]["calendar"], 3496);
        assert_eq!(metrics["thisYear"]["commits"], 1);
        assert_eq!(metrics["counts"]["commits"], 2);
        assert_eq!(metrics["counts"]["issues"], 1);
    }

    fn churn_of(rows: &[(&str, i64, i64)]) -> CommitChurn {
        rows.iter().map(|(name, add, del)| ((*name).to_string(), (*add, *del))).collect()
    }

    #[test]
    fn docs_and_skipped_stay_out_of_language_rows() {
        let mut snapshot = empty();
        snapshot.commits = vec![commit("a", "2026-05-05T00:00:00Z", Scope::Personal)];
        snapshot.churn.insert("a".into(), churn_of(&[("TypeScript", 10, 2), (DOCS_DATA, 5, 1), (SKIPPED, 100, 50)]));
        let metrics = compute(&snapshot, SEOUL, now(), DEFAULT_MAX_COMMIT_LINES, &[]);
        assert_eq!(metrics["churn"]["rows"], json!([{ "name": "TypeScript", "add": 10, "del": 2, "net": 8 }]));
        assert_eq!(metrics["churn"]["docs"], json!({ "add": 5, "del": 1 }));
        assert_eq!(metrics["churn"]["skipped"], 150);
    }

    #[test]
    fn a_bulk_import_is_set_aside_and_reported() {
        let mut snapshot = empty();
        snapshot.commits = vec![commit("sdk", "2026-05-05T00:00:00Z", Scope::Org), commit("real", "2026-05-05T00:00:00Z", Scope::Org)];
        snapshot.churn.insert("sdk".into(), churn_of(&[("C", 250_000, 10)]));
        snapshot.churn.insert("real".into(), churn_of(&[("TypeScript", 900, 100), ("C", 50, 5)]));
        snapshot.languages.insert("C".into(), LanguageBytes { org: 99_000_000.0, ..Default::default() });
        let metrics = compute(&snapshot, SEOUL, now(), DEFAULT_MAX_COMMIT_LINES, &[]);
        assert_eq!(metrics["churn"]["bulk"], json!({ "commits": 1, "lines": 250_010 }));
        let languages = metrics["languages"].as_array().unwrap();
        assert_eq!(languages[0]["name"], "TypeScript", "huge in bytes, tiny in authored lines");
        assert_eq!(languages[0]["org"], 900);
        assert_eq!(languages[1]["bytes"], 99_000_000.0);
    }

    #[test]
    fn languages_combine_commit_and_gist_lines_and_honor_exclusions() {
        let mut snapshot = empty();
        snapshot.commits = vec![commit("a", "2026-05-05T00:00:00Z", Scope::Personal)];
        snapshot.churn.insert("a".into(), churn_of(&[("Python", 10, 0), ("Ruby", 999, 0)]));
        snapshot.languages.insert("Python".into(), LanguageBytes { personal: 1.0, gist: 40.0, gist_lines: 5, ..Default::default() });
        snapshot.languages.insert("Lua".into(), LanguageBytes { gist: 20.0, gist_lines: 2, ..Default::default() });
        let metrics = compute(&snapshot, SEOUL, now(), DEFAULT_MAX_COMMIT_LINES, &["ruby".to_string()]);
        let rows: Vec<(&str, i64)> = metrics["languages"].as_array().unwrap().iter().map(|row| (row["name"].as_str().unwrap(), row["lines"].as_i64().unwrap())).collect();
        assert_eq!(rows, vec![("Python", 15), ("Lua", 2)]);
        assert_eq!(metrics["languageTotals"], json!({ "personal": 10, "org": 0, "external": 0, "gist": 7 }));
    }

    #[test]
    fn the_output_has_every_field_the_server_needs_even_when_empty() {
        let metrics = compute(&empty(), SEOUL, now(), DEFAULT_MAX_COMMIT_LINES, &[]);
        for key in ["counts", "thisYear", "monthly", "scopes", "rhythm", "coauthors", "languageTotals", "churn", "pulse", "coverage", "months", "years", "yearGrid", "languages"] {
            assert!(!metrics[key].is_null(), "{key}");
        }
        assert_eq!(metrics["rhythm"]["punch"].as_array().unwrap().len(), 7);
        assert_eq!(metrics["rhythm"]["buckets"].as_array().unwrap().len(), 4);
        assert_eq!(metrics["months"].as_array().unwrap().len(), 12);
    }

    #[test]
    fn nothing_commit_level_is_uploaded() {
        let mut snapshot = empty();
        snapshot.commits = vec![commit("deadbeefcafe", "2026-05-05T00:00:00Z", Scope::Org)];
        let text = compute(&snapshot, SEOUL, now(), DEFAULT_MAX_COMMIT_LINES, &[]).to_string();
        assert!(!text.contains("deadbeefcafe"));
    }
}
