import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const videoScriptPath = path.join(repoRoot, 'docs', 'submission', 'video-script.md');
const seedScript = path.join(repoRoot, 'apps', 'web', 'scripts', 'seed-needs-check.mjs');
const viteBin = path.join(repoRoot, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js');
const ENV_FILE = path.join(repoRoot, '.env');
const envFileArgs = fs.existsSync(ENV_FILE) ? [`--env-file=${ENV_FILE}`] : [];

const DEFAULT_API = 'http://127.0.0.1:8787';
const API_HOST = '127.0.0.1';
const API_PORT = Number(process.env.DEMO_API_PORT) || 8787;
const WEB_PORT = Number(process.env.DEMO_WEB_PORT) || 5173;
const ROLES = ['intro', 'paid', 'rejected', 'approval', 'approved', 'ledger', 'resolve', 'cli'];
const MAX_TOTAL_SECONDS = 175;
const WEB_ZOOM = Number(process.env.WEB_ZOOM ?? '0.8');
const SECRET_RE = /(secret|api[_-]?key|token\b|password|Bearer )/i;

/** @type {import('playwright').ChromiumBrowser | null} */
let browser = null;
/** @type {import('node:child_process').ChildProcess | null} */
let apiChild = null;
/** @type {import('node:child_process').ChildProcess | null} */
let webChild = null;

const pageErrors = [];
const consoleErrors = [];
/** @type {ReturnType<typeof setTimeout>[]} */
const captionTimers = [];
/** @type {{ tag: string; testId: string; elTop: number; elBottom: number; captionTop: number; captionBottom: number; overlap: boolean; fullyVisible: boolean }[]} */
const captionOverlapChecks = [];
/** @type {{ tag: string; expected: string; actual: string }[]} */
const spentChecks = [];

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

function prefixLines(stream, prefix) {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      console.log(`${prefix}${line}`);
    }
  });
  stream.on('end', () => {
    if (buffer.length) console.log(`${prefix}${buffer}`);
  });
}

function checkPortFree(port, label) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `port ${port} (${label}) is already in use on ${API_HOST} — stop the other process or set DEMO_API_PORT/DEMO_WEB_PORT`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(port, API_HOST, () => {
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve();
      });
    });
  });
}

function runSeed(ledgerPath) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const outChunks = [];
    /** @type {Buffer[]} */
    const errChunks = [];
    const child = spawn(process.execPath, [seedScript], {
      cwd: repoRoot,
      env: { ...process.env, LEDGER_PATH: ledgerPath, RAIL: 'mock' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => {
      outChunks.push(c);
      for (const line of c.toString('utf8').split('\n').filter(Boolean)) {
        console.log(`[seed] ${line}`);
      }
    });
    child.stderr.on('data', (c) => {
      errChunks.push(c);
      for (const line of c.toString('utf8').split('\n').filter(Boolean)) {
        console.log(`[seed] ${line}`);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      const combined = `${stdout}\n${stderr}`.trim();
      if (code !== 0) {
        reject(new Error(`seed-needs-check exited with code ${code}:\n${combined}`));
        return;
      }
      if (!stdout.includes('needsManualResolve=true') || !stdout.includes('submitting')) {
        reject(
          new Error(
            `seed-needs-check stdout missing expected markers (needsManualResolve=true, submitting):\n${combined}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

async function startServers(ledgerPath) {
  await checkPortFree(API_PORT, 'api');
  await checkPortFree(WEB_PORT, 'web');

  const apiUrl = `http://${API_HOST}:${API_PORT}`;
  const webUrl = `http://${API_HOST}:${WEB_PORT}/`;

  apiChild = spawn(
    process.execPath,
    [...envFileArgs, path.join('apps', 'api', 'src', 'main.ts')],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        RAIL: 'mock',
        LEDGER_PATH: ledgerPath,
        PORT: String(API_PORT),
        HOST: API_HOST,
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  prefixLines(apiChild.stdout, '[api] ');
  prefixLines(apiChild.stderr, '[api] ');

  const healthDeadline = Date.now() + 15_000;
  let apiReady = false;
  while (Date.now() < healthDeadline) {
    if (apiChild.exitCode !== null || apiChild.signalCode !== null) {
      throw new Error('API process exited before health check succeeded');
    }
    try {
      const res = await fetch(`${apiUrl}/health`);
      if (res.ok) {
        const body = await res.json();
        if (body?.ok === true) {
          if (body.rail !== 'mock') {
            throw new Error(
              `API health rail must be "mock" for submission recording (got ${JSON.stringify(body.rail)})`,
            );
          }
          apiReady = true;
          break;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('rail must be')) throw err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!apiReady) {
    throw new Error('API health check timed out after 15s (expected { ok: true, rail: "mock" })');
  }

  webChild = spawn(process.execPath, [viteBin, '--host', API_HOST, '--port', String(WEB_PORT), '--strictPort'], {
    cwd: path.join(repoRoot, 'apps', 'web'),
    env: {
      ...process.env,
      VITE_API_BASE: apiUrl,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prefixLines(webChild.stdout, '[web] ');
  prefixLines(webChild.stderr, '[web] ');

  const webDeadline = Date.now() + 30_000;
  let webReady = false;
  while (Date.now() < webDeadline) {
    if (webChild.exitCode !== null || webChild.signalCode !== null) {
      throw new Error('web process exited before HTTP 200');
    }
    try {
      const res = await fetch(webUrl);
      if (res.status === 200) {
        webReady = true;
        break;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!webReady) {
    throw new Error('web server did not respond with HTTP 200 within 30s');
  }

  console.log(
    `[record] api pid ${apiChild.pid ?? '—'} web pid ${webChild.pid ?? '—'} ledger ${ledgerPath}`,
  );

  return { webUrl, apiUrl };
}

async function stopServers() {
  for (const child of [apiChild, webChild]) {
    if (!child?.pid) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH') throw err;
    }
    await waitForExit(child, 4000);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH') throw err;
      }
    }
  }
  apiChild = null;
  webChild = null;
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

function parseTimingRange(range) {
  const m = String(range)
    .trim()
    .match(/^(\d+):(\d+)[–-](\d+):(\d+)$/);
  if (!m) {
    throw new Error(`video-script.md: invalid timing range "${range}"`);
  }
  return {
    start: parseTime(m[1], m[2]),
    end: parseTime(m[3], m[4]),
  };
}

function validateTimingTable(markdown, scenes, totalSeconds) {
  const timingMatch = markdown.match(/## Timing\b[\s\S]*?(?=\n## [^\n]+|\n### Scene \d+ —|$)/);
  if (!timingMatch) return;

  const block = timingMatch[0];
  const rowRe = /^\|\s*S(\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(\d+)\s*s\s*\|\s*$/gm;
  let rowMatch;
  while ((rowMatch = rowRe.exec(block)) !== null) {
    const num = Number(rowMatch[1]);
    const range = rowMatch[3].trim();
    const duration = Number(rowMatch[4]);
    const scene = scenes.find((s) => s.num === num);
    if (!scene) {
      throw new Error(`video-script.md: Timing table references unknown S${num}`);
    }
    const { start, end } = parseTimingRange(range);
    if (start !== scene.start || end !== scene.end || duration !== scene.duration) {
      throw new Error(
        `video-script.md: Timing row S${num} disagrees with scene heading (table ${start}–${end}, ${duration}s vs heading ${scene.start}–${scene.end}, ${scene.duration}s)`,
      );
    }
  }

  const totalRow = block.match(
    /^\|\s*\|\s*\*\*Total\*\*\s*\|\s*\*\*([^*]+)\*\*\s*\|\s*\*\*(\d+)\s*s\*\*\s*\|\s*$/m,
  );
  if (totalRow) {
    const { start, end } = parseTimingRange(totalRow[1].trim());
    const tableTotal = Number(totalRow[2]);
    if (start !== 0 || end !== totalSeconds || tableTotal !== totalSeconds) {
      throw new Error(
        `video-script.md: Timing Total row disagrees with derived total (table 0:00–${end}, ${tableTotal}s vs ${totalSeconds}s)`,
      );
    }
  }
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

  if (scenes.length !== ROLES.length) {
    throw new Error(
      `video-script.md: expected ${ROLES.length} scenes, found ${scenes.length}`,
    );
  }
  for (let i = 0; i < ROLES.length; i++) {
    if (scenes[i].num !== i + 1) {
      throw new Error(`video-script.md: expected Scene ${i + 1}, got Scene ${scenes[i].num}`);
    }
  }
  if (scenes[0].start !== 0) {
    throw new Error(`video-script.md: Scene 1 must start at 0:00 (got ${scenes[0].start}s)`);
  }
  for (let i = 0; i < scenes.length - 1; i++) {
    if (scenes[i].end !== scenes[i + 1].start) {
      throw new Error(
        `video-script.md: scenes ${scenes[i].num} and ${scenes[i + 1].num} are not contiguous (${scenes[i].end} → ${scenes[i + 1].start})`,
      );
    }
  }

  const totalSeconds = scenes[scenes.length - 1].end;
  if (totalSeconds > MAX_TOTAL_SECONDS) {
    throw new Error(
      `video-script.md: total ${totalSeconds}s exceeds limit ${MAX_TOTAL_SECONDS}s (2:55)`,
    );
  }

  validateTimingTable(markdown, scenes, totalSeconds);

  if (!/intent|resolve/i.test(scenes[6].title)) {
    throw new Error(
      `video-script.md: Scene 7 title must mention intent or resolve (got "${scenes[6].title}")`,
    );
  }
  if (!/\bCLI\b/i.test(scenes[7].title)) {
    throw new Error(
      `video-script.md: Scene 8 title must mention CLI (got "${scenes[7].title}")`,
    );
  }

  const enriched = scenes.map((s, i) => ({
    ...s,
    role: ROLES[i],
    id: `S${s.num}`,
    captionChunks: buildCaptionChunks(s.narration, s.duration),
  }));

  return { scenes: enriched, totalSeconds };
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
    // The Receipt card (when shown) sits below Decision; keep it fully clear of the caption too.
    const receipt = document.querySelector('[data-testid="receipt"]');
    const lowest = receipt ?? decision;
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
      const lowestRect = lowest?.getBoundingClientRect();
      return {
        scrollY,
        gaugeTop: gaugeRect?.top ?? 0,
        decisionTop: decisionRect?.top ?? 0,
        decisionBottom: lowestRect?.bottom ?? 0,
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

async function scrollAboveCaptionSel(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const box = document.querySelector('#submission-caption .submission-caption__box');
    const captionTop = box
      ? box.getBoundingClientRect().top
      : window.innerHeight - 140;
    const gap = 24;
    const minTop = 8;
    const targetBottom = captionTop - gap;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > targetBottom) {
      const scrollDown = rect.bottom - targetBottom;
      const topAfter = rect.top - scrollDown;
      const want = topAfter < minTop ? rect.top - minTop : scrollDown;
      // Near the end of the page there may not be enough document left to scroll the element
      // above the caption; grow a recorder-owned spacer so the scroll can happen.
      const root = document.scrollingElement || document.documentElement;
      const maxScroll = root.scrollHeight - window.innerHeight - window.scrollY;
      if (want > maxScroll) {
        let spacer = document.getElementById('record-scroll-spacer');
        if (!spacer) {
          spacer = document.createElement('div');
          spacer.id = 'record-scroll-spacer';
          spacer.setAttribute('aria-hidden', 'true');
          document.body.appendChild(spacer);
        }
        const cur = spacer.getBoundingClientRect().height;
        spacer.style.height = `${Math.ceil(cur + (want - maxScroll) / 0.5 + 40)}px`;
      }
      window.scrollBy({ top: want, behavior: 'instant' });
    }
  }, selector);
  await pause(page, 400);
}

/** The app smooth-scrolls the stepper into view when the step changes; wait for that to finish. */
async function waitScrollSettled(page, { stableMs = 300, maxMs = 3000 } = {}) {
  const t0 = Date.now();
  let last = await page.evaluate(() => window.scrollY);
  let stableSince = Date.now();
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(100);
    const y = await page.evaluate(() => window.scrollY);
    if (y !== last) {
      last = y;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return;
    }
  }
}

async function scrollAboveCaption(page, testId) {
  await scrollAboveCaptionSel(page, `[data-testid="${testId}"]`);
}

const FULL = { requireFullyVisible: true };

async function assertSelNotUnderCaption(page, selector, tag, { requireFullyVisible = false } = {}) {
  const metrics = await page.evaluate(
    ({ sel }) => {
      const el = document.querySelector(sel);
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
      const testId = el?.getAttribute('data-testid') ?? sel;
      return { testId, elTop, elBottom, captionTop, captionBottom, overlap, fullyVisible };
    },
    { sel: selector },
  );
  const check = { tag, selector, requireFullyVisible, ...metrics };
  captionOverlapChecks.push(check);
  if (requireFullyVisible && !check.fullyVisible) {
    throw new Error(
      `${tag} ${selector} not fully visible above caption: element ${check.elTop.toFixed(1)}–${check.elBottom.toFixed(1)} vs caption top ${check.captionTop.toFixed(1)} (needs ${16}px gap)`,
    );
  }
  if (check.overlap || check.elTop < 0) {
    throw new Error(
      `caption overlaps ${tag} ${selector}: element ${check.elTop.toFixed(1)}–${check.elBottom.toFixed(1)} vs caption ${check.captionTop.toFixed(1)}–${check.captionBottom.toFixed(1)}` +
        (check.elTop < 0 ? ' (partially scrolled off top)' : ''),
    );
  }
  return check;
}

async function assertNotUnderCaption(page, testId, tag, opts) {
  return assertSelNotUnderCaption(page, `[data-testid="${testId}"]`, tag, opts);
}

async function refocusAboveCaption(page, testId, tag, opts) {
  await scrollAboveCaption(page, testId);
  await assertNotUnderCaption(page, testId, tag, opts);
}

async function markIntentFlow(page, purpose, markId) {
  await page.evaluate(
    ({ purpose, markId }) => {
      const items = document.querySelectorAll('[data-testid="intent-flow"]');
      for (const li of items) {
        const titleEl = li.querySelector('.intent-flow__title');
        const title = titleEl?.textContent ?? '';
        if (title.includes(purpose)) {
          li.setAttribute('data-demo-id', markId);
          return;
        }
      }
      throw new Error(`intent-flow li not found for purpose containing: ${purpose}`);
    },
    { purpose, markId },
  );
}

async function assertSpent(page, tag, expected) {
  let actual = '';
  try {
    await page.waitForFunction(
      ({ exp }) => {
        const gauge = document.querySelector('[data-testid="gauge"]');
        if (!gauge) return false;
        return gauge.innerText.includes(`Spent today ${exp}`);
      },
      { exp: expected },
      { timeout: 6000 },
    );
    actual =
      (await page.evaluate(() => {
        const gauge = document.querySelector('[data-testid="gauge"]');
        const text = gauge?.innerText ?? '';
        const m = text.match(/Spent today\s*(\$[\d,]+\.\d{2})/);
        return m ? m[1] : text;
      })) ?? '';
  } catch {
    actual =
      (await page.evaluate(() => {
        const gauge = document.querySelector('[data-testid="gauge"]');
        const text = gauge?.innerText ?? '';
        const m = text.match(/Spent today\s*(\$[\d,]+\.\d{2})/);
        return m ? m[1] : text;
      })) ?? '';
    spentChecks.push({ tag, expected, actual });
    throw new Error(`Spent today mismatch at ${tag}: expected ${expected}, got ${actual}`);
  }
  spentChecks.push({ tag, expected, actual });
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
  const label = `${scene.id} · ${stripMarkdownBackticks(scene.title)}`;
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

async function highlightSel(page, selector) {
  await page.evaluate((sel) => {
    for (const el of document.querySelectorAll('[data-demo-hl]')) {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.style.borderRadius = '';
      el.removeAttribute('data-demo-hl');
    }
    const el = document.querySelector(sel);
    if (!el) return;
    el.style.outline = '3px solid #facc15';
    el.style.outlineOffset = '4px';
    el.style.borderRadius = '12px';
    el.setAttribute('data-demo-hl', '');
  }, selector);
}

async function highlight(page, testId) {
  await highlightSel(page, `[data-testid="${testId}"]`);
}

async function highlightIntentPanelAndItem(page, itemSelector) {
  await page.evaluate((itemSel) => {
    for (const el of document.querySelectorAll('[data-demo-hl]')) {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.style.borderRadius = '';
      el.removeAttribute('data-demo-hl');
    }
    for (const sel of ['[data-testid="intent-flows"]', itemSel]) {
      const el = document.querySelector(sel);
      if (!el) continue;
      el.style.outline = '3px solid #facc15';
      el.style.outlineOffset = '4px';
      el.style.borderRadius = '12px';
      el.setAttribute('data-demo-hl', '');
    }
  }, itemSelector);
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
  let cmd = 'npm run -s agent -- --scenario small --json';
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
  await stopServers();
  process.exit(code);
}

process.on('SIGINT', () => {
  void handleSignalExit(130);
});
process.on('SIGTERM', () => {
  void handleSignalExit(143);
});

const markdown = fs.readFileSync(videoScriptPath, 'utf8');
const { scenes, totalSeconds: TOTAL_SECONDS } = parseVideoScript(markdown);

if (process.env.PARSE_ONLY === '1') {
  console.log(
    JSON.stringify(
      {
        totalSeconds: TOTAL_SECONDS,
        scenes: scenes.map((s) => ({
          id: s.id,
          num: s.num,
          role: s.role,
          title: s.title,
          start: s.start,
          end: s.end,
          duration: s.duration,
          narrationWordCount: wordCount(s.narration),
          captionChunks: s.captionChunks,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const playwright = await loadPlaywright();
let exitCode = 0;
/** @type {{ id: string; role: string; scene: number; title: string; plannedStart: number; plannedEnd: number; actualStart: number; actualEnd: number }[]} */
const timingLog = [];
/** @type {Record<string, string | undefined>} */
const resolveTimingFields = {};
let seedStdout = '';
let ledgerPath = '';

try {
  ledgerPath = process.env.LEDGER_PATH ?? '';
  if (!ledgerPath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pay-record-'));
    ledgerPath = path.join(dir, 'ledger.json');
  }
  if (fs.existsSync(ledgerPath)) {
    throw new Error(`LEDGER_PATH must be fresh (file already exists): ${ledgerPath}`);
  }

  seedStdout = await runSeed(ledgerPath);
  const { webUrl, apiUrl } = await startServers(ledgerPath);

  const ledgerRes = await fetch(`${apiUrl}/ledger`);
  if (!ledgerRes.ok) {
    throw new Error(`GET /ledger failed: ${ledgerRes.status}`);
  }
  const ledgerBody = await ledgerRes.json();
  const purposes = (ledgerBody.entries ?? []).map((e) => e.intent?.purpose).filter(Boolean);
  for (const need of ['Buy API credits (rail error)', 'Deploy preview (stuck)']) {
    if (!purposes.some((p) => p === need || String(p).includes(need))) {
      throw new Error(`GET /ledger missing seeded purpose "${need}" (got: ${purposes.join(', ')})`);
    }
  }

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

  async function runScene(role, actions) {
    const scene = scenes.find((s) => s.role === role);
    if (!scene) throw new Error(`no scene for role ${role}`);
    const actualStart = (Date.now() - t0) / 1000;
    await actions(scene, () => scheduleSceneCaptions(page, scene));
    await until(scene.end);
    const actualEnd = (Date.now() - t0) / 1000;
    timingLog.push({
      id: scene.id,
      role: scene.role,
      scene: scene.num,
      title: scene.title,
      plannedStart: scene.start,
      plannedEnd: scene.end,
      actualStart,
      actualEnd,
    });
  }

  // Scene 1 — Intro
  await runScene('intro', async (_scene, scheduleCaptions) => {
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
    await assertSpent(page, 's1-end', '$32.00');
  });

  // Scene 2 — $12 paid
  await runScene('paid', async (_scene, scheduleCaptions) => {
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
    await assertNotUnderCaption(page, 'receipt', 'scene2-receipt', FULL);
    await pause(page, 2200);
    await refocusAboveCaption(page, 'receipt', 'scene2-receipt-after-pause', FULL);
    await scrollForGaugeHighlight(page);
    await highlight(page, 'gauge');
    await assertNotUnderCaption(page, 'decision', 'scene2-decision-during-gauge');
    await assertNotUnderCaption(page, 'receipt', 'scene2-receipt-during-gauge', FULL);
    await pause(page, 2000);
    await assertNotUnderCaption(page, 'decision', 'scene2-decision-during-gauge-after-pause');
    await assertNotUnderCaption(page, 'receipt', 'scene2-receipt-during-gauge-after-pause', FULL);
    await assertSpent(page, 's2-end', '$44.00');
  });

  // Scene 3 — rejected
  await runScene('rejected', async (_scene, scheduleCaptions) => {
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
    await assertSpent(page, 's3-end', '$44.00');
  });

  // Scene 4 — needs approval
  await runScene('approval', async (_scene, scheduleCaptions) => {
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
    await assertSpent(page, 's4-end', '$44.00');
  });

  // Scene 5 — approved
  await runScene('approved', async (_scene, scheduleCaptions) => {
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
    await assertNotUnderCaption(page, 'receipt', 'scene5-receipt', FULL);
    await pause(page, 1800);
    await refocusAboveCaption(page, 'receipt', 'scene5-receipt-after-pause', FULL);
    await scrollForGaugeHighlight(page);
    await highlight(page, 'gauge');
    await assertNotUnderCaption(page, 'decision', 'scene5-decision-during-gauge');
    await assertNotUnderCaption(page, 'receipt', 'scene5-receipt-during-gauge', FULL);
    await pause(page, 1500);
    await assertNotUnderCaption(page, 'decision', 'scene5-decision-during-gauge-after-pause');
    await assertNotUnderCaption(page, 'receipt', 'scene5-receipt-during-gauge-after-pause', FULL);
    await assertSpent(page, 's5-end', '$119.00');
  });

  // Scene 6 — ledger zoom
  await runScene('ledger', async (_scene, scheduleCaptions) => {
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

  // Scene 7 — Intents & manual resolve
  await runScene('resolve', async (_scene, scheduleCaptions) => {
    await ensureWebCaptionPadding(page);
    scheduleCaptions();
    await clearHighlights(page);
    await scrollToTop(page);

    const intentSel = '[data-demo-id="needs-check"]';
    await markIntentFlow(page, 'Buy API credits (rail error)', 'needs-check');
    await scrollAboveCaptionSel(page, intentSel);
    await highlightIntentPanelAndItem(page, intentSel);
    await assertSelNotUnderCaption(page, intentSel, 's7-intent-needs-check', FULL);
    resolveTimingFields.resolveChipBefore = await page.evaluate((sel) => {
      const li = document.querySelector(sel);
      return li?.querySelector('.intent-flow__chip')?.innerText?.trim() ?? '';
    }, intentSel);
    await assertSpent(page, 's7-start', '$119.00');
    await pause(page, 2500);

    await page
      .getByRole('button', { name: 'Resolve Buy API credits (rail error)' })
      .click();
    await page.getByTestId('resolve-form').waitFor({ state: 'visible' });
    await pause(page, 600);
    await waitScrollSettled(page);

    await scrollAboveCaption(page, 'decision');
    resolveTimingFields.outcomeBadgeBefore = (
      await page.getByTestId('result-status').innerText()
    ).trim();
    if (!/needs check/i.test(resolveTimingFields.outcomeBadgeBefore)) {
      throw new Error(
        `expected result-status needs check before resolve, got "${resolveTimingFields.outcomeBadgeBefore}"`,
      );
    }
    await pause(page, 1500);

    await scrollAboveCaption(page, 'resolve-form');
    await highlight(page, 'resolve-form');
    await assertNotUnderCaption(page, 'resolve-form', 's7-resolve-form', FULL);

    await page.getByTestId('resolve-status-failed').click();
    const noteEl = page.getByTestId('resolve-note');
    await noteEl.click();
    await noteEl.pressSequentially('No charge on the rail dashboard', { delay: 30 });
    const byEl = page.getByTestId('resolve-by');
    await byEl.click();
    await byEl.fill('');
    await byEl.pressSequentially('ops-bob', { delay: 40 });

    await assertNotUnderCaption(page, 'resolve-form', 's7-resolve-form-filled', FULL);
    const submitText = (await page.getByTestId('btn-resolve-submit').innerText()).trim();
    if (submitText !== 'Record outcome') {
      throw new Error(`resolve submit button text must be "Record outcome" (got "${submitText}")`);
    }
    await pause(page, 500);
    await page.getByTestId('btn-resolve-submit').click();

    const resolveErr = page.getByTestId('resolve-error');
    if (await resolveErr.isVisible().catch(() => false)) {
      throw new Error(await resolveErr.innerText());
    }

    await page.getByTestId('resolve-success').waitFor({ state: 'visible', timeout: 8000 });
    const successText = (await page.getByTestId('resolve-success').innerText()).trim();
    if (successText !== 'Resolved as failed by ops-bob.') {
      throw new Error(`unexpected resolve-success text: "${successText}"`);
    }
    resolveTimingFields.resolveBanner = successText;
    await waitScrollSettled(page);

    await page.getByTestId('payment-outcome-text').waitFor({ state: 'visible' });
    resolveTimingFields.resolveOutcome = (
      await page.getByTestId('payment-outcome-text').innerText()
    ).trim();
    if (resolveTimingFields.resolveOutcome !== 'Payment failed — resolved by ops-bob') {
      throw new Error(`unexpected payment-outcome-text: "${resolveTimingFields.resolveOutcome}"`);
    }

    resolveTimingFields.resolveBadge = (await page.getByTestId('result-status').innerText()).trim();
    if (!/^failed$/i.test(resolveTimingFields.resolveBadge)) {
      throw new Error(`expected result-status failed after resolve, got "${resolveTimingFields.resolveBadge}"`);
    }

    await scrollAboveCaption(page, 'resolve-success');
    await assertNotUnderCaption(page, 'resolve-success', 's7-resolve-success', FULL);
    await highlight(page, 'resolve-success');
    await pause(page, 1500);

    await scrollAboveCaption(page, 'payment-outcome');
    await highlight(page, 'payment-outcome');
    await assertNotUnderCaption(page, 'payment-outcome', 's7-payment-outcome', FULL);
    await pause(page, 1500);

    await markIntentFlow(page, 'Buy API credits (rail error)', 'needs-check');
    const resolutionText = await page.evaluate((sel) => {
      const li = document.querySelector(sel);
      return li?.querySelector('[data-testid="intent-resolution"]')?.innerText?.trim() ?? '';
    }, intentSel);
    if (
      !resolutionText.includes('Resolved failed by ops-bob · No charge on the rail dashboard')
    ) {
      throw new Error(`unexpected intent-resolution: "${resolutionText}"`);
    }
    await scrollAboveCaptionSel(page, intentSel);
    await assertSelNotUnderCaption(page, intentSel, 's7-intent-resolved', FULL);
    await highlightIntentPanelAndItem(page, intentSel);
    await assertSpent(page, 's7-end', '$107.00');
  });

  // Scene 8 — CLI
  await runScene('cli', async (scene, scheduleCaptions) => {
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
    const revealBudgetMs = Math.max(
      0,
      (scene.end - 6 - 1) * 1000 - (Date.now() - t0),
    );
    const perLine = Math.min(
      600,
      Math.max(150, Math.floor(revealBudgetMs / Math.max(1, lineCount))),
    );
    for (let i = 0; i < lineCount; i++) {
      await page.evaluate((idx) => {
        const el = document.getElementById(`line-${idx}`);
        if (el) el.style.visibility = 'visible';
      }, i);
      await pause(page, perLine);
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

  await until(TOTAL_SECONDS + 0.3);

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
  const timingPayload = {
    totalSeconds: TOTAL_SECONDS,
    ledgerPath,
    seedStdout,
    spentChecks,
    ...resolveTimingFields,
    t0,
    scenes: timingLog,
    captionOverlapChecks,
  };
  const timingJson = `${JSON.stringify(timingPayload, null, 2)}\n`;
  fs.writeFileSync(timingPath, timingJson);
  if (process.env.TIMING_OUT) {
    fs.writeFileSync(process.env.TIMING_OUT, timingJson);
  }

  const captionFailing = captionOverlapChecks.filter(
    (c) => c.overlap || (c.requireFullyVisible && !c.fullyVisible),
  );
  console.log(
    `caption checks: ${captionOverlapChecks.length} total, ${captionFailing.length} failing`,
  );

  for (const row of timingLog) {
    console.log(
      `${row.id} (${row.role}, ${row.title}): planned ${row.plannedStart.toFixed(1)}–${row.plannedEnd.toFixed(1)}s, actual ${row.actualStart.toFixed(2)}–${row.actualEnd.toFixed(2)}s`,
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
  await stopServers();
}

process.exit(exitCode);
