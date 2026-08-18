/**
 * Per-site pause control, end to end in real Chromium.
 *
 * Pins the full loop: baseline block by the static plane → user pause installs
 * a durable allowAllRequests allowance and the blocked resource stops being
 * extension-blocked → resume restores blocking → the allowance survives a full
 * browser restart (durable DYNAMIC rules, unlike session-only transaction
 * rules). Runs on a 127.0.0.1 fixture, which also exercises the IPv4
 * `||host` urlFilter branch of the pause rule builder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import puppeteer, { Browser, Target } from 'puppeteer';
import { chromeExecutable } from '../support/chrome-executable';

const TRACKER_URL = 'https://doubleclick.net/pause-fixture-pixel.js';

const FIXTURE_HTML = `<!doctype html><html><head><title>pause fixture</title></head>
<body><main><h1>Pause fixture</h1></main>
<script src="${TRACKER_URL}"></script>
</body></html>`;

function startFixtureServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(FIXTURE_HTML);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('fixture server failed to bind'));
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function launchBrowser(userDataDir?: string): Promise<Browser> {
  const extensionPath = path.resolve(__dirname, '../../dist');
  return puppeteer.launch({
    headless: false,
    executablePath: chromeExecutable(),
    userDataDir,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--headless=new', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox'],
  });
}

async function extensionWorker(browser: Browser): Promise<Target> {
  // Match our service worker by script name — a fresh persistent profile can
  // briefly expose component-extension workers before ours is ready.
  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === 'service_worker' && /chrome-extension:\/\/[^/]+\/background\.js$/.test(candidate.url()),
    { timeout: 15_000 }
  );
  // The extension API bindings must be live before evaluate touches chrome.storage.
  // 30s: profile-restore restarts on a loaded machine can take well past 10s.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const worker = await target.worker().catch(() => null);
    if (worker) {
      const ready = await worker.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage?.local).catch(() => false);
      if (ready) return target;
    }
    if (Date.now() > deadline) throw new Error('extension service worker never became ready');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function workerEval<T>(browser: Browser, fn: () => T): Promise<T> {
  const target = await extensionWorker(browser);
  const worker = await target.worker();
  if (!worker) throw new Error('extension service worker unavailable');
  return worker.evaluate(fn) as Promise<T>;
}

async function pauseBandRuleHosts(browser: Browser): Promise<string[]> {
  return workerEval(browser, async () => {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return rules
      .filter((rule) => rule.id >= 5_010_000 && rule.id <= 5_019_999)
      .map((rule) => rule.condition.requestDomains?.[0] ?? rule.condition.urlFilter?.replace(/^\|\|/, '') ?? '?');
  });
}

async function waitBandHosts(browser: Browser, expected: string[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hosts = await pauseBandRuleHosts(browser).catch(() => [] as string[]);
    if (hosts.length === expected.length && expected.every((host) => hosts.includes(host))) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`pause band did not settle to [${expected.join(', ')}] within ${timeoutMs}ms`);
}

/** Failure reason Chrome reports for the fixture's tracker request on the next load. */
async function trackerFailureReason(browser: Browser, fixtureUrl: string): Promise<string | null> {
  const page = await browser.newPage();
  try {
    const failure = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 12_000);
      page.on('requestfailed', (request) => {
        if (request.url().startsWith('https://doubleclick.net/')) {
          clearTimeout(timer);
          resolve(request.failure()?.errorText ?? null);
        }
      });
    });
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
    return await failure;
  } finally {
    await page.close().catch(() => undefined);
  }
}

describe('per-site pause control (real Chromium)', () => {
  let fixture: { port: number; close: () => Promise<void> };
  let browser: Browser;
  let fixtureUrl: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    fixtureUrl = `http://127.0.0.1:${fixture.port}/pause-fixture`;
    browser = await launchBrowser();
    await extensionWorker(browser);
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
  });

  it('baseline: the static plane blocks the tracker (ERR_BLOCKED_BY_CLIENT)', async () => {
    const reason = await trackerFailureReason(browser, fixtureUrl);
    expect(reason).toBe('net::ERR_BLOCKED_BY_CLIENT');
  }, 40_000);

  it('pause: the DNR allowance lands in the pause band and the tracker is no longer extension-blocked', async () => {
    await workerEval(browser, async () => {
      await chrome.storage.local.set({ adapt_paused_hosts: ['127.0.0.1'] });
    });
    await waitBandHosts(browser, ['127.0.0.1']);
    const reason = await trackerFailureReason(browser, fixtureUrl);
    // DNS fails instead of the extension block — the static plane stood down.
    expect(reason).not.toBeNull();
    expect(reason).not.toBe('net::ERR_BLOCKED_BY_CLIENT');
  }, 60_000);

  it('resume: removing the host withdraws the allowance and blocking returns', async () => {
    await workerEval(browser, async () => {
      await chrome.storage.local.set({ adapt_paused_hosts: [] });
    });
    await waitBandHosts(browser, []);
    const reason = await trackerFailureReason(browser, fixtureUrl);
    expect(reason).toBe('net::ERR_BLOCKED_BY_CLIENT');
  }, 60_000);

  it('main-world popup broker disarms while paused and is restored on resume', async () => {
    // The stand-down reaches the MAIN-world broker via the content script's
    // storage read + postMessage — an async path that can lose to a fast
    // domcontentloaded on a slow machine. Poll for the expected state instead
    // of racing it.
    const openSource = async (expectNative: boolean): Promise<string> => {
      const page = await browser.newPage();
      try {
        await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        const deadline = Date.now() + 8_000;
        let source = '';
        while (Date.now() < deadline) {
          source = await page.evaluate(() => window.open.toString());
          if (source.includes('[native code]') === expectNative) return source;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return source;
      } finally {
        await page.close().catch(() => undefined);
      }
    };
    // Unpaused: the broker wraps window.open (a JS function, not the native one).
    expect(await openSource(false)).not.toContain('[native code]');
    await workerEval(browser, async () => {
      await chrome.storage.local.set({ adapt_paused_hosts: ['127.0.0.1'] });
    });
    await waitBandHosts(browser, ['127.0.0.1']);
    // Paused: the stand-down message disarmed the broker and restored native open.
    expect(await openSource(true)).toContain('[native code]');
    await workerEval(browser, async () => {
      await chrome.storage.local.set({ adapt_paused_hosts: [] });
    });
    await waitBandHosts(browser, []);
    expect(await openSource(false)).not.toContain('[native code]');
  }, 60_000);

  it('durable: a pause survives a full browser restart', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-pause-profile-'));
    let first: Browser | undefined;
    let second: Browser | undefined;
    try {
      first = await launchBrowser(profileDir);
      await extensionWorker(first);
      await workerEval(first, async () => {
        await chrome.storage.local.set({ adapt_paused_hosts: ['127.0.0.1'] });
      });
      await waitBandHosts(first, ['127.0.0.1']);
      await first.close();
      first = undefined;

      second = await launchBrowser(profileDir);
      await extensionWorker(second);
      // The stored list and the durable dynamic rule both survive; startup
      // reconcile keeps the band in place (fail open only where the user asked).
      await waitBandHosts(second, ['127.0.0.1']);
      const stored = await workerEval(second, async () => {
        const data = await chrome.storage.local.get(['adapt_paused_hosts']);
        return data.adapt_paused_hosts as string[] | undefined;
      });
      expect(stored).toEqual(['127.0.0.1']);
    } finally {
      await first?.close().catch(() => undefined);
      await second?.close().catch(() => undefined);
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }, 120_000);
});
