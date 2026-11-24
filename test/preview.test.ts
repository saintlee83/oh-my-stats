import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 as zlibCrc32, inflateSync } from 'node:zlib';
import type { Metrics } from '../src/shared/metrics.ts';
import { GLYPH_COLUMNS, GLYPH_ROWS, GLYPHS, paint, rect, type Drawing } from '../src/shared/render/pixels.ts';
import { crc32, encodePng } from '../src/shared/render/png.ts';
import {
  calendarSquare, PREVIEW_HEIGHT, PREVIEW_PALETTE, PREVIEW_WIDTH, previewData, previewDrawing, renderPreview,
  type PreviewData,
} from '../src/shared/render/preview.ts';
import { computeTokens } from '../src/shared/tokens.ts';
import type { MachineUsage } from '../src/shared/types.ts';
import { githubMetrics } from './fixtures.ts';
import { api, app, countingDb, fakeCache, MACHINE_A, machine, ORIGIN, published, SECRET_NAME, signIn, upload, webLogin, webPost } from './harness.ts';

const [BACKGROUND, EMPTY, GREEN_1, GREEN_2, , GREEN_4, BLUE] = PREVIEW_PALETTE;
const MARGIN = 72;

/** Reads a PNG the long way: every part's checksum by zlib's own count, then each pixel's color. */
function decode(file: Uint8Array) {
  const bytes = Buffer.from(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'the PNG signature');
  const parts: { type: string; data: Buffer }[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    assert.equal(bytes.readUInt32BE(at + 8 + length), zlibCrc32(bytes.subarray(at + 4, at + 8 + length)), `the checksum of ${type}`);
    parts.push({ type, data: bytes.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  const part = (type: string) => parts.find((item) => item.type === type)?.data as Buffer;
  const header = part('IHDR');
  const [width, height] = [header.readUInt32BE(0), header.readUInt32BE(4)];
  const palette = Array.from({ length: part('PLTE').length / 3 }, (_, index) => part('PLTE').readUIntBE(index * 3, 3));
  const rows = inflateSync(part('IDAT'));
  assert.equal(rows.length, (width + 1) * height, 'a filter byte and a byte a pixel, for every row');
  const pixels = new Uint8Array(width * height);
  let copies = 0;
  for (let y = 0; y < height; y++) {
    const filter = rows[y * (width + 1)];
    assert.ok(filter === 0 || (filter === 2 && y > 0), `row ${y} is stored as it is, or as its difference from the row above`);
    copies += filter / 2;
    for (let x = 0; x < width; x++) pixels[y * width + x] = rows[y * (width + 1) + 1 + x] + (filter ? pixels[(y - 1) * width + x] : 0);
  }
  return {
    width, height, palette, copies, rows,
    bits: header[8],
    colorType: header[9],
    parts: parts.map((item) => item.type),
    color: (x: number, y: number) => palette[pixels[y * width + x]],
  };
}

const DAY = 86_400_000;

/** A full year ending on a Wednesday, so the calendar's last week has three days. */
const YEAR = 52 * 7 + 3;

function sample(overrides: Partial<PreviewData> = {}): PreviewData {
  return {
    login: 'octocat',
    tokens: { total: 24.5e9, streak: 41, activeDays: 512 },
    rank: { place: 3, of: 12 },
    github: { year: 2026, contributions: 5923, streak: 12, activeDaysYear: 301 },
    calendar: Array.from({ length: YEAR }, (_, day) => (day % 7 < 5 ? (day + 1) * 1e6 : 0)),
    ...overrides,
  };
}

/** Profiles at the edges of what the picture has to hold. */
const SAMPLES: Record<string, PreviewData> = {
  'every figure': sample(),
  'every character a login can have': sample({ login: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' }),
  'the longest login, in the widest letter': sample({ login: 'W'.repeat(39) }),
  'the largest figures': sample({
    login: 'M'.repeat(39),
    tokens: { total: 999.96e9, streak: 99_999, activeDays: 99_999 },
    rank: { place: 99_999, of: 99_999 },
    github: { year: 2026, contributions: 99_999, streak: 99_999, activeDaysYear: 366 },
  }),
  'figures past a hundred thousand': sample({
    tokens: { total: 8.8e15, streak: 0, activeDays: 123_456 },
    rank: { place: 1_234_567, of: 7_654_321 },
    github: { year: 2026, contributions: 1_234_567, streak: 0, activeDaysYear: 0 },
  }),
  'one of everything': sample({ login: 'a', tokens: { total: 1, streak: 0, activeDays: 1 }, rank: { place: 1, of: 1 }, github: { year: 2026, contributions: 1, streak: 0, activeDaysYear: 1 } }),
  'AI usage alone': sample({ rank: null, github: null }),
  'GitHub stats alone': sample({ tokens: null, rank: null, calendar: Array(YEAR).fill(0) }),
  'GitHub stats alone, at their largest': sample({ tokens: null, rank: null, github: { year: 2026, contributions: 1_234_567, streak: 99_999, activeDaysYear: 366 }, calendar: Array(YEAR).fill(0) }),
  'nothing yet': sample({ tokens: null, rank: null, github: null, calendar: Array(YEAR).fill(0) }),
};

const written = (data: PreviewData) => previewDrawing(data).lines.map((line) => line.text);

const NOW = new Date('2026-11-09T05:00:00Z');

/** What the server works out for a profile, from one machine's usage. */
function metricsOf(days: Record<string, number>, github: Metrics['github'] = null): Metrics {
  const usage: MachineUsage = {
    id: MACHINE_A,
    days: Object.fromEntries(Object.entries(days).map(([date, total]) => [date, { 'claude/claude-opus-5-5': [total, 0, 0, 0, 1] }])),
  };
  const profile = { login: 'octo', name: 'Octo Cat', title: null, company: null, location: null, bio: null, status: null, avatar: null };
  return { generatedDate: '2026-11-09', timezone: 'Asia/Seoul', profile, github, tokens: computeTokens([usage], {}, 'Asia/Seoul', NOW, null) };
}

async function preview(context: ReturnType<typeof app>, path = '/u/octo/og.png') {
  const response = await context.call(path);
  assert.equal(response.status, 200, path);
  return { response, file: new Uint8Array(await response.arrayBuffer()) };
}

test('the preview is a 1200 by 630 PNG of palette colors, with every checksum right and nothing but the picture in it', async () => {
  const { context } = await published();
  const { response, file } = await preview(context);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const png = decode(file);
  assert.deepEqual([png.width, png.height], [1200, 630]);
  assert.deepEqual([png.bits, png.colorType], [8, 3], 'one byte a pixel, each a place in the palette');
  assert.deepEqual(png.palette, [0x0d1117, 0x21262d, 0x0e4429, 0x006d32, 0x26a641, 0x39d353, 0x58a6ff, 0xe6edf3, 0x8b949e]);
  assert.deepEqual(png.parts, ['IHDR', 'PLTE', 'IDAT', 'IEND'], 'no text or other extras');
  for (const [x, y] of [[0, 0], [1199, 0], [0, 629], [1199, 629], [600, 20]]) assert.equal(png.color(x, y), BACKGROUND, `${x},${y} is background`);
  assert.ok(file.length < 10_000, `a few kilobytes, not ${file.length} bytes`);
  assert.ok(png.copies > png.height / 2, 'most rows repeat the row above, which is what keeps drawing and compressing cheap');
});

test('the checksum is the one zlib computes', () => {
  for (const text of ['', 'IEND', 'oh-my-stats', String.fromCharCode(0, 255).repeat(700)]) {
    const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
    assert.equal(crc32(bytes), zlibCrc32(bytes), JSON.stringify(text.slice(0, 12)));
  }
});

test('a picture comes out pixel for pixel as painted, with later rectangles on top and anything past the edge cut off', async () => {
  const [width, height] = [40, 30];
  const drawing: Drawing = [];
  rect(drawing, 2, 3, 10, 8, 1);
  rect(drawing, 6, 5, 20, 3, 2);
  rect(drawing, 30, 0, 4, 30, 3);
  rect(drawing, 35, 25, 50, 50, 4);
  rect(drawing, -5, -5, 8, 7, 5);
  rect(drawing, 8, 6, 1, 1, 6);
  const expected = new Uint8Array(width * height);
  for (let index = 0; index < drawing.length; index += 5) {
    const [left, top, wide, high, color] = drawing.slice(index, index + 5);
    for (let y = Math.max(0, top); y < Math.min(height, top + high); y++) {
      for (let x = Math.max(0, left); x < Math.min(width, left + wide); x++) expected[y * width + x] = color;
    }
  }
  const palette = [0x000000, 0x111111, 0x222222, 0x333333, 0x444444, 0x555555, 0x666666];
  const png = decode(await encodePng({ width, height, palette, rows: paint(drawing, width, height) }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) assert.equal(png.color(x, y), palette[expected[y * width + x]], `${x},${y}`);
  }
  assert.ok(png.copies > 0, 'rows that repeat are stored as copies');
});

test('the calendar shows the last 53 weeks: more usage is brighter, a day without is dim, the newest is blue, and nothing comes after today', async () => {
  const context = app();
  const token = await signIn(context);
  // The server's clock reads Monday 2026-11-09 in the profile's timezone.
  const days = { '2025-11-10': 1000, '2026-10-01': 1, '2026-11-02': 1000, '2026-11-03': 250, '2026-11-08': 500 };
  const body = {
    machine: machine(MACHINE_A),
    timezone: 'Asia/Seoul',
    days: Object.fromEntries(Object.entries(days).map(([date, total]) => [date, { 'claude/claude-opus-5-5': [total, 0, 0, 0, 1] }])),
    totals: {},
  };
  assert.equal((await context.call('/v1/usage', api(token, 'PUT', body))).status, 200);
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  const png = decode((await preview(context)).file);

  const first = '2025-11-10';
  const square = (date: string) => calendarSquare((Date.parse(date) - Date.parse(first)) / DAY);
  const colorOn = (date: string) => {
    const { x, y, size } = square(date);
    const corners = [[x, y], [x + size - 1, y], [x, y + size - 1], [x + size - 1, y + size - 1], [x + size / 2, y + size / 2]];
    const colors = new Set(corners.map(([left, top]) => png.color(left, top)));
    assert.equal(colors.size, 1, `${date} is one flat square`);
    assert.equal(png.color(x + size, y), BACKGROUND, `${date} has a gap to its right`);
    assert.equal(png.color(x, y - 1), BACKGROUND, `${date} has a gap above`);
    return png.color(x, y);
  };
  assert.deepEqual(square(first), { x: MARGIN, y: 440, size: 16 }, 'the oldest week starts at the left margin, on a Monday');
  assert.deepEqual(square('2026-11-09'), { x: PREVIEW_WIDTH - MARGIN - 16, y: 440, size: 16 }, 'today is in the last column, at the right margin');
  assert.equal(square('2026-11-08').y + 16, PREVIEW_HEIGHT - 54, 'Sunday is the bottom row, as far from the edge as the header is from the top');

  assert.equal(colorOn(first), GREEN_4, 'the oldest day shown');
  assert.equal(colorOn('2026-11-02'), GREEN_4, 'the most used day');
  assert.equal(colorOn('2026-11-03'), GREEN_2, 'a quarter of the most is half way up, on a square-root scale');
  assert.equal(colorOn('2026-10-01'), GREEN_1, 'the least usage still shows');
  assert.equal(colorOn('2026-11-08'), BLUE, 'the newest day with usage');
  assert.equal(colorOn('2026-11-09'), EMPTY, 'today, without usage yet');
  assert.equal(colorOn('2026-07-15'), EMPTY, 'a day without usage');
  const tomorrow = square('2026-11-10');
  assert.equal(png.color(tomorrow.x + 8, tomorrow.y + 8), BACKGROUND, 'tomorrow is not drawn');
});

test('a private profile and a missing one answer for the preview exactly as they do for the other images', async () => {
  const cache = fakeCache();
  const context = app({ cache });
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  const answer = async (path: string) => {
    const response = await context.call(path);
    return { status: response.status, headers: [...response.headers], body: await response.text() };
  };
  const hidden = await answer('/u/octo/og.png');
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden, await answer('/u/nobody/og.png'), 'a private profile is not told apart from a missing one');
  assert.deepEqual(hidden, await answer('/u/octo/dashboard.svg'), 'the same answer as the dashboard image');
  assert.ok(hidden.headers.some(([name, value]) => name === 'cache-control' && value === 'no-store'));
  assert.equal(cache.store.size, 0, 'and it is not kept');

  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  await preview(context);
  for (const path of ['/u/octo/og.jpg', '/u/octo/OG.png', '/u/octo/og.png/', '/u/octo/components/og.png']) {
    assert.equal((await context.call(path)).status, 404, path);
  }
});

test('the preview is cached for five minutes once the profile has data, under one address however it is written', async () => {
  const cache = fakeCache();
  const db = countingDb();
  const context = app({ cache, db });
  const token = await signIn(context);
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  const empty = await preview(context);
  assert.equal(empty.response.headers.get('cache-control'), 'no-store', 'so the first upload shows at once');
  assert.equal(cache.store.size, 0);

  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  const first = await preview(context);
  assert.equal(first.response.headers.get('cache-control'), 'public, max-age=300');
  assert.deepEqual([...cache.store.keys()], [`${ORIGIN}/u/octo/og.png`]);
  assert.notDeepEqual(first.file, empty.file, 'the picture now has numbers');

  const reads = db.sql.length;
  for (const path of ['/u/octo/og.png', '/u/OCTO/og.png', '/u/octo/og.png?v=2', '/u/octo/og.png?theme=tokyo-night']) {
    const again = await preview(context, path);
    assert.deepEqual(again.file, first.file, path);
    assert.equal(again.response.headers.get('content-type'), 'image/png', path);
    assert.equal(again.response.headers.get('cache-control'), 'public, max-age=300', path);
  }
  assert.equal(db.sql.length, reads, 'the database is not touched');
  assert.equal(cache.store.size, 1, 'one copy, since the picture has no themes');
});

test('making a profile private, or deleting the account, removes its preview from the cache', async () => {
  const cache = fakeCache();
  const { context, token } = await published({ cache });
  await preview(context);
  assert.equal(cache.store.size, 1);
  await context.call('/v1/me', api(token, 'PATCH', { public: false }));
  assert.equal(cache.store.size, 0);
  assert.equal((await context.call('/u/octo/og.png')).status, 404);

  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  await preview(context);
  assert.equal(cache.store.size, 1);
  const session = await webLogin(context);
  assert.equal((await context.call('/me/delete', webPost(session, 'confirm=octo'))).status, 303);
  assert.equal(cache.store.size, 0);
  assert.equal((await context.call('/u/octo/og.png')).status, 404);
});

test('the profile page names its preview as the image to show, at 1200 by 630, and that address serves it', async () => {
  const { context } = await published();
  const page = await (await context.call('/u/octo')).text();
  const meta = (property: string) => new RegExp(`<meta property="${property}" content="([^"]*)">`).exec(page)?.[1];
  assert.equal(meta('og:image'), 'https://stats.example/u/octo/og.png', 'by its full address, which sites that draw previews need');
  assert.deepEqual([meta('og:image:width'), meta('og:image:height')], [String(PREVIEW_WIDTH), String(PREVIEW_HEIGHT)]);
  assert.deepEqual([PREVIEW_WIDTH, PREVIEW_HEIGHT], [1200, 630]);
  assert.match(meta('og:image:alt') ?? '', /@octo/);
  assert.match(page, /<meta name="twitter:card" content="summary_large_image">/);
  assert.equal(page.match(/og:image"/g)?.length, 1, 'one image, not the site banner as well');
  const png = decode((await preview(context, new URL(meta('og:image') as string).pathname)).file);
  assert.deepEqual([png.width, png.height], [Number(meta('og:image:width')), Number(meta('og:image:height'))]);
  assert.match(await (await context.call('/')).text(), /<meta property="og:image" content="https:\/\/stats\.example\/og\.png"\/?>/, 'other pages keep the site banner');
});

test('every character the preview can write has a glyph of seven rows by five columns', () => {
  assert.deepEqual([...GLYPHS.keys()].sort().join(''), [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#-., '].sort().join(''));
  assert.deepEqual([GLYPH_ROWS, GLYPH_COLUMNS], [7, 5]);
  const seen = new Map<string, string>();
  for (const [character, rows] of GLYPHS) {
    assert.equal(rows.length, 7, `${character} has seven rows`);
    for (const row of rows) assert.match(row, /^[.#]{5}$/, `${character} has five columns`);
    assert.equal(rows.join('').includes('#'), character !== ' ', `${character} is drawn, and a space is not`);
    const shape = rows.join('\n');
    assert.equal(seen.get(shape), undefined, `${character} looks like no other character`);
    seen.set(shape, character);
  }
  for (const [name, data] of Object.entries(SAMPLES)) {
    for (const line of written(data)) {
      assert.ok(line.length > 0, name);
      for (const character of line) assert.ok(GLYPHS.has(character), `${name}: "${character}" in "${line}" has a glyph`);
    }
  }
  assert.ok(written(SAMPLES['every character a login can have']).includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'));
});

test('the longest login and the largest figures stay inside the picture, and no line of text touches another', async () => {
  for (const [name, data] of Object.entries(SAMPLES)) {
    const { drawing, lines } = previewDrawing(data);
    for (let index = 0; index < drawing.length; index += 5) {
      const [x, y, width, height] = drawing.slice(index, index + 4);
      assert.ok(Number.isInteger(x) && Number.isInteger(y) && width > 0 && height > 0, `${name}: whole pixels`);
      assert.ok(x >= MARGIN && x + width <= PREVIEW_WIDTH - MARGIN && y >= 54 && y + height <= PREVIEW_HEIGHT - 54, `${name}: a rectangle at ${x},${y} is past the margin`);
    }
    for (const line of lines) {
      assert.ok(line.x >= MARGIN && line.x + line.width <= PREVIEW_WIDTH - MARGIN, `${name}: "${line.text}" is inside the margins`);
      for (const other of lines) {
        if (other === line) continue;
        const apart = line.x + line.width <= other.x || other.x + other.width <= line.x || line.y + line.height <= other.y || other.y + other.height <= line.y;
        assert.ok(apart, `${name}: "${line.text}" overlaps "${other.text}"`);
      }
    }
  }
  const longest = SAMPLES['the longest login, in the widest letter'];
  assert.ok(written(longest).includes('W'.repeat(39)), 'the whole login is written, not cut short');
  const png = decode(await renderPreview(longest));
  for (let y = 0; y < PREVIEW_HEIGHT; y++) {
    for (const x of [0, MARGIN - 1, PREVIEW_WIDTH - MARGIN, PREVIEW_WIDTH - 1]) assert.equal(png.color(x, y), BACKGROUND, `${x},${y} is in the margin`);
  }
});

test('the preview writes only its listed figures, so a machine name or the profile\'s own name has no way in', async () => {
  const data = previewData(metricsOf({ '2026-11-08': 10 }, githubMetrics()), { rank: 1, participants: 1 });
  assert.deepEqual(Object.keys(data).sort(), ['calendar', 'github', 'login', 'rank', 'tokens']);
  assert.ok(!JSON.stringify(data).includes(MACHINE_A), 'no machine id is carried to the drawing');
  assert.ok(!JSON.stringify(data).includes('Octo Cat'), 'nor the name, which can be in any script');
  assert.deepEqual(written(data), [
    'OH-MY-STATS', '@', 'OCTO',
    '10', 'AI TOKENS',
    '#1', 'OF 1 RANKED PROFILE',
    '3,729', 'CONTRIBUTIONS IN 2026',
    '1', 'DAY WITH AI USAGE',
    'LAST 53 WEEKS OF AI USAGE', 'MORE', 'LESS',
  ]);

  // The same profile over the network, from a machine with a name to keep.
  const context = app();
  const token = await signIn(context);
  await context.call('/v1/usage', api(token, 'PUT', upload(MACHINE_A)));
  await context.call('/v1/github', api(token, 'PUT', githubMetrics()));
  await context.call('/v1/me', api(token, 'PATCH', { public: true }));
  const { file } = await preview(context);
  assert.deepEqual(file, await renderPreview(data), 'the picture is drawn from those figures and nothing else');
  const bytes = Buffer.concat([file, decode(file).rows]).toString('latin1');
  assert.ok(!bytes.includes(SECRET_NAME) && !bytes.includes(MACHINE_A), 'neither as stored nor as unpacked');
});

test('a streak is days in a row up to today or yesterday, and the calendar starts on a Monday and stops at today', () => {
  const streakOf = (days: Record<string, number>) => previewData(metricsOf(days), null).tokens?.streak;
  assert.equal(streakOf({ '2026-11-07': 5, '2026-11-08': 5, '2026-11-09': 5 }), 3, 'through today');
  assert.equal(streakOf({ '2026-11-06': 5, '2026-11-07': 5, '2026-11-08': 5 }), 3, 'through yesterday, since uploads can be a day behind');
  assert.equal(streakOf({ '2026-11-05': 5, '2026-11-06': 5, '2026-11-07': 5 }), 0, 'a run that ended two days ago is over');
  assert.equal(streakOf({ '2026-11-05': 5, '2026-11-06': 5, '2026-11-08': 5, '2026-11-09': 5 }), 2, 'a gap starts the count again');
  assert.equal(streakOf({ '2026-11-09': 5, '2026-11-10': 5 }), 1, 'a day past today, from a machine whose clock runs ahead, is left out');

  const data = previewData(metricsOf({ '2025-11-09': 7, '2025-11-10': 8, '2026-11-09': 9, '2026-11-10': 5 }), null);
  assert.equal(data.calendar.length, 52 * 7 + 1, 'today is a Monday, so the last week has one day');
  assert.equal(data.calendar[0], 8, 'the first day is the Monday 52 weeks ago');
  assert.equal(data.calendar.at(-1), 9, 'the last day is today');
  assert.equal(data.calendar.reduce((sum, value) => sum + value, 0), 17, 'days before and after are left out');
  assert.equal(data.tokens?.total, 29, 'while the total stays the lifetime one');
  assert.equal(data.rank, null);

  assert.ok(written(sample({ tokens: { total: 5, streak: 41, activeDays: 60 } })).includes('DAY STREAK OF AI USAGE'));
  const resting = written(sample({ tokens: { total: 5, streak: 1, activeDays: 60 } }));
  assert.ok(resting.includes('DAYS WITH AI USAGE') && resting.includes('60') && !resting.includes('DAY STREAK OF AI USAGE'), 'one day is not a streak');
});

test('without AI usage the contributions lead, and with nothing at all the picture says so', () => {
  assert.deepEqual(written(SAMPLES['GitHub stats alone']), [
    'OH-MY-STATS', '@', 'OCTOCAT',
    '5,923', 'CONTRIBUTIONS IN 2026',
    '12', 'DAY STREAK',
    '301', 'ACTIVE DAYS IN A YEAR',
    'LAST 53 WEEKS OF AI USAGE', 'NONE YET',
  ]);
  assert.deepEqual(written(SAMPLES['AI usage alone']), [
    'OH-MY-STATS', '@', 'OCTOCAT',
    '24.5B', 'AI TOKENS',
    '41', 'DAY STREAK OF AI USAGE',
    'LAST 53 WEEKS OF AI USAGE', 'MORE', 'LESS',
  ]);
  assert.deepEqual(written(SAMPLES['nothing yet']), ['OH-MY-STATS', '@', 'OCTOCAT', 'NO STATS YET', 'LAST 53 WEEKS OF AI USAGE', 'NONE YET']);
  assert.deepEqual(written(SAMPLES['one of everything']), [
    'OH-MY-STATS', '@', 'A',
    '1', 'AI TOKEN',
    '#1', 'OF 1 RANKED PROFILE',
    '1', 'CONTRIBUTION IN 2026',
    '1', 'DAY WITH AI USAGE',
    'LAST 53 WEEKS OF AI USAGE', 'MORE', 'LESS',
  ], 'one of a thing is not called several');
  const large = written(SAMPLES['figures past a hundred thousand']);
  for (const figure of ['8800T', '#1.2M', 'OF 7.7M RANKED PROFILES', '1.2M', '123K']) assert.ok(large.includes(figure), `${figure} in ${large.join(' | ')}`);
});
