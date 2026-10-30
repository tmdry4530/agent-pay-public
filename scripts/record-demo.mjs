import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const demoScript = path.join(repoRoot, 'scripts', 'demo.mjs');

/** @type {import('playwright').ChromiumBrowser | null} */
let browser = null;
/** @type {import('node:child_process').ChildProcess | null} */
let demoChild = null;

const pageErrors = [];
const consoleErrors = [];

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

function startDemoAndWaitForReady() {
  return new Promise((resolve, reject) => {
    const readyRe = /agent-pay demo ready:\s*(https?:\/\/[^\s]+)/;
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
          if (m) finish(resolve, m[1]);
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

async function caption(page, text) {
  await page.evaluate((t) => {
    let el = document.getElementById('demo-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      el.style.cssText =
        'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
        'background:rgba(0,0,0,0.75);color:#fff;font:20px/1.4 system-ui,sans-serif;' +
        'padding:12px 20px;border-radius:12px;z-index:9999;pointer-events:none;' +
        'max-width:760px;text-align:center;';
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

async function pause(page, ms) {
  if (typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms);
  } else {
    await new Promise((r) => setTimeout(r, ms));
  }
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
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, testId);
}

let signalExitCode = null;

async function handleSignalExit(code) {
  if (signalExitCode !== null) return;
  signalExitCode = code;
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

const playwright = await loadPlaywright();
let demoUrl;
let exitCode = 0;

try {
  demoUrl = await startDemoAndWaitForReady();

  const OUT =
    process.env.DEMO_VIDEO || path.join(repoRoot, 'docs', 'demo', 'agent-pay-demo.webm');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const videoTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pay-demo-video-'));

  browser = await playwright.chromium.launch({ slowMo: 250 });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: {
      dir: videoTempDir,
      size: { width: 1280, height: 800 },
    },
  });

  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto(demoUrl, { waitUntil: 'domcontentloaded' });

  await caption(
    page,
    'agent-pay: AI agent payments within a spending policy — mock rail, no real funds',
  );
  await pause(page, 4000);

  await highlight(page, 'gauge');
  await caption(page, 'Daily spend gauge vs policy max');
  await pause(page, 3000);

  await page.getByTestId('scenario-approved').click();
  await caption(page, '$12 API credits — within limits');
  await pause(page, 1500);
  await page.getByTestId('btn-quote').click();
  await caption(page, 'Quote from mock rail');
  await pause(page, 1500);
  await page.getByTestId('btn-policy').click();
  await pause(page, 1500);
  await page.getByTestId('result-status').waitFor({ state: 'visible' });
  await caption(page, 'Policy check: within policy → paid immediately');
  await highlight(page, 'decision');
  await pause(page, 1500);
  await page.getByTestId('receipt').waitFor({ state: 'visible' });
  await highlight(page, 'receipt');
  await caption(page, 'Paid within policy — receipt issued');
  await pause(page, 4000);

  await page.getByTestId('scenario-rejected').click();
  await caption(page, '$480 GPU cluster — over the per-tx limit?');
  await pause(page, 1500);
  await page.getByTestId('btn-quote').click();
  await pause(page, 1500);
  await page.getByTestId('btn-policy').click();
  await page.getByTestId('result-status').waitFor({ state: 'visible' });
  await highlight(page, 'decision');
  await caption(page, 'Over the $100 per-transaction limit — rejected, no payment');
  await pause(page, 4000);

  await page.getByTestId('scenario-needs-approval').click();
  await caption(page, '$75 NEAR compute — above the approval threshold?');
  await pause(page, 1500);
  await page.getByTestId('btn-quote').click();
  await pause(page, 1500);
  await page.getByTestId('btn-policy').click();
  await page.getByTestId('result-status').waitFor({ state: 'visible' });
  await highlight(page, 'decision');
  await caption(page, 'Above the $50 approval threshold — needs human approval');
  await pause(page, 4000);
  await caption(page, 'Human approves…');
  await pause(page, 2000);
  await highlight(page, 'btn-approve');
  await page.getByTestId('btn-approve').click();
  await page.getByTestId('human-outcome').waitFor({ state: 'visible' });
  await page.getByTestId('receipt').waitFor({ state: 'visible' });
  await highlight(page, 'receipt');
  await caption(page, 'Approved by a human — paid with receipt');
  await pause(page, 4000);

  await highlight(page, 'ledger');
  const ledger = page.getByTestId('ledger');
  await ledger.hover();
  await caption(page, 'Ledger timeline: every intent, decision, approval and receipt');
  await pause(page, 5000);

  await highlight(page, 'gauge');
  await caption(page, 'Spent today vs daily max read from GET /policy');
  await pause(page, 3000);

  const video = page.video();
  await page.close();
  await context.close();

  if (video) {
    const srcPath = await video.path();
    fs.copyFileSync(srcPath, OUT);
  }
  fs.rmSync(videoTempDir, { recursive: true, force: true });
  await browser.close();
  browser = null;

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
  await stopDemoRunner();
}

process.exit(exitCode);
