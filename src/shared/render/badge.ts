import type { GitHubMetrics, TokenMetrics } from '../metrics.ts';
import { commas, compact } from '../format.ts';
import { dayCount, esc, listPrice } from './svg.ts';

/**
 * A small flat badge for a README line, the size and shape shields.io made common: a gray
 * label on the left and a colored value on the right. Its colors are fixed, because a badge
 * is a filled box that reads the same on a light page and a dark one.
 */

export const BADGE_METRICS = ['tokens', 'cost', 'rank', 'contributions', 'streak'] as const;
export type BadgeMetric = (typeof BADGE_METRICS)[number];
export const DEFAULT_BADGE_METRIC: BadgeMetric = 'tokens';

/** Reads a metric from an address. Without one it is the default, and one that doesn't exist is null. */
export function badgeMetricNamed(value: string | null): BadgeMetric | null {
  const wanted = (value ?? '').trim().toLowerCase();
  if (!wanted) return DEFAULT_BADGE_METRIC;
  return BADGE_METRICS.find((metric) => metric === wanted) ?? null;
}

/** What a badge is drawn from. The rank badge needs only the position, the others only the metrics. */
export interface BadgeFacts {
  tokens: TokenMetrics | null;
  github: GitHubMetrics | null;
  /** Where the profile stands on the lifetime public board. */
  position: { rank: number | null; participants: number } | null;
}

export interface Badge {
  label: string;
  value: string;
  /** False when the value only says that there is no figure yet. */
  known: boolean;
}

const LABELS: Record<BadgeMetric, string> = {
  tokens: 'AI tokens',
  cost: 'API list price',
  rank: 'oh-my-stats rank',
  contributions: 'contributions',
  streak: 'streak',
};

function badgeValue(metric: BadgeMetric, { tokens, github, position }: BadgeFacts): string | null {
  if (metric === 'tokens') return tokens ? compact(tokens.total) : null;
  if (metric === 'cost') {
    const price = tokens ? listPrice(tokens) : 'n/a';
    return price === 'n/a' ? null : price;
  }
  if (metric === 'rank') return position?.rank ? `#${commas(position.rank)} of ${commas(position.participants)}` : null;
  if (metric === 'contributions') return github ? commas(github.counts.calendar) : null;
  return github ? dayCount(github.pulse.streak) : null;
}

export function badgeFor(metric: BadgeMetric, facts: BadgeFacts): Badge {
  const value = badgeValue(metric, facts);
  return { label: LABELS[metric], value: value ?? (metric === 'rank' ? 'unranked' : 'n/a'), known: value !== null };
}

/** White text on each of these clears 4.5:1. */
export const BADGE_COLORS = { label: '#555555', value: '#0969da', unknown: '#6e7781', text: '#ffffff' };

/**
 * Verdana's advance widths in thousandths of the font size, the font a badge asks for first.
 * A character that isn't listed counts as a full em, so the estimate errs wide.
 */
const VERDANA: [width: number, characters: string][] = [
  [274, 'il'], [344, 'j'], [352, ' f'], [364, '.,'], [394, 't'], [421, 'I'], [427, 'r'], [454, '-/:'], [455, 'J'],
  [521, 'cs'], [525, 'z'], [557, 'L'], [575, 'F'], [592, 'kvxy'], [596, 'e'], [601, 'a'], [603, 'P'], [607, 'o'],
  [615, 'Y'], [616, 'T'], [623, 'bdgpq'], [632, 'E'], [633, 'hnu'], [636, '0123456789$'], [684, 'ASV'], [685, 'XZ'],
  [686, 'B'], [693, 'K'], [695, 'R'], [698, 'C'], [732, 'U'], [748, 'N'], [751, 'H'], [771, 'D'], [775, 'G'],
  [787, 'OQ'], [818, 'w#≥≈'], [843, 'M'], [973, 'm'], [989, 'W'],
];
const WIDTHS = new Map(VERDANA.flatMap(([width, characters]) => Array.from(characters, (char): [string, number] => [char, width])));
const FONT_SIZE = 11;

const verdanaWidth = (content: string) =>
  Math.ceil(Array.from(content).reduce((sum, char) => sum + (WIDTHS.get(char) ?? 1000), 0) * FONT_SIZE / 1000);

const HEIGHT = 20;
const PADDING = 6;
const RADIUS = 3;

/**
 * Each text is given the length it was measured at, so a system without Verdana squeezes or
 * spreads its own font to that length, and the words can't run past their box.
 */
function words(content: string, center: number, length: number): string {
  const at = `x="${center}" textLength="${length}"`;
  return `<text ${at} y="15" fill="#010101" fill-opacity=".3" aria-hidden="true">${esc(content)}</text><text ${at} y="14">${esc(content)}</text>`;
}

export function renderBadge({ label, value, known }: Badge): string {
  const [labelLength, valueLength] = [verdanaWidth(label), verdanaWidth(value)];
  const split = labelLength + PADDING * 2;
  const width = split + valueLength + PADDING * 2;
  const name = esc(`${label}: ${value}`);
  const corner = (dx: number, dy: number) => `a${RADIUS} ${RADIUS} 0 0 1 ${dx} ${dy}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${HEIGHT}" width="${width}" height="${HEIGHT}" role="img" aria-label="${name}">
<title>${name}</title>
<path d="M${split} 0v${HEIGHT}H${RADIUS}${corner(-RADIUS, -RADIUS)}V${RADIUS}${corner(RADIUS, -RADIUS)}z" fill="${BADGE_COLORS.label}"/>
<path d="M${split} 0H${width - RADIUS}${corner(RADIUS, RADIUS)}V${HEIGHT - RADIUS}${corner(-RADIUS, RADIUS)}H${split}z" fill="${known ? BADGE_COLORS.value : BADGE_COLORS.unknown}"/>
<g fill="${BADGE_COLORS.text}" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="${FONT_SIZE}" text-anchor="middle" text-rendering="geometricPrecision">${words(label, split / 2, labelLength)}${words(value, split + (width - split) / 2, valueLength)}</g>
</svg>
`;
}
