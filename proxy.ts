import { NextResponse, type NextRequest } from 'next/server';
import { handle } from './src/server/app.ts';
import { gate, PAGE_ERROR_HEADER, PAGE_URL_HEADER, pageFor, pageHeaders } from './src/web/routes.ts';
import { depsFor } from './app/_lib/deps.ts';

// Everything but the build's own files: the pages, the server's addresses, and what is posted to either.
export const config = { matcher: ['/((?!_next/).*)'] };

/**
 * The front door. What isn't GET or HEAD is the server's: the API `oms` calls and the website's
 * forms, answered as before. A page gets the server's checks, then a nonce for the scripts React
 * needs. Any other GET goes on to app/[...path]/route.ts, which hands it to the server too.
 */
export async function proxy(request: NextRequest) {
  const deps = depsFor(request);
  if (request.method !== 'GET' && request.method !== 'HEAD') return handle(request, deps);
  const page = pageFor(request.nextUrl.pathname);
  if (!page) return NextResponse.next();

  const gated = await gate(page, request, deps);
  if ('response' in gated) return gated.response;
  const nonce = btoa(crypto.randomUUID());
  const forwarded = new Headers(request.headers);
  forwarded.delete(PAGE_URL_HEADER);
  forwarded.delete(PAGE_ERROR_HEADER);
  forwarded.set(PAGE_URL_HEADER, request.url);
  // React reads the nonce from the request's policy and puts it on every script it writes.
  const policy = pageHeaders(nonce);
  forwarded.set('content-security-policy', policy['content-security-policy']);
  let response: NextResponse;
  if ('error' in gated) {
    forwarded.set(PAGE_ERROR_HEADER, JSON.stringify(gated.error));
    response = NextResponse.rewrite(request.url, { status: gated.error.status, request: { headers: forwarded } });
  } else {
    response = NextResponse.next({ request: { headers: forwarded } });
  }
  for (const [name, value] of Object.entries(policy)) response.headers.set(name, value);
  return response;
}
