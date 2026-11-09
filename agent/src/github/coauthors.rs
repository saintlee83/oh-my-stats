use std::collections::{BTreeMap, HashSet};

use super::classify::{ai_coauthor, ai_label};

#[derive(Debug, Clone)]
pub struct Actor {
    pub name: String,
    pub email: String,
    pub login: Option<String>,
}

/// Internal to collection: identities here must not leave this module unfiltered.
#[derive(Debug, Clone)]
pub struct CoauthorEvent {
    pub oid: String,
    pub is_private: bool,
    /// As GitHub returns them: the git author first, then trailer co-authors.
    pub actors: Vec<Actor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoauthorRow {
    pub label: String,
    pub kind: &'static str,
    pub commits: i64,
}

#[derive(Debug, Clone, Default)]
pub struct CoauthorSummary {
    pub named: Vec<CoauthorRow>,
    pub private_people: i64,
    pub private_commits: i64,
    pub coauthored_commits: i64,
    pub solo_commits: i64,
    pub by_ai: i64,
    pub by_bot: i64,
    pub by_person: i64,
}

/// Anyone can install these, so their names say nothing about where they were used.
const WELL_KNOWN_BOTS: [&str; 4] = ["dependabot", "github-actions", "renovate", "pre-commit-ci"];

fn is_bot(actor: &Actor) -> bool {
    format!("{} {} {}", actor.name, actor.login.as_deref().unwrap_or(""), actor.email).to_lowercase().contains("[bot]")
}

fn bot_name(actor: &Actor) -> String {
    let source = actor.login.clone().unwrap_or_else(|| actor.name.clone());
    let cleaned = source.replace("[bot]", "").trim().to_string();
    if cleaned.is_empty() { "bot".to_string() } else { cleaned }
}

/// Applies the publishing rule for co-authors:
/// - AI assistants are named, because they are not people. So are bots, except a custom bot
///   in a private repo, because its name can include an organization's.
/// - A person is named only with a GitHub account and a co-authored commit in a public repo.
///   That link is already public, and only those commits count, so the number reveals
///   nothing about private work.
/// - `allowed` logins opt in explicitly and count everywhere. `agents` are the user's own
///   AI agent accounts: named, and counted as AI.
/// - All other collaboration is an anonymous count. Emails are never kept.
pub fn tally(events: &[CoauthorEvent], login: &str, total_commits: i64, allowed: &[String], agents: &[String]) -> CoauthorSummary {
    let lower = |items: &[String]| items.iter().map(|item| item.to_lowercase()).collect::<HashSet<_>>();
    let (opted_in, agent_accounts) = (lower(allowed), lower(agents));
    let me = login.to_lowercase();

    let mut named: BTreeMap<String, CoauthorRow> = BTreeMap::new();
    let mut private_people: HashSet<String> = HashSet::new();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut summary = CoauthorSummary::default();

    for event in events {
        if !seen.insert(&event.oid) {
            continue;
        }
        let author_email = event.actors.first().map(|actor| actor.email.to_lowercase());
        let mut credited: HashSet<String> = HashSet::new();
        let (mut has_coauthor, mut has_private, mut ai, mut bot, mut person) = (false, false, false, false, false);

        for actor in event.actors.iter().skip(1) {
            let account = actor.login.as_deref();
            let account_lower = account.map(str::to_lowercase);
            let email = actor.email.to_lowercase();
            // A trailer can credit the author again under a second address.
            if account_lower.as_deref() == Some(me.as_str()) || (!email.is_empty() && Some(&email) == author_email.as_ref()) {
                continue;
            }
            has_coauthor = true;
            let mut credit = |key: String, label: String, kind: &'static str| {
                if credited.insert(key.clone()) {
                    named.entry(key).or_insert(CoauthorRow { label, kind, commits: 0 }).commits += 1;
                }
            };

            if let Some(account) = account.filter(|_| account_lower.as_ref().is_some_and(|value| agent_accounts.contains(value))) {
                ai = true;
                credit(format!("ai:@{account}"), format!("@{account}"), "ai");
            } else if let Some(family) = ai_coauthor(&actor.name, &email, account) {
                ai = true;
                let label = ai_label(&actor.name, family);
                credit(format!("ai:{label}"), label, "ai");
            } else if is_bot(actor) {
                bot = true;
                let name = bot_name(actor);
                let opted = account_lower.as_ref().is_some_and(|value| opted_in.contains(value));
                if !event.is_private || opted || WELL_KNOWN_BOTS.contains(&name.to_lowercase().as_str()) {
                    credit(format!("bot:{name}"), name, "bot");
                }
            } else if let Some(account) = account.filter(|_| !event.is_private || account_lower.as_ref().is_some_and(|value| opted_in.contains(value))) {
                person = true;
                credit(format!("person:{account}"), format!("@{account}"), "person");
            } else {
                person = true;
                has_private = true;
                let identity = account_lower.clone().or_else(|| (!email.is_empty()).then(|| email.clone())).unwrap_or_else(|| actor.name.to_lowercase());
                if !identity.is_empty() {
                    private_people.insert(identity);
                }
            }
        }
        summary.by_ai += i64::from(ai);
        summary.by_bot += i64::from(bot);
        summary.by_person += i64::from(person);
        summary.private_commits += i64::from(has_private);
        summary.coauthored_commits += i64::from(has_coauthor);
    }

    let mut rows: Vec<CoauthorRow> = named.into_values().collect();
    rows.sort_by(|a, b| b.commits.cmp(&a.commits).then_with(|| a.label.cmp(&b.label)));
    summary.named = rows;
    summary.private_people = private_people.len() as i64;
    summary.solo_commits = (total_commits - summary.coauthored_commits).max(0);
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(name: &str, email: &str, login: Option<&str>) -> Actor {
        Actor { name: name.into(), email: email.into(), login: login.map(str::to_string) }
    }

    fn me() -> Actor {
        actor("Me", "me@example.com", Some("octo"))
    }

    fn event(oid: &str, is_private: bool, others: Vec<Actor>) -> CoauthorEvent {
        let mut actors = vec![me()];
        actors.extend(others);
        CoauthorEvent { oid: oid.into(), is_private, actors }
    }

    fn row(label: &str, kind: &'static str, commits: i64) -> CoauthorRow {
        CoauthorRow { label: label.into(), kind, commits }
    }

    #[test]
    fn ai_and_bots_are_named_and_ranked() {
        let events = vec![
            event("1", true, vec![actor("Claude Opus 5.5", "noreply@anthropic.com", None)]),
            event("2", true, vec![actor("Claude Sonnet 5.5", "noreply@anthropic.com", None)]),
            event("3", false, vec![actor("dependabot[bot]", "x@users.noreply.github.com", Some("dependabot"))]),
            event("4", false, vec![]),
        ];
        let summary = tally(&events, "octo", 4, &[], &[]);
        assert_eq!(summary.named, vec![row("Claude Opus 5.5", "ai", 1), row("Claude Sonnet 5.5", "ai", 1), row("dependabot", "bot", 1)]);
        assert_eq!((summary.coauthored_commits, summary.solo_commits), (3, 1));
        assert_eq!((summary.by_ai, summary.by_bot, summary.by_person), (2, 1, 0));
    }

    #[test]
    fn a_custom_bot_in_a_private_repo_is_only_counted() {
        let custom = || actor("acme-deploy[bot]", "1+acme-deploy[bot]@users.noreply.github.com", Some("acme-deploy"));
        let dependabot = actor("dependabot[bot]", "x@users.noreply.github.com", Some("dependabot"));
        let events = vec![event("1", true, vec![custom()]), event("2", true, vec![dependabot])];
        let summary = tally(&events, "octo", 2, &[], &[]);
        assert_eq!(summary.named, vec![row("dependabot", "bot", 1)]);
        assert_eq!(summary.by_bot, 2);
        assert!(!format!("{summary:?}").contains("acme"));

        let public = vec![event("1", false, vec![custom()]), event("2", true, vec![custom()])];
        assert_eq!(tally(&public, "octo", 2, &[], &[]).named, vec![row("acme-deploy", "bot", 1)], "public commits only");
        assert_eq!(tally(&events[..1], "octo", 1, &["acme-deploy".to_string()], &[]).named, vec![row("acme-deploy", "bot", 1)], "opted in");
    }

    #[test]
    fn a_person_from_a_private_repo_is_never_named() {
        let secret = || actor("Secret Teammate", "secret@corp.example", Some("secret-teammate"));
        let events = vec![event("1", true, vec![secret()]), event("2", true, vec![secret()]), event("3", true, vec![actor("No Account", "unlinked@corp.example", None)])];
        let summary = tally(&events, "octo", 3, &[], &[]);
        assert!(summary.named.is_empty());
        assert_eq!((summary.private_people, summary.private_commits), (2, 3));
        let text = format!("{summary:?}");
        for secret in ["Secret Teammate", "secret-teammate", "corp.example", "No Account", "unlinked"] {
            assert!(!text.contains(secret), "{secret}");
        }
    }

    #[test]
    fn a_public_collaborator_shows_public_commits_only() {
        let pal = || actor("Pal", "pal@example.com", Some("pal"));
        let events = vec![event("1", false, vec![pal()]), event("2", true, vec![pal()]), event("3", true, vec![pal()])];
        let summary = tally(&events, "octo", 3, &[], &[]);
        assert_eq!(summary.named, vec![row("@pal", "person", 1)]);
        assert_eq!(summary.private_commits, 2);
    }

    #[test]
    fn a_public_trailer_without_an_account_stays_anonymous() {
        let summary = tally(&[event("1", false, vec![actor("Someone", "someone@example.com", None)])], "octo", 1, &[], &[]);
        assert!(summary.named.is_empty());
        assert_eq!(summary.private_people, 1);
    }

    #[test]
    fn crediting_yourself_or_repeating_a_coauthor_counts_once() {
        let pal = || actor("Pal", "pal@example.com", Some("pal"));
        let events = vec![
            event("1", false, vec![actor("Me Again", "second@example.com", Some("OCTO")), actor("Me", "me@example.com", None)]),
            event("2", false, vec![pal(), pal()]),
            event("2", false, vec![pal()]), // The same commit reached through a fork.
        ];
        let summary = tally(&events, "octo", 2, &[], &[]);
        assert_eq!(summary.named, vec![row("@pal", "person", 1)]);
        assert_eq!((summary.coauthored_commits, summary.solo_commits), (1, 1));
    }

    #[test]
    fn opting_in_names_a_private_collaborator() {
        let events = vec![event("1", true, vec![actor("Pal", "p@x.example", Some("pal"))]), event("2", true, vec![actor("Other", "o@x.example", Some("other-person"))])];
        let summary = tally(&events, "octo", 2, &["PAL".to_string()], &[]);
        assert_eq!(summary.named, vec![row("@pal", "person", 1)]);
        assert_eq!(summary.private_people, 1);
        assert!(!format!("{summary:?}").contains("other-person"));
    }

    #[test]
    fn your_own_agent_account_is_named_and_counted_as_ai() {
        let agent = || actor("Team Agent", "agent@corp.example", Some("team-agent"));
        let events = vec![event("1", true, vec![agent()]), event("2", true, vec![agent(), actor("Other", "o@x.example", Some("other"))])];
        let summary = tally(&events, "octo", 2, &[], &["TEAM-AGENT".to_string()]);
        assert_eq!(summary.named, vec![row("@team-agent", "ai", 2)]);
        assert_eq!((summary.by_ai, summary.by_person), (2, 1));
    }
}
