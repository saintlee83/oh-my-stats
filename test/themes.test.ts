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

test('theme names are read loosely, and anything unknown is the default', () => {
  for (const name of ['tokyo-night', 'tokyonight', 'Tokyo Night', 'TOKYO_NIGHT']) assert.equal(themeNamed(name), 'tokyo-night', name);
  for (const name of [null, '', 'github', 'GitHub', 'dracula', '__proto__', 'constructor']) assert.equal(themeNamed(name), 'github', String(name));
});
