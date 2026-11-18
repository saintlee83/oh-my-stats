import { cleanLine } from '../shared/profile.ts';
import { safeEqual } from './auth.ts';
import type { Db } from './db.ts';

/**
 * Groups: who is in them, and who may see them. Every page and form opens a group through
 * `openGroup`, which is the one place that decides whether a viewer may know it exists.
 */

/** Text in characters. An account owns and joins only so many groups, and a group holds only so many members. */
export const GROUP_LIMITS = { name: 40, description: 200, owned: 5, joined: 20, members: 200 } as const;

/** How many public groups the list shows, largest first. */
export const PUBLIC_GROUPS_SHOWN = 100;

/** Other people read this text. Markup has no place in it, as in a machine's name, and what is left is one clean line. */
function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? cleanLine(value.normalize('NFC').replace(/[<>&"']/g, ''), max) ?? '' : '';
}

export const cleanGroupName = (value: unknown) => cleanText(value, GROUP_LIMITS.name);

export interface GroupDetails {
  /** Empty when the form gave no usable name. */
  name: string;
  description: string;
  isPublic: boolean;
}

/** From the create and edit forms. A group is private unless the form says public. */
export const groupDetails = (form: URLSearchParams): GroupDetails => ({
  name: cleanGroupName(form.get('name')),
  description: cleanText(form.get('description'), GROUP_LIMITS.description),
  isPublic: form.get('visibility') === 'public',
});

/** Thirty-two symbols, so each takes five random bits evenly. None is easily misread for another. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function randomPart(length: number): string {
  return [...crypto.getRandomValues(new Uint8Array(length))].map((byte) => ALPHABET[byte & 31]).join('');
}

/**
 * A group's address: its name in lowercase ASCII, then a random part. A name with no ASCII
 * letters has the random part alone. No address can be had by choosing a name, so starting a
 * group never tells whether another one, perhaps private, already has that name.
 */
export function groupSlug(name: string): string {
  const base = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').slice(0, GROUP_LIMITS.name).replace(/^-+|-+$/g, '');
  return /[a-z]/.test(base) ? `${base}-${randomPart(6)}` : randomPart(10);
}

/** 120 random bits: far too many to guess, and short enough for a link. */
const inviteCode = () => randomPart(24);

export interface GroupRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  owner_id: string;
  is_public: number;
}

/**
 * How a viewer stands to a group they may see. A visitor is anyone looking at a public group
 * from outside. Someone invited holds a private group's invite code and has not joined yet.
 */
export type GroupRole = 'owner' | 'member' | 'visitor' | 'invited';

export interface OpenedGroup {
  group: GroupRow;
  role: GroupRole;
  /** The code in the invite link, handed to the owner alone. */
  inviteCode: string | null;
}

/**
 * A group as one viewer may see it. A private group is given only to its members and to
 * whoever holds its invite code. Everyone else gets what a missing group gets, so nothing
 * built on this can tell the two apart.
 */
export async function openGroup(db: Db, slug: string, viewerId: string | null, invite: string | null = null): Promise<OpenedGroup | null> {
  const row = await db.prepare(`SELECT id, slug, name, description, owner_id, is_public, invite_code,
      EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = groups.id AND m.user_id = ?2) AS is_member
    FROM groups WHERE slug = ?1`).bind(slug, viewerId).first<GroupRow & { invite_code: string; is_member: number }>();
  // Compared whether or not there is a group, so the time an answer takes says nothing about one.
  const codeMatches = await safeEqual(invite ?? '', row?.invite_code ?? '');
  if (!row) return null;
  const { invite_code: code, is_member: isMember, ...group } = row;
  const role: GroupRole | null = group.owner_id === viewerId ? 'owner'
    : isMember ? 'member'
    : group.is_public ? 'visitor'
    : invite && codeMatches ? 'invited'
    : null;
  return role && { group, role, inviteCode: role === 'owner' ? code : null };
}

export interface GroupSummary {
  slug: string;
  name: string;
  description: string;
  is_public: number;
  members: number;
  /** Whether the account asked about owns it. */
  owned: number;
}

/** The largest public groups. Members are counted whether their profiles are public or not. */
export async function publicGroups(db: Db): Promise<GroupSummary[]> {
  const { results } = await db.prepare(`SELECT g.slug, g.name, g.description, g.is_public, COUNT(*) AS members, 0 AS owned
    FROM groups g JOIN group_members m ON m.group_id = g.id
    WHERE g.is_public = 1
    GROUP BY g.id ORDER BY members DESC, g.name COLLATE NOCASE, g.id LIMIT ?`).bind(PUBLIC_GROUPS_SHOWN).all<GroupSummary>();
  return results;
}

/** Every group an account is in, private ones included. Only that account is shown this. */
export async function groupsOf(db: Db, userId: string): Promise<GroupSummary[]> {
  const { results } = await db.prepare(`SELECT g.slug, g.name, g.description, g.is_public, g.owner_id = ?1 AS owned,
      (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS members
    FROM group_members mine JOIN groups g ON g.id = mine.group_id
    WHERE mine.user_id = ?1 ORDER BY g.name COLLATE NOCASE, g.id`).bind(userId).all<GroupSummary>();
  return results;
}

export interface GroupMember {
  id: string;
  login: string;
  is_public: number;
  joined_at: string;
}

/** A group's members by login. `publicOnly` leaves out private profiles, for a viewer outside the group. */
export async function groupMembers(db: Db, groupId: string, publicOnly: boolean): Promise<GroupMember[]> {
  const { results } = await db.prepare(`SELECT u.id, u.login, u.is_public, m.joined_at
    FROM group_members m JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ?${publicOnly ? ' AND u.is_public = 1' : ''}
    ORDER BY u.login COLLATE NOCASE, u.id`).bind(groupId).all<GroupMember>();
  return results;
}

export async function memberCount(db: Db, groupId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS members FROM group_members WHERE group_id = ?').bind(groupId).first<{ members: number }>();
  return row?.members ?? 0;
}

/** A group's address is random, so a clash is rare. A few more tries always find a free one. */
const SLUG_TRIES = 5;

/** Starts a group with its owner as the first member, unless the account is at one of its limits. */
export async function createGroup(db: Db, ownerId: string, details: GroupDetails, now: string): Promise<{ slug: string } | 'owns-too-many' | 'in-too-many'> {
  const counts = await db.prepare(`SELECT (SELECT COUNT(*) FROM groups WHERE owner_id = ?1) AS owned,
    (SELECT COUNT(*) FROM group_members WHERE user_id = ?1) AS joined`).bind(ownerId).first<{ owned: number; joined: number }>();
  if ((counts?.owned ?? 0) >= GROUP_LIMITS.owned) return 'owns-too-many';
  if ((counts?.joined ?? 0) >= GROUP_LIMITS.joined) return 'in-too-many';
  for (let attempt = 0; attempt < SLUG_TRIES; attempt++) {
    const id = crypto.randomUUID();
    const slug = groupSlug(details.name);
    // The limits are checked again as the row is written, so two requests at once can't both pass.
    await db.batch([
      db.prepare(`INSERT INTO groups (id, slug, name, description, owner_id, is_public, invite_code, created_at, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8
        WHERE NOT EXISTS (SELECT 1 FROM groups WHERE slug = ?2)
          AND (SELECT COUNT(*) FROM groups WHERE owner_id = ?5) < ?9
          AND (SELECT COUNT(*) FROM group_members WHERE user_id = ?5) < ?10`)
        .bind(id, slug, details.name, details.description, ownerId, details.isPublic ? 1 : 0, inviteCode(), now, GROUP_LIMITS.owned, GROUP_LIMITS.joined),
      db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) SELECT id, owner_id, created_at FROM groups WHERE id = ?').bind(id),
    ]);
    if (await db.prepare('SELECT 1 FROM groups WHERE id = ?').bind(id).first()) return { slug };
  }
  throw new Error('no free address for a new group');
}

/** Adds a member, unless the group is full or the account is in too many. Joining twice changes nothing. */
export async function joinGroup(db: Db, groupId: string, userId: string, now: string): Promise<'joined' | 'full' | 'in-too-many'> {
  const added = await db.prepare(`INSERT INTO group_members (group_id, user_id, joined_at)
    SELECT ?1, ?2, ?3
    WHERE (SELECT COUNT(*) FROM group_members WHERE group_id = ?1) < ?4
      AND (SELECT COUNT(*) FROM group_members WHERE user_id = ?2) < ?5
    ON CONFLICT DO NOTHING
    RETURNING user_id`).bind(groupId, userId, now, GROUP_LIMITS.members, GROUP_LIMITS.joined).first();
  if (added) return 'joined';
  const state = await db.prepare(`SELECT (SELECT COUNT(*) FROM group_members WHERE group_id = ?1) AS members,
    EXISTS (SELECT 1 FROM group_members WHERE group_id = ?1 AND user_id = ?2) AS already`).bind(groupId, userId).first<{ members: number; already: number }>();
  if (state?.already) return 'joined';
  return (state?.members ?? 0) >= GROUP_LIMITS.members ? 'full' : 'in-too-many';
}

export async function deleteGroup(db: Db, groupId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM group_members WHERE group_id = ?').bind(groupId),
    db.prepare('DELETE FROM groups WHERE id = ?').bind(groupId),
  ]);
}

/**
 * Takes a member out of a group. Its owner stays while anyone else is in it, because a group
 * without one could not be managed. The last one out leaves nothing to keep, so the group goes too.
 */
export async function leaveGroup(db: Db, group: GroupRow, userId: string): Promise<'left' | 'owner-stays'> {
  if (group.owner_id !== userId) {
    await db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').bind(group.id, userId).run();
    return 'left';
  }
  if ((await memberCount(db, group.id)) > 1) return 'owner-stays';
  await deleteGroup(db, group.id);
  return 'left';
}

/**
 * Saves the owner's changes. Whoever joined a private group agreed to show their totals to the
 * people its owner invites. A public group lets anyone join and look, so a group can't be made
 * public while a member other than its owner has a private profile. False when that stopped it.
 */
export async function updateGroup(db: Db, groupId: string, details: GroupDetails, now: string): Promise<boolean> {
  const saved = await db.prepare(`UPDATE groups SET name = ?2, description = ?3, is_public = ?4, updated_at = ?5
    WHERE id = ?1 AND (?4 = 0 OR is_public = 1 OR NOT EXISTS (
      SELECT 1 FROM group_members m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = groups.id AND u.is_public = 0 AND u.id <> groups.owner_id))
    RETURNING id`).bind(groupId, details.name, details.description, details.isPublic ? 1 : 0, now).first();
  return saved !== null;
}

/** Replaces the invite code, so a link already handed out stops working. */
export async function renewInvite(db: Db, groupId: string, now: string): Promise<void> {
  await db.prepare('UPDATE groups SET invite_code = ?, updated_at = ? WHERE id = ?').bind(inviteCode(), now, groupId).run();
}

/** Removes a member. The owner can't be removed from their own group. */
export async function removeMember(db: Db, group: GroupRow, memberId: string): Promise<void> {
  await db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ? AND user_id <> ?').bind(group.id, memberId, group.owner_id).run();
}
