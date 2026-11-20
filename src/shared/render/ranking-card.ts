import { commas, compact } from '../format.ts';
import type { CardPosition } from './small-card.ts';
import { BOLD, fitted, surface, text, type Theme } from './svg.ts';

const WIDTH = 495;
const MARGIN = 24;
const RIGHT = WIDTH - MARGIN;
const STYLES = `
  .place { font-size: 40px; font-weight: 650; }
  .count { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
`;

export function renderRankingCard(login: string, position: CardPosition, lifetime: number, days: { date: string; tokens: number }[], theme: Theme): string {
  const rank = position.rank === null ? 'Unranked' : `#${commas(position.rank)}`;
  const field = `${commas(position.participants)} ranked public ${position.participants === 1 ? 'profile' : 'profiles'}`;
  let body = text(MARGIN, 33, 'Token ranking', 'h1') + fitted(RIGHT, 33, `@${login}`, 292, 13, 'label', 'end');
  body += text(MARGIN, 103, rank, position.rank === null || rank.length > 7 ? 'name' : 'place');
  body += fitted(MARGIN, 125, position.rank === null ? 'No ranked usage yet' : `of ${field}`, 193, 12, 'note');

  const chartX = 230;
  const baseline = 113;
  const step = (RIGHT - chartX) / days.length;
  const peak = Math.max(1, ...days.map(day => day.tokens));
  body += text(chartX, 59, 'Daily tokens · UTC', 'note');
  body += `<rect x="${RIGHT - 74}" y="51" width="8" height="8" rx="2" fill="var(--c1)"/>` + text(RIGHT - 61, 59, 'Last 7 days', 'note');
  body += `<line x1="${chartX}" x2="${RIGHT}" y1="${baseline}" y2="${baseline}" class="grid"/>`;
  days.forEach(({ date, tokens }, i) => {
    if (!tokens) return;
    const height = Math.max(1, 43 * tokens / peak);
    const color = i >= days.length - 7 ? 'c1' : 'ramp-low';
    body += `<rect x="${(chartX + i * step + 1).toFixed(1)}" y="${(baseline - height).toFixed(1)}" width="${(step - 2).toFixed(1)}" height="${height.toFixed(1)}" rx="1.5" fill="var(--${color})"><title>${date} · ${commas(tokens)} tokens</title></rect>`;
  });
  body += text(chartX, 130, days[0].date.slice(5), 'axis') + text(RIGHT, 130, days[days.length - 1].date.slice(5), 'axis', 'end');
  body += `<line x1="${MARGIN}" x2="${RIGHT}" y1="147" y2="147" class="grid"/>`;
  const total = (rows: typeof days) => rows.reduce((sum, day) => sum + day.tokens, 0);
  const month = total(days);
  const week = total(days.slice(-7));
  if (!month) body += text(chartX, 93, 'No usage in the last 30 days', 'note');
  const usage: [string, number][] = [['Lifetime tokens', lifetime], ['Last 30 days', month], ['Last 7 days', week]];
  const hasAbbreviation = usage.some(([, count]) => compact(count) !== commas(count));
  usage.forEach(([label, count], i) => {
    const x = MARGIN + i * 153;
    body += text(x, 170, label, 'note') + fitted(x, 197, compact(count), 136, 22 * BOLD, 'count');
    if (compact(count) !== commas(count)) body += fitted(x, 214, commas(count), 136, 11, 'axis');
  });
  const summary = `Lifetime public rank ${rank} among ${field}. ${commas(lifetime)} lifetime tokens, ${commas(month)} in the last 30 days and ${commas(week)} in the last 7 days.`;
  return surface(theme, `Token ranking for @${login}`, summary, WIDTH, hasAbbreviation ? 234 : 219, body, STYLES);
}
