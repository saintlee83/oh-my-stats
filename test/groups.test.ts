import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GROUP_LIMITS, groupSlug, openGroup, PUBLIC_GROUPS_SHOWN } from '../src/server/groups.ts';
import { rankBoard, rankingPeriod } from '../src/server/rankings.ts';
import { commas, compact } from '../src/shared/format.ts';
import { api, app, machine, MACHINE_A, octo, ORIGIN, SECRET_NAME, upload, webLogin, webPost, type GitHubUser } from './harness.ts';
import type { testDb } from './sqlite-d1.ts';

/** Who the tests are about: an owner, a member with a public profile, one with a private profile, and a stranger. */
const PEOPLE = {
  octo,
  alpha: { id: 2, login: 'alpha' },
  beta: { id: 3, login: 'beta' },
  mallory: { id: 4, login: 'mallory' },
} satisfies Record<string, GitHubUser>;

type Person = keyof typeof PEOPLE;

const JOIN_NOTE = 'Joining shows your token totals to this group’s members, even while your profile is private. Machine names stay private.';
const HIDDEN = /<p class="code">404<\/p><h1>This group is private or does not exist\.<\/h1>/;

/** A server where each person has a website session, and the helpers to act as them. */
async function world(overrides: Parameters<typeof app>[0] = {}) {
  const tokens: Record<string, GitHubUser> = { ...PEOPLE, 'web-token': octo };
  const context = app(overrides, tokens);
  const sessions = {} as Record<Person, string>;
  for (const name of Object.keys(PEOPLE) as Person[]) {
    tokens['web-token'] = PEOPLE[name];
    sessions[name] = await webLogin(context);
  }
  const raw = (context.deps.db as ReturnType<typeof testDb>).raw;
  const get = (path: string, who: Person | null = null) => context.call(path, who ? { headers: { cookie: sessions[who] } } : {});
  const post = (path: string, who: Person, fields: Record<string, string> = {}) =>
    context.call(path, webPost(sessions[who], new URLSearchParams(fields).toString()));
  const page = async (path: string, who: Person | null = null) => {
    const response = await get(path, who);
    assert.equal(response.status, 200, `${path} for ${who ?? 'a signed-out visitor'}`);
    return response.text();
  };
  /** Starts a group and gives its address. */
  const start = async (who: Person, name: string, visibility: 'public' | 'private', description = '') => {
    const made = await post('/groups', who, { name, description, visibility });
    assert.equal(made.status, 303, await made.clone().text());
    return made.headers.get('location') as string;
  };
  const count = (sql: string, ...values: (string | number)[]) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...values) as { n: number }).n;
  const inviteOf = (path: string) => (raw.prepare('SELECT invite_code FROM groups WHERE slug = ?').get(path.slice('/groups/'.length)) as { invite_code: string }).invite_code;
  const join = async (path: string, who: Person) => {
    const joined = await post(`${path}/join`, who, { invite: inviteOf(path) });
    assert.equal(joined.status, 303, `${who} joins`);
  };
  /** Uploads one machine's usage for a person, and publishes their profile when asked. */
  const usage = async (who: Person, days: Record<string, number>, isPublic: boolean) => {
    const signedIn = await context.call('/v1/auth/token', api(null, 'POST', { githubToken: who, machine: machine(MACHINE_A) }));
    const { token } = await signedIn.json() as { token: string };
    const body = { ...upload(MACHINE_A), days: Object.fromEntries(Object.entries(days).map(([day, tokens]) => [day, { 'claude/claude-opus-5-5': [tokens, 0, 0, 0, 1] }])) };
    assert.equal((await context.call('/v1/usage', api(token, 'PUT', body))).status, 200);
    assert.equal((await context.call('/v1/me', api(token, 'PATCH', { public: isPublic }))).status, 200);
    return token;
  };
  return { context, sessions, raw, get, post, page, start, count, inviteOf, join, usage };
}

/** Everything a visitor could tell two answers apart by. */
async function told(response: Response) {
  return { status: response.status, headers: [...response.headers].sort(), body: await response.text() };
}

/** A board's rows as the page shows them: the place, the login and the exact tokens. */
function boardRows(html: string) {
  const table = /<table class="standings group-board">[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
  const row = /<tr[^>]*><td class="rank"><span class="place"[^>]*>([^<]+)<\/span><\/td><td class="who">[\s\S]*?@([A-Za-z0-9-]+)[\s\S]*?<td class="num"><strong>([^<]+)<\/strong>(?:<small>([^<]+)<\/small>)?<\/td><\/tr>/g;
  return [...table.matchAll(row)].map(([, place, login, short, exact]) => ({ place, login, tokens: exact ?? short }));
}

test('a group starts private, with its owner as the first member, at an address made from its name', async () => {
  const { post, page, count, raw } = await world();
  const made = await post('/groups', 'octo', { name: 'Platform team', description: 'Everyone on the platform.' });
  assert.equal(made.status, 303);
  assert.equal(made.headers.get('cache-control'), 'no-store');
  const path = made.headers.get('location') as string;
  assert.match(path, /^\/groups\/platform-team-[0-9a-z]{6}$/);
  assert.deepEqual({ ...raw.prepare('SELECT name, description, owner_id, is_public FROM groups').get() },
    { name: 'Platform team', description: 'Everyone on the platform.', owner_id: '1', is_public: 0 }, 'private unless the form says public');
  assert.deepEqual(raw.prepare('SELECT user_id FROM group_members').all().map((row) => ({ ...row })), [{ user_id: '1' }]);

  const own = await page(path, 'octo');
  assert.match(own, /<h1>Platform team<\/h1>\s*<p>Everyone on the platform\.<\/p>/);
  assert.match(own, /<span class="badge">Private<\/span><span>1 member · You own this group\.<\/span>/);
  assert.deepEqual(boardRows(own), [{ place: '—', login: 'octo', tokens: '0' }], 'a member with no usage is listed without a rank');
  assert.match(own, /<tr class="me">[\s\S]*?@octo<\/span><span class="badge">You<\/span><span class="badge">Owner<\/span>/);

  const list = await page('/groups', 'octo');
  assert.match(list, new RegExp(`<h2>My groups</h2>[\\s\\S]*<a href="${path}">Platform team</a><span class="badge">Private</span><span class="badge">Owner</span>`));
  assert.match(list, /<h2>Public groups<\/h2><\/div>\s*<p>No public groups yet\.<\/p>/);
  assert.equal(count('groups'), 1);
});

test('an address has the name in plain letters and a random part, and a name without letters has only the random part', () => {
  assert.match(groupSlug('Platform team'), /^platform-team-[0-9a-hjkmnp-tv-z]{6}$/);
  assert.match(groupSlug('  Café -- Zürich!  '), /^cafe-zurich-[0-9a-z]{6}$/);
  assert.match(groupSlug('x'.repeat(40)), /^x{40}-[0-9a-z]{6}$/);
  for (const name of ['한국어 팀', '東京', '🎉🎉', '2026', '---']) assert.match(groupSlug(name), /^[0-9a-z]{10}$/, name);
  assert.notEqual(groupSlug('Platform team'), groupSlug('Platform team'), 'no address can be had by choosing a name');
});

test('names and descriptions are cleaned and cut to their limits, and a group needs a name', async () => {
  const { post, page, start, count, raw } = await world();
  const named = () => raw.prepare('SELECT name, description FROM groups ORDER BY created_at, rowid').all().map((row) => ({ ...row })) as { name: string; description: string }[];

  const path = await start('octo', '  <script>alert(1)</script>‮ "Tom\'s" &\tco\u0007  ', 'public', 'First line\r\n<b>second</b> line third');
  assert.deepEqual(named()[0], { name: 'scriptalert(1)/script Toms co', description: 'First line bsecond/b line third' });
  for (const html of [await page(path, 'octo'), await page(path), await page('/groups')]) {
    assert.doesNotMatch(html, /<script|<b>|alert\(1\)<|‮/);
    assert.match(html, /scriptalert\(1\)\/script Toms co/);
  }

  await start('octo', 'n'.repeat(60), 'private', 'd'.repeat(300));
  assert.deepEqual(named()[1], { name: 'n'.repeat(GROUP_LIMITS.name), description: 'd'.repeat(GROUP_LIMITS.description) });

  const korean = await start('octo', '한국어 팀 🎉', 'public');
  assert.match(korean, /^\/groups\/[0-9a-z]{10}$/, 'a name with no ASCII letters gets a random address');
  assert.match(await page(korean), /<h1>한국어 팀 🎉<\/h1>/);
  await start('octo', '🎉'.repeat(50), 'private');
  assert.equal(named()[3].name, '🎉'.repeat(GROUP_LIMITS.name), 'the limit counts characters, and never cuts one in half');

  for (const name of ['', '   ', '<>&"\'', '\u0000‮']) {
    const refused = await post('/groups', 'octo', { name, visibility: 'public' });
    assert.equal(refused.status, 400, JSON.stringify(name));
    assert.match(await refused.text(), /<h1>A group needs a name\.<\/h1>/);
  }
  assert.equal((await post(`${path}/edit`, 'octo', { name: ' <> ', visibility: 'public' })).status, 400);
  assert.equal(count('groups'), 4);
  assert.equal(named()[0].name, 'scriptalert(1)/script Toms co', 'a refused edit changes nothing');
});

test('a name or description is escaped wherever a page shows it', async () => {
  const { page, start, raw, inviteOf, join } = await world();
  const path = await start('octo', 'Plain', 'private');
  await join(path, 'beta');
  // As if it had been stored before names were cleaned: the pages must hold up on their own.
  raw.prepare('UPDATE groups SET name = ?, description = ?').run('<img src=x onerror=alert(1)> & "q"', '</p><script>alert(2)</script>');
  const escaped = /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;q&quot;/;
  const views = [await page(path, 'octo'), await page(path, 'beta'), await page(`${path}?invite=${inviteOf(path)}`, 'mallory'), await page('/groups', 'octo')];
  raw.prepare('UPDATE groups SET is_public = 1').run();
  views.push(await page(path), await page(path, 'mallory'), await page('/groups'));
  for (const html of views) {
    assert.doesNotMatch(html, /<img src=x|<script>|onerror=alert\(1\)>/);
    assert.match(html, escaped);
  }
  assert.match(views[0], /<title>&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;q&quot; · Groups · oh-my-stats<\/title>/);
  assert.match(views[0], /name="name" value="&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;q&quot;"/);
  assert.match(views[0], /<textarea[^>]*>&lt;\/p&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;<\/textarea>/);
  assert.match(views[4], /<meta name="description" content="&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;q&quot;: a group on/);
});

test('a private group answers exactly like a missing one to everyone but its members', async () => {
  const { get, post, page, start, count, inviteOf, join, raw } = await world();
  const path = await start('octo', 'Secret project', 'private', 'Nobody may know.');
  await join(path, 'beta');
  const missing = '/groups/secret-project-zzzzzz';
  const state = () => JSON.stringify([raw.prepare('SELECT * FROM groups').all(), raw.prepare('SELECT * FROM group_members ORDER BY user_id').all()]);
  const before = state();

  for (const who of [null, 'mallory'] as const) {
    for (const query of ['', '?days=7', '?days=never', '?invite=', '?invite=wrong', `?invite=${inviteOf(path).slice(1)}`]) {
      const [hidden, absent] = [await told(await get(path + query, who)), await told(await get(missing + query, who))];
      assert.equal(hidden.status, 404, `${who} ${query}`);
      assert.match(hidden.body, HIDDEN);
      assert.deepEqual(hidden, absent, `${who ?? 'signed out'} can't tell ${query || 'the page'} from a missing group's`);
      assert.doesNotMatch(hidden.body, /Secret project|Nobody may know|@octo|@beta|og:image/);
    }
    const list = await page('/groups', who);
    assert.doesNotMatch(list, /Secret project|secret-project|Nobody may know/, 'the list of groups keeps it to its members');
  }

  const actions: [string, Record<string, string>][] = [
    ['join', {}], ['join', { invite: 'wrong' }], ['leave', {}], ['edit', { name: 'Taken over', visibility: 'public' }],
    ['invite', {}], ['delete', { confirm: 'Secret project' }], ['members/3/remove', {}], ['members/1/remove', {}],
  ];
  for (const [action, fields] of actions) {
    const [hidden, absent] = [await told(await post(`${path}/${action}`, 'mallory', fields)), await told(await post(`${missing}/${action}`, 'mallory', fields))];
    assert.equal(hidden.status, 404, action);
    assert.match(hidden.body, HIDDEN);
    assert.deepEqual(hidden, absent, `a stranger's ${action} is answered as for a missing group`);
  }
  assert.equal(state(), before, 'and none of it changed anything');
  assert.deepEqual(await told(await get(`${path}/join`, 'mallory')), await told(await get(`${missing}/join`, 'mallory')), 'nor does an address under it give it away');

  // Starting a group of the same name gets an address of its own, whether or not the name is taken.
  const second = await start('mallory', 'Secret project', 'public');
  assert.match(second, /^\/groups\/secret-project-[0-9a-z]{6}$/);
  assert.notEqual(second, path);
  assert.equal((await get('/groups/secret-project', 'mallory')).status, 404);

  for (const who of ['octo', 'beta'] as const) assert.match(await page(path, who), /<h1>Secret project<\/h1>/, `${who} is a member`);
  assert.match(await page('/groups', 'beta'), /<h2>My groups<\/h2>[\s\S]*Secret project<\/a><span class="badge">Private<\/span><p>Nobody may know\.<\/p>/);
  assert.equal(count('groups'), 2);
});

test('a group is handed only to those who may see it, and its invite code only to its owner', async () => {
  const { context, start, join, inviteOf, raw } = await world();
  const closed = (await start('octo', 'Closed', 'private')).slice('/groups/'.length);
  const open = (await start('octo', 'Open', 'public')).slice('/groups/'.length);
  await join(`/groups/${closed}`, 'beta');
  const code = inviteOf(`/groups/${closed}`);
  const seen = async (slug: string, viewerId: string | null, invite: string | null = null) => {
    const opened = await openGroup(context.deps.db, slug, viewerId, invite);
    assert.ok(!opened || !('invite_code' in opened.group), 'the group itself never carries the code');
    return opened && [opened.role, opened.inviteCode];
  };
  assert.deepEqual(await seen(closed, '1'), ['owner', code]);
  assert.deepEqual(await seen(closed, '3'), ['member', null]);
  assert.deepEqual(await seen(closed, '3', code), ['member', null]);
  assert.deepEqual(await seen(closed, '4', code), ['invited', null]);
  assert.deepEqual(await seen(closed, null, code), ['invited', null]);
  for (const viewerId of [null, '4', '999']) {
    for (const invite of [null, '', 'wrong', `${code}x`, code.slice(1)]) assert.equal(await seen(closed, viewerId, invite), null, `${viewerId} with ${invite}`);
  }
  assert.deepEqual(await seen(open, null), ['visitor', null]);
  assert.deepEqual(await seen(open, '4', 'anything'), ['visitor', null]);
  assert.deepEqual(await seen(open, '1'), ['owner', inviteOf(`/groups/${open}`)]);
  assert.equal(await seen('nothing-zzzzzz', '1', code), null);

  // Even a group whose code was somehow lost is not opened by sending no code.
  raw.prepare("UPDATE groups SET invite_code = ''").run();
  for (const invite of [null, '']) assert.equal(await seen(closed, '4', invite), null);
});

test('signing in from an invite link returns to it, and a sign-in link cannot send anyone elsewhere', async () => {
  const { context, start, inviteOf } = await world();
  const path = await start('octo', 'Friday pairing', 'private');
  const invite = `${path}?invite=${inviteOf(path)}`;
  /** Signs in through GitHub, having started at `/login` with this query, and says where it ends up. */
  const landing = async (query: string) => {
    const started = await context.call(`/login${query}`);
    const state = new URL(started.headers.get('location') as string).searchParams.get('state');
    const cookie = (started.headers.get('set-cookie') as string).split(';')[0];
    const done = await context.call(`/auth/callback?code=good-code&state=${state}`, { headers: { cookie } });
    assert.equal(done.status, 303, query);
    assert.ok(done.headers.getSetCookie().some((value) => value.startsWith('oms_session=')), 'signed in either way');
    return done.headers.get('location');
  };
  assert.equal(await landing(`?next=${encodeURIComponent(invite)}`), invite, 'back to the invitation');
  assert.equal(await landing(''), '/me');
  for (const next of ['https://evil.example/groups/x', '//evil.example/groups/x', '/\\evil.example/groups/x', '/me', '/login', '/groupsx', 'groups/x', `/groups/${'x'.repeat(300)}`, '%']) {
    assert.equal(await landing(`?next=${encodeURIComponent(next)}`), '/me', `${next} is not followed`);
  }

  // The cookie is in the visitor's hands, so a forged one is checked the same way.
  const started = await context.call('/login');
  const state = new URL(started.headers.get('location') as string).searchParams.get('state');
  for (const forged of ['https%3A%2F%2Fevil.example%2Fgroups%2Fx', '%2F%2Fevil.example', '%E0%A4%A']) {
    const done = await context.call(`/auth/callback?code=good-code&state=${state}`, { headers: { cookie: `oms_state=${state}.${forged}` } });
    assert.deepEqual([done.status, done.headers.get('location')], [303, '/me'], forged);
  }
});

test('an invite link shows a signed-in visitor the name and a join button, and sends a signed-out one to sign in', async () => {
  const { get, post, page, start, count, inviteOf, usage } = await world();
  await usage('octo', { '2026-11-08': 4321 }, false);
  const path = await start('octo', 'Friday pairing', 'private', 'Every Friday.');
  const code = inviteOf(path);
  assert.match(code, /^[0-9a-z]{24}$/);
  const missing = '/groups/friday-pairing-zzzzzz';

  const invitation = await get(`${path}?invite=${code}`, 'mallory');
  assert.equal(invitation.headers.get('cache-control'), 'no-store');
  const html = await invitation.text();
  assert.match(html, /<h1>Friday pairing<\/h1>\s*<p>Every Friday\.<\/p>/);
  assert.match(html, /<span class="badge">Private<\/span><span>1 member · You have an invite link\.<\/span>/);
  assert.ok(html.includes(`<p>${JOIN_NOTE}</p>`), 'the join form says what joining shows');
  assert.ok(html.includes(`<form method="post" action="${path}/join"><input type="hidden" name="invite" value="${code}"><button class="primary">Join group</button></form>`));
  assert.doesNotMatch(html, /@octo|4,321|4\.3k|<table|og:image/, 'who is in it and what they used stay inside');

  const signedOut = await get(`${path}?invite=${code}`);
  const back = `/login?next=${encodeURIComponent(`${path}?invite=${code}`)}`;
  assert.deepEqual([signedOut.status, signedOut.headers.get('location'), signedOut.headers.get('cache-control')], [303, back, 'no-store']);
  assert.equal(await signedOut.text(), '', 'signed out, not even the name is shown');
  for (const who of [null, 'mallory'] as const) {
    assert.deepEqual(await told(await get(`${path}?invite=${code}x`, who)), await told(await get(`${missing}?invite=${code}x`, who)), 'a wrong code opens nothing');
  }

  const guesses: Record<string, string>[] = [{}, { invite: '' }, { invite: `${code}x` }, { invite: code.toUpperCase() }];
  for (const fields of guesses) {
    const refused = await post(`${path}/join`, 'mallory', fields);
    assert.deepEqual(await told(refused), await told(await post(`${missing}/join`, 'mallory', fields)), 'joining takes the code itself');
  }
  for (const action of ['leave', 'edit', 'invite', 'delete']) {
    assert.match(await (await post(`${path}/${action}`, 'mallory', { invite: code, name: 'Mine now', confirm: 'Friday pairing' })).text(), HIDDEN, `the code is for joining, not for ${action}`);
  }
  assert.equal(count('group_members'), 1);

  const joined = await post(`${path}/join`, 'mallory', { invite: code });
  assert.deepEqual([joined.status, joined.headers.get('location')], [303, path]);
  assert.equal(count('group_members'), 2);
  assert.equal((await post(`${path}/join`, 'mallory', { invite: code })).status, 303, 'joining twice changes nothing');
  assert.equal(count('group_members'), 2);
  const inside = await page(path, 'mallory');
  assert.match(inside, /<span>2 members · You are a member\.<\/span>/);
  assert.deepEqual(boardRows(inside), [{ place: '1', login: 'octo', tokens: '4,321' }, { place: '—', login: 'mallory', tokens: '0' }],
    'joining is what shows a private profile’s totals');
  assert.doesNotMatch(inside, /\?invite=|href="\/u\/octo"/, 'the link is the owner’s to hand out, and a private profile gets no link');
  assert.match(await page(path, 'octo'), new RegExp(`<pre><code>${ORIGIN}${path}\\?invite=${code}</code></pre>`));
});

test('making a new invite code stops the old link, and only the owner can make one', async () => {
  const { get, post, start, count, inviteOf, join } = await world();
  const path = await start('octo', 'Friday pairing', 'private');
  const old = inviteOf(path);
  await join(path, 'beta');

  const byMember = await post(`${path}/invite`, 'beta');
  assert.equal(byMember.status, 403);
  assert.match(await byMember.text(), /<h1>Only this group’s owner can do that\.<\/h1>/);
  assert.equal(inviteOf(path), old);

  assert.deepEqual([(await post(`${path}/invite`, 'octo')).status, inviteOf(path) === old], [303, false]);
  const missing = '/groups/friday-pairing-zzzzzz';
  assert.deepEqual(await told(await get(`${path}?invite=${old}`, 'mallory')), await told(await get(`${missing}?invite=${old}`, 'mallory')), 'the old link answers like a missing group');
  assert.equal((await get(`${path}?invite=${old}`)).status, 404);
  assert.equal((await post(`${path}/join`, 'mallory', { invite: old })).status, 404);
  assert.equal(count('group_members'), 2, 'members stay, and nobody new got in');
  assert.equal((await get(`${path}?invite=${inviteOf(path)}`, 'mallory')).status, 200);
  assert.equal((await post(`${path}/join`, 'mallory', { invite: inviteOf(path) })).status, 303);
  assert.equal(count('group_members'), 3);
});

test('a public group shows visitors only the members with public profiles, and members see everyone', async () => {
  const { context, get, post, page, start, join, usage } = await world();
  await usage('octo', { '2026-11-08': 5000 }, true);
  const alpha = await usage('alpha', { '2026-11-08': 300 }, true);
  await usage('beta', { '2026-11-08': 70_000 }, false);
  const path = await start('octo', 'Open team', 'public', 'Anyone may look.');
  assert.equal((await post(`${path}/join`, 'alpha')).status, 303, 'a public group needs no invite');
  await join(path, 'beta');

  for (const who of [null, 'mallory'] as const) {
    const response = await get(path, who);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.deepEqual(boardRows(html), [{ place: '1', login: 'octo', tokens: '5,000' }, { place: '2', login: 'alpha', tokens: '300' }]);
    assert.doesNotMatch(html, /beta|70,000|75,300|75\.3k/i, 'nothing about the member with a private profile, not even in the total');
    assert.match(html, /<span class="tile-label">Members<\/span><strong>3<\/strong><span>2 shown · 1 not shown<\/span>/);
    assert.match(html, /<span class="tile-label">Lifetime tokens<\/span><strong>5\.3k<\/strong><span>5,300<\/span><span>By the 2 shown<\/span>/);
    assert.match(html, /1 member has a private profile and is not shown\. Members of the group see everyone\./);
    assert.match(html, /<a href="\/u\/octo"><img[^>]*>@octo<\/a><span class="badge">Owner<\/span>/);
    assert.match(html, /<a href="\/u\/alpha"><img/);
    assert.doesNotMatch(html, /class="me"|Your place|\?invite=|id="manage"|Leave this group/);
    assert.doesNotMatch(html, new RegExp(`${SECRET_NAME}|${MACHINE_A}`), 'machine names and ids stay private');
  }

  for (const who of ['octo', 'alpha', 'beta'] as const) {
    const html = await page(path, who);
    assert.deepEqual(boardRows(html), [{ place: '1', login: 'beta', tokens: '70,000' }, { place: '2', login: 'octo', tokens: '5,000' }, { place: '3', login: 'alpha', tokens: '300' }]);
    assert.match(html, /<span class="group-member"><img[^>]*>@beta<\/span>/, 'a private profile is named without a link');
    assert.doesNotMatch(html, /href="\/u\/beta"/);
    assert.match(html, /<span class="tile-label">Lifetime tokens<\/span><strong>75\.3k<\/strong><span>75,300<\/span><\/div>/);
    assert.equal(html.match(/<tr class="me">/g)?.length, 1);
    assert.match(html, new RegExp(`<tr class="me">[\\s\\S]*?@${who}</(a|span)><span class="badge">You</span>`), 'the viewer’s own row is marked');
    assert.match(html, /Anyone can open this page\. People outside the group see only the members whose profiles are public\./);
    assert.doesNotMatch(html, /not shown/);
    assert.doesNotMatch(html, new RegExp(`${SECRET_NAME}|${MACHINE_A}`), 'machine names and ids stay private');
  }
  assert.match(await page(path, 'beta'), /<span class="tile-label">Your place<\/span><strong>#1<\/strong><span>of 3 ranked members<\/span>/);
  assert.match(await page(`${path}?days=last-month`, 'alpha'), /<strong>—<\/strong><span>No usage in this period<\/span>/);

  await context.call('/v1/me', api(alpha, 'PATCH', { public: false }));
  const after = await page(path);
  assert.deepEqual(boardRows(after), [{ place: '1', login: 'octo', tokens: '5,000' }], 'a profile made private leaves the visitors’ board at once');
  assert.doesNotMatch(after, /alpha|beta/i);
  assert.match(after, /2 members have private profiles and are not shown\./);
  assert.equal(boardRows(await page(path, 'octo')).length, 3, 'and stays on the members’');
});

test('a group board gives each member the score the public rankings give them, in every period', async () => {
  const { context, page, start, join, usage } = await world();
  const db = context.deps.db;
  await usage('octo', { '2026-09-01': 900_000, '2026-10-15': 40_000, '2026-11-02': 3_000, '2026-11-08': 200 }, true);
  await usage('alpha', { '2026-10-20': 7_000_000, '2026-11-04': 50 }, true);
  await usage('beta', { '2026-11-09': 123_456_789 }, true);
  await usage('mallory', { '2026-10-15': 5_000_000, '2026-11-08': 999 }, true);
  const path = await start('octo', 'Everyone but one', 'public');
  for (const who of ['alpha', 'beta'] as const) await join(path, who);
  const { id } = (db as ReturnType<typeof testDb>).raw.prepare('SELECT id FROM groups').get() as { id: string };

  for (const days of ['all', '7', '30', 'month', 'last-month']) {
    const period = rankingPeriod(days, context.deps.now(), true);
    const everyone = await rankBoard(db, period, { kind: 'public' });
    const scores = new Map(everyone.users.map((row) => [row.label, row.tokens]));
    const members = everyone.users.filter((row) => row.label !== 'mallory');
    assert.ok(everyone.users.some((row) => row.label === 'mallory'), `${days}: the public board has someone the group doesn't`);

    const board = await rankBoard(db, period, { kind: 'group', id, publicOnly: false });
    assert.deepEqual(board.users.map((row) => [row.label, row.tokens]), members.map((row) => [row.label, row.tokens]), days);
    assert.equal(board.tokens, members.reduce((sum, row) => sum + row.tokens, 0), `${days}: the total is the members' alone`);

    for (const who of [null, 'mallory', 'beta'] as const) {
      const html = await page(`${path}?days=${days}`, who);
      const ranked = boardRows(html).filter((row) => row.place !== '—');
      assert.deepEqual(ranked.map((row) => [row.login, row.tokens]), members.map((row) => [row.label, commas(scores.get(row.label) as number)]), `${days} for ${who}`);
      assert.deepEqual(ranked.map((row) => row.place), members.map((_, index) => String(index + 1)), 'places are counted within the group');
      assert.ok(html.includes(`<strong>${compact(board.tokens)}</strong><span>${commas(board.tokens)}</span>`), `${days}: the members' total`);
      assert.equal(boardRows(html).length, 3, 'every member is listed, ranked or not');
    }
  }
  assert.match(await page(`${path}?days=7`), /aria-current="page">Last 7 days<\/a>[\s\S]*2026-11-03 through 2026-11-09[\s\S]*Tokens \(7 days\)/);
  assert.match(await page(`${path}?days=last-month`), /aria-current="page">Last month<\/a>[\s\S]*2026-10-01 through 2026-10-31[\s\S]*Tokens \(last month\)/);
  assert.equal((await context.call(`${path}?days=week`)).status, 400);
});

test('every way into a group says what joining shows', async () => {
  const { page, start, inviteOf } = await world();
  const open = await start('octo', 'Open team', 'public');
  const closed = await start('octo', 'Closed team', 'private');

  const visitor = await page(open, 'mallory');
  assert.ok(visitor.includes(`<p>${JOIN_NOTE}</p>`));
  assert.match(visitor, /This group is public: any signed-in account can join it\. People outside the group see you on its board only while your profile is public\./);
  assert.ok(visitor.includes(`<form method="post" action="${open}/join"><button class="primary">Join group</button></form>`));

  const signedOut = await page(open);
  assert.ok(signedOut.includes(`<p>Sign in to join. ${JOIN_NOTE}</p>`));
  assert.match(signedOut, /<a class="button primary" href="\/login">/);
  assert.doesNotMatch(signedOut, /<form/, 'signed out, there is nothing to post');

  const invited = await page(`${closed}?invite=${inviteOf(closed)}`, 'mallory');
  assert.ok(invited.includes(`<p>${JOIN_NOTE}</p>`));
  assert.match(invited, /This group is private: only its members can open it, and they join with its invite link\./);

  assert.ok((await page('/groups', 'mallory')).includes(`<p>You become its owner and its first member. ${JOIN_NOTE}</p>`), 'starting one is joining it');
  assert.match(await page(open, 'octo'), /Your place/);
  assert.match(await page('/groups'), /<a class="button" href="\/login">.*Sign in to start a group<\/a>/);
});

test('an account owns at most five groups and joins at most twenty, and a group holds at most two hundred members', async () => {
  const { post, page, start, count, raw } = await world();
  for (let index = 1; index <= GROUP_LIMITS.owned; index++) await start('octo', `Group ${index}`, 'public');
  const sixth = await post('/groups', 'octo', { name: 'One too many', visibility: 'public' });
  assert.equal(sixth.status, 400);
  assert.match(await sixth.text(), /<h1>You already own 5 groups\.<\/h1>\s*<p>That is the most an account can own\. Delete one to start another\.<\/p>/);
  assert.equal(count('groups'), GROUP_LIMITS.owned);
  const own = await page('/groups', 'octo');
  assert.match(own, /You own 5 groups, the most an account can\. Delete one to start another\./);
  assert.doesNotMatch(own, /action="\/groups"/, 'at the limit, the form is not offered');

  // Twenty groups that mallory is in, written straight into the tables to keep the test short.
  raw.exec(`
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<${GROUP_LIMITS.joined})
    INSERT INTO groups (id, slug, name, owner_id, is_public, invite_code, created_at, updated_at)
    SELECT 'filled-' || i, 'filled-' || i, 'Filled ' || i, '2', 1, 'code-' || i, '2026-11-01', '2026-11-01' FROM n;
    INSERT INTO group_members SELECT id, '2', '2026-11-01' FROM groups WHERE id LIKE 'filled-%';
    INSERT INTO group_members SELECT id, '4', '2026-11-01' FROM groups WHERE id LIKE 'filled-%';
  `);
  const [open] = (raw.prepare("SELECT slug FROM groups WHERE name = 'Group 1'").all() as { slug: string }[]).map((row) => `/groups/${row.slug}`);
  for (const attempt of [await post(`${open}/join`, 'mallory'), await post('/groups', 'mallory', { name: 'Twenty-first', visibility: 'private' })]) {
    assert.equal(attempt.status, 400);
    assert.match(await attempt.text(), /<h1>You are already in 20 groups\.<\/h1>\s*<p>That is the most an account can join\. Leave one to join another\.<\/p>/);
  }
  assert.equal(count('group_members WHERE user_id = ?', '4'), GROUP_LIMITS.joined);
  assert.match(await page('/groups', 'mallory'), /You are in 20 groups, the most an account can join\./);
  assert.equal((await post('/groups/filled-1/leave', 'mallory')).status, 303);
  assert.equal((await post(`${open}/join`, 'mallory')).status, 303, 'leaving one makes room');

  raw.exec(`
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<${GROUP_LIMITS.members - 2})
    INSERT INTO users (id, login, created_at, updated_at) SELECT 1000 + i, 'crowd-' || i, '2026-11-01', '2026-11-01' FROM n;
    INSERT INTO group_members SELECT (SELECT id FROM groups WHERE name = 'Group 1'), id, '2026-11-01' FROM users WHERE login LIKE 'crowd-%';
  `);
  assert.equal(count("group_members WHERE group_id = (SELECT id FROM groups WHERE name = 'Group 1')"), GROUP_LIMITS.members);
  const full = await post(`${open}/join`, 'beta');
  assert.equal(full.status, 400);
  assert.match(await full.text(), /<h1>This group is full\.<\/h1>\s*<p>A group holds at most 200 members\.<\/p>/);
  assert.equal(count('group_members WHERE user_id = ?', '3'), 0);
  assert.equal(boardRows(await page(open, 'octo')).length, GROUP_LIMITS.members, 'every member is listed, with or without usage');
  raw.exec(`
    INSERT INTO machines (user_id, id, name, created_at, last_seen_at) SELECT id, 'a', 'Primary', '2026-11-01', '2026-11-01' FROM users WHERE login LIKE 'crowd-%';
    INSERT INTO usage_daily SELECT id, 'a', '2026-11-08', 'codex', 'm', 5000 - id, 0, 0, 0, 1 FROM users WHERE login LIKE 'crowd-%';
  `);
  const crowded = boardRows(await page(open, 'octo'));
  assert.deepEqual(crowded.filter((row) => row.place !== '—').map((row) => Number(row.place)), Array.from({ length: GROUP_LIMITS.members - 2 }, (_, index) => index + 1),
    'a board longer than one read of the rankings is still shown whole');
  assert.deepEqual(crowded.slice(-2).map((row) => [row.place, row.login]), [['—', 'mallory'], ['—', 'octo']]);
  assert.equal((await post(`${open}/leave`, 'mallory')).status, 303);
  assert.equal((await post(`${open}/join`, 'beta')).status, 303, 'a place opens when someone leaves');
});

test('starting and joining count against the strict limit, and opening a group against the public one', async () => {
  const blocked = new Set<string>();
  const calls: string[] = [];
  const { get, post, start, count } = await world({ allow: async (kind, key) => (calls.push(`${kind} ${key}`), !blocked.has(kind)) });
  const open = await start('octo', 'Open team', 'public');
  const closed = await start('octo', 'Closed team', 'private');
  assert.ok(calls.includes('strict groups:1'), 'counted by account');

  blocked.add('strict');
  for (const attempt of [await post('/groups', 'mallory', { name: 'More' }), await post(`${open}/join`, 'mallory'), await post(`${closed}/join`, 'mallory', { invite: 'guess' })]) {
    assert.deepEqual([attempt.status, attempt.headers.get('retry-after'), attempt.headers.get('cache-control')], [429, '60', 'no-store']);
  }
  assert.ok(calls.includes('strict groups:4'));
  assert.deepEqual([count('groups'), count('group_members')], [2, 2]);
  assert.equal((await post(`${open}/edit`, 'octo', { name: 'Open team', visibility: 'public' })).status, 303, 'an owner at work is not held to it');
  assert.equal((await get(open)).status, 200);

  blocked.add('public');
  for (const path of ['/groups', open, closed, '/groups/nothing-here-zzzzzz']) assert.equal((await get(path, 'mallory')).status, 429, path);
  assert.ok(calls.includes('public groups:unknown'), 'counted by address, before the group is looked for');
});

test('only the owner can change a group, remove a member or delete it, and deleting takes typing its name', async () => {
  const { get, post, page, start, count, join, raw } = await world();
  const path = await start('octo', 'Open team', 'public', 'As it was.');
  for (const who of ['alpha', 'beta'] as const) await join(path, who);
  const state = () => JSON.stringify([raw.prepare('SELECT * FROM groups').all(), raw.prepare('SELECT * FROM group_members ORDER BY user_id').all()]);
  const before = state();

  const actions: [string, Record<string, string>][] = [
    ['edit', { name: 'Taken over', visibility: 'private' }], ['invite', {}], ['members/2/remove', {}], ['members/1/remove', {}], ['delete', { confirm: 'Open team' }],
  ];
  for (const who of ['beta', 'mallory'] as const) {
    for (const [action, fields] of actions) {
      const refused = await post(`${path}/${action}`, who, fields);
      assert.equal(refused.status, 403, `${who} ${action}`);
      assert.match(await refused.text(), /<h1>Only this group’s owner can do that\.<\/h1>/);
    }
    assert.doesNotMatch(await page(path, who), /id="manage"|\/edit"|\/delete"|\/remove"|\/invite"/, `${who} is shown no controls`);
  }
  assert.equal(state(), before);

  const own = await page(path, 'octo');
  for (const action of ['edit', 'delete', 'members/2/remove', 'members/3/remove']) assert.ok(own.includes(`action="${path}/${action}"`), action);
  assert.doesNotMatch(own, /members\/1\/remove|\/leave"/, 'the owner can’t be removed, and is not offered a way to leave');
  assert.match(own, /You own this group, so you can’t leave it while it has other members\./);
  assert.ok(own.includes(`<pre><code>${ORIGIN}${path}</code></pre>`), 'a public group is joined from its own address');

  assert.equal((await post(`${path}/edit`, 'octo', { name: ' Renamed  team ', description: 'As it is now.', visibility: 'public' })).status, 303);
  assert.match(await page(path), /<h1>Renamed team<\/h1>\s*<p>As it is now\.<\/p>/, 'the address stays when the name changes');

  assert.equal((await post(`${path}/members/1/remove`, 'octo')).status, 303);
  assert.equal(count('group_members'), 3, 'the owner stays');
  assert.equal((await post(`${path}/members/2/remove`, 'octo')).status, 303);
  assert.deepEqual(raw.prepare('SELECT user_id FROM group_members ORDER BY user_id').all().map((row) => ({ ...row }).user_id), ['1', '3']);
  assert.match(await page(path, 'alpha'), /<a class="button" href="#join">Join group<\/a>/, 'whoever was removed is a visitor again');

  for (const confirm of ['', 'Open team', 'Renamed', 'octo']) {
    const refused = await post(`${path}/delete`, 'octo', { confirm });
    assert.equal(refused.status, 400, confirm);
    assert.match(await refused.text(), /<h1>Nothing was deleted\. Type the group’s name to confirm\.<\/h1>/);
  }
  assert.equal(count('groups'), 1);
  // Without the database's own cascade, so it is the server that clears the memberships.
  raw.exec('PRAGMA foreign_keys = OFF');
  const deleted = await post(`${path}/delete`, 'octo', { confirm: '  renamed TEAM ' });
  assert.deepEqual([deleted.status, deleted.headers.get('location')], [303, '/groups']);
  assert.deepEqual([count('groups'), count('group_members')], [0, 0]);
  for (const who of [null, 'octo', 'beta'] as const) assert.match(await (await get(path, who)).text(), HIDDEN);
});

test('a member can leave at once, and the owner only when nobody else remains', async () => {
  const { get, post, page, start, count, join } = await world();
  const path = await start('octo', 'Friday pairing', 'private');
  for (const who of ['alpha', 'beta'] as const) await join(path, who);

  assert.match(await page(path, 'beta'), new RegExp(`action="${path}/leave"><span class="muted">Your totals stop showing here at once\\. To come back, you need an invite link\\.</span>`));
  const left = await post(`${path}/leave`, 'beta');
  assert.deepEqual([left.status, left.headers.get('location')], [303, '/groups']);
  assert.equal(count('group_members'), 2);
  assert.deepEqual(await told(await get(path, 'beta')), await told(await get('/groups/friday-pairing-zzzzzz', 'beta')), 'having left, the group is hidden again');
  assert.equal((await post(`${path}/leave`, 'beta')).status, 404);

  const stays = await post(`${path}/leave`, 'octo');
  assert.equal(stays.status, 400);
  assert.match(await stays.text(), /<h1>The owner can’t leave while others remain\.<\/h1>\s*<p>Remove the other members first, or delete the group\.<\/p>/);
  assert.equal(count('group_members'), 2);

  assert.equal((await post(`${path}/members/2/remove`, 'octo')).status, 303);
  assert.doesNotMatch(await page(path, 'octo'), /can’t leave it while/);
  assert.equal((await post(`${path}/leave`, 'octo')).status, 303);
  assert.deepEqual([count('groups'), count('group_members')], [0, 0], 'the last one out leaves no empty group behind');
});

test('a private group can’t be made public while another member has a private profile', async () => {
  const { post, page, start, join, usage, raw } = await world();
  await usage('beta', { '2026-11-08': 70_000 }, false);
  const path = await start('octo', 'Friday pairing', 'private', 'As it was.');
  await join(path, 'alpha');
  await join(path, 'beta');
  const group = () => ({ ...raw.prepare('SELECT name, description, is_public FROM groups').get() });

  const refused = await post(`${path}/edit`, 'octo', { name: 'Now open', description: 'Changed.', visibility: 'public' });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /<h1>Nothing was changed\. This group can’t be made public yet\.<\/h1>\s*<p>Some members have private profiles, and joined a group that only invited people could see\./);
  assert.deepEqual(group(), { name: 'Friday pairing', description: 'As it was.', is_public: 0 }, 'nobody who joined privately is shown to whoever joins next');
  assert.equal((await post(`${path}/edit`, 'octo', { name: 'Renamed', description: '', visibility: 'private' })).status, 303, 'other changes still save');

  // The owner decides for themselves, so their own private profile is no obstacle. Alpha's is.
  raw.prepare("UPDATE users SET is_public = 1 WHERE login = 'beta'").run();
  assert.equal((await post(`${path}/edit`, 'octo', { name: 'Renamed', visibility: 'public' })).status, 400, 'alpha never published');
  raw.prepare("UPDATE users SET is_public = 1 WHERE login = 'alpha'").run();
  assert.equal((await post(`${path}/edit`, 'octo', { name: 'Renamed', visibility: 'public' })).status, 303);
  assert.equal(group().is_public, 1);
  assert.match(await page(path), /<h1>Renamed<\/h1>/);

  assert.equal((await post(`${path}/edit`, 'octo', { name: 'Renamed', visibility: 'private' })).status, 303);
  assert.equal((await post(`${path}/edit`, 'mallory', { name: 'Renamed', visibility: 'public' })).status, 404, 'made private, it is hidden at once');
});

test('deleting an account removes its memberships and the groups it owns', async () => {
  const { get, post, page, start, count, join, raw } = await world();
  const owned = await start('octo', 'Owned by octo', 'private');
  const joined = await start('alpha', 'Owned by alpha', 'private');
  await join(owned, 'alpha');
  await join(owned, 'beta');
  await join(joined, 'octo');
  assert.deepEqual([count('groups'), count('group_members')], [2, 5]);

  // Without the database's own cascade, so it is the server that clears each table.
  raw.exec('PRAGMA foreign_keys = OFF');
  assert.equal((await post('/me/delete', 'octo', { confirm: 'octo' })).status, 303);
  assert.deepEqual(raw.prepare('SELECT name FROM groups').all().map((row) => ({ ...row }).name), ['Owned by alpha']);
  assert.deepEqual(raw.prepare('SELECT user_id FROM group_members').all().map((row) => ({ ...row }).user_id), ['2'], 'only alpha, in alpha’s own group');
  assert.match(await (await get(owned, 'alpha')).text(), HIDDEN);
  assert.deepEqual(boardRows(await page(joined, 'alpha')).map((row) => row.login), ['alpha']);
  assert.doesNotMatch(await page('/groups', 'beta'), /Owned by/);
});

test('group forms posted from another site are refused, and signed-out ones are sent to sign in', async () => {
  const { context, sessions, start, join, raw } = await world();
  const path = await start('octo', 'Open team', 'public');
  await join(path, 'alpha');
  const state = () => JSON.stringify([raw.prepare('SELECT * FROM groups').all(), raw.prepare('SELECT * FROM group_members ORDER BY user_id').all()]);
  const before = state();
  const forms: [string, string, Person][] = [
    ['/groups', 'name=Forged&visibility=public', 'octo'], [`${path}/join`, '', 'beta'], [`${path}/leave`, '', 'alpha'],
    [`${path}/edit`, 'name=Forged&visibility=private', 'octo'], [`${path}/invite`, '', 'octo'],
    [`${path}/members/2/remove`, '', 'octo'], [`${path}/delete`, 'confirm=Open+team', 'octo'],
  ];
  for (const [action, body, who] of forms) {
    const forged = await context.call(action, webPost(sessions[who], body, 'https://evil.example'));
    assert.equal(forged.status, 403, action);
    assert.match(await forged.text(), /That request came from another site\./);
    const noOrigin = await context.call(action, { method: 'POST', headers: { cookie: sessions[who] }, body });
    assert.equal(noOrigin.status, 403, action);
    const signedOut = await context.call(action, webPost('', body));
    assert.deepEqual([signedOut.status, signedOut.headers.get('location')], [303, '/login'], action);
    const agentOnly = await context.call(action, webPost('oms_session=omsa_not-a-web-session', body));
    assert.equal(agentOnly.headers.get('location'), '/login', action);
  }
  assert.equal(state(), before, 'nothing changed');
  assert.equal((await context.call(`${path}/sideways`, webPost(sessions.octo))).status, 404);
});

test('group pages are never kept by a cache, load only what the policy allows, and only public ones are offered for sharing', async () => {
  const { get, post, start, inviteOf, join, usage } = await world();
  await usage('octo', { '2026-11-08': 5000 }, true);
  const open = await start('octo', 'Open team', 'public');
  const closed = await start('octo', 'Closed team', 'private');
  await join(closed, 'beta');

  const shared: [string, Person | null][] = [['/groups', null], ['/groups', 'octo'], [open, null], [open, 'mallory'], [open, 'octo'], [`${open}?days=30`, null]];
  const kept: [string, Person | null][] = [[closed, 'octo'], [closed, 'beta'], [`${closed}?invite=${inviteOf(closed)}`, 'mallory'], [closed, 'mallory'], [closed, null], ['/groups/nothing-zzzzzz', null]];
  for (const [path, who] of [...shared, ...kept]) {
    const response = await get(path, who);
    const text = await response.text();
    const label = `${path} for ${who}`;
    assert.equal(response.headers.get('cache-control'), 'no-store', label);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/, label);
    assert.doesNotMatch(text, /<script|<link rel="stylesheet"|@import|url\((?!#)|<iframe|\son[a-z]+=/i, label);
    for (const [, source] of text.matchAll(/<img src="([^"]+)"/g)) assert.match(source, /^(\/(?!\/)|https:\/\/avatars\.githubusercontent\.com\/)/, `${label} loads ${source}`);
    for (const [, action] of text.matchAll(/<form[^>]* action="([^"]+)"/g)) assert.match(action, /^\/(groups|logout)/, `${label} posts to ${action}`);
    assert.match(text, /<a class="skip" href="#main">Skip to content<\/a>[\s\S]*<main id="main"/, label);
    assert.equal(text.match(/<h1[ >]/g)?.length, 1, `${label} has one main heading`);
    assert.equal(/og:image/.test(text), shared.some(([sharedPath, sharedWho]) => sharedPath === path && sharedWho === who), `${label}: a preview only for what anyone may open`);
  }
  const refusal = await post(`${closed}/leave`, 'octo');
  assert.equal(refusal.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await refusal.text(), /og:image/);
  assert.match(await (await get(open)).text(), /<meta property="og:image" content="https:\/\/stats\.example\/og\.png">/);
  assert.equal((await get(open, null)).headers.get('referrer-policy'), 'same-origin', 'an invite link is not passed on to other sites');
});

test('the groups page lists public groups, largest first, and shows a signed-in visitor their own', async () => {
  const { page, start, join, raw } = await world();
  const small = await start('octo', 'Small', 'public', 'Just one.');
  const large = await start('alpha', 'Large', 'public');
  const closed = await start('alpha', 'Closed', 'private', 'Not listed.');
  await join(large, 'beta');
  await join(large, 'octo');
  await join(closed, 'beta');
  const alsoSmall = await start('beta', 'Also small', 'public');

  const signedOut = await page('/groups');
  const listed = [...signedOut.matchAll(/<li><div><a href="(\/groups\/[^"]+)">([^<]+)<\/a>(?:<p>([^<]*)<\/p>)?<\/div><span class="group-count">([^<]+)<\/span><\/li>/g)]
    .map(([, href, name, description, members]) => [href, name, description, members]);
  assert.deepEqual(listed, [[large, 'Large', undefined, '3 members'], [alsoSmall, 'Also small', undefined, '1 member'], [small, 'Small', 'Just one.', '1 member']],
    'by members, then by name');
  assert.match(signedOut, /<p class="muted">3 groups, most members first<\/p>/);
  assert.doesNotMatch(signedOut, /My groups|Closed|Not listed|action="\/groups"/);

  const own = await page('/groups', 'beta');
  const mine = /<h2>My groups<\/h2>[\s\S]*?<\/ul>/.exec(own)?.[0] ?? '';
  assert.match(mine, /3 of 20 · Only you can see this list\./);
  assert.deepEqual([...mine.matchAll(/<a href="[^"]+">([^<]+)<\/a>((?:<span class="badge[^"]*">[^<]+<\/span>)*)/g)].map(([, name, badges]) => [name, badges.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()]),
    [['Also small', 'Public Owner'], ['Closed', 'Private'], ['Large', 'Public']]);
  assert.match(own, /<details class="group-start"><summary class="button">Start a group<\/summary>\s*<form method="post" action="\/groups">/);
  assert.doesNotMatch(await page('/groups', 'mallory'), /Closed|Not listed/);
  assert.match(await page('/groups', 'mallory'), /You are not in a group yet\./);

  raw.exec(`
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<${PUBLIC_GROUPS_SHOWN})
    INSERT INTO groups (id, slug, name, owner_id, is_public, invite_code, created_at, updated_at)
    SELECT 'many-' || i, 'many-' || i, 'Many ' || i, '4', 1, 'code-' || i, '2026-11-01', '2026-11-01' FROM n;
    INSERT INTO group_members SELECT id, '4', '2026-11-01' FROM groups WHERE id LIKE 'many-%';
  `);
  const crowded = await page('/groups');
  assert.equal(crowded.match(/<li>/g)?.length, PUBLIC_GROUPS_SHOWN, 'at most a hundred');
  assert.match(crowded, /<p class="muted">The 100 largest<\/p>/);
  assert.ok(crowded.includes(`<a href="${large}">Large</a>`), 'the largest are the ones kept');
});
