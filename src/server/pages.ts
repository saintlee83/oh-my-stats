import type { Card } from '../shared/render/cards.ts';
import type { ComponentKey } from '../shared/render/svg.ts';
import { commas, compact, percent, providerName } from '../shared/format.ts';
import { providerMix } from '../shared/insights.ts';
import type { GitHubProfile, TokenMetrics } from '../shared/metrics.ts';
import { PROFILE_LIMITS, STATUS_CHOICES, type ManualProfile } from '../shared/profile.ts';
import type { MachineRow, UserRow } from './db.ts';
import type { PersonalRankings, PublicPosition, RankingPeriod, Standing } from './rankings.ts';

/** Server-rendered pages. Every value from a user or machine goes through `esc`. */

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

/** GitHub's light and dark colors, following the system setting, to match the dashboard's default theme. */
const STYLE = `
  :root { color-scheme: light dark; --bg:#ffffff; --surface:#ffffff; --ink:#1f2328; --ink2:#424a53; --muted:#656d76; --line:#d0d7de; --link:#0969da;
    --button:#f6f8fa; --primary:#1f883d; --primary-ink:#ffffff; --danger:#d1242f; --code:#f6f8fa; --code-inline:rgba(175,184,193,0.2); }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --surface:#0d1117; --ink:#e6edf3; --ink2:#c9d1d9; --muted:#8b949e; --line:#30363d; --link:#4493f8;
    --button:#21262d; --primary:#238636; --danger:#f85149; --code:#161b22; --code-inline:rgba(110,118,129,0.4); } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; }
  a { color: var(--link); }
  header.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; max-width: 1032px; margin: 0 auto; padding: 16px; }
  nav.links { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }
  nav.links [aria-current=page] { font-weight: 650; color: var(--ink); }
  .brand { font-weight: 650; color: var(--ink); text-decoration: none; }
  main { max-width: 1032px; margin: 0 auto; padding: 8px 16px 64px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 24px 0 8px; }
  h2 { font-size: 17px; margin: 0 0 12px; }
  p { margin: 0 0 12px; color: var(--ink2); }
  .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin: 16px 0; overflow: hidden; }
  .dash { overflow-x: auto; margin: 16px 0; }
  .dash svg { display: block; max-width: 100%; height: auto; }
  pre, code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre { background: var(--code); border-radius: 6px; padding: 12px 14px; overflow-x: auto; margin: 8px 0 12px; }
  code { background: var(--code-inline); border-radius: 6px; padding: 1px 5px; }
  pre code { background: none; padding: 0; }
  button, .button { font: inherit; font-weight: 600; cursor: pointer; border: 1px solid var(--line); background: var(--button); color: var(--ink); border-radius: 6px; padding: 7px 12px; text-decoration: none; display: inline-block; min-height: 36px; }
  .primary { background: var(--primary); border-color: var(--primary); color: var(--primary-ink); }
  .danger { color: var(--danger); }
  input[type=text] { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; min-height: 36px; width: 100%; max-width: 240px; }
  form.inline { display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0; }
  .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 16px; margin: 16px 0; }
  .fields label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; color: var(--ink2); }
  .fields .wide { grid-column: 1 / -1; }
  .fields input[type=text], .fields textarea, .fields select { max-width: none; width: 100%; font: inherit; font-weight: 400; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; min-height: 36px; }
  .fields textarea { resize: vertical; }
  details.confirm summary { cursor: pointer; font-weight: 600; width: fit-content; padding: 6px 0; }
  details.confirm form { margin-top: 8px; }
  .table { width: 100%; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 10px 12px 10px 0; border-bottom: 1px solid var(--line); vertical-align: middle; white-space: nowrap; }
  th { font-size: 13px; font-weight: 500; color: var(--muted); }
  tr:last-child td { border-bottom: 0; }
  .num { text-align: right; }
  .muted { color: var(--muted); font-size: 13px; }
  .badge { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--ink2); }
  .profile { display: flex; align-items: center; gap: 14px; margin: 16px 0; }
  .profile img { width: 56px; height: 56px; border-radius: 50%; }
  .profile h1 { margin: 0; }
  .steps { padding-left: 20px; color: var(--ink2); } .steps li { margin-bottom: 12px; }
  .activity-panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 350px), 1fr)); gap: 16px; margin: 16px 0; }
  .activity-panels .panel { margin: 0; }
  .calendar { display: grid; grid-auto-flow: column; grid-auto-columns: 20px; grid-template-rows: repeat(7, 20px); gap: 3px; width: fit-content; }
  .calendar small { align-self: center; color: var(--muted); font-size: 10px; }
  button.day { min-height: 0; padding: 0; border-radius: 4px; background: var(--code); }
  .day[data-level="1"] { background: #aceebb; } .day[data-level="2"] { background: #4ac26b; }
  .day[data-level="3"] { background: #1a7f37; } .day[data-level="4"] { background: #0a4621; }
  @media (prefers-color-scheme: dark) {
    .day[data-level="1"] { background: #1b5334; } .day[data-level="2"] { background: #247a43; }
    .day[data-level="3"] { background: #3cab60; } .day[data-level="4"] { background: #89e59f; }
  }
  .day:focus-visible, .day:hover { outline: 2px solid var(--ink); outline-offset: 1px; }
  .day-details { background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 20px; max-width: 90vw; }
  .day-details::backdrop { background: #0005; } .day-details ul { padding-inline-start: 20px; }
  @media (max-width: 640px) { h1 { font-size: 24px; } .panel { padding: 16px; } .dash svg { min-width: 720px; max-width: none; } }
`;

function layout(title: string, body: string, viewer: UserRow | null): string {
  const nav = viewer
    ? `<a class="button" href="/me">@${esc(viewer.login)}</a>`
    : '<a class="button" href="/login">Sign in with GitHub</a>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${STYLE}</style>
</head>
<body>
<header class="top"><a class="brand" href="/">oh-my-stats</a><nav class="links" aria-label="Main navigation"><a href="/rankings">Rankings</a>${nav}</nav></header>
<main>${body}</main>
</body>
</html>
`;
}

function rankingTable(title: string, column: string, rows: Standing[], tokenColumn: string, profiles = false): string {
  const body = rows.map(row => {
    const label = profiles ? `<a href="/u/${esc(encodeURIComponent(row.label))}">@${esc(row.label)}</a>` : esc(row.label);
    return `<tr><td>${row.rank}</td><td>${label}</td><td class="num">${commas(row.tokens)}</td></tr>`;
  }).join('');
  return `<section class="panel"><h2>${title}</h2>${rows.length
    ? `<div class="table"><table><thead><tr><th>Rank</th><th>${column}</th><th class="num">${tokenColumn}</th></tr></thead><tbody>${body}</tbody></table></div>`
    : '<p>No token usage for this period.</p>'}</section>`;
}

export function rankingsPage(period: RankingPeriod, data: Standing[] | PersonalRankings, viewer: UserRow | null, positions: PublicPosition[]): string {
  const isPublic = Array.isArray(data);
  const path = isPublic ? '/rankings' : '/me/rankings';
  const title = isPublic ? 'Public token rankings' : 'My token rankings';
  const periods = (['all', 7, 30] as const).map(days =>
    `<a href="${path}?days=${days}"${period.days === days ? ' aria-current="page"' : ''}>${days === 'all' ? 'All time' : `Last ${days} days`}</a>`).join('');
  const other = isPublic ? (viewer ? `<a href="/me/rankings?days=${period.days}">My rankings</a>` : '') : `<a href="/rankings?days=${period.days}">Public rankings</a>`;
  const tokenColumn = period.days === 'all' ? 'Lifetime tokens' : `Tokens (${period.days} days)`;
  const tables = isPublic ? rankingTable('Top 100 public profiles', 'GitHub user', data, tokenColumn, true)
    : rankingTable('My devices', 'Device', data.machines, tokenColumn) + rankingTable('My providers', 'Provider', data.providers, tokenColumn);
  const ranks = positions.map(({ days, rank, participants }) => {
    const range = days === 'all' ? 'All time' : `Last ${days} days`;
    const place = !viewer ? '' : rank === null ? 'Unranked · ' : `<strong>#${rank}</strong> of `;
    return `<p>${range} · ${place}${commas(participants)} ranked public profiles</p>`;
  }).join('');
  return layout(title, `<h1>${title}</h1>
<nav class="links" aria-label="Ranking periods and views">${periods}${other}</nav>
${period.days === 'all' ? '' : `<p class="muted">${period.start} through ${period.end} · Reporting dates through today in UTC.</p>`}
<section class="panel"><h2>${viewer ? 'Your public position' : 'Participation'}</h2>${ranks}
${viewer && positions.every(p => p.rank === null) ? `<p class="muted">${viewer.is_public ? 'No ranked usage in these periods.' : 'Your profile is private.'}</p>` : ''}</section>
${tables}${isPublic ? '' : '<p class="muted">Device scores cover usage attributable to individual machines. Provider scores also include account-wide usage.</p>'}`, viewer);
}

const HOSTED_ORIGIN = 'https://ohmystats.dev';

const installSnippet = (origin: string) => `# Install the agent on macOS or Linux
curl -fsSL ${origin}/install.sh | sh
# or on Windows, in PowerShell
irm ${origin}/install.ps1 | iex

# Sign in on each machine, then let it run in the background
oms login${origin === HOSTED_ORIGIN ? '' : ` --server ${origin}`}
oms service install`;

export function landingPage(origin: string, viewer: UserRow | null): string {
  return layout(
    'oh-my-stats',
    `<h1>Your real developer stats, from every machine.</h1>
<p>Sign in with GitHub, run a small agent on each computer, and see your AI tokens and contributions in one place, with private work included.</p>
<div class="panel">
  <h2>Get started</h2>
  <pre><code>${esc(installSnippet(origin))}</code></pre>
  ${viewer ? '<a class="button primary" href="/me">Go to your dashboard</a>' : '<a class="button primary" href="/login">Sign in with GitHub</a>'}
  <p class="muted" style="margin-top:12px">The agent records usage continuously and uploads once a day. Run <code>oms sync</code> to update right away.</p>
</div>
<div class="panel">
  <h2>What leaves your machine</h2>
  <p>Only totals: tokens per day and model, and aggregated GitHub numbers, plus your public GitHub profile. Prompts, code, commit messages, file paths and private repository names stay on your computer.</p>
  <p>Your profile is private until you choose to publish it. Machine names are never public.</p>
</div>`,
    viewer,
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

export function profilePage(user: UserRow, svg: string, tokens: TokenMetrics | null, cards: Card[], parts: Part[], origin: string, viewer: UserRow | null): string {
  const url = `${origin}/u/${encodeURIComponent(user.login)}`;
  const avatar = user.avatar_url ? `<img src="${esc(user.avatar_url)}" alt="">` : '';
  const cardLinks = cards
    .map((card) => `<li><a href="/u/${esc(encodeURIComponent(user.login))}/cards/${esc(card.key)}.txt">${esc(card.title)}</a></li>`)
    .join('');
  return layout(
    `@${user.login} on oh-my-stats`,
    `<div class="profile">${avatar}<div><h1>@${esc(user.login)}</h1>${user.name ? `<p>${esc(user.name)}</p>` : ''}</div></div>
<div class="dash">${svg}</div>
${activityPanels(tokens)}
${providerActivity(tokens)}
<div class="panel">
  <h2>Add this to your GitHub profile</h2>
  ${embedCode(url, parts)}
  ${cards.length ? `<h2>Text cards</h2><ul>${cardLinks}</ul>` : ''}
</div>`,
    viewer,
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
  const empty = `<div class="panel"><h2>Connect your first machine</h2><pre><code>${esc(installSnippet(origin))}</code></pre></div>`;
  return layout(
    'Your dashboard',
    `<h1>Your dashboard</h1>
<p><a href="/me/rankings">View my device and provider rankings</a></p>
${machines.length === 0 ? empty : ''}
${svg ? `<div class="dash">${svg}</div>` : ''}
${activityPanels(tokens)}
${providerActivity(tokens)}
<div class="panel">
  <h2>Profile <span class="badge">${isPublic ? 'Public' : 'Private'}</span></h2>
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
  return layout(`${status}`, `<h1>${esc(message)}</h1><p><a href="/">Back to the home page</a></p>`, viewer);
}
