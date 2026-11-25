import type { CSSProperties } from 'react';
import { commas, compact, niceMax, percent } from '../../shared/format.ts';
import type { GitHubProfile, Metrics, TokenMetrics } from '../../shared/metrics.ts';
import { manualProfileFromJson, PROFILE_LIMITS, STATUS_CHOICES, type ManualProfile } from '../../shared/profile.ts';
import { availableComponents } from '../../shared/render/svg.ts';
import { lastDays } from '../../shared/time.ts';
import { usageCalendar, type CalendarView } from '../../shared/usage.ts';
import { buildMetrics } from '../../server/app.ts';
import { listMachines, type MachineRow, type UserRow } from '../../server/db.ts';
import { SITE, type Part } from '../../server/pages.ts';
import { activityIcons, ActivityPanels, EmbedCode, ProviderActivity } from '../activity.tsx';
import { GitHubSetup, InstallCommands, ProviderLabel } from '../common.tsx';
import { Layout } from '../layout.tsx';
import type { PageModule } from '../page.ts';
import { TrendCard, WorkspaceSections } from './workspace.tsx';

/** The signed-in dashboard: a workspace only its owner sees, in four sections. */

function MachineRows({ machines, tokens }: { machines: MachineRow[]; tokens: TokenMetrics | null }) {
  const totals = new Map(tokens?.machines.map((row) => [row.id, row]));
  return machines.map((machine) => {
    const usage = totals.get(machine.id);
    return (
      <tr key={machine.id}>
        <td>
          <form className="inline" method="post" action={`/me/machines/${machine.id}/rename`}>
            <input type="text" name="name" defaultValue={machine.name} aria-label="Machine name" maxLength={64} />
            <button>Rename</button>
          </form>
        </td>
        <td>{machine.platform ?? '-'}</td>
        <td className="num">{commas(usage?.last7 ?? 0)}</td>
        <td className="num">{commas(usage?.last30 ?? 0)}</td>
        <td className="num">{commas(usage?.total ?? 0)}</td>
        <td>{`${machine.last_seen_at.slice(0, 16).replace('T', ' ')} UTC`}</td>
        <td>
          <details className="confirm">
            <summary className="danger">Remove</summary>
            <form className="inline" method="post" action={`/me/machines/${machine.id}/delete`}>
              <span className="muted">Deletes its data and signs it out.</span>
              <button className="danger">Remove this machine</button>
            </form>
          </details>
        </td>
      </tr>
    );
  });
}

function githubStatus(github: GitHubProfile | null): string {
  if (!github) return 'none read yet';
  if (github.status) return [github.status.emoji, github.status.message ?? (github.status.busy ? 'Busy' : '')].filter(Boolean).join(' ') || 'set';
  return github.hireable ? 'Available for hire' : 'none set';
}

/** Each field shows the GitHub value it falls back to as its placeholder. */
function ProfileForm({ manual, github }: { manual: ManualProfile; github: GitHubProfile | null }) {
  const field = (name: keyof typeof PROFILE_LIMITS, label: string, fallback: string | null | undefined, hint: string) => {
    const attrs = { name, maxLength: PROFILE_LIMITS[name], placeholder: fallback ?? hint, autoComplete: 'off', defaultValue: manual[name] ?? '' };
    return name === 'bio'
      ? <label className="wide">{label}<textarea {...attrs} rows={2} /></label>
      : <label>{label}<input type="text" {...attrs} /></label>;
  };
  return (
    <div className="panel" id="profile-header">
      <h2>Profile header</h2>
      <p>Shown at the top of your dashboard, and as its own <code>profile</code> part. Leave a field empty to use your GitHub profile, which <code>oms</code> reads once a day.</p>
      <form method="post" action="/me/profile">
        <div className="fields">
          {field('name', 'Name', github?.name, 'Your name')}
          {field('title', 'Title', null, 'e.g. Backend engineer')}
          {field('company', 'Company', github?.company, 'e.g. Acme')}
          {field('location', 'Location', github?.location, 'e.g. Seoul')}
          <label>
            Status
            <select name="status" defaultValue={manual.status ?? ''}>
              <option value="">{`From GitHub (${githubStatus(github)})`}</option>
              {Object.entries(STATUS_CHOICES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {field('bio', 'Bio', github?.bio, 'One line about you')}
        </div>
        <button className="primary">Save profile</button>
      </form>
    </div>
  );
}

const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateLabel = (date: string) => shortDate.format(new Date(`${date}T00:00:00Z`));
const windows = [7, 30, 60] as const;

const series = (index: number | undefined): CSSProperties => ({ '--series': `var(--series-${index})` }) as CSSProperties;

function UsageWindow({ tokens, size, palette }: { tokens: TokenMetrics; size: number; palette: Map<string, number> }) {
  const days = tokens.daily.slice(-size);
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const max = niceMax(Math.max(2, ...days.map((day) => day.total)));
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
  // Slot centers are also the pointer and keyboard inspection positions.
  const halfSlot = 50 / size;
  const points = days.map((day, i) => `${((2 * i + 1) * halfSlot).toFixed(3)},${(100 - (100 * day.total) / max).toFixed(3)}`).join(' ');
  return (
    <div className="usage-window" data-window={size}>
      <TrendCard
        size={size}
        total={compact(total)}
        exactTotal={`${commas(total)} tokens`}
        range={change !== null
          ? <><strong>{`${change > 0 ? '+' : ''}${percent(change)}`}</strong>{` vs prior ${size} days`}</>
          : `${dateLabel(first.date)} – ${dateLabel(last.date)}`}
        max={compact(max)}
        half={compact(max / 2)}
        points={points}
        halfSlot={halfSlot}
        dates={[dateLabel(first.date), dateLabel(days[Math.floor(size / 2)].date), dateLabel(last.date)]}
        days={days.map((day) => ({ label: `${day.date} · ${commas(day.total)} tokens`, y: 100 - (100 * day.total) / max }))}
      />
      <section className="provider-card panel">
        <h2>Provider breakdown</h2>
        <p className="muted">{`Share of tokens · last ${size} days`}</p>
        {providers.length ? (
          <>
            <div className="provider-mix" aria-hidden="true">
              {providers.map(([tool, count]) => <i key={tool} style={{ flexGrow: count, background: `var(--series-${palette.get(tool)})` }}></i>)}
            </div>
            <ol className="provider-list">
              {providers.map(([tool, count]) => (
                <li key={tool} style={series(palette.get(tool))}>
                  <div><strong><ProviderLabel id={tool} /></strong><span>{percent(count / total)}</span></div>
                  <small title={`${commas(count)} tokens`}>{`${compact(count)} tokens`}</small>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="provider-empty">No dated usage in this period.</p>
        )}
      </section>
    </div>
  );
}

/** The period switch uses native radios so the same daily totals remain available without JavaScript. */
function UsageExplorer({ tokens }: { tokens: TokenMetrics }) {
  const palette = new Map(tokens.tools.map(({ tool }, i) => [tool, i % 6]));
  return (
    <div className="usage-explorer" role="group" aria-label="Token activity period">
      {windows.map((size) => <input key={size} className="sr" type="radio" name="window" id={`window-${size}`} defaultChecked={size === 30} />)}
      <div className="window-switch">
        {windows.map((size) => <label key={size} htmlFor={`window-${size}`}>{size}<span aria-hidden="true">D</span><span className="sr"> days</span></label>)}
      </div>
      {windows.map((size) => <UsageWindow key={size} tokens={tokens} size={size} palette={palette} />)}
    </div>
  );
}

const LEVELS = [0, 1, 2, 3, 4];

function CalendarSummary({ view }: { view: CalendarView }) {
  const weeks = view.weeks.slice(-26);
  const from = weeks[0].days[0]!.date;
  return (
    <div className="calendar-summary">
      <div className="calendar-heading"><h2>Daily token activity</h2><a href="#activity">View activity <span aria-hidden="true">→</span></a></div>
      <div className="heat-grid" role="img" aria-label={`Daily token activity from ${from} to ${view.end}`}>
        {weeks.map((week, index) => (
          <div key={index} className="heat-week">
            <small>{week.month ?? ''}</small>
            {week.days.map((day, i) => (day ? <i key={i} data-level={day.level} title={`${day.date} · ${commas(day.total)} tokens`}></i> : <i key={i}></i>))}
          </div>
        ))}
      </div>
      <div className="heat-caption">
        <span>{`${dateLabel(from)} – ${dateLabel(view.end)}`}</span>
        <span className="heat-key">{'Less '}{LEVELS.map((level) => <i key={level} data-level={level}></i>)}{' More'}</span>
      </div>
    </div>
  );
}

function OverviewSummary({ metrics: { tokens, github }, calendar }: { metrics: Metrics; calendar?: CalendarView }) {
  const metric = (label: string, value: number | undefined, short = false) => (
    <div key={label}>
      <dt>{label}</dt>
      <dd title={value === undefined ? 'No synced data' : commas(value)}>{value === undefined ? '—' : short ? compact(value) : commas(value)}</dd>
    </div>
  );
  const stats = !tokens && github
    ? [metric('GitHub contributions', github.counts.calendar, true), metric('Commits', github.counts.commits), metric('Pull requests', github.counts.pulls)]
    : [metric('Lifetime tokens', tokens?.total, true), metric('Active days', tokens?.activeDays), metric('GitHub contributions', github?.counts.calendar)];
  return (
    <section className="overview-summary" aria-label="Lifetime statistics">
      <dl className="summary-stats">{stats}</dl>
      {calendar ? <CalendarSummary view={calendar} /> : null}
    </section>
  );
}

function AccountPanel({ user }: { user: UserRow }) {
  return (
    <div className="panel">
      <h2>Account</h2>
      <form method="post" action="/logout"><button>Sign out</button></form>
      <details className="confirm" style={{ marginTop: 12 }}>
        <summary className="danger">Delete my account and data</summary>
        <form method="post" action="/me/delete">
          <p>This deletes everything on this server and signs out every machine. To confirm, type your GitHub username, <code>{user.login}</code>.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="text" name="confirm" aria-label="Your GitHub username" maxLength={39} autoComplete="off" spellCheck={false} required />
            <button className="danger">Delete everything</button>
          </div>
        </form>
      </details>
    </div>
  );
}

interface DashboardProps {
  user: UserRow;
  machines: MachineRow[];
  metrics: Metrics;
  parts: Part[];
  origin: string;
  manual: ManualProfile;
}

/** Every tool the dashboard marks: the shared panels', and each period's breakdown. */
const dashboardIcons = (tokens: TokenMetrics | null) =>
  tokens ? [...activityIcons(tokens), ...tokens.daily.flatMap((day) => Object.keys(day.byTool))] : [];

function DashboardView({ user, machines, metrics, parts, origin, manual }: DashboardProps) {
  const { github, tokens } = metrics;
  const calendars = tokens ? usageCalendar(tokens) : [];
  const url = `${origin}/u/${encodeURIComponent(user.login)}`;
  const isPublic = user.is_public === 1;
  const githubSetup = github ? null : <GitHubSetup />;
  const lastSeen = machines[0]?.last_seen_at;
  const syncLabel = lastSeen ? new Date(lastSeen).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: user.timezone, timeZoneName: 'short',
  }) : '';
  const unassigned = tokens && Object.values(tokens.unassigned).some((n) => n > 0) ? tokens.unassigned : null;

  const overview = (
    <>
      {machines.length ? null : (
        <section className="panel setup-card" id="connect">
          <div>
            <h2>Connect your first machine</h2>
            <p>Install <code>oms</code> on your computer to start counting AI usage. It uploads your totals once a day.</p>
          </div>
          <InstallCommands origin={origin} />
          {githubSetup}
        </section>
      )}
      {tokens || github ? <OverviewSummary metrics={metrics} calendar={calendars[0]} /> : null}
      {tokens ? <UsageExplorer tokens={tokens} />
        : machines.length ? <section className="panel"><h2>Waiting for token usage</h2><p>Run <code>oms sync</code> on a connected machine to upload its usage.</p></section>
        : null}
      {github || tokens ? (
        <details className="report-preview">
          <summary>Full developer report</summary>
          <div className="report-scroll"><img src="/me/report.svg" loading="lazy" alt="Your developer stats report" /></div>
        </details>
      ) : null}
    </>
  );

  const activity = tokens ? (
    <>
      <ActivityPanels tokens={tokens} calendars={calendars} />
      <ProviderActivity tokens={tokens} />
    </>
  ) : (
    <div className="panel"><h2>Activity</h2><p>The calendar and provider activity appear after your first token sync.</p><a href="#machines">View machines</a></div>
  );

  const machinesPanel = machines.length ? (
    <div className="panel">
      <h2>Machines</h2>
      <div className="table">
        <table>
          <thead><tr><th>Name</th><th>Platform</th><th className="num">Tokens · last 7d</th><th className="num">Tokens · last 30d</th><th className="num">Lifetime tokens</th><th>Last sync</th><th></th></tr></thead>
          <tbody>
            <MachineRows machines={machines} tokens={tokens} />
            {unassigned ? (
              <tr>
                <td colSpan={2}>No matching device</td>
                <td className="num">{commas(unassigned.last7)}</td>
                <td className="num">{commas(unassigned.last30)}</td>
                <td className="num">{commas(unassigned.total)}</td>
                <td colSpan={2}></td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="muted">Machines upload once a day, so numbers can be up to a day behind. Run <code>oms sync</code> on a machine to update it now. For providers with an account-wide total, device attribution uses local logs. Account usage with no matching machine record appears only in the account total. Removing a machine deletes its data and signs it out.</p>
      {githubSetup}
    </div>
  ) : (
    <div className="panel"><h2>Machines</h2><p>No machines connected yet.</p><a href="#connect">Connect your first machine</a></div>
  );

  const settings = (
    <>
      <div className="panel">
        <h2>Profile <span className={`badge${isPublic ? ' live' : ''}`}>{isPublic ? 'Public' : 'Private'}</span></h2>
        {isPublic ? (
          <>
            <p>Anyone can see your profile at <a href={url}>{url}</a>.</p>
            <EmbedCode url={url} parts={parts} />
          </>
        ) : (
          <p>Only you can see your stats. Publishing shows your totals, by model and by day. Machine names stay private.</p>
        )}
        <form method="post" action="/me/visibility">
          <input type="hidden" name="public" value={isPublic ? '0' : '1'} />
          <button className={isPublic ? '' : 'primary'}>{isPublic ? 'Make private' : 'Publish profile'}</button>
        </form>
      </div>
      <ProfileForm manual={manual} github={github?.profile ?? null} />
      <AccountPanel user={user} />
    </>
  );

  return (
    <Layout title={`Your dashboard · ${SITE}`} viewer={user} icons={dashboardIcons(tokens)}>
      <link rel="stylesheet" href="/dashboard.css" precedence="default" />
      <div className="workspace-head">
        <div>
          <h1>Personal dashboard</h1>
          <p className="sync-line">
            <span>{`@${user.login}`}</span>
            {isPublic ? null : <span>Private profile</span>}
            <span>{lastSeen ? <>{'Last synced '}<time dateTime={lastSeen}>{syncLabel}</time></> : 'Waiting for your first sync'}</span>
          </p>
        </div>
        <div className="actions">
          <a className="button" href="/me/rankings">My rankings</a>
          {isPublic ? <a className="button public-link" href={url}>Public profile <span aria-hidden="true">↗</span></a> : null}
        </div>
      </div>
      <WorkspaceSections sections={[
        { id: 'overview', label: 'Overview', content: overview },
        { id: 'activity', label: 'Activity', content: activity },
        { id: 'machines', label: 'Machines', count: machines.length, content: machinesPanel },
        { id: 'settings', label: 'Settings', content: settings },
      ]} />
    </Layout>
  );
}

export const me: PageModule<DashboardProps> = {
  async load({ viewer, deps, url }) {
    if (!viewer) return { redirect: '/login' };
    const [machines, { metrics }] = await Promise.all([listMachines(deps.db, viewer.id), buildMetrics(viewer, deps)]);
    return {
      props: { user: viewer, machines, metrics, parts: availableComponents(metrics), origin: url.origin, manual: manualProfileFromJson(viewer.profile) },
    };
  },
  View: DashboardView,
};
