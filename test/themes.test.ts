import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THEMES, themeNamed } from '../src/shared/render/svg.ts';

/** WCAG 2 contrast ratio between two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test('every theme keeps text readable and the quietest heatmap step visible', () => {
  for (const [name, modes] of Object.entries(THEMES)) {
    for (const [mode, palette] of Object.entries(modes)) {
      for (const token of ['ink', 'ink2', 'muted'] as const) {
        const ratio = contrast(palette[token], palette.surface);
        assert.ok(ratio >= 4.5, `${name} ${mode} ${token} is ${ratio.toFixed(2)}:1`);
      }
      const quiet = contrast(palette.h1, palette.surface);
      assert.ok(quiet >= 2, `${name} ${mode} h1 is ${quiet.toFixed(2)}:1`);
    }
  }
});

const channels = (hex: string) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));

test('each theme’s heat scale runs one way, so more usage always reads as more', () => {
  for (const [name, modes] of Object.entries(THEMES)) {
    for (const [mode, palette] of Object.entries(modes)) {
      const steps = ([1, 2, 3, 4, 5] as const).map((step) => contrast(palette[`h${step}`], palette.surface));
      for (const [index, ratio] of steps.entries()) {
        if (index) assert.ok(ratio > steps[index - 1] * 1.15, `${name} ${mode} h${index + 1} stands out more than h${index}: ${steps.map((step) => step.toFixed(2)).join(', ')}`);
      }
      assert.ok(contrast(palette.accent, palette.surface) >= 3, `${name} ${mode} accent is ${contrast(palette.accent, palette.surface).toFixed(2)}:1`);
      // What stands in for other providers is a gray, so it can't be taken for one of the four series.
      const [r, g, b] = channels(palette['ramp-low']);
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 48, `${name} ${mode} ramp-low is a gray`);
    }
  }
});

test('the GitHub theme draws usage in green, as GitHub’s contribution graph does, and Tokyo Night keeps its blue', () => {
  const leads = (hex: string) => {
    const [r, g, b] = channels(hex);
    return g > r && g > b ? 'green' : b > r && b > g ? 'blue' : 'other';
  };
  for (const palette of Object.values(THEMES.github)) {
    for (const token of ['accent', 'add', 'h1', 'h2', 'h3', 'h4', 'h5'] as const) assert.equal(leads(palette[token]), 'green', `${token} ${palette[token]}`);
    const [r, g, b] = channels(palette.del);
    assert.ok(r > g * 2 && r > b * 2, `removed lines are red: ${palette.del}`);
  }
  for (const palette of Object.values(THEMES['tokyo-night'])) {
    for (const token of ['accent', 'add', 'h1', 'h3', 'h5'] as const) assert.equal(leads(palette[token]), 'blue', `${token} ${palette[token]}`);
  }
});

test('theme names are read loosely, and anything unknown is the default', () => {
  for (const name of ['tokyo-night', 'tokyonight', 'Tokyo Night', 'TOKYO_NIGHT']) assert.equal(themeNamed(name), 'tokyo-night', name);
  for (const name of [null, '', 'github', 'GitHub', 'dracula', '__proto__', 'constructor']) assert.equal(themeNamed(name), 'github', String(name));
});
