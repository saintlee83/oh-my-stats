import type { ReactNode } from 'react';
import { commas, compact } from '../../shared/format.ts';
import type { UserRow } from '../../server/db.ts';
import { wholeBoard } from '../../server/grouproutes.ts';
import {
  GROUP_LIMITS, groupMembers, groupsOf, memberCount, openGroup, publicGroups, PUBLIC_GROUPS_SHOWN,
  type GroupMember, type GroupRole, type GroupRow, type GroupSummary,
} from '../../server/groups.ts';
import { AVATARS, periodLabel, SITE, tokenColumnLabel } from '../../server/pages.ts';
import { rankingPeriod, type Board, type RankingPeriod } from '../../server/rankings.ts';
import { GitHubMark, share } from '../common.tsx';
import { Layout } from '../layout.tsx';
import { PageLink } from '../link.tsx';
import type { PageModule } from '../page.ts';

/**
 * The pages for groups: every public group with the viewer's own, and one group's board. A
 * group's name and description are written by its owner and read by others; React escapes both.
 * The forms post to the server, whose answers (src/server/grouproutes.ts) are its own pages.
 */

/** What joining a group shows, said wherever someone is about to join or has joined. */
const JOIN_NOTE = 'Joining shows your token totals to this group’s members, even while your profile is private. Machine names stay private.';

const memberCountLabel = (count: number) => `${commas(count)} ${count === 1 ? 'member' : 'members'}`;

function VisibilityBadge({ isPublic }: { isPublic: number }) {
  return <span className={`badge${isPublic ? ' live' : ''}`}>{isPublic ? 'Public' : 'Private'}</span>;
}

/** The fields the create and edit forms share. */
function DetailFields({ group }: { group: Pick<GroupRow, 'name' | 'description' | 'is_public'> | null }) {
  return (
    <div className="fields group-fields">
      <label>Name<input type="text" name="name" defaultValue={group?.name ?? ''} maxLength={GROUP_LIMITS.name} autoComplete="off" required /></label>
      <label>Who can see it<select name="visibility" defaultValue={group?.is_public ? 'public' : 'private'}>
        <option value="private">Private: members only, by invite link</option>
        <option value="public">Public: anyone can open it and join</option>
      </select></label>
      <label className="wide">Description<textarea name="description" maxLength={GROUP_LIMITS.description} rows={2} placeholder="Who this group is for" defaultValue={group?.description ?? ''} /></label>
    </div>
  );
}

function GroupList({ groups, own }: { groups: GroupSummary[]; own: boolean }) {
  return (
    <ul className="group-list">
      {groups.map((group) => (
        <li key={group.slug}>
          <div>
            <PageLink href={`/groups/${group.slug}`}>{group.name}</PageLink>
            {own ? <><VisibilityBadge isPublic={group.is_public} />{group.owned ? <span className="badge">Owner</span> : null}</> : null}
            {group.description ? <p>{group.description}</p> : null}
          </div>
          <span className="group-count">{memberCountLabel(group.members)}</span>
        </li>
      ))}
    </ul>
  );
}

interface GroupsProps {
  open: GroupSummary[];
  mine: GroupSummary[];
  viewer: UserRow | null;
  origin: string;
}

function GroupsView({ open, mine, viewer, origin }: GroupsProps) {
  const owned = mine.filter((group) => group.owned).length;
  const start = owned >= GROUP_LIMITS.owned ? (
    <p className="muted">{`You own ${GROUP_LIMITS.owned} groups, the most an account can. Delete one to start another.`}</p>
  ) : mine.length >= GROUP_LIMITS.joined ? (
    <p className="muted">{`You are in ${GROUP_LIMITS.joined} groups, the most an account can join. Leave one to start another.`}</p>
  ) : (
    <details className="group-start">
      <summary className="button">Start a group</summary>
      <form method="post" action="/groups">
        <p>{`You become its owner and its first member. ${JOIN_NOTE}`}</p>
        <DetailFields group={null} />
        <button className="primary">Create group</button>
      </form>
    </details>
  );
  const shown = open.length >= PUBLIC_GROUPS_SHOWN ? `The ${PUBLIC_GROUPS_SHOWN} largest` : `${commas(open.length)} ${open.length === 1 ? 'group' : 'groups'}, most members first`;
  return (
    <Layout title={`Groups · ${SITE}`} viewer={viewer} origin={origin}
      description={`Groups on ${SITE}: a board for a team or a circle of friends, ranking its members by AI token usage.`}>
      <div className="page-head">
        <div>
          <h1>Groups</h1>
          <p>A board for a team or a circle of friends: its members, ranked by AI tokens.</p>
        </div>
        {viewer ? null : <div className="actions"><a className="button" href="/login"><GitHubMark />Sign in to start a group</a></div>}
      </div>
      {viewer ? (
        <section className="panel">
          <div className="panel-head"><h2>My groups</h2><p className="muted">{`${mine.length} of ${GROUP_LIMITS.joined} · Only you can see this list.`}</p></div>
          {mine.length ? <GroupList groups={mine} own /> : <p>You are not in a group yet. Start one, or join a public group below.</p>}
          {start}
        </section>
      ) : null}
      <section className="panel">
        <div className="panel-head"><h2>Public groups</h2>{open.length ? <p className="muted">{shown}</p> : null}</div>
        {open.length ? <GroupList groups={open} own={false} /> : <p>No public groups yet.</p>}
      </section>
    </Layout>
  );
}

function JoinPanel({ group, viewer, invite }: { group: GroupRow; viewer: UserRow | null; invite: string | null }) {
  if (!viewer) {
    return (
      <section className="panel" id="join">
        <h2>Join this group</h2>
        <p>{`Sign in to join. ${JOIN_NOTE}`}</p>
        <a className="button primary" href="/login"><GitHubMark />Sign in with GitHub</a>
      </section>
    );
  }
  const reach = group.is_public
    ? 'This group is public: any signed-in account can join it. People outside the group see you on its board only while your profile is public.'
    : 'This group is private: only its members can open it, and they join with its invite link.';
  return (
    <section className="panel" id="join">
      <h2>Join this group</h2>
      <p>{JOIN_NOTE}</p>
      <p className="muted">{reach}</p>
      <form method="post" action={`/groups/${group.slug}/join`}>
        {invite === null ? null : <input type="hidden" name="invite" value={invite} />}
        <button className="primary">Join group</button>
      </form>
    </section>
  );
}

function GroupHead({ group, memberCount: count, standing, action }: { group: GroupRow; memberCount: number; standing: string; action?: ReactNode }) {
  return (
    <div className="page-head group-head">
      <div>
        <p className="group-crumb"><PageLink href="/groups">Groups</PageLink></p>
        <h1>{group.name}</h1>
        {group.description ? <p>{group.description}</p> : null}
        <p className="muted group-facts"><VisibilityBadge isPublic={group.is_public} /><span>{`${memberCountLabel(count)}${standing ? ` · ${standing}` : ''}`}</span></p>
      </div>
      {action ? <div className="actions">{action}</div> : null}
    </div>
  );
}

/** A member as every list names them: their GitHub avatar and login. */
function Face({ member }: { member: GroupMember }) {
  return (
    <>
      <img src={`${AVATARS}/${encodeURIComponent(member.login)}?s=56`} alt="" width={28} height={28} loading="lazy" />
      {`@${member.login}`}
    </>
  );
}

interface BoardRow {
  /** Null for a member with no usage in the period, who is listed below the ranked ones. */
  rank: number | null;
  tokens: number;
  member: GroupMember;
}

/**
 * A group's board, in the look of the public rankings. A member with a private profile is
 * named without a link, because their profile page would say it doesn't exist.
 */
function BoardTable({ rows, tokenColumn, ownerId, viewer }: { rows: BoardRow[]; tokenColumn: string; ownerId: string; viewer: UserRow | null }) {
  const most = rows[0]?.tokens ?? 0;
  return (
    <div className="table">
      <table className="standings group-board">
        <thead><tr><th className="rank">Rank</th><th>Member</th><td className="meter" aria-hidden="true"></td><th className="num">{tokenColumn}</th></tr></thead>
        <tbody>
          {rows.map(({ rank, tokens, member }) => {
            const mine = viewer?.id === member.id;
            const exact = commas(tokens);
            const short = compact(tokens);
            return (
              <tr key={member.id} className={mine ? 'me' : undefined}>
                <td className="rank">
                  {rank === null ? <span className="place">—</span> : <span className="place" data-place={rank <= 3 ? rank : undefined}>{rank}</span>}
                </td>
                <td className="who">
                  {member.is_public
                    ? <a href={`/u/${encodeURIComponent(member.login)}`}><Face member={member} /></a>
                    : <span className="group-member"><Face member={member} /></span>}
                  {mine ? <span className="badge">You</span> : null}
                  {member.id === ownerId ? <span className="badge">Owner</span> : null}
                </td>
                <td className="meter" aria-hidden="true">{rank === null ? null : <span style={share(tokens / most)}></span>}</td>
                <td className="num"><strong>{short}</strong>{short === exact ? null : <small>{exact}</small>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const DAYS: RankingPeriod['days'][] = ['all', 7, 30, 'month', 'last-month'];

interface GroupBoard {
  kind: 'board';
  group: GroupRow;
  role: Exclude<GroupRole, 'invited'>;
  viewer: UserRow | null;
  period: RankingPeriod;
  /** Ranked from the members this viewer may see, and no others. */
  board: Board;
  /** The members this viewer may see, by login. */
  members: GroupMember[];
  /** How many members the group has, seen or not. */
  memberCount: number;
  origin: string;
  inviteCode: string | null;
}

/** What someone holding a private group's invite link sees before joining: what it is, and nothing about who is in it. */
interface Invitation {
  kind: 'invitation';
  group: GroupRow;
  memberCount: number;
  invite: string;
  viewer: UserRow;
}

function OwnerPanels({ group, members, origin, inviteCode }: GroupBoard) {
  const path = `/groups/${group.slug}`;
  const address = `${origin}/groups/${group.slug}`;
  const others = members.length > 1;
  return (
    <>
      <section className="panel" id="manage">
        <h2>Group settings</h2>
        <form method="post" action={`${path}/edit`}>
          <DetailFields group={group} />
          <p className="muted">{group.is_public
            ? 'Making the group private hides it at once from everyone who is not a member.'
            : 'A private group can be made public only while every other member’s profile is public, because a public group lets anyone join and see its members’ totals.'}</p>
          <button className="primary">Save changes</button>
        </form>
      </section>
      <section className="panel">
        <h2>Invite link</h2>
        {group.is_public ? (
          <>
            <p>This group is public, so any signed-in account can join from its page.</p>
            <pre><code>{address}</code></pre>
          </>
        ) : (
          <>
            <p>Whoever opens this link while signed in can join, so send it only to the people you want in the group.</p>
            <pre><code>{`${address}?invite=${inviteCode ?? ''}`}</code></pre>
            <details className="confirm">
              <summary>Make a new link</summary>
              <form className="inline" method="post" action={`${path}/invite`}><span className="muted">The link above stops working. Members stay.</span><button>Make a new invite link</button></form>
            </details>
          </>
        )}
      </section>
      <section className="panel">
        <div className="panel-head"><h2>Members</h2><p className="muted">{`${members.length} of ${GROUP_LIMITS.members}`}</p></div>
        <ul className="group-list group-roster">
          {members.map((member) => {
            const owner = member.id === group.owner_id;
            return (
              <li key={member.id}>
                <div className="who">
                  <span className="group-member"><Face member={member} /></span>
                  {owner ? <span className="badge">Owner</span> : null}
                  <p>{`Joined ${member.joined_at.slice(0, 10)}`}</p>
                </div>
                {owner ? null : (
                  <details className="confirm">
                    <summary className="danger">Remove</summary>
                    <form className="inline" method="post" action={`${path}/members/${member.id}/remove`}><span className="muted">Takes them off this board.</span><button className="danger">Remove member</button></form>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      <section className="panel">
        <h2>Delete group</h2>
        {others ? <p>You own this group, so you can’t leave it while it has other members. Remove them first, or delete the group.</p> : null}
        <details className="confirm">
          <summary className="danger">Delete this group</summary>
          <form method="post" action={`${path}/delete`}>
            <p>This removes the group and its board for every member. Nobody’s usage is deleted. To confirm, type the group’s name, <code>{group.name}</code>.</p>
            <div className="group-confirm"><input type="text" name="confirm" aria-label="The group’s name" maxLength={GROUP_LIMITS.name} autoComplete="off" spellCheck="false" required /><button className="danger">Delete group</button></div>
          </form>
        </details>
      </section>
    </>
  );
}

function MemberPanel({ group }: { group: GroupRow }) {
  return (
    <section className="panel">
      <h2>Your membership</h2>
      <p>Your token totals show on this board to the group’s members, even while your profile is private. Machine names stay private.</p>
      <details className="confirm">
        <summary className="danger">Leave this group</summary>
        <form className="inline" method="post" action={`/groups/${group.slug}/leave`}>
          <span className="muted">{`Your totals stop showing here at once.${group.is_public ? '' : ' To come back, you need an invite link.'}`}</span>
          <button className="danger">Leave group</button>
        </form>
      </details>
    </section>
  );
}

function InvitationView({ group, memberCount: count, invite, viewer }: Invitation) {
  return (
    <Layout title={`Join ${group.name} · ${SITE}`} viewer={viewer}>
      <GroupHead group={group} memberCount={count} standing="You have an invite link." />
      <JoinPanel group={group} viewer={viewer} invite={invite} />
    </Layout>
  );
}

function BoardView(page: GroupBoard) {
  const { group, role, viewer, period, board, members, memberCount: count } = page;
  const inside = role !== 'visitor';
  const hidden = count - members.length;
  const byLogin = new Map(members.map((member) => [member.login.toLowerCase(), member]));
  const ranked: BoardRow[] = [];
  for (const { rank, label, tokens } of board.users) {
    const member = byLogin.get(label.toLowerCase());
    if (!member) continue;
    byLogin.delete(label.toLowerCase());
    ranked.push({ rank, tokens, member });
  }
  const rows = [...ranked, ...[...byLogin.values()].map((member): BoardRow => ({ rank: null, tokens: 0, member }))];
  const { rank, participants } = board.position;

  const path = `/groups/${group.slug}`;
  const tokenColumn = tokenColumnLabel(period.days);
  // The total is of the rows on this page. From outside, that leaves out members with private profiles, and the tile says so.
  const [short, exact] = [compact(board.tokens), commas(board.tokens)];
  const total = (
    <div className="tile">
      <span className="tile-label">{tokenColumn}</span>
      <strong>{short}</strong>
      {short === exact ? null : <span>{exact}</span>}
      {hidden > 0 && members.length ? <span>{`By the ${commas(members.length)} shown`}</span> : null}
    </div>
  );
  const shown = hidden <= 0 ? `${commas(participants)} ranked in this period`
    : members.length ? `${commas(members.length)} shown · ${commas(hidden)} not shown`
    : 'None shown';
  const audience = !inside
    ? hidden > 0 ? `${commas(hidden)} ${hidden === 1 ? 'member has a private profile and is' : 'members have private profiles and are'} not shown. Members of the group see everyone.` : ''
    : group.is_public
      ? 'Anyone can open this page. People outside the group see only the members whose profiles are public.'
      : 'Only this group’s members can open this page.';
  const standing = role === 'owner' ? 'You own this group.' : role === 'member' ? 'You are a member.' : '';
  const action = role === 'owner' ? <a className="button" href="#manage">Manage group</a>
    : role === 'visitor' ? <a className="button" href="#join">Join group</a>
    : null;
  const options = group.is_public ? { origin: page.origin, description: `${group.name}: a group on ${SITE}, with its members ranked by AI token usage.` } : {};
  return (
    <Layout title={`${group.name} · Groups · ${SITE}`} viewer={viewer} {...options}>
      <GroupHead group={group} memberCount={count} standing={standing} action={action} />
      <div className="toolbar">
        <nav className="segments group-periods" aria-label="Ranking periods">
          {DAYS.map((days) => (
            <PageLink key={days} href={`${path}?days=${days}`} aria-current={period.days === days ? 'page' : undefined}>{periodLabel(days)}</PageLink>
          ))}
        </nav>
      </div>
      {period.days === 'all' ? null : <p className="muted">{`${period.start} through ${period.end} · Reporting dates through today in UTC.`}</p>}
      <h2 className="sr">The group in numbers</h2>
      <div className="tiles group-tiles">
        {inside ? (
          <>
            {total}
            <div className="tile">
              <span className="tile-label">Your place</span>
              <strong>{rank === null ? '—' : `#${rank}`}</strong>
              <span>{rank === null ? 'No usage in this period' : `of ${commas(participants)} ranked ${participants === 1 ? 'member' : 'members'}`}</span>
            </div>
          </>
        ) : (
          <>
            <div className="tile"><span className="tile-label">Members</span><strong>{commas(count)}</strong><span>{shown}</span></div>
            {total}
          </>
        )}
      </div>
      <section className="panel">
        <div className="panel-head"><h2>Members by tokens</h2><p className="muted">Input, output, cache reads and cache writes</p></div>
        {rows.length ? <BoardTable rows={rows} tokenColumn={tokenColumn} ownerId={group.owner_id} viewer={viewer} /> : <p>No members to show.</p>}
        {audience ? <p className="muted group-audience">{audience}</p> : null}
      </section>
      {role === 'visitor' ? <JoinPanel group={group} viewer={viewer} invite={null} /> : role === 'owner' ? <OwnerPanels {...page} /> : <MemberPanel group={group} />}
    </Layout>
  );
}

type GroupProps = GroupBoard | Invitation;

function GroupView(props: GroupProps) {
  return props.kind === 'invitation' ? <InvitationView {...props} /> : <BoardView {...props} />;
}

const SLUG = /^[a-z0-9-]{1,64}$/;

/** `GET /groups`: every public group, and the viewer's own. */
export const groups: PageModule<GroupsProps> = {
  async load({ url, viewer, deps }) {
    const [open, mine] = await Promise.all([publicGroups(deps.db), viewer ? groupsOf(deps.db, viewer.id) : []]);
    return { props: { open, mine, viewer, origin: url.origin } };
  },
  View: GroupsView,
};

/** `GET /groups/<slug>`. A group that is missing and a private one this viewer may not see are not found alike. */
export const group: PageModule<GroupProps> = {
  async load({ url, viewer, deps, params }) {
    const { db } = deps;
    if (!SLUG.test(params.slug ?? '')) return { notFound: true };
    const invite = url.searchParams.get('invite');
    const opened = await openGroup(db, params.slug, viewer?.id ?? null, invite);
    if (!opened) return { notFound: true };
    const { group: found, role, inviteCode } = opened;
    if (role === 'invited') {
      // Joining belongs to an account, so signing in comes first, and returns here.
      if (!viewer) return { redirect: `/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}` };
      return { props: { kind: 'invitation', group: found, memberCount: await memberCount(db, found.id), invite: invite ?? '', viewer } };
    }
    const period = rankingPeriod(url.searchParams.get('days'), deps.now(), true);
    // From outside, a public group is its members with public profiles: their rows, and a total of theirs alone.
    const publicOnly = role === 'visitor';
    const [members, count, board] = await Promise.all([
      groupMembers(db, found.id, publicOnly),
      memberCount(db, found.id),
      wholeBoard(db, period, { kind: 'group', id: found.id, publicOnly }, publicOnly ? null : viewer?.id ?? null),
    ]);
    return { props: { kind: 'board', group: found, role, viewer, period, board, members, memberCount: count, origin: url.origin, inviteCode } };
  },
  View: GroupView,
  notFound: 'This group is private or does not exist.',
};
