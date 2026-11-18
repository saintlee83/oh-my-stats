import { commas, compact } from '../format.ts';
import type { Metrics } from '../metrics.ts';
import { lastDays } from '../time.ts';
import { paint, rect, text, textHeight, textWidth, type DotSize, type Drawing } from './pixels.ts';
import { encodePng } from './png.ts';

/**
 * The picture sites show where a link to a public profile is shared: the login, the headline
 * figures and a year of AI usage. Those sites want a PNG and the server has no image library,
 * so the picture is drawn here as rectangles.
 */

export const PREVIEW_WIDTH = 1200;
export const PREVIEW_HEIGHT = 630;

/** The logo's colors on its dark background. A pixel holds its color's place in this list. */
export const PREVIEW_PALETTE = [0x0d1117, 0x21262d, 0x0e4429, 0x006d32, 0x26a641, 0x39d353, 0x58a6ff, 0xe6edf3, 0x8b949e];
const EMPTY = 1;
const GREENS = [2, 3, 4, 5];
const BLUE = 6;
const INK = 7;
const QUIET = 8;

const CALENDAR_WEEKS = 53;

/**
 * Everything the picture shows. It holds totals only, so it has nothing of a machine to give
 * away. The profile's name is left out too: it can be in any script, and the typeface has
 * capitals, digits and a few signs.
 */
export interface PreviewData {
  login: string;
  tokens: {
    /** Lifetime AI tokens. */
    total: number;
    /** Days with usage in a row, ending today or yesterday, since uploads can be a day behind. */
    streak: number;
    /** Days with usage, however long ago. */
    activeDays: number;
  } | null;
  /** The place among public profiles with usage, by lifetime tokens. */
  rank: { place: number; of: number } | null;
  /** Contributions on the GitHub graph this year, the run of days with one that is still going, and active days in the last year. */
  github: { year: number; contributions: number; streak: number; activeDaysYear: number } | null;
  /** Tokens on each day of the calendar, oldest first. The first day is a Monday and the last is today. */
  calendar: number[];
}

const dayBefore = (date: string) => lastDays(date, 2)[0];

/** Picks the picture's few figures out of a profile's metrics and its place in the public rankings. */
export function previewData({ profile, tokens, github, generatedDate }: Metrics, position: { rank: number | null; participants: number } | null): PreviewData {
  const weekday = (new Date(`${generatedDate}T00:00:00Z`).getUTCDay() + 6) % 7;
  const dates = lastDays(generatedDate, (CALENDAR_WEEKS - 1) * 7 + weekday + 1);
  // A machine's clock can run ahead of the profile's timezone. The picture stops at today.
  const dated = tokens?.dated.filter((day) => day.date <= generatedDate) ?? [];
  const used = new Map<string, number>();
  for (let index = dated.length - 1; index >= 0 && dated[index].date >= dates[0]; index--) used.set(dated[index].date, dated[index].total);
  let streak = 0;
  let expected = dated.at(-1)?.date ?? '';
  if (expected >= dayBefore(generatedDate)) {
    for (let index = dated.length - 1; index >= 0 && dated[index].date === expected; index--) {
      streak += 1;
      expected = dayBefore(expected);
    }
  }
  return {
    login: profile.login,
    tokens: tokens && { total: tokens.total, streak, activeDays: tokens.activeDays },
    rank: position?.rank ? { place: position.rank, of: position.participants } : null,
    github: github && {
      year: github.thisYear.year,
      contributions: github.thisYear.calendar,
      streak: github.pulse.streak,
      activeDaysYear: github.pulse.activeDaysYear,
    },
    calendar: dates.map((date) => used.get(date) ?? 0),
  };
}

interface Figure {
  value: string;
  label: string;
}

/** Exact while that stays short, so no figure can outgrow its place. */
const count = (value: number) => (value < 100_000 ? commas(value) : compact(value).toUpperCase());

const plural = (value: number, one: string, many: string) => (value === 1 ? one : many);

/** The large figure, and up to three smaller ones beside it. Without AI usage, contributions lead. */
function figures({ tokens, rank, github }: PreviewData): { lead: Figure | null; others: Figure[] } {
  const contributions = github && { value: count(github.contributions), label: `${plural(github.contributions, 'CONTRIBUTION', 'CONTRIBUTIONS')} IN ${github.year}` };
  const others: Figure[] = [];
  if (!tokens) {
    // These two are about contributions, as the figure they stand beside is.
    if (github && github.streak > 1) others.push({ value: count(github.streak), label: 'DAY STREAK' });
    if (github && github.activeDaysYear > 0) others.push({ value: count(github.activeDaysYear), label: `ACTIVE ${plural(github.activeDaysYear, 'DAY', 'DAYS')} IN A YEAR` });
    return { lead: contributions, others };
  }
  if (rank) others.push({ value: `#${count(rank.place)}`, label: `OF ${count(rank.of)} RANKED ${plural(rank.of, 'PROFILE', 'PROFILES')}` });
  if (contributions) others.push(contributions);
  // One day is not a streak, so a profile at rest shows how many days it has used AI instead.
  if (tokens.streak > 1) others.push({ value: count(tokens.streak), label: 'DAY STREAK OF AI USAGE' });
  else if (tokens.activeDays > 0) others.push({ value: count(tokens.activeDays), label: `${plural(tokens.activeDays, 'DAY', 'DAYS')} WITH AI USAGE` });
  return { lead: { value: compact(tokens.total).toUpperCase(), label: plural(tokens.total, 'AI TOKEN', 'AI TOKENS') }, others };
}

const dots = (dot: number, gap: number): DotSize => ({ dot, gap });

/** The same space above the header as below the calendar, and wider at the sides, where the calendar's 53 weeks set it. */
const MARGIN = 72;
const RIGHT = PREVIEW_WIDTH - MARGIN;
const HEADER_TOP = 54;
const LOGIN_TOP = 132;
const LEAD_TOP = 220;
const CAPTION_TOP = 404;
const CALENDAR = { top: 440, size: 16, gap: 4 };

/** The logo's grid: unlit squares, bars that rise to the right, and the newest square in blue. */
const LOGO = ['...b', '..34', '.234', '1234'];
const LOGO_COLORS: Record<string, number> = { '.': EMPTY, 1: GREENS[0], 2: GREENS[1], 3: GREENS[2], 4: GREENS[3], b: BLUE };
const LOGO_SQUARE = { size: 10, gap: 2 };
const WORDMARK = dots(4, 1);

/** Largest first. The smallest fits the longest login GitHub allows, 39 characters, even in the widest letters. */
const LOGIN_SIZES = [dots(6, 2), dots(5, 2), dots(5, 1), dots(4, 1), dots(3, 1)];
const LEAD_SIZES = [dots(13, 3), dots(11, 3), dots(10, 2), dots(8, 2), dots(6, 2), dots(5, 1), dots(4, 1)];
/** Room for five characters at the largest size, such as 24.5B, which leaves the right half to the smaller figures. */
const LEAD_WIDTH = 448;
const VALUE_SIZES = [dots(4, 1), dots(3, 1)];
/**
 * Labels are drawn with their squares touching. With gaps between them, squares this small
 * fade into the background once the picture is shown smaller than it is drawn, as a link
 * preview usually is.
 */
const LEAD_LABEL = dots(4, 0);
const NOTE = dots(3, 0);
const LEAD_LABEL_GAP = 15;
const FIGURE_GAP = 25;
const LABEL_GAP = 16;
/** The least room between the large figure and the smaller ones. */
const COLUMN_GAP = 48;
const LEGEND = { size: 15, gap: 4, space: 10 };

/** One line of the picture's text, and the room it takes. */
export interface PreviewLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Page {
  drawing: Drawing;
  lines: PreviewLine[];
}

/** Returns the x where a next character would start, for a line that changes color part way. */
function write(page: Page, x: number, y: number, content: string, size: DotSize, color: number): number {
  page.lines.push({ text: content, x, y, width: textWidth(content, size), height: textHeight(size) });
  return text(page.drawing, x, y, content, size, color);
}

const fit = (content: string, width: number, sizes: DotSize[]) => sizes.find((size) => textWidth(content, size) <= width) ?? sizes[sizes.length - 1];

function header(page: Page): void {
  const pitch = LOGO_SQUARE.size + LOGO_SQUARE.gap;
  const side = LOGO.length * pitch - LOGO_SQUARE.gap;
  LOGO.forEach((row, y) => {
    Array.from(row, (square, x) => rect(page.drawing, MARGIN + x * pitch, HEADER_TOP + y * pitch, LOGO_SQUARE.size, LOGO_SQUARE.size, LOGO_COLORS[square]));
  });
  write(page, MARGIN + side + 18, HEADER_TOP + Math.floor((side - textHeight(WORDMARK)) / 2), 'OH-MY-STATS', WORDMARK, INK);
}

/** A long login gets smaller squares, so it is always written whole. */
function login(page: Page, name: string): void {
  const size = fit(`@${name}`, RIGHT - MARGIN, LOGIN_SIZES);
  const top = LOGIN_TOP + Math.floor((textHeight(LOGIN_SIZES[0]) - textHeight(size)) / 2);
  write(page, write(page, MARGIN, top, '@', size, GREENS[3]), top, name, size, INK);
}

/** Returns where the large figure and its label end, so the smaller figures can keep clear. */
function leadFigure(page: Page, lead: Figure | null): number {
  const bottom = LEAD_TOP + textHeight(LEAD_SIZES[0]);
  if (!lead) {
    write(page, MARGIN, bottom - textHeight(LOGIN_SIZES[0]), 'NO STATS YET', LOGIN_SIZES[0], QUIET);
    return MARGIN;
  }
  const size = fit(lead.value, LEAD_WIDTH, LEAD_SIZES);
  write(page, MARGIN, bottom - textHeight(size), lead.value, size, INK);
  write(page, MARGIN, bottom + LEAD_LABEL_GAP, lead.label, LEAD_LABEL, QUIET);
  return MARGIN + Math.max(textWidth(lead.value, size), textWidth(lead.label, LEAD_LABEL));
}

/** A column at the right margin: each value ends where its label begins, and the two sit on one line. */
function otherFigures(page: Page, others: Figure[], leadRight: number): void {
  if (!others.length) return;
  const labelLeft = RIGHT - Math.max(...others.map((figure) => textWidth(figure.label, NOTE)));
  const widest = (size: DotSize) => Math.max(...others.map((figure) => textWidth(figure.value, size)));
  const room = labelLeft - LABEL_GAP - COLUMN_GAP - leadRight;
  const size = VALUE_SIZES.find((candidate) => widest(candidate) <= room) ?? VALUE_SIZES[VALUE_SIZES.length - 1];
  const row = textHeight(VALUE_SIZES[0]);
  const leadHeight = textHeight(LEAD_SIZES[0]) + LEAD_LABEL_GAP + textHeight(LEAD_LABEL);
  const top = LEAD_TOP + Math.floor((leadHeight - others.length * row - (others.length - 1) * FIGURE_GAP) / 2);
  others.forEach((figure, index) => {
    const bottom = top + index * (row + FIGURE_GAP) + row;
    write(page, labelLeft - LABEL_GAP - textWidth(figure.value, size), bottom - textHeight(size), figure.value, size, INK);
    write(page, labelLeft, bottom - textHeight(NOTE), figure.label, NOTE, QUIET);
  });
}

/** Where a day of the calendar is drawn, by its place in `PreviewData.calendar`. Weeks run left to right, Monday on top. */
export function calendarSquare(day: number): { x: number; y: number; size: number } {
  const pitch = CALENDAR.size + CALENDAR.gap;
  return { x: MARGIN + Math.floor(day / 7) * pitch, y: CALENDAR.top + (day % 7) * pitch, size: CALENDAR.size };
}

/** Skewed usage reads better on a square-root scale, as on the dashboard: quiet days stay visible. */
function heatStep(value: number, most: number): number {
  if (value <= 0 || most <= 0) return 0;
  return Math.max(1, Math.ceil(Math.sqrt(value / most) * GREENS.length));
}

function calendar(page: Page, days: number[]): void {
  write(page, MARGIN, CAPTION_TOP, `LAST ${CALENDAR_WEEKS} WEEKS OF AI USAGE`, NOTE, QUIET);
  const most = Math.max(0, ...days);
  if (most > 0) {
    const steps = [EMPTY, ...GREENS];
    const pitch = LEGEND.size + LEGEND.gap;
    const more = RIGHT - textWidth('MORE', NOTE);
    const first = more - LEGEND.space - steps.length * pitch + LEGEND.gap;
    write(page, more, CAPTION_TOP, 'MORE', NOTE, QUIET);
    steps.forEach((color, index) => rect(page.drawing, first + index * pitch, CAPTION_TOP + Math.floor((textHeight(NOTE) - LEGEND.size) / 2), LEGEND.size, LEGEND.size, color));
    write(page, first - LEGEND.space - textWidth('LESS', NOTE), CAPTION_TOP, 'LESS', NOTE, QUIET);
  } else {
    write(page, RIGHT - textWidth('NONE YET', NOTE), CAPTION_TOP, 'NONE YET', NOTE, QUIET);
  }
  // The newest day with usage is lit in blue, the way the logo lights its newest square.
  const newest = days.findLastIndex((value) => value > 0);
  days.forEach((value, day) => {
    const { x, y, size } = calendarSquare(day);
    const step = heatStep(value, most);
    rect(page.drawing, x, y, size, size, day === newest ? BLUE : step ? GREENS[step - 1] : EMPTY);
  });
}

/** The picture as rectangles, with its lines of text listed, so a test can read what is written and where. */
export function previewDrawing(data: PreviewData): Page {
  const page: Page = { drawing: [], lines: [] };
  const { lead, others } = figures(data);
  header(page);
  login(page, data.login.toUpperCase());
  otherFigures(page, others, leadFigure(page, lead));
  calendar(page, data.calendar);
  return page;
}

export function renderPreview(data: PreviewData): Promise<Uint8Array<ArrayBuffer>> {
  const { drawing } = previewDrawing(data);
  return encodePng({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, palette: PREVIEW_PALETTE, rows: paint(drawing, PREVIEW_WIDTH, PREVIEW_HEIGHT) });
}
