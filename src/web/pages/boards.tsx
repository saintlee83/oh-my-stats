import type { ReactNode } from 'react';
import { commas, compact, money, percent, PROVIDERS, providerName } from '../../shared/format.ts';
import { loadPrices } from '../../server/prices.ts';
import { boardSort, CHANGE_BASE, costBoard, modelBoard, providerBoard, type BoardSort, type Change, type CostBoard, type ModelBoard, type ProviderBoard } from '../../server/boards.ts';
import type { UserRow } from '../../server/db.ts';
import { periodLabel, profileCount, REPO_URL, SITE, tokenColumnLabel } from '../../server/pages.ts';
import {
  BOARD_PAGE, personalRankings, publicRankings, rankBoard, rankingPage, rankingPeriod, rankingProvider,
  type Board, type PersonalRankings, type PublicPosition, type RankingPeriod,
} from '../../server/rankings.ts';
import { costFigures, Figure, GitHubMark, ProviderLabel, share, Standings } from '../common.tsx';
import { Layout } from '../layout.tsx';
import { PageLink } from '../link.tsx';
import type { PageInput, PageModule } from '../page.ts';

/** The pages of the boards under /rankings, and of the signed-in viewer's own rankings. */

type Days = RankingPeriod['days'];

const PERIODS: Days[] = ['all', 7, 30, 'month', 'last-month'];
const BOARDS = [['/rankings', 'Profiles'], ['/rankings/providers', 'Providers'], ['/rankings/models', 'Models']];

const current = (active: boolean) => (active ? ('page' as const) : undefined);

/** What narrows or orders the profiles board. */
interface View {
  provider?: string | null;
  sort?: BoardSort;
  page?: number;
}

/** A board's address. The usual order and the first page are left out, so each view has one address. */
function address(path: string, days: Days, { provider = null, sort = 'tokens', page = 1 }: View = {}): string {
  const chosen = provider === null ? '' : `&provider=${encodeURIComponent(provider)}`;
  return `${path}?days=${days}${chosen}${sort === 'cost' ? '&sort=cost' : ''}${page > 1 ? `&page=${page}` : ''}`;
}

function PeriodNav({ period, link }: { period: RankingPeriod; link: (days: Days) => string }) {
  return (
    <nav className="segments" aria-label="Ranking periods">
      {PERIODS.map((days) => (
        <PageLink key={days} href={link(days)} aria-current={current(period.days === days)}>{periodLabel(days)}</PageLink>
      ))}
    </nav>
  );
}

function ViewNav({ days, everyone }: { days: Days; everyone: boolean }) {
  return (
    <nav className="segments" aria-label="Ranking views">
      <PageLink href={`/rankings?days=${days}`} aria-current={current(everyone)}>Everyone</PageLink>
      <PageLink href={`/me/rankings?days=${days}`} aria-current={current(!everyone)}>Mine</PageLink>
    </nav>
  );
}

/** The days a period covers. Last month is over, so it does not run through today. */
function Dates({ period }: { period: RankingPeriod }) {
  if (period.days === 'all') return null;
  return <p className="muted">{`${period.start} through ${period.end} · Reporting dates ${period.days === 'last-month' ? '' : 'through today '}in UTC.`}</p>;
}

const plural = (count: number, one: string, many: string) => `${commas(count)} ${count === 1 ? one : many}`;

/** How to appear on the boards, which only ever count published profiles. */
function Joining({ viewer }: { viewer: UserRow | null }) {
  if (viewer?.is_public) {
    return (
      <section className="panel">
        <h2>Your profile is counted</h2>
        <p>Your profile is public, so it counts on these boards wherever it has usage. Machines upload once a day. Run <code>oms sync</code> to update your numbers now.</p>
      </section>
    );
  }
  return (
    <section className="panel">
      <h2>Appear on the boards</h2>
      <p>
        {viewer ? (
          <>Your profile is private, so it is not counted here. To publish it, use <a href="/me">your dashboard</a>, or run this on a computer where <code>oms</code> is signed in:</>
        ) : (
          <>The boards count published profiles only. To publish yours, run this on a computer where <code>oms</code> is signed in:</>
        )}
      </p>
      <pre><code>oms publish</code></pre>
      <p className="muted">Publishing shows your totals per model and per day. Machine names are never public. <code>oms unpublish</code> takes you off the boards again.</p>
      {viewer ? null : (
        <>
          <p>New here? Sign in with GitHub, and your dashboard shows how to install <code>oms</code>.</p>
          <div className="actions">
            <a className="button primary" href="/login"><GitHubMark />Sign in with GitHub</a>
            <a className="button" href={`${REPO_URL}#get-started`}>Read the guide</a>
          </div>
        </>
      )}
    </section>
  );
}

interface BoardFrame {
  path: string;
  title: string;
  lead: string;
  description: string;
  /** Where each period leads, keeping what else is chosen. */
  link(days: Days): string;
  views?: ReactNode;
  icons?: string[];
  children: ReactNode;
}

/** What the three public boards share: tabs between them, the periods, and how to join. */
function BoardPage({ period, viewer, origin, frame }: { period: RankingPeriod; viewer: UserRow | null; origin: string; frame: BoardFrame }) {
  return (
    <Layout title={`${frame.title} · ${SITE}`} viewer={viewer} origin={origin} description={frame.description} icons={frame.icons}>
      <div className="page-head">
        <div>
          <h1>{frame.title}</h1>
          <p>{frame.lead}</p>
        </div>
      </div>
      <nav className="board-tabs" aria-label="Boards">
        {BOARDS.map(([path, label]) => (
          <PageLink key={path} href={address(path, period.days)} aria-current={current(path === frame.path)}>{label}</PageLink>
        ))}
      </nav>
      <div className="toolbar">
        <PeriodNav period={period} link={frame.link} />
        {frame.views}
      </div>
      <Dates period={period} />
      {frame.children}
      <Joining viewer={viewer} />
    </Layout>
  );
}

function PanelHead({ heading, children }: { heading: ReactNode; children: ReactNode }) {
  return (
    <div className="panel-head">
      <h2>{heading}</h2>
      <p className="muted">{children}</p>
    </div>
  );
}

/** Steps to the pages beside this one, around the places it shows. */
function Pager({ board, link }: { board: Board; link: (page: number) => string }) {
  if (board.pages < 2 || !board.users.length) return null;
  const first = (board.page - 1) * BOARD_PAGE + 1;
  const step = (page: number, label: string, rel: string) =>
    page < 1 || page > board.pages ? <span></span> : <PageLink className="button" href={link(page)} rel={rel}>{label}</PageLink>;
  return (
    <nav className="board-pager" aria-label="Pages">
      {step(board.page - 1, 'Previous', 'prev')}
      <span>{`${commas(first)}–${commas(first + board.users.length - 1)} of ${commas(board.position.participants)}`}</span>
      {step(board.page + 1, 'Next', 'next')}
    </nav>
  );
}

const COST_NOTE = 'Estimated cost is what a profile’s logged responses would cost at public API list prices. It is not what anyone paid, because subscription plans pay differently. Only usage found in logs is priced, so it is lower than the cost on a profile’s own page when a tool reports more usage than its logs hold. A model without a list price adds its tokens here, but no cost.';

interface RankingsProps {
  period: RankingPeriod;
  board: Board | CostBoard;
  viewer: UserRow | null;
  provider: string | null;
  origin: string;
}

/** The board of public profiles, by tokens or by estimated cost. */
function RankingsView({ period, board, viewer, provider, origin }: RankingsProps) {
  const byCost = 'cost' in board;
  const sort: BoardSort = byCost ? 'cost' : 'tokens';
  const link = (view: View) => address('/rankings', period.days, { provider, sort, ...view });
  // Provider IDs are chosen by whoever uploads them, so only the known ones are offered to everyone.
  const offered = board.providers.map(({ tool }) => tool).filter((tool) => PROVIDERS.has(tool));
  if (provider !== null && !offered.includes(provider)) offered.push(provider);
  const showProviders = offered.length > 1 || provider !== null;

  const { rank, participants } = board.position;
  const together = participants === 0 ? null
    : byCost ? `${money((board as CostBoard).cost)} at list prices for ${compact(board.tokens)} logged tokens, from `
    : <><span title={`${commas(board.tokens)} tokens`}>{`${compact(board.tokens)} tokens`}</span>{' from '}</>;
  const elsewhere = board.viewerPage && board.viewerPage !== board.page
    ? <>{', '}<PageLink href={link({ page: board.viewerPage })}>{`on page ${commas(board.viewerPage)}`}</PageLink></>
    : null;
  const place = !viewer ? null
    : rank === null ? ` · ${viewer.is_public ? 'No ranked usage in these periods.' : 'Your profile is private.'}`
    : <>{' · You are '}<strong>{`#${commas(rank)}`}</strong>{elsewhere}</>;

  const shown = board.users.length;
  const first = (board.page - 1) * BOARD_PAGE + 1;
  const places = shown > 1 ? `Places ${commas(first)}–${commas(first + shown - 1)}` : shown === 1 ? `Place ${commas(first)}` : board.page > 1 ? `Page ${commas(board.page)}` : 'Places';
  const table = shown === 0 && board.page > 1 ? (
    <>
      <p>{`There is no page ${commas(board.page)}. This board has ${plural(board.pages, 'page', 'pages')}.`}</p>
      <p><PageLink className="button" href={link({})}>Back to the first page</PageLink></p>
    </>
  ) : shown === 0 && byCost ? (
    <p>No logged usage with a list price for this period.</p>
  ) : (
    <Standings
      rows={board.users}
      column="GitHub user"
      tokenColumn={byCost ? 'Logged tokens' : tokenColumnLabel(period.days)}
      profiles={{ viewer: viewer?.login ?? null, names: true, ...(byCost ? { cost: 'Estimated cost' } : {}) }}
    />
  );

  return (
    <BoardPage period={period} viewer={viewer} origin={origin} frame={{
      path: '/rankings',
      title: 'Public token rankings',
      lead: byCost
        ? 'Published profiles, by what their logged AI usage would cost at public API list prices.'
        : 'Published profiles, by AI tokens used: input, output, cache reads and cache writes.',
      description: 'Published developer profiles ranked by AI token usage or its estimated cost: all time, the last 7 or 30 days, this month and last month.',
      link: (days) => address('/rankings', days, { provider, sort }),
      // Signed out, the second view would only lead to the sign-in page.
      views: viewer ? <ViewNav days={period.days} everyone /> : null,
      icons: showProviders ? offered : [],
      children: (
        <>
          <div className="toolbar">
            {showProviders ? (
              <nav className="filters" aria-label="Providers">
                <PageLink href={link({ provider: null })} aria-current={current(provider === null)}>All providers</PageLink>
                {offered.map((tool) => (
                  <PageLink key={tool} href={link({ provider: tool })} aria-current={current(provider === tool)}><ProviderLabel id={tool} /></PageLink>
                ))}
              </nav>
            ) : null}
            <nav className="segments" aria-label="Rank by">
              <PageLink href={link({ sort: 'tokens' })} aria-current={current(!byCost)}>By tokens</PageLink>
              <PageLink href={link({ sort: 'cost' })} aria-current={current(byCost)}>By estimated cost</PageLink>
            </nav>
          </div>
          <section className="panel">
            <PanelHead heading={`${places}${provider === null ? '' : ` · ${providerName(provider)}`}`}>
              {together}{profileCount(participants)}{place}
            </PanelHead>
            {table}
            <Pager board={board} link={(page) => link({ page })} />
          </section>
          {byCost ? <p className="muted">{COST_NOTE}</p> : null}
        </>
      ),
    }} />
  );
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
  cell(row: Row): ReactNode;
  narrow?: boolean;
}

const sign = (change: Change) => (change.by > 0 ? '+' : change.by < 0 ? '−' : '');
const tone = (change: Change) => (change.by > 0 ? 'up' : change.by < 0 ? 'down' : undefined);

/** A move in active profiles: +3, −2 or new. */
const moved = (change: Change) => (change.before === 0 ? 'new' : `${sign(change)}${commas(Math.abs(change.by))}`);

/** The move with its percentage beneath, when the period before had enough profiles for one. */
function ChangeFigure({ change }: { change: Change | null }) {
  if (!change) return null;
  return (
    <>
      <strong className={tone(change)}>{moved(change)}</strong>
      {change.rate === null || change.by === 0 ? null : <small>{`${sign(change)}${percent(Math.abs(change.rate))}`}</small>}
    </>
  );
}

/**
 * A board of providers or models: a place, a name, a bar for its share of profiles, then its
 * figures. A phone has no room for the columns, so there the reach is written under the name.
 */
function ReachTable<Row extends Reach>({ rows, heading, name, columns }: { rows: Row[]; heading: string; name: (row: Row) => ReactNode; columns: Column<Row>[] }) {
  const kind = (column: Column<Row>) => (column.narrow ? 'num' : 'num wide');
  return (
    <div className="table">
      <table className="standings reach">
        <thead>
          <tr>
            <th className="rank">Rank</th>
            <th>{heading}</th>
            <td className="meter" aria-hidden="true"></td>
            {columns.map((column) => <th key={column.heading} className={kind(column)}>{column.heading}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td className="rank"><span className="place">{row.rank}</span></td>
              <td className="who">
                {name(row)}
                <small className="narrow">
                  {`${plural(row.profiles, 'profile', 'profiles')} (${percent(row.share)})`}
                  {row.change?.by ? <>{' · '}<span className={tone(row.change)}>{moved(row.change)}</span></> : null}
                </small>
              </td>
              <td className="meter" aria-hidden="true"><span style={share(row.share)}></span></td>
              {columns.map((column) => <td key={column.heading} className={kind(column)}>{column.cell(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What the change column compares with. This month so far is set against the whole month before it. */
const comparison = (period: RankingPeriod, compared: RankingPeriod | null, each: string) =>
  compared?.start
    ? ` Change is the difference in active profiles from ${compared.start} through ${compared.end}${period.days === 'month' ? ', the whole of last month' : ''}. It comes with a percentage when the ${each} had at least ${CHANGE_BASE} active profiles then.`
    : '';

interface ProvidersProps {
  period: RankingPeriod;
  board: ProviderBoard;
  viewer: UserRow | null;
  origin: string;
}

/** The known providers, by how many public profiles use each one. */
function ProvidersView({ period, board, viewer, origin }: ProvidersProps) {
  const columns: Column<ProviderBoard['providers'][number]>[] = [
    { heading: 'Active profiles', cell: (row) => <Figure short={commas(row.profiles)} /> },
    { heading: 'Adoption', cell: (row) => <Figure short={percent(row.share)} /> },
    { heading: tokenColumnLabel(period.days), cell: (row) => <Figure short={compact(row.tokens)} exact={commas(row.tokens)} />, narrow: true },
  ];
  if (board.compared) columns.push({ heading: 'Change in profiles', cell: (row) => <ChangeFigure change={row.change} /> });
  const reading = board.providers.length
    ? `Active profiles are published profiles with usage of the provider in the period. Adoption is their share of all ${profileCount(board.profiles)}.${comparison(period, board.compared, 'provider')} `
    : '';
  return (
    <BoardPage period={period} viewer={viewer} origin={origin} frame={{
      path: '/rankings/providers',
      title: 'Provider rankings',
      lead: 'The AI tools that published profiles use, by how many profiles used each one.',
      description: 'AI coding tools ranked by how many published developer profiles use them, with adoption, tokens and the change from the period before.',
      link: (days) => address('/rankings/providers', days),
      icons: board.providers.map((row) => row.tool),
      children: (
        <>
          <section className="panel">
            <PanelHead heading="Providers by active profiles">{`${board.profiles ? `${compact(board.tokens)} tokens from ` : ''}${profileCount(board.profiles)}`}</PanelHead>
            {board.providers.length ? (
              // Each provider leads to the profiles that use it.
              <ReachTable rows={board.providers} heading="Provider" columns={columns}
                name={(row) => <PageLink href={address('/rankings', period.days, { provider: row.tool })}><ProviderLabel id={row.tool} /></PageLink>} />
            ) : (
              <p>No token usage for this period.</p>
            )}
          </section>
          <p className="muted">{reading}Only the tools <code>oms</code> reads on its own are listed, because a provider ID is chosen by whoever uploads it.</p>
        </>
      ),
    }} />
  );
}

interface ModelsProps {
  period: RankingPeriod;
  board: ModelBoard;
  viewer: UserRow | null;
  origin: string;
}

/** The models with a list price, by how many public profiles logged usage of each one. */
function ModelsView({ period, board, viewer, origin }: ModelsProps) {
  type Row = ModelBoard['models'][number];
  const columns: Column<Row>[] = [
    { heading: 'Active profiles', cell: (row) => <Figure short={commas(row.profiles)} /> },
    { heading: 'Adoption', cell: (row) => <Figure short={percent(row.share)} /> },
    // On a phone the cost goes under the tokens, in place of their exact figure.
    { heading: 'Logged tokens', cell: (row) => <Figure short={compact(row.tokens)} exact={commas(row.tokens)} narrow={costFigures(row.cost)[0]} />, narrow: true },
    { heading: 'Cost at list price', cell: (row) => { const [short, exact] = costFigures(row.cost); return <Figure short={short} exact={exact} />; } },
  ];
  if (board.compared) columns.push({ heading: 'Change in profiles', cell: (row) => <ChangeFigure change={row.change} /> });
  const carrier = (row: Row) => `${percent(row.providerShare, 0)} via ${row.provider === null ? 'other tools' : providerName(row.provider)}`;
  const heading = board.priced > board.models.length ? `Top ${board.models.length} models by active profiles` : 'Models by active profiles';
  const summary = board.priced
    ? `${plural(board.priced, 'priced model', 'priced models')} · ${compact(board.tokens)} logged tokens · ${money(board.cost)} at list prices`
    : 'No priced models';
  const reading = board.models.length
    ? ` Under each model is the provider most of its tokens came through. Adoption is a model’s share of the ${plural(board.profiles, 'published profile', 'published profiles')} with logged usage in the period.${comparison(period, board.compared, 'model')} Cost is at public API list prices, not what anyone paid.`
    : '';
  return (
    <BoardPage period={period} viewer={viewer} origin={origin} frame={{
      path: '/rankings/models',
      title: 'Model rankings',
      lead: 'The AI models in the logs of published profiles, by how many profiles used each one.',
      description: 'AI models ranked by how many published developer profiles logged usage of them, with adoption, tokens, cost at list prices and the change from the period before.',
      link: (days) => address('/rankings/models', days),
      children: (
        <>
          <section className="panel">
            <PanelHead heading={heading}>{summary}</PanelHead>
            {board.models.length ? (
              <ReachTable rows={board.models} heading="Model" columns={columns} name={(row) => <><b>{row.model}</b><small>{carrier(row)}</small></>} />
            ) : (
              <p>No logged usage of a model with a list price for this period.</p>
            )}
          </section>
          <p className="muted">{`Counted from the responses that published profiles logged, the only record that names a model. A model name is chosen by whoever uploads it, so only models with a public list price are listed, and a dated name counts as the model it is priced as.${reading}`}</p>
        </>
      ),
    }} />
  );
}

interface MyRankingsProps {
  period: RankingPeriod;
  personal: PersonalRankings;
  viewer: UserRow;
  positions: PublicPosition[];
}

/** The viewer's own places, devices and providers. Only they can open it. */
function MyRankingsView({ period, personal, viewer, positions }: MyRankingsProps) {
  const tokenColumn = tokenColumnLabel(period.days);
  const unranked = positions.every((p) => p.rank === null) ? (viewer.is_public ? 'No ranked usage in these periods.' : 'Your profile is private.') : '';
  return (
    <Layout title={`My token rankings · ${SITE}`} viewer={viewer} icons={personal.providers.map((row) => row.tool)}>
      <div className="page-head">
        <div>
          <h1>My token rankings</h1>
          <p>Where you stand, and how your own devices and providers compare. Only you can see this page.</p>
        </div>
        {viewer.is_public ? <a className="button" href={`/u/${encodeURIComponent(viewer.login)}/ranking.svg`}>View ranking SVG</a> : null}
      </div>
      <div className="toolbar">
        <PeriodNav period={period} link={(days) => address('/me/rankings', days)} />
        <ViewNav days={period.days} everyone={false} />
      </div>
      <Dates period={period} />
      <h2 className="sr">Your public position</h2>
      <div className="tiles">
        {positions.map(({ days, rank, participants }) => (
          <div key={String(days)} className="tile">
            <span className="tile-label">{periodLabel(days)}</span>
            <strong>{rank === null ? '—' : `#${rank}`}</strong>
            <span>{`${rank === null ? 'Unranked · ' : 'of '}${profileCount(participants)}`}</span>
          </div>
        ))}
      </div>
      {unranked ? <p className="muted">{unranked}</p> : null}
      <section className="panel"><h2>My devices</h2><Standings rows={personal.machines} column="Device" tokenColumn={tokenColumn} /></section>
      <section className="panel"><h2>My providers</h2><Standings rows={personal.providers} column="Provider" tokenColumn={tokenColumn} /></section>
      <p className="muted">Device scores cover usage attributable to individual machines. Provider scores also include account-wide usage.</p>
    </Layout>
  );
}

const periodOf = ({ url, deps }: PageInput) => rankingPeriod(url.searchParams.get('days'), deps.now(), true);
const pricesOf = ({ deps }: PageInput) => loadPrices(deps.db, deps.fetch, deps.waitUntil, deps.now());

export const rankings: PageModule<RankingsProps> = {
  async load(input) {
    const { url, viewer, deps } = input;
    const period = periodOf(input);
    const view = { viewerId: viewer?.id, provider: rankingProvider(url.searchParams.get('provider')), page: rankingPage(url.searchParams.get('page')) };
    // Only the board by cost reads the logs and the prices. By tokens, a visit costs what it always has.
    const board = boardSort(url.searchParams.get('sort')) === 'cost'
      ? await costBoard(deps.db, await pricesOf(input), period, view)
      : await rankBoard(deps.db, period, { kind: 'public' }, view);
    return { props: { period, board, viewer, provider: view.provider, origin: url.origin } };
  },
  View: RankingsView,
};

export const providers: PageModule<ProvidersProps> = {
  async load(input) {
    const period = periodOf(input);
    return { props: { period, board: await providerBoard(input.deps.db, period), viewer: input.viewer, origin: input.url.origin } };
  },
  View: ProvidersView,
};

export const models: PageModule<ModelsProps> = {
  async load(input) {
    const period = periodOf(input);
    return { props: { period, board: await modelBoard(input.deps.db, await pricesOf(input), period), viewer: input.viewer, origin: input.url.origin } };
  },
  View: ModelsView,
};

export const myRankings: PageModule<MyRankingsProps> = {
  async load(input) {
    const { viewer, deps } = input;
    const period = periodOf(input);
    if (!viewer) return { redirect: '/login' };
    const now = deps.now();
    // The viewer's place all time and this week, and in the period chosen when it is another.
    const ranges = [rankingPeriod('all', now), rankingPeriod('7', now), ...(period.days === 'all' || period.days === 7 ? [] : [period])];
    const [personal, ...boards] = await Promise.all([
      personalRankings(deps.db, viewer.id, period),
      ...ranges.map((range) => publicRankings(deps.db, range, viewer.id)),
    ] as const);
    return { props: { period, personal, viewer, positions: boards.map((board) => board.position) } };
  },
  View: MyRankingsView,
};
