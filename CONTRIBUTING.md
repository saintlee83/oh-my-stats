# Contributing to oh-my-stats

Thank you for helping. This guide covers how the code is laid out, how to run it, what a change needs before it is merged, and how to make the most common kinds of change.

- [What to work on](#what-to-work-on)
- [How the code is laid out](#how-the-code-is-laid-out)
- [Set up](#set-up)
- [Before you open a pull request](#before-you-open-a-pull-request)
- [Rules the code keeps](#rules-the-code-keeps)
- [Common changes](#common-changes): [an AI tool](#add-an-ai-tool) · [a page](#add-a-page) · [a README image](#add-or-change-a-readme-image) · [a table](#change-the-database) · [the install scripts](#change-the-install-scripts-or-oms-update)
- [Style](#style)
- [Releases](#releases)
- [Security problems](#security-problems)

## What to work on

- **Bugs.** [Open an issue](https://github.com/saintlee83/oh-my-stats/issues) with what you ran, what you expected and what happened. Include `oms --version` and your operating system. When a number is wrong, the output of `oms preview` shows what `oms` counted, and holds only totals. Take out anything you would rather not share.
- **A tool that isn't read yet.** `oms` reads seventeen AI tools on its own. Adding one is the most common contribution, and [has its own steps below](#add-an-ai-tool).
- **Something larger**, such as a new page, a new board or a change to what is uploaded. Open an issue first, so the idea can be discussed before you write it.

A small fix can go straight to a pull request.

Some changes are declined whatever their merit, because the project promises otherwise: anything that sends more than totals off a machine, a script on a page, and a runtime dependency for the server. [Rules the code keeps](#rules-the-code-keeps) has the reasons.

## How the code is laid out

There are two programs. `oms` runs on each computer, and the server is one Cloudflare Worker. In the code, `oms` is called the agent, after the folder it lives in.

```
agent/                    `oms`, in Rust
  src/main.rs             The commands
  src/scan.rs             Finds each tool's logs and reads what is new
  src/parse.rs            Claude Code and Codex logs, and the usage event every reader produces
  src/providers.rs        The list of readers, Gemini CLI, and the JSONL export format
  src/providers/native.rs Readers for the other tools' own files
  src/totals.rs           Lifetime figures the tools report themselves
  src/store.rs            The local record, in SQLite
  src/sync.rs             What to upload, and when
  src/github/             GitHub activity, collected and aggregated on the machine
  src/service.rs          The background service: launchd, systemd, or a Windows startup app
  src/updates.rs          `oms update` and the notice of a newer release
  tests/                  Tests that run the built program against files on disk

proxy.ts                  The front door: each page's checks and nonce, and every POST to the server
app/                      The routes vinext serves: one page.tsx per page, the rest to the server
src/web/                  The website's pages, in React
  routes.ts               Which address is which page, and what is checked before one is drawn
  layout.tsx, common.tsx  The frame every page shares, and the pieces several pages use
  activity.tsx, days.tsx  The usage panels of a profile, and the days that answer when pointed at
  pages/                  Each page: what it loads, and how it is drawn
src/server/               The API, images, sign-in, forms and queries
  app.ts                  Every route that isn't a page, the cache, and the security headers
  pages.ts, style.ts      The error pages the server draws itself, and the one stylesheet
  provider-icons.ts       The mark of each AI tool, drawn beside its name
  rankings.ts, boards.ts  The queries behind the boards, and board-pages.ts draws them
  groups.ts, grouppages.ts, grouproutes.ts
  reading.ts              How we count, privacy, terms, robots.txt and the sitemap
  wire.ts                 Checks everything `oms` sends
  db.ts                   The queries, over the small part of D1 the app uses
src/shared/               Code with no server in it: numbers, time, and drawing
  render/                 The SVG dashboard, its parts, the card, the badge and the preview PNG

migrations/               The database, one numbered SQL file per change
test/                     Server tests, run by Node
public/                   Files served as they are
install.sh, install.ps1   The install scripts, which each release carries
.github/workflows/        CI, and the release build
```

## Set up

You need:

- [Node.js](https://nodejs.org) 22.18 or newer, and [pnpm](https://pnpm.io) 10. CI uses Node 24.
- [Rust](https://rustup.rs), the current stable release. On Windows, let rustup install the Visual Studio build tools when it offers.
- [GitHub CLI](https://cli.github.com), signed in, to sign `oms` in to a server on your computer.

You only need the first to work on the server, and the second to work on `oms`.

Run the server:

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm db:local        # creates the local database from migrations/
pnpm dev             # http://localhost:8787
```

`.dev.vars` sets `ALLOW_ANY_GITHUB_TOKEN=true`, so the local server accepts your GitHub CLI login and you don't need a GitHub App. The server ignores that setting for any request that doesn't come from this computer.

Then sign a development build of `oms` in to it, from a second terminal:

```sh
cd agent
export OMS_HOME=~/.oh-my-stats-dev
cargo run -- login --server http://localhost:8787 --gh
cargo run -- sync
cargo run -- publish
```

Set `OMS_HOME` first. `oms login` replaces the sign-in kept in `~/.oh-my-stats`, so without it, the `oms` you use every day would start sending to your local server. In PowerShell, that line is `$env:OMS_HOME = "$HOME\.oh-my-stats-dev"`. The development build still reads your real AI tool logs, which is what gives the local pages something to show. The first `sync` reads your whole history, and if GitHub CLI is signed in it also walks your repositories for GitHub activity, so it can take several minutes.

Now open http://localhost:8787. Signing in on the website needs a GitHub App, so without one you work with the public pages: `/u/<your login>` once you have run `publish`, `/rankings`, and the images under `/u/<your login>/`. To see the pages behind sign-in, such as your dashboard at `/me`, create an app as [Run your own server](README.md#run-your-own-server) describes, with `http://localhost:8787/auth/callback` as its callback URL, and put its client ID and secret in `.dev.vars`.

## Before you open a pull request

Run what CI runs:

```sh
pnpm typecheck
pnpm test
cd agent && cargo test --locked
```

CI runs the server checks on Linux, and the tests of `oms` on Linux, macOS and Windows. A pull request that changes an install script, the release workflow, `agent/Cargo.toml` or `agent/Cargo.lock` also builds all six release targets and installs the build with the script.

A pull request should have:

- **One change.** A fix and an unrelated cleanup are two pull requests.
- **A test** that fails without the change. The exceptions are wording and styling.
- **The README**, updated in the same pull request when the change is something a user can see: a command, a setting, an address, a tool, a limit.
- **A picture** when a page or an image changes, in light and dark, and at a phone's width for a page.
- **What you couldn't check.** If the change touches Windows and you have no Windows, say so. The same goes for a tool you read from its source code without running it.

## Rules the code keeps

These are what the project promises its users. A change that breaks one is a bug, whatever else it does.

**On the machine**

- **Only totals leave it.** Prompts, responses, code, commit messages and file paths are never uploaded. `oms preview` prints exactly what a sync sends, and has to stay true.
- **Repository, organization and file names exist only inside `agent/src/github/collect.rs`.** `Snapshot`, which that module hands on, has none of them, so nothing downstream can leak one. Don't add a field to it that could hold one.
- **The token that reads repositories stays on the machine.** The server only ever receives a token that proves who someone is.
- **Other programs' files are read, never written.** SQLite databases are opened read-only.
- **Every tool counts the same way.** A reader produces `UsageEvent`s: input without cached tokens, output with reasoning tokens, cache reads and writes apart, and a key that stays the same when the same file is read again. A response is counted once, however often its log is scanned.

**On the server**

- **The pages are React, served by vinext; everything else is plain TypeScript.** The runtime dependencies are React and vinext. Images, the API and the server's own error pages are built as strings.
- **Pages run only React's scripts.** The content security policy is `default-src 'none'`, with inline styles, the site's own images and GitHub avatars, and scripts that carry the nonce `proxy.ts` gives each response. Menus, tabs and dialogs still work with CSS and HTML alone, so a page reads the same before its scripts run. Pages load no fonts and nothing from another site.
- **Everything shown is escaped.** Names, descriptions and model names come from users and from uploads. React escapes what a page shows; `dangerouslySetInnerHTML` is only for constants in the code, such as a tool's mark. In an image, put them through `esc` in `src/shared/render/svg.ts`, and in a page the server draws, through `esc` in `src/server/pages.ts`.
- **Everything `oms` sends is checked** in `src/server/wire.ts`, with a limit on its size. Model and provider names end up on public pages.
- **A private profile answers exactly like a missing one**, on every address. So does a private group, to everyone but its members. Machine names are never public.
- **Going private takes effect at once.** Public pages are cached for 5 minutes, and `purgeProfile` in `app.ts` removes a profile's cached copies when it is unpublished. A new cached address under `/u/<login>` has to be added to that list. One request may make 50 calls to the cache and the database together on Cloudflare's free plan, so a test keeps the list at 40 or fewer. When there is no room, serve the new address uncached.
- **Queries go through the `Db` interface** in `db.ts`: `prepare`, `bind`, `run`, `all`, `first` and `batch`. That is the part of D1 the tests can run on plain SQLite.

## Common changes

### Add an AI tool

A tool whose usage you can export needs no code at all: see [Add a provider with JSONL](README.md#add-a-provider-with-jsonl). To have `oms` read a tool's own files:

1. **Find a record of each model response with its token counts**, in a file the tool keeps on disk. Session summaries and terminal output are not enough, because they can describe the same usage twice. Read the tool's source for the format, and link the file you relied on.
2. **Add the reader** to the `Reader` list in `agent/src/providers.rs`, with its provider ID in `provider()` and the file names it reads in `accepts()`. An ID is lowercase, such as `kilo-code`.
3. **Parse it** in `agent/src/providers/native.rs`: `line` for a file of JSON lines, `snapshot` for a file that is rewritten whole, and `database` for SQLite.
4. **Say where to look** in `default_roots` in `agent/src/scan.rs`, following the tool's own setting for its folder if it has one, and its location on Windows.
5. **Name it** in `PROVIDERS` in `src/shared/format.ts`. That gives it its name on the website, and a place on the providers board, which lists only the tools named there. Add its mark to `src/server/provider-icons.ts` under the same ID, which the website draws beside the name: one flat shape in a square of 24 units, with no color of its own, and a note of where it came from. A test fails for a tool that has none.
6. **Test it** in `agent/tests/native_usage.rs`: write files as the tool would, scan twice, and check that each response counts once and that new usage is picked up.
7. **Document it** in the README: a row in the table under [Automatically collected histories](README.md#automatically-collected-histories), any folder setting it follows, what it can't count, and the number of tools where the README and this guide state it.

Say in the pull request whether you ran the tool and compared the numbers, or worked from its source alone.

### Add a page

1. Write it in `src/web/pages/` as a `PageModule`: `load` reads what the page shows, or sends the visitor elsewhere, or finds nothing; `View` draws it inside `Layout` from `src/web/layout.tsx`. Pass `origin` only for a page search engines should list. Without it, the page is marked `noindex`. Name every tool the page marks in `icons`.
2. Give it an address: a pattern in `ROUTES` in `src/web/routes.ts`, with any rate limit and any check of its query in `gate`, and a `page.tsx` under `app/` that calls `serve`. A form posts to `handleWebPost` in `src/server/app.ts`.
3. Add its styles to `src/server/style.ts`, with the colors already defined there, which have light and dark values. A chart that tells providers or models apart takes each one's color from `seriesOf` in `src/shared/series.ts`, so a name wears the same color in every chart, and always names it beside the color. What a day shows when it is pointed at is in `src/web/days.tsx`, one of the few files that run in the browser.
4. Decide whether what it loads is kept. Anything kept that shows a profile's data has to be removed when that profile goes private. See the rule above.
5. Add a page that search engines should find to `INDEXED_PATHS` in `src/server/reading.ts`, which is what the sitemap lists.
6. List it in `PAGES` in `test/site.tsx`, and test it through `app()` in `test/harness.ts`, which gives you the website over a new database and a stand-in for GitHub. The tests draw each page the way vinext does, without a browser.

### Add or change a README image

The dashboard and its parts are drawn in `src/shared/render/svg.ts`. The card, the badge and the preview image are in the files beside it. A new part needs its key in `COMPONENT_KEYS`, its drawing in `renderComponent`, and a row in the README's table of parts. The key gives it an address, `/u/<login>/components/<key>.svg`, and one more cached copy per theme for `purgeProfile` to remove, so check the limit above. An image has to read well in each theme, in light and in dark, and show a short note when a profile has no data for it.

The image shown where a link to the site is shared is `public/og.png`. It is `.github/banner.svg` drawn at twice its size, 2400 by 1260. After changing the drawing, open it in a browser and save a screenshot at that size. A profile's own preview, `/u/<login>/og.png`, is drawn by the server from squares, with no image library: see `src/shared/render/preview.ts`.

### Change the database

Add a new file to `migrations/`, numbered after the last one, with a comment that says what the tables are for. Never edit a migration that has been released, because servers have already applied it. Run `pnpm db:local` to apply it locally. The tests build their database from the same files, so they pick it up on their own.

A server's owner applies migrations before deploying. Say in the pull request that the change needs one.

### Change the install scripts or `oms update`

`install.sh` and `install.ps1` are what people run to install, and `oms update` runs the same script from the release it installs. Keep `install.sh` to POSIX `sh`, and `install.ps1` working in both Windows PowerShell 5.1 and PowerShell 7. The release workflow installs each build with them, and `agent/tests/update.rs` runs `oms update` against a release served from the test itself.

Don't try an install script against your real home folder if `oms` runs in the background there, because the script restarts that `oms` on whatever it just installed. On macOS and Linux, set `HOME` and `OMS_INSTALL_DIR` to a folder made for the test, as the tests do.

## Style

- **Match the code around you.** There is no formatter or linter to run. The Rust code is not formatted with `cargo fmt`, so don't run it: it rewrites hundreds of lines you didn't change.
- **TypeScript runs as it is written.** Node runs the tests by removing the types, so use only syntax that can be removed: no `enum`, no `namespace`, no parameter properties. Imports name the file with its `.ts` ending.
- **Comments say why.** What the code does is in the code. Write a comment for a reason, a limit or a trap.
- **A test's name is a sentence about behavior**, such as `a private group answers exactly like a missing one to everyone but its members`.
- **Write for the person reading.** Messages, pages and the README use plain words and whole sentences, and say what to do next when something fails.
- **A commit's subject says what changes, in the imperative**, with no prefix: `Read Roo Code, Kilo Code, Goose and Oh My Pi histories`. Put the reasons in the body.

## Releases

Maintainers release `oms`. The website is deployed separately.

1. Set the new version in `agent/Cargo.toml`, and build once so `agent/Cargo.lock` follows. CI builds with `--locked`, and fails if the two disagree.
2. Commit both files as `Release v0.3.1`, push to `main`, and wait for CI to pass on all three systems.
3. Tag that commit and push the tag: `git tag v0.3.1 && git push origin v0.3.1`. The workflow checks that the tag matches the version.

The release workflow builds six targets, installs each build with the install script, and publishes the release with its checksums and build provenance. The install scripts and `oms update` then find it as the latest release. A tag with a suffix, such as `v0.4.0-rc.1`, becomes a prerelease. The install scripts skip it unless `OMS_VERSION` names it, and `oms update` never installs one.

To deploy the website, apply any new migrations first, then build and deploy: `npx wrangler d1 migrations apply DB --remote`, then `pnpm run deploy`.

## Security problems

Please don't describe a security problem in a public issue. Open an issue that says only that you have one to report, and a maintainer will arrange a private way to send the details.

## License

oh-my-stats is released under the [MIT license](LICENSE). By contributing, you agree that your contribution is released under it too.
