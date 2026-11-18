import type { Metrics, ProfileMetrics } from '../metrics.ts';
import { commas, compact, providerName } from '../format.ts';
import { lastDays } from '../time.ts';
import { BOLD, calendar, dayCount, DEFAULT_THEME, esc, fit, fitted, heatLegend, held, surface, text, textWidth, type Theme } from './svg.ts';

/**
 * A card 495 wide, the size github-readme-stats made common, for a README where the
 * dashboard's parts are too wide. It leads with one figure and lists a few more beside it,
 * from whatever the profile has: AI tokens, GitHub stats, or both.
 */

const WIDTH = 495;
const MARGIN = 24;
const INNER = WIDTH - MARGIN * 2;
const FACTS_X = 208;
const GRAPH_WEEKS = 26;

const RULES = `
  .at { font-size: 13px; font-weight: 400; fill: var(--muted); }
  .big { font-size: 40px; font-weight: 600; }
  .fact { font-size: 13px; font-weight: 600; }
`;

/** Where a profile stands on the lifetime public board. */
export interface CardPosition {
  rank: number | null;
  participants: number;
}

interface Contents {
  figure: string;
  caption: string;
  facts: [label: string, value: string][];
}

/** The figure the card leads with and the lines beside it. Tokens lead when there are any. */
function contentsOf({ tokens, github }: Metrics, position: CardPosition | null): Contents | null {
  if (tokens) {
    const facts: Contents['facts'] = position?.rank ? [['Rank', `#${commas(position.rank)} of ${commas(position.participants)}`]] : [];
    if (github) facts.push([`Contributions in ${github.thisYear.year}`, commas(github.thisYear.calendar)], ['Current streak', dayCount(github.pulse.streak)]);
    else facts.push(['Active days', commas(tokens.activeDays)]);
    facts.push(['Most used', providerName(tokens.tools[0].tool)]);
    return { figure: compact(tokens.total), caption: 'lifetime AI tokens', facts };
  }
  if (!github) return null;
  return {
    figure: commas(github.thisYear.calendar),
    caption: `contributions in ${github.thisYear.year}`,
    facts: [['Lifetime contributions', commas(github.counts.calendar)], ['Current streak', dayCount(github.pulse.streak)], ['Best streak', dayCount(github.pulse.bestStreak)]],
  };
}

/**
 * The name with the login after it, or the login alone, cut to fit. A login can be 39
 * characters, which nearly fills the card. No system font is known to run more than 45%
 * wider than the estimate, so a line that long is held to its measured length, and a
 * shorter one can't leave the card anyway.
 */
function who(profile: ProfileMetrics): string {
  const handle = fit(`@${profile.login}`, profile.name ? INNER - 120 : INNER, profile.name ? 13 : 15 * BOLD);
  const name = profile.name ? fit(profile.name, INNER - textWidth(handle, 13) - 8, 15 * BOLD) : '';
  const width = name ? textWidth(name, 15 * BOLD) + 8 + textWidth(handle, 13) : textWidth(handle, 15 * BOLD);
  const length = width * 1.45 > INNER ? held(Math.min(width, INNER)) : '';
  const line = name ? `${esc(name)}<tspan class="at" dx="8">${esc(handle)}</tspan>` : esc(handle);
  return `<text x="0" y="14" class="h1"${length}>${line}</text>`;
}

/** The last 26 weeks of AI usage, ending with the current week. */
function graph(metrics: Metrics, y: number): { height: number; body: string } {
  const today = metrics.generatedDate;
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const [first] = lastDays(today, (GRAPH_WEEKS - 1) * 7 + weekday + 1);
  const grid = calendar(metrics.tokens?.dated ?? [], first, today, today, INNER);
  let body = `<line x1="0" x2="${INNER}" y1="${y}" y2="${y}" class="grid"/>`;
  body += text(0, y + 24, `AI tokens per day, last ${GRAPH_WEEKS} weeks`, 'note') + heatLegend(INNER, y + 24);
  body += `<g transform="translate(0 ${y + 36})">${grid.body}</g>`;
  return { height: 36 + grid.height, body };
}

export function renderSmallCard(metrics: Metrics, position: CardPosition | null, theme: Theme = DEFAULT_THEME, withGraph = false): string {
  const { profile } = metrics;
  const named = profile.name ? `${profile.name} (@${profile.login})` : `@${profile.login}`;
  const heading = `oh-my-stats: ${named}`;
  const contents = contentsOf(metrics, position);
  let body = who(profile);
  if (!contents) {
    body += text(0, 38, 'No stats yet.', 'note');
    return surface(theme, heading, 'No stats yet.', WIDTH, MARGIN * 2 + 42, `<g transform="translate(${MARGIN} ${MARGIN})">${body}</g>`, RULES);
  }

  const { figure, caption, facts } = contents;
  body += text(0, 78, fit(figure, FACTS_X - 16, 40 * BOLD), 'big') + text(0, 98, caption, 'note');
  // The lines sit level with the figure, however many there are.
  const firstLine = 74 - (facts.length - 1) * 11;
  facts.forEach(([label, value], index) => {
    const y = firstLine + index * 22;
    body += text(FACTS_X, y, label, 'label');
    body += fitted(INNER, y, value, INNER - FACTS_X - textWidth(label, 13) - 12, 13 * BOLD, 'fact', 'end');
  });
  let height = Math.max(104, firstLine + (facts.length - 1) * 22 + 8);
  if (withGraph && metrics.tokens) {
    const drawn = graph(metrics, height + 12);
    body += drawn.body;
    height += 12 + drawn.height;
  }
  const summary = `${figure} ${caption}. ${facts.map(([label, value]) => `${label}: ${value}`).join('. ')}.`;
  return surface(theme, heading, summary, WIDTH, MARGIN * 2 + height, `<g transform="translate(${MARGIN} ${MARGIN})">${body}</g>`, RULES);
}
