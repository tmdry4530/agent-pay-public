/**
 * Design tokens referenced by CSS (index.css) and contrast tests.
 * Pairs to meet WCAG AA: normal text ≥ 4.5:1, large/UI ≥ 3:1.
 */
export const colors = {
  /** Steel-mist page background. */
  bg: '#e3e8ee',
  /** Near-white document surface. */
  surface: '#fafbfc',
  surface2: '#eef1f5',
  /** Ink text. */
  text: '#0f1b2d',
  /** Muted on surface and surface-2, ≥4.5:1 */
  muted: '#475a6e',
  /** Hairline rules (decorative) and the stronger control outline (≥3:1 vs surface, WCAG 1.4.11). */
  border: '#bac4d0',
  borderStrong: '#66768a',
  /** Ultramarine ink: primary button background, white label ≥4.5:1 */
  accent: '#2438c4',
  accentDim: '#1a2a9c',
  /** Accent-colored text on light surfaces — ≥4.5:1 */
  accentText: '#2438c4',
  accentWash: '#e8ecff',
  /** Focus ring on bg / surfaces — ≥3:1 */
  focus: '#2438c4',
  success: '#0b6e42',
  danger: '#b42318',
  warn: '#8a5200',
  /** Badge warn text on surface */
  badgeWarn: '#7a4900',
  /** Hold (amber) fill; ink text on it. */
  hold: '#f5b93b',
  btnPrimaryText: '#ffffff',
  btnSuccessText: '#ffffff',
  btnDangerText: '#ffffff',
  /** Guard instrument (dark spend gauge) */
  guard: '#141f6b',
  guardTrack: '#0b1347',
  gText: '#f4f6ff',
  gMuted: '#b9c3f0',
  gLine: '#5667cf',
  gFill: '#dde3ff',
  gPass: '#8fe3b8',
  gHold: '#ffc857',
  gStop: '#ff9b91',
} as const;

/** CSS custom properties that must match `colors` hex values in index.css */
export const cssSyncedTokens: { cssVar: string; colorKey: keyof typeof colors }[] = [
  { cssVar: '--bg', colorKey: 'bg' },
  { cssVar: '--surface', colorKey: 'surface' },
  { cssVar: '--surface-2', colorKey: 'surface2' },
  { cssVar: '--border', colorKey: 'border' },
  { cssVar: '--border-strong', colorKey: 'borderStrong' },
  { cssVar: '--text', colorKey: 'text' },
  { cssVar: '--muted', colorKey: 'muted' },
  { cssVar: '--accent', colorKey: 'accent' },
  { cssVar: '--accent-dim', colorKey: 'accentDim' },
  { cssVar: '--accent-text', colorKey: 'accentText' },
  { cssVar: '--accent-wash', colorKey: 'accentWash' },
  { cssVar: '--focus', colorKey: 'focus' },
  { cssVar: '--success', colorKey: 'success' },
  { cssVar: '--danger', colorKey: 'danger' },
  { cssVar: '--warn', colorKey: 'warn' },
  { cssVar: '--badge-warn', colorKey: 'badgeWarn' },
  { cssVar: '--hold', colorKey: 'hold' },
  { cssVar: '--guard', colorKey: 'guard' },
  { cssVar: '--guard-track', colorKey: 'guardTrack' },
  { cssVar: '--g-text', colorKey: 'gText' },
  { cssVar: '--g-muted', colorKey: 'gMuted' },
  { cssVar: '--g-line', colorKey: 'gLine' },
  { cssVar: '--g-fill', colorKey: 'gFill' },
  { cssVar: '--g-pass', colorKey: 'gPass' },
  { cssVar: '--g-hold', colorKey: 'gHold' },
  { cssVar: '--g-stop', colorKey: 'gStop' },
];

export type ColorPair = { foreground: string; background: string; label: string; minRatio: number };

/** Key pairs asserted in contrast.test.ts */
export const contrastPairs: ColorPair[] = [
  { foreground: colors.text, background: colors.surface, label: 'body on surface', minRatio: 4.5 },
  { foreground: colors.text, background: colors.surface2, label: 'body on surface-2', minRatio: 4.5 },
  { foreground: colors.text, background: colors.bg, label: 'body on page', minRatio: 4.5 },
  { foreground: colors.muted, background: colors.surface, label: 'muted on surface', minRatio: 4.5 },
  { foreground: colors.muted, background: colors.surface2, label: 'muted on surface-2', minRatio: 4.5 },
  { foreground: colors.muted, background: colors.bg, label: 'muted on page', minRatio: 4.5 },
  { foreground: colors.btnPrimaryText, background: colors.accent, label: 'primary button', minRatio: 4.5 },
  { foreground: colors.btnPrimaryText, background: colors.accentDim, label: 'primary button hover', minRatio: 4.5 },
  { foreground: colors.success, background: colors.surface, label: 'success on surface', minRatio: 4.5 },
  { foreground: colors.success, background: colors.surface2, label: 'success on card', minRatio: 4.5 },
  { foreground: colors.danger, background: colors.surface, label: 'danger on surface', minRatio: 4.5 },
  { foreground: colors.danger, background: colors.surface2, label: 'danger on card', minRatio: 4.5 },
  { foreground: colors.badgeWarn, background: colors.surface, label: 'warn badge', minRatio: 4.5 },
  { foreground: colors.badgeWarn, background: colors.surface2, label: 'warn badge on card', minRatio: 4.5 },
  { foreground: colors.warn, background: colors.surface, label: 'warn on surface', minRatio: 4.5 },
  { foreground: colors.warn, background: colors.surface2, label: 'warn on card', minRatio: 4.5 },
  { foreground: colors.text, background: colors.hold, label: 'ink on hold fill', minRatio: 4.5 },
  { foreground: colors.btnSuccessText, background: colors.success, label: 'success button', minRatio: 4.5 },
  { foreground: colors.btnDangerText, background: colors.danger, label: 'danger button', minRatio: 4.5 },
  { foreground: colors.accentText, background: colors.surface, label: 'accent text on surface', minRatio: 4.5 },
  { foreground: colors.accentText, background: colors.surface2, label: 'accent text on surface-2', minRatio: 4.5 },
  { foreground: colors.accentText, background: colors.accentWash, label: 'accent text on accent wash', minRatio: 4.5 },
  { foreground: colors.text, background: colors.accentWash, label: 'body on accent wash', minRatio: 4.5 },
  { foreground: colors.focus, background: colors.bg, label: 'focus ring on bg', minRatio: 3 },
  { foreground: colors.focus, background: colors.surface, label: 'focus ring on surface', minRatio: 3 },
  { foreground: colors.focus, background: colors.surface2, label: 'focus ring on surface-2', minRatio: 3 },
  { foreground: colors.borderStrong, background: colors.surface, label: 'control outline on surface', minRatio: 3 },
  { foreground: colors.borderStrong, background: colors.bg, label: 'control outline on page', minRatio: 3 },
  /* Guard instrument (dark panel) */
  { foreground: colors.gText, background: colors.guard, label: 'guard text on guard', minRatio: 4.5 },
  { foreground: colors.gMuted, background: colors.guard, label: 'guard muted on guard', minRatio: 4.5 },
  { foreground: colors.gMuted, background: colors.guardTrack, label: 'guard muted on track', minRatio: 4.5 },
  { foreground: colors.gHold, background: colors.guard, label: 'guard hold on guard', minRatio: 4.5 },
  { foreground: colors.gStop, background: colors.guard, label: 'guard stop on guard', minRatio: 4.5 },
  { foreground: colors.gPass, background: colors.guard, label: 'guard pass on guard', minRatio: 4.5 },
  { foreground: colors.guardTrack, background: colors.gPass, label: 'zone label on pass', minRatio: 4.5 },
  { foreground: colors.guardTrack, background: colors.gHold, label: 'zone label on hold', minRatio: 4.5 },
  { foreground: colors.guardTrack, background: colors.gStop, label: 'zone label on stop', minRatio: 4.5 },
  { foreground: colors.gFill, background: colors.guardTrack, label: 'gauge fill vs track', minRatio: 3 },
  { foreground: colors.gHold, background: colors.guard, label: 'focus ring on guard', minRatio: 3 },
];
