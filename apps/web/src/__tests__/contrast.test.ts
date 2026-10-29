import { describe, expect, it } from 'vitest';
import { contrastPairs } from '../lib/colorTokens';
import { contrastRatio } from '../lib/contrast';

describe('WCAG contrast for design tokens', () => {
  it.each(contrastPairs)('$label meets ratio ≥ $minRatio', ({ foreground, background, minRatio }) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(minRatio);
  });
});
