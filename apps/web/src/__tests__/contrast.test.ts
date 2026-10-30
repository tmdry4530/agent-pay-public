import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { colors, contrastPairs, cssSyncedTokens } from '../lib/colorTokens';
import { contrastRatio } from '../lib/contrast';

const testDir = dirname(fileURLToPath(import.meta.url));
const indexCssPath = join(testDir, '../index.css');
const appCssPath = join(testDir, '../App.css');

function parseRootHexVars(css: string): Map<string, string> {
  const rootMatch = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/:root\s*\{([^}]+)\}/s);
  if (!rootMatch) return new Map();
  const map = new Map<string, string>();
  for (const chunk of rootMatch[1]!.split(';')) {
    const m = chunk.trim().match(/^(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*$/);
    if (m) map.set(m[1]!, m[2]!.toLowerCase());
  }
  return map;
}

const cssVarToColorKey: Record<string, keyof typeof colors> = {
  '--text': 'text',
  '--muted': 'muted',
  '--accent': 'accent',
  '--accent-text': 'accentText',
  '--success': 'success',
  '--danger': 'danger',
  '--warn': 'warn',
  '--badge-warn': 'badgeWarn',
};

function collectTextColorVars(css: string): string[] {
  const found = new Set<string>();
  for (const m of css.matchAll(/(?<![\w-])color:\s*var\((--[\w-]+)\)/g)) {
    found.add(m[1]!);
  }
  return [...found];
}

describe('WCAG contrast for design tokens', () => {
  it.each(contrastPairs)('$label meets ratio ≥ $minRatio', ({ foreground, background, minRatio }) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(minRatio);
  });
});

describe('index.css token sync', () => {
  const rootVars = parseRootHexVars(readFileSync(indexCssPath, 'utf8'));

  it.each(cssSyncedTokens)('$cssVar matches colorTokens.$colorKey', ({ cssVar, colorKey }) => {
    expect(rootVars.get(cssVar)?.toLowerCase()).toBe(colors[colorKey].toLowerCase());
  });
});

describe('CSS text color tokens on surfaces', () => {
  const css = readFileSync(appCssPath, 'utf8');
  const textVars = collectTextColorVars(css).filter((v) => cssVarToColorKey[v]);

  it.each(textVars)('var(%s) on --surface and --surface-2 ≥ 4.5:1', (cssVar) => {
    const key = cssVarToColorKey[cssVar]!;
    const fg = colors[key];
    expect(contrastRatio(fg, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fg, colors.surface2)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('CSS guard-instrument text tokens', () => {
  const css = readFileSync(appCssPath, 'utf8');
  const guardVars: Record<string, keyof typeof colors> = {
    '--g-text': 'gText',
    '--g-muted': 'gMuted',
    '--g-pass': 'gPass',
    '--g-hold': 'gHold',
    '--g-stop': 'gStop',
  };
  const used = collectTextColorVars(css).filter((v) => guardVars[v]);

  it('uses at least one guard text token', () => {
    expect(used.length).toBeGreaterThan(0);
  });

  it.each(used)('var(%s) on --guard and --guard-track ≥ 4.5:1', (cssVar) => {
    const fg = colors[guardVars[cssVar]!];
    expect(contrastRatio(fg, colors.guard)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fg, colors.guardTrack)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('page-level text tokens', () => {
  it.each(['text', 'muted', 'accentText', 'success', 'danger', 'warn', 'badgeWarn'] as const)(
    '%s on the page background ≥ 4.5:1',
    (key) => {
      expect(contrastRatio(colors[key], colors.bg)).toBeGreaterThanOrEqual(4.5);
    },
  );
});
