import assert from 'node:assert/strict';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { handle, SESSION_COOKIE, viewerFromToken, type Deps } from '../src/server/app.ts';
import { readCookie } from '../src/server/auth.ts';
import { Document } from '../src/web/document.tsx';
import { ErrorView, PAGE_NOT_FOUND } from '../src/web/error.tsx';
import type { PageModule } from '../src/web/page.ts';
import * as boards from '../src/web/pages/boards.tsx';
import * as dashboard from '../src/web/pages/dashboard.tsx';
import { gate, isWorkspace, pageFor, pageHeaders, type PageName } from '../src/web/routes.ts';

/**
 * The website as vinext serves it, without vinext: proxy.ts's checks, then a page from
 * src/web/pages drawn as React draws it on the server, or the server for every other address.
 * Each page module is listed here as app/ serves it.
 */
const PAGES: Partial<Record<PageName, PageModule<any>>> = {
  rankings: boards.rankings,
  providers: boards.providers,
  models: boards.models,
  'my-rankings': boards.myRankings,
  me: dashboard.me,
};

export const TEST_NONCE = 'test-nonce';

/** Every mark a page uses must have its drawing on the page. */
function assertMarksDrawn(html: string, path: string) {
  const used = new Set([...html.matchAll(/<use href="#provider-([a-z0-9_-]+)"\/>/g)].map(([, id]) => id));
  for (const id of used) assert.ok(html.includes(`<symbol id="provider-${id}"`), `${path} draws the mark of ${id}`);
}

export async function site(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return handle(request, deps);
  const url = new URL(request.url);
  const page = pageFor(url.pathname);
  const module = page && PAGES[page.name];
  if (!page || !module) return handle(request, deps);

  const gated = await gate(page, request, deps);
  if ('response' in gated) return gated.response;
  const viewer = await viewerFromToken(readCookie(request, SESSION_COOKIE), deps);
  const draw = (node: ReactNode, status: number) => {
    const html = `<!DOCTYPE html>${renderToStaticMarkup(<Document workspace={isWorkspace(url.pathname)}>{node}</Document>)}`;
    assertMarksDrawn(html, url.pathname);
    return new Response(request.method === 'HEAD' ? null : html, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', ...pageHeaders(TEST_NONCE) },
    });
  };
  if ('error' in gated) return draw(<ErrorView status={gated.error.status} message={gated.error.message} viewer={viewer} />, gated.error.status);
  const result = await module.load({ url, request, viewer, deps, params: page.params });
  // Next's redirect() from a page is a 307.
  if ('redirect' in result) return new Response(null, { status: 307, headers: { location: result.redirect } });
  if ('notFound' in result) return draw(<ErrorView status={404} message={module.notFound ?? PAGE_NOT_FOUND} viewer={viewer} />, 404);
  return draw(<module.View {...result.props} />, 200);
}
