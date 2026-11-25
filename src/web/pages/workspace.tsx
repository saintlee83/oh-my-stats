'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { commas, compact, niceMax, percent } from '../../shared/format.ts';
import { lastDays } from '../../shared/time.ts';
import type { DayData } from '../../shared/usage.ts';
import { anchorOf, DayTip, indexDays, shortDate, useReady, type Anchor, type DayInfo, type DayPart } from '../days.tsx';

/**
 * The dashboard's moving parts. Without scripts, the page reads the way the server draws it:
 * every section shown, each nav link an ordinary fragment link, and each chart's last day.
 */

export interface WorkspaceSection {
  id: string;
  label: string;
  /** A figure after the label, such as how many machines there are. */
  count?: number;
  content: ReactNode;
}

/** The section an address points into: the one holding its fragment, or the first. */
function sectionFor(hash: string, sections: WorkspaceSection[]): { section: string; target: HTMLElement | null } {
  const target = hash ? document.getElementById(hash.slice(1)) : null;
  const holder = target?.closest('.workspace-view');
  return { section: holder?.id ?? sections[0].id, target };
}

/**
 * The dashboard's sections, one at a time, chosen by the address's fragment. Following a link
 * into a section, from the nav or from a link such as `#profile-header`, shows that section and
 * scrolls to what the link points at.
 */
export function WorkspaceSections({ sections }: { sections: WorkspaceSection[] }) {
  // Until the script runs, every section is shown.
  const [current, setCurrent] = useState<string | null>(null);
  const currentRef = useRef<string | null>(null);
  // What to scroll to once its section is shown.
  const pending = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const show = (scrollToDetail: boolean) => {
      const { section, target } = sectionFor(location.hash, sections);
      // The skip link points at the page's main element; it leaves the chosen section alone.
      if (target?.id === 'main' && currentRef.current !== null) return;
      const detail = scrollToDetail && target && target.id !== section ? target : null;
      if (currentRef.current === section) {
        detail?.scrollIntoView();
        return;
      }
      currentRef.current = section;
      pending.current = detail;
      setCurrent(section);
    };
    const onHashChange = () => show(true);
    window.addEventListener('hashchange', onHashChange);
    show(true);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [sections]);

  useEffect(() => {
    pending.current?.scrollIntoView();
    pending.current = null;
  }, [current]);

  const choose = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (location.hash !== `#${id}`) history.pushState(null, '', `#${id}`);
    currentRef.current = id;
    setCurrent(id);
  };

  return (
    <>
      <nav className="workspace-nav" aria-label="Dashboard sections">
        {sections.map(({ id, label, count }) => (
          <a key={id} href={`#${id}`} aria-current={current === id ? 'location' : undefined} onClick={(event) => choose(event, id)}>
            {label}
            {count === undefined ? null : <>{' '}<span>{count}</span></>}
          </a>
        ))}
      </nav>
      {sections.map(({ id, label, content }) => (
        <section key={id} id={id} className="workspace-view" aria-label={label} hidden={current !== null && current !== id}>
          {content}
        </section>
      ))}
    </>
  );
}

type ColorBy = 'providers' | 'models';

/** What the daily charts are colored by. The dashboard draws one chart per period, and they share the choice. */
let colorBy: ColorBy = 'providers';
const watchers = new Set<() => void>();
const watch = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};
const chooseColorBy = (next: ColorBy) => {
  colorBy = next;
  for (const watcher of watchers) watcher();
};

/** A series color, or a paler gray for tokens that no model is named for. */
const fill = (slot: number) => (slot < 0 ? 'var(--line)' : `var(--s${slot})`);

/**
 * A day's bar from the baseline up: the same name always in the same place, so a color can be
 * followed across the days. Names without a color of their own are one gray part above them.
 * On top, paler, are the tokens no model is named for: only logged responses name one, so a
 * day's models can cover less than its total, and a day a tool counted itself names none.
 */
export function segments(day: DayInfo | undefined, by: ColorBy): DayPart[] {
  if (!day?.total) return [];
  const parts = by === 'providers' ? day.providers : day.models;
  const named = parts.filter((part) => part.slot > 0).sort((a, b) => a.place - b.place);
  const rest = parts.reduce((sum, part) => sum + (part.slot > 0 ? 0 : part.tokens), 0);
  const unnamed = by === 'models' ? day.total - parts.reduce((sum, part) => sum + part.tokens, 0) : 0;
  return [
    ...named,
    ...(rest ? [{ label: by === 'providers' ? 'Other providers' : 'Other models', slot: 0, place: Infinity, tokens: rest }] : []),
    ...(unnamed > 0 ? [{ label: 'No model named', slot: -1, place: Infinity, tokens: unnamed }] : []),
  ];
}

/**
 * The daily chart of one period: a bar for each day, split by provider or by model. Pointing
 * at a day shows its details. A native slider over the chart does the pointing: it handles
 * dragging, touch, keyboard steps and assistive technology, and a mouse only has to move.
 */
export function ActivityChart({ data, size }: { data: DayData; size: number }) {
  const ready = useReady();
  const by = useSyncExternalStore(watch, () => colorBy, () => 'providers' as ColorBy);
  const lookup = useMemo(() => indexDays(data), [data]);
  const dates = useMemo(() => lastDays(data.today, size), [data.today, size]);
  const [day, setDay] = useState(size);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const slider = useRef<HTMLInputElement>(null);
  const slots = useRef<HTMLDivElement>(null);

  const days = dates.map((date) => lookup.get(date));
  const total = days.reduce((sum, found) => sum + (found?.total ?? 0), 0);
  const max = niceMax(Math.max(2, ...days.map((found) => found?.total ?? 0)));
  const priorStart = lastDays(data.today, size * 2)[0];
  const previous = data.days.reduce((sum, [date, count]) => sum + (date >= priorStart && date < dates[0] ? count : 0), 0);
  const change = previous ? (total - previous) / previous : null;
  const label = (index: number) => `${dates[index]} · ${commas(days[index]?.total ?? 0)} tokens`;

  // Every name the period's bars show, in the order they stack.
  const legend = new Map<string, DayPart>();
  for (const found of days) for (const part of segments(found, by)) if (!legend.has(part.label)) legend.set(part.label, part);
  const keys = [...legend.values()].sort((a, b) => a.place - b.place || b.slot - a.slot);

  // The details sit above a day's bar, or above the baseline on a day without one.
  const show = (index: number) => {
    setDay(index + 1);
    const slot = slots.current?.children[index];
    if (slot) setAnchor(anchorOf(slot.firstElementChild ?? slot));
  };
  const point = (event: PointerEvent<HTMLInputElement>) => {
    if (event.pointerType !== 'mouse' || event.buttons || !slider.current) return;
    const rect = slider.current.getBoundingClientRect();
    const index = Math.floor(((event.clientX - rect.left) / rect.width) * size);
    show(Math.max(0, Math.min(index, size - 1)));
  };
  // A page that scrolls leaves the details behind, so they go.
  const shown = anchor !== null;
  useEffect(() => {
    if (!shown) return;
    const hide = () => setAnchor(null);
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, { capture: true });
      window.removeEventListener('resize', hide);
    };
  }, [shown]);

  return (
    <section className="trend-card" aria-label={`Daily token usage, last ${size} days`}>
      <h2>Token activity</h2>
      <div className="trend-total" title={`${commas(total)} tokens`}>{compact(total)} <span>tokens</span></div>
      <p className="trend-range">
        {change !== null
          ? <><strong>{`${change > 0 ? '+' : ''}${percent(change)}`}</strong>{` vs prior ${size} days`}</>
          : `${shortDate(dates[0])} – ${shortDate(dates[size - 1])}`}
      </p>
      <div className="plot-area">
        <div className="plot-scale" aria-hidden="true"><span>{compact(max)}</span><span>{compact(max / 2)}</span><span>0</span></div>
        <div className="plot">
          <div className="plot-slots" ref={slots}>
            {days.map((found, index) => {
              const stack = segments(found, by);
              const whole = stack.reduce((sum, part) => sum + part.tokens, 0);
              return (
                <span key={index} className={ready && index === day - 1 ? 'plot-slot selected' : 'plot-slot'} title={ready ? undefined : label(index)}>
                  {stack.length ? (
                    <i className="plot-bar" style={{ height: `${((100 * (found?.total ?? 0)) / max).toFixed(2)}%` }}>
                      {stack.map((part, at) => <b key={at} style={{ flexGrow: ((100 * part.tokens) / whole).toFixed(2), background: fill(part.slot) }}></b>)}
                    </i>
                  ) : null}
                </span>
              );
            })}
          </div>
          <input
            ref={slider}
            hidden={!ready}
            type="range"
            min="1"
            max={size}
            value={day}
            aria-label="Inspect daily token usage"
            aria-valuetext={ready ? label(day - 1) : undefined}
            onChange={(event) => show(event.currentTarget.valueAsNumber - 1)}
            // A tap on the day already chosen changes nothing, and a touch sends no click to a
            // slider, so lifting the finger asks for the details itself.
            onPointerUp={(event) => { if (event.pointerType !== 'mouse') show(event.currentTarget.valueAsNumber - 1); }}
            onPointerMove={point}
            onPointerLeave={(event) => { if (event.pointerType === 'mouse') setAnchor(null); }}
            onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) show(day - 1); }}
            onBlur={() => setAnchor(null)}
          />
        </div>
      </div>
      <div className="plot-dates" aria-hidden="true"><span>{shortDate(dates[0])}</span><span>{shortDate(dates[Math.floor(size / 2)])}</span><span>{shortDate(dates[size - 1])}</span></div>
      <div className="plot-keys">
        {ready ? (
          <span className="switch" role="group" aria-label="Color the bars by">
            <button type="button" aria-pressed={by === 'providers'} onClick={() => chooseColorBy('providers')}>Providers</button>
            <button type="button" aria-pressed={by === 'models'} onClick={() => chooseColorBy('models')}>Models</button>
          </span>
        ) : null}
        {keys.length ? (
          <ul aria-label={by === 'providers' ? 'Providers' : 'Models'}>
            {keys.map((part) => <li key={part.label}><i style={{ background: fill(part.slot) }}></i>{part.label}</li>)}
          </ul>
        ) : null}
      </div>
      <p className="plot-detail"><span>{ready ? 'Selected day' : 'Daily total'}</span> <b>{label(day - 1)}</b></p>
      {anchor ? <DayTip date={dates[day - 1]} day={days[day - 1]} anchor={anchor} /> : null}
    </section>
  );
}
