import { providerName } from './format.ts';
import type { TokenMetrics } from './metrics.ts';

/**
 * Which color a provider or a model wears on the website, wherever a chart tells them apart.
 * There are eight series colors, `--s1` to `--s8` in the stylesheet, in an order checked for
 * color-vision safety. A color belongs to a name and not to its rank, so it is the same in
 * every chart and every period of a page. Names past the eighth are drawn together, in gray.
 */
export const SERIES_COLORS = 8;

export interface Series {
  /** A provider's ID, or a model's name. */
  key: string;
  label: string;
  /** 1 to 8, or 0 for a name drawn with the others. */
  slot: number;
}

/**
 * The three most used tools keep one color on every profile, so a reader learns them once:
 * blue, orange and aqua, the palette's first three, which stay apart for every kind of color
 * vision. A map, because a provider's ID is whatever an upload says.
 */
const PROVIDER_SLOTS = new Map([['gemini', 1], ['claude', 2], ['codex', 3]]);

/** Providers, most used first. Those without a color of their own take the free ones in that order. */
export function providerSeries(tools: string[]): Series[] {
  const promised = new Set(PROVIDER_SLOTS.values());
  const all = Array.from({ length: SERIES_COLORS }, (_, index) => index + 1);
  const unused = [...PROVIDER_SLOTS].filter(([tool]) => !tools.includes(tool)).map(([, slot]) => slot);
  // A color promised to a tool this profile doesn't use is given out last.
  const free = [...all.filter((slot) => !promised.has(slot)), ...unused];
  return tools.map((tool) => ({ key: tool, label: providerName(tool), slot: PROVIDER_SLOTS.get(tool) ?? free.shift() ?? 0 }));
}

/** Models, most used first: the first eight get the colors in order. */
export function modelSeries(models: string[]): Series[] {
  return models.map((model, index) => ({ key: model, label: model, slot: index < SERIES_COLORS ? index + 1 : 0 }));
}

/** A model reached through two tools is one model. Most used first, by lifetime tokens. */
export function modelTotals(tokens: TokenMetrics): [model: string, total: number][] {
  const totals = new Map<string, number>();
  for (const { model, total } of tokens.models) totals.set(model, (totals.get(model) ?? 0) + total);
  return [...totals].filter(([, total]) => total > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The colors of a profile's providers and models, by lifetime use, so they hold whatever period is shown. */
export function seriesOf(tokens: TokenMetrics): { providers: Series[]; models: Series[] } {
  return {
    providers: providerSeries(tokens.tools.map(({ tool }) => tool)),
    models: modelSeries(modelTotals(tokens).map(([model]) => model)),
  };
}
