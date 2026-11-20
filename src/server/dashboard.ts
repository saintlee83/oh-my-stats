import { commas, compact, percent, providerName } from '../shared/format.ts';
import type { GitHubProfile, Metrics, TokenMetrics } from '../shared/metrics.ts';
import { PROFILE_LIMITS, STATUS_CHOICES, type ManualProfile } from '../shared/profile.ts';
import { niceMax } from '../shared/render/svg.ts';
import { lastDays } from '../shared/time.ts';
import { usageCalendar, type CalendarView } from '../shared/usage.ts';
import type { MachineRow, UserRow } from './db.ts';
import { activityPanels, embedCode, esc, GITHUB_SETUP, installCommands, layout, providerActivity, SITE, type Part } from './pages.ts';

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
  <p>Shown at the top of your dashboard, and as its own <code>profile</code> part. Leave a field empty to use your GitHub profile, which <code>oms</code> reads once a day.</p>
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

const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateLabel = (date: string) => shortDate.format(new Date(`${date}T00:00:00Z`));
const windows = [7, 30, 60] as const;

function usageWindow(tokens: TokenMetrics, size: number, series: Map<string, number>): string {
  const days = tokens.daily.slice(-size);
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const max = niceMax(Math.max(2, ...days.map(day => day.total)));
  const first = days[0];
  const last = days[days.length - 1];
  const priorStart = lastDays(last.date, size * 2)[0];
  const previous = tokens.dated.reduce((sum, day) => sum + (day.date >= priorStart && day.date < first.date ? day.total : 0), 0);
  const change = previous ? (total - previous) / previous : null;
  const shares = new Map<string, number>();
  for (const day of days) {
    for (const [tool, count] of Object.entries(day.byTool)) {
      if (count > 0) shares.set(tool, (shares.get(tool) ?? 0) + count);
    }
  }
  const providers = [...shares].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rows = providers.map(([tool, count]) => {
    const share = percent(count / total);
    return `<li style="--series:var(--series-${series.get(tool)})"><div><strong>${esc(providerName(tool))}</strong><span>${share}</span></div>
      <small title="${commas(count)} tokens">${compact(count)} tokens</small></li>`;
  }).join('');
  const mix = providers.map(([tool, count]) => `<i style="flex-grow:${count};background:var(--series-${series.get(tool)})"></i>`).join('');
  // Slot centers are also the pointer and keyboard inspection positions.
  const halfSlot = 50 / size;
  const points = days.map((day, i) => `${((2 * i + 1) * halfSlot).toFixed(3)},${(100 - 100 * day.total / max).toFixed(3)}`).join(' ');
  const slots = days.map(day => {
    const label = `${day.date} · ${commas(day.total)} tokens`;
    return `<span class="plot-slot" title="${label}" style="--y:${100 - 100 * day.total / max}%"></span>`;
  }).join('');
  return `<div class="usage-window" data-window="${size}">
    <section class="trend-card" aria-label="Daily token usage, last ${size} days">
      <h2>Token activity</h2>
      <div class="trend-total" title="${commas(total)} tokens">${compact(total)} <span>tokens</span></div>
      <p class="trend-range">${change !== null ? `<strong>${change > 0 ? '+' : ''}${percent(change)}</strong> vs prior ${size} days` : `${dateLabel(first.date)} – ${dateLabel(last.date)}`}</p>
      <div class="plot-area">
        <div class="plot-scale" aria-hidden="true"><span>${compact(max)}</span><span>${compact(max / 2)}</span><span>0</span></div>
        <div class="plot">
          <svg class="trend-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id="fill-${size}" x2="0" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="currentColor" stop-opacity=".24"/><stop offset="1" stop-color="currentColor" stop-opacity=".025"/></linearGradient></defs>
            <polygon points="${halfSlot},100 ${points} ${100 - halfSlot},100" fill="url(#fill-${size})"/>
            <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
          </svg>
          <div class="plot-slots">${slots}</div>
          <input hidden type="range" min="1" max="${size}" value="${size}" aria-label="Inspect daily token usage"></div>
      </div>
      <div class="plot-dates" aria-hidden="true"><span>${dateLabel(first.date)}</span><span>${dateLabel(days[Math.floor(size / 2)].date)}</span><span>${dateLabel(last.date)}</span></div>
      <p class="plot-detail"><span>Daily total</span> <b>${last.date} · ${commas(last.total)} tokens</b></p>
    </section>
    <section class="provider-card panel"><h2>Provider breakdown</h2><p class="muted">Share of tokens · last ${size} days</p>
      ${rows ? `<div class="provider-mix" aria-hidden="true">${mix}</div><ol class="provider-list">${rows}</ol>` : '<p class="provider-empty">No dated usage in this period.</p>'}
    </section></div>`;
}

/** The period switch uses native radios so the same daily totals remain available without JavaScript. */
function usageExplorer(tokens: TokenMetrics): string {
  const series = new Map(tokens.tools.map(({ tool }, i) => [tool, i % 6]));
  const switches = windows.map(size => `<input class="sr" type="radio" name="window" id="window-${size}"${size === 30 ? ' checked' : ''}>`).join('');
  const labels = windows.map(size => `<label for="window-${size}">${size}<span aria-hidden="true">D</span><span class="sr"> days</span></label>`).join('');
  return `<div class="usage-explorer" role="group" aria-label="Token activity period">${switches}
    <div class="window-switch">${labels}</div>${windows.map(size => usageWindow(tokens, size, series)).join('')}</div>`;
}

function calendarSummary(view: CalendarView): string {
  const weeks = view.weeks.slice(-26);
  const from = weeks[0].days[0]!.date;
  const columns = weeks.map(week => `<div class="heat-week"><small>${week.month ?? ''}</small>${week.days.map(day =>
    day ? `<i data-level="${day.level}" title="${day.date} · ${commas(day.total)} tokens"></i>` : '<i></i>'
  ).join('')}</div>`).join('');
  return `<div class="calendar-summary"><div class="calendar-heading"><h2>Daily token activity</h2><a href="#activity">View activity <span aria-hidden="true">→</span></a></div>
    <div class="heat-grid" role="img" aria-label="Daily token activity from ${from} to ${view.end}">${columns}</div>
    <div class="heat-caption"><span>${dateLabel(from)} – ${dateLabel(view.end)}</span><span class="heat-key">Less ${[0,1,2,3,4].map(n => `<i data-level="${n}"></i>`).join('')} More</span></div></div>`;
}

function overviewSummary({ tokens, github }: Metrics, calendar?: CalendarView): string {
  const metric = (label: string, value: number | undefined, short = false) =>
    `<div><dt>${label}</dt><dd title="${value === undefined ? 'No synced data' : commas(value)}">${value === undefined ? '—' : short ? compact(value) : commas(value)}</dd></div>`;
  const stats = !tokens && github
    ? metric('GitHub contributions', github.counts.calendar, true) + metric('Commits', github.counts.commits) + metric('Pull requests', github.counts.pulls)
    : metric('Lifetime tokens', tokens?.total, true) + metric('Active days', tokens?.activeDays) + metric('GitHub contributions', github?.counts.calendar);
  return `<section class="overview-summary" aria-label="Lifetime statistics"><dl class="summary-stats">
    ${stats}
    </dl>${calendar ? calendarSummary(calendar) : ''}</section>`;
}

export function dashboardPage(
  user: UserRow,
  machines: MachineRow[],
  metrics: Metrics,
  parts: Part[],
  origin: string,
  manual: ManualProfile,
): string {
  const { github, tokens } = metrics;
  const calendars = tokens ? usageCalendar(tokens) : [];
  const url = `${origin}/u/${encodeURIComponent(user.login)}`;
  const isPublic = user.is_public === 1;
  const githubSetup = github ? '' : GITHUB_SETUP;
  const setup = `<section class="panel setup-card" id="connect"><div><h2>Connect your first machine</h2><p>Install <code>oms</code> on your computer to start counting AI usage. It uploads your totals once a day.</p></div>${installCommands(origin)}${githubSetup}</section>`;
  const lastSeen = machines[0]?.last_seen_at;
  const syncLabel = lastSeen ? new Date(lastSeen).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: user.timezone, timeZoneName: 'short',
  }) : '';
  return layout(
    `Your dashboard · ${SITE}`,
    `<div class="workspace-head"><div><h1>Personal dashboard</h1>
<p class="sync-line"><span>@${esc(user.login)}</span>${isPublic ? '' : '<span>Private profile</span>'}<span>${lastSeen ? `Last synced <time datetime="${esc(lastSeen)}">${esc(syncLabel)}</time>` : 'Waiting for your first sync'}</span></p></div>
<div class="actions"><a class="button" href="/me/rankings">My rankings</a>${isPublic ? `<a class="button public-link" href="${esc(url)}">Public profile <span aria-hidden="true">↗</span></a>` : ''}</div></div>
<nav class="workspace-nav" aria-label="Dashboard sections">
  <a href="#overview">Overview</a><a href="#activity">Activity</a><a href="#machines">Machines <span>${machines.length}</span></a><a href="#settings">Settings</a>
</nav>
<section id="overview" class="workspace-view" aria-label="Overview">
  ${!machines.length ? setup : ''}
  ${tokens || github ? overviewSummary(metrics, calendars[0]) : ''}
  ${tokens ? usageExplorer(tokens) : machines.length ? '<section class="panel"><h2>Waiting for token usage</h2><p>Run <code>oms sync</code> on a connected machine to upload its usage.</p></section>' : ''}
  ${github || tokens ? '<details class="report-preview"><summary>Full developer report</summary><div class="report-scroll"><img src="/me/report.svg" loading="lazy" alt="Your developer stats report"></div></details>' : ''}
</section>
<section id="activity" class="workspace-view" aria-label="Activity">
  ${tokens ? activityPanels(tokens, calendars) + providerActivity(tokens) : '<div class="panel"><h2>Activity</h2><p>The calendar and provider activity appear after your first token sync.</p><a href="#machines">View machines</a></div>'}
</section>
<section id="machines" class="workspace-view" aria-label="Machines">
${
  machines.length
    ? `<div class="panel"><h2>Machines</h2><div class="table"><table>
<thead><tr><th>Name</th><th>Platform</th><th class="num">Tokens · last 7d</th><th class="num">Tokens · last 30d</th><th class="num">Lifetime tokens</th><th>Last sync</th><th></th></tr></thead>
<tbody>${machineRows(machines, tokens)}${tokens && Object.values(tokens.unassigned).some(n => n > 0) ? `<tr><td colspan="2">No matching device</td>
  <td class="num">${commas(tokens.unassigned.last7)}</td><td class="num">${commas(tokens.unassigned.last30)}</td><td class="num">${commas(tokens.unassigned.total)}</td><td colspan="2"></td></tr>` : ''}</tbody></table></div>
<p class="muted">Machines upload once a day, so numbers can be up to a day behind. Run <code>oms sync</code> on a machine to update it now. For providers with an account-wide total, device attribution uses local logs. Account usage with no matching machine record appears only in the account total. Removing a machine deletes its data and signs it out.</p>
${githubSetup}</div>`
    : '<div class="panel"><h2>Machines</h2><p>No machines connected yet.</p><a href="#connect">Connect your first machine</a></div>'
}
</section>
<section id="settings" class="workspace-view" aria-label="Settings">
<div class="panel">
  <h2>Profile <span class="badge${isPublic ? ' live' : ''}">${isPublic ? 'Public' : 'Private'}</span></h2>
  ${
    isPublic
      ? `<p>Anyone can see your profile at <a href="${esc(url)}">${esc(url)}</a>.</p>${embedCode(url, parts)}`
      : '<p>Only you can see your stats. Publishing shows your totals, by model and by day. Machine names stay private.</p>'
  }
  <form method="post" action="/me/visibility"><input type="hidden" name="public" value="${isPublic ? '0' : '1'}"><button class="${isPublic ? '' : 'primary'}">${isPublic ? 'Make private' : 'Publish profile'}</button></form>
</div>
${profileForm(manual, github?.profile ?? null)}
${accountPanel(user)}
</section>`,
    user,
    { dashboard: true },
  );
}

function accountPanel(user: UserRow): string {
  return `<div class="panel">
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
</div>`;
}

