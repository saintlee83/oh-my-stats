'use client';

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from 'react';

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

export interface TrendDay {
  /** The day and its total, as the chart's tooltip and its detail line say them. */
  label: string;
  /** How far down from the top the day's point is, as a share of the chart's height. */
  y: number;
}

interface TrendCardProps {
  size: number;
  total: string;
  exactTotal: string;
  range: ReactNode;
  max: string;
  half: string;
  /** The polyline's points, slot centers left to right. */
  points: string;
  halfSlot: number;
  dates: [first: string, middle: string, last: string];
  days: TrendDay[];
}

/**
 * The daily chart of one period. A native slider over the chart picks a day: it handles
 * dragging, touch, keyboard steps and assistive technology, and a mouse only has to point.
 */
export function TrendCard({ size, total, exactTotal, range, max, half, points, halfSlot, dates, days }: TrendCardProps) {
  const [ready, setReady] = useState(false);
  const [day, setDay] = useState(days.length);
  const slider = useRef<HTMLInputElement>(null);
  useEffect(() => setReady(true), []);
  const shown = days[day - 1];

  const point = (event: PointerEvent<HTMLInputElement>) => {
    if (event.pointerType !== 'mouse' || event.buttons || !slider.current) return;
    const rect = slider.current.getBoundingClientRect();
    const index = Math.floor(((event.clientX - rect.left) / rect.width) * days.length);
    setDay(Math.max(0, Math.min(index, days.length - 1)) + 1);
  };

  return (
    <section className="trend-card" aria-label={`Daily token usage, last ${size} days`}>
      <h2>Token activity</h2>
      <div className="trend-total" title={exactTotal}>{total} <span>tokens</span></div>
      <p className="trend-range">{range}</p>
      <div className="plot-area">
        <div className="plot-scale" aria-hidden="true"><span>{max}</span><span>{half}</span><span>0</span></div>
        <div className="plot">
          <svg className="trend-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id={`fill-${size}`} x2="0" y2="1" gradientUnits="objectBoundingBox">
                <stop stopColor="currentColor" stopOpacity=".24" />
                <stop offset="1" stopColor="currentColor" stopOpacity=".025" />
              </linearGradient>
            </defs>
            <polygon points={`${halfSlot},100 ${points} ${100 - halfSlot},100`} fill={`url(#fill-${size})`} />
            <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="plot-slots">
            {days.map(({ label, y }, index) => (
              <span key={index} className={ready && index === day - 1 ? 'plot-slot selected' : 'plot-slot'} title={label} style={{ '--y': `${y}%` } as CSSProperties}></span>
            ))}
          </div>
          <input
            ref={slider}
            hidden={!ready}
            type="range"
            min="1"
            max={size}
            value={day}
            aria-label="Inspect daily token usage"
            aria-valuetext={ready ? shown.label : undefined}
            onChange={(event) => setDay(event.currentTarget.valueAsNumber)}
            onPointerMove={point}
          />
        </div>
      </div>
      <div className="plot-dates" aria-hidden="true"><span>{dates[0]}</span><span>{dates[1]}</span><span>{dates[2]}</span></div>
      <p className="plot-detail"><span>{ready ? 'Selected day' : 'Daily total'}</span> <b>{shown.label}</b></p>
    </section>
  );
}
