import { PROVIDERS } from '../shared/format.ts';
import type { Db, UserRow } from './db.ts';
import { esc, layout, REPO_URL, SITE } from './pages.ts';

/**
 * The pages that explain the service in words, and the two files search engines ask for.
 * The words describe what this code does, so a change to what it counts, stores or shares
 * belongs here too. Anyone can run this server, so the pages say "this server" and name
 * nobody who runs it.
 */

type Section = [id: string, title: string, body: string];

interface ReadingPage {
  title: string;
  lead: string;
  description: string;
  /** The day the words last changed. The two pages people rely on as a record carry one. */
  updated?: string;
  sections: Section[];
}

const ISSUES_URL = `${REPO_URL}/issues`;
const TOOLS = [...PROVIDERS.values()].map(esc).join(', ');

const HOW_WE_COUNT: ReadingPage = {
  title: 'How we count',
  lead: 'What each number means, where it comes from, and where it stops being reliable.',
  description: `What the numbers on ${SITE} mean: tokens, cost at list price, contributions and rankings, and where each one stops being reliable.`,
  sections: [
    ['source', 'Where it comes from', `<p>Every number starts on your own machines. A small program, <code>oms</code>, runs on each computer you sign in. It reads the usage records your AI tools already keep there, and one machine with GitHub access walks your repositories.</p>
<p><code>oms</code> keeps its own record, so your history survives when a tool deletes its logs. Only totals are uploaded. This server adds up what your machines send, and never sees a prompt, a response or a line of code.</p>
<p><code>oms</code> finds ${PROVIDERS.size} tools on its own: ${TOOLS}. Any other tool can be added with a <a href="${REPO_URL}#add-a-provider-with-jsonl">JSONL export</a>.</p>`],
    ['tokens', 'Tokens', `<p>A token total is the sum of four kinds: input, output, cache reads and cache writes. Lifetime totals and rankings include all four.</p>
<p>Tools report these in different ways, and <code>oms</code> sorts them into the same four. For Gemini CLI, for example, cached input is counted once, tool-prompt tokens count as input and thinking tokens count as output. Where a tool gives one figure of its own, such as Codex’s account total, that figure is used as the tool reports it.</p>
<p>The cache hit rate is cache reads as a share of input, cache reads and cache writes together. Response counts, and tokens per response, come only from local logs, with one count per model response.</p>`],
    ['machines', 'How machines combine', `<p>Adding every number together would be wrong, because the sources have different reach.</p>
<div class="table"><table><thead><tr><th>Source</th><th>Reach</th><th>Combined by</th></tr></thead><tbody>
<tr><td>Claude Code’s lifetime statistics</td><td>One machine</td><td>Adding across machines</td></tr>
<tr><td>Codex’s account total, the figure behind <code>/usage</code></td><td>Every device on the account</td><td>Counting once</td></tr>
<tr><td>Local logs, one count per model response</td><td>One machine</td><td>Adding across machines</td></tr>
</tbody></table></div>
<p>Usage logged after a tool’s figure was last updated is added on top. Where a machine’s logs add up to more than the tool’s own figure, the larger number is used.</p>
<p>A machine’s id comes from its hardware, so reinstalling <code>oms</code> doesn’t register it twice. An account can have 50 machines.</p>
<p>The split by machine is shown only to its owner. Account-wide tokens with no matching machine record are listed apart, as “No matching device”.</p>`],
    ['dated', 'Dated and undated usage', `<p>Charts, calendars, weekly figures and rankings over a number of days use dated usage: tokens that belong to a day.</p>
<p>Logged usage is dated in the timezone of the machine that recorded it. Where a tool keeps daily figures of its own, those are used up to the last day they cover and logs fill in after that, because mixing the two would count the same usage twice.</p>
<p>A tool’s lifetime figure can be larger than all its dated days together. The rest is undated: it counts in lifetime totals and the all-time ranking, and appears as “Earlier” in the token card’s table by month, but it is in no chart and no dated period. So a profile can rank on lifetime tokens and show nothing for the last 7 days.</p>`],
    ['cost', 'Cost', `<p>Cost is what the usage would cost at public API list prices. It is not what was paid: subscription plans pay differently, so read it as a yardstick.</p>
<p>Prices come from <a href="https://github.com/BerriAI/litellm" rel="noopener">LiteLLM’s</a> community-maintained list, which this server fetches about once a day. The lookup covers the Claude, OpenAI and Gemini model families. Any other model still counts as usage and shows no price.</p>
<p>Each kind of token has its own price. Where the list has no cache price for a model, cache reads and writes are priced as input.</p>
<p>Cost is a minimum, marked ≥, whenever some tokens have no known model or price, because those are left out. Codex’s split by model comes from logs, so usage outside them shows as “Model unknown” and adds nothing to cost.</p>
<p>The current list is applied to all usage, old and new. A price change moves the cost of past usage too.</p>`],
    ['contributions', 'Contributions', `<p>GitHub’s contribution API hides the breakdown of private work, even from your own token. So <code>oms</code> counts commits by walking each repository, on your machine, with a token that stays there.</p>
<p>Private work is included because only numbers are uploaded, such as commits per month and lines per language. Private repository and organization names, commit messages and file paths stay on the machine.</p>
<p>The headline count is the one on your GitHub graph. Commits, pull requests, reviews and issues are what could be itemized, and can add up to less: the graph also counts activity GitHub does not list per repository, such as work in repositories that were later deleted.</p>
<p>Only default branches are walked, which matches how GitHub counts contributions. Line counts read the first 300 files of a commit, and a commit over 20,000 lines is treated as a bulk import.</p>`],
    ['rankings', 'Rankings', `<p>Rankings list published profiles only. Setting a profile to private removes it from them immediately.</p>
<p>A profile is ranked when it has positive usage in the period. Equal totals share a place and the next place is skipped: 1, 1, 3.</p>
<p>All time ranks lifetime totals, undated usage included. A period ranks dated usage: the last 7 or 30 days or this month, through today’s date in UTC, or the whole of last month. Your dashboard’s own windows end today in your timezone, so the two can differ by a day.</p>
<p>Account-wide usage counts once in a profile’s score. Ranking by one provider counts that tool alone. On My rankings, a device is credited with the usage attributable to it, and only you see that table.</p>
<p>Sorted by estimated cost, a profile is ranked by what its logged responses in the period would cost at public list prices. Only usage found in logs is priced, so the figure can be lower than the cost on the profile’s own page, and a model without a list price adds no cost.</p>
<p>The providers board counts, for each tool <code>oms</code> reads on its own, the published profiles that used it in the period, and their share of all ranked profiles. The models board does the same from logged responses, and lists a model only when it has a public list price. Both compare a period with the stretch right before it, and give a percentage only when that stretch had at least 25 profiles, because a percentage on a small base says little.</p>
<p>A group’s board ranks its members by the same score as the public rankings.</p>
<p>Rankings rest on what each machine reports. The server checks that an upload is well formed and within limits. It cannot check that the usage happened, so read a ranking as what profiles report, not as an audit.</p>`],
    ['freshness', 'How fresh it is', `<p><code>oms</code> reads new log lines every 5 minutes and uploads once a day, so numbers can be up to a day behind. A machine that was asleep or offline catches up when it comes back. Run <code>oms sync</code> to update right away.</p>
<p>GitHub numbers are collected by one machine at a time, when it uploads and the last collection is more than six hours old. With the daily upload, that is once a day.</p>
<p>Public profile pages and images are cached for 5 minutes. So are the home page’s preview of the rankings and the rank on a profile page, which can lag by up to five minutes. Your own dashboard is never cached.</p>`],
    ['limits', 'Known limits', `<ul>
<li>Claude Code has no account-wide figure for individual plans, so a machine without <code>oms</code> isn’t counted. Its statistics file isn’t a public format. If a future version changes it, <code>oms</code> keeps the last known total and uses logs.</li>
<li>Codex’s account total assumes all your machines use one Codex account.</li>
<li>Tools read from local logs, such as Gemini CLI, and imported usage cover only the machines running <code>oms</code>.</li>
<li>Hermes keeps running counters, so a first scan, or a gap between scans, can place several days of its usage on one day.</li>
<li>Copilot sessions without per-request token records, and Amp installations without local thread snapshots, can be incomplete.</li>
<li>Uploads are capped at 20,000 changed rows per account per day. Anything over that goes through the next day.</li>
</ul>
<p>Does a number look wrong? <a href="${ISSUES_URL}">Open an issue</a>.</p>`],
  ],
};

const PRIVACY: ReadingPage = {
  title: 'Privacy',
  lead: 'What this server stores, what stays on your machine, what publishing makes public, and how to remove it. The server is open source, so what this page says about the code can be checked there.',
  description: `What this ${SITE} server stores, what stays on your machine, what publishing makes public, its two cookies, and how to delete your data.`,
  updated: '2026-11-18',
  sections: [
    ['summary', 'In short', `<ul>
<li>Only totals leave your machine. Prompts, responses and code never do.</li>
<li>Your profile is private until you publish it, and a private profile looks the same as one that doesn’t exist.</li>
<li>Pages run no scripts and load no trackers. Two cookies exist, both for signing in.</li>
<li>You can remove a machine or your whole account on your dashboard, and it is deleted at once.</li>
</ul>`],
    ['local', 'What stays on your machine', `<ul>
<li>Prompts, responses and code</li>
<li>Commit messages and file paths</li>
<li>Private repository and organization names</li>
<li>The token that reads your repositories</li>
</ul>
<p>GitHub stats are aggregated on your machine first, so no commit-level data is sent. Emails are never uploaded.</p>
<p><code>oms</code> keeps its own record of your usage, and its sign-in for this server, in <code>~/.oh-my-stats</code> on each machine. Run <code>oms preview</code> to see exactly what would be uploaded, without sending anything.</p>`],
    ['stored', 'What this server stores', `<h3>Your account</h3>
<p>Your GitHub user id, username, name and avatar address, as GitHub gives them when you sign in. Whether your profile is public. Your timezone. What you write in the profile header on your dashboard. When the account was created and last changed, and how many rows it uploaded today, which enforces the daily cap.</p>
<p>The database has no place for an email address, a password or an IP address.</p>
<h3>Sign-ins</h3>
<p>For each website sign-in and each signed-in machine: a hash of its token, when it was created and when it expires. The tokens themselves are not stored.</p>
<h3>Machines</h3>
<p>For each machine: an id, its name, its platform, its version of <code>oms</code>, and when it was first and last seen. The id is a hash made on the machine from its hardware id, which itself never leaves it. The name is the machine’s own name unless you give it another.</p>
<h3>Usage</h3>
<p>For each machine, day, tool and model: input, output, cache-read and cache-write tokens, and the number of model responses. And each tool’s own lifetime figure as that machine last reported it, with its totals per model and per day where the tool gives them.</p>
<h3>GitHub aggregates</h3>
<p>One set of numbers per account, worked out on a machine. Among them: commits, pull requests, reviews and issues by month and year, when in the week you commit, lines per language, lines added and removed, streaks, times to merge and review, and counts of stars, followers and organizations. It holds no repository names. With it comes your public GitHub profile: name, bio, company, location and status.</p>
<p>It also counts who you co-author commits with. AI assistants are named. Bots are too, except a custom bot in a private repo, because its name can include an organization’s. People are named only if they have a GitHub account and co-authored in a public repo, counting those public commits only, or if you list them in your <code>oms</code> settings. Everyone else is an anonymous count.</p>
<h3>Groups</h3>
<p>For each group you start: its name, its description, whether it is public, its invite code and when it was made. For each group you are in: that you are a member, and since when.</p>
<h3>Not about you</h3>
<p>A copy of the public price list, and a note of when one of your machines last took the job of collecting GitHub stats.</p>`],
    ['public', 'What publishing makes public', `<p>Nothing is public until you publish. A private profile and a missing one give the same answer: not found.</p>
<p>Publishing shows anyone your GitHub username, name and avatar, your profile header, your token totals per tool, per model and per day with response counts and cost at list price, your GitHub aggregates as described above, your timezone, and your place in the public rankings.</p>
<p>It also lists your profile’s address in this site’s <a href="/sitemap.xml">sitemap</a>, where search engines look for pages. Published images can be embedded on other sites, such as a GitHub README.</p>
<p>Machine names and ids are never public, and neither is the split of your usage by machine. A public page says how many machines report a tool, not which.</p>
<p>Provider and model names you upload appear on public pages, so choose public-facing names if you export usage of your own. You can publish and unpublish at any time, on your dashboard or with <code>oms publish</code> and <code>oms unpublish</code>.</p>`],
    ['cookies', 'Cookies, scripts and trackers', `<p>This site sets two cookies, both only when you sign in on the website. A visitor who never signs in gets none.</p>
<ul>
<li><code>oms_session</code> keeps you signed in. It holds a random token, of which the server stores only a hash. It lasts 30 days, and signing out removes it.</li>
<li><code>oms_state</code> is set when you start signing in and removed when you finish, or after 10 minutes. It lets the server check that GitHub’s answer belongs to the sign-in you started, and, when you came from a group’s invite link, holds that address to return you to.</li>
</ul>
<p>Both are kept from scripts (<code>HttpOnly</code>) and travel only over HTTPS. With <code>SameSite=Lax</code>, another site can’t use them in a request of its own. They are sent from elsewhere only when you follow a link here.</p>
<p>Pages run no scripts. Each page is sent with a content policy that forbids scripts, frames, fonts and requests to other sites, with one exception: images from GitHub’s avatar server. There is no analytics code, no advertising and no tracking pixel.</p>`],
    ['others', 'Who else is involved', `<h3>GitHub, to sign in</h3>
<p>On the website you are sent to GitHub to approve the sign-in. On a machine, <code>oms login</code> shows a code that you approve at GitHub. Either way the server only ever receives a token that proves who you are. It comes from a GitHub App with no permissions, so it can’t read your repositories. The server uses it once and doesn’t store it, and <code>oms</code> refuses to send a GitHub token with more access than that.</p>
<h3>GitHub, for avatars</h3>
<p>Pages show avatars straight from GitHub’s avatar server, so your browser asks GitHub for those images. The page tells the browser not to say which page it came from. For the dashboard image, the server fetches the avatar itself, keeps that copy for a day, and draws it in.</p>
<h3>GitHub, for <code>oms</code></h3>
<p>The install scripts download <code>oms</code> from this project’s releases on GitHub. <code>oms</code> reads your repositories through GitHub with your own token, on your machine. When you run <code>oms status</code>, <code>oms sync</code> or <code>oms rankings</code> in a terminal, it checks GitHub for a newer release, up to once a day. Set <code>OMS_NO_UPDATE_CHECK=1</code> to turn that off.</p>
<h3>The price list</h3>
<p>About once a day the server fetches a public price list from GitHub. The request carries nothing about you.</p>
<h3>The host</h3>
<p>The server is built to run on Cloudflare Workers with a D1 database. Run that way, Cloudflare carries every request and holds the database, and like any host it sees the IP address a request comes from.</p>
<p>The server’s own code stores no IP address. To slow down floods, it hands the host’s rate limiter that address, or your account’s id when a signed-in <code>oms</code> calls. When a request fails unexpectedly, it logs the page’s path and the error. This project’s deployment settings also turn on the host’s request logs and traces. What those hold, and for how long, is decided by the host and by whoever runs this server, not by this code.</p>
<p>The server makes no other outside requests, and sends your data to nobody else.</p>`],
    ['groups', 'What joining a group shows', `<p>Joining a group shows its members your GitHub username and your token total for each period its board covers, even while your profile is private. It shows no models, no day-by-day history and no machine names.</p>
<p>A private group is shown to its members only. To anyone else it gives the same answer as a group that doesn’t exist. A public group can be opened by anyone and joined by any signed-in account; people outside it see only the members whose profiles are public.</p>
<p>A group’s name and description are written by its owner and, for a public group, shown to everyone. When you leave a group, your totals stop showing there at once.</p>`],
    ['caching', 'Caching and unpublishing', `<p>Public pages and images are cached for 5 minutes, by the host and by browsers.</p>
<p>When you unpublish or delete your account, everything public about you answers “not found” from then on. The server removes your pages, your images and your sitemap entry from the cache at the location that handled the request. Copies at other locations and in browsers can stay visible for up to five minutes.</p>
<p>Copies that others made are beyond this server’s reach. A search engine’s index, or an image proxy such as the one GitHub uses for READMEs, keeps what it fetched by its own rules.</p>`],
    ['deleting', 'Removing your data', `<h3>A machine</h3>
<p>On your dashboard, under Machines, choose Remove. Its usage, its lifetime figures and its sign-in are deleted from the database at once, and <code>oms</code> on it is signed out at its next sync.</p>
<h3>Your account</h3>
<p>On your dashboard, under Account, choose “Delete my account and data” and type your GitHub username to confirm. Everything this server holds about the account is deleted at once: usage, lifetime figures, GitHub aggregates, machines, sign-ins, your group memberships, the groups you own and the account itself. This can’t be undone.</p>
<h3>What remains</h3>
<p>A cached copy of a public page can show the old numbers for up to five minutes. Each machine keeps its local history, so <code>oms login</code> and <code>oms sync</code> bring your usage back. Signing a machine out with <code>oms logout</code> keeps both its local history and what it uploaded.</p>
<p>This code makes no backups. Whether the host keeps recovery copies of the database, and for how long, is up to the host and to whoever runs this server.</p>`],
    ['sign-ins', 'How long sign-ins last', `<p>A machine’s sign-in expires after 180 days without an upload, and signing in again replaces it. A website sign-in lasts 30 days.</p>
<p>An expired sign-in is refused. A machine’s record of it is removed when the machine signs in again or is removed. A website sign-in’s record, a hash and two dates, is removed when you sign out, and otherwise stays until the account is deleted.</p>`],
    ['questions', 'Changes and questions', `<p>This page describes the code as of the date above. Its history is public, with the rest of the <a href="${REPO_URL}">source</a>.</p>
<p>Whoever runs this server decides how it is hosted. For a question this page leaves open, or a statement that looks wrong, <a href="${ISSUES_URL}">open an issue</a>.</p>`],
  ],
};

const TERMS: ReadingPage = {
  title: 'Terms',
  lead: 'The few rules for using this server, in plain words.',
  description: `The terms for using this ${SITE} server: MIT-licensed software with no warranty, your own real usage only, and publishing by your choice.`,
  updated: '2026-11-18',
  sections: [
    ['software', 'The software', `<p>${SITE} is open source under the <a href="${REPO_URL}/blob/main/LICENSE">MIT license</a>. As the license says, it is provided as is, without warranty of any kind.</p>`],
    ['service', 'This service', `<p>This server is offered the same way: as is, with no promise that it stays up, keeps your data or gets every number right. The numbers are estimates, and <a href="/how-we-count">How we count</a> says where they stop being reliable.</p>
<p>Each machine keeps its own history, so <code>oms login</code> and <code>oms sync</code> can bring your usage back to a server.</p>`],
    ['usage', 'Your usage', `<p>Upload only your own real usage: what your own tools recorded, on your own accounts. Don’t make up or inflate numbers, don’t upload someone else’s usage as yours, and don’t try to get around the limits.</p>
<p>An account can have 50 machines and can change 20,000 rows a day, and requests are rate limited.</p>`],
    ['publishing', 'What you publish', `<p>Your profile is private until you publish it, and publishing is your choice. Once published, anyone can see your profile, embed its images, and find you in the rankings and the sitemap.</p>
<p>You can unpublish at any time. <a href="/privacy#caching">Privacy</a> says how long a copy can remain.</p>
<p>Joining a group is also your choice, and shows your token totals to its members. A public group’s name and description are shown to everyone.</p>`],
    ['removal', 'Removal', `<p>Whoever runs this server may remove an account or a group that abuses the service or the rankings, for example with made-up usage, by flooding the server, or with a group name or description that is not fit to show others.</p>
<p>You can leave at any time: delete your account on your dashboard, and everything on the server is removed.</p>`],
    ['changes', 'Changes', `<p>The service may change or stop, and these terms may change with it. The date above says when they last did.</p>
<p>Questions go to the project’s <a href="${ISSUES_URL}">issue tracker</a>.</p>`],
  ],
};

type Render = (origin: string, viewer: UserRow | null) => string;

/** Each section has its heading beside it, so a long page can be scanned down one edge. */
const readingPage = (page: ReadingPage): Render => (origin, viewer) => {
  const updated = page.updated ? `<p class="muted">Last updated <time datetime="${page.updated}">${page.updated}</time></p>` : '';
  const jumps = page.sections.map(([id, title]) => `<a href="#${id}">${title}</a>`).join('');
  const sections = page.sections.map(([id, title, body]) => `<section id="${id}"><h2>${title}</h2><div>${body}</div></section>`).join('\n');
  return layout(`${page.title} · ${SITE}`, `<div class="page-head"><div><h1>${page.title}</h1><p>${page.lead}</p>${updated}</div></div>
<nav class="filters jump" aria-label="On this page">${jumps}</nav>
<article class="reading">${sections}</article>`, viewer, { origin, description: page.description });
};

/** Every reading page by its address. */
export const READING_PAGES: ReadonlyMap<string, Render> = new Map([
  ['/how-we-count', readingPage(HOW_WE_COUNT)],
  ['/privacy', readingPage(PRIVACY)],
  ['/terms', readingPage(TERMS)],
]);

/** A file for crawlers. The lifetime is the caller's, so the edge cache keeps it like any public page. */
export const crawlerFile = (body: string, type: 'text/plain' | 'application/xml', cacheControl: string) =>
  new Response(body, { headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': cacheControl, 'x-content-type-options': 'nosniff' } });

/** Pages only their owner sees, the agent's API and the sign-in steps are of no use to a search engine. */
export const robotsTxt = (origin: string) => `User-agent: *
Disallow: /me
Disallow: /v1/
Disallow: /login
Disallow: /auth/

Sitemap: ${origin}/sitemap.xml
`;

const INDEXED_PATHS = ['/', '/rankings', '/rankings/providers', '/rankings/models', '/groups', ...READING_PAGES.keys()];
/** One sitemap file may list 50,000 addresses. This keeps the file, and the query behind it, small. */
const SITEMAP_PROFILES = 5000;
/** What a profile's address accepts. An account whose login passed to someone else has no address until it signs in again. */
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

/** The logins of public profiles, for the sitemap. A private profile is never among them. */
export async function publicLogins(db: Db): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT login FROM users WHERE is_public = 1 ORDER BY login COLLATE NOCASE LIMIT ?')
    .bind(SITEMAP_PROFILES)
    .all<{ login: string }>();
  return results.map((row) => row.login).filter((login) => LOGIN.test(login));
}

export function sitemapXml(origin: string, logins: string[]): string {
  const addresses = [...INDEXED_PATHS.map((path) => `${origin}${path}`), ...logins.map((login) => `${origin}/u/${encodeURIComponent(login)}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${addresses.map((address) => `<url><loc>${esc(address)}</loc></url>`).join('\n')}
</urlset>
`;
}
