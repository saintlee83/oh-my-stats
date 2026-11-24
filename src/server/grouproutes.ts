import type { Db, UserRow } from './db.ts';
import { groupNotice } from './grouppages.ts';
import {
  cleanGroupName,
  createGroup,
  deleteGroup,
  groupDetails,
  GROUP_LIMITS,
  joinGroup,
  leaveGroup,
  openGroup,
  removeMember,
  renewInvite,
  updateGroup,
} from './groups.ts';
import { rankBoard, type Board, type Membership, type RankingPeriod } from './rankings.ts';

/** What a group form answers: a page, or another address to go to. Neither is kept by a cache. */
export type GroupAnswer = { page: string; status: number } | { location: string };

const ALL_GROUPS = { href: '/groups', label: 'See all groups' };

const refused = (status: number, title: string, detail: string, viewer: UserRow | null, back = ALL_GROUPS): GroupAnswer =>
  ({ page: groupNotice(status, title, detail, back, viewer), status });

/** The one answer for a group that is missing and for a private one this viewer may not see. */
const hidden = (viewer: UserRow | null) => refused(404, 'This group is private or does not exist.', '', viewer);

const atJoinLimit = (viewer: UserRow) =>
  refused(400, `You are already in ${GROUP_LIMITS.joined} groups.`, 'That is the most an account can join. Leave one to join another.', viewer);

/** A group holds few enough members to show its board whole, however many pages that is read in. */
export async function wholeBoard(db: Db, period: RankingPeriod, members: Membership, viewerId: string | null): Promise<Board> {
  const first = await rankBoard(db, period, members, { viewerId });
  const users = [...first.users];
  for (let page = 2; page <= first.pages; page++) users.push(...(await rankBoard(db, period, members, { viewerId, page })).users);
  return { ...first, users };
}

const ACTION = /^\/groups\/([a-z0-9-]{1,64})\/(join|leave|edit|invite|delete|members\/(\d{1,20})\/remove)$/;

/** Every form under `/groups`, for a signed-in viewer whose request came from this site. */
export async function groupPost(db: Db, viewer: UserRow, path: string, form: URLSearchParams, now: string): Promise<GroupAnswer> {
  if (path === '/groups') {
    const details = groupDetails(form);
    if (!details.name) return refused(400, 'A group needs a name.', '', viewer);
    const made = await createGroup(db, viewer.id, details, now);
    if (made === 'owns-too-many') {
      return refused(400, `You already own ${GROUP_LIMITS.owned} groups.`, 'That is the most an account can own. Delete one to start another.', viewer);
    }
    return made === 'in-too-many' ? atJoinLimit(viewer) : { location: `/groups/${made.slug}` };
  }
  const [, slug, action, memberId] = ACTION.exec(path) ?? [];
  if (!slug) return refused(404, 'Page not found.', '', viewer);
  // Only joining takes an invite code. For anything else, a private group stays hidden from whoever is outside it.
  const opened = await openGroup(db, slug, viewer.id, action === 'join' ? form.get('invite') : null);
  if (!opened) return hidden(viewer);
  const { group, role } = opened;
  const board = `/groups/${group.slug}`;
  const back = { href: board, label: 'Back to the group' };
  const inside = role === 'owner' || role === 'member';

  if (action === 'join') {
    if (inside) return { location: board };
    const outcome = await joinGroup(db, group.id, viewer.id, now);
    if (outcome === 'full') return refused(400, 'This group is full.', `A group holds at most ${GROUP_LIMITS.members} members.`, viewer);
    return outcome === 'in-too-many' ? atJoinLimit(viewer) : { location: board };
  }
  if (action === 'leave') {
    if (!inside) return { location: board };
    if ((await leaveGroup(db, group, viewer.id)) === 'owner-stays') {
      return refused(400, 'The owner can’t leave while others remain.', 'Remove the other members first, or delete the group.', viewer, back);
    }
    return { location: '/groups' };
  }
  if (role !== 'owner') return refused(403, 'Only this group’s owner can do that.', '', viewer, back);

  if (action === 'edit') {
    const details = groupDetails(form);
    if (!details.name) return refused(400, 'A group needs a name.', '', viewer, back);
    if (!(await updateGroup(db, group.id, details, now))) {
      return refused(400, 'Nothing was changed. This group can’t be made public yet.',
        'Some members have private profiles, and joined a group that only invited people could see. A public group lets anyone join and see its members’ totals. They can publish their profiles or leave first.', viewer, back);
    }
    return { location: board };
  }
  if (action === 'invite') {
    await renewInvite(db, group.id, now);
    return { location: board };
  }
  if (action === 'delete') {
    // This can't be undone, so it takes more than a stray click.
    if (cleanGroupName(form.get('confirm')).toLowerCase() !== group.name.toLowerCase()) {
      return refused(400, 'Nothing was deleted. Type the group’s name to confirm.', '', viewer, back);
    }
    await deleteGroup(db, group.id);
    return { location: '/groups' };
  }
  await removeMember(db, group, memberId);
  return { location: board };
}
