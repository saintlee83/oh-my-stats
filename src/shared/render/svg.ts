import type { GitHubMetrics, Metrics, ProfileMetrics, ProfileStatus, TokenMetrics } from '../metrics.ts';
import { commas, compact, hours, money, percent } from '../format.ts';
import { WEEKDAYS } from '../time.ts';

type Palette = Record<
  'surface' | 'ink' | 'ink2' | 'muted' | 'grid' | 'axis' | 'ramp-low' | 'c1' | 'c2' | 'c3' | 'c4' | 'add' | 'del' | 'h0' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5',
  string
>;

/**
 * Every palette is checked for color-vision safety against its own surface:
 * categorical slots keep a fixed order, magnitude uses one hue whose quietest step
 * still shows on the surface, and added/removed use a blue-red diverging pair of
 * equal lightness. Text clears 4.5:1. Inside an <img> an SVG follows the OS color
 * scheme and has no hover, so every value is also in the text cards, which act as
 * the table view.
 */
export const THEMES = {
  /** GitHub's own backgrounds and grays, so on a GitHub page the image reads as one of its bordered boxes. */
  github: {
    light: {
      surface: '#ffffff', ink: '#1f2328', ink2: '#424a53', muted: '#656d76', grid: '#d0d7de', axis: '#afb8c1', 'ramp-low': '#afb8c1',
      c1: '#2a78d6', c2: '#eb6834', c3: '#1baf7a', c4: '#eda100', add: '#2a78d6', del: '#e34948',
      h0: '#eaeef2', h1: '#7eb5fe', h2: '#4996f6', h3: '#2a78d6', h4: '#015bb5', h5: '#014286',
    },
    dark: {
      surface: '#0d1117', ink: '#e6edf3', ink2: '#c9d1d9', muted: '#8b949e', grid: '#30363d', axis: '#3d444d', 'ramp-low': '#4d5560',
      c1: '#3987e5', c2: '#d95926', c3: '#199e70', c4: '#c98500', add: '#3987e5', del: '#e66767',
      h0: '#21262d', h1: '#004791', h2: '#0e63bf', h3: '#3683e2', h4: '#5ca3ff', h5: '#99c5fe',
    },
  },
  /**
   * Tokyo Night in dark mode and its Day variant in light mode. Its blue, orange, cyan and
   * yellow are kept, at the lightness a chart needs; its green is left out, because next
   * to yellow and orange it can't be told apart with red-green color blindness.
   */
  'tokyo-night': {
    light: {
      surface: '#e1e2e7', ink: '#3760bf', ink2: '#475692', muted: '#596089', grid: '#c4c8da', axis: '#a8aecb', 'ramp-low': '#a1a6c5',
      c1: '#2e7de9', c2: '#b15c00', c3: '#007197', c4: '#a0731c', add: '#2e7de9', del: '#e8155b',
      h0: '#c4c8da', h1: '#5a9efe', h2: '#3483f0', h3: '#176ad4', h4: '#0053b2', h5: '#013e89',
    },
    dark: {
      surface: '#1a1b26', ink: '#c0caf5', ink2: '#a9b1d6', muted: '#7f86ad', grid: '#292e42', axis: '#3b4261', 'ramp-low': '#4a5175',
      c1: '#698fe3', c2: '#d3763b', c3: '#0aa4bc', c4: '#b88841', add: '#698fe3', del: '#e1627b',
      h0: '#292e42', h1: '#2a4b98', h2: '#4468b8', h3: '#6086d9', h4: '#7da6fb', h5: '#acc7ff',
    },
  },
} satisfies Record<string, { light: Palette; dark: Palette }>;

export type Theme = keyof typeof THEMES;
export const DEFAULT_THEME: Theme = 'github';
export const THEME_NAMES = Object.keys(THEMES) as Theme[];

/** Reads a theme name loosely, so "tokyonight" and "Tokyo-Night" work too. Anything else is the default. */
export function themeNamed(value: string | null): Theme {
  const wanted = (value ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return THEME_NAMES.find((name) => name.replace(/-/g, '') === wanted) ?? DEFAULT_THEME;
}

const variables = (palette: Palette) =>
  Object.entries(palette)
    .map(([name, value]) => `--${name}:${value};`)
    .join(' ');

const RULES = `
  text { font-family: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: var(--ink); }
  .surface { fill: var(--surface); stroke: var(--grid); }
  .h1 { font-size: 15px; font-weight: 600; }
  .note { font-size: 12px; fill: var(--muted); }
  .label { font-size: 13px; fill: var(--ink2); }
  .value { font-size: 12px; fill: var(--ink2); font-variant-numeric: tabular-nums; }
  .axis { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
  .hero { font-size: 56px; font-weight: 600; }
  .tile-value { font-size: 26px; font-weight: 600; }
  .name { font-size: 24px; font-weight: 600; }
  .handle { font-size: 15px; font-weight: 400; fill: var(--muted); }
  .lead { font-size: 15px; fill: var(--ink2); }
  .bio { font-size: 13px; fill: var(--muted); }
  .chip { font-size: 12px; font-weight: 600; fill: var(--ink2); }
  .initial { font-size: 30px; font-weight: 600; fill: var(--ink2); }
  .tile-text { font-size: 17px; font-weight: 600; }
  .outline { fill: none; stroke: var(--grid); stroke-width: 1; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .baseline { stroke: var(--axis); stroke-width: 1; }
`;

const style = (theme: Theme) => `
  svg { ${variables(THEMES[theme].light)} }
  @media (prefers-color-scheme: dark) {
    svg { ${variables(THEMES[theme].dark)} }
  }${RULES}`;

const WIDTH = 1000;
const MARGIN = 32;
const INNER = WIDTH - MARGIN * 2;

interface Section {
  height: number;
  body: string;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

function n(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function text(x: number, y: number, content: string, cls: string, anchor: 'start' | 'end' | 'middle' = 'start'): string {
  const attr = anchor === 'start' ? '' : ` text-anchor="${anchor}"`;
  return `<text x="${n(x)}" y="${n(y)}" class="${cls}"${attr}>${esc(content)}</text>`;
}

/** Hangul, CJK, full-width forms and emoji take about an em. */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u;

/** Roughly how wide a line is drawn, since an SVG can't wrap or measure text itself. Errs wide. */
function textWidth(content: string, size: number): number {
  let width = 0;
  for (const char of content) {
    if (/[\u200D\uFE0F]/u.test(char)) continue;
    width += WIDE.test(char) ? size : /[A-Z0-9@#%&mw]/.test(char) ? size * 0.66 : /[\s.,:;'!|·ijlrtf()]/.test(char) ? size * 0.32 : size * 0.56;
  }
  return width;
}

/** Shortens a line to fit a width, ending it with an ellipsis. */
function fit(content: string, maxWidth: number, size: number): string {
  if (textWidth(content, size) <= maxWidth) return content;
  const chars = Array.from(content);
  while (chars.length && textWidth(`${chars.join('')}…`, size) > maxWidth) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

function title(content: string): string {
  return `<title>${esc(content)}</title>`;
}

/** A bar growing right from x: square at the baseline, rounded at its data end. */
function barRight(x: number, y: number, width: number, height: number, fill: string, tip = '', round = true): string {
  if (width <= 0) return '';
  const radius = round ? Math.min(4, width, height / 2) : 0;
  const d = `M${n(x)} ${n(y)}H${n(x + width - radius)}${radius ? `A${n(radius)} ${n(radius)} 0 0 1 ${n(x + width)} ${n(y + radius)}V${n(y + height - radius)}A${n(radius)} ${n(radius)} 0 0 1 ${n(x + width - radius)} ${n(y + height)}` : `V${n(y + height)}`}H${n(x)}Z`;
  return `<path d="${d}" fill="var(--${fill})">${tip ? title(tip) : ''}</path>`;
}

function barLeft(x: number, y: number, width: number, height: number, fill: string, tip = ''): string {
  if (width <= 0) return '';
  const radius = Math.min(4, width, height / 2);
  const d = `M${n(x)} ${n(y)}H${n(x - width + radius)}A${n(radius)} ${n(radius)} 0 0 0 ${n(x - width)} ${n(y + radius)}V${n(y + height - radius)}A${n(radius)} ${n(radius)} 0 0 0 ${n(x - width + radius)} ${n(y + height)}H${n(x)}Z`;
  return `<path d="${d}" fill="var(--${fill})">${tip ? title(tip) : ''}</path>`;
}

function barUp(x: number, baseline: number, width: number, height: number, fill: string, tip = '', round = true): string {
  if (height <= 0) return '';
  const radius = round ? Math.min(4, height, width / 2) : 0;
  const top = baseline - height;
  const d = radius
    ? `M${n(x)} ${n(baseline)}V${n(top + radius)}A${n(radius)} ${n(radius)} 0 0 1 ${n(x + radius)} ${n(top)}H${n(x + width - radius)}A${n(radius)} ${n(radius)} 0 0 1 ${n(x + width)} ${n(top + radius)}V${n(baseline)}Z`
    : `M${n(x)} ${n(baseline)}V${n(top)}H${n(x + width)}V${n(baseline)}Z`;
  return `<path d="${d}" fill="var(--${fill})">${tip ? title(tip) : ''}</path>`;
}

function legend(x: number, y: number, items: { label: string; fill: string }[]): string {
  let cursor = x;
  let out = '';
  for (const item of items) {
    out += `<rect x="${n(cursor)}" y="${n(y - 9)}" width="10" height="10" rx="2" fill="var(--${item.fill})"/>`;
    out += text(cursor + 15, y, item.label, 'note');
    cursor += 15 + item.label.length * 6.6 + 18;
  }
  return out;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

/** Skewed activity data reads better on a square-root scale: quiet cells stay visible. */
function heatStep(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(1, Math.ceil(Math.sqrt(value / max) * 5));
}

function miniBars(x: number, y: number, values: number[], width: number, height: number): string {
  const slot = width / values.length;
  const max = Math.max(1, ...values);
  return values
    .map((value, index) => {
      const size = value > 0 ? Math.max(2, (value / max) * height) : 0;
      const last = index === values.length - 1;
      return barUp(x + index * slot, y + height, Math.max(1, slot - 2), size, last ? 'c1' : 'ramp-low');
    })
    .join('');
}

/** In the dashboard the profile above already names the person, so this heading says what it shows. */
function headerSection(github: GitHubMetrics, heading = `@${github.login}`): Section {
  const { counts, monthly, thisYear } = github;
  const tiles: [string, number, number, number[]][] = [
    ['Commits', thisYear.commits, counts.commits, monthly.commits],
    ['Pull requests', thisYear.pulls, counts.pulls, monthly.pulls],
    ['Code reviews', thisYear.reviews, counts.reviews, monthly.reviews],
    ['Issues', thisYear.issues, counts.issues, monthly.issues],
  ];
  const tileWidth = 150;
  const startX = INNER - tileWidth * tiles.length - 18 * (tiles.length - 1);
  let body = text(0, 22, heading, 'h1');
  body += text(0, 92, commas(thisYear.calendar), 'hero');
  body += text(0, 118, `contributions in ${thisYear.year}`, 'note');
  body += text(0, 136, `${commas(counts.calendar)} lifetime contributions`, 'note');
  body += text(0, 154, `across ${commas(github.coverage.reposWithCommits)} repos and ${github.pulse.organizations} orgs`, 'note');
  tiles.forEach(([label, value, lifetime, series], index) => {
    const x = startX + index * (tileWidth + 18);
    body += text(x, 22, label, 'label');
    body += text(x, 58, commas(value), 'tile-value');
    body += miniBars(x, 72, series, tileWidth, 34);
    body += text(x, 122, `${commas(lifetime)} lifetime · 12 months`, 'axis');
  });
  return { height: 160, body };
}

const AVATAR = 72;
const BOLD = 1.12;

const TONES: Record<ProfileStatus['tone'], string> = { open: 'c3', hiring: 'c1', freelance: 'c4', busy: 'c2', neutral: 'muted' };

function avatar(profile: ProfileMetrics): string {
  const r = AVATAR / 2;
  if (profile.avatar) {
    return `<clipPath id="omg-avatar"><circle cx="${r}" cy="${r}" r="${r}"/></clipPath><image href="${esc(profile.avatar)}" width="${AVATAR}" height="${AVATAR}" clip-path="url(#omg-avatar)" preserveAspectRatio="xMidYMid slice"/><circle cx="${r}" cy="${r}" r="${r - 0.5}" class="outline"/>`;
  }
  const initial = Array.from(profile.name ?? profile.login)[0]?.toUpperCase() ?? '?';
  return `<circle cx="${r}" cy="${r}" r="${r}" fill="var(--h0)"/>${text(r, r + 11, initial, 'initial', 'middle')}`;
}

/** A rounded label in the top right corner. Returns its width, so the name can stay clear of it. */
function statusPill(status: ProfileStatus): { width: number; body: string } {
  // Semibold text runs wider than the estimate.
  const label = fit(status.label, 260, 12 * BOLD);
  const marker = status.emoji ? textWidth(status.emoji, 13) + 6 : 14;
  const width = 24 + marker + (label ? textWidth(label, 12 * BOLD) : -6);
  const x = INNER - width;
  let body = `<rect x="${n(x)}" y="2" width="${n(width)}" height="26" rx="13" class="outline"/>`;
  body += status.emoji ? text(x + 12, 20, status.emoji, 'chip') : `<circle cx="${n(x + 16)}" cy="15" r="4" fill="var(--${TONES[status.tone]})"/>`;
  if (label) body += text(x + 12 + marker, 19, label, 'chip');
  return { width, body };
}

function careerTiles({ github, tokens }: Metrics): { label: string; value: string; note: string; wordy?: boolean }[] {
  const tiles: { label: string; value: string; note: string; wordy?: boolean }[] = [];
  if (github) {
    const active = github.years.filter((year) => year.calendar > 0);
    const joined = Number(github.memberSince.slice(0, 4));
    const since = active.length ? Math.min(...active.map((year) => year.year)) : joined;
    if (Number.isFinite(since) && since > 0) {
      tiles.push({ label: 'Contributing since', value: String(since), note: `${active.length} active ${active.length === 1 ? 'year' : 'years'}` });
    }
    tiles.push({ label: 'Lifetime contributions', value: commas(github.counts.calendar), note: `${commas(github.thisYear.calendar)} in ${github.thisYear.year}` });
    const top = github.languages.filter((row) => row.lines > 0).slice(0, 3);
    if (top.length) tiles.push({ label: 'Top languages', value: top.map((row) => row.name).join(' · '), note: 'by lines added', wordy: true });
  }
  if (tokens) {
    tiles.push({ label: 'AI tokens', value: compact(tokens.total), note: github ? `${percent(github.pulse.aiShare, 0)} of commits AI-assisted` : `${commas(tokens.activeDays)} active days` });
  } else if (github) {
    tiles.push({ label: 'Current streak', value: `${commas(github.pulse.streak)} days`, note: `best ${commas(github.pulse.bestStreak)} days` });
  }
  return tiles;
}

/** As many items of a ` · ` list as fit, rather than cutting one in half. */
function fewest(list: string, maxWidth: number, size: number): string {
  const items = list.split(' · ');
  for (let count = items.length; count > 1; count--) {
    const shown = items.slice(0, count).join(' · ');
    if (textWidth(shown, size) <= maxWidth) return shown;
  }
  return fit(items[0], maxWidth, size);
}

/** Who this is: name, role and status, with a line of career figures beneath. */
function profileSection(metrics: Metrics): Section {
  const { profile } = metrics;
  const textX = AVATAR + 20;
  let body = avatar(profile);
  const pill = profile.status ? statusPill(profile.status) : null;
  if (pill) body += pill.body;

  const room = INNER - textX - (pill ? pill.width + 16 : 0);
  const handle = `@${profile.login}`;
  if (profile.name) {
    const name = fit(profile.name, Math.max(120, room - textWidth(handle, 15) - 10), 24);
    body += `<text x="${textX}" y="28" class="name">${esc(name)}<tspan class="handle" dx="10">${esc(handle)}</tspan></text>`;
  } else {
    body += text(textX, 28, fit(handle, room, 24), 'name');
  }

  const role = profile.title && profile.company ? `${profile.title} at ${profile.company}` : (profile.title ?? profile.company);
  const lines: [string, string][] = [];
  const lead = [role, profile.location].filter(Boolean).join(' · ');
  if (lead) lines.push([fit(lead, INNER - textX, 15), 'lead']);
  if (profile.bio) lines.push([fit(profile.bio, INNER - textX, 13), 'bio']);
  let y = 28;
  for (const [line, cls] of lines) {
    y += cls === 'lead' ? 26 : 22;
    body += text(textX, y, line, cls);
  }

  const tiles = careerTiles(metrics);
  if (!tiles.length) return { height: Math.max(AVATAR, y + 6), body };
  const top = Math.max(AVATAR, y + 6) + 28;
  const slot = INNER / 4;
  tiles.forEach((tile, index) => {
    const x = index * slot;
    body += text(x, top + 14, tile.label, 'label');
    body += tile.wordy ? text(x, top + 44, fewest(tile.value, slot - 12, 17 * BOLD), 'tile-text') : text(x, top + 48, tile.value, 'tile-value');
    body += text(x, top + 68, tile.note, 'axis');
  });
  return { height: top + 74, body };
}

function rhythmSection(github: GitHubMetrics, timezone: string): Section {
  const { rhythm } = github;
  const labelWidth = 34;
  const cell = 22;
  const gap = 2;
  const max = Math.max(1, ...rhythm.punch.flat());
  let body = text(0, 14, 'When contributions happen', 'h1');
  body += text(0, 32, `${commas(rhythm.total)} timestamped events, ${timezone}`, 'note');

  const top = 54;
  rhythm.punch.forEach((row, weekday) => {
    const y = top + weekday * (cell + gap);
    body += text(0, y + 15, WEEKDAYS[weekday], 'axis');
    row.forEach((value, hour) => {
      const x = labelWidth + hour * (cell + gap);
      body += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="var(--h${heatStep(value, max)})">${title(`${WEEKDAYS[weekday]} ${String(hour).padStart(2, '0')}:00, ${commas(value)}`)}</rect>`;
    });
  });
  const axisY = top + 7 * (cell + gap) + 12;
  for (const hour of [0, 6, 12, 18]) {
    body += text(labelWidth + hour * (cell + gap), axisY, `${String(hour).padStart(2, '0')}:00`, 'axis');
  }

  const scaleX = labelWidth + 24 * (cell + gap) - 142;
  body += text(scaleX - 6, axisY, 'Less', 'axis', 'end');
  for (let step = 0; step <= 5; step++) {
    body += `<rect x="${scaleX + step * 18}" y="${axisY - 10}" width="16" height="11" rx="2" fill="var(--h${step})"/>`;
  }
  body += text(scaleX + 6 * 18 + 2, axisY, 'More', 'axis');

  const barX = labelWidth + 24 * (cell + gap) + 40;
  const barWidth = INNER - barX;
  const peakShare = Math.max(0.01, ...rhythm.buckets.map((bucket) => bucket.share));
  body += text(barX, 14, 'By time of day', 'h1');
  body += text(barX, 32, rhythm.persona, 'note');
  rhythm.buckets.forEach((bucket, index) => {
    const y = top + index * 42;
    body += text(barX, y + 10, `${bucket.label} ${bucket.range}`, 'label');
    body += text(barX + barWidth, y + 10, percent(bucket.share, 0), 'value', 'end');
    body += `<rect x="${barX}" y="${y + 18}" width="${barWidth}" height="8" rx="4" fill="var(--grid)"/>`;
    body += barRight(barX, y + 18, (bucket.share / peakShare) * barWidth, 8, 'c1', `${bucket.label}: ${commas(bucket.count)}`);
  });
  return { height: axisY + 6, body };
}

function languagesPanel(github: GitHubMetrics, width: number): Section {
  const rows = github.languages.filter((row) => row.lines > 0).slice(0, 10);
  const nameWidth = 122;
  const valueWidth = 48;
  const trackWidth = width - nameWidth - valueWidth;
  const maxLines = Math.max(1, ...rows.map((row) => row.lines));
  const series = [
    { key: 'personal', label: 'Personal', fill: 'c1' },
    { key: 'org', label: 'Orgs', fill: 'c2' },
    { key: 'gist', label: 'Gists', fill: 'c3' },
    { key: 'external', label: 'Other', fill: 'c4' },
  ] as const;

  let body = text(0, 14, 'Top languages', 'h1');
  body += text(0, 32, `By lines you added, of ${github.languages.length} languages traced`, 'note');
  body += legend(0, 54, series.map(({ label, fill }) => ({ label, fill })));

  rows.forEach((row, index) => {
    const y = 72 + index * 26;
    body += text(0, y + 12, row.name.length > 18 ? `${row.name.slice(0, 17)}…` : row.name, 'label');
    let x = nameWidth;
    const segments = series
      .map((item) => ({ ...item, value: row[item.key] }))
      .filter((item) => (item.value / maxLines) * trackWidth >= 1);
    segments.forEach((segment, position) => {
      const raw = (segment.value / maxLines) * trackWidth;
      const isLast = position === segments.length - 1;
      const drawn = Math.max(1, isLast ? raw : raw - 2);
      body += barRight(x, y, drawn, 14, segment.fill, `${row.name}, ${segment.label}: ${compact(segment.value)} lines`, isLast);
      x += raw;
    });
    body += text(x + 6, y + 12, percent(row.share, row.share < 0.1 ? 1 : 0), 'value');
  });
  return { height: 72 + rows.length * 26, body };
}

function coauthorsPanel(github: GitHubMetrics, width: number): Section {
  const { coauthors } = github;
  const rows = coauthors.rows.slice(0, 10);
  let body = text(0, 14, 'Top coauthored with', 'h1');
  body += text(0, 32, `${commas(coauthors.coauthored)} co-authored commits, ${percent(coauthors.soloShare, 0)} solo`, 'note');
  if (rows.length === 0) {
    body += text(0, 64, 'No co-authored commits yet.', 'label');
    return { height: 80, body };
  }
  const nameWidth = 138;
  const valueWidth = 48;
  const maxCommits = Math.max(1, ...rows.map((row) => row.commits));
  rows.forEach((row, index) => {
    const y = 72 + index * 26;
    const label = row.label.length > 20 ? `${row.label.slice(0, 19)}…` : row.label;
    body += text(0, y + 12, label, 'label');
    const size = (row.commits / maxCommits) * (width - nameWidth - valueWidth);
    body += barRight(nameWidth, y, Math.max(2, size), 14, 'c1', `${row.label}: ${commas(row.commits)} commits`);
    body += text(nameWidth + Math.max(2, size) + 6, y + 12, compact(row.commits), 'value');
  });
  return { height: 72 + rows.length * 26, body };
}

function churnSection(github: GitHubMetrics): Section {
  const { churn } = github;
  const rows = churn.rows.slice(0, 10);
  const nameWidth = 130;
  const tipSpace = 58;
  // One scale for both directions; each arm gets only the width its data needs.
  const maxDel = Math.max(0, ...rows.map((row) => row.del));
  const maxAdd = Math.max(1, ...rows.map((row) => row.add));
  const pixelsPerLine = (INNER - nameWidth - tipSpace * 2) / (maxDel + maxAdd);
  const center = nameWidth + tipSpace + maxDel * pixelsPerLine;

  let body = text(0, 14, 'Lines added and removed, by language', 'h1');
  body += text(0, 32, `+${compact(churn.add)} / -${compact(churn.del)} lines of code in ${commas(github.coverage.churnDone)} commits`, 'note');
  body += legend(0, 54, [
    { label: 'Removed', fill: 'del' },
    { label: 'Added', fill: 'add' },
  ]);

  const top = 70;
  const rowHeight = 25;
  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    body += text(0, y + 12, row.name.length > 18 ? `${row.name.slice(0, 17)}…` : row.name, 'label');
    const left = row.del > 0 ? Math.max(2, row.del * pixelsPerLine) : 0;
    const right = row.add > 0 ? Math.max(2, row.add * pixelsPerLine) : 0;
    body += barLeft(center - 1, y, left, 14, 'del', `${row.name} removed: ${commas(row.del)}`);
    body += barRight(center + 1, y, right, 14, 'add', `${row.name} added: ${commas(row.add)}`);
    body += text(center - left - 7, y + 12, `-${compact(row.del)}`, 'value', 'end');
    body += text(center + right + 7, y + 12, `+${compact(row.add)}`, 'value');
  });
  const bottom = top + rows.length * rowHeight;
  body += `<line x1="${n(center)}" x2="${n(center)}" y1="${top - 4}" y2="${bottom - 6}" class="baseline"/>`;
  return { height: bottom, body };
}

function tokensSection(tokens: TokenMetrics): Section {
  const toolLabel: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
  const machineCount = (count: number) => (count === 1 ? '1 machine' : `${count} machines`);
  const reach = {
    machine: (count: number) => `on ${machineCount(count)}`,
    account: () => 'across the account',
    logs: (count: number) => `from logs on ${machineCount(count)}`,
  };
  const isMinimum = tokens.unpricedModels.length > 0 || tokens.unattributed > 0;
  const tileItems: [string, string][] = [
    ['Total tokens', compact(tokens.total)],
    ...tokens.tools.slice(0, 2).map((row): [string, string] => [toolLabel[row.tool] ?? row.tool, compact(row.total)]),
    ['Cache hit rate', percent(tokens.cacheShare, 1)],
    ['At API list price', `${isMinimum ? '≥' : '≈'}${money(tokens.cost)}`],
  ];
  let body = text(0, 14, 'AI token trace', 'h1');
  body += text(0, 32, tokens.tools.map((row) => `${toolLabel[row.tool] ?? row.tool} ${reach[row.scope](row.machines)}`).join(', '), 'note');
  const tileWidth = INNER / tileItems.length;
  tileItems.forEach(([label, value], index) => {
    body += text(index * tileWidth, 66, value, 'tile-value');
    body += text(index * tileWidth, 86, label, 'label');
  });

  // Fixed per tool, so a tool keeps its color when the ranking changes.
  const TOOL_FILLS: Record<string, string> = { claude: 'c1', codex: 'c2' };
  const spare = ['c3', 'c4'];
  const toolNames = tokens.tools.map((tool) => tool.tool).sort();
  const fillOf = (tool: string) => TOOL_FILLS[tool] ?? spare[Math.max(0, toolNames.indexOf(tool)) % spare.length];
  body += text(0, 120, 'Tokens per day, last 60 days', 'label');
  body += legend(
    INNER - toolNames.length * 110,
    120,
    toolNames.map((tool) => ({ label: toolLabel[tool] ?? tool, fill: fillOf(tool) })),
  );

  const axisWidth = 44;
  const plotTop = 134;
  const plotHeight = 120;
  const baseline = plotTop + plotHeight;
  const plotWidth = INNER - axisWidth;
  const peak = niceMax(Math.max(1, ...tokens.daily.map((day) => day.total)));
  for (const tick of [0, 0.5, 1]) {
    const y = baseline - tick * plotHeight;
    body += `<line x1="${axisWidth}" x2="${INNER}" y1="${n(y)}" y2="${n(y)}" class="${tick === 0 ? 'baseline' : 'grid'}"/>`;
    body += text(axisWidth - 8, y + 4, compact(peak * tick), 'axis', 'end');
  }
  const slot = plotWidth / tokens.daily.length;
  tokens.daily.forEach((day, index) => {
    const x = axisWidth + index * slot;
    const parts = toolNames
      .map((tool) => ({ tool, fill: fillOf(tool), value: day.byTool[tool] ?? 0 }))
      .filter((part) => part.value > 0);
    let stack = 0;
    parts.forEach((part, position) => {
      const raw = (part.value / peak) * plotHeight;
      const isTop = position === parts.length - 1;
      const drawn = Math.max(1, isTop ? raw : raw - 2);
      body += barUp(x + 1, baseline - stack, slot - 2, drawn, part.fill, `${day.date}, ${toolLabel[part.tool] ?? part.tool}: ${compact(part.value)}`, isTop);
      stack += raw;
    });
  });
  const labelled = [0, Math.floor(tokens.daily.length / 2), tokens.daily.length - 1];
  labelled.forEach((index) => {
    const anchor = index === 0 ? 'start' : index === tokens.daily.length - 1 ? 'end' : 'middle';
    const x = axisWidth + index * slot + (index === tokens.daily.length - 1 ? slot : 0);
    body += text(x, baseline + 16, tokens.daily[index].date.slice(5), 'axis', anchor);
  });
  return { height: baseline + 22, body };
}

function historySection(github: GitHubMetrics): Section {
  const grid = github.yearGrid.slice(0, 8);
  const cellWidth = 30;
  const cellHeight = 18;
  const gap = 2;
  const labelWidth = 40;
  const max = Math.max(1, ...grid.flatMap((row) => row.months));

  let body = text(0, 14, 'Every year, by month', 'h1');
  body += text(0, 32, 'Commits, PRs, issues and reviews', 'note');
  const top = 48;
  'JFMAMJJASOND'.split('').forEach((letter, index) => {
    body += text(labelWidth + index * (cellWidth + gap) + cellWidth / 2, top, letter, 'axis', 'middle');
  });
  grid.forEach((row, rowIndex) => {
    const y = top + 8 + rowIndex * (cellHeight + gap);
    body += text(0, y + 13, String(row.year), 'axis');
    row.months.forEach((value, month) => {
      const x = labelWidth + month * (cellWidth + gap);
      body += `<rect x="${x}" y="${y}" width="${cellWidth}" height="${cellHeight}" rx="3" fill="var(--h${heatStep(value, max)})">${title(`${row.year}-${String(month + 1).padStart(2, '0')}: ${commas(value)}`)}</rect>`;
    });
  });
  const gridBottom = top + 8 + grid.length * (cellHeight + gap);

  const { pulse } = github;
  const tiles: [string, string][] = [
    ['Current streak', `${pulse.streak}d`],
    ['Best streak', `${pulse.bestStreak}d`],
    ['Active days, 1 year', commas(pulse.activeDaysYear)],
    ['PRs merged', percent(pulse.mergeRate, 0)],
    ['Median time to merge', hours(pulse.mergeHours)],
    ['Median time to review', hours(pulse.reviewHours)],
  ];
  const tilesX = labelWidth + 12 * (cellWidth + gap) + 44;
  const tileWidth = (INNER - tilesX) / 3;
  tiles.forEach(([label, value], index) => {
    const x = tilesX + (index % 3) * tileWidth;
    const y = Math.floor(index / 3) * 72;
    body += text(x, y + 30, value, 'tile-value');
    body += text(x, y + 50, label, 'note');
  });
  return { height: Math.max(gridBottom, 144), body };
}

/** Stacks sections on one surface, with a rule between each. */
function frame(theme: Theme, heading: string, summary: string, sections: Section[], footer: string | null): string {
  const spacing = 36;
  let y = MARGIN;
  let content = '';
  sections.forEach((section, index) => {
    if (index > 0) {
      content += `<line x1="${MARGIN}" x2="${WIDTH - MARGIN}" y1="${y - spacing / 2}" y2="${y - spacing / 2}" class="grid"/>`;
    }
    content += `<g transform="translate(${MARGIN} ${y})">${section.body}</g>`;
    y += section.height + spacing;
  });
  let height = y - spacing + MARGIN;
  if (footer !== null) {
    height += 18;
    content += text(MARGIN, height - 20, footer, 'axis');
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${n(height)}" width="${WIDTH}" height="${n(height)}" role="img" aria-labelledby="omg-title omg-desc">
<title id="omg-title">${esc(heading)}</title>
<desc id="omg-desc">${esc(summary)}</desc>
<style>${style(theme)}</style>
<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${n(height - 1)}" rx="12" class="surface"/>
${content}
</svg>
`;
}

const contributionsSummary = (github: GitHubMetrics) =>
  `${github.login}: ${commas(github.counts.commits)} commits, ${commas(github.counts.pulls)} pull requests, ${commas(github.counts.reviews)} reviews, ${commas(github.counts.issues)} issues.`;

const tokensSummary = (tokens: TokenMetrics) => `AI token usage: ${compact(tokens.total)} tokens.`;

const listed = (items: string[], empty: string) => (items.length ? `${items.join(', ')}.` : empty);

function profileSummary({ profile }: Metrics): string {
  const role = profile.title && profile.company ? `${profile.title} at ${profile.company}` : (profile.title ?? profile.company);
  const status = profile.status ? [profile.status.emoji, profile.status.label].filter(Boolean).join(' ') : null;
  return [profile.name ? `${profile.name} (@${profile.login})` : `@${profile.login}`, role, profile.location, status, profile.bio]
    .filter(Boolean)
    .join('. ')
    .concat('.');
}

/**
 * Each part of the dashboard can also be embedded on its own, so a profile README can
 * show only some of them, in its own order. Parts are drawn at the dashboard's width,
 * so stacked parts line up and their text stays the same size.
 */
type Component =
  | { label: string; source: 'profile'; draw(metrics: Metrics): Section; summary(metrics: Metrics): string }
  | { label: string; source: 'github'; draw(github: GitHubMetrics, timezone: string): Section; summary(github: GitHubMetrics): string }
  | { label: string; source: 'tokens'; draw(tokens: TokenMetrics): Section; summary(tokens: TokenMetrics): string };

export const COMPONENT_KEYS = ['profile', 'contributions', 'rhythm', 'languages', 'coauthors', 'churn', 'tokens', 'history'] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

const COMPONENTS: Record<ComponentKey, Component> = {
  profile: { label: 'Profile', source: 'profile', draw: profileSection, summary: profileSummary },
  contributions: { label: 'Contributions', source: 'github', draw: (github) => headerSection(github), summary: contributionsSummary },
  rhythm: {
    label: 'Coding rhythm',
    source: 'github',
    draw: rhythmSection,
    summary: ({ rhythm }) => `${commas(rhythm.total)} timestamped events by weekday and hour: ${rhythm.persona}.`,
  },
  languages: {
    label: 'Top languages',
    source: 'github',
    draw: (github) => languagesPanel(github, INNER),
    summary: (github) =>
      `Top languages by lines added: ${listed(
        github.languages.filter((row) => row.lines > 0).slice(0, 5).map((row) => `${row.name} ${percent(row.share, 0)}`),
        'none yet.',
      )}`,
  },
  coauthors: {
    label: 'Co-authors',
    source: 'github',
    draw: (github) => coauthorsPanel(github, INNER),
    summary: ({ coauthors }) =>
      `Top coauthored with: ${listed(coauthors.rows.slice(0, 5).map((row) => `${row.label} (${commas(row.commits)} commits)`), 'nobody yet.')}`,
  },
  churn: {
    label: 'Language churn',
    source: 'github',
    draw: churnSection,
    summary: ({ churn }) => `Lines of code added and removed, by language: +${compact(churn.add)} / -${compact(churn.del)}.`,
  },
  tokens: { label: 'AI token trace', source: 'tokens', draw: tokensSection, summary: tokensSummary },
  history: {
    label: 'Contribution history',
    source: 'github',
    draw: historySection,
    summary: ({ pulse }) => `Contributions by month, every year. Current streak ${pulse.streak} days, best ${pulse.bestStreak} days.`,
  },
};

export const isComponentKey = (key: string): key is ComponentKey => Object.hasOwn(COMPONENTS, key);

/** The parts that have data to draw, in dashboard order. */
export function availableComponents(metrics: Metrics): { key: ComponentKey; label: string }[] {
  return COMPONENT_KEYS.filter((key) => metrics[COMPONENTS[key].source]).map((key) => ({ key, label: COMPONENTS[key].label }));
}

/** One part of the dashboard. Without its data, it says so rather than leaving a broken image. */
export function renderComponent(metrics: Metrics, key: ComponentKey, theme: Theme = DEFAULT_THEME): string {
  const component = COMPONENTS[key];
  const heading = `oh-my-stats: ${component.label}`;
  if (component.source === 'profile') return frame(theme, heading, component.summary(metrics), [component.draw(metrics)], null);
  if (component.source === 'tokens' && metrics.tokens) {
    return frame(theme, heading, component.summary(metrics.tokens), [component.draw(metrics.tokens)], null);
  }
  if (component.source === 'github' && metrics.github) {
    return frame(theme, heading, component.summary(metrics.github), [component.draw(metrics.github, metrics.timezone)], null);
  }
  const message = component.source === 'tokens' ? 'No AI token usage yet.' : 'No GitHub stats yet.';
  return frame(theme, heading, message, [{ height: 36, body: text(0, 14, component.label, 'h1') + text(0, 32, message, 'note') }], null);
}

export function renderDashboard(metrics: Metrics, theme: Theme = DEFAULT_THEME): string {
  const sections: Section[] = [profileSection(metrics)];
  const { github, tokens } = metrics;

  if (github) {
    sections.push(headerSection(github, 'Contributions'), rhythmSection(github, metrics.timezone));
    const panelGap = 48;
    const leftWidth = Math.round((INNER - panelGap) * 0.58);
    const left = languagesPanel(github, leftWidth);
    const right = coauthorsPanel(github, INNER - panelGap - leftWidth);
    sections.push({
      height: Math.max(left.height, right.height),
      body: `${left.body}<g transform="translate(${leftWidth + panelGap} 0)">${right.body}</g>`,
    });
    sections.push(churnSection(github));
  }
  if (tokens) sections.push(tokensSection(tokens));
  if (github) sections.push(historySection(github));

  const summary = `${profileSummary(metrics)} ${github ? contributionsSummary(github) : tokens ? tokensSummary(tokens) : 'No data yet.'}`;
  return frame(theme, 'oh-my-stats developer dashboard', summary, sections, `oh-my-stats · updated ${metrics.generatedDate} · ${metrics.timezone}`);
}
