import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { SESSION_COOKIE, viewerFromToken } from '../../src/server/app.ts';
import { readCookie } from '../../src/server/auth.ts';
import type { UserRow } from '../../src/server/db.ts';
import { ErrorView } from '../../src/web/error.tsx';
import type { PageModule } from '../../src/web/page.ts';
import { PAGE_ERROR_HEADER, PAGE_URL_HEADER } from '../../src/web/routes.ts';
import { depsFor } from './deps.ts';

/** The request as the proxy saw it: its full address, and the visitor's headers. */
async function currentRequest(): Promise<Request> {
  const sent = await headers();
  return new Request(sent.get(PAGE_URL_HEADER) ?? `https://${sent.get('host')}/`, { headers: sent });
}

export async function currentViewer(request?: Request): Promise<UserRow | null> {
  const asked = request ?? (await currentRequest());
  return viewerFromToken(readCookie(asked, SESSION_COOKIE), depsFor(asked));
}

/**
 * Draws a page under app/: who is signed in, then what the page loads. The proxy has already
 * run its checks; when one failed, it says so in a header and the page draws that error with
 * the status the proxy set.
 */
export async function serve<Props extends object>(page: PageModule<Props>, params: Record<string, string> = {}) {
  const request = await currentRequest();
  const deps = depsFor(request);
  const viewer = await currentViewer(request);
  const refused = request.headers.get(PAGE_ERROR_HEADER);
  if (refused) {
    const { status, message } = JSON.parse(refused) as { status: number; message: string };
    return <ErrorView status={status} message={message} viewer={viewer} />;
  }
  const result = await page.load({ url: new URL(request.url), request, viewer, deps, params });
  if ('redirect' in result) redirect(result.redirect);
  if ('notFound' in result) notFound();
  return <page.View {...result.props} />;
}
