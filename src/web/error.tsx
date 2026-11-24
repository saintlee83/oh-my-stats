import type { UserRow } from '../server/db.ts';
import { SITE } from '../server/pages.ts';
import { Layout } from './layout.tsx';

/** Where an error page leads back to. */
export interface Back {
  href: string;
  label: string;
}

const HOME: Back = { href: '/', label: 'Back to the home page' };

/**
 * A page that couldn't be shown: its status, what went wrong, and a way back. A page that
 * gives its own way back, such as a group, is drawn like the server's group notices.
 */
export function ErrorView({ status, message, viewer, back }: { status: number; message: string; viewer: UserRow | null; back?: Back }) {
  return (
    <Layout title={`${status} · ${SITE}`} viewer={viewer}>
      <div className={back ? 'notice group-notice' : 'notice'}>
        <p className="code">{status}</p>
        <h1>{message}</h1>
        <div className="actions">
          <a className="button" href={(back ?? HOME).href}>{(back ?? HOME).label}</a>
        </div>
      </div>
    </Layout>
  );
}

export const PAGE_NOT_FOUND = 'Page not found.';
