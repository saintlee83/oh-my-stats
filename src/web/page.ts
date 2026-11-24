import type { ReactNode } from 'react';
import type { Deps } from '../server/app.ts';
import type { UserRow } from '../server/db.ts';
import type { Back } from './error.tsx';

/** What a page is given to load from: its address, the request, who is signed in, and the server's parts. */
export interface PageInput {
  url: URL;
  request: Request;
  viewer: UserRow | null;
  deps: Deps;
  /** The parts of the address the page's route names, such as a profile's login. */
  params: Record<string, string>;
}

/** What loading a page comes to: what to draw, an address to go to instead, or nothing to show. */
export type PageResult<Props> = { props: Props } | { redirect: string } | { notFound: true };

/**
 * A page of the website: how it loads, and how it is drawn. Loading does everything that can
 * fail or send the visitor elsewhere, so drawing only lays out what was loaded.
 * app/ serves it through vinext; the tests draw it the same way, without a browser.
 */
export interface PageModule<Props> {
  load(input: PageInput): Promise<PageResult<Props>>;
  View(props: Props): ReactNode;
  /** What a missing page says. Its route's not-found.tsx shows the same words. */
  notFound?: string;
  /** Where a missing page leads back to, when not the home page. */
  notFoundBack?: Back;
}
