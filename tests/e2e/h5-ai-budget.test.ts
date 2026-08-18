/**
 * H5.2 — AI budget live proof (real Chrome, real extension, loopback planner).
 *
 * The t44 fixture injects four waves of ambiguous third-party survivors on ONE
 * navigation; each wave's observation batch reaches the survivor-AI gate. The
 * per-navigation budget must cap planner calls at exactly 2 and gate the third
 * evaluation AI_BUDGET_EXHAUSTED. The planner is the PRODUCTION RemotePlanner
 * pointed at a loopback capture server — the same transport the real endpoint
 * uses — so the request count is the ground-truth spend.
 *
 * Artifact: artifacts/h5/H5_AI_BUDGET.json
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import puppeteer, { Browser } from 'puppeteer';
import { startTestServers, TestServerInstances } from '../pages/server';
import { chromeExecutable } from '../support/chrome-executable';
import { verificationMetadata } from '../../scripts/verification-metadata';

describe('H5.2 AI budget live proof', () => {
  let browser: Browser;
  let servers: TestServerInstances;
  const extensionPath = path.resolve(__dirname, '../../dist');
  const app = 'http://localhost:4080';
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function workerEvaluate<T>(expression: string): Promise<T | undefined> {
    const candidates = browser.targets().filter((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
    for (const candidate of candidates) {
      let session;
      try {
        session = await candidate.createCDPSession();
        const result = (await Promise.race([
          session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
          sleep(4_000).then(() => null),
        ])) as { result?: { value?: T }; exceptionDetails?: unknown } | null;
        if (result && !result.exceptionDetails) return result.result?.value;
      } catch {
        /* try the next candidate */
      } finally {
        await session?.detach().catch(() => undefined);
      }
    }
    return undefined;
  }

  async function workerEvaluateRetry<T>(expression: string, attempts = 8, gapMs = 700): Promise<T | undefined> {
    for (let i = 0; i < attempts; i++) {
      const value = await workerEvaluate<T>(expression);
      if (value !== undefined) return value;
      await sleep(gapMs);
    }
    return undefined;
  }

  /** Worker-independent forensics read: storage.session is reachable from any
   * extension page, even when the service worker is idle/dead. */
  async function readForensicsViaOptionsPage(): Promise<{
    started?: number;
    budgetGated?: number;
    counters?: Record<string, number>;
    aiEvents?: string;
  } | undefined> {
    const target = browser.targets().find((t) => t.url().startsWith('chrome-extension://'));
    let extensionId = '';
    try { extensionId = target ? new URL(target.url()).host : ''; } catch { /* fall through */ }
    if (!extensionId) return undefined;
    const diag = await browser.newPage();
    try {
      await diag.goto(`chrome-extension://${extensionId}/options/index.html`, { waitUntil: 'domcontentloaded' });
      return await diag.evaluate(async () => {
        const f = (await chrome.storage.session.get(null)).adapt_kimi_forensics_v1 as
          | { counters?: Record<string, number>; events?: Array<{ kind?: string }> }
          | undefined;
        const counters = f && f.counters ? f.counters : {};
        const aiEvents = f && f.events
          ? f.events.filter((e) => String(e.kind).startsWith('AI_') || String(e.kind) === 'SURVIVORS_OBSERVED')
          : [];
        return {
          started: counters['aiCallsStarted'] ?? 0,
          budgetGated: counters['aiSkip.AI_BUDGET_EXHAUSTED'] ?? 0,
          counters,
          aiEvents: JSON.stringify(aiEvents).slice(0, 2400),
        };
      });
    } finally {
      await diag.close().catch(() => undefined);
    }
  }

  let plannerRequests: number;
  let plannerServer: http.Server;
  let plannerPort: number;

  beforeAll(async () => {
    servers = await startTestServers(4080, 4081);
    plannerRequests = 0;
    plannerServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        plannerRequests += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          plan: {
            schemaVersion: 1,
            decision: 'ABSTAIN',
            hypothesis: { category: 'UNKNOWN', confidence: 0.5, explanation: 'budget probe' },
            selectedStrategyTier: 'ABSTAIN',
            actions: [],
            verification: { expectedHealthDelta: 0, maxWaitMs: 500 },
            abortConditions: [],
            explanationCodes: [],
          },
        }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      plannerServer.once('error', reject);
      plannerServer.listen(0, '127.0.0.1', () => resolve());
    });
    plannerPort = (plannerServer.address() as AddressInfo).port;

    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromeExecutable(),
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--headless=new',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-sandbox',
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await servers?.close().catch(() => undefined);
    await new Promise<void>((resolve) => plannerServer?.close(() => resolve()));
  });

  it('four survivor waves on one navigation spend exactly 2 planner calls; the third is gated', async () => {
    // Point the production planner wiring at the loopback capture server via an
    // extension PAGE, not the service worker: chrome.storage.local is writable
    // from any extension page, so this never depends on MV3 worker liveness
    // (an idle-killed worker answers no evaluates until a page event restarts
    // it; a static wake page may emit none). The worker picks the config up via
    // storage.onChanged when alive, or via loadConfiguredPlanner at its next
    // boot — the t44 navigation's events guarantee a boot.
    const swTarget = await browser.waitForTarget(
      (t) => t.url().startsWith('chrome-extension://'),
      { timeout: 20_000 }
    );
    const extensionId = new URL(swTarget.url()).host;
    const configPage = await browser.newPage();
    let configured = false;
    try {
      await configPage.goto(`chrome-extension://${extensionId}/options/index.html`, { waitUntil: 'domcontentloaded' });
      configured = await configPage.evaluate(async (port) => {
        await chrome.storage.local.set({
          adapt_ai_config: {
            endpoint: `http://127.0.0.1:${port}/plan`,
            privacyMode: 'STRICT',
            timeoutMs: 5000,
          },
        });
        const verify = await chrome.storage.local.get('adapt_ai_config');
        return (verify.adapt_ai_config as { endpoint?: string } | undefined)?.endpoint === `http://127.0.0.1:${port}/plan`;
      }, plannerPort);
    } finally {
      await configPage.close().catch(() => undefined);
    }
    expect(configured).toBe(true);

    const page = await browser.newPage();
    await page.evaluateOnNewDocument(`window.__adPort = 4081;`);
    await page.goto(`${app}/t44-ai-budget/index.html`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => (window as any).__budget_done === true, { timeout: 30_000 });
    // Let the final gate evaluation settle.
    await sleep(2_000);

    expect(await page.evaluate(() => (window as any).__waves_injected)).toBe(4);

    let forensicsState = await workerEvaluateRetry<{
      started?: number;
      budgetGated?: number;
      counters?: Record<string, number>;
      aiEvents?: string;
    }>(
      `(async () => {
        const f = (await chrome.storage.session.get(null)).adapt_kimi_forensics_v1;
        const counters = f && f.counters ? f.counters : {};
        const aiEvents = f && f.events
          ? f.events.filter((e: { kind?: string }) => String(e.kind).startsWith('AI_') || String(e.kind) === 'SURVIVORS_OBSERVED')
          : [];
        return {
          started: counters['aiCallsStarted'] ?? 0,
          budgetGated: counters['aiSkip.AI_BUDGET_EXHAUSTED'] ?? 0,
          counters,
          aiEvents: JSON.stringify(aiEvents).slice(0, 2400),
        };
      })()`
    );
    if (!forensicsState) forensicsState = await readForensicsViaOptionsPage();
    // Ground-truth spend at the transport: exactly two wire calls.
    expect(plannerRequests, `planner wire calls; forensics=${JSON.stringify(forensicsState)?.slice(0, 2200)}`).toBe(2);

    expect(forensicsState?.started).toBe(2);
    expect(forensicsState?.budgetGated).toBeGreaterThanOrEqual(1);

    mkdirSync(path.resolve(__dirname, '../../artifacts/h5'), { recursive: true });
    writeFileSync(
      path.resolve(__dirname, '../../artifacts/h5/H5_AI_BUDGET.json'),
      `${JSON.stringify(
        {
          schema: 'adapt-h5-ai-budget-v1',
          ...verificationMetadata(path.resolve(__dirname, '../..')),
          verdict: 'PASS',
          plannerWireCalls: plannerRequests,
          forensics: forensicsState,
          waves: 4,
          claim: 'One navigation triggers >=3 survivor-AI gate evaluations; exactly 2 planner calls reach the wire; the third is gated AI_BUDGET_EXHAUSTED.',
        },
        null,
        2
      )}\n`
    );
    await page.close();
  }, 90_000);
});
