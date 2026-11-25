import type { ReactNode } from 'react';

/**
 * Panes switched without scripts: a radio for each, then their labels, then the panes. The
 * stylesheet pairs the nth radio with the nth label and the nth pane, for five at most.
 * It keeps no state of its own, so a page can draw it on the server or in the browser.
 */
export function TabbedPanel({ name, title, panes, id }: { name: string; title: string; panes: { key: string; label: string; body: ReactNode }[]; id?: string }) {
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
