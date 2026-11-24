import type { ComponentKey } from '../shared/render/svg.ts';
import { commas } from '../shared/format.ts';
import type { UserRow } from './db.ts';
import type { RankingPeriod, Standing } from './rankings.ts';
import { STYLE } from './style.ts';

/**
 * The pages the server draws itself: errors and the answers to forms, which come from
 * route handlers and the proxy rather than from React. The website's pages are in src/web.
 * Every value from a user or machine goes through `esc`.
 */

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

export const REPO_URL = 'https://github.com/saintlee83/oh-my-stats';
export const HOSTED_ORIGIN = 'https://ohmystats.dev';
export const SITE = 'oh-my-stats';
export const DESCRIPTION = 'Your AI tokens and GitHub contributions in one place, from every machine, with private work included.';
export const AVATARS = 'https://avatars.githubusercontent.com';

export const GITHUB_MARK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>';

/** A GitHub avatar at twice the size it's drawn, for sharp screens. The page may load images from nowhere else. */
export function avatar(url: string | null, size: number): string {
  if (!url) return '';
  try {
    const sized = new URL(url);
    if (sized.protocol !== 'https:' || sized.origin !== AVATARS) return '';
    sized.searchParams.set('s', String(size * 2));
    return `<img src="${esc(sized)}" alt="" width="${size}" height="${size}">`;
  } catch {
    return '';
  }
}

/**
 * What a page says about itself. A page worth sharing gives the address it's served from, and
 * gets the preview image: sites that show link previews only follow a full address.
 */
export interface PageOptions {
  description?: string;
  bleed?: boolean;
  origin?: string;
  /** A preview image of the page's own, by its full address, in place of the site's banner. */
  image?: { url: string; width: number; height: number; alt: string };
}

/**
 * The frame every page shares: the head, the header and the footer around a body. A page that
 * gives no address is one only its owner sees, or an error, so search engines are asked to leave it out.
 */
export function layout(title: string, body: string, viewer: UserRow | null, page: PageOptions = {}): string {
  const description = esc(page.description ?? DESCRIPTION);
  const image = page.image
    ?? (page.origin ? { url: `${page.origin}/og.png`, width: 2400, height: 1260, alt: `${SITE}. Your real developer stats, from every machine.` } : null);
  const preview = image
    ? `<meta property="og:image" content="${esc(image.url)}">
<meta property="og:image:width" content="${image.width}">
<meta property="og:image:height" content="${image.height}">
<meta property="og:image:alt" content="${esc(image.alt)}">
<meta name="twitter:card" content="summary_large_image">`
    : '<meta name="twitter:card" content="summary">';
  const account = viewer
    ? `<a class="button" href="/me">${avatar(viewer.avatar_url, 20)}@${esc(viewer.login)}</a>`
    : '<a class="button" href="/login">Sign in</a>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${description}">
${page.origin ? '' : '<meta name="robots" content="noindex">\n'}<meta property="og:site_name" content="${SITE}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${description}">
${preview}
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${STYLE}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="bar"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="26" height="26">${SITE}</a><nav class="links" aria-label="Main navigation"><a href="/rankings">Rankings</a><a href="/groups">Groups</a>${account}</nav></div></header>
<main id="main"${page.bleed ? ' class="bleed"' : ''}>${body}</main>
<footer class="bottom"><div class="bar"><p>${SITE} is open source, under the MIT license.</p><nav aria-label="Footer"><a href="/rankings">Rankings</a><a href="/how-we-count">How we count</a><a href="${REPO_URL}#get-started">Install</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${REPO_URL}">GitHub</a></nav></div></footer>
</body>
</html>
`;
}

/** What a list of profiles can show beyond their logins: the viewer's own row, names, and a cost that leads the tokens. */
export interface ProfileRows {
  viewer: string | null;
  /** Shows a row's `name` above its login, when it has one. */
  names?: boolean;
  /** The heading of a column for each row's `cost`. The list is then measured by cost. */
  cost?: string;
}

export const periodLabel = (days: RankingPeriod['days']) =>
  days === 'all' ? 'All time' : days === 'month' ? 'This month' : days === 'last-month' ? 'Last month' : `Last ${days} days`;

/** The heading of a board's token column, which says what stretch the tokens are from. */
export const tokenColumnLabel = (days: RankingPeriod['days']) =>
  days === 'all' ? 'Lifetime tokens' : typeof days === 'number' ? `Tokens (${days} days)` : `Tokens (${periodLabel(days).toLowerCase()})`;

export const profileCount = (count: number) => `${commas(count)} ranked public ${count === 1 ? 'profile' : 'profiles'}`;

/** What the landing page shows of the public rankings. */
export interface LandingBoard {
  leaders: Standing[];
  participants: number;
  /** What every ranked profile has used together, all time. */
  tokens: number;
}

export type Part = { key: ComponentKey; label: string };

export function errorPage(status: number, message: string, viewer: UserRow | null): string {
  return layout(`${status} · ${SITE}`, `<div class="notice"><p class="code">${status}</p><h1>${esc(message)}</h1>
<div class="actions"><a class="button" href="/">Back to the home page</a></div></div>`, viewer);
}
