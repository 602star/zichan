import { describe, expect, it } from 'vitest';
import { DARK_THEMES, THEMES } from '../src/theme.js';

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('theme text contrast', () => {
  it('keeps supporting and semantic text readable on every content surface', () => {
    for (const [mode, families] of [['light', THEMES], ['dark', DARK_THEMES]] as const) {
      for (const [name, tokens] of Object.entries(families)) {
        for (const foreground of ['--fg-subtle', '--positive', '--negative', '--warning', '--accent']) {
          for (const background of ['--bg', '--surface', '--surface-2']) {
            const ratio = contrast(tokens[foreground], tokens[background]);
            expect(ratio, `${mode} ${name} ${foreground} on ${background}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
          }
        }
        const buttonRatio = contrast(tokens['--on-accent'], tokens['--accent']);
        expect(buttonRatio, `${mode} ${name} primary button: ${buttonRatio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
