import type { UserRow } from '../server/db.ts';
import { SITE } from '../server/pages.ts';
import { Layout } from './layout.tsx';

/** A page that couldn't be shown: its status, what went wrong, and the way home. */
export function ErrorView({ status, message, viewer }: { status: number; message: string; viewer: UserRow | null }) {
  return (
    <Layout title={`${status} · ${SITE}`} viewer={viewer}>
      <div className="notice">
        <p className="code">{status}</p>
        <h1>{message}</h1>
        <div className="actions">
          <a className="button" href="/">Back to the home page</a>
        </div>
      </div>
    </Layout>
  );
}

export const PAGE_NOT_FOUND = 'Page not found.';
