import type { UserRow } from './db.ts';
import { esc, layout, SITE } from './pages.ts';

/** The answers to the group forms that aren't a redirect. The group pages themselves are in src/web/pages/groups.tsx. */

/** A refusal: what happened, what to do about it, and a way back. */
export function groupNotice(status: number, title: string, detail: string, back: { href: string; label: string }, viewer: UserRow | null): string {
  return layout(`${status} · ${SITE}`, `<div class="notice group-notice"><p class="code">${status}</p><h1>${esc(title)}</h1>
${detail ? `<p>${esc(detail)}</p>` : ''}
<div class="actions"><a class="button" href="${esc(back.href)}">${esc(back.label)}</a></div></div>`, viewer);
}
