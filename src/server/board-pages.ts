import { commas, compact, money, percent, PROVIDERS, providerName } from '../shared/format.ts';
import { CHANGE_BASE, type BoardSort, type Change, type CostBoard, type ModelBoard, type ProviderBoard } from './boards.ts';
import type { UserRow } from './db.ts';
import { costFigures, esc, figure, GITHUB_MARK, layout, periodLabel, profileCount, providerLabel, REPO_URL, SITE, standings, tokenColumnLabel } from './pages.ts';
import { BOARD_PAGE, type Board, type PersonalRankings, type PublicPosition, type RankingPeriod } from './rankings.ts';

/** The pages of the boards under /rankings, and of the signed-in viewer's own rankings. */

type Days = RankingPeriod['days'];

const PERIODS: Days[] = ['all', 7, 30, 'month', 'last-month'];
const BOARDS = [['/rankings', 'Profiles'], ['/rankings/providers', 'Providers'], ['/rankings/models', 'Models']];

const current = (active: boolean) => (active ? ' aria-current="page"' : '');

/** What narrows or orders the profiles board. */
interface View {
  provider?: string | null;
  sort?: BoardSort;
  page?: number;
}

/** A board's address. The usual order and the first page are left out, so each view has one address. */
function address(path: string, days: Days, { provider = null, sort = 'tokens', page = 1 }: View = {}): string {
  const chosen = provider === null ? '' : `&amp;provider=${esc(encodeURIComponent(provider))}`;
  return `${path}?days=${days}${chosen}${sort === 'cost' ? '&amp;sort=cost' : ''}${page > 1 ? `&amp;page=${page}` : ''}`;
}

const periodNav = (period: RankingPeriod, link: (days: Days) => string) =>
  `<nav class="segments" aria-label="Ranking periods">${PERIODS.map(days => `<a href="${link(days)}"${current(period.days === days)}>${periodLabel(days)}</a>`).join('')}</nav>`;

const viewNav = (days: Days, everyone: boolean) =>
  `<nav class="segments" aria-label="Ranking views"><a href="/rankings?days=${days}"${current(everyone)}>Everyone</a><a href="/me/rankings?days=${days}"${current(!everyone)}>Mine</a></nav>`;

/** The days a period covers. Last month is over, so it does not run through today. */
const dates = (period: RankingPeriod) =>
  period.days === 'all' ? '' : `<p class="muted">${period.start} through ${period.end} · Reporting dates ${period.days === 'last-month' ? '' : 'through today '}in UTC.</p>`;

const plural = (count: number, one: string, many: string) => `${commas(count)} ${count === 1 ? one : many}`;

/** How to appear on the boards, which only ever count published profiles. */
function joining(viewer: UserRow | null): string {
  if (viewer?.is_public) {
    return `<section class="panel"><h2>Your profile is counted</h2>
<p>Your profile is public, so it counts on these boards wherever it has usage. Machines upload once a day. Run <code>oms sync</code> to update your numbers now.</p></section>`;
  }
  const how = viewer
    ? 'Your profile is private, so it is not counted here. To publish it, use <a href="/me">your dashboard</a>, or run this on a computer where <code>oms</code> is signed in:'
    : 'The boards count published profiles only. To publish yours, run this on a computer where <code>oms</code> is signed in:';
  const start = viewer
    ? ''
    : `<p>New here? Sign in with GitHub, and your dashboard shows how to install <code>oms</code>.</p>
<div class="actions"><a class="button primary" href="/login">${GITHUB_MARK}Sign in with GitHub</a><a class="button" href="${REPO_URL}#get-started">Read the guide</a></div>`;
  return `<section class="panel"><h2>Appear on the boards</h2>
<p>${how}</p>
<pre><code>oms publish</code></pre>
<p class="muted">Publishing shows your totals per model and per day. Machine names are never public. <code>oms unpublish</code> takes you off the boards again.</p>
${start}</section>`;
}

interface BoardFrame {
  path: string;
  title: string;
  lead: string;
  description: string;
  /** Where each period leads, keeping what else is chosen. */
  link(days: Days): string;
  views?: string;
  body: string;
}

/** What the three public boards share: tabs between them, the periods, and how to join. */
function boardPage(period: RankingPeriod, viewer: UserRow | null, origin: string, frame: BoardFrame): string {
  const tabs = BOARDS.map(([path, label]) => `<a href="${address(path, period.days)}"${current(path === frame.path)}>${label}</a>`).join('');
  return layout(`${frame.title} · ${SITE}`, `<div class="page-head"><div><h1>${frame.title}</h1>
<p>${frame.lead}</p></div></div>
<nav class="board-tabs" aria-label="Boards">${tabs}</nav>
<div class="toolbar">${periodNav(period, frame.link)}${frame.views ?? ''}</div>
${dates(period)}
${frame.body}
${joining(viewer)}`, viewer, { origin, description: frame.description });
}

const panelHead = (heading: string, summary: string) => `<div class="panel-head"><h2>${heading}</h2><p class="muted">${summary}</p></div>`;

/** Steps to the pages beside this one, around the places it shows. */
function pager(board: Board, link: (page: number) => string): string {
  if (board.pages < 2 || !board.users.length) return '';
  const first = (board.page - 1) * BOARD_PAGE + 1;
  const step = (page: number, label: string, rel: string) =>
    page < 1 || page > board.pages ? '<span></span>' : `<a class="button" href="${link(page)}" rel="${rel}">${label}</a>`;
  return `<nav class="board-pager" aria-label="Pages">${step(board.page - 1, 'Previous', 'prev')}<span>${commas(first)}–${commas(first + board.users.length - 1)} of ${commas(board.position.participants)}</span>${step(board.page + 1, 'Next', 'next')}</nav>`;
}

const COST_NOTE = `<p class="muted">Estimated cost is what a profile’s logged responses would cost at public API list prices. It is not what anyone paid, because subscription plans pay differently. Only usage found in logs is priced, so it is lower than the cost on a profile’s own page when a tool reports more usage than its logs hold. A model without a list price adds its tokens here, but no cost.</p>`;

/** The board of public profiles, by tokens or by estimated cost. */
export function rankingsPage(period: RankingPeriod, board: Board | CostBoard, viewer: UserRow | null, provider: string | null, origin: string): string {
  const byCost = 'cost' in board;
  const sort: BoardSort = byCost ? 'cost' : 'tokens';
  const link = (view: View) => address('/rankings', period.days, { provider, sort, ...view });
  // Provider IDs are chosen by whoever uploads them, so only the known ones are offered to everyone.
  const offered = board.providers.map(({ tool }) => tool).filter(tool => PROVIDERS.has(tool));
  if (provider !== null && !offered.includes(provider)) offered.push(provider);
  const providers = offered.length > 1 || provider !== null
    ? `<nav class="filters" aria-label="Providers"><a href="${link({ provider: null })}"${current(provider === null)}>All providers</a>${offered
      .map(tool => `<a href="${link({ provider: tool })}"${current(provider === tool)}>${providerLabel(tool)}</a>`).join('')}</nav>`
    : '';
  const order = `<nav class="segments" aria-label="Rank by"><a href="${link({ sort: 'tokens' })}"${current(!byCost)}>By tokens</a><a href="${link({ sort: 'cost' })}"${current(byCost)}>By estimated cost</a></nav>`;

  const { rank, participants } = board.position;
  const together = participants === 0 ? ''
    : byCost ? `${money(board.cost)} at list prices for ${compact(board.tokens)} logged tokens, from `
    : `<span title="${commas(board.tokens)} tokens">${compact(board.tokens)} tokens</span> from `;
  const elsewhere = board.viewerPage && board.viewerPage !== board.page ? `, <a href="${link({ page: board.viewerPage })}">on page ${commas(board.viewerPage)}</a>` : '';
  const place = !viewer ? ''
    : rank === null ? ` · ${viewer.is_public ? 'No ranked usage in these periods.' : 'Your profile is private.'}`
    : ` · You are <strong>#${commas(rank)}</strong>${elsewhere}`;

  const shown = board.users.length;
  const first = (board.page - 1) * BOARD_PAGE + 1;
  const places = shown > 1 ? `Places ${commas(first)}–${commas(first + shown - 1)}` : shown === 1 ? `Place ${commas(first)}` : board.page > 1 ? `Page ${commas(board.page)}` : 'Places';
  const table = shown === 0 && board.page > 1
    ? `<p>There is no page ${commas(board.page)}. This board has ${plural(board.pages, 'page', 'pages')}.</p>
<p><a class="button" href="${link({})}">Back to the first page</a></p>`
    : shown === 0 && byCost ? '<p>No logged usage with a list price for this period.</p>'
    : standings(board.users, 'GitHub user', byCost ? 'Logged tokens' : tokenColumnLabel(period.days), { viewer: viewer?.login ?? null, names: true, ...(byCost ? { cost: 'Estimated cost' } : {}) });

  return boardPage(period, viewer, origin, {
    path: '/rankings',
    title: 'Public token rankings',
    lead: byCost
      ? 'Published profiles, by what their logged AI usage would cost at public API list prices.'
      : 'Published profiles, by AI tokens used: input, output, cache reads and cache writes.',
    description: 'Published developer profiles ranked by AI token usage or its estimated cost: all time, the last 7 or 30 days, this month and last month.',
    link: (days) => address('/rankings', days, { provider, sort }),
    // Signed out, the second view would only lead to the sign-in page.
    views: viewer ? viewNav(period.days, true) : '',
    body: `<div class="toolbar">${providers}${order}</div>
<section class="panel">${panelHead(`${places}${provider === null ? '' : ` · ${esc(providerName(provider))}`}`, `${together}${profileCount(participants)}${place}`)}
${table}${pager(board, (page) => link({ page }))}</section>
${byCost ? COST_NOTE : ''}`,
  });
}

interface Reach {
  rank: number;
  profiles: number;
  share: number;
  change: Change | null;
}

/** A column of numbers. All of them fit a wide screen. A phone keeps the one marked `narrow`. */
interface Column<Row> {
  heading: string;
  cell(row: Row): string;
  narrow?: boolean;
}

const sign = (change: Change) => (change.by > 0 ? '+' : change.by < 0 ? '−' : '');
const tone = (change: Change) => (change.by > 0 ? ' class="up"' : change.by < 0 ? ' class="down"' : '');

/** A move in active profiles: +3, −2 or new. */
const moved = (change: Change) => (change.before === 0 ? 'new' : `${sign(change)}${commas(Math.abs(change.by))}`);

/** The move with its percentage beneath, when the period before had enough profiles for one. */
const changeFigure = (change: Change | null) =>
  change ? `<strong${tone(change)}>${moved(change)}</strong>${change.rate === null || change.by === 0 ? '' : `<small>${sign(change)}${percent(Math.abs(change.rate))}</small>`}` : '';

/**
 * A board of providers or models: a place, a name, a bar for its share of profiles, then its
 * figures. A phone has no room for the columns, so there the reach is written under the name.
 */
function reachTable<Row extends Reach>(rows: Row[], heading: string, name: (row: Row) => string, columns: Column<Row>[]): string {
  const reach = (row: Row) =>
    `${plural(row.profiles, 'profile', 'profiles')} (${percent(row.share)})${row.change?.by ? ` · <span${tone(row.change)}>${moved(row.change)}</span>` : ''}`;
  const kind = (column: Column<Row>) => (column.narrow ? 'num' : 'num wide');
  const body = rows.map((row) => `<tr><td class="rank"><span class="place">${row.rank}</span></td><td class="who">${name(row)}<small class="narrow">${reach(row)}</small></td>
<td class="meter" aria-hidden="true"><span style="--share:${(100 * row.share).toFixed(1)}%"></span></td>
${columns.map((column) => `<td class="${kind(column)}">${column.cell(row)}</td>`).join('')}</tr>`).join('');
  return `<div class="table"><table class="standings reach"><thead><tr><th class="rank">Rank</th><th>${heading}</th><td class="meter" aria-hidden="true"></td>${columns
    .map((column) => `<th class="${kind(column)}">${column.heading}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** What the change column compares with. This month so far is set against the whole month before it. */
const comparison = (period: RankingPeriod, compared: RankingPeriod | null, each: string) =>
  compared?.start
    ? ` Change is the difference in active profiles from ${compared.start} through ${compared.end}${period.days === 'month' ? ', the whole of last month' : ''}. It comes with a percentage when the ${each} had at least ${CHANGE_BASE} active profiles then.`
    : '';

/** The known providers, by how many public profiles use each one. */
export function providersPage(period: RankingPeriod, board: ProviderBoard, viewer: UserRow | null, origin: string): string {
  const columns: Column<ProviderBoard['providers'][number]>[] = [
    { heading: 'Active profiles', cell: (row) => figure(commas(row.profiles)) },
    { heading: 'Adoption', cell: (row) => figure(percent(row.share)) },
    { heading: tokenColumnLabel(period.days), cell: (row) => figure(compact(row.tokens), commas(row.tokens)), narrow: true },
  ];
  if (board.compared) columns.push({ heading: 'Change in profiles', cell: (row) => changeFigure(row.change) });
  // Each provider leads to the profiles that use it.
  const table = board.providers.length
    ? reachTable(board.providers, 'Provider', (row) => `<a href="${address('/rankings', period.days, { provider: row.tool })}">${providerLabel(row.tool)}</a>`, columns)
    : '<p>No token usage for this period.</p>';
  const reading = board.providers.length
    ? `Active profiles are published profiles with usage of the provider in the period. Adoption is their share of all ${profileCount(board.profiles)}.${comparison(period, board.compared, 'provider')} `
    : '';
  return boardPage(period, viewer, origin, {
    path: '/rankings/providers',
    title: 'Provider rankings',
    lead: 'The AI tools that published profiles use, by how many profiles used each one.',
    description: 'AI coding tools ranked by how many published developer profiles use them, with adoption, tokens and the change from the period before.',
    link: (days) => address('/rankings/providers', days),
    body: `<section class="panel">${panelHead('Providers by active profiles', `${board.profiles ? `${compact(board.tokens)} tokens from ` : ''}${profileCount(board.profiles)}`)}
${table}</section>
<p class="muted">${reading}Only the tools <code>oms</code> reads on its own are listed, because a provider ID is chosen by whoever uploads it.</p>`,
  });
}

/** The models with a list price, by how many public profiles logged usage of each one. */
export function modelsPage(period: RankingPeriod, board: ModelBoard, viewer: UserRow | null, origin: string): string {
  type Row = ModelBoard['models'][number];
  const columns: Column<Row>[] = [
    { heading: 'Active profiles', cell: (row) => figure(commas(row.profiles)) },
    { heading: 'Adoption', cell: (row) => figure(percent(row.share)) },
    // On a phone the cost goes under the tokens, in place of their exact figure.
    { heading: 'Logged tokens', cell: (row) => figure(compact(row.tokens), commas(row.tokens), costFigures(row.cost)[0]), narrow: true },
    { heading: 'Cost at list price', cell: (row) => figure(...costFigures(row.cost)) },
  ];
  if (board.compared) columns.push({ heading: 'Change in profiles', cell: (row) => changeFigure(row.change) });
  const carrier = (row: Row) => `${percent(row.providerShare, 0)} via ${row.provider === null ? 'other tools' : esc(providerName(row.provider))}`;
  const table = board.models.length
    ? reachTable(board.models, 'Model', (row) => `<b>${esc(row.model)}</b><small>${carrier(row)}</small>`, columns)
    : '<p>No logged usage of a model with a list price for this period.</p>';
  const heading = board.priced > board.models.length ? `Top ${board.models.length} models by active profiles` : 'Models by active profiles';
  const summary = board.priced
    ? `${plural(board.priced, 'priced model', 'priced models')} · ${compact(board.tokens)} logged tokens · ${money(board.cost)} at list prices`
    : 'No priced models';
  const reading = board.models.length
    ? ` Under each model is the provider most of its tokens came through. Adoption is a model’s share of the ${plural(board.profiles, 'published profile', 'published profiles')} with logged usage in the period.${comparison(period, board.compared, 'model')} Cost is at public API list prices, not what anyone paid.`
    : '';
  return boardPage(period, viewer, origin, {
    path: '/rankings/models',
    title: 'Model rankings',
    lead: 'The AI models in the logs of published profiles, by how many profiles used each one.',
    description: 'AI models ranked by how many published developer profiles logged usage of them, with adoption, tokens, cost at list prices and the change from the period before.',
    link: (days) => address('/rankings/models', days),
    body: `<section class="panel">${panelHead(heading, summary)}
${table}</section>
<p class="muted">Counted from the responses that published profiles logged, the only record that names a model. A model name is chosen by whoever uploads it, so only models with a public list price are listed, and a dated name counts as the model it is priced as.${reading}</p>`,
  });
}

/** The viewer's own places, devices and providers. Only they can open it. */
export function myRankingsPage(period: RankingPeriod, personal: PersonalRankings, viewer: UserRow, positions: PublicPosition[]): string {
  const tokenColumn = tokenColumnLabel(period.days);
  const unranked = positions.every(p => p.rank === null) ? (viewer.is_public ? 'No ranked usage in these periods.' : 'Your profile is private.') : '';
  const tiles = positions.map(({ days, rank, participants }) =>
    `<div class="tile"><span class="tile-label">${periodLabel(days)}</span><strong>${rank === null ? '—' : `#${rank}`}</strong><span>${rank === null ? 'Unranked · ' : 'of '}${profileCount(participants)}</span></div>`).join('');
  return layout(`My token rankings · ${SITE}`, `<div class="page-head"><div><h1>My token rankings</h1>
<p>Where you stand, and how your own devices and providers compare. Only you can see this page.</p></div>
${viewer.is_public ? `<a class="button" href="/u/${encodeURIComponent(viewer.login)}/ranking.svg">View ranking SVG</a>` : ''}</div>
<div class="toolbar">${periodNav(period, (days) => address('/me/rankings', days))}${viewNav(period.days, false)}</div>
${dates(period)}
<h2 class="sr">Your public position</h2><div class="tiles">${tiles}</div>
${unranked ? `<p class="muted">${unranked}</p>` : ''}
<section class="panel"><h2>My devices</h2>${standings(personal.machines, 'Device', tokenColumn)}</section>
<section class="panel"><h2>My providers</h2>${standings(personal.providers, 'Provider', tokenColumn)}</section>
<p class="muted">Device scores cover usage attributable to individual machines. Provider scores also include account-wide usage.</p>`, viewer);
}
