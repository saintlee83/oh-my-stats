'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { commas, compact, percent } from '../shared/format.ts';
import type { Series } from '../shared/series.ts';
import { usageCalendar, type CalendarDay, type CalendarView, type DayData } from '../shared/usage.ts';
import { TabbedPanel } from './panes.tsx';

/**
 * The days a page draws, and what one says when it is pointed at: its tokens, by provider and
 * by model. Without scripts a day with usage still says its total in the browser's own tooltip;
 * with them, the same days answer to a mouse, a tap and the arrow keys.
 */

export interface DayPart {
  label: string;
  /** A series color, 1 to 8, or 0 for names drawn together. */
  slot: number;
  /** Its place among the profile's providers or models, most used first, or -1 for the rest of a day's models. */
  place: number;
  tokens: number;
}

export interface DayInfo {
  date: string;
  total: number;
  providers: DayPart[];
  /** What logged responses name a model for. Empty on a day only a tool's own figure covers. */
  models: DayPart[];
}

function parts(pairs: number[], names: Series[], rest: string): DayPart[] {
  const out: DayPart[] = [];
  for (let index = 0; index < pairs.length; index += 2) {
    const name = names[pairs[index]];
    out.push({ label: name?.label ?? rest, slot: name?.slot ?? 0, place: name ? pairs[index] : -1, tokens: pairs[index + 1] });
  }
  return out;
}

/** Each day with usage, by its date. */
export function indexDays(data: DayData): Map<string, DayInfo> {
  return new Map(data.days.map(([date, total, providers, models]) => [
    date,
    { date, total, providers: parts(providers, data.providers, 'Other providers'), models: parts(models, data.models, 'Other models') },
  ]));
}

/** False on the server and until the page's scripts run, so both draw the same thing first. */
export function useReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}

const LONG_DATE = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Mon, Nov 24, 2026 */
export const longDate = (date: string) => LONG_DATE.format(new Date(`${date}T00:00:00Z`));

const shareOf = (tokens: number, whole: number) => {
  const share = whole > 0 ? tokens / whole : 0;
  return share > 0 && share < 0.001 ? '<0.1%' : percent(share, share < 0.1 ? 1 : 0);
};

const sum = (rows: DayPart[]) => rows.reduce((total, row) => total + row.tokens, 0);

/** A day as one sentence, for a screen reader moving through the days with the arrow keys. */
function sentence(date: string, day: DayInfo | undefined): string {
  if (!day) return `${longDate(date)}: no usage.`;
  const providers = day.providers.map((part) => `${part.label} ${shareOf(part.tokens, day.total)}`).join(', ');
  return `${longDate(date)}: ${commas(day.total)} tokens. ${providers}.`;
}

/** Where on the screen what is pointed at is, so its details can sit beside it. */
export interface Anchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const anchorOf = (element: Element): Anchor => {
  const { left, right, top, bottom } = element.getBoundingClientRect();
  return { left, right, top, bottom };
};

function TipRows({ title, rows, whole }: { title: string; rows: DayPart[]; whole: number }) {
  return (
    <>
      <p className="tip-head">{title}</p>
      {rows.map((row, index) => (
        // The figure leads and the name follows: whoever points at a day wants its numbers.
        <p key={index} className="tip-row">
          <i style={{ background: `var(--s${row.slot})` }}></i>
          <span>{row.label}</span>
          <b>{compact(row.tokens)}</b>
          <em>{shareOf(row.tokens, whole)}</em>
        </p>
      ))}
    </>
  );
}

/**
 * A day's details, floating beside what was pointed at: above it where there is room, below
 * otherwise, and never past the edge of the screen. It is drawn for sighted readers; everything
 * in it is also in the page's tables, and a screen reader hears the day as a sentence instead.
 */
export function DayTip({ date, day, anchor }: { date: string; day: DayInfo | undefined; anchor: Anchor }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tip = box.current;
    if (!tip) return;
    const { width, height } = tip.getBoundingClientRect();
    const edge = 8;
    const left = (anchor.left + anchor.right) / 2 - width / 2;
    const above = anchor.top - height - 10;
    tip.style.left = `${Math.round(Math.max(edge, Math.min(left, document.documentElement.clientWidth - width - edge)))}px`;
    tip.style.top = `${Math.round(above >= edge ? above : anchor.bottom + 10)}px`;
    tip.style.visibility = 'visible';
  });
  const named = day ? sum(day.models) : 0;
  return (
    <div ref={box} className="tip" aria-hidden="true" style={{ visibility: 'hidden' }}>
      <p className="tip-date">{longDate(date)}</p>
      {day ? (
        <>
          <p className="tip-total"><strong>{commas(day.total)}</strong> tokens</p>
          <TipRows title="Providers" rows={day.providers} whole={day.total} />
          {day.models.length ? <TipRows title="Models" rows={day.models} whole={named} /> : null}
          {day.models.length && Math.abs(named - day.total) > day.total * 0.01 ? <p className="tip-note">{`Models from synced logs: ${compact(named)} tokens`}</p> : null}
        </>
      ) : (
        <p className="tip-total">No usage</p>
      )}
    </div>
  );
}

const DAY = 86_400_000;
const shifted = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** Weeks are columns with Monday on top, so left and right move a week and up and down move a day. */
const MOVES: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };

const cellOf = (target: EventTarget) => (target instanceof Element ? target.closest('[data-date]') : null);

/**
 * What makes days answer when they are pointed at. `bind` goes on anything that holds
 * elements carrying a `data-date`; `tip` is drawn once, wherever the page likes.
 * A mouse shows a day by moving over it, a finger by tapping it, and a keyboard by focusing
 * the days and moving with the arrow keys.
 */
export function useDayTips(days: Map<string, DayInfo>) {
  const [shown, setShown] = useState<{ date: string; anchor: Anchor } | null>(null);
  const [spoken, setSpoken] = useState('');
  const marked = useRef<Element | null>(null);

  const point = useCallback((cell: Element | null, speak = false) => {
    if (cell === marked.current) return;
    marked.current?.classList.remove('on');
    marked.current = cell;
    const date = cell?.getAttribute('data-date');
    if (!cell || !date) return setShown(null);
    cell.classList.add('on');
    setShown({ date, anchor: anchorOf(cell) });
    if (speak) setSpoken(sentence(date, days.get(date)));
  }, [days]);

  const visible = shown !== null;
  useEffect(() => {
    if (!visible) return;
    // The days can scroll under the pointer, so the details follow the day they describe.
    const follow = () => {
      const cell = marked.current;
      const date = cell?.getAttribute('data-date');
      if (cell && date) setShown({ date, anchor: anchorOf(cell) });
    };
    const away = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-date]')) point(null);
    };
    window.addEventListener('scroll', follow, { capture: true, passive: true });
    window.addEventListener('resize', follow);
    document.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('scroll', follow, { capture: true });
      window.removeEventListener('resize', follow);
      document.removeEventListener('pointerdown', away);
    };
  }, [visible, point]);

  const bind = useMemo(() => ({
    onPointerMove(event: PointerEvent<HTMLElement>) {
      // Between two days the last one stays shown, so the details don't flicker on the way across.
      const cell = event.pointerType === 'touch' ? null : cellOf(event.target);
      if (cell) point(cell);
    },
    onPointerLeave(event: PointerEvent<HTMLElement>) {
      if (event.pointerType !== 'touch') point(null);
    },
    onClick(event: MouseEvent<HTMLElement>) {
      point(cellOf(event.target));
    },
    onFocus(event: FocusEvent<HTMLElement>) {
      const holder = event.currentTarget;
      if (event.target !== holder || !holder.matches(':focus-visible')) return;
      // Start at the newest day with usage, or the newest day.
      const used = holder.querySelectorAll('[data-date][data-level]:not([data-level="0"])');
      const all = holder.querySelectorAll('[data-date]');
      point(used[used.length - 1] ?? all[all.length - 1] ?? null, true);
    },
    onBlur() {
      point(null);
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key === 'Escape') return point(null);
      const move = MOVES[event.key];
      const from = marked.current?.getAttribute('data-date');
      if (!move || !from || !event.currentTarget.contains(marked.current)) return;
      event.preventDefault();
      const next = event.currentTarget.querySelector(`[data-date="${shifted(from, move)}"]`);
      if (!next) return;
      next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      point(next, true);
    },
  }), [point]);

  const day = shown ? days.get(shown.date) : undefined;
  const tip = (
    <>
      {shown ? <DayTip date={shown.date} day={day} anchor={shown.anchor} /> : null}
      <span className="sr" aria-live="polite">{spoken}</span>
    </>
  );
  return { bind, tip };
}

type Bind = ReturnType<typeof useDayTips>['bind'];

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

interface PaneProps {
  view: CalendarView;
  newest: boolean;
  ready: boolean;
  days: Map<string, DayInfo>;
  bind: Bind;
}

/**
 * One view of the calendar, weeks as columns. Until the scripts run, a day with usage says its
 * total in a title, and in the newest view its providers too: a breakdown written out for
 * every day of every year would outweigh the rest of the page.
 */
const CalendarPane = memo(function CalendarPane({ view, newest, ready, days, bind }: PaneProps) {
  const title = (day: CalendarDay) => {
    if (ready || !day.total) return undefined;
    const providers = newest ? days.get(day.date)?.providers.map((part) => `${part.label} ${compact(part.tokens)}`).join(', ') : '';
    return `${day.date} · ${commas(day.total)} tokens${providers ? ` · ${providers}` : ''}`;
  };
  const cell = (day: CalendarDay | null, index: number) =>
    day ? <span key={index} className="day" data-level={day.level || undefined} data-date={day.date} title={title(day)}></span> : <span key={index}></span>;
  const summary = `AI usage per day from ${view.start} to ${view.end}: ${view.total ? `${commas(view.total)} tokens on ${dayCount(view.activeDays)}` : 'none'}.`;
  return (
    <>
      <p className="muted">
        {`${view.start} – ${view.end} · `}
        {view.total ? `${compact(view.total)} tokens on ${dayCount(view.activeDays)}` : 'No dated usage.'}
        {ready && view.total ? ' · Point at a day for its providers and models.' : null}
      </p>
      <div className={`weeks-scroll${newest ? ' newest' : ''}`}>
        <div className="weeks-fit">
          <div className="weeks" role="group" aria-label={ready ? `${summary} Use the arrow keys to read each day.` : summary} tabIndex={ready && view.total ? 0 : undefined} {...bind}>
            {WEEKDAY_LABELS.map((label, index) => (label ? <small key={index} aria-hidden="true">{label}</small> : <span key={index}></span>))}
            {view.weeks.map(({ month, days: week }, column) => [
              month ? <small key={`m${column}`} aria-hidden="true">{month}</small> : <span key={`m${column}`}></span>,
              ...week.map((day, index) => cell(day, column * 7 + index)),
            ])}
          </div>
          <Scale />
        </div>
      </div>
    </>
  );
});

/** The calendar: the last 12 months, then each year with usage, switched without scripts. */
export function UsageCalendar({ data }: { data: DayData }) {
  const days = useMemo(() => indexDays(data), [data]);
  const views = useMemo(() => usageCalendar(data), [data]);
  const ready = useReady();
  const { bind, tip } = useDayTips(days);
  const panes = views.map((view, index) => ({
    key: view.key,
    label: view.label,
    body: <CalendarPane view={view} newest={index === 0} ready={ready} days={days} bind={bind} />,
  }));
  return (
    <>
      <TabbedPanel name="range" title="AI usage calendar" panes={panes} />
      {tip}
    </>
  );
}

const SHORT_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Nov 24 */
export const shortDate = (date: string) => SHORT_DATE.format(new Date(`${date}T00:00:00Z`));

const LEVELS = [0, 1, 2, 3, 4];

/** The last 26 weeks at a glance, for the top of the private dashboard. */
export function HeatSummary({ data }: { data: DayData }) {
  const days = useMemo(() => indexDays(data), [data]);
  const view = useMemo(() => usageCalendar(data)[0], [data]);
  const ready = useReady();
  const { bind, tip } = useDayTips(days);
  const weeks = view.weeks.slice(-26);
  const from = weeks[0].days[0]!.date;
  const label = `Daily token activity from ${from} to ${view.end}.`;
  return (
    <div className="calendar-summary">
      <div className="calendar-heading"><h2>Daily token activity</h2><a href="#activity">View activity <span aria-hidden="true">→</span></a></div>
      <div className="heat-grid" role="group" aria-label={ready ? `${label} Use the arrow keys to read each day.` : label} tabIndex={ready ? 0 : undefined} {...bind}>
        {weeks.map((week, index) => (
          <div key={index} className="heat-week">
            <small>{week.month ?? ''}</small>
            {week.days.map((day, at) => (day
              ? <i key={at} data-level={day.level} data-date={day.date} title={ready ? undefined : `${day.date} · ${commas(day.total)} tokens`}></i>
              : <i key={at}></i>))}
          </div>
        ))}
      </div>
      <div className="heat-caption">
        <span>{`${shortDate(from)} – ${shortDate(view.end)}`}</span>
        <span className="heat-key">{'Less '}{LEVELS.map((level) => <i key={level} data-level={level}></i>)}{' More'}</span>
      </div>
      {tip}
    </div>
  );
}
