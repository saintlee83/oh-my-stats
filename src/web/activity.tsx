import type { CSSProperties } from 'react';
import { commas, compact, percent, providerName } from '../shared/format.ts';
import { providerMix } from '../shared/insights.ts';
import type { TokenMetrics } from '../shared/metrics.ts';
import { seriesOf, type Series } from '../shared/series.ts';
import { DAY_MODELS, dayData, tokenMix, usagePeriods, type DayData, type Share, type UsagePeriod } from '../shared/usage.ts';
import type { Part } from '../server/pages.ts';
import { ProviderLabel } from './common.tsx';
import { UsageCalendar } from './days.tsx';
import { TabbedPanel } from './panes.tsx';

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

const dayCount = (count: number) => `${commas(count)} ${count === 1 ? 'day' : 'days'}`;

/** A series color. The stylesheet has `--s1` to `--s8`, and `--s0` for names drawn together. */
const seriesColor = (slot: number): CSSProperties => ({ background: `var(--s${slot})` });

/** A share so small that its figure would read as nothing says so instead. */
const shareOf = (share: number) => (share > 0 && share < 0.001 ? '<0.1%' : percent(share));

interface ShareRow {
  key: string;
  label: string;
  slot: number;
  tokens: number;
  share: number;
  /** A provider's ID, for its mark. */
  icon?: string;
}

/**
 * Most used first: each name with a color of its own, and the period's largest few whatever
 * their color, since a color goes by lifetime use and a model that is new can lead a week
 * without one. Every other name is added up in one gray row.
 */
function shareRows(rows: Share[], series: Series[], kind: 'providers' | 'models'): ShareRow[] {
  const known = new Map(series.map((item) => [item.key, item]));
  const row = ({ key, tokens, share }: Share): ShareRow =>
    ({ key, label: known.get(key)?.label ?? key, slot: known.get(key)?.slot ?? 0, tokens, share, icon: kind === 'providers' ? key : undefined });
  const named = rows.filter(({ key }, index) => index < DAY_MODELS || known.get(key)?.slot);
  const others = rows.filter((item) => !named.includes(item));
  // One name left over keeps its row: adding it up would only hide it.
  if (others.length < 2) return rows.map(row);
  const sum = (pick: (item: Share) => number) => others.reduce((total, item) => total + pick(item), 0);
  return [...named.map(row), { key: '', label: `${commas(others.length)} other ${kind}`, slot: 0, tokens: sum((item) => item.tokens), share: sum((item) => item.share) }];
}

/**
 * How a period's tokens split by provider or by model: a thin bar for the split at a glance,
 * then a table that names each part beside its color and gives its figures, so the colors are
 * never the only way to tell the parts apart.
 */
export function ShareBreakdown({ title, kind, rows, series, note, empty }: {
  /** Left out where the panel around it has a heading already. */
  title?: string;
  kind: 'providers' | 'models';
  rows: Share[];
  series: Series[];
  note?: string | null;
  empty: string;
}) {
  const parts = shareRows(rows, series, kind);
  return (
    <div className="breakdown">
      {title ? <h3>{title}</h3> : null}
      {parts.length ? (
        <>
          <div className="mix-bar" role="img" aria-label={parts.map((part) => `${part.label} ${shareOf(part.share)}`).join(', ')}>
            {parts.map((part) => (
              <span key={part.key} style={{ flexGrow: (part.share * 100).toFixed(2), ...seriesColor(part.slot) }} title={`${part.label} · ${shareOf(part.share)} · ${commas(part.tokens)} tokens`}></span>
            ))}
          </div>
          <table className="shares">
            <thead className="sr"><tr><th>{kind === 'providers' ? 'Provider' : 'Model'}</th><th>Tokens</th><th>Share</th></tr></thead>
            <tbody>
              {parts.map((part) => (
                <tr key={part.key}>
                  <td><i style={seriesColor(part.slot)}></i>{part.icon ? <ProviderLabel id={part.icon} /> : part.label}</td>
                  <td className="num" title={`${commas(part.tokens)} tokens`}>{compact(part.tokens)}</td>
                  <td className="num"><strong>{shareOf(part.share)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="muted">{empty}</p>
      )}
      {note ? <p className="muted">{note}</p> : null}
    </div>
  );
}

/** Says when the models listed cover less than the period's tokens, and why. */
export function modelNote({ total, named, models }: Pick<UsagePeriod, 'total' | 'named' | 'models'>): string | null {
  if (!models.length) return null;
  if (named < total * 0.995) return `Models are named for ${compact(named)} of these ${compact(total)} tokens: only logged responses say which model answered.`;
  // A tool's own daily figures can put a logged response on the day before or after its log does.
  if (named > total * 1.005) return `Logged responses name models for ${compact(named)} tokens, more than the ${compact(total)} counted in this period: a tool’s own daily figures can put a response on a neighbouring day.`;
  return null;
}

/** A period's providers and its models, side by side. */
function Breakdowns({ period, series }: { period: UsagePeriod; series: { providers: Series[]; models: Series[] } }) {
  return (
    <div className="breakdowns">
      <ShareBreakdown title="By provider" kind="providers" rows={period.providers} series={series.providers} empty="No usage in this period." />
      <ShareBreakdown title="By model" kind="models" rows={period.models} series={series.models} note={modelNote(period)} empty={period.total ? 'No synced log names a model for this period.' : 'No usage in this period.'} />
    </div>
  );
}

function PeriodPane({ period, undated, series }: { period: UsagePeriod; undated: number; series: { providers: Series[]; models: Series[] } }) {
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
      <Breakdowns period={period} series={series} />
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

/**
 * The calendar, the periods with their providers and models, the token mix and each provider's
 * share from month to month. `days` is what the calendar is drawn from, when the page has
 * worked it out already.
 */
export function ActivityPanels({ tokens, days }: { tokens: TokenMetrics | null; days?: DayData }) {
  if (!tokens) return null;
  const series = seriesOf(tokens);
  const periods = usagePeriods(tokens).map((period) => ({ key: period.key, label: period.label, body: <PeriodPane period={period} undated={tokens.undated} series={series} /> }));
  const mix = providerMix(tokens);
  const shareLabel = (value: number | null) => (value === null ? '—' : percent(value));
  return (
    <>
      <UsageCalendar data={days ?? dayData(tokens)} />
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
