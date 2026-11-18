import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOARD_PAGE, previousPeriod, rankBoard, rankingPage, rankingPeriod } from '../src/server/rankings.ts';
import { BadRequest } from '../src/server/wire.ts';
import { testDb } from './sqlite-d1.ts';

const NOW = new Date('2026-11-09T05:00:00Z');

test('periods are days in UTC, and pages can also ask for a calendar month', () => {
  assert.deepEqual(rankingPeriod(null, NOW), { days: 'all', start: null, end: null });
  assert.deepEqual(rankingPeriod('7', NOW), { days: 7, start: '2026-11-03', end: '2026-11-09' });
  assert.deepEqual(rankingPeriod('month', NOW, true), { days: 'month', start: '2026-11-01', end: '2026-11-09' });
  assert.deepEqual(rankingPeriod('last-month', NOW, true), { days: 'last-month', start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(rankingPeriod('last-month', new Date('2027-01-15T00:00:00Z'), true), { days: 'last-month', start: '2026-12-01', end: '2026-12-31' });
  assert.deepEqual(rankingPeriod('last-month', new Date('2028-03-31T23:00:00Z'), true).end, '2028-02-29', 'a leap year');
  for (const value of ['month', 'last-month']) assert.throws(() => rankingPeriod(value, NOW), BadRequest, 'the agent API keeps its three periods');
  for (const value of ['0', '8', 'week', '']) assert.throws(() => rankingPeriod(value, NOW, true), BadRequest, value);
});

test('each period is compared with the stretch right before it', () => {
  assert.equal(previousPeriod(rankingPeriod('all', NOW)), null);
  assert.deepEqual(previousPeriod(rankingPeriod('7', NOW)), { days: 7, start: '2026-10-27', end: '2026-11-02' });
  assert.deepEqual(previousPeriod(rankingPeriod('30', NOW)), { days: 30, start: '2026-09-11', end: '2026-10-10' });
  assert.deepEqual(previousPeriod(rankingPeriod('month', NOW, true)), { days: 'last-month', start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(previousPeriod(rankingPeriod('last-month', NOW, true)), { days: 'last-month', start: '2026-09-01', end: '2026-09-30' });
});

test('a page of a board is named by a small whole number', () => {
  assert.equal(rankingPage(null), 1);
  assert.equal(rankingPage('12'), 12);
  for (const value of ['0', '-1', '1.5', 'two', '10000', '01']) assert.throws(() => rankingPage(value), BadRequest, value);
});

test('a board is read a page at a time, with its totals and the viewer’s place on every page', async () => {
  const db = testDb();
  db.raw.exec(`
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<205)
    INSERT INTO users (id, login, name, is_public, created_at, updated_at)
    SELECT i, printf('member-%03d', i), CASE WHEN i % 2 THEN printf('Member %d', i) END, i <> 205, '2026-11-01', '2026-11-01' FROM n;
    INSERT INTO machines (user_id,id,name,created_at,last_seen_at) SELECT id,'a','Primary','2026-11-01','2026-11-01' FROM users;
    INSERT INTO usage_daily SELECT id,'a','2026-11-08','codex','m',1000 - id,0,0,0,1 FROM users;
    INSERT INTO usage_daily SELECT id,'a','2026-10-20','pi','m',5,0,0,0,1 FROM users WHERE CAST(id AS INTEGER) <= 3;
  `);
  const week = rankingPeriod('7', NOW);
  const first = await rankBoard(db, week, { kind: 'public' }, { viewerId: '150' });
  assert.equal(first.users.length, BOARD_PAGE);
  assert.deepEqual(first.users[0], { rank: 1, label: 'member-001', name: 'Member 1', tokens: 999 });
  assert.deepEqual(first.users[1], { rank: 2, label: 'member-002', name: null, tokens: 998 });
  assert.deepEqual(first.position, { days: 7, rank: 150, participants: 204 }, 'the viewer is on another page, and the private member is not counted');
  assert.deepEqual([first.page, first.pages], [1, 3]);
  assert.equal(first.tokens, Array.from({ length: 204 }, (_, i) => 999 - i).reduce((sum, value) => sum + value, 0));
  assert.deepEqual(first.providers, [{ tool: 'codex', tokens: first.tokens, profiles: 204 }]);

  const last = await rankBoard(db, week, { kind: 'public' }, { viewerId: '150', page: 3 });
  assert.deepEqual(last.users.map((row) => row.rank), [201, 202, 203, 204]);
  assert.deepEqual([last.position, last.tokens, last.pages], [first.position, first.tokens, 3]);
  const beyond = await rankBoard(db, week, { kind: 'public' }, { page: 9 });
  assert.deepEqual([beyond.users, beyond.position.participants, beyond.tokens, beyond.pages], [[], 204, first.tokens, 3], 'an empty page still knows the board');

  const lifetime = await rankBoard(db, rankingPeriod('all', NOW), { kind: 'public' }, { provider: 'pi' });
  assert.deepEqual(lifetime.users.map((row) => [row.label, row.tokens]), [['member-001', 5], ['member-002', 5], ['member-003', 5]]);
  assert.deepEqual([lifetime.position.participants, lifetime.tokens], [3, 15]);
  assert.deepEqual((await rankBoard(db, rankingPeriod('last-month', NOW, true), { kind: 'public' })).providers, [{ tool: 'pi', tokens: 15, profiles: 3 }]);
  assert.deepEqual((await rankBoard(db, week, { kind: 'user', id: '205' })).users.map((row) => row.label), ['member-205'], 'one account, public or not');
});
