import type { CSSProperties, ReactNode } from 'react';
import { commas, compact, percent, providerName } from '../shared/format.ts';
import { providerMix } from '../shared/insights.ts';
import type { TokenMetrics } from '../shared/metrics.ts';
import { tokenMix, usageCalendar, usagePeriods, type CalendarDay, type CalendarView, type UsagePeriod } from '../shared/usage.ts';
import type { Part } from '../server/pages.ts';
import { ProviderLabel } from './common.tsx';

/** The panels the public profile and the private dashboard share: usage over time, the token mix, and how to embed a profile. */

/** Every tool these panels mark, for the page's `Layout` `icons`. */
export const activityIcons = (tokens: TokenMetrics | null) => (tokens ? tokens.tools.map(({ tool }) => tool) : []);

/**
 * The whole dashboard as one image, then each part on its own for a README that wants only
 * some, then the two small images for one that has no room for either.
 */
export function EmbedCode({ url, parts }: { url: string; parts: Part[] }) {
  const dashboard = <pre><code>{`![Developer stats](${url}/dashboard.svg)`}</code></pre>;
  if (parts.length === 0) return dashboard;
  // A blank line puts each image in its own paragraph, so GitHub spaces them evenly.
  const lines = parts.map((part) => `![${part.label}](${url}/components/${part.key}.svg)`).join('\n\n');
  const small = `![Developer stats](${url}/card.svg)\n\n![Token ranking](${url}/ranking.svg)\n\n![AI tokens](${url}/badge.svg)`;
  return (
    <>
      {dashboard}
      <p>Or pick the parts you want, in any order:</p>
      <pre><code>{lines}</code></pre>
      <p>For a smaller embed, choose a stats card, a token ranking card, or a badge.</p>
      <pre><code>{small}</code></pre>
      <p className="muted">The card adds a calendar of the last 26 weeks with <code>?graph=1</code>. The badge shows another figure with <code>?metric=cost</code>, <code>rank</code>, <code>contributions</code> or <code>streak</code>.</p>
      <p className="muted">For Tokyo Night colors, add <code>?theme=tokyo-night</code> to any image address. The badge keeps its own colors.</p>
    </>
  );
}

export function ProviderActivity({ tokens }: { tokens: TokenMetrics | null }) {
  if (!tokens) return null;
  return (
    <section className="panel">
      <h2>Provider activity</h2>
      <div className="table">
        <table>
          <thead>
            <tr>
              <th>Provider</th><th className="num">Tokens · last 7d</th><th className="num">Tokens · prior 7d</th>
              <th className="num">Active days · 30d</th><th className="num">Responses · 30d</th><th className="num">Tokens / response · 30d</th>
            </tr>
          </thead>
          <tbody>
            {tokens.tools.map(({ tool, activity: a }) => (
              <tr key={tool}>
                <td><ProviderLabel id={tool} /></td>
                <td className="num">{compact(a.last7)}</td>
                <td className="num">{compact(a.previous7)}</td>
                <td className="num">{a.activeDays30}</td>
                <td className="num">{commas(a.responses30)}</td>
                <td className="num">{a.tokensPerResponse30 === null ? '—' : compact(a.tokensPerResponse30)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">Response counts and averages use responses recorded by your synced machines.</p>
    </section>
  );
}

/**
 * Panes switched without scripts: a radio for each, then their labels, then the panes. The
 * stylesheet pairs the nth radio with the nth label and the nth pane, for five at most.
 */
function TabbedPanel({ name, title, panes, id }: { name: string; title: string; panes: { key: string; label: string; body: ReactNode }[]; id?: string }) {
  if (panes.length === 1) {
    return (
      <section className="panel" id={id}>
        <h2>{title}</h2>
        <div>{panes[0].body}</div>
      </section>
    );
  }
  return (
    <section className="panel panes" id={id} role="group" aria-label={title}>
      {panes.map(({ key }, index) => <input key={key} type="radio" name={name} id={`${name}-${key}`} defaultChecked={index === 0} />)}
      <header className="panel-head">
        <h2>{title}</h2>
        <span className="segments">
          {panes.map(({ key, label }) => <label key={key} htmlFor={`${name}-${key}`} data-label={label}>{label}</label>)}
        </span>
      </header>
      {panes.map(({ key, body }) => <div key={key} className="pane">{body}</div>)}
    </section>
  );
}

const dayCount = (count: number) => `${commas(count)} ${count === 1 ? 'day' : 'days'}`;

const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '', ''];

function Scale() {
  return (
    <p className="scale" aria-hidden="true">
      <small>Less</small>
      {[0, 1, 2, 3, 4].map((level) => <span key={level} className="day" data-level={level || undefined}></span>)}
      <small>More</small>
    </p>
  );
}

function DayDetails({ date, total, byTool }: CalendarDay) {
  const tools = Object.entries(byTool).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  return (
    <section popover="" className="day-details" id={`day-${date}`} aria-label={`AI usage on ${date}`}>
      <h2>{date}</h2>
      <p>{`${commas(total)} tokens`}</p>
      {tools.length ? <ul>{tools.map(([tool, count]) => <li key={tool}>{`${providerName(tool)} · ${commas(count)}`}</li>)}</ul> : null}
      <button popoverTarget={`day-${date}`} popoverTargetAction="hide">Close</button>
    </section>
  );
}

/**
 * One view of the calendar, weeks as columns. Only the newest view opens its days: a
 * breakdown for every day of every year would outweigh the rest of the page, so the
 * others say their total in a tooltip.
 */
function CalendarPane({ view, opens }: { view: CalendarView; opens: boolean }) {
  const cell = (day: CalendarDay | null, index: number) => {
    if (!day) return <span key={index}></span>;
    const label = `${day.date} · ${commas(day.total)} tokens`;
    return opens && day.total
      ? <button key={index} className="day" popoverTarget={`day-${day.date}`} data-level={day.level} aria-label={label} title={label}></button>
      : <span key={index} className="day" data-level={day.level || undefined} title={label}></span>;
  };
  const opened = opens ? view.weeks.flatMap((week) => week.days).filter((day) => day !== null).filter((day) => day.total > 0) : [];
  return (
    <>
      <p className="muted">
        {`${view.start} – ${view.end} · `}
        {view.total ? `${compact(view.total)} tokens on ${dayCount(view.activeDays)}` : 'No dated usage.'}
        {/* Each day that opens is a stop for the Tab key, so a keyboard gets a way past them. */}
        {view.total && opened.length ? <>{' · Select a day for its providers. '}<a className="sr" href="#periods">Skip the calendar</a></> : null}
      </p>
      <div className={`weeks-scroll${opens ? ' newest' : ''}`}>
        <div className="weeks-fit">
          <div className="weeks">
            {WEEKDAY_LABELS.map((label, index) => (label ? <small key={index} aria-hidden="true">{label}</small> : <span key={index}></span>))}
            {view.weeks.map(({ month, days }, week) => [
              month ? <small key={`m${week}`} aria-hidden="true">{month}</small> : <span key={`m${week}`}></span>,
              ...days.map((day, index) => cell(day, week * 7 + index)),
            ])}
          </div>
          <Scale />
        </div>
      </div>
      {opened.map((day) => <DayDetails key={day.date} {...day} />)}
    </>
  );
}

function PeriodPane({ period, undated }: { period: UsagePeriod; undated: number }) {
  const figure = (label: string, value: string, detail: string) => (
    <div className="figure" key={label}>
      <span>{label}</span>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
  const short = compact(period.total);
  const exact = commas(period.total);
  const { range, top, busiest, firstDay } = period;
  // Lifetime has no number of days to be active out of, so it says when its days began.
  const outOf = range ? `of ${dayCount(range.days)}${period.key === 'month' ? ' so far' : ''}` : firstDay ? `since ${firstDay}` : 'No dated usage';
  const note = range
    ? `${range.start} – ${range.end}`
    : undated > 0
      ? `Includes ${compact(undated)} tokens from before a tool’s daily records begin. They have no date, so the calendar and the other periods leave them out.`
      : 'Everything counted so far.';
  return (
    <>
      <div className="figures">
        {figure('Tokens', short, short === exact ? '' : exact)}
        {figure('Active days', commas(period.activeDays), outOf)}
        {figure('Most used provider', top ? providerName(top.tool) : '—', top ? `${percent(top.share)} of tokens` : 'No usage')}
        {figure('Busiest day', busiest?.date ?? '—', busiest ? `${compact(busiest.total)} tokens` : 'No dated usage')}
      </div>
      <p className="muted">{note}</p>
    </>
  );
}

const swatch = (key: string): CSSProperties => ({ background: `var(--${key})` });

/** A thin bar for the split at a glance, above a table that names each part and gives its figures. */
function TokenMixPanel({ tokens }: { tokens: TokenMetrics }) {
  const { known, parts } = tokenMix(tokens);
  if (!known) {
    return (
      <section className="panel">
        <h2>Token mix</h2>
        <p>No tokens with a known breakdown yet.</p>
      </section>
    );
  }
  return (
    <section className="panel mix">
      <h2>Token mix</h2>
      <p className="muted">{`Covers tokens with a known breakdown: ${compact(known)} of ${compact(tokens.total)} lifetime tokens.`}</p>
      <div className="mix-bar" role="img" aria-label={parts.map((part) => `${part.label} ${percent(part.share)}`).join(', ')}>
        {parts.filter((part) => part.tokens > 0).map(({ key, label, share }) => (
          <span key={key} style={{ flexGrow: (share * 100).toFixed(2), ...swatch(key) }} title={`${label} · ${percent(share)}`}></span>
        ))}
      </div>
      <div className="table">
        <table>
          <thead><tr><th>Kind</th><th className="num">Share</th><th className="num">Tokens</th></tr></thead>
          <tbody>
            {parts.map(({ key, label, tokens: count, share }) => (
              <tr key={key}>
                <td><i style={swatch(key)}></i>{label}</td>
                <td className="num">{percent(share)}</td>
                <td className="num">{commas(count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The calendar, the periods, the token mix and each provider's share. `calendars` are the views to show, when the page has chosen them. */
export function ActivityPanels({ tokens, calendars }: { tokens: TokenMetrics | null; calendars?: CalendarView[] }) {
  if (!tokens) return null;
  const calendar = (calendars ?? usageCalendar(tokens)).map((view, index) => ({ key: view.key, label: view.label, body: <CalendarPane view={view} opens={index === 0} /> }));
  const periods = usagePeriods(tokens).map((period) => ({ key: period.key, label: period.label, body: <PeriodPane period={period} undated={tokens.undated} /> }));
  const mix = providerMix(tokens);
  const shareLabel = (value: number | null) => (value === null ? '—' : percent(value));
  return (
    <>
      <TabbedPanel name="range" title="AI usage calendar" panes={calendar} />
      <TabbedPanel name="period" title="Usage by period" panes={periods} id="periods" />
      <div className="activity-panels">
        <TokenMixPanel tokens={tokens} />
        <section className="panel">
          <h2>Provider share of tokens</h2>
          <p className="muted">{`Previous month and month to date through ${mix.today}.`}</p>
          {mix.rows.length ? (
            <div className="table">
              <table>
                <thead><tr><th>Provider</th><th className="num">{mix.previousMonth}</th><th className="num">{mix.today.slice(0, 7)}</th><th className="num">Change</th></tr></thead>
                <tbody>
                  {mix.rows.map(({ tool, share, priorShare }) => {
                    const delta = share === null || priorShare === null ? null : (share - priorShare) * 100;
                    return (
                      <tr key={tool}>
                        <td><ProviderLabel id={tool} /></td>
                        <td className="num">{shareLabel(priorShare)}</td>
                        <td className="num">{shareLabel(share)}</td>
                        <td className="num">{delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} pp`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No dated usage in either month.</p>
          )}
        </section>
      </div>
    </>
  );
}
