import { commas, compact } from '../shared/format.ts';
import type { UserRow } from './db.ts';
import { GROUP_LIMITS, PUBLIC_GROUPS_SHOWN, type GroupMember, type GroupRole, type GroupRow, type GroupSummary } from './groups.ts';
import { esc, GITHUB_MARK, layout, periodLabel, SITE, tokenColumnLabel } from './pages.ts';
import type { Board, RankingPeriod } from './rankings.ts';

/** The pages for groups. A group's name and description are written by its owner and read by others, so both go through `esc`. */

const AVATARS = 'https://avatars.githubusercontent.com';

/** What joining a group shows, said wherever someone is about to join or has joined. */
const JOIN_NOTE = 'Joining shows your token totals to this group’s members, even while your profile is private. Machine names stay private.';

const memberCountLabel = (count: number) => `${commas(count)} ${count === 1 ? 'member' : 'members'}`;

const visibilityBadge = (isPublic: number) => `<span class="badge${isPublic ? ' live' : ''}">${isPublic ? 'Public' : 'Private'}</span>`;

/** The fields the create and edit forms share. */
function detailFields(group: Pick<GroupRow, 'name' | 'description' | 'is_public'> | null): string {
  const choice = (value: string, label: string, chosen: boolean) => `<option value="${value}"${chosen ? ' selected' : ''}>${label}</option>`;
  return `<div class="fields group-fields">
<label>Name<input type="text" name="name" value="${esc(group?.name ?? '')}" maxlength="${GROUP_LIMITS.name}" autocomplete="off" required></label>
<label>Who can see it<select name="visibility">${choice('private', 'Private: members only, by invite link', !group?.is_public)}${choice('public', 'Public: anyone can open it and join', Boolean(group?.is_public))}</select></label>
<label class="wide">Description<textarea name="description" maxlength="${GROUP_LIMITS.description}" rows="2" placeholder="Who this group is for">${esc(group?.description ?? '')}</textarea></label>
</div>`;
}

function groupList(groups: GroupSummary[], own: boolean): string {
  return `<ul class="group-list">${groups.map((group) => `<li><div><a href="/groups/${esc(group.slug)}">${esc(group.name)}</a>${
    own ? `${visibilityBadge(group.is_public)}${group.owned ? '<span class="badge">Owner</span>' : ''}` : ''
  }${group.description ? `<p>${esc(group.description)}</p>` : ''}</div><span class="group-count">${memberCountLabel(group.members)}</span></li>`).join('')}</ul>`;
}

export function groupsPage(open: GroupSummary[], mine: GroupSummary[], viewer: UserRow | null, origin: string): string {
  const owned = mine.filter((group) => group.owned).length;
  const start = owned >= GROUP_LIMITS.owned
    ? `<p class="muted">You own ${GROUP_LIMITS.owned} groups, the most an account can. Delete one to start another.</p>`
    : mine.length >= GROUP_LIMITS.joined
      ? `<p class="muted">You are in ${GROUP_LIMITS.joined} groups, the most an account can join. Leave one to start another.</p>`
      : `<details class="group-start"><summary class="button">Start a group</summary>
<form method="post" action="/groups">
<p>You become its owner and its first member. ${JOIN_NOTE}</p>
${detailFields(null)}
<button class="primary">Create group</button>
</form></details>`;
  const own = viewer
    ? `<section class="panel"><div class="panel-head"><h2>My groups</h2><p class="muted">${mine.length} of ${GROUP_LIMITS.joined} · Only you can see this list.</p></div>
${mine.length ? groupList(mine, true) : '<p>You are not in a group yet. Start one, or join a public group below.</p>'}
${start}</section>`
    : '';
  const shown = open.length >= PUBLIC_GROUPS_SHOWN ? `The ${PUBLIC_GROUPS_SHOWN} largest` : `${commas(open.length)} ${open.length === 1 ? 'group' : 'groups'}, most members first`;
  return layout(`Groups · ${SITE}`, `<div class="page-head"><div><h1>Groups</h1>
<p>A board for a team or a circle of friends: its members, ranked by AI tokens.</p></div>
${viewer ? '' : `<div class="actions"><a class="button" href="/login">${GITHUB_MARK}Sign in to start a group</a></div>`}</div>
${own}
<section class="panel"><div class="panel-head"><h2>Public groups</h2>${open.length ? `<p class="muted">${shown}</p>` : ''}</div>
${open.length ? groupList(open, false) : '<p>No public groups yet.</p>'}</section>`, viewer, {
    origin,
    description: `Groups on ${SITE}: a board for a team or a circle of friends, ranking its members by AI token usage.`,
  });
}

function joinPanel(group: GroupRow, viewer: UserRow | null, invite: string | null): string {
  if (!viewer) {
    return `<section class="panel" id="join"><h2>Join this group</h2>
<p>Sign in to join. ${JOIN_NOTE}</p>
<a class="button primary" href="/login">${GITHUB_MARK}Sign in with GitHub</a></section>`;
  }
  const reach = group.is_public
    ? 'This group is public: any signed-in account can join it. People outside the group see you on its board only while your profile is public.'
    : 'This group is private: only its members can open it, and they join with its invite link.';
  return `<section class="panel" id="join"><h2>Join this group</h2>
<p>${JOIN_NOTE}</p>
<p class="muted">${reach}</p>
<form method="post" action="/groups/${esc(group.slug)}/join">${invite === null ? '' : `<input type="hidden" name="invite" value="${esc(invite)}">`}<button class="primary">Join group</button></form></section>`;
}

function groupHead(group: GroupRow, memberCount: number, standing: string, action = ''): string {
  return `<div class="page-head group-head"><div><p class="group-crumb"><a href="/groups">Groups</a></p><h1>${esc(group.name)}</h1>
${group.description ? `<p>${esc(group.description)}</p>` : ''}
<p class="muted group-facts">${visibilityBadge(group.is_public)}<span>${memberCountLabel(memberCount)}${standing ? ` · ${standing}` : ''}</span></p></div>
${action ? `<div class="actions">${action}</div>` : ''}</div>`;
}

/** What someone holding a private group's invite link sees before joining: what it is, and nothing about who is in it. */
export function invitationPage(group: GroupRow, memberCount: number, invite: string, viewer: UserRow): string {
  return layout(`Join ${group.name} · ${SITE}`, `${groupHead(group, memberCount, 'You have an invite link.')}
${joinPanel(group, viewer, invite)}`, viewer);
}

/** A member as every list names them: their GitHub avatar and login. */
const face = (member: GroupMember) =>
  `<img src="${AVATARS}/${esc(encodeURIComponent(member.login))}?s=56" alt="" width="28" height="28" loading="lazy">@${esc(member.login)}`;

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
function boardTable(rows: BoardRow[], tokenColumn: string, ownerId: string, viewer: UserRow | null): string {
  const most = rows[0]?.tokens ?? 0;
  const body = rows.map(({ rank, tokens, member }) => {
    const mine = viewer?.id === member.id;
    const who = `${member.is_public ? `<a href="/u/${esc(encodeURIComponent(member.login))}">${face(member)}</a>` : `<span class="group-member">${face(member)}</span>`}${
      mine ? '<span class="badge">You</span>' : ''}${member.id === ownerId ? '<span class="badge">Owner</span>' : ''}`;
    const exact = commas(tokens);
    const short = compact(tokens);
    const place = rank === null ? '<span class="place">—</span>' : `<span class="place"${rank <= 3 ? ` data-place="${rank}"` : ''}>${rank}</span>`;
    const meter = rank === null ? '' : `<span style="--share:${((100 * tokens) / most).toFixed(1)}%"></span>`;
    return `<tr${mine ? ' class="me"' : ''}><td class="rank">${place}</td><td class="who">${who}</td>
<td class="meter" aria-hidden="true">${meter}</td>
<td class="num"><strong>${short}</strong>${short === exact ? '' : `<small>${exact}</small>`}</td></tr>`;
  }).join('');
  return `<div class="table"><table class="standings group-board"><thead><tr><th class="rank">Rank</th><th>Member</th><td class="meter" aria-hidden="true"></td><th class="num">${tokenColumn}</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

const DAYS: RankingPeriod['days'][] = ['all', 7, 30, 'month', 'last-month'];

export interface GroupPage {
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

function ownerPanels({ group, members, origin, inviteCode }: GroupPage): string {
  const path = `/groups/${esc(group.slug)}`;
  const address = `${origin}/groups/${group.slug}`;
  const others = members.length > 1;
  const invite = group.is_public
    ? `<p>This group is public, so any signed-in account can join from its page.</p><pre><code>${esc(address)}</code></pre>`
    : `<p>Whoever opens this link while signed in can join, so send it only to the people you want in the group.</p>
<pre><code>${esc(`${address}?invite=${inviteCode ?? ''}`)}</code></pre>
<details class="confirm"><summary>Make a new link</summary><form class="inline" method="post" action="${path}/invite"><span class="muted">The link above stops working. Members stay.</span><button>Make a new invite link</button></form></details>`;
  const roster = members.map((member) => {
    const owner = member.id === group.owner_id;
    return `<li><div class="who"><span class="group-member">${face(member)}</span>${owner ? '<span class="badge">Owner</span>' : ''}<p>Joined ${esc(member.joined_at.slice(0, 10))}</p></div>
${owner ? '' : `<details class="confirm"><summary class="danger">Remove</summary><form class="inline" method="post" action="${path}/members/${esc(member.id)}/remove"><span class="muted">Takes them off this board.</span><button class="danger">Remove member</button></form></details>`}</li>`;
  }).join('');
  return `<section class="panel" id="manage"><h2>Group settings</h2>
<form method="post" action="${path}/edit">
${detailFields(group)}
<p class="muted">${group.is_public
    ? 'Making the group private hides it at once from everyone who is not a member.'
    : 'A private group can be made public only while every other member’s profile is public, because a public group lets anyone join and see its members’ totals.'}</p>
<button class="primary">Save changes</button>
</form>
</section>
<section class="panel"><h2>Invite link</h2>
${invite}</section>
<section class="panel"><div class="panel-head"><h2>Members</h2><p class="muted">${members.length} of ${GROUP_LIMITS.members}</p></div>
<ul class="group-list group-roster">${roster}</ul></section>
<section class="panel"><h2>Delete group</h2>
${others ? '<p>You own this group, so you can’t leave it while it has other members. Remove them first, or delete the group.</p>' : ''}
<details class="confirm"><summary class="danger">Delete this group</summary>
<form method="post" action="${path}/delete">
<p>This removes the group and its board for every member. Nobody’s usage is deleted. To confirm, type the group’s name, <code>${esc(group.name)}</code>.</p>
<div class="group-confirm"><input type="text" name="confirm" aria-label="The group’s name" maxlength="${GROUP_LIMITS.name}" autocomplete="off" spellcheck="false" required><button class="danger">Delete group</button></div>
</form></details></section>`;
}

function memberPanel(group: GroupRow): string {
  return `<section class="panel"><h2>Your membership</h2>
<p>Your token totals show on this board to the group’s members, even while your profile is private. Machine names stay private.</p>
<details class="confirm"><summary class="danger">Leave this group</summary><form class="inline" method="post" action="/groups/${esc(group.slug)}/leave"><span class="muted">Your totals stop showing here at once.${
    group.is_public ? '' : ' To come back, you need an invite link.'}</span><button class="danger">Leave group</button></form></details></section>`;
}

export function groupPage(page: GroupPage): string {
  const { group, role, viewer, period, board, members, memberCount } = page;
  const inside = role !== 'visitor';
  const hidden = memberCount - members.length;
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

  const path = `/groups/${esc(group.slug)}`;
  const periods = DAYS.map((days) => `<a href="${path}?days=${days}"${period.days === days ? ' aria-current="page"' : ''}>${periodLabel(days)}</a>`).join('');
  const tokenColumn = tokenColumnLabel(period.days);
  // The total is of the rows on this page. From outside, that leaves out members with private profiles, and the tile says so.
  const [short, exact] = [compact(board.tokens), commas(board.tokens)];
  const total = `<div class="tile"><span class="tile-label">${tokenColumn}</span><strong>${short}</strong>${short === exact ? '' : `<span>${exact}</span>`}${
    hidden > 0 && members.length ? `<span>By the ${commas(members.length)} shown</span>` : ''}</div>`;
  const shown = hidden <= 0 ? `${commas(participants)} ranked in this period`
    : members.length ? `${commas(members.length)} shown · ${commas(hidden)} not shown`
    : 'None shown';
  const tiles = `<div class="tiles group-tiles">${inside
    ? `${total}<div class="tile"><span class="tile-label">Your place</span><strong>${rank === null ? '—' : `#${rank}`}</strong><span>${
      rank === null ? 'No usage in this period' : `of ${commas(participants)} ranked ${participants === 1 ? 'member' : 'members'}`}</span></div>`
    : `<div class="tile"><span class="tile-label">Members</span><strong>${commas(memberCount)}</strong><span>${shown}</span></div>${total}`}</div>`;
  const audience = !inside
    ? hidden > 0 ? `${commas(hidden)} ${hidden === 1 ? 'member has a private profile and is' : 'members have private profiles and are'} not shown. Members of the group see everyone.` : ''
    : group.is_public
      ? 'Anyone can open this page. People outside the group see only the members whose profiles are public.'
      : 'Only this group’s members can open this page.';
  const standing = role === 'owner' ? 'You own this group.' : role === 'member' ? 'You are a member.' : '';
  const action = role === 'owner' ? '<a class="button" href="#manage">Manage group</a>'
    : role === 'visitor' ? '<a class="button" href="#join">Join group</a>'
    : '';
  return layout(`${group.name} · Groups · ${SITE}`, `${groupHead(group, memberCount, standing, action)}
<div class="toolbar"><nav class="segments group-periods" aria-label="Ranking periods">${periods}</nav></div>
${period.days === 'all' ? '' : `<p class="muted">${period.start} through ${period.end} · Reporting dates through today in UTC.</p>`}
<h2 class="sr">The group in numbers</h2>${tiles}
<section class="panel"><div class="panel-head"><h2>Members by tokens</h2><p class="muted">Input, output, cache reads and cache writes</p></div>
${rows.length ? boardTable(rows, tokenColumn, group.owner_id, viewer) : '<p>No members to show.</p>'}
${audience ? `<p class="muted group-audience">${audience}</p>` : ''}</section>
${role === 'visitor' ? joinPanel(group, viewer, null) : role === 'owner' ? ownerPanels(page) : memberPanel(group)}`, viewer, group.is_public
    ? { origin: page.origin, description: `${group.name}: a group on ${SITE}, with its members ranked by AI token usage.` }
    : {});
}

/** A refusal: what happened, what to do about it, and a way back. */
export function groupNotice(status: number, title: string, detail: string, back: { href: string; label: string }, viewer: UserRow | null): string {
  return layout(`${status} · ${SITE}`, `<div class="notice group-notice"><p class="code">${status}</p><h1>${esc(title)}</h1>
${detail ? `<p>${esc(detail)}</p>` : ''}
<div class="actions"><a class="button" href="${esc(back.href)}">${esc(back.label)}</a></div></div>`, viewer);
}
