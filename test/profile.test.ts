import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GitHubProfile, Metrics } from '../src/shared/metrics.ts';
import { cleanGitHubProfile, cleanLine, manualProfileFromForm, manualProfileFromJson, manualProfileJson, profileOf, type ManualProfile } from '../src/shared/profile.ts';
import { renderComponent, renderDashboard } from '../src/shared/render/svg.ts';
import { githubMetrics } from './fixtures.ts';

const EMPTY: ManualProfile = { name: null, title: null, company: null, location: null, bio: null, status: null };
const GITHUB: GitHubProfile = { name: 'Octo Cat', bio: 'Builds things', company: '@corp', location: 'Seoul', hireable: false, status: null };
const octo = { login: 'octo', name: 'Signed-in Name' };

const metrics = (manual: Partial<ManualProfile> = {}, github: GitHubProfile | undefined = GITHUB): Metrics => ({
  generatedDate: '2026-11-09',
  timezone: 'Asia/Seoul',
  profile: profileOf(octo, { ...EMPTY, ...manual }, github),
  github: githubMetrics(),
  tokens: null,
});

test('a line of profile text is cleaned, and clipped by character', () => {
  assert.equal(cleanLine('  a\n\tb  ', 10), 'a b');
  assert.equal(cleanLine('‮evil​﻿', 10), 'evil', 'characters that reorder or hide text are removed');
  assert.equal(cleanLine('\u{1F468}‍\u{1F469}', 10), '\u{1F468}‍\u{1F469}', 'joined emoji keep their joiner');
  assert.equal(cleanLine('가나다라', 2), '가나');
  assert.equal(cleanLine('   ', 10), null);
  assert.equal(cleanLine(5, 10), null);
});

test('what the owner wrote comes first, and GitHub fills the rest', () => {
  const profile = profileOf(octo, { ...EMPTY, title: 'Staff engineer', company: 'Acme' }, GITHUB);
  assert.equal(profile.name, 'Octo Cat');
  assert.equal(profile.title, 'Staff engineer');
  assert.equal(profile.company, 'Acme');
  assert.equal(profile.location, 'Seoul');
  assert.equal(profile.bio, 'Builds things');
  assert.equal(profileOf(octo, EMPTY, undefined).name, 'Signed-in Name', 'an agent that sends no profile leaves the name from sign-in');
  assert.equal(profileOf(octo, EMPTY, GITHUB).title, null, 'GitHub has no job title');
});

test('a status is chosen, hidden, or taken from GitHub', () => {
  const status = (choice: ManualProfile['status'], github: Partial<GitHubProfile>) => profileOf(octo, { ...EMPTY, status: choice }, { ...GITHUB, ...github }).status;
  assert.deepEqual(status('open-to-work', {}), { label: 'Open to work', emoji: null, tone: 'open' });
  assert.equal(status('none', { hireable: true }), null);
  assert.deepEqual(status(null, { status: { emoji: '🎯', message: 'Focusing', busy: true } }), { label: 'Focusing', emoji: '🎯', tone: 'busy' });
  assert.deepEqual(status(null, { hireable: true }), { label: 'Available for hire', emoji: null, tone: 'open' });
  assert.equal(status(null, {}), null);
});

test('stored and posted profiles are read loosely, and an empty one is not stored', () => {
  assert.deepEqual(manualProfileFromJson('not json'), EMPTY);
  assert.deepEqual(manualProfileFromJson('{"title":" x ","status":"bogus","admin":true}'), { ...EMPTY, title: 'x' });
  const posted = manualProfileFromForm(new URLSearchParams({ title: 'a'.repeat(100), status: 'hiring', bio: '' }));
  assert.equal(posted.title, 'a'.repeat(60));
  assert.equal(posted.status, 'hiring');
  assert.equal(posted.bio, null);
  assert.equal(manualProfileJson(EMPTY), null);
  assert.deepEqual(JSON.parse(manualProfileJson(posted) as string), { title: 'a'.repeat(60), status: 'hiring' });
});

test('an uploaded GitHub profile is cleaned, and junk is dropped', () => {
  assert.equal(cleanGitHubProfile('nope'), undefined);
  const profile = cleanGitHubProfile({ name: 'a‮b', bio: 7, hireable: 'yes', status: { emoji: '', message: '', busy: false } });
  assert.deepEqual(profile, { name: 'ab', bio: null, company: null, location: null, hireable: false, status: null });
});

test('the profile part shows who this is, their status and career figures', () => {
  const svg = renderComponent(metrics({ title: 'Staff engineer', company: 'Acme', status: 'hiring' }), 'profile');
  assert.ok(svg.includes('>Octo Cat<tspan class="handle" dx="10">@octo</tspan>'));
  assert.ok(svg.includes('>Staff engineer at Acme · Seoul</text>'));
  assert.ok(svg.includes('>Builds things</text>'));
  assert.ok(svg.includes('>Hiring</text>'));
  assert.ok(svg.includes('>Contributing since</text>') && svg.includes('>2026</text>'));
  assert.ok(svg.includes('>4,671</text>'), 'lifetime contributions');
  assert.ok(svg.includes('Octo Cat (@octo). Staff engineer at Acme. Seoul. Hiring. Builds things.'), 'described for screen readers');
  assert.ok(svg.includes('class="initial"'), 'an initial stands in for a missing avatar');
  assert.ok(!/NaN|undefined|Infinity|null/.test(svg));
});

test('long profile text is shortened to fit, and markup is escaped', () => {
  const long = '긴 소개 '.repeat(60);
  const svg = renderComponent(metrics({ bio: long, title: '<b>x</b>' }), 'profile');
  const bio = /class="bio">([^<]*)</.exec(svg)?.[1] ?? '';
  assert.ok(bio.endsWith('…') && bio.length < long.length);
  assert.ok(!svg.includes('<b>') && svg.includes('&lt;b&gt;x&lt;/b&gt;'));
});

test('the avatar is drawn inside the image when there is one', () => {
  const drawn = metrics();
  drawn.profile.avatar = 'data:image/png;base64,AAAA';
  const svg = renderComponent(drawn, 'profile');
  assert.ok(svg.includes('<image href="data:image/png;base64,AAAA"'));
  assert.ok(!svg.includes('class="initial"'));
});

test('the dashboard opens with the profile, and the contributions part alone still names the person', () => {
  const dashboard = renderDashboard(metrics());
  assert.ok(dashboard.indexOf('Octo Cat') < dashboard.indexOf('>Contributions</text>'));
  assert.ok(!dashboard.includes('class="h1">@octo<'), 'the profile already names the person');
  assert.ok(renderComponent(metrics(), 'contributions').includes('class="h1">@octo<'));
});
