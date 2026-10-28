import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const demoScript = path.join(repoRoot, 'scripts', 'demo.mjs');
const videoScriptPath = path.join(repoRoot, 'docs', 'submission', 'video-script.md');

const DEFAULT_API = 'http://127.0.0.1:8787';
const TOTAL_SECONDS = 170;
const WEB_ZOOM = Number(process.env.WEB_ZOOM ?? '0.8');
const SECRET_RE = /(secret|api[_-]?key|token\b|password|Bearer )/i;

/** @type {import('playwright').ChromiumBrowser | null} */
let browser = null;
/** @type {import('node:child_process').ChildProcess | null} */
let demoChild = null;

const pageErrors = [];
const consoleErrors = [];
/** @type {ReturnType<typeof setTimeout>[]} */
const captionTimers = [];
/** @type {{ tag: string; testId: string; elTop: number; elBottom: number; captionTop: number; captionBottom: number; overlap: boolean; fullyVisible: boolean }[]} */
const captionOverlapChecks = [];

let t0 = 0;
let signalExitCode = null;

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const dir = process.env.PLAYWRIGHT_DIR;
    if (dir) {
      const require = createRequire(path.join(dir, 'package.json'));
      return require('playwright');
    }
    console.error(
      'error: playwright is not installed.\n' +
        '  Hint: npm i --no-save playwright && npx playwright install chromium\n' +
        '  Or set PLAYWRIGHT_DIR to a directory that has playwright installed.',
    );
    process.exit(1);
  }
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopDemoRunner() {
  if (!demoChild?.pid) return;
  try {
    process.kill(-demoChild.pid, 'SIGINT');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH') throw err;
  }
  await waitForExit(demoChild, 10_000);
  if (demoChild.exitCode === null && demoChild.signalCode === null) {
    try {
      process.kill(-demoChild.pid, 'SIGKILL');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH') throw err;
    }
  }
}

function startDemoRunner() {
  return new Promise((resolve, reject) => {
    const readyRe =
      /agent-pay demo ready:\s*(https?:\/\/[^\s]+)\s+\(api\s+(https?:\/\/[^,\s]+)/;
    const deadline = Date.now() + 60_000;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      fn(value);
    };

    demoChild = spawn(process.execPath, [demoScript], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const handleStream = (stream) => {
      if (!stream) return;
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          console.log(`[demo] ${line}`);
          const m = line.match(readyRe);
          if (m) finish(resolve, { webUrl: m[1], apiUrl: m[2] });
        }
      });
    };

    handleStream(demoChild.stdout);
    handleStream(demoChild.stderr);

    demoChild.on('error', (err) => finish(reject, err));
    demoChild.on('exit', (code, signal) => {
      finish(
        reject,
        new Error(
          `demo runner exited before ready (${signal != null ? `signal ${signal}` : `code ${code}`})`,
        ),
      );
    });

    const timer = setInterval(() => {
      if (Date.now() >= deadline) {
        finish(reject, new Error('timed out waiting for demo ready line (60s)'));
      }
    }, 500);
  });
}

function parseTime(m, s) {
  return Number(m) * 60 + Number(s);
}

function wordCount(text) {
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

function splitSentences(narration) {
  const normalized = narration.replace(/\s+/g, ' ').trim();
  const parts = normalized.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function buildCaptionChunks(narration, sceneDurationSec, maxWords = 22) {
  const sentences = splitSentences(narration);
  /** @type {string[]} */
  const texts = [];
  /** @type {string[]} */
  let current = [];
  let count = 0;

  for (const sentence of sentences) {
    const w = wordCount(sentence);
    if (count + w > maxWords && current.length > 0) {
      texts.push(current.join(' '));
      current = [sentence];
      count = w;
    } else {
      current.push(sentence);
      count += w;
    }
  }
  if (current.length) texts.push(current.join(' '));

  const totalWords = texts.reduce((n, t) => n + wordCount(t), 0) || 1;
  let offset = 0;
  return texts.map((text) => {
    const words = wordCount(text);
    const duration = (words / totalWords) * sceneDurationSec;
    const chunk = { text, startOffset: offset, duration };
    offset += duration;
    return chunk;
  });
}

function parseVideoScript(markdown) {
  const headingRe =
    /^### Scene (\d+) — (.+?) \((\d+):(\d+)–(\d+):(\d+), (\d+) s\)\s*$/gm;
  /** @type {{ num: number; title: string; start: number; end: number; duration: number; narration: string }[]} */
  const scenes = [];

  let match;
  while ((match = headingRe.exec(markdown)) !== null) {
    const num = Number(match[1]);
    const title = match[2].trim();
    const start = parseTime(match[3], match[4]);
    const end = parseTime(match[5], match[6]);
    const duration = Number(match[7]);
    const bodyStart = match.index + match[0].length;
    const rest = markdown.slice(bodyStart);
    const nextHeading = rest.search(/\n### Scene \d+ — /);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

    const narrHeadingRe = /^\*\*Narration[^\n]*:\*\*\s*$/m;
    const narrHeadingMatch = narrHeadingRe.exec(section);
    if (!narrHeadingMatch) {
      throw new Error(`video-script.md: missing narration for Scene ${num}`);
    }
    const afterHeading = section.slice(narrHeadingMatch.index + narrHeadingMatch[0].length);
    const bodyAfterHeading = afterHeading.startsWith('\n')
      ? afterHeading.slice(1)
      : afterHeading;
    /** @type {string[]} */
    const paraLines = [];
    for (const line of bodyAfterHeading.split('\n')) {
      if (line.trim() === '') break;
      paraLines.push(line.trim());
    }
    const narration = paraLines.join(' ');
    if (!narration) {
      throw new Error(`video-script.md: empty narration for Scene ${num}`);
    }

    if (end - start !== duration) {
      throw new Error(
        `video-script.md: Scene ${num} duration mismatch (${end - start}s vs ${duration}s)`,
      );
    }

    scenes.push({ num, title, start, end, duration, narration });
  }

  scenes.sort((a, b) => a.num - b.num);

  if (scenes.length !== 7) {
    throw new Error(`video-script.md: expected 7 scenes, found ${scenes.length}`);
  }
  for (let i = 0; i < 7; i++) {
    if (scenes[i].num !== i + 1) {
      throw new Error(`video-script.md: expected Scene ${i + 1}, got Scene ${scenes[i].num}`);
    }
  }
  if (scenes[0].start !== 0) {
    throw new Error(`video-script.md: Scene 1 must start at 0:00 (got ${scenes[0].start}s)`);
  }
  if (scenes[6].end !== TOTAL_SECONDS) {
    throw new Error(
      `video-script.md: Scene 7 must end at 2:50 / ${TOTAL_SECONDS}s (got ${scenes[6].end}s)`,
    );
  }
  for (let i = 0; i < scenes.length - 1; i++) {
    if (scenes[i].end !== scenes[i + 1].start) {
      throw new Error(
        `video-script.md: scenes ${scenes[i].num} and ${scenes[i + 1].num} are not contiguous (${scenes[i].end} → ${scenes[i + 1].start})`,
      );
    }
  }

  return scenes.map((s) => ({
    ...s,
    captionChunks: buildCaptionChunks(s.narration, s.duration),
  }));
}

function until(sec) {
  const target = t0 + sec * 1000;
  const delay = target - Date.now();
  if (delay <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, delay));
}

async function pause(page, ms) {
  if (typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms);
  } else {
    await new Promise((r) => setTimeout(r, ms));
  }
}

async function scrollToTop(page) {
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
}

async function scrollForGaugeHighlight(page) {
  await page.evaluate(() => {
    const gauge = document.querySelector('[data-testid="gauge"]');
    const decision = document.querySelector('[data-testid="decision"]');
    const box = document.querySelector('#submission-caption .submission-caption__box');
    const captionTop = box
      ? box.getBoundingClientRect().top
      : window.innerHeight - 140;
    const gap = 16;
    const targetDecisionBottom = captionTop - gap;

    const maxScroll = Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight,
    );

    const metricsAt = (scrollY) => {
      window.scrollTo({ top: scrollY, behavior: 'instant' });
      const gaugeRect = gauge?.getBoundingClientRect();
      const decisionRect = decision?.getBoundingClientRect();
      return {
        scrollY,
        gaugeTop: gaugeRect?.top ?? 0,
        decisionTop: decisionRect?.top ?? 0,
        decisionBottom: decisionRect?.bottom ?? 0,
      };
    };

    const bothVisible = (m) =>
      m.gaugeTop >= 0 &&
      m.decisionTop >= 0 &&
      m.decisionBottom <= targetDecisionBottom;

    const decisionFullyVisible = (m) =>
      m.decisionTop >= 0 && m.decisionBottom <= targetDecisionBottom;

    window.scrollTo({ top: 0, behavior: 'instant' });
    if (!decision) return;

    const atTop = metricsAt(0);
    if (bothVisible(atTop)) return;

    /** @type {number | null} */
    let bestBoth = null;
    /** @type {number | null} */
    let bestDecision = null;
    const step = Math.max(1, Math.floor(maxScroll / 400));
    for (let y = 0; y <= maxScroll; y += step) {
      const m = metricsAt(y);
      if (bothVisible(m)) {
        bestBoth = y;
        break;
      }
      if (decisionFullyVisible(m) && bestDecision == null) bestDecision = y;
    }
    if (bestBoth != null) {
      metricsAt(bestBoth);
      return;
    }
    if (bestDecision != null) {
      metricsAt(bestDecision);
      return;
    }
    metricsAt(0);
  });
}

async function scrollAboveCaption(page, testId) {
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return;
    const box = document.querySelector('#submission-caption .submission-caption__box');
    const captionTop = box
      ? box.getBoundingClientRect().top
      : window.innerHeight - 140;
    const gap = 16;
    const minTop = 8;
    const targetBottom = captionTop - gap;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > targetBottom) {
      const scrollDown = rect.bottom - targetBottom;
      const topAfter = rect.top - scrollDown;
      if (topAfter < minTop) {
        window.scrollBy({ top: rect.top - minTop, behavior: 'instant' });
      } else {
        window.scrollBy({ top: scrollDown, behavior: 'instant' });
      }
    }
  }, testId);
  await pause(page, 400);
}

async function assertNotUnderCaption(page, testId, tag) {
  const metrics = await page.evaluate(
    ({ id }) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      const box = document.querySelector('#submission-caption .submission-caption__box');
      let captionTop;
      let captionBottom;
      if (box) {
        const r = box.getBoundingClientRect();
        captionTop = r.top;
        captionBottom = r.bottom;
      } else {
        captionTop = window.innerHeight - 140;
        captionBottom = window.innerHeight;
      }
      let elTop = 0;
      let elBottom = 0;
      if (el) {
        const r = el.getBoundingClientRect();
        elTop = r.top;
        elBottom = r.bottom;
      }
      const gap = 16;
      const overlap = elBottom > captionTop && elTop < captionBottom;
      const fullyVisible =
        el != null && elTop >= 0 && elBottom <= captionTop - gap;
      return { testId: id, elTop, elBottom, captionTop, captionBottom, overlap, fullyVisible };
    },
    { id: testId },
  );
  const check = { tag, ...metrics };
  captionOverlapChecks.push(check);
  if (check.overlap || check.elTop < 0) {
    throw new Error(
      `caption overlaps ${tag} [data-testid=${testId}]: element ${check.elTop.toFixed(1)}–${check.elBottom.toFixed(1)} vs caption ${check.captionTop.toFixed(1)}–${check.captionBottom.toFixed(1)}` +
        (check.elTop < 0 ? ' (partially scrolled off top)' : ''),
    );
  }
  return check;
}

async function refocusAboveCaption(page, testId, tag) {
  await scrollAboveCaption(page, testId);
  await assertNotUnderCaption(page, testId, tag);
}

function stripMarkdownBackticks(title) {
  return title.replace(/`/g, '');
}

async function ensureWebCaptionPadding(page) {
  await page.evaluate((zoom) => {
    if (!document.getElementById('submission-caption-padding')) {
      const style = document.createElement('style');
      style.id = 'submission-caption-padding';
      style.textContent = 'body { padding-bottom: 170px !important; }';
      document.head.appendChild(style);
    }
    document.documentElement.style.zoom = String(zoom);
  }, WEB_ZOOM);
}

async function setCaption(page, sceneLabel, text) {
  await page.evaluate(
    ({ label, body }) => {
      let root = document.getElementById('submission-caption');
      if (!root) {
        root = document.createElement('div');
        root.id = 'submission-caption';
        root.style.cssText =
          'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
          'max-width:1100px;z-index:2147483647;pointer-events:none;text-align:center;';
        document.body.appendChild(root);
      }
      let box = root.querySelector('.submission-caption__box');
      if (!box) {
        box = document.createElement('div');
        box.className = 'submission-caption__box';
        box.style.cssText =
          'background:rgba(0,0,0,0.82);color:#fff;padding:10px 18px;border-radius:10px;' +
          'display:inline-block;text-align:left;max-width:100%;';
        root.appendChild(box);
      }
      let labelEl = box.querySelector('.submission-caption__label');
      if (!labelEl) {
        labelEl = document.createElement('div');
        labelEl.className = 'submission-caption__label';
        labelEl.style.cssText =
          'font:600 12px/1.2 system-ui,sans-serif;text-transform:uppercase;' +
          'letter-spacing:0.06em;color:#9ca3af;margin-bottom:4px;';
        box.appendChild(labelEl);
      }
      let textEl = box.querySelector('.submission-caption__text');
      if (!textEl) {
        textEl = document.createElement('div');
        textEl.className = 'submission-caption__text';
        textEl.style.cssText =
          'font:20px/1.35 system-ui,sans-serif;color:#fff;';
        box.appendChild(textEl);
      }
      labelEl.textContent = label;
      textEl.textContent = body;
    },
    { label: sceneLabel, body: text },
  );
}

function scheduleSceneCaptions(page, scene) {
  const label = `Scene ${scene.num} · ${stripMarkdownBackticks(scene.title)}`;
  for (const chunk of scene.captionChunks) {
    const fireAt = t0 + (scene.start + chunk.startOffset) * 1000;
    const delay = Math.max(0, fireAt - Date.now());
    const timer = setTimeout(() => {
      void setCaption(page, label, chunk.text);
    }, delay);
    captionTimers.push(timer);
  }
}

async function restoreLedgerZoom(page) {
  await page.evaluate(() => {
    document.getElementById('submission-ledger-backdrop')?.remove();

    const panel = document.querySelector('[data-testid="ledger"]');
    if (panel?.hasAttribute('data-demo-ledger-panel-style')) {
      const saved = panel.getAttribute('data-demo-ledger-panel-style');
      if (saved === '') panel.removeAttribute('style');
      else panel.setAttribute('style', saved);
      panel.removeAttribute('data-demo-ledger-panel-style');
    }

    const list = panel?.querySelector('.ledger-list');
    if (list?.hasAttribute('data-demo-ledger-list-style')) {
      const saved = list.getAttribute('data-demo-ledger-list-style');
      if (saved === '') list.removeAttribute('style');
      else list.setAttribute('style', saved);
      list.removeAttribute('data-demo-ledger-list-style');
    }
  });
}

async function clearHighlights(page) {
  await restoreLedgerZoom(page);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-demo-hl]')) {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.style.borderRadius = '';
      el.removeAttribute('data-demo-hl');
    }
  });
}

async function highlight(page, testId) {
  await page.evaluate((id) => {
    for (const el of document.querySelectorAll('[data-demo-hl]')) {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.style.borderRadius = '';
      el.removeAttribute('data-demo-hl');
    }
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return;
    el.style.outline = '3px solid #facc15';
    el.style.outlineOffset = '4px';
    el.style.borderRadius = '12px';
    el.setAttribute('data-demo-hl', '');
  }, testId);
}

async function highlightSelector(page, selector) {
  await clearHighlights(page);
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.style.outline = '3px solid #facc15';
    el.style.outlineOffset = '4px';
    el.style.borderRadius = '12px';
    el.setAttribute('data-demo-hl', '');
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const captionRegionTop = 800 - 150;
    if (el.getBoundingClientRect().bottom > captionRegionTop) {
      window.scrollBy(0, 60);
    }
  }, selector);
}

async function startLedgerZoom(page) {
  await page.evaluate(() => {
    if (document.getElementById('submission-ledger-backdrop')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'submission-ledger-backdrop';
    backdrop.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9000;';
    document.body.appendChild(backdrop);

    const panel = document.querySelector('[data-testid="ledger"]');
    if (!panel) return;

    const list = panel.querySelector('.ledger-list');
    panel.setAttribute('data-demo-ledger-panel-style', panel.getAttribute('style') ?? '');
    panel.style.cssText =
      'position:fixed;top:20px;left:50%;transform:translateX(-50%);width:820px;' +
      'max-height:590px;overflow-y:auto;z-index:9001;font-size:125%;' +
      'box-shadow:0 24px 64px rgba(0,0,0,0.45);';

    if (list) {
      list.setAttribute('data-demo-ledger-list-style', list.getAttribute('style') ?? '');
      list.style.maxHeight = 'none';
      list.style.overflow = 'visible';
    }

    panel.scrollTop = 0;
    panel.style.outline = '3px solid #facc15';
    panel.style.outlineOffset = '4px';
    panel.style.borderRadius = '12px';
  });
}

async function scrollLedgerPanelToBottom(page, durationMs) {
  await page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const panel = document.querySelector('[data-testid="ledger"]');
        if (!panel) {
          resolve(undefined);
          return;
        }
        const maxScroll = Math.max(0, panel.scrollHeight - panel.clientHeight);
        if (maxScroll <= 0) {
          resolve(undefined);
          return;
        }
        const t0 = performance.now();
        const tick = (now) => {
          const p = Math.min(1, (now - t0) / ms);
          panel.scrollTop = maxScroll * p;
          if (p < 1) requestAnimationFrame(tick);
          else resolve(undefined);
        };
        requestAnimationFrame(tick);
      }),
    durationMs,
  );
}

async function clickScenarioFlow(page, scenarioId) {
  await page.getByTestId(scenarioId).click();
  await pause(page, 1800);
  await page.getByTestId('btn-quote').click();
  await pause(page, 1800);
  await page.getByTestId('btn-policy').click();
  await pause(page, 1500);
  await page.getByTestId('result-status').waitFor({ state: 'visible' });
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function agentCliCommand(apiUrl) {
  let cmd = 'npm run -s agent -w @agent-pay/agent -- --scenario small --json';
  if (apiUrl !== DEFAULT_API) {
    cmd += ` --api ${apiUrl}`;
  }
  return cmd;
}

function runAgentCli(apiUrl) {
  const args = [
    'run',
    '-s',
    'agent',
    '-w',
    '@agent-pay/agent',
    '--',
    '--scenario',
    'small',
    '--json',
  ];
  if (apiUrl !== DEFAULT_API) {
    args.push('--api', apiUrl);
  }

  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd: repoRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    /** @type {Buffer[]} */
    const outChunks = [];
    /** @type {Buffer[]} */
    const errChunks = [];

    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        exitCode: code ?? 1,
      });
    });
  });
}

const TERMINAL_HIGHLIGHT_RAW = ['"apiStatus":"paid"', '"exitCode":0'];

function applyTerminalHighlights(escaped) {
  let out = escaped;
  for (const raw of TERMINAL_HIGHLIGHT_RAW) {
    const needle = escapeHtml(raw);
    out = out.split(needle).join(`<mark>${needle}</mark>`);
  }
  return out;
}

function buildTerminalHtml(commandLine, stdoutText, exitCode) {
  const lines = stdoutText.split('\n');
  const lineHtml = lines
    .map((line, i) => {
      const escaped = applyTerminalHighlights(escapeHtml(line));
      return `<div class="line" id="line-${i}" style="visibility:hidden">${escaped || ' '}</div>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Terminal — agent-pay</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0d1117; color: #e6edf3; font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; min-height: 100vh; }
  .window { max-width: 1200px; margin: 0 auto; border: 1px solid #30363d; border-radius: 10px; overflow: hidden; box-shadow: 0 16px 48px rgba(0,0,0,0.45); }
  .titlebar { background: #161b22; padding: 10px 14px; border-bottom: 1px solid #30363d; font: 600 13px system-ui, sans-serif; color: #c9d1d9; }
  .terminal { padding: 16px 18px 24px; }
  .line { white-space: pre-wrap; word-break: break-all; margin: 0 0 8px; }
  .line.prompt { color: #7ee787; }
  mark { background: #facc15; color: #0d1117; padding: 0 2px; border-radius: 2px; }
  .end-card { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: none; z-index: 2147483646; }
  .end-card.is-visible { display: flex; }
  .end-card__inner { background: rgba(13,17,23,0.92); border: 1px solid #30363d; border-radius: 16px; padding: 28px 36px; font: 600 26px/1.35 system-ui, sans-serif; color: #f0f6fc; text-align: center; max-width: 900px; box-shadow: 0 24px 64px rgba(0,0,0,0.55); }
</style>
</head>
<body>
<div class="window">
  <div class="titlebar">Terminal — agent-pay</div>
  <div class="terminal"><div class="line prompt">$ ${escapeHtml(commandLine)}</div>${lineHtml}<div class="line prompt" id="exit-prompt" style="visibility:hidden">$ echo $?</div><div class="line" id="exit-code" style="visibility:hidden">${escapeHtml(String(exitCode))}</div></div>
</div>
<div class="end-card" id="end-card"><div class="end-card__inner">agent-pay: policy-guarded payments for AI agents.</div></div>
</body>
</html>`;

  const stdoutNeedsHighlight = TERMINAL_HIGHLIGHT_RAW.some((s) => stdoutText.includes(s));
  if (stdoutNeedsHighlight && !html.includes('<mark>')) {
    throw new Error(
      'terminal HTML missing <mark> highlights despite stdout containing apiStatus paid or exitCode 0',
    );
  }

  return html;
}

function spawnAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, options);
    /** @type {Buffer[]} */
    const errChunks = [];
    if (child.stderr) {
      child.stderr.on('data', (c) => errChunks.push(c));
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(undefined);
      else {
        reject(
          new Error(
            `${cmd} exited with code ${code}: ${Buffer.concat(errChunks).toString('utf8').trim()}`,
          ),
        );
      }
    });
  });
}

function toolOnPath(name) {
  return spawnAsync('sh', ['-c', `command -v ${name} >/dev/null 2>&1`]).then(
    () => true,
    () => false,
  );
}

async function trimSubmissionVideo(rawPath, outPath, totalSeconds) {
  const hasFfmpeg = await toolOnPath('ffmpeg');
  if (hasFfmpeg) {
    await spawnAsync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-i',
        rawPath,
        '-t',
        String(totalSeconds),
        '-an',
        '-c:v',
        'libvpx-vp9',
        '-b:v',
        '0',
        '-crf',
        '36',
        '-row-mt',
        '1',
        '-deadline',
        'good',
        '-cpu-used',
        '4',
        outPath,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    const hasFfprobe = await toolOnPath('ffprobe');
    if (hasFfprobe) {
      const probe = spawn('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        outPath,
      ]);
      /** @type {Buffer[]} */
      const chunks = [];
      probe.stdout.on('data', (c) => chunks.push(c));
      await new Promise((resolve) => probe.on('close', resolve));
      const duration = Buffer.concat(chunks).toString('utf8').trim();
      if (duration) console.log(`ffprobe duration: ${duration}s`);
    }
    return;
  }

  fs.copyFileSync(rawPath, outPath);
  console.warn('warning: ffmpeg not found on PATH; copied raw recording without trim/re-encode');
}

async function showEndCard(page) {
  await page.evaluate(() => {
    const el = document.getElementById('end-card');
    if (el) el.classList.add('is-visible');
  });
}

async function handleSignalExit(code) {
  if (signalExitCode !== null) return;
  signalExitCode = code;
  for (const t of captionTimers) clearTimeout(t);
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  await stopDemoRunner();
  process.exit(code);
}

process.on('SIGINT', () => {
  void handleSignalExit(130);
});
process.on('SIGTERM', () => {
  void handleSignalExit(143);
});

const markdown = fs.readFileSync(videoScriptPath, 'utf8');
const scenes = parseVideoScript(markdown);

if (process.env.PARSE_ONLY === '1') {
  const report = scenes.map((s) => ({
    num: s.num,
    title: s.title,
    start: s.start,
    end: s.end,
    narrationWordCount: wordCount(s.narration),
    captionChunks: s.captionChunks,
  }));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const playwright = await loadPlaywright();
let exitCode = 0;
/** @type {{ scene: number; title: string; plannedStart: number; plannedEnd: number; actualStart: number; actualEnd: number }[]} */
const timingLog = [];

try {
  const { webUrl, apiUrl } = await startDemoRunner();

  const OUT =
    process.env.SUBMISSION_VIDEO ||
    path.join(repoRoot, 'docs', 'demo', 'agent-pay-submission.webm');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const videoTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pay-submission-video-'));

  browser = await playwright.chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: {
      dir: videoTempDir,
      size: { width: 1280, height: 800 },
    },
  });

  const page = await context.newPage();
  t0 = Date.now();

  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  async function runScene(sceneNum, actions) {
    const scene = scenes[sceneNum - 1];
    const actualStart = (Date.now() - t0) / 1000;
    await actions(scene, () => scheduleSceneCaptions(page, scene));
    await until(scene.end);
    const actualEnd = (Date.now() - t0) / 1000;
    timingLog.push({
      scene: scene.num,
      title: scene.title,
      plannedStart: scene.start,
      plannedEnd: scene.end,
      actualStart,
      actualEnd,
    });
  }

  // Scene 1 — Intro
  await runScene(1, async (_scene, scheduleCaptions) => {
    await page.goto(webUrl, { waitUntil: 'domcontentloaded' });
    await ensureWebCaptionPadding(page);
    scheduleCaptions();
    await pause(page, 1500);
    await highlightSelector(page, '.scenario-grid');
    await pause(page, 2500);
    await highlightSelector(page, 'ol.stepper');
    await pause(page, 2500);
    await clearHighlights(page);
    await highlight(page, 'gauge');
    await pause(page, 2000);
  });

  // Scene 2 — $12 paid
  await runScene(2, async (_scene, scheduleCaptions) => {
    await ensureWebCaptionPadding(page);
    scheduleCaptions();
    await clearHighlights(page);
    await clickScenarioFlow(page, 'scenario-approved');
    await scrollAboveCaption(page, 'decision');
    await highlight(page, 'decision');
    await assertNotUnderCaption(page, 'decision', 'scene2-decision');
    await pause(page, 2200);
    await refocusAboveCaption(page, 'decision', 'scene2-decision-after-pause');
    await page.getByTestId('receipt').waitFor({ state: 'visible' });
    await scrollAboveCaption(page, 'receipt');
    await highlight(page, 'receipt');
    await assertNotUnderCaption(page, 'receipt', 'scene2-receipt');
    await pause(page, 2200);
    await refocusAboveCaption(page, 'receipt', 'scene2-receipt-after-pause');
    await scrollForGaugeHighlight(page);
    await highlight(page, 'gauge');
    await assertNotUnderCaption(page, 'decision', 'scene2-decision-during-gauge');
    await pause(page, 2000);
    await assertNotUnderCaption(page, 'decision', 'scene2-decision-during-gauge-after-pause');
  });

  // Scene 3 — rejected
  await runScene(3, async (_scene, scheduleCaptions) => {
    await ensureWebCaptionPadding(page);
    scheduleCaptions();
    await clearHighlights(page);
    await clickScenarioFlow(page, 'scenario-rejected');
    await scrollAboveCaption(page, 'decision');
    await highlight(page, 'decision');
    await assertNotUnderCaption(page, 'decision', 'scene3-decision');
    await pause(page, 2800);
    await refocusAboveCaption(page, 'decision', 'scene3-decision-after-pause');
    await scrollForGaugeHighlight(page);
    await highlight(page, 'gauge');
    await assertNotUnderCaption(page, 'decision', 'scene3-decision-during-gauge');
    await pause(page, 2000);
    await assertNotUnderCaption(page, 'decision', 'scene3-decision-during-gauge-after-pause');
  });

  // Scene 4 — needs approval
  await runScene(4, async (_scene, scheduleCaptions) => {
    await ensureWebCaptionPadding(page);
    scheduleCaptions();
    await clearHighlights(page);
    await clickScenarioFlow(page, 'scenario-needs-approval');
    await highlightSelector(page, 'ol.stepper');
    await pause(page, 2200);
    await scrollAboveCaption(page, 'decision');
    await highlight(page, 'decision');
    await assertNotUnderCaption(page, 'decision', 'scene4-decision');
    await pause(page, 2200);
    await refocusAboveCaption(page, 'decision', 'scene4-decision-after-pause');
    await scrollAboveCaption(page, 'btn-approve');
    await highlight(page, 'btn-approve');
    await pause(page, 2000);
  });

  // Scene 5 — approved
  await runScene(5, async (_scene, scheduleCaptions) => {
    await ensureWebCaptionPadding(page);
    scheduleCaptions();
    await clearHighlights(page);
    await page.getByTestId('btn-approve').click();
    await pause(page, 1800);
    await page.getByTestId('human-outcome').waitFor({ state: 'visible' });
    await scrollAboveCaption(page, 'decision');
    await highlight(page, 'decision');
    await assertNotUnderCaption(page, 'decision', 'scene5-decision');
    await pause(page, 1800);
    await refocusAboveCaption(page, 'decision', 'scene5-decision-after-pause');
    await page.getByTestId('receipt').waitFor({ state: 'visible' });
    await scrollAboveCaption(page, 'receipt');
    await highlight(page, 'receipt');
    await assertNotUnderCaption(page, 'receipt', 'scene5-receipt');
    await pause(page, 1800);
    await refocusAboveCaption(page, 'receipt', 'scene5-receipt-after-pause');
    await scrollForGaugeHighlight(page);
    await highlight(page, 'gauge');
    await assertNotUnderCaption(page, 'decision', 'scene5-decision-during-gauge');
    await pause(page, 1500);
    await assertNotUnderCaption(page, 'decision', 'scene5-decision-during-gauge-after-pause');
  });

  // Scene 6 — ledger zoom
  await runScene(6, async (_scene, scheduleCaptions) => {
    await ensureWebCaptionPadding(page);
    scheduleCaptions();
    await clearHighlights(page);
    await scrollToTop(page);
    await highlight(page, 'ledger');
    await pause(page, 800);
    await startLedgerZoom(page);
    await pause(page, 3000);
    await scrollLedgerPanelToBottom(page, 11_000);
    await pause(page, 2000);
    await restoreLedgerZoom(page);
    await clearHighlights(page);
  });

  // Scene 7 — CLI
  await runScene(7, async (scene, scheduleCaptions) => {
    const commandLine = agentCliCommand(apiUrl);
    const cliResult = await runAgentCli(apiUrl);

    if (cliResult.exitCode !== 0) {
      throw new Error(
        `agent CLI failed with exit code ${cliResult.exitCode}\n${cliResult.stderr}`,
      );
    }
    if (cliResult.stdout.length === 0) {
      throw new Error('agent CLI produced empty stdout');
    }

    const stdoutUtf8 = cliResult.stdout.toString('utf8');
    if (SECRET_RE.test(stdoutUtf8)) {
      throw new Error('agent CLI stdout matched secret pattern; aborting (not redacted)');
    }

    const cliOutPath =
      process.env.CLI_OUT || path.join(repoRoot, 'docs', 'demo', 'agent-cli-small.ndjson');
    fs.mkdirSync(path.dirname(cliOutPath), { recursive: true });
    fs.writeFileSync(cliOutPath, cliResult.stdout);

    const html = buildTerminalHtml(commandLine, stdoutUtf8, cliResult.exitCode);
    const htmlPath = path.join(os.tmpdir(), `agent-pay-terminal-${process.pid}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');

    await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
    scheduleCaptions();
    await pause(page, 800);

    const lineCount = stdoutUtf8.split('\n').length;
    for (let i = 0; i < lineCount; i++) {
      await page.evaluate((idx) => {
        const el = document.getElementById(`line-${idx}`);
        if (el) el.style.visibility = 'visible';
      }, i);
      await pause(page, 600);
    }

    await page.evaluate(() => {
      const ep = document.getElementById('exit-prompt');
      const ec = document.getElementById('exit-code');
      if (ep) ep.style.visibility = 'visible';
      if (ec) ec.style.visibility = 'visible';
    });

    const endCardAt = scene.end - 6;
    await until(endCardAt);
    await showEndCard(page);
  });

  await until(170.3);

  const video = page.video();
  await page.close();
  await context.close();

  if (video) {
    const srcPath = await video.path();
    await trimSubmissionVideo(srcPath, OUT, TOTAL_SECONDS);
  }
  fs.rmSync(videoTempDir, { recursive: true, force: true });
  await browser.close();
  browser = null;

  const timingPath = path.join(os.tmpdir(), 'agent-pay-submission-timing.json');
  fs.writeFileSync(
    timingPath,
    `${JSON.stringify({ t0, scenes: timingLog, captionOverlapChecks }, null, 2)}\n`,
  );

  for (const row of timingLog) {
    console.log(
      `scene ${row.scene} (${row.title}): planned ${row.plannedStart.toFixed(1)}–${row.plannedEnd.toFixed(1)}s, actual ${row.actualStart.toFixed(2)}–${row.actualEnd.toFixed(2)}s`,
    );
  }
  console.log(`timing log: ${timingPath}`);

  const bytes = fs.statSync(OUT).size;
  console.log(`video: ${OUT} (${bytes} bytes)`);

  if (pageErrors.length) {
    console.error('page errors:');
    for (const e of pageErrors) console.error(`  ${e}`);
    exitCode = 1;
  }
  if (consoleErrors.length) {
    console.error('console errors:');
    for (const e of consoleErrors) console.error(`  ${e}`);
    exitCode = 1;
  }
} catch (err) {
  console.error(err);
  exitCode = 1;
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
} finally {
  for (const t of captionTimers) clearTimeout(t);
  await stopDemoRunner();
}

process.exit(exitCode);
