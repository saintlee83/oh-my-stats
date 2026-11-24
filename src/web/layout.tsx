import type { ReactNode } from 'react';
import type { UserRow } from '../server/db.ts';
import { DESCRIPTION, REPO_URL, SITE, type PageOptions } from '../server/pages.ts';
import { OTHER_PROVIDER_ICON, PROVIDER_ICONS } from '../server/provider-icons.ts';
import { Avatar, iconId } from './common.tsx';

interface LayoutProps extends Omit<PageOptions, 'dashboard'> {
  title: string;
  viewer: UserRow | null;
  /** Every tool the page marks, so each drawing is on the page once however many rows show it. */
  icons?: Iterable<string>;
  children: ReactNode;
}

/**
 * The frame every page shares: what the page says about itself, the header and the footer
 * around its body. React puts the title and the meta tags in the document's head. A page that
 * gives no address is one only its owner sees, or an error, so search engines are asked to
 * leave it out.
 */
export function Layout({ title, viewer, icons = [], children, ...page }: LayoutProps) {
  const description = page.description ?? DESCRIPTION;
  const image = page.image
    ?? (page.origin ? { url: `${page.origin}/og.png`, width: 2400, height: 1260, alt: `${SITE}. Your real developer stats, from every machine.` } : null);
  const marks = [...new Set([...icons].map(iconId))];
  return (
    <>
      <title>{title}</title>
      <meta name="description" content={description} />
      {page.origin ? null : <meta name="robots" content="noindex" />}
      <meta property="og:site_name" content={SITE} />
      <meta property="og:type" content="website" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      {image ? (
        <>
          <meta property="og:image" content={image.url} />
          <meta property="og:image:width" content={String(image.width)} />
          <meta property="og:image:height" content={String(image.height)} />
          <meta property="og:image:alt" content={image.alt} />
          <meta name="twitter:card" content="summary_large_image" />
        </>
      ) : (
        <meta name="twitter:card" content="summary" />
      )}
      <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)" />
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <a className="skip" href="#main">Skip to content</a>
      {marks.length ? (
        <svg className="marks" width="0" height="0" aria-hidden="true">
          {marks.map((id) => (
            <symbol key={id} id={`provider-${id}`} viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: PROVIDER_ICONS.get(id) ?? OTHER_PROVIDER_ICON }} />
          ))}
        </svg>
      ) : null}
      <header className="top">
        <div className="bar">
          <a className="brand" href="/">
            <img src="/favicon.svg" alt="" width={26} height={26} />
            {SITE}
          </a>
          <nav className="links" aria-label="Main navigation">
            <a href="/rankings">Rankings</a>
            <a href="/groups">Groups</a>
            {viewer ? (
              <a className="button" href="/me">
                <Avatar url={viewer.avatar_url} size={20} />
                {`@${viewer.login}`}
              </a>
            ) : (
              <a className="button" href="/login">Sign in</a>
            )}
          </nav>
        </div>
      </header>
      <main id="main" className={page.bleed ? 'bleed' : undefined}>
        {children}
      </main>
      <footer className="bottom">
        <div className="bar">
          <p>{`${SITE} is open source, under the MIT license.`}</p>
          <nav aria-label="Footer">
            <a href="/rankings">Rankings</a>
            <a href="/how-we-count">How we count</a>
            <a href={`${REPO_URL}#get-started`}>Install</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href={REPO_URL}>GitHub</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
