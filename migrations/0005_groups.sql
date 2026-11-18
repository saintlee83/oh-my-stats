-- A named set of accounts with its own board. A private group is shown to its members only.
-- The invite code is kept as it is, so the owner can read the link again: it opens nothing
-- that this database doesn't already hold.
CREATE TABLE groups (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  owner_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  is_public    INTEGER NOT NULL DEFAULT 0,
  invite_code  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX groups_slug ON groups (slug);
CREATE INDEX groups_owner ON groups (owner_id);
CREATE INDEX groups_public ON groups (is_public);

-- Joining is what lets a group's members see an account's totals. The owner is always a member.
CREATE TABLE group_members (
  group_id   TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
) WITHOUT ROWID;
CREATE INDEX group_members_user ON group_members (user_id);
