import type { TokenMetrics } from '../../shared/metrics.ts';
import { buildCards } from '../../shared/render/cards.ts';
import { PREVIEW_HEIGHT, PREVIEW_WIDTH } from '../../shared/render/preview.ts';
import { availableComponents, renderDashboard } from '../../shared/render/svg.ts';
import { dayData } from '../../shared/usage.ts';
import { buildMetrics, hasData, PREVIEW_IMAGE, profilePageKey, PUBLIC_CACHE, publicProfile, withAvatar } from '../../server/app.ts';
import type { UserRow } from '../../server/db.ts';
import { profileCount, SITE, type PageOptions, type Part } from '../../server/pages.ts';
import { publicRankings, rankingPeriod, type PublicPosition } from '../../server/rankings.ts';
import { ActivityPanels, activityIcons, EmbedCode, ProviderActivity } from '../activity.tsx';
import { Avatar, GitHubMark } from '../common.tsx';
import { Layout } from '../layout.tsx';
import { PageLink } from '../link.tsx';
import type { PageModule } from '../page.ts';
import { ActivityChart } from './workspace.tsx';

/** A public profile: its header, its dashboard, its activity, and how to embed it. */

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

/**
 * What a profile page shows that is the same for every signed-out visitor, and costly to work
 * out: drawing the dashboard most of all. A location keeps it while a public page may be kept.
 */
interface Shown {
  user: UserRow;
  /** The dashboard, drawn as the image at dashboard.svg is. */
  svg: string;
  tokens: TokenMetrics | null;
  cards: { key: string; title: string }[];
  parts: Part[];
  position: PublicPosition | null;
}

interface ProfileProps extends Shown {
  origin: string;
  viewer: UserRow | null;
  image: NonNullable<PageOptions['image']>;
}

async function shown(user: UserRow, origin: string, deps: Parameters<typeof buildMetrics>[1]): Promise<{ shown: Shown; worthKeeping: boolean }> {
  const [{ metrics }, { position }] = await Promise.all([buildMetrics(user, deps), publicRankings(deps.db, rankingPeriod('all', deps.now()), user.id)]);
  // Usage per machine is for its owner, and the page never draws it, so it isn't kept either.
  const tokens = metrics.tokens ? { ...metrics.tokens, machines: [] } : null;
  return {
    shown: {
      user,
      svg: renderDashboard(await withAvatar({ ...metrics, rank: position }, user, origin, deps)),
      tokens,
      cards: buildCards(metrics).map(({ key, title }) => ({ key, title })),
      parts: availableComponents(metrics),
      position,
    },
    // Only a page with data is kept, so publishing and a first upload show at once.
    worthKeeping: hasData(metrics),
  };
}

function ProfileView({ user, svg, tokens, cards, parts, position, origin, viewer, image }: ProfileProps) {
  const url = `${origin}/u/${encodeURIComponent(user.login)}`;
  const login = encodeURIComponent(user.login);
  const mine = viewer?.id === user.id;
  // Worked out once: the calendar and the daily chart are drawn from the same days.
  const days = tokens ? dayData(tokens) : undefined;
  const since = new Date(user.created_at);
  const joined = Number.isNaN(since.getTime()) ? '' : `Joined ${since.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
  const about = [user.name ?? '', joined].filter(Boolean).join(' · ');
  // A GitHub login is not an X handle, so the text names the profile without an @.
  const share = `https://x.com/intent/post?text=${encodeURIComponent(`${mine ? 'My' : `${user.login}’s`} developer stats on ${SITE}`)}&url=${encodeURIComponent(url)}`;
  return (
    <Layout
      title={`@${user.login} on ${SITE}`}
      viewer={viewer}
      origin={origin}
      image={image}
      description={`The developer stats of @${user.login}: AI tokens and GitHub contributions, counted across every machine.`}
      icons={activityIcons(tokens)}
    >
      <div className="profile">
        <Avatar url={user.avatar_url} size={64} />
        <div>
          <h1>{`@${user.login}`}</h1>
          {about ? <p>{about}</p> : null}
          {position?.rank ? (
            <p><PageLink className="badge" href="/rankings">{`#${position.rank} of ${profileCount(position.participants)}, by lifetime AI tokens`}</PageLink></p>
          ) : null}
        </div>
        <div className="actions">
          {mine ? <a className="button" href="/me#profile-header">Edit profile</a> : null}
          <a className="button" href={`https://github.com/${login}`} rel="noopener"><GitHubMark />GitHub</a>
          <a className="button" href="#embed">Embed</a>
          <a className="button" href={share} rel="noopener" title="Share on X">Share</a>
        </div>
      </div>
      <ActivityPanels tokens={tokens} days={days}>
        {/* A profile with no dated usage has no days to chart. */}
        {days?.days.length ? <ActivityChart data={days} size={60} /> : null}
      </ActivityPanels>
      <ProviderActivity tokens={tokens} />
      <div className="dash" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="panel" id="embed">
        <h2>Add this to your GitHub profile</h2>
        <EmbedCode url={url} parts={parts} />
        {cards.length ? (
          <>
            <h2>Text cards</h2>
            <ul>
              {cards.map((card) => (
                <li key={card.key}><a href={`/u/${login}/cards/${card.key}.txt`}>{card.title}</a></li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </Layout>
  );
}

export const profile: PageModule<ProfileProps> = {
  async load({ url, viewer, deps, params }) {
    const login = params.login ?? '';
    // A private or missing profile answers the same way, so neither is revealed.
    if (!LOGIN.test(login)) return { notFound: true };
    const origin = url.origin;
    const key = profilePageKey(origin, login);
    // The page names whoever is signed in, so only signed-out visits share a kept copy.
    const kept = viewer ? null : await deps.cache?.match(key);
    let page: Shown;
    if (kept) {
      page = (await kept.json()) as Shown;
    } else {
      const user = await publicProfile(login, deps);
      if (!user) return { notFound: true };
      const { shown: drawn, worthKeeping } = await shown(user, origin, deps);
      page = drawn;
      if (!viewer && worthKeeping && deps.cache) {
        deps.waitUntil(deps.cache.put(key, new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json', 'cache-control': PUBLIC_CACHE } })));
      }
    }
    const image = {
      url: `${origin}/u/${encodeURIComponent(page.user.login)}/${PREVIEW_IMAGE}`,
      width: PREVIEW_WIDTH,
      height: PREVIEW_HEIGHT,
      alt: `The stats of @${page.user.login}: AI tokens, rank, contributions and a calendar of AI usage over the last year.`,
    };
    return { props: { ...page, origin, viewer, image } };
  },
  View: ProfileView,
  notFound: 'This profile is private or does not exist.',
};
