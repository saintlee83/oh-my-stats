import type { Card } from '../shared/render/cards.ts';
import type { ComponentKey } from '../shared/render/svg.ts';
import { commas, compact, money, percent, PROVIDERS, providerName } from '../shared/format.ts';
import { providerMix } from '../shared/insights.ts';
import type { GitHubProfile, TokenMetrics } from '../shared/metrics.ts';
import { PROFILE_LIMITS, STATUS_CHOICES, type ManualProfile } from '../shared/profile.ts';
import type { MachineRow, UserRow } from './db.ts';
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
  origin?: string;
  /** A preview image of the page's own, by its full address, in place of the site's banner. */
  image?: { url: string; width: number; height: number; alt: string };
}

/** The frame every page shares: the head, the header and the footer around a body. */
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
<meta property="og:site_name" content="${SITE}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${description}">
${preview}
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${STYLE}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="bar"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="26" height="26">${SITE}</a><nav class="links" aria-label="Main navigation"><a href="/rankings">Rankings</a>${account}</nav></div></header>
<main id="main"${page.bleed ? ' class="bleed"' : ''}>${body}</main>
<footer class="bottom"><div class="bar"><p>${SITE} is open source, under the MIT license.</p><nav aria-label="Footer"><a href="/rankings">Rankings</a><a href="${REPO_URL}#get-started">Install</a><a href="${REPO_URL}#what-leaves-your-machine">Privacy</a><a href="${REPO_URL}">GitHub</a></nav></div></footer>
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
    'A background agent records usage as you work and keeps its own record, so your history survives when AI tools delete their logs.'],
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

/** What the landing page shows of the public rankings. */
export interface LandingBoard {
  leaders: Standing[];
  participants: number;
}

export function landingPage(origin: string, viewer: UserRow | null, board: LandingBoard = { leaders: [], participants: 0 }): string {
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
<p class="lead">Sign in with GitHub, run a small agent on each computer, and see your AI tokens and contributions in one place, with private work included.</p>
<div class="actions">${start}<a class="button lg" href="/rankings">See the rankings</a></div>
${installCommands(origin)}
<p class="muted">The agent records usage continuously and uploads once a day. Run <code>oms sync</code> to update right away.</p>
</div></section>
${showcase}
<section class="section wrap">
<div class="section-head"><h2>Numbers you can stand behind</h2><p>Collected on your machines, combined on the server, and shown only where you choose.</p></div>
<div class="grid">${FEATURES.map(([icon, title, text]) => `<div class="feature"><div class="icon"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></div><h3>${title}</h3><p>${text}</p></div>`).join('')}</div>
</section>
<section class="section wrap">
<div class="section-head"><h2>Reads the tools you already use</h2><p>The agent finds these histories on its own. Any other tool can be added with a JSONL export.</p></div>
<ul class="chips">${[...PROVIDERS.values()].map(name => `<li>${esc(name)}</li>`).join('')}</ul>
</section>
<section class="section wrap">
<div class="section-head"><h2>What leaves your machine</h2><p>Only totals. Run <code>oms preview</code> to see exactly what would be uploaded, without sending anything.</p></div>
<div class="grid"><div class="panel ledger"><h3>Uploaded</h3>${list(UPLOADED)}</div><div class="panel ledger kept"><h3>Stays on your machine</h3>${list(KEPT)}</div></div>
</section>
${leaders}
<div class="wrap"><section class="cta"><h2>Start counting</h2><p>Install the agent, sign in with GitHub, and run <code>oms sync</code> to see your first numbers.</p>
<div class="actions">${start}<a class="button lg" href="${REPO_URL}#get-started">Read the guide</a></div></section></div>`,
    viewer,
    { bleed: true, origin },
  );
}

type Part = { key: ComponentKey; label: string };

/** The whole dashboard as one image, then each part on its own for a README that wants only some. */
function embedCode(url: string, parts: Part[]): string {
  const dashboard = `<pre><code>${esc(`![Developer stats](${url}/dashboard.svg)`)}</code></pre>`;
  if (parts.length === 0) return dashboard;
  // A blank line puts each image in its own paragraph, so GitHub spaces them evenly.
  const lines = parts.map((part) => `![${part.label}](${url}/components/${part.key}.svg)`).join('\n\n');
  return `${dashboard}
  <p>Or pick the parts you want, in any order:</p>
  <pre><code>${esc(lines)}</code></pre>
  <p class="muted">For Tokyo Night colors, add <code>?theme=tokyo-night</code> to any image address.</p>`;
}

function providerActivity(tokens: TokenMetrics | null): string {
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

function activityPanels(tokens: TokenMetrics | null): string {
  if (!tokens) return '';
  const days = tokens.daily;
  const peak = Math.max(1, ...days.map(day => day.total));
  const offset = (new Date(days[0].date + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const labels = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(label => `<small aria-hidden="true">${label}</small>`).join('');
  const cells = days.map(({ date, total }) => {
    const level = total ? Math.ceil(Math.sqrt(total / peak) * 4) : 0;
    const label = `${date} · ${commas(total)} tokens`;
    return `<button class="day" popovertarget="day-${date}" data-level="${level}" aria-label="${label}" title="${label}"></button>`;
  }).join('');
  const details = days.map(({ date, total, byTool }) => {
    const tools = Object.entries(byTool).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
    const list = tools.map(([tool, count]) => `<li>${esc(providerName(tool))} · ${commas(count)}</li>`).join('');
    return `<section popover class="day-details" id="day-${date}" aria-label="AI usage on ${date}"><h2>${date}</h2>
      <p>${commas(total)} tokens</p>${list ? `<ul>${list}</ul>` : ''}<button popovertarget="day-${date}" popovertargetaction="hide">Close</button></section>`;
  }).join('');
  const mix = providerMix(tokens);
  const shareLabel = (value: number | null) => value === null ? '—' : percent(value);
  const rows = mix.rows.map(({ tool, share, priorShare }) => {
    const delta = share === null || priorShare === null ? null : (share - priorShare) * 100;
    return `<tr><td>${esc(providerName(tool))}</td><td class="num">${shareLabel(priorShare)}</td><td class="num">${shareLabel(share)}</td>
      <td class="num">${delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} pp`}</td></tr>`;
  }).join('');
  return `<div class="activity-panels"><section class="panel"><h2>AI usage calendar</h2>
    <p class="muted">${days[0].date} – ${days.at(-1)!.date} · Select a day for its providers.</p>
    <div class="calendar">${labels}${'<span></span>'.repeat(offset)}${cells}</div>${details}</section>
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
  return layout(
    `@${user.login} on ${SITE}`,
    `<div class="profile">${avatar(user.avatar_url, 64)}<div><h1>@${esc(user.login)}</h1>${user.name ? `<p>${esc(user.name)}</p>` : ''}${standing}</div>
<div class="actions">${viewer?.id === user.id ? '<a class="button" href="/me#profile-header">Edit profile</a>' : ''}<a class="button" href="https://github.com/${login}" rel="noopener">${GITHUB_MARK}GitHub</a></div></div>
<div class="dash">${svg}</div>
${activityPanels(tokens)}
${providerActivity(tokens)}
<div class="panel">
  <h2>Add this to your GitHub profile</h2>
  ${embedCode(url, parts)}
  ${cards.length ? `<h2>Text cards</h2><ul>${cardLinks}</ul>` : ''}
</div>`,
    viewer,
    { origin, image, description: `The developer stats of @${user.login}: AI tokens and GitHub contributions, counted across every machine.` },
  );
}

function machineRows(machines: MachineRow[], tokens: TokenMetrics | null): string {
  const totals = new Map(tokens?.machines.map(row => [row.id, row]));
  return machines
    .map((machine) => {
      const id = esc(machine.id);
      const usage = totals.get(machine.id);
      return `<tr>
  <td><form class="inline" method="post" action="/me/machines/${id}/rename"><input type="text" name="name" value="${esc(machine.name)}" aria-label="Machine name" maxlength="64"><button>Rename</button></form></td>
  <td>${esc(machine.platform ?? '-')}</td>
  <td class="num">${commas(usage?.last7 ?? 0)}</td>
  <td class="num">${commas(usage?.last30 ?? 0)}</td>
  <td class="num">${commas(usage?.total ?? 0)}</td>
  <td>${esc(machine.last_seen_at.slice(0, 16).replace('T', ' '))} UTC</td>
  <td><details class="confirm"><summary class="danger">Remove</summary><form class="inline" method="post" action="/me/machines/${id}/delete"><span class="muted">Deletes its data and signs it out.</span><button class="danger">Remove this machine</button></form></details></td>
</tr>`;
    })
    .join('');
}

function githubStatus(github: GitHubProfile | null): string {
  if (!github) return 'none read yet';
  if (github.status) return [github.status.emoji, github.status.message ?? (github.status.busy ? 'Busy' : '')].filter(Boolean).join(' ') || 'set';
  return github.hireable ? 'Available for hire' : 'none set';
}

/** Each field shows the GitHub value it falls back to as its placeholder. */
function profileForm(manual: ManualProfile, github: GitHubProfile | null): string {
  const field = (name: keyof typeof PROFILE_LIMITS, label: string, fallback: string | null | undefined, hint: string) => {
    const attrs = `name="${name}" maxlength="${PROFILE_LIMITS[name]}" placeholder="${esc(fallback ?? hint)}" autocomplete="off"`;
    return name === 'bio'
      ? `<label class="wide">${label}<textarea ${attrs} rows="2">${esc(manual[name] ?? '')}</textarea></label>`
      : `<label>${label}<input type="text" ${attrs} value="${esc(manual[name] ?? '')}"></label>`;
  };
  const choice = (value: string, label: string) => `<option value="${esc(value)}"${(manual.status ?? '') === value ? ' selected' : ''}>${esc(label)}</option>`;
  return `<div class="panel" id="profile-header">
  <h2>Profile header</h2>
  <p>Shown at the top of your dashboard, and as its own <code>profile</code> part. Leave a field empty to use your GitHub profile, which your agent reads once a day.</p>
  <form method="post" action="/me/profile">
    <div class="fields">
      ${field('name', 'Name', github?.name, 'Your name')}
      ${field('title', 'Title', null, 'e.g. Backend engineer')}
      ${field('company', 'Company', github?.company, 'e.g. Acme')}
      ${field('location', 'Location', github?.location, 'e.g. Seoul')}
      <label>Status<select name="status">${choice('', `From GitHub (${githubStatus(github)})`)}${Object.entries(STATUS_CHOICES)
        .map(([value, label]) => choice(value, label))
        .join('')}</select></label>
      ${field('bio', 'Bio', github?.bio, 'One line about you')}
    </div>
    <button class="primary">Save profile</button>
  </form>
</div>`;
}

export function dashboardPage(
  user: UserRow,
  machines: MachineRow[],
  svg: string | null,
  tokens: TokenMetrics | null,
  parts: Part[],
  origin: string,
  profile: { manual: ManualProfile; github: GitHubProfile | null },
): string {
  const url = `${origin}/u/${encodeURIComponent(user.login)}`;
  const isPublic = user.is_public === 1;
  const empty = `<div class="panel"><h2>Connect your first machine</h2><p>Run this on each computer. The agent records usage continuously and uploads once a day.</p>${installCommands(origin)}</div>`;
  return layout(
    `Your dashboard · ${SITE}`,
    `<div class="page-head"><div><h1>Your dashboard</h1><p>Signed in as @${esc(user.login)}. ${isPublic ? 'Your profile is public.' : 'Only you can see these numbers.'}</p></div>
<div class="actions"><a class="button" href="/me/rankings">My rankings</a>${isPublic ? `<a class="button" href="${esc(url)}">Public profile</a>` : ''}</div></div>
${machines.length === 0 ? empty : ''}
${svg ? `<div class="dash">${svg}</div>` : ''}
${activityPanels(tokens)}
${providerActivity(tokens)}
<div class="panel">
  <h2>Profile <span class="badge${isPublic ? ' live' : ''}">${isPublic ? 'Public' : 'Private'}</span></h2>
  ${
    isPublic
      ? `<p>Anyone can see your profile at <a href="${esc(url)}">${esc(url)}</a>.</p>${embedCode(url, parts)}`
      : '<p>Only you can see your stats. Publishing shows your totals, by model and by day. Machine names stay private.</p>'
  }
  <form method="post" action="/me/visibility"><input type="hidden" name="public" value="${isPublic ? '0' : '1'}"><button class="${isPublic ? '' : 'primary'}">${isPublic ? 'Make private' : 'Publish profile'}</button></form>
</div>
${profileForm(profile.manual, profile.github)}
${
  machines.length
    ? `<div class="panel"><h2>Machines</h2><div class="table"><table>
<thead><tr><th>Name</th><th>Platform</th><th class="num">Tokens · last 7d</th><th class="num">Tokens · last 30d</th><th class="num">Lifetime tokens</th><th>Last sync</th><th></th></tr></thead>
<tbody>${machineRows(machines, tokens)}${tokens && Object.values(tokens.unassigned).some(n => n > 0) ? `<tr><td colspan="2">No matching device</td>
  <td class="num">${commas(tokens.unassigned.last7)}</td><td class="num">${commas(tokens.unassigned.last30)}</td><td class="num">${commas(tokens.unassigned.total)}</td><td colspan="2"></td></tr>` : ''}</tbody></table></div>
<p class="muted">Machines upload once a day, so numbers can be up to a day behind. Run <code>oms sync</code> on a machine to update it now. For providers with an account-wide total, device attribution uses local logs. Account usage with no matching machine record appears only in the account total. Removing a machine deletes its data and signs it out.</p></div>`
    : ''
}
<div class="panel">
  <h2>Account</h2>
  <form method="post" action="/logout"><button>Sign out</button></form>
  <details class="confirm" style="margin-top:12px">
    <summary class="danger">Delete my account and data</summary>
    <form method="post" action="/me/delete">
      <p>This deletes everything on this server and signs out every machine. To confirm, type your GitHub username, <code>${esc(user.login)}</code>.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="text" name="confirm" aria-label="Your GitHub username" maxlength="39" autocomplete="off" spellcheck="false" required>
        <button class="danger">Delete everything</button>
      </div>
    </form>
  </details>
</div>`,
    user,
  );
}

export function errorPage(status: number, message: string, viewer: UserRow | null): string {
  return layout(`${status} · ${SITE}`, `<div class="notice"><p class="code">${status}</p><h1>${esc(message)}</h1>
<div class="actions"><a class="button" href="/">Back to the home page</a></div></div>`, viewer);
}
