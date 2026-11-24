import { clientIp, HTML_CSP, isLocalRequest, profilePageKey, SESSION_COOKIE, tooMany, type Deps } from '../server/app.ts';
import { readCookie } from '../server/auth.ts';
import { boardSort } from '../server/boards.ts';
import { rankingPage, rankingPeriod, rankingProvider } from '../server/rankings.ts';
import { BadRequest } from '../server/wire.ts';

/**
 * The website's pages, by address, and what is checked before one is drawn: rate limits and
 * the choices in its address. vinext's proxy runs this; so do the tests, the same way.
 * Every other address, and every request that isn't GET or HEAD, is the server's in src/server/app.ts.
 */

export type PageName =
  | 'landing' | 'how-we-count' | 'privacy' | 'terms'
  | 'rankings' | 'providers' | 'models' | 'my-rankings'
  | 'me' | 'profile' | 'groups' | 'group';

/** The patterns match what app/ routes to each page, so a malformed login reaches the page and is not found there. */
const ROUTES: [PageName, RegExp][] = [
  ['landing', /^\/$/],
  ['how-we-count', /^\/how-we-count$/],
  ['privacy', /^\/privacy$/],
  ['terms', /^\/terms$/],
  ['rankings', /^\/rankings$/],
  ['providers', /^\/rankings\/providers$/],
  ['models', /^\/rankings\/models$/],
  ['my-rankings', /^\/me\/rankings$/],
  ['me', /^\/me$/],
  ['profile', /^\/u\/(?<login>[^/]+)$/],
  ['groups', /^\/groups$/],
  ['group', /^\/groups\/(?<slug>[^/]+)$/],
];

export interface PageMatch {
  name: PageName;
  params: Record<string, string>;
}

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export function pageFor(path: string): PageMatch | null {
  for (const [name, pattern] of ROUTES) {
    const match = pattern.exec(path);
    if (match) return { name, params: Object.fromEntries(Object.entries(match.groups ?? {}).map(([key, value]) => [key, decode(value)])) };
  }
  return null;
}

/** The private dashboard is a workspace, with its own styles. */
export const isWorkspace = (path: string) => pageFor(path)?.name === 'me';

/** What a page may be: drawn, answered here instead, or drawn as an error with its status. */
export type Gate = { pass: true } | { response: Response } | { error: { status: number; message: string } };

/**
 * The checks the server made before drawing each page, made before the page loads: sign-in
 * tokens never cross the network in the clear, a page's rate limit, and the choices in its
 * address, which are refused with a 400 before anything is read.
 */
export async function gate(page: PageMatch, request: Request, deps: Deps): Promise<Gate> {
  const url = new URL(request.url);
  if (url.protocol === 'http:' && !isLocalRequest(request)) {
    url.protocol = 'https:';
    return { response: new Response(null, { status: 308, headers: { location: url.toString(), 'cache-control': 'no-store' } }) };
  }
  const ip = clientIp(request);
  const limited = async (key: string) => Boolean(deps.allow && !(await deps.allow('public', key)));
  const query = (name: string) => url.searchParams.get(name);
  try {
    switch (page.name) {
      case 'rankings':
      case 'providers':
      case 'models':
      case 'my-rankings':
        if (await limited(`rankings:${ip}`)) return { response: tooMany() };
        rankingPeriod(query('days'), deps.now(), true);
        if (page.name === 'rankings') {
          rankingProvider(query('provider'));
          rankingPage(query('page'));
          boardSort(query('sort'));
        }
        break;
      case 'groups':
      case 'group':
        // Counted before the group is looked for, so being turned away says nothing about it.
        if (await limited(`groups:${ip}`)) return { response: tooMany() };
        if (page.name === 'group') rankingPeriod(query('days'), deps.now(), true);
        break;
      case 'profile':
        // A cookie alone proves nothing, so it can't be used to skip the limit. Signed out,
        // the limit applies only when the page isn't kept here already.
        if (readCookie(request, SESSION_COOKIE)) {
          if (await limited(`session:${ip}`)) return { response: tooMany() };
        } else if (!(await deps.cache?.match(profilePageKey(url.origin, page.params.login))) && (await limited(`${ip}:${url.pathname.toLowerCase()}`))) {
          return { response: tooMany() };
        }
        break;
    }
  } catch (error) {
    if (error instanceof BadRequest) return { error: { status: 400, message: error.message } };
    throw error;
  }
  return { pass: true };
}

/** The headers of every page. React's scripts carry the nonce; nothing else on a page may run. */
export function pageHeaders(nonce: string): Record<string, string> {
  return {
    'content-security-policy': `${HTML_CSP}; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'cache-control': 'no-store',
  };
}

/** Headers the proxy passes to a page. Anything a visitor sends under these names is dropped first. */
export const PAGE_URL_HEADER = 'x-oms-url';
export const PAGE_ERROR_HEADER = 'x-oms-error';
