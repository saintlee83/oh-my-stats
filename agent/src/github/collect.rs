//! Gathers activity by walking every repository. GitHub's contribution API hides the
//! breakdown of private work even from your own token, so it can't be used for counts.
//!
//! Repository, organization and person names exist only inside this module, to make API
//! calls. `Snapshot` has none of them, so nothing downstream can leak one.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use anyhow::{Result, anyhow, bail};
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{Value, json};

use super::Log;
use super::churn::{self, ChurnResult, ChurnTarget, CommitChurn};
use super::classify::{ai_agent, commit_kind, is_code_language};
use super::client::{Gh, GhError};
use super::coauthors::{Actor, CoauthorEvent, CoauthorSummary, tally};
use crate::store::Store;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Personal,
    Org,
    External,
}

#[derive(Debug, Clone)]
pub struct CommitRow {
    pub oid: String,
    pub at: String,
    pub scope: Scope,
    pub add: i64,
    pub del: i64,
    pub merge: bool,
    pub ai: Option<String>,
    pub kind: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PullRow {
    pub created_at: String,
    pub merged_at: Option<String>,
    pub scope: Scope,
}

#[derive(Debug, Clone)]
pub struct IssueRow {
    pub created_at: String,
    pub scope: Scope,
}

#[derive(Debug, Clone)]
pub struct ReviewRow {
    /// Submission time of the viewer's first review on the PR.
    pub at: String,
    pub pr_created_at: String,
    pub scope: Scope,
}

#[derive(Debug, Clone, Default)]
pub struct LanguageBytes {
    pub personal: f64,
    pub org: f64,
    pub external: f64,
    pub gist: f64,
    pub gist_lines: i64,
}

#[derive(Debug, Clone, Default)]
pub struct Coverage {
    pub repos_listed: usize,
    pub repos_walked: usize,
    pub repos_failed: usize,
    pub repos_with_commits: usize,
    pub churn: ChurnResult,
    pub gists: usize,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub login: String,
    pub member_since: String,
    pub calendar: Vec<(String, i64)>,
    /// (year, calendar total, hidden from the API breakdown)
    pub years: Vec<(i32, i64, i64)>,
    pub commits: Vec<CommitRow>,
    pub pulls: Vec<PullRow>,
    pub issues: Vec<IssueRow>,
    pub reviews: Vec<ReviewRow>,
    pub coauthors: CoauthorSummary,
    pub languages: BTreeMap<String, LanguageBytes>,
    pub churn: HashMap<String, CommitChurn>,
    pub issue_comments: i64,
    pub organizations: i64,
    pub stars: i64,
    pub followers: i64,
    pub coverage: Coverage,
}

pub struct Settings {
    pub expected_login: Option<String>,
    pub named_coauthors: Vec<String>,
    pub agent_coauthors: Vec<String>,
    pub exclude_languages: Vec<String>,
    pub max_requests: usize,
    pub max_file_lines: i64,
}

const REPO_FIELDS: &str = "id nameWithOwner isFork isPrivate owner { login __typename } languages(first: 100, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } }";
const AFFILIATIONS: &str = "[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]";

#[derive(Debug, Clone)]
struct Repo {
    id: String,
    name_with_owner: String,
    is_fork: bool,
    is_private: bool,
    owner: String,
    owner_type: String,
    languages: Vec<(String, f64)>,
}

fn text(value: &Value, path: &str) -> String {
    value.pointer(path).and_then(Value::as_str).unwrap_or("").to_string()
}

fn int(value: &Value, path: &str) -> i64 {
    value.pointer(path).and_then(Value::as_i64).unwrap_or(0)
}

fn parse_repo(value: &Value) -> Option<Repo> {
    let id = value.get("id")?.as_str()?.to_string();
    let languages = value
        .pointer("/languages/edges")
        .and_then(Value::as_array)
        .map(|edges| edges.iter().map(|edge| (text(edge, "/node/name"), edge.get("size").and_then(Value::as_f64).unwrap_or(0.0))).collect())
        .unwrap_or_default();
    Some(Repo {
        id,
        name_with_owner: text(value, "/nameWithOwner"),
        is_fork: value.get("isFork").and_then(Value::as_bool).unwrap_or(false),
        is_private: value.get("isPrivate").and_then(Value::as_bool).unwrap_or(false),
        owner: text(value, "/owner/login"),
        owner_type: text(value, "/owner/__typename"),
        languages,
    })
}

struct Scoper {
    login: String,
    orgs: HashSet<String>,
}

impl Scoper {
    fn of(&self, owner: &str, owner_type: &str) -> Scope {
        if owner.eq_ignore_ascii_case(&self.login) {
            Scope::Personal
        } else if owner_type == "Organization" && self.orgs.contains(&owner.to_lowercase()) {
            Scope::Org
        } else {
            Scope::External
        }
    }

    fn of_value(&self, owner: &Value) -> Scope {
        self.of(&text(owner, "/login"), &text(owner, "/__typename"))
    }
}

/// Runs `work` over items on a few threads. A rate limit stops everything and is returned.
fn pool<T: Sync>(items: &[T], workers: usize, work: impl Fn(&T) -> Result<(), GhError> + Sync) -> Result<(), GhError> {
    let next = AtomicUsize::new(0);
    let stopped = AtomicBool::new(false);
    let failure: Mutex<Option<GhError>> = Mutex::new(None);
    std::thread::scope(|scope| {
        for _ in 0..workers.max(1) {
            scope.spawn(|| {
                while !stopped.load(Ordering::Relaxed) {
                    let Some(item) = items.get(next.fetch_add(1, Ordering::Relaxed)) else { return };
                    if let Err(error) = work(item) {
                        stopped.store(true, Ordering::Relaxed);
                        failure.lock().unwrap().get_or_insert(error);
                    }
                }
            });
        }
    });
    match failure.into_inner().unwrap() {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Follows a connection to its end. `fetch` returns the connection for a cursor.
fn paginate(mut fetch: impl FnMut(Option<&str>) -> Result<Value, GhError>) -> Result<Vec<Value>, GhError> {
    let mut out = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let page = fetch(after.as_deref())?;
        out.extend(page.get("nodes").and_then(Value::as_array).into_iter().flatten().filter(|node| !node.is_null()).cloned());
        if page.pointer("/pageInfo/hasNextPage").and_then(Value::as_bool) != Some(true) {
            return Ok(out);
        }
        after = page.pointer("/pageInfo/endCursor").and_then(Value::as_str).map(str::to_string);
    }
}

struct Calendar {
    days: Vec<(String, i64)>,
    years: Vec<(i32, i64, i64)>,
    repos: Vec<Repo>,
}

/// The calendar is the only source that includes everything GitHub counts, so it drives
/// totals and streaks. Its per-type breakdown isn't usable for private work.
fn collect_years(gh: &Gh, years: &[i32], today: &str) -> Result<Calendar, GhError> {
    let query = format!(
        "query($from: DateTime!, $to: DateTime!) {{ viewer {{ contributionsCollection(from: $from, to: $to) {{
           restrictedContributionsCount
           contributionCalendar {{ totalContributions weeks {{ contributionDays {{ date contributionCount }} }} }}
           commitContributionsByRepository(maxRepositories: 100) {{ repository {{ {REPO_FIELDS} }} }}
         }} }} }}"
    );
    let out = Mutex::new(Calendar { days: Vec::new(), years: Vec::new(), repos: Vec::new() });
    pool(years, 4, |year| {
        let data = gh.graphql(&query, json!({ "from": format!("{year}-01-01T00:00:00Z"), "to": format!("{year}-12-31T23:59:59Z") }))?;
        let collection = data.pointer("/viewer/contributionsCollection").cloned().unwrap_or(Value::Null);
        let mut out = out.lock().unwrap();
        out.years.push((*year, int(&collection, "/contributionCalendar/totalContributions"), int(&collection, "/restrictedContributionsCount")));
        for week in collection.pointer("/contributionCalendar/weeks").and_then(Value::as_array).into_iter().flatten() {
            for day in week.get("contributionDays").and_then(Value::as_array).into_iter().flatten() {
                let date = text(day, "/date");
                if date.as_str() <= today {
                    out.days.push((date, int(day, "/contributionCount")));
                }
            }
        }
        for entry in collection.get("commitContributionsByRepository").and_then(Value::as_array).into_iter().flatten() {
            out.repos.extend(entry.get("repository").and_then(parse_repo));
        }
        Ok(())
    })?;
    let mut calendar = out.into_inner().unwrap();
    calendar.days.sort();
    calendar.years.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(calendar)
}

fn collect_repos(gh: &Gh, orgs: &[String], known: Vec<Repo>) -> Result<Vec<Repo>, GhError> {
    let found: Mutex<HashMap<String, Repo>> = Mutex::new(known.into_iter().map(|repo| (repo.id.clone(), repo)).collect());
    let add = |nodes: Vec<Value>| {
        let mut found = found.lock().unwrap();
        for repo in nodes.iter().filter_map(parse_repo) {
            found.insert(repo.id.clone(), repo);
        }
    };
    let mine = format!(
        "query($after: String) {{ viewer {{ repositories(first: 100, after: $after, affiliations: {AFFILIATIONS}, ownerAffiliations: {AFFILIATIONS}) {{
           pageInfo {{ hasNextPage endCursor }} nodes {{ {REPO_FIELDS} }} }} }} }}"
    );
    add(paginate(|after| Ok(gh.graphql(&mine, json!({ "after": after }))?.pointer("/viewer/repositories").cloned().unwrap_or(Value::Null)))?);

    // Repos reachable only through an org's base permission aren't "affiliated".
    let org_query = format!(
        "query($login: String!, $after: String) {{ organization(login: $login) {{ repositories(first: 100, after: $after) {{
           pageInfo {{ hasNextPage endCursor }} nodes {{ {REPO_FIELDS} }} }} }} }}"
    );
    pool(orgs, 4, |login| {
        let nodes = paginate(|after| Ok(gh.graphql(&org_query, json!({ "login": login, "after": after }))?.pointer("/organization/repositories").cloned().unwrap_or(Value::Null)))?;
        add(nodes);
        Ok(())
    })?;
    Ok(found.into_inner().unwrap().into_values().collect())
}

const WALK_QUERY: &str = "query($id: ID!, $author: ID!, $after: String, $first: Int!) { node(id: $id) { ... on Repository { defaultBranchRef { target { ... on Commit {
  all: history { totalCount }
  history(first: $first, after: $after, author: { id: $author }) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes { oid authoredDate additions deletions parents { totalCount } messageHeadline messageBody authors(first: 10) { nodes { name email user { login } } } }
  } } } } } } }";

/// Commit diffs are computed on demand, so large pages can time out. Retry smaller.
fn walk_page(gh: &Gh, repo_id: &str, author: &str, after: Option<&str>) -> Result<Option<Value>, GhError> {
    let mut last = GhError::Failed("no attempt".into());
    for first in [100, 25, 10] {
        match gh.graphql(WALK_QUERY, json!({ "id": repo_id, "author": author, "after": after, "first": first })) {
            Ok(data) => return Ok(data.pointer("/node/defaultBranchRef/target").filter(|target| !target.is_null()).cloned()),
            Err(GhError::RateLimited) => return Err(GhError::RateLimited),
            Err(error) => last = error,
        }
    }
    Err(last)
}

#[derive(Default)]
struct Walk {
    commits: Vec<CommitRow>,
    targets: Vec<ChurnTarget>,
    events: Vec<CoauthorEvent>,
    shares: HashMap<String, (i64, i64)>,
    failed: usize,
}

fn walk_commits(gh: &Gh, repos: &[Repo], author: &str, scoper: &Scoper, agents: &HashSet<String>, log: Log<'_>) -> Result<Walk, GhError> {
    let out = Mutex::new(Walk::default());
    let finished = AtomicUsize::new(0);
    pool(repos, 6, |repo| {
        let scope = scoper.of(&repo.owner, &repo.owner_type);
        let mut after: Option<String> = None;
        let mut rows = Walk::default();
        let walked = loop {
            match walk_page(gh, &repo.id, author, after.as_deref()) {
                Err(GhError::RateLimited) => return Err(GhError::RateLimited),
                Err(_) => break false,
                Ok(None) => break true,
                Ok(Some(target)) => {
                    rows.shares.insert(repo.id.clone(), (int(&target, "/history/totalCount"), int(&target, "/all/totalCount")));
                    for node in target.pointer("/history/nodes").and_then(Value::as_array).into_iter().flatten() {
                        let oid = text(node, "/oid");
                        let merge = int(node, "/parents/totalCount") > 1;
                        let (add, del) = (int(node, "/additions"), int(node, "/deletions"));
                        let actors: Vec<Actor> = node
                            .pointer("/authors/nodes")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .map(|actor| Actor {
                                name: text(actor, "/name"),
                                email: text(actor, "/email"),
                                login: actor.pointer("/user/login").and_then(Value::as_str).map(str::to_string),
                            })
                            .collect();
                        let agent = actors.iter().skip(1).find_map(|actor| actor.login.as_ref().filter(|login| agents.contains(&login.to_lowercase())).cloned());
                        let headline = text(node, "/messageHeadline");
                        // Commit messages are reduced to these two labels and then dropped.
                        let ai = ai_agent(&format!("{headline}\n{}", text(node, "/messageBody"))).or(agent);
                        rows.commits.push(CommitRow { oid: oid.clone(), at: text(node, "/authoredDate"), scope, add, del, merge, ai, kind: commit_kind(&headline) });
                        rows.targets.push(ChurnTarget { oid: oid.clone(), repo: repo.name_with_owner.clone(), add, del, merge });
                        rows.events.push(CoauthorEvent { oid, is_private: repo.is_private, actors });
                    }
                    if target.pointer("/history/pageInfo/hasNextPage").and_then(Value::as_bool) != Some(true) {
                        break true;
                    }
                    after = target.pointer("/history/pageInfo/endCursor").and_then(Value::as_str).map(str::to_string);
                }
            }
        };
        let mut out = out.lock().unwrap();
        out.commits.append(&mut rows.commits);
        out.targets.append(&mut rows.targets);
        out.events.append(&mut rows.events);
        out.shares.extend(rows.shares);
        out.failed += usize::from(!walked);
        let count = finished.fetch_add(1, Ordering::Relaxed) + 1;
        if count % 50 == 0 {
            log(&format!("commits: {count} of {} repos, {} commits", repos.len(), out.commits.len()));
        }
        Ok(())
    })?;
    Ok(out.into_inner().unwrap())
}

const SEARCH_CAP: i64 = 1000;

/// GitHub search stops at 1,000 results, so busy windows are split in half until they fit.
fn search_reviews(gh: &Gh, login: &str, from: NaiveDate, to: NaiveDate) -> Result<Vec<Value>, GhError> {
    let search = format!("is:pr reviewed-by:{login} -author:{login} created:{from}..{to}");
    let graphql = "query($query: String!, $after: String, $login: String!) { search(query: $query, type: ISSUE, first: 50, after: $after) {
        issueCount pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest { createdAt repository { owner { login __typename } } reviews(first: 10, author: $login) { nodes { submittedAt } } } } } }";
    let mut out = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let data = gh.graphql(graphql, json!({ "query": search, "after": after, "login": login }))?;
        let result = data.get("search").cloned().unwrap_or(Value::Null);
        if int(&result, "/issueCount") > SEARCH_CAP && from < to {
            let middle = from + (to - from) / 2;
            let mut older = search_reviews(gh, login, from, middle)?;
            older.extend(search_reviews(gh, login, middle.succ_opt().unwrap_or(to), to)?);
            return Ok(older);
        }
        out.extend(result.get("nodes").and_then(Value::as_array).into_iter().flatten().cloned());
        if result.pointer("/pageInfo/hasNextPage").and_then(Value::as_bool) != Some(true) {
            return Ok(out);
        }
        after = result.pointer("/pageInfo/endCursor").and_then(Value::as_str).map(str::to_string);
    }
}

fn count_lines(text: &str) -> i64 {
    if text.is_empty() {
        return 0;
    }
    let breaks = text.matches('\n').count() as i64;
    if text.ends_with('\n') { breaks } else { breaks + 1 }
}

/// Bytes per language, credited by your share of each repo's commits. Your own non-fork
/// repos count fully when no commit matched your account, which usually means they were
/// committed under an unlinked email. Gist text is only measured here, never kept.
fn aggregate_languages(repos: &[Repo], shares: &HashMap<String, (i64, i64)>, gists: &[Value], scoper: &Scoper, excluded: &[String]) -> BTreeMap<String, LanguageBytes> {
    let skip: HashSet<String> = excluded.iter().map(|name| name.to_lowercase()).collect();
    let mut totals: BTreeMap<String, LanguageBytes> = BTreeMap::new();
    for repo in repos {
        let scope = scoper.of(&repo.owner, &repo.owner_type);
        let fraction = shares.get(&repo.id).filter(|(_, total)| *total > 0).map_or(0.0, |(mine, total)| *mine as f64 / *total as f64);
        let weight = if fraction > 0.0 {
            fraction
        } else if scope == Scope::Personal && !repo.is_fork {
            1.0
        } else {
            0.0
        };
        if weight == 0.0 {
            continue;
        }
        for (name, size) in &repo.languages {
            if skip.contains(&name.to_lowercase()) {
                continue;
            }
            let row = totals.entry(name.clone()).or_default();
            let bytes = size * weight;
            match scope {
                Scope::Personal => row.personal += bytes,
                Scope::Org => row.org += bytes,
                Scope::External => row.external += bytes,
            }
        }
    }
    for gist in gists {
        for file in gist.get("files").and_then(Value::as_array).into_iter().flatten() {
            let name = text(file, "/language/name");
            if name.is_empty() || !is_code_language(&name) || skip.contains(&name.to_lowercase()) {
                continue;
            }
            let row = totals.entry(name).or_default();
            row.gist += file.get("size").and_then(Value::as_f64).unwrap_or(0.0);
            row.gist_lines += count_lines(file.get("text").and_then(Value::as_str).unwrap_or(""));
        }
    }
    totals
}

fn to_anyhow(error: GhError) -> anyhow::Error {
    anyhow!(error.to_string())
}

pub fn collect(gh: &Gh, store: &mut Store, settings: &Settings, log: Log<'_>, now: DateTime<Utc>) -> Result<Snapshot> {
    let viewer = gh
        .graphql(
            "query { viewer { id login createdAt followers { totalCount } issueComments { totalCount }
               organizations(first: 100) { totalCount nodes { login } } contributionsCollection { contributionYears } } }",
            json!({}),
        )
        .map_err(to_anyhow)?;
    let viewer = viewer.get("viewer").cloned().unwrap_or(Value::Null);
    let login = text(&viewer, "/login");

    // A token without these sees only public work and raises no error at all.
    let missing = gh.missing_scopes(&["repo", "read:org"]);
    if !missing.is_empty() {
        bail!(
            "This GitHub token is missing {}. Without it, private work would silently drop out of your stats, so nothing was uploaded. Run `gh auth refresh -s repo,read:org`, or use a token with those scopes.",
            missing.join(", ")
        );
    }
    if let Some(expected) = settings.expected_login.as_deref().filter(|expected| !expected.eq_ignore_ascii_case(&login)) {
        bail!("GitHub stats would come from @{login}, but this machine is signed in as @{expected}. Switch with `gh auth switch`.");
    }

    let org_logins: Vec<String> = viewer.pointer("/organizations/nodes").and_then(Value::as_array).into_iter().flatten().map(|org| text(org, "/login")).collect();
    let scoper = Scoper { login: login.clone(), orgs: org_logins.iter().map(|org| org.to_lowercase()).collect() };
    let years: Vec<i32> = viewer.pointer("/contributionsCollection/contributionYears").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_i64).map(|year| year as i32).collect();
    let today = now.format("%Y-%m-%d").to_string();

    log("profile and contribution calendar");
    let calendar = collect_years(gh, &years, &today).map_err(to_anyhow)?;
    log(&format!("repositories across {} organizations", org_logins.len()));
    let repos = collect_repos(gh, &org_logins, calendar.repos).map_err(to_anyhow)?;
    log(&format!("walking commits in {} repositories", repos.len()));
    let agents: HashSet<String> = settings.agent_coauthors.iter().map(|name| name.to_lowercase()).collect();
    let mut walk = walk_commits(gh, &repos, &text(&viewer, "/id"), &scoper, &agents, log).map_err(to_anyhow)?;

    // Forks share history with their parent, so one commit can be reached twice.
    let mut seen = HashSet::new();
    walk.commits.retain(|commit| seen.insert(commit.oid.clone()));
    let mut seen = HashSet::new();
    walk.targets.retain(|target| seen.insert(target.oid.clone()));

    log("pull requests, issues and reviews");
    let pull_nodes = paginate(|after| {
        Ok(gh
            .graphql(
                "query($after: String) { viewer { pullRequests(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
                   pageInfo { hasNextPage endCursor } nodes { createdAt mergedAt repository { owner { login __typename } } } } } }",
                json!({ "after": after }),
            )?
            .pointer("/viewer/pullRequests")
            .cloned()
            .unwrap_or(Value::Null))
    })
    .map_err(to_anyhow)?;
    let pulls = pull_nodes
        .iter()
        .map(|pull| PullRow {
            created_at: text(pull, "/createdAt"),
            merged_at: pull.get("mergedAt").and_then(Value::as_str).map(str::to_string),
            scope: scoper.of_value(pull.pointer("/repository/owner").unwrap_or(&Value::Null)),
        })
        .collect();
    let issue_nodes = paginate(|after| {
        Ok(gh
            .graphql(
                "query($after: String) { viewer { issues(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
                   pageInfo { hasNextPage endCursor } nodes { createdAt repository { owner { login __typename } } } } } }",
                json!({ "after": after }),
            )?
            .pointer("/viewer/issues")
            .cloned()
            .unwrap_or(Value::Null))
    })
    .map_err(to_anyhow)?;
    let issues = issue_nodes
        .iter()
        .map(|issue| IssueRow { created_at: text(issue, "/createdAt"), scope: scoper.of_value(issue.pointer("/repository/owner").unwrap_or(&Value::Null)) })
        .collect();

    let member_since = text(&viewer, "/createdAt");
    let from = member_since.get(..10).and_then(|date| date.parse().ok()).unwrap_or_else(|| now.date_naive());
    let review_nodes = search_reviews(gh, &login, from, now.date_naive()).map_err(to_anyhow)?;
    let mut reviews = Vec::new();
    for pull in &review_nodes {
        let mut times: Vec<String> = pull.pointer("/reviews/nodes").and_then(Value::as_array).into_iter().flatten().filter_map(|review| review.get("submittedAt").and_then(Value::as_str).map(str::to_string)).collect();
        times.sort();
        let created = text(pull, "/createdAt");
        if let (Some(first), false, Some(owner)) = (times.first(), created.is_empty(), pull.pointer("/repository/owner")) {
            reviews.push(ReviewRow { at: first.clone(), pr_created_at: created, scope: scoper.of_value(owner) });
        }
    }

    log("gist languages");
    let gist_nodes = paginate(|after| {
        Ok(gh
            .graphql(
                "query($after: String) { viewer { gists(first: 30, after: $after, privacy: ALL) {
                   pageInfo { hasNextPage endCursor } nodes { isFork files(limit: 300) { name size text language { name } } } } } }",
                json!({ "after": after }),
            )?
            .pointer("/viewer/gists")
            .cloned()
            .unwrap_or(Value::Null))
    })
    .map_err(to_anyhow)?;
    // Skip cards published by this tool or its predecessor, so a profile doesn't count itself.
    let gists: Vec<Value> = gist_nodes
        .into_iter()
        .filter(|gist| {
            let own = gist.get("files").and_then(Value::as_array).into_iter().flatten().any(|file| {
                let name = text(file, "/name");
                name.starts_with("oh-my-gist") || name.starts_with("00-oh-my-gist") || name.starts_with("oms-")
            });
            !own && gist.get("isFork").and_then(Value::as_bool) != Some(true)
        })
        .collect();
    let languages = aggregate_languages(&repos, &walk.shares, &gists, &scoper, &settings.exclude_languages);

    let (churn_result, churn_map) = churn::collect(gh, store, &walk.targets, settings.max_requests, settings.max_file_lines, log)?;
    if churn_result.pending > 0 {
        log(&format!("churn: {} commits still pending; the next run continues", churn_result.pending));
    }

    let stars = gh
        .graphql(
            "query { viewer { repositories(first: 100, ownerAffiliations: [OWNER], isFork: false, privacy: PUBLIC, orderBy: { field: STARGAZERS, direction: DESC }) { nodes { stargazerCount } } } }",
            json!({}),
        )
        .map(|data| data.pointer("/viewer/repositories/nodes").and_then(Value::as_array).into_iter().flatten().map(|repo| int(repo, "/stargazerCount")).sum())
        .unwrap_or(0);

    let authored = walk.commits.iter().filter(|commit| !commit.merge).count() as i64;
    let coauthors = tally(&walk.events, &login, authored, &settings.named_coauthors, &settings.agent_coauthors);
    let coverage = Coverage {
        repos_listed: repos.len(),
        repos_walked: repos.len() - walk.failed,
        repos_failed: walk.failed,
        repos_with_commits: walk.shares.values().filter(|(mine, _)| *mine > 0).count(),
        churn: churn_result,
        gists: gists.len(),
    };
    Ok(Snapshot {
        login,
        member_since,
        calendar: calendar.days,
        years: calendar.years,
        commits: walk.commits,
        pulls,
        issues,
        reviews,
        coauthors,
        languages,
        churn: churn_map,
        issue_comments: int(&viewer, "/issueComments/totalCount"),
        organizations: int(&viewer, "/organizations/totalCount"),
        stars,
        followers: int(&viewer, "/followers/totalCount"),
        coverage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scoper() -> Scoper {
        Scoper { login: "octo".into(), orgs: HashSet::from(["corp".to_string()]) }
    }

    fn repo(id: &str, owner: &str, owner_type: &str, is_fork: bool, bytes: f64) -> Repo {
        Repo { id: id.into(), name_with_owner: format!("{owner}/{id}"), is_fork, is_private: true, owner: owner.into(), owner_type: owner_type.into(), languages: vec![("Go".into(), bytes)] }
    }

    #[test]
    fn language_bytes_are_weighted_by_commit_share() {
        let repos = vec![repo("mono", "corp", "Organization", false, 1_000_000.0)];
        let shares = HashMap::from([("mono".to_string(), (1, 100))]);
        let rows = aggregate_languages(&repos, &shares, &[], &scoper(), &[]);
        assert_eq!(rows["Go"].org, 10_000.0);
    }

    #[test]
    fn own_repos_with_unlinked_commits_count_but_untouched_forks_and_org_repos_do_not() {
        let repos = vec![repo("mine", "octo", "User", false, 500.0), repo("fork", "octo", "User", true, 900.0), repo("corp", "corp", "Organization", false, 900.0)];
        let shares: HashMap<String, (i64, i64)> = ["mine", "fork", "corp"].iter().map(|id| ((*id).to_string(), (0, 5))).collect();
        let rows = aggregate_languages(&repos, &shares, &[], &scoper(), &[]);
        assert_eq!(rows["Go"].personal, 500.0);
        assert_eq!(rows["Go"].org, 0.0);
    }

    #[test]
    fn gist_languages_count_code_measure_lines_and_honor_exclusions() {
        let gist = json!({ "isFork": false, "files": [
            { "name": "a.py", "size": 100, "text": "one\ntwo\nthree\n", "language": { "name": "Python" } },
            { "name": "b.md", "size": 999, "text": "x", "language": { "name": "Markdown" } },
            { "name": "c.rb", "size": 100, "text": "x", "language": { "name": "Ruby" } },
        ] });
        let rows = aggregate_languages(&[], &HashMap::new(), &[gist], &scoper(), &["ruby".to_string()]);
        assert_eq!(rows.keys().collect::<Vec<_>>(), vec!["Python"]);
        assert_eq!((rows["Python"].gist, rows["Python"].gist_lines), (100.0, 3));
        assert!(!format!("{rows:?}").contains("three"), "gist text is measured, not kept");
    }

    #[test]
    fn line_counts_handle_a_missing_final_newline() {
        assert_eq!(count_lines("a\nb\n"), 2);
        assert_eq!(count_lines("a\nb"), 2);
        assert_eq!(count_lines(""), 0);
    }

    #[test]
    fn scopes_come_from_ownership() {
        let scoper = scoper();
        assert_eq!(scoper.of("OCTO", "User"), Scope::Personal);
        assert_eq!(scoper.of("Corp", "Organization"), Scope::Org);
        assert_eq!(scoper.of("other", "Organization"), Scope::External);
        assert_eq!(scoper.of("someone", "User"), Scope::External);
    }
}
