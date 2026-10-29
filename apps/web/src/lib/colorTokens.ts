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
  success: '#2db872',
  danger: '#e85c66',
  warn: '#d4a017',
  /** Badge warn border text on surface */
  badgeWarn: '#e0b84a',
  btnPrimaryText: '#ffffff',
  btnSuccessText: '#041a10',
  btnDangerText: '#1a080a',
} as const;

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
];
