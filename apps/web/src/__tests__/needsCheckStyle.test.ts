import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const appCssPath = join(testDir, '../App.css');

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function ruleBlock(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's');
  const m = css.match(re);
  return m ? m[1]! : null;
}

describe('needs-check warn styling in App.css', () => {
  const css = stripCssComments(readFileSync(appCssPath, 'utf8'));

  it('styles pending manual-resolve badges and decision card with warn, not success green', () => {
    const paidIdx = css.indexOf('.result-badge.status-paid');
    const needsCheckBadgeIdx = css.indexOf('.result-badge.status-needs-check');
    expect(paidIdx).toBeGreaterThanOrEqual(0);
    expect(needsCheckBadgeIdx).toBeGreaterThan(paidIdx);

    const resultBlock = ruleBlock(css, '.result-badge.status-needs-check');
    expect(resultBlock).not.toBeNull();
    expect(resultBlock).toContain('border-color: var(--warn)');
    expect(resultBlock).toContain('color: var(--warn)');
    expect(resultBlock).not.toContain('--success');
    expect(resultBlock).not.toMatch(/62,\s*207,\s*142/);

    const decisionBlock = ruleBlock(css, '.decision-card.status-needs-check');
    expect(decisionBlock).not.toBeNull();
    expect(decisionBlock).toContain('border-color: var(--warn)');
    expect(decisionBlock).not.toContain('--success');
    expect(decisionBlock).not.toMatch(/62,\s*207,\s*142/);
  });
});
