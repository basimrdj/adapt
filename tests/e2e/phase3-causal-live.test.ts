import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { Browser, Target } from 'puppeteer';
import { startTestServers, TestServerInstances } from '../pages/server';

function chromeExecutable(): string {
  const chromeDir = path.resolve(__dirname, '../../chrome');
  if (fs.existsSync(chromeDir)) {
    for (const sub of fs.readdirSync(chromeDir)) {
      const candidate = path.join(chromeDir, sub, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

describe('Phase 3 causal runtime in real Chromium', () => {
  let browser: Browser;
  let servers: TestServerInstances;
  let workerTarget: Target;
  const extensionPath = path.resolve(__dirname, '../../dist');

  beforeAll(async () => {
    servers = await startTestServers(4010, 4011);
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromeExecutable(),
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--headless=new', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox'],
    });
    workerTarget = await browser.waitForTarget(
      (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
      { timeout: 10_000 }
    );
  });

  afterAll(async () => {
    await browser?.close();
    await servers?.close();
  });

  async function sessionValue<T>(key: string): Promise<T | undefined> {
    let target = workerTarget;
    let worker = await target.worker().catch(() => null);
    if (!worker) {
      target = await browser.waitForTarget((item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'));
      workerTarget = target;
      worker = await target.worker();
    }
    if (!worker) throw new Error('extension service worker unavailable');
    return worker.evaluate(async (storageKey) => {
      const result = await chrome.storage.session.get([storageKey]);
      return result[storageKey] as T | undefined;
    }, key);
  }

  async function waitSessionValue<T>(key: string, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await sessionValue<T>(key).catch(() => undefined);
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`session key ${key} was not written within ${timeoutMs}ms`);
  }

  async function waitSessionMatch<T>(
    key: string,
    predicate: (value: T) => boolean,
    timeoutMs = 5000
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await sessionValue<T>(key).catch(() => undefined);
      if (value !== undefined && predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`session key ${key} did not satisfy its predicate within ${timeoutMs}ms`);
  }

  it('persists causal graphs and real experiment records in chrome.storage.session', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('http://localhost:4010/t28-causal-bait/index.html', { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 1800));

    const state = await waitSessionValue<{ graphs: Array<{ nodes: unknown[]; hypotheses: unknown[] }> }>('adapt_causal_session_state_v1');
    const experiments = await waitSessionMatch<Record<string, {
      txId: string;
      record: { status: string; rollbackVerified: boolean };
    }>>(
      'adapt_causal_experiments_v1',
      (value) => Object.values(value).some(
        (entry) => entry.record.status !== 'STAGED' && entry.record.rollbackVerified
      )
    );
    expect(state.graphs.length).toBeGreaterThan(0);
    expect(state.graphs.some((graph) => graph.nodes.length > 0 && graph.hypotheses.length > 0)).toBe(true);
    const records = Object.values(experiments);
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((entry) => entry.record.status !== 'STAGED' && entry.record.rollbackVerified)).toBe(true);
    expect(records.filter((entry) => entry.record.status === 'STAGED').every((entry) => entry.txId.length > 0)).toBe(true);
    await page.close();
  });

  it('keeps documentId stable for SPA history and changes it on a document commit', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4010/t08-spa-transitions/index.html', { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const before = await sessionValue<{ navigation: { epochs: Array<{ tabId: number; frameId: number; documentId: string; navigationEpoch: number; url: string }> } }>('adapt_causal_session_state_v1');
    const tabEpoch = before?.navigation.epochs.find((epoch) => epoch.frameId === 0 && epoch.url.includes('t08-spa-transitions'));
    expect(tabEpoch).toBeDefined();
    await page.click('#link-article');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const spa = await sessionValue<typeof before>('adapt_causal_session_state_v1');
    const spaEpoch = spa?.navigation.epochs.find((epoch) => epoch.tabId === tabEpoch?.tabId && epoch.frameId === 0);
    expect(spaEpoch?.documentId).toBe(tabEpoch?.documentId);
    expect(spaEpoch!.navigationEpoch).toBeGreaterThan(tabEpoch!.navigationEpoch);
    await page.goto('http://localhost:4010/t01-basic-ad/index.html', { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const committed = await sessionValue<typeof before>('adapt_causal_session_state_v1');
    const committedEpoch = committed?.navigation.epochs.find((epoch) => epoch.tabId === tabEpoch?.tabId && epoch.frameId === 0);
    expect(committedEpoch?.documentId).not.toBe(tabEpoch?.documentId);
    await page.close();
  });

  it('restores session state after forcibly stopping the MV3 service worker', async () => {
    const before = await sessionValue<{ savedWallMs: number; navigation: { counters: Array<[number, number]> } }>('adapt_causal_session_state_v1');
    expect(before).toBeDefined();
    const page = await browser.newPage();
    const cdp = await workerTarget.createCDPSession();
    await cdp.send('Runtime.terminateExecution');
    await cdp.detach();
    await page.goto('http://localhost:4010/t01-basic-ad/index.html', { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    workerTarget = await browser.waitForTarget((target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'), { timeout: 10_000 });
    const after = await waitSessionValue<typeof before>('adapt_causal_session_state_v1');
    expect(after).toBeDefined();
    expect(after!.navigation.counters.length).toBeGreaterThan(0);
    expect(after!.savedWallMs).toBeGreaterThanOrEqual(before!.savedWallMs);
    await page.close();
  });
});
