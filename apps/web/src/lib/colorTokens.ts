/**
 * Design tokens referenced by CSS (index.css) and contrast tests.
 * Pairs to meet WCAG AA: normal text ≥ 4.5:1, large/UI ≥ 3:1.
 */
export const colors = {
  bg: '#0c0f14',
  surface: '#141a24',
  surface2: '#1c2433',
  text: '#e8edf5',
  /** Muted on surface — ≥4.5:1 */
  muted: '#9aa8c0',
  /** Primary button background — white label ≥4.5:1 */
  accent: '#3d6fd9',
  accentDim: '#2f5aa8',
  /** Accent-colored text on dark surfaces — ≥4.5:1 */
  accentText: '#7aa2ff',
  /** Focus ring on bg / surfaces — ≥3:1 */
  focus: '#7aa2ff',
  success: '#2db872',
  danger: '#e85c66',
  warn: '#d4a017',
  /** Badge warn border text on surface */
  badgeWarn: '#e0b84a',
  btnPrimaryText: '#ffffff',
  btnSuccessText: '#041a10',
  btnDangerText: '#1a080a',
} as const;

/** CSS custom properties that must match `colors` hex values in index.css */
export const cssSyncedTokens: { cssVar: string; colorKey: keyof typeof colors }[] = [
  { cssVar: '--bg', colorKey: 'bg' },
  { cssVar: '--surface', colorKey: 'surface' },
  { cssVar: '--surface-2', colorKey: 'surface2' },
  { cssVar: '--text', colorKey: 'text' },
  { cssVar: '--muted', colorKey: 'muted' },
  { cssVar: '--accent', colorKey: 'accent' },
  { cssVar: '--accent-dim', colorKey: 'accentDim' },
  { cssVar: '--accent-text', colorKey: 'accentText' },
  { cssVar: '--focus', colorKey: 'focus' },
  { cssVar: '--success', colorKey: 'success' },
  { cssVar: '--danger', colorKey: 'danger' },
  { cssVar: '--warn', colorKey: 'warn' },
  { cssVar: '--badge-warn', colorKey: 'badgeWarn' },
];

export type ColorPair = { foreground: string; background: string; label: string; minRatio: number };

/** Key pairs asserted in contrast.test.ts */
export const contrastPairs: ColorPair[] = [
  { foreground: colors.text, background: colors.surface, label: 'body on surface', minRatio: 4.5 },
  { foreground: colors.muted, background: colors.surface, label: 'muted on surface', minRatio: 4.5 },
  { foreground: colors.btnPrimaryText, background: colors.accent, label: 'primary button', minRatio: 4.5 },
  { foreground: colors.success, background: colors.surface2, label: 'success on card', minRatio: 4.5 },
  { foreground: colors.danger, background: colors.surface, label: 'danger on surface', minRatio: 4.5 },
  { foreground: colors.badgeWarn, background: colors.surface, label: 'warn badge', minRatio: 4.5 },
  { foreground: colors.warn, background: colors.surface2, label: 'warn on card', minRatio: 4.5 },
  { foreground: colors.btnSuccessText, background: colors.success, label: 'success button', minRatio: 4.5 },
  { foreground: colors.accentText, background: colors.surface, label: 'accent text on surface', minRatio: 4.5 },
  { foreground: colors.accentText, background: colors.surface2, label: 'accent text on surface-2', minRatio: 4.5 },
  { foreground: colors.focus, background: colors.bg, label: 'focus ring on bg', minRatio: 3 },
  { foreground: colors.focus, background: colors.surface, label: 'focus ring on surface', minRatio: 3 },
  { foreground: colors.focus, background: colors.surface2, label: 'focus ring on surface-2', minRatio: 3 },
];
