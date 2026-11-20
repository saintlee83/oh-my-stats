import type { Card } from '../shared/render/cards.ts';
import type { ComponentKey } from '../shared/render/svg.ts';
import { commas, compact, money, percent, PROVIDERS, providerName } from '../shared/format.ts';
import { providerMix } from '../shared/insights.ts';
import type { TokenMetrics } from '../shared/metrics.ts';
import { tokenMix, usageCalendar, usagePeriods, type CalendarDay, type CalendarView, type UsagePeriod } from '../shared/usage.ts';
import type { UserRow } from './db.ts';
import type { PublicPosition, RankingPeriod, Standing } from './rankings.ts';
import { STYLE } from './style.ts';

/** Server-rendered pages. Every value from a user or machine goes through `esc`. */

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

export const REPO_URL = 'https://github.com/saintlee83/oh-my-stats';
const HOSTED_ORIGIN = 'https://ohmystats.dev';
export const SITE = 'oh-my-stats';
const DESCRIPTION = 'Your AI tokens and GitHub contributions in one place, from every machine, with private work included.';
const AVATARS = 'https://avatars.githubusercontent.com';

export const GITHUB_MARK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>';

/** A GitHub avatar at twice the size it's drawn, for sharp screens. The page may load images from nowhere else. */
export function avatar(url: string | null, size: number): string {
  if (!url) return '';
  try {
    const sized = new URL(url);
    if (sized.protocol !== 'https:' || sized.origin !== AVATARS) return '';
    sized.searchParams.set('s', String(size * 2));
    return `<img src="${esc(sized)}" alt="" width="${size}" height="${size}">`;
  } catch {
    return '';
  }
}

/**
 * What a page says about itself. A page worth sharing gives the address it's served from, and
 * gets the preview image: sites that show link previews only follow a full address.
 */
export interface PageOptions {
  description?: string;
  bleed?: boolean;
  dashboard?: boolean;
  origin?: string;
  /** A preview image of the page's own, by its full address, in place of the site's banner. */
  image?: { url: string; width: number; height: number; alt: string };
}

/**
 * The frame every page shares: the head, the header and the footer around a body. A page that
 * gives no address is one only its owner sees, or an error, so search engines are asked to leave it out.
 */
export function layout(title: string, body: string, viewer: UserRow | null, page: PageOptions = {}): string {
  const description = esc(page.description ?? DESCRIPTION);
  const image = page.image
    ?? (page.origin ? { url: `${page.origin}/og.png`, width: 2400, height: 1260, alt: `${SITE}. Your real developer stats, from every machine.` } : null);
  const preview = image
    ? `<meta property="og:image" content="${esc(image.url)}">
<meta property="og:image:width" content="${image.width}">
<meta property="og:image:height" content="${image.height}">
<meta property="og:image:alt" content="${esc(image.alt)}">
<meta name="twitter:card" content="summary_large_image">`
    : '<meta name="twitter:card" content="summary">';
  const account = viewer
    ? `<a class="button" href="/me">${avatar(viewer.avatar_url, 20)}@${esc(viewer.login)}</a>`
    : '<a class="button" href="/login">Sign in</a>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${description}">
${page.origin ? '' : '<meta name="robots" content="noindex">\n'}<meta property="og:site_name" content="${SITE}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${description}">
${preview}
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${STYLE}</style>
${page.dashboard ? '<link rel="stylesheet" href="/dashboard.css"><script src="/dashboard.js" defer></script>' : ''}
</head>
<body${page.dashboard ? ' class="workspace"' : ''}>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="bar"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="26" height="26">${SITE}</a><nav class="links" aria-label="Main navigation"><a href="/rankings">Rankings</a><a href="/groups">Groups</a>${account}</nav></div></header>
<main id="main"${page.bleed ? ' class="bleed"' : ''}>${body}</main>
<footer class="bottom"><div class="bar"><p>${SITE} is open source, under the MIT license.</p><nav aria-label="Footer"><a href="/rankings">Rankings</a><a href="/how-we-count">How we count</a><a href="${REPO_URL}#get-started">Install</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${REPO_URL}">GitHub</a></nav></div></footer>
</body>
</html>
`;
}

/**
 * A number in a table: the short figure to scan, and the exact one beneath it when they differ.
 * A phone has room for one column of numbers, so `narrow` is what it shows beneath instead:
 * the figure of a column it leaves out.
 */
export const figure = (short: string, exact = short, narrow = '') =>
  `<strong>${short}</strong>${narrow && `<small class="narrow">${narrow}</small>`}${short === exact ? '' : `<small>${exact}</small>`}`;

/** A cost as its short figure and its exact one. Under a cent, the amount itself would read as nothing. */
export const costFigures = (cost: number): [short: string, exact: string] =>
  cost < 0.005 ? ['&lt;$0.01', '&lt;$0.01'] : [money(cost), `$${cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`];

/** What a list of profiles can show beyond their logins: the viewer's own row, names, and a cost that leads the tokens. */
export interface ProfileRows {
  viewer: string | null;
  /** Shows a row's `name` above its login, when it has one. */
  names?: boolean;
  /** The heading of a column for each row's `cost`. The list is then measured by cost. */
  cost?: string;
}

/** A cost, then the tokens it is for. On a phone the tokens go under the cost, and their own column is left out. */
const costCells = (cost: number, tokens: number) =>
  `<td class="num">${figure(...costFigures(cost), `${compact(tokens)} ${tokens === 1 ? 'token' : 'tokens'}`)}</td><td class="num wide">${figure(compact(tokens), commas(tokens))}</td>`;

/**
 * A ranked list. Totals span orders of magnitude, so each row has the short figure to
 * scan, the exact one beneath it, and a bar comparing it with the leader.
 */
export function standings(
  rows: (Standing & { name?: string | null; cost?: number })[],
  column: string,
  tokenColumn: string,
  profiles: ProfileRows | null = null,
): string {
  if (!rows.length) return '<p>No token usage for this period.</p>';
  const byCost = profiles?.cost !== undefined;
  const score = (row: (typeof rows)[number]) => (byCost ? row.cost ?? 0 : row.tokens);
  const most = score(rows[0]);
  const body = rows.map((row) => {
    const mine = profiles?.viewer?.toLowerCase() === row.label.toLowerCase();
    const login = esc(encodeURIComponent(row.label));
    const handle = `@${esc(row.label)}`;
    const who = profiles
      ? `<a href="/u/${login}"><img src="${AVATARS}/${login}?s=56" alt="" width="28" height="28" loading="lazy">${profiles.names && row.name ? `<span><b>${esc(row.name)}</b><small>${handle}</small></span>` : handle}</a>${mine ? '<span class="badge">You</span>' : ''}`
      : esc(row.label);
    return `<tr${mine ? ' class="me"' : ''}><td class="rank"><span class="place"${profiles && row.rank <= 3 ? ` data-place="${row.rank}"` : ''}>${row.rank}</span></td><td class="who">${who}</td>
<td class="meter" aria-hidden="true"><span style="--share:${((100 * score(row)) / most).toFixed(1)}%"></span></td>
${byCost ? costCells(row.cost ?? 0, row.tokens) : `<td class="num">${figure(compact(row.tokens), commas(row.tokens))}</td>`}</tr>`;
  }).join('');
  const heads = byCost ? `<th class="num">${profiles?.cost}</th><th class="num wide">${tokenColumn}</th>` : `<th class="num">${tokenColumn}</th>`;
  return `<div class="table"><table class="standings"><thead><tr><th class="rank">Rank</th><th>${column}</th><td class="meter" aria-hidden="true"></td>${heads}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export const periodLabel = (days: RankingPeriod['days']) =>
  days === 'all' ? 'All time' : days === 'month' ? 'This month' : days === 'last-month' ? 'Last month' : `Last ${days} days`;

/** The heading of a board's token column, which says what stretch the tokens are from. */
export const tokenColumnLabel = (days: RankingPeriod['days']) =>
  days === 'all' ? 'Lifetime tokens' : typeof days === 'number' ? `Tokens (${days} days)` : `Tokens (${periodLabel(days).toLowerCase()})`;

export const profileCount = (count: number) => `${commas(count)} ranked public ${count === 1 ? 'profile' : 'profiles'}`;

/** The same steps on every system but the first, so the reader picks theirs once. */
export function installCommands(origin: string): string {
  const login = `oms login${origin === HOSTED_ORIGIN ? '' : ` --server ${origin}`}`;
  const pane = (install: string) => `<pre><code>${esc(`${install}\n${login}\noms service install`)}</code></pre>`;
  return `<div class="terminal" role="group" aria-label="Install commands">
<input type="radio" name="os" id="os-unix" checked><label for="os-unix">macOS and Linux</label>
<input type="radio" name="os" id="os-windows"><label for="os-windows">Windows</label>
${pane(`curl -fsSL ${origin}/install.sh | sh`)}${pane(`irm ${origin}/install.ps1 | iex`)}
</div>`;
}

export const GITHUB_SETUP = `<details class="github-setup">
<summary>Add GitHub contribution stats (optional)</summary>
<p><code>oms login</code> is enough to sync AI usage. To include commits and other repository activity, set up the <a href="https://cli.github.com/">GitHub CLI</a> on one machine.</p>
<ol>
  <li>Run <code>gh auth status</code> to check the active GitHub account. If you need to sign in, run <code>gh auth login</code> with the account you use for OMS.</li>
  <li>Run <code>oms sync --github</code> to update your contribution stats now. <code>oms</code> uses the repository token on this machine to read from GitHub.</li>
  <li>If the sync reports that your GitHub CLI login is missing <code>repo</code> or <code>read:org</code>, run <code>gh auth refresh -s repo,read:org</code>, approve the request, and retry the sync. The <code>repo</code> scope includes read and write access to repositories you can access. OMS uses it to read activity. The <code>read:org</code> scope allows reading organization and team membership.</li>
</ol>
</details>`;

/**
 * The logo's motif behind the landing page's heading: contribution squares that rise like
 * bar charts toward both edges, leaving the middle clear for the words. Each bar is one
 * shape filled with a pattern of squares, so the whole drawing stays small.
 */
const HERO_ART = (() => {
  const columns = 64;
  const rows = 7;
  const pitch = 26;
  const cell = 20;
  const width = columns * pitch - (pitch - cell);
  const height = rows * pitch - (pitch - cell);
  const wobble = [0.3, -0.6, 0.1, 0.7, -0.3, 0.5, -0.7, 0.2];
  const bars: string[] = ['', '', '', '', ''];
  let newest = { size: 0, column: 0 };
  for (let column = 0; column < columns; column++) {
    const fromCenter = Math.abs(column - (columns - 1) / 2) / ((columns - 1) / 2);
    if (fromCenter < 0.4) continue;
    const x = column * pitch;
    const size = Math.max(0, Math.min(rows, Math.round(((fromCenter - 0.4) / 0.6) ** 0.9 * 6.2 + wobble[(column * 5) % wobble.length])));
    if (size === 0) continue;
    // The newest square is on the right, as it is in the logo, where the drawing is at full strength.
    if (column > columns * 0.8 && column < columns * 0.88 && size >= newest.size) newest = { size, column };
    const top = (rows - size) * pitch;
    bars[Math.ceil((size / rows) * 4)] += `M${x} ${top}h${cell}v${height - top}h-${cell}z`;
  }
  const pattern = (id: string, color: string) =>
    `<pattern id="oms-${id}" width="${pitch}" height="${pitch}" patternUnits="userSpaceOnUse"><rect width="${cell}" height="${cell}" rx="5" fill="var(--${color})"/></pattern>`;
  const levels = [1, 2, 3, 4].map(level => `<path d="${bars[level]}" fill="url(#oms-g${level})"/>`).join('');
  const lit = `<rect x="${newest.column * pitch}" y="${(rows - newest.size) * pitch}" width="${cell}" height="${cell}" rx="5" fill="var(--spark)"/>`;
  return `<svg class="hero-art" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><defs>${[1, 2, 3, 4].map(level => pattern(`g${level}`, `g${level}`)).join('')}</defs>${levels}${lit}</svg>`;
})();

const FEATURES: [icon: string, title: string, text: string][] = [
  ['<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 'Always recording',
    '<code>oms</code> records usage in the background as you work, and keeps its own record, so your history survives when AI tools delete their logs.'],
  ['<rect x="2.5" y="5" width="13" height="9.5" rx="1.5"/><path d="M1 18h12"/><rect x="16.5" y="8.5" width="5" height="10.5" rx="1.2"/>', 'Every machine, counted once',
    'Sign in on each computer. Per-machine logs are added together, and an account-wide total is counted a single time.'],
  ['<circle cx="12" cy="12" r="3.5"/><path d="M2.5 12h6M15.5 12h6"/>', 'Private work included',
    'GitHub’s contribution API hides private work, so commits are counted by walking each repository, on your own machine.'],
  ['<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>', 'Private by default',
    'Your profile stays hidden until you publish it. Machine names are never public.'],
  ['<path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5"/>', 'Made for your README',
    'Embed the whole dashboard, or only the parts you want, as images that follow light and dark mode.'],
  ['<path d="M5 20v-8M12 20V4M19 20v-5"/>', 'Rankings',
    'See where you stand among published profiles, and compare your own devices and providers.'],
];

const UPLOADED = [
  'Tokens per day and model', 'Lifetime totals per tool and model', 'Aggregated GitHub numbers, such as commits per month and lines per language',
  'Your public GitHub profile: name, bio, company, location and status', 'Each machine’s name and platform, shown only to you', 'Your timezone',
];
const KEPT = ['Prompts, responses and code', 'Commit messages and file paths', 'Private repository and organization names', 'The token that reads your repositories'];

const STEPS: [title: string, text: string][] = [
  ['Read on your machine',
    'Run <code>oms</code> on each computer. It reads the usage records your AI tools already keep there. One computer with GitHub access also walks your repositories, and that access never leaves it.'],
  ['Only totals are uploaded',
    'Tokens per day and model, and aggregated GitHub numbers. Prompts, code, commit messages and private repository names stay where they are.'],
  ['You see it where you choose',
    'First on a dashboard only you can open. Publish it for a profile page, a place in the rankings, and images to embed in your README.'],
];

const QUESTIONS: [question: string, answer: string][] = [
  ['Is anything public by default?',
    'No. Your profile stays hidden until you publish it, and a private profile looks the same as one that doesn’t exist. Publishing shows your totals per model and per day, and lists you in the public rankings. Machine names are never public.'],
  ['What does <code>oms</code> read, and what does it send?',
    'It reads the usage records your AI tools keep on that machine, and your GitHub repositories with a token that stays there. It sends totals: tokens per day and model, each tool’s lifetime total, aggregated GitHub numbers, your public GitHub profile, your timezone, and the machine’s name and platform, which only you see. Run <code>oms preview</code> to see exactly what would be uploaded, without sending anything.'],
  ['What can this server do with my GitHub sign-in?',
    'Only tell who you are. The token it receives comes from a GitHub App with no permissions, so it can’t read your repositories. The server uses it once and doesn’t store it.'],
  ['How is cost estimated?',
    'At public API list prices. It is what the usage would cost through the API, not what you paid. Tokens without a known model or price are left out, so the figure is then shown as a minimum. <a href="/how-we-count#cost">How we count</a> has the rest.'],
  ['What if I use several machines?',
    'Sign in on each one. Per-machine figures and logs are added together, and an account-wide total, such as Codex’s, is counted once. A machine’s id comes from its hardware, so reinstalling doesn’t register it twice.'],
  ['How often do the numbers update?',
    '<code>oms</code> reads new log lines every 5 minutes and uploads once a day, so your numbers can be up to a day behind. Run <code>oms sync</code> to update right away. Public pages are cached for 5 minutes.'],
  ['How do I delete everything?',
    'On your dashboard. Removing a machine deletes its data and signs it out. Deleting your account removes everything on the server, after you confirm with your username. Each machine keeps its local history, so signing in again brings your usage back. <a href="/privacy#deleting">Privacy</a> has the details.'],
  ['Can I run my own server?',
    `Yes. The server is a single Cloudflare Worker with a D1 database, and has no runtime dependencies. <a href="${REPO_URL}#run-your-own-server">The README</a> has the steps, and how to sign your machines in to it.`],
];

/** What the landing page shows of the public rankings. */
export interface LandingBoard {
  leaders: Standing[];
  participants: number;
  /** What every ranked profile has used together, all time. */
  tokens: number;
}

/** With fewer ranked profiles, their count and total describe those few people rather than the site. */
const FIGURES_FROM = 3;

/** A quiet line of numbers under the heading. How many tools the agent reads is true of any server, so it always shows. */
function figures(board: LandingBoard): string {
  const ranked = board.participants >= FIGURES_FROM
    ? [[commas(board.participants), 'ranked public profiles'], [compact(board.tokens), 'AI tokens between them, all time']]
    : [];
  const items = [...ranked, [String(PROVIDERS.size), 'AI tools read automatically']];
  return `<ul class="tally wrap">${items.map(([value, label]) => `<li><strong>${value}</strong> <span>${label}</span></li>`).join('')}</ul>`;
}

export function landingPage(origin: string, viewer: UserRow | null, board: LandingBoard = { leaders: [], participants: 0, tokens: 0 }): string {
  const start = viewer
    ? '<a class="button primary lg" href="/me">Go to your dashboard</a>'
    : `<a class="button primary lg" href="/login">${GITHUB_MARK}Sign in with GitHub</a>`;
  const list = (items: string[]) => `<ul>${items.map(item => `<li>${item}</li>`).join('')}</ul>`;
  const [leader] = board.leaders;
  const login = leader ? esc(encodeURIComponent(leader.label)) : '';
  const showcase = leader
    ? `<section class="section wrap">
<div class="section-head"><h2>A dashboard built from real work</h2><p>Live from the rankings: <a href="/u/${login}">@${esc(leader.label)}</a>, first by lifetime AI tokens.</p></div>
<a class="showcase" href="/u/${login}"><img src="/u/${login}/dashboard.svg" alt="The developer dashboard of @${esc(leader.label)}" loading="lazy"></a>
</section>`
    : '';
  const leaders = leader
    ? `<section class="section wrap">
<div class="section-head"><h2>Top of the rankings</h2><p>${profileCount(board.participants)}, by lifetime AI tokens. Publish your profile to appear here.</p></div>
<div class="panel">${standings(board.leaders, 'GitHub user', 'Lifetime tokens', { viewer: viewer?.login ?? null })}</div>
<p><a href="/rankings">See all rankings</a></p>
</section>`
    : '';
  return layout(`${SITE} · Your real developer stats, from every machine`, `<section class="hero">${HERO_ART}<div class="wrap">
<p class="eyebrow">Open source · macOS, Linux and Windows</p>
<h1>Your real developer stats,<br> from every machine.</h1>
<p class="lead">Sign in with GitHub, run <code>oms</code> on each computer, and see your AI tokens and contributions in one place, with private work included.</p>
<div class="actions">${start}<a class="button lg" href="/rankings">See the rankings</a></div>
${installCommands(origin)}
<p class="muted"><code>oms</code> records usage continuously and uploads once a day. Run <code>oms sync</code> to update right away.</p>
${GITHUB_SETUP}
</div></section>
${figures(board)}
${showcase}
<section class="section wrap">
<div class="section-head"><h2>How it works</h2><p>The counting happens on your machines. The server adds up what they send.</p></div>
<ol class="steps">${STEPS.map(([title, text]) => `<li><h3>${title}</h3><p>${text}</p></li>`).join('')}</ol>
</section>
<section class="section wrap">
<div class="section-head"><h2>Numbers you can stand behind</h2><p>Collected on your machines, combined on the server, and shown only where you choose.</p></div>
<div class="grid">${FEATURES.map(([icon, title, text]) => `<div class="feature"><div class="icon"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></div><h3>${title}</h3><p>${text}</p></div>`).join('')}</div>
</section>
<section class="section wrap">
<div class="section-head"><h2>Reads the tools you already use</h2><p><code>oms</code> finds these histories on its own. Any other tool can be added with a JSONL export.</p></div>
<ul class="chips">${[...PROVIDERS.values()].map(name => `<li>${esc(name)}</li>`).join('')}</ul>
</section>
<section class="section wrap">
<div class="section-head"><h2>What leaves your machine</h2><p>Only totals. Run <code>oms preview</code> to see exactly what would be uploaded, without sending anything.</p></div>
<div class="grid"><div class="panel ledger"><h3>Uploaded</h3>${list(UPLOADED)}</div><div class="panel ledger kept"><h3>Stays on your machine</h3>${list(KEPT)}</div></div>
</section>
${leaders}
<section class="section wrap questions">
<div class="section-head"><h2>Questions</h2><p>Short answers. <a href="/how-we-count">How we count</a> and <a href="/privacy">Privacy</a> have the long ones.</p></div>
<div class="panel faq">${QUESTIONS.map(([question, answer]) => `<details><summary>${question}</summary><p>${answer}</p></details>`).join('')}</div>
</section>
<div class="wrap"><section class="cta"><h2>Start counting</h2><p>Install <code>oms</code>, sign in with GitHub, and run <code>oms sync</code> to see your first numbers.</p>
<div class="actions">${start}<a class="button lg" href="${REPO_URL}#get-started">Read the guide</a></div></section></div>`,
    viewer,
    { bleed: true, origin },
  );
}

export type Part = { key: ComponentKey; label: string };

/**
 * The whole dashboard as one image, then each part on its own for a README that wants only
 * some, then the two small images for one that has no room for either.
 */
export function embedCode(url: string, parts: Part[]): string {
  const dashboard = `<pre><code>${esc(`![Developer stats](${url}/dashboard.svg)`)}</code></pre>`;
  if (parts.length === 0) return dashboard;
  // A blank line puts each image in its own paragraph, so GitHub spaces them evenly.
  const lines = parts.map((part) => `![${part.label}](${url}/components/${part.key}.svg)`).join('\n\n');
  const small = `![Developer stats](${url}/card.svg)\n\n![Token ranking](${url}/ranking.svg)\n\n![AI tokens](${url}/badge.svg)`;
  return `${dashboard}
  <p>Or pick the parts you want, in any order:</p>
  <pre><code>${esc(lines)}</code></pre>
  <p>For a smaller embed, choose a stats card, a token ranking card, or a badge.</p>
  <pre><code>${esc(small)}</code></pre>
  <p class="muted">The card adds a calendar of the last 26 weeks with <code>?graph=1</code>. The badge shows another figure with <code>?metric=cost</code>, <code>rank</code>, <code>contributions</code> or <code>streak</code>.</p>
  <p class="muted">For Tokyo Night colors, add <code>?theme=tokyo-night</code> to any image address. The badge keeps its own colors.</p>`;
}

export function providerActivity(tokens: TokenMetrics | null): string {
  if (!tokens) return '';
  const rows = tokens.tools.map(({ tool, activity: a }) => `<tr><td>${esc(providerName(tool))}</td>
    <td class="num">${compact(a.last7)}</td><td class="num">${compact(a.previous7)}</td>
    <td class="num">${a.activeDays30}</td><td class="num">${commas(a.responses30)}</td>
    <td class="num">${a.tokensPerResponse30 === null ? '—' : compact(a.tokensPerResponse30)}</td></tr>`).join('');
  return `<section class="panel"><h2>Provider activity</h2>
    <div class="table"><table><thead><tr><th>Provider</th><th class="num">Tokens · last 7d</th><th class="num">Tokens · prior 7d</th>
    <th class="num">Active days · 30d</th><th class="num">Responses · 30d</th><th class="num">Tokens / response · 30d</th></tr></thead>
    <tbody>${rows}</tbody></table></div><p class="muted">Response counts and averages use responses recorded by your synced machines.</p></section>`;
}

/**
 * Panes switched without scripts: a radio for each, then their labels, then the panes. The
 * stylesheet pairs the nth radio with the nth label and the nth pane, for five at most.
 */
function tabbedPanel(name: string, title: string, panes: { key: string; label: string; body: string }[], id = ''): string {
  const anchor = id ? ` id="${id}"` : '';
  if (panes.length === 1) return `<section class="panel"${anchor}><h2>${title}</h2><div>${panes[0].body}</div></section>`;
  const radios = panes.map(({ key }, index) => `<input type="radio" name="${name}" id="${name}-${key}"${index ? '' : ' checked'}>`).join('');
  const labels = panes.map(({ key, label }) => `<label for="${name}-${key}" data-label="${label}">${label}</label>`).join('');
  return `<section class="panel panes"${anchor} role="group" aria-label="${title}">${radios}
<header class="panel-head"><h2>${title}</h2><span class="segments">${labels}</span></header>
${panes.map(({ body }) => `<div class="pane">${body}</div>`).join('\n')}</section>`;
}

const dayCount = (count: number) => `${commas(count)} ${count === 1 ? 'day' : 'days'}`;

const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '', ''].map(label => (label ? `<small aria-hidden="true">${label}</small>` : '<span></span>')).join('');
const SCALE = `<p class="scale" aria-hidden="true"><small>Less</small>${[0, 1, 2, 3, 4].map(level => `<span class="day"${level ? ` data-level="${level}"` : ''}></span>`).join('')}<small>More</small></p>`;

function dayDetails({ date, total, byTool }: CalendarDay): string {
  const tools = Object.entries(byTool).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  const list = tools.map(([tool, count]) => `<li>${esc(providerName(tool))} · ${commas(count)}</li>`).join('');
  return `<section popover class="day-details" id="day-${date}" aria-label="AI usage on ${date}"><h2>${date}</h2><p>${commas(total)} tokens</p>${list ? `<ul>${list}</ul>` : ''}<button popovertarget="day-${date}" popovertargetaction="hide">Close</button></section>`;
}

/**
 * One view of the calendar, weeks as columns. Only the newest view opens its days: a
 * breakdown for every day of every year would outweigh the rest of the page, so the
 * others say their total in a tooltip.
 */
function calendarPane(view: CalendarView, opens: boolean): string {
  const cell = (day: CalendarDay | null) => {
    if (!day) return '<span></span>';
    const label = `${day.date} · ${commas(day.total)} tokens`;
    return opens && day.total
      ? `<button class="day" popovertarget="day-${day.date}" data-level="${day.level}" aria-label="${label}" title="${label}"></button>`
      : `<span class="day"${day.level ? ` data-level="${day.level}"` : ''} title="${label}"></span>`;
  };
  const weeks = view.weeks.map(({ month, days }) => `${month ? `<small aria-hidden="true">${month}</small>` : '<span></span>'}${days.map(cell).join('')}`).join('\n');
  const opened = opens ? view.weeks.flatMap(week => week.days).filter(day => day !== null).filter(day => day.total > 0) : [];
  // Each day that opens is a stop for the Tab key, so a keyboard gets a way past them.
  const hint = opened.length ? ' · Select a day for its providers. <a class="sr" href="#periods">Skip the calendar</a>' : '';
  const summary = view.total ? `${compact(view.total)} tokens on ${dayCount(view.activeDays)}${hint}` : 'No dated usage.';
  return `<p class="muted">${view.start} – ${view.end} · ${summary}</p>
<div class="weeks-scroll${opens ? ' newest' : ''}"><div class="weeks-fit"><div class="weeks">${WEEKDAY_LABELS}
${weeks}</div>${SCALE}</div></div>${opened.map(dayDetails).join('\n')}`;
}

function periodPane(period: UsagePeriod, undated: number): string {
  const figure = (label: string, value: string, detail: string) => `<div class="figure"><span>${label}</span><strong>${value}</strong><span>${detail}</span></div>`;
  const short = compact(period.total);
  const exact = commas(period.total);
  const { range, top, busiest, firstDay } = period;
  // Lifetime has no number of days to be active out of, so it says when its days began.
  const outOf = range ? `of ${dayCount(range.days)}${period.key === 'month' ? ' so far' : ''}` : firstDay ? `since ${firstDay}` : 'No dated usage';
  const figures = [
    figure('Tokens', short, short === exact ? '' : exact),
    figure('Active days', commas(period.activeDays), outOf),
    figure('Most used provider', top ? esc(providerName(top.tool)) : '—', top ? `${percent(top.share)} of tokens` : 'No usage'),
    figure('Busiest day', busiest?.date ?? '—', busiest ? `${compact(busiest.total)} tokens` : 'No dated usage'),
  ];
  const note = range
    ? `${range.start} – ${range.end}`
    : undated > 0
      ? `Includes ${compact(undated)} tokens from before a tool’s daily records begin. They have no date, so the calendar and the other periods leave them out.`
      : 'Everything counted so far.';
  return `<div class="figures">${figures.join('')}</div><p class="muted">${note}</p>`;
}

/** A thin bar for the split at a glance, above a table that names each part and gives its figures. */
function tokenMixPanel(tokens: TokenMetrics): string {
  const { known, parts } = tokenMix(tokens);
  if (!known) return '<section class="panel"><h2>Token mix</h2><p>No tokens with a known breakdown yet.</p></section>';
  const bar = parts.filter(part => part.tokens > 0)
    .map(({ key, label, share }) => `<span style="flex-grow:${(share * 100).toFixed(2)};background:var(--${key})" title="${label} · ${percent(share)}"></span>`).join('');
  const rows = parts.map(({ key, label, tokens: count, share }) =>
    `<tr><td><i style="background:var(--${key})"></i>${label}</td><td class="num">${percent(share)}</td><td class="num">${commas(count)}</td></tr>`).join('');
  return `<section class="panel mix"><h2>Token mix</h2>
    <p class="muted">Covers tokens with a known breakdown: ${compact(known)} of ${compact(tokens.total)} lifetime tokens.</p>
    <div class="mix-bar" role="img" aria-label="${parts.map(part => `${part.label} ${percent(part.share)}`).join(', ')}">${bar}</div>
    <div class="table"><table><thead><tr><th>Kind</th><th class="num">Share</th><th class="num">Tokens</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

export function activityPanels(tokens: TokenMetrics | null, calendars?: CalendarView[]): string {
  if (!tokens) return '';
  const calendar = (calendars ?? usageCalendar(tokens)).map((view, index) => ({ key: view.key, label: view.label, body: calendarPane(view, index === 0) }));
  const periods = usagePeriods(tokens).map(period => ({ key: period.key, label: period.label, body: periodPane(period, tokens.undated) }));
  const mix = providerMix(tokens);
  const shareLabel = (value: number | null) => value === null ? '—' : percent(value);
  const rows = mix.rows.map(({ tool, share, priorShare }) => {
    const delta = share === null || priorShare === null ? null : (share - priorShare) * 100;
    return `<tr><td>${esc(providerName(tool))}</td><td class="num">${shareLabel(priorShare)}</td><td class="num">${shareLabel(share)}</td>
      <td class="num">${delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} pp`}</td></tr>`;
  }).join('');
  return `${tabbedPanel('range', 'AI usage calendar', calendar)}
${tabbedPanel('period', 'Usage by period', periods, 'periods')}
<div class="activity-panels">${tokenMixPanel(tokens)}
    <section class="panel"><h2>Provider share of tokens</h2><p class="muted">Previous month and month to date through ${mix.today}.</p>
    ${rows ? `<div class="table"><table><thead><tr><th>Provider</th><th class="num">${mix.previousMonth}</th><th class="num">${mix.today.slice(0, 7)}</th><th class="num">Change</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>No dated usage in either month.</p>'}
    </section></div>`;
}

export function profilePage(
  user: UserRow,
  svg: string,
  tokens: TokenMetrics | null,
  cards: Card[],
  parts: Part[],
  origin: string,
  viewer: UserRow | null,
  position: PublicPosition | null = null,
  image?: PageOptions['image'],
): string {
  const url = `${origin}/u/${encodeURIComponent(user.login)}`;
  const login = esc(encodeURIComponent(user.login));
  const standing = position?.rank
    ? `<p><a class="badge" href="/rankings">#${position.rank} of ${profileCount(position.participants)}, by lifetime AI tokens</a></p>`
    : '';
  const cardLinks = cards
    .map((card) => `<li><a href="/u/${login}/cards/${esc(card.key)}.txt">${esc(card.title)}</a></li>`)
    .join('');
  const mine = viewer?.id === user.id;
  const since = new Date(user.created_at);
  const joined = Number.isNaN(since.getTime()) ? '' : `Joined ${since.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
  const about = [user.name ? esc(user.name) : '', joined].filter(Boolean).join(' · ');
  // A GitHub login is not an X handle, so the text names the profile without an @.
  const share = `https://x.com/intent/post?text=${encodeURIComponent(`${mine ? 'My' : `${user.login}’s`} developer stats on ${SITE}`)}&url=${encodeURIComponent(url)}`;
  return layout(
    `@${user.login} on ${SITE}`,
    `<div class="profile">${avatar(user.avatar_url, 64)}<div><h1>@${esc(user.login)}</h1>${about ? `<p>${about}</p>` : ''}${standing}</div>
<div class="actions">${mine ? '<a class="button" href="/me#profile-header">Edit profile</a>' : ''}<a class="button" href="https://github.com/${login}" rel="noopener">${GITHUB_MARK}GitHub</a><a class="button" href="#embed">Embed</a><a class="button" href="${esc(share)}" rel="noopener" title="Share on X">Share</a></div></div>
<div class="dash">${svg}</div>
${activityPanels(tokens)}
${providerActivity(tokens)}
<div class="panel" id="embed">
  <h2>Add this to your GitHub profile</h2>
  ${embedCode(url, parts)}
  ${cards.length ? `<h2>Text cards</h2><ul>${cardLinks}</ul>` : ''}
</div>`,
    viewer,
    { origin, image, description: `The developer stats of @${user.login}: AI tokens and GitHub contributions, counted across every machine.` },
  );
}

export function errorPage(status: number, message: string, viewer: UserRow | null): string {
  return layout(`${status} · ${SITE}`, `<div class="notice"><p class="code">${status}</p><h1>${esc(message)}</h1>
<div class="actions"><a class="button" href="/">Back to the home page</a></div></div>`, viewer);
}
