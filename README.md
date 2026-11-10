# oh-my-stats

The ultimate developer stats platform, at [ohmystats.dev](https://ohmystats.dev). Sign in with GitHub, run a small agent on each computer, and see your AI tokens and contributions in one place, with private work included.

- **Continuous:** a background agent records usage as you work, and keeps its own record, so history survives when AI tools delete their logs. It uploads once a day, and `oms sync` uploads right away.
- **Multi-machine:** every computer signs in to the same account, and their numbers are combined correctly.
- **Real numbers:** GitHub's contribution API hides private work, so commits are counted by walking each repository instead.
- **Private by default:** your profile stays hidden until you publish it, and only totals ever leave your machine.

## How it works

```
 Each machine                                   Server (Cloudflare Workers + D1)
┌─────────────────────────────────────┐        ┌───────────────────────────────┐
│ oms agent (Rust)                    │        │ GitHub sign-in                │
│  reads Claude Code and Codex logs   │ totals │ per-machine usage             │
│  keeps every response in local SQLite├──────▶│ combines machines             │
│  walks GitHub with a local token    │  only  │ dashboard, profile, SVG embed │
└─────────────────────────────────────┘        └───────────────────────────────┘
```

## Get started

The agent needs [Rust](https://rustup.rs) to build. Prebuilt binaries aren't published yet.

```sh
git clone https://github.com/saintlee83/oh-my-stats
cargo install --path oh-my-stats/agent

oms login             # approve a code in your browser
oms sync              # send your usage now
oms service install   # keep tracking in the background
oms publish           # optional: make your profile public
```

Repeat `oms login`, `oms sync` and `oms service install` on each computer.

The agent reads new log lines every 5 minutes and uploads once a day, so your numbers can be up to a day behind. A machine that was asleep or offline catches up when it comes back. Run `oms sync` to update right away, or change `uploadIntervalMinutes`.

GitHub stats need read access to your repositories, and that access stays on your machine. The agent uses your [GitHub CLI](https://cli.github.com) login if you have one, after `gh auth refresh -s repo,read:org`. Otherwise, set `OMS_GITHUB_TOKEN` to a token with the `repo` and `read:org` scopes.

Once published, add the dashboard to your GitHub profile README:

```markdown
![Developer stats](https://ohmystats.dev/u/<login>/dashboard.svg)
```

Or show only the parts you want, in any order. Each part is its own image, as wide as the dashboard, so stacked parts line up:

```markdown
![Contributions](https://ohmystats.dev/u/<login>/components/contributions.svg)

![AI token trace](https://ohmystats.dev/u/<login>/components/tokens.svg)
```

| Part | Shows |
|---|---|
| `contributions` | Contributions this year and lifetime, and commits, PRs, reviews and issues by month |
| `rhythm` | When you contribute, by weekday and hour, and by time of day |
| `languages` | Top languages by lines added, split by personal, organization, gist and other repos |
| `coauthors` | Who you co-author commits with |
| `churn` | Lines added and removed, by language |
| `tokens` | AI tokens by tool, cache hit rate, API list price, and tokens per day for 60 days |
| `history` | Every year by month, streaks, and time to merge and review |

Your profile page lists the embed code for every part that has data. A part without data yet shows a short note instead of a broken image.

Images follow the viewer's light or dark mode. By default they use GitHub's colors, so they blend into a GitHub page. For [Tokyo Night](https://github.com/tokyo-night/tokyo-night-vscode-theme) colors, add `?theme=tokyo-night` to any image address. Dark mode uses Tokyo Night, and light mode uses its Day variant:

```markdown
![Developer stats](https://ohmystats.dev/u/<login>/dashboard.svg?theme=tokyo-night)
```

## Commands

```
oms login                 Sign this machine in with GitHub
oms logout                Sign this machine out, keeping its local history
oms status                Show sign-in, totals and machines
oms sync                  Read new logs and upload what changed, right now
oms sync --github         Also collect GitHub stats now
oms daemon                Keep tracking in the foreground
oms service install       Run in the background, starting at login (launchd or systemd)
oms service uninstall     Remove the background service
oms service status        Show whether the service is running
oms publish               Show your profile to everyone
oms unpublish             Make your profile private again
oms preview               Print exactly what would be uploaded, without sending anything
```

## What leaves your machine

| Uploaded | Stays on your machine |
|---|---|
| Tokens per day and model | Prompts, responses and code |
| Lifetime totals per tool and model | Commit messages and file paths |
| Aggregated GitHub numbers, such as commits per month and lines per language | Private repository and organization names |
| This machine's name and platform, shown only to you | The token that reads your repositories |
| Your timezone, shown on your public dashboard | |

Run `oms preview` to see the exact usage data. GitHub stats are aggregated on your machine first, so no commit-level data is sent.

**Sign-in:** the server only ever receives a token that proves who you are. It comes from a GitHub App with no permissions, so it can't read your repositories. The server uses it once and doesn't store it, and only accepts tokens issued to its own app. It stores a hash of its own session tokens. The agent refuses to send a GitHub token with more access than that. A machine's sign-in expires after 180 days without an upload, and signing in again replaces it.

**Publishing:** a private profile looks the same as one that doesn't exist. Publishing shows your totals per model and per day. Machine names are never public. Public pages are cached for 5 minutes, so after you unpublish, a copy can stay visible for up to that long.

**Co-authors:** AI assistants are named. Bots are too, except a custom bot in a private repo, because its name can include an organization's. People are named only if they have a GitHub account and co-authored in a public repo, counting those public commits only. Everyone else is an anonymous count. Emails are never uploaded.

**Your data:** removing a machine deletes its data and signs it out. Deleting your account removes everything on the server, after you confirm with your username. Each machine keeps its local history, so `oms login` and `oms sync` bring your usage back.

## How machines combine

Adding every number together would be wrong, because the sources have different reach:

| Source | Reach | Combined by |
|---|---|---|
| Claude Code's lifetime statistics (`stats-cache.json`) | One machine | Adding across machines |
| Codex's account total (the figure behind `/usage`) | Every device on the account | Counting once |
| Local logs, one count per model response | One machine | Adding across machines |

Usage logged after a tool's figure was last updated is added on top. Codex's split by model comes from logs, so usage outside them shows as "Model unknown" and is left out of cost. For that reason, cost is shown as a minimum, at public API list prices.

A machine's id comes from its hardware, so reinstalling doesn't register it twice.

## Run your own server

The server is a single Cloudflare Worker with a D1 database, and has no runtime dependencies.

1. [Create a GitHub App](https://github.com/settings/apps/new) with no permissions, so its tokens can only identify a user. Set the callback URL to `https://your-server/auth/callback`, **enable device flow**, turn off the webhook, and allow installation on any account.
2. Create the database. In `wrangler.jsonc`, put in its id, your domain under `routes`, and your app's `GITHUB_CLIENT_ID` under `vars`.
   ```sh
   pnpm install
   npx wrangler d1 create oh-my-stats
   npx wrangler d1 migrations apply DB --remote
   ```
3. Add the client secret and deploy.
   ```sh
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler deploy
   ```

Then point agents at it with `oms login --server https://your-server`.

## Known limits

- **Claude Code has no account-wide figure** for individual plans in its docs, so a machine without the agent isn't counted. Its statistics file isn't a public format, so a future version could change it. If it does, the agent keeps the last known total and uses logs.
- **Codex's account total** assumes all your machines use one Codex account.
- **AI tools:** only Claude Code, Claude Desktop agent sessions and Codex are read today.
- **Default branches only.** Commits still on other branches aren't walked, which matches how GitHub counts contributions. Your GitHub graph can show more than can be itemized, for example work in repositories that were later deleted.
- **Churn reads the first 300 files of a commit**, and treats a commit over 20,000 lines as a bulk import. Change this with `maxCommitLines` in `~/.oh-my-stats/config.json`.
- **Windows** isn't supported yet. The agent is tested on macOS and Linux.
- **Uploads are capped** at 20,000 changed rows per account per day. Anything over that goes through the next day. An account can have 50 machines.
- **Rate limits are approximate.** They use Cloudflare's rate limiting, which counts per location and can briefly let requests through above the limit.

## Configuration

`~/.oh-my-stats/config.json`, in addition to what `oms login` writes:

| Key | Default | Meaning |
|---|---|---|
| `timezone` | System | IANA zone for days and the rhythm chart |
| `uploadIntervalMinutes` | `1440` | How often to upload. Usage is recorded locally all the time. The minimum is 5 |
| `machineName` | Hostname | The name reported for a new machine. Rename it on your dashboard afterwards |
| `excludeLanguages` | `[]` | For example `["Jupyter Notebook"]` |
| `namedCoauthors` | `[]` | Logins to name on the co-author card, including private commits. Use this for people who've agreed |
| `agentCoauthors` | `[]` | Your own AI agent accounts: named, and counted as AI |
| `maxCommitLines` | `20000` | A commit changing more lines is treated as a bulk import |
| `maxFileLines` | `5000` | A bigger single-file diff is treated as generated |
| `maxRequestsPerRun` | `4000` | GitHub API budget per collection |

Environment: `OMS_HOME` (state folder), `OMS_SERVER`, `OMS_TIMEZONE`, `OMS_GITHUB_TOKEN`.

## Development

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm db:local && pnpm dev            # server on localhost:8787
pnpm test && pnpm typecheck

cd agent && cargo test
cargo run -- login --server http://localhost:8787 --gh
```

With `ALLOW_ANY_GITHUB_TOKEN=true` in `.dev.vars`, a local server accepts your GitHub CLI login, so you don't need a GitHub App to develop. The server ignores this setting anywhere but this computer, and the agent only uses `--gh` with a server on this computer.

- **Adding an AI tool:** add a parser in `agent/src/parse.rs`, and its log folder in `agent/src/scan.rs`.
- **The one rule that matters:** repository, organization and file names exist only inside `agent/src/github/collect.rs`. `Snapshot` has none, so nothing downstream can leak them.

## License

[MIT](LICENSE)
