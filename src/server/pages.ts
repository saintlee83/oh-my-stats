import type { Card } from '../shared/render/cards.ts';
import { compact } from '../shared/format.ts';
import type { MachineRow, UserRow } from './db.ts';

/** Server-rendered pages. Every value from a user or machine goes through `esc`. */

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

const STYLE = `
  :root { color-scheme: light dark; --bg:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#6f6d68; --line:#e1e0d9; --accent:#2a78d6; --accent-ink:#fff; --danger:#d03b3b; --code:#f0efec; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0d0d; --surface:#1a1a19; --ink:#f0efec; --ink2:#c3c2b7; --muted:#a3a198; --line:#2c2c2a; --accent:#3987e5; --code:#262624; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  a { color: var(--accent); }
  header.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; max-width: 1032px; margin: 0 auto; padding: 16px; }
  .brand { font-weight: 650; color: var(--ink); text-decoration: none; }
  main { max-width: 1032px; margin: 0 auto; padding: 8px 16px 64px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 24px 0 8px; }
  h2 { font-size: 17px; margin: 0 0 12px; }
  p { margin: 0 0 12px; color: var(--ink2); }
  .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin: 16px 0; overflow: hidden; }
  .dash { overflow-x: auto; margin: 16px 0; }
  .dash svg { display: block; max-width: 100%; height: auto; }
  pre, code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre { background: var(--code); border-radius: 8px; padding: 12px 14px; overflow-x: auto; margin: 8px 0 12px; }
  code { background: var(--code); border-radius: 4px; padding: 1px 5px; }
  pre code { background: none; padding: 0; }
  button, .button { font: inherit; font-weight: 600; cursor: pointer; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 8px; padding: 7px 12px; text-decoration: none; display: inline-block; min-height: 36px; }
  .primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .danger { color: var(--danger); }
  input[type=text] { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; min-height: 36px; width: 100%; max-width: 240px; }
  form.inline { display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0; }
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
<style>${STYLE}</style>
</head>
<body>
<header class="top"><a class="brand" href="/">oh-my-stats</a>${nav}</header>
<main>${body}</main>
</body>
</html>
`;
}

const installSnippet = (origin: string) => `# Build the agent (a prebuilt release is on the way)
git clone https://github.com/saintlee83/oh-my-stats
cargo install --path oh-my-stats/agent

# Sign in on each machine, then let it run in the background
oms login --server ${origin}
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
</div>
<div class="panel">
  <h2>What leaves your machine</h2>
  <p>Only totals: tokens per day and model, and aggregated GitHub numbers. Prompts, code, commit messages, file paths and private repository names stay on your computer.</p>
  <p>Your profile is private until you choose to publish it. Machine names are never public.</p>
</div>`,
    viewer,
  );
}

export function profilePage(user: UserRow, svg: string, cards: Card[], origin: string, viewer: UserRow | null): string {
  const url = `${origin}/u/${encodeURIComponent(user.login)}`;
  const avatar = user.avatar_url ? `<img src="${esc(user.avatar_url)}" alt="">` : '';
  const cardLinks = cards
    .map((card) => `<li><a href="/u/${esc(encodeURIComponent(user.login))}/cards/${esc(card.key)}.txt">${esc(card.title)}</a></li>`)
    .join('');
  return layout(
    `@${user.login} on oh-my-stats`,
    `<div class="profile">${avatar}<div><h1>@${esc(user.login)}</h1>${user.name ? `<p>${esc(user.name)}</p>` : ''}</div></div>
<div class="dash">${svg}</div>
<div class="panel">
  <h2>Add this to your GitHub profile</h2>
  <pre><code>${esc(`![Developer stats](${url}/dashboard.svg)`)}</code></pre>
  ${cards.length ? `<h2>Text cards</h2><ul>${cardLinks}</ul>` : ''}
</div>`,
    viewer,
  );
}

function machineRows(machines: MachineRow[], tokensByMachine: Map<string, number>): string {
  return machines
    .map((machine) => {
      const id = esc(machine.id);
      return `<tr>
  <td><form class="inline" method="post" action="/me/machines/${id}/rename"><input type="text" name="name" value="${esc(machine.name)}" aria-label="Machine name" maxlength="64"><button>Rename</button></form></td>
  <td>${esc(machine.platform ?? '-')}</td>
  <td class="num">${esc(compact(tokensByMachine.get(machine.id) ?? 0))}</td>
  <td>${esc(machine.last_seen_at.slice(0, 16).replace('T', ' '))} UTC</td>
  <td><form class="inline" method="post" action="/me/machines/${id}/delete"><button class="danger">Remove</button></form></td>
</tr>`;
    })
    .join('');
}

export function dashboardPage(
  user: UserRow,
  machines: MachineRow[],
  tokensByMachine: Map<string, number>,
  svg: string | null,
  origin: string,
): string {
  const url = `${origin}/u/${encodeURIComponent(user.login)}`;
  const isPublic = user.is_public === 1;
  const empty = `<div class="panel"><h2>Connect your first machine</h2><pre><code>${esc(installSnippet(origin))}</code></pre></div>`;
  return layout(
    'Your dashboard',
    `<h1>Your dashboard</h1>
${machines.length === 0 ? empty : ''}
${svg ? `<div class="dash">${svg}</div>` : ''}
<div class="panel">
  <h2>Profile <span class="badge">${isPublic ? 'Public' : 'Private'}</span></h2>
  ${
    isPublic
      ? `<p>Anyone can see your profile at <a href="${esc(url)}">${esc(url)}</a>.</p><pre><code>${esc(`![Developer stats](${url}/dashboard.svg)`)}</code></pre>`
      : '<p>Only you can see your stats. Publishing shows your totals, by model and by day. Machine names stay private.</p>'
  }
  <form method="post" action="/me/visibility"><input type="hidden" name="public" value="${isPublic ? '0' : '1'}"><button class="${isPublic ? '' : 'primary'}">${isPublic ? 'Make private' : 'Publish profile'}</button></form>
</div>
${
  machines.length
    ? `<div class="panel"><h2>Machines</h2><div class="table"><table>
<thead><tr><th>Name</th><th>Platform</th><th class="num">Tokens</th><th>Last sync</th><th></th></tr></thead>
<tbody>${machineRows(machines, tokensByMachine)}</tbody></table></div>
<p class="muted">Codex's account total isn't split by machine, so per-machine tokens cover what each machine logged. Removing a machine deletes its data and signs it out.</p></div>`
    : ''
}
<div class="panel">
  <h2>Account</h2>
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <form method="post" action="/logout"><button>Sign out</button></form>
    <form method="post" action="/me/delete"><button class="danger">Delete my account and data</button></form>
  </div>
</div>`,
    user,
  );
}

export function errorPage(status: number, message: string, viewer: UserRow | null): string {
  return layout(`${status}`, `<h1>${esc(message)}</h1><p><a href="/">Back to the home page</a></p>`, viewer);
}
