import type { UserRow } from '../../server/db.ts';
import { SITE } from '../../server/pages.ts';
import { READING, type ReadingPage } from '../../server/reading.ts';
import { Layout } from '../layout.tsx';
import type { PageModule } from '../page.ts';

/** The pages that explain the service in words. Their words are in src/server/reading.ts. */

interface ReadingProps {
  page: ReadingPage;
  viewer: UserRow | null;
  origin: string;
}

/**
 * Each section has its heading beside it, so a long page can be scanned down one edge. A
 * section's body is prose written in this repository, with its own markup, so it goes on the
 * page as written.
 */
function ReadingView({ page, viewer, origin }: ReadingProps) {
  return (
    <Layout title={`${page.title} · ${SITE}`} viewer={viewer} origin={origin} description={page.description}>
      <div className="page-head">
        <div>
          <h1>{page.title}</h1>
          <p>{page.lead}</p>
          {page.updated ? <p className="muted">Last updated <time dateTime={page.updated}>{page.updated}</time></p> : null}
        </div>
      </div>
      <nav className="filters jump" aria-label="On this page">
        {page.sections.map(([id, title]) => <a key={id} href={`#${id}`}>{title}</a>)}
      </nav>
      <article className="reading">
        {page.sections.map(([id, title, body]) => (
          <section key={id} id={id}>
            <h2>{title}</h2>
            <div dangerouslySetInnerHTML={{ __html: body }} />
          </section>
        ))}
      </article>
    </Layout>
  );
}

function readingModule(path: string): PageModule<ReadingProps> {
  const page = READING.get(path);
  if (!page) throw new Error(`No reading page at ${path}`);
  return {
    async load({ viewer, url }) {
      return { props: { page, viewer, origin: url.origin } };
    },
    View: ReadingView,
  };
}

export const howWeCount = readingModule('/how-we-count');
export const privacy = readingModule('/privacy');
export const terms = readingModule('/terms');
