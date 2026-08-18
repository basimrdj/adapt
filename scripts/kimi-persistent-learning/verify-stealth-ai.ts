/**
 * PHASE D2b VERIFICATION — AI-learned anti-detector counter-constants.
 *
 * A self-hosted NOVEL detector the deterministic stealth kit has never seen:
 * a third-party "vendor" script arms a custom global (window.novDetectLabs) and,
 * unless disarmed, throws up a fullscreen "AdBlock Detected" wall. The deterministic
 * plane cannot know the flag name; the survivor-AI pipeline must:
 *
 *   1. observe the anti-block reaction (wall = ANTI_BLOCK_REACTION survivor),
 *   2. get STEALTH_SET_CONSTANT offered in availableActions (reaction-gated),
 *   3. plan a counter-constant (novDetectLabs.disarmed=true) + overlay removal,
 *   4. apply the constant in the MAIN world, verify health improved,
 *   5. PERSIST the constant per site (durable, restart-proof),
 *   6. on revisit: replay the constant before the vendor script's check runs —
 *      the wall never appears, and with no survivor and only one third-party
 *      candidate the planner is never invoked again (zero AI).
 *
 * Asserts: AI fired on visit 1; wall removed; constant persisted to storage.local;
 * visits 2 and 3 (full browser restart) show no wall and make ZERO new AI calls.
 *
 * Run: npm run build && npx tsx scripts/kimi-persistent-learning/verify-stealth-ai.ts
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { Browser } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const root = process.cwd();
const extensionPath = path.join(root, 'dist');
const artifactPath = path.join(root, 'artifacts', 'kimi-persistent-learning', 'STEALTH_AI_PROOF.json');
const RELAY_TOKEN = `dev-mock-token-${Math.random().toString(36).slice(2, 12)}`;

const HOSTS = ['detector-site.test', 'detector-vendor.test'];

let relayCalls = 0;
let lastPlanActions: unknown[] = [];

async function startRelay(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/plan') {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${RELAY_TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      relayCalls++;
      try {
        const evidence = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          availableActions?: string[];
          candidateElements?: Array<{ ref: string; role: string }>;
          observedReaction?: { antiBlockConfidence?: number };
        };
        const available = new Set(evidence.availableActions ?? []);
        const elements = evidence.candidateElements ?? [];
        const wall = elements.find((element) => element.role === 'ANTI_BLOCK_REACTION') ?? elements[0];
        if (available.has('STEALTH_SET_CONSTANT') && wall && available.has('DOM_REMOVE_OVERLAY')) {
          const actions = [
            { actionType: 'DOM_REMOVE_OVERLAY', targetRef: wall.ref, parameter: '' },
            { actionType: 'STEALTH_SET_CONSTANT', targetRef: '', parameter: 'novDetectLabs.disarmed=true' },
          ];
          lastPlanActions = actions;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            plan: {
              schemaVersion: 1,
              decision: 'ADAPT',
              hypothesis: { category: 'UNKNOWN', confidence: 0.85, explanation: 'anti-block reaction with unknown flag gate' },
              selectedStrategyTier: 'S2',
              actions,
              verification: { expectedHealthDelta: 0.2, maxWaitMs: 1500 },
              abortConditions: [],
              explanationCodes: ['STEALTH_COUNTER_CONSTANT'],
            },
          }));
          return;
        }
        lastPlanActions = [{ actionType: 'ABSTAIN', targetRef: '', parameter: '' }];
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          plan: {
            schemaVersion: 1,
            decision: 'ABSTAIN',
            hypothesis: { category: 'UNKNOWN', confidence: 0.9, explanation: 'no anti-block reaction' },
            selectedStrategyTier: 'ABSTAIN',
            actions: [{ actionType: 'ABSTAIN', targetRef: '', parameter: '' }],
            verification: { expectedHealthDelta: 0, maxWaitMs: 500 },
            abortConditions: [],
            explanationCodes: [],
          },
        }));
      } catch {
        response.writeHead(502).end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return { port: (server.address() as { port: number }).port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function startSite(): Promise<{ port: number; close: () => Promise<void> }> {
  let serverPort = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://detector-site.test');
    if (url.pathname === '/detector.js') {
      // The novel vendor detector: arms a custom global; unless disarmed, walls the
      // page — and FIGHTS BACK like real hardened detectors: a MutationObserver plus
      // a 1s timer re-insert/re-show the wall whenever something hides or removes it.
      // Deterministic overlay-hiding alone can never resolve this; only learning the
      // counter-flag (novDetectLabs.disarmed=true) ends the fight.
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(`
        window.novDetectLabs = window.novDetectLabs || { armed: true };
        function novEnsureWall() {
          if (window.novDetectLabs.disarmed === true) return;
          var wall = document.getElementById('novelWall');
          if (!wall) {
            wall = document.createElement('div');
            wall.id = 'novelWall';
            wall.textContent = 'AdBlock Detected! Please disable your ad blocker to continue.';
            (document.body || document.documentElement).appendChild(wall);
          }
          if (wall.style.display !== 'flex') {
            wall.style.cssText = 'position:fixed;inset:0;background:#111;color:#fff;z-index:2147483647;'
              + 'display:flex;align-items:center;justify-content:center;font-size:28px;';
          }
        }
        setTimeout(function () {
          if (window.novDetectLabs.disarmed === true) return;
          novEnsureWall();
          try {
            new MutationObserver(function () { novEnsureWall(); })
              .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
          } catch (e) {}
          setInterval(novEnsureWall, 1000);
        }, 800);
      `);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>novel detector site</title></head>
<body><h1>Content people want</h1><p>Article body text.</p>
<script src="http://detector-vendor.test:${serverPort}/detector.js"></script>
</body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  serverPort = (server.address() as { port: number }).port;
  return { port: serverPort, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function launchBrowser(userDataDir: string): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    executablePath: chromeExecutable(root),
    userDataDir,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--host-resolver-rules=${HOSTS.map((host) => `MAP ${host} 127.0.0.1`).join(',')}`,
    ],
  });
}

async function evaluateWorker<T>(browser: Browser, expression: string): Promise<T> {
  const deadline = Date.now() + 12_000;
  let lastError = 'extension worker unavailable';
  while (Date.now() < deadline) {
    const target = browser.targets().find((item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'));
    if (target) {
      const client = await target.createCDPSession();
      try {
        const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (!response.exceptionDetails) return response.result.value as T;
        lastError = response.exceptionDetails.exception?.description || 'worker evaluation failed';
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        await client.detach().catch(() => undefined);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(lastError);
}

async function configureRelay(browser: Browser, relayPort: number): Promise<void> {
  const extId = await (async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const target = browser.targets().find((item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'));
      if (target) return new URL(target.url()).hostname;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('extension id unavailable');
  })();
  const options = await browser.newPage();
  await options.goto(`chrome-extension://${extId}/options/index.html`, { waitUntil: 'domcontentloaded' });
  await options.waitForSelector('#endpoint', { timeout: 5000 });
  await options.$eval('#endpoint', (node) => { (node as HTMLInputElement).value = ''; });
  await options.type('#endpoint', `http://127.0.0.1:${relayPort}/plan`);
  await options.$eval('#token', (node) => { (node as HTMLInputElement).value = ''; });
  await options.type('#token', RELAY_TOKEN);
  await options.click('#btn-save');
  await new Promise((resolve) => setTimeout(resolve, 800));
  await options.close();
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(`  (timeout waiting: ${label})`);
  return false;
}

interface PageState {
  wallVisible: boolean | null;
  disarmed: boolean | null;
}

async function readState(pageUrl: string, browser: Browser): Promise<PageState> {
  const page = await browser.newPage();
  if (process.env.ADAPT_STEALTH_AI_DEBUG === '1') {
    page.on('requestfailed', (r) => console.log('  [page] FAILED:', r.url(), r.failure()?.errorText));
    page.on('console', (m) => console.log('  [page] console:', m.text().slice(0, 140)));
    page.on('pageerror', (e) => console.log('  [page] PAGEERROR:', String(e).slice(0, 200)));
    page.on('response', (r) => {
      console.log('  [page] response:', r.status(), r.url().slice(0, 100));
      if (r.url().includes('detector.js')) {
        void r.text().then((t) => console.log('  [page] detector.js body head:', t.slice(0, 120).replace(/\n/g, ' '))).catch(() => undefined);
      }
    });
  }
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const state = await page.evaluate(() => {
    const wall = document.getElementById('novelWall');
    const visible = Boolean(wall) && getComputedStyle(wall!).display !== 'none' && (wall!.offsetHeight > 0);
    const nov = (window as unknown as { novDetectLabs?: { disarmed?: boolean } }).novDetectLabs;
    return { wallVisible: visible, disarmed: nov?.disarmed ?? null };
  }) as PageState;
  if (process.env.ADAPT_STEALTH_AI_DEBUG === '1') {
    const probe = await page.evaluate(() => {
      const wall = document.getElementById('novelWall');
      return {
        typeofNov: typeof (window as unknown as { novDetectLabs?: unknown }).novDetectLabs,
        title: document.title,
        bodyChildren: document.body ? document.body.children.length : -1,
        childIds: document.body ? Array.from(document.body.children).map((c) => c.id || c.tagName) : [],
        wallState: wall ? {
          display: getComputedStyle(wall).display,
          visibility: getComputedStyle(wall).visibility,
          offsetHeight: wall.offsetHeight,
          zIndex: getComputedStyle(wall).zIndex,
          attrStyle: wall.getAttribute('style'),
        } : null,
      };
    });
    console.log('  [page] probe:', JSON.stringify(probe));
  }
  await page.close();
  return state;
}

async function main(): Promise<void> {
  const relay = await startRelay();
  const site = await startSite();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-stealth-ai-'));
  const pageUrl = `http://detector-site.test:${site.port}/`;
  const failures: string[] = [];
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  let browser = await launchBrowser(userDataDir);
  try {
    await configureRelay(browser, relay.port);

    // ---- Visit 1: the novel detector escapes once; the AI must neutralize it. ----
    const first = await readState(pageUrl, browser);
    report.visit1Early = first; // sampled before the AI pipeline necessarily finished
    const aiFired = await waitFor(async () => relayCalls >= 1, 45_000, 'relay call on visit 1');
    if (process.env.ADAPT_STEALTH_AI_DEBUG === '1') {
      try {
        // The MV3 worker may be idle after a long wait — wake it with a navigation
        // before attaching over CDP.
        const wake = await browser.newPage();
        await wake.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const funnel = await evaluateWorker<unknown>(
          browser,
          `chrome.storage.session.get("adapt_kimi_forensics_v1").then((r) => {
            const f = r.adapt_kimi_forensics_v1 || {};
            return {
              counters: f.counters || {},
              aiEvents: (f.events || []).filter((e) => /AI_|SURVIVOR|STEALTH|REACTION|FALLBACK|EXPERIMENT/i.test(e.kind || '')).slice(-40),
            };
          })`
        );
        console.log('  [forensics]', JSON.stringify(funnel, null, 1).slice(0, 4000));
        await wake.close().catch(() => undefined);
      } catch (error) {
        console.log('  [forensics] unavailable:', error instanceof Error ? error.message : String(error));
      }
    }
    if (!aiFired) failures.push('visit1: planner never called for the anti-block reaction');
    report.relayCallsAfterVisit1 = relayCalls;
    report.visit1Plan = lastPlanActions;

    // The wall must be removed and the counter-constant persisted.
    const wallCleared = await waitFor(async () => (await readState(pageUrl, browser)).wallVisible === false, 20_000, 'wall removed on revisit-after-apply');
    const persisted = await evaluateWorker<Array<{ path: string; value: string }>>(
      browser,
      `chrome.storage.local.get("adapt_stealth_profiles_v1").then((r) => {
        const f = r.adapt_stealth_profiles_v1;
        return f && f.sites ? Object.values(f.sites).flatMap((s) => (s.constants || []).map((c) => ({ path: c.path, value: c.value }))) : [];
      })`
    );
    report.persistedConstants = persisted;
    if (!persisted.some((c) => c.path === 'novDetectLabs.disarmed' && c.value === 'true')) {
      failures.push(`constant not persisted after healthy outcome: ${JSON.stringify(persisted)}`);
    }
    report.wallClearedOnRecheck = wallCleared;

    // ---- Visit 2: replay must pre-disarm the detector; zero new AI calls. --------
    const callsBefore = relayCalls;
    const second = await readState(pageUrl, browser);
    report.visit2 = second;
    report.relayCallsVisit2 = relayCalls - callsBefore;
    if (second.wallVisible !== false) failures.push(`visit2: wall appeared despite learned constant: ${JSON.stringify(second)}`);
    if (second.disarmed !== true) failures.push(`visit2: constant not replayed pre-check: ${JSON.stringify(second)}`);
    if (relayCalls - callsBefore !== 0) failures.push(`visit2: expected zero AI calls, got ${relayCalls - callsBefore}`);

    // ---- Visit 3: full browser restart — durable memory must carry the counter. --
    await browser.close();
    browser = await launchBrowser(userDataDir);
    const third = await readState(pageUrl, browser);
    report.visit3AfterRestart = third;
    report.relayCallsVisit3 = relayCalls - callsBefore;
    if (third.wallVisible !== false) failures.push(`visit3 (restart): wall appeared — persistence broken: ${JSON.stringify(third)}`);
    if (third.disarmed !== true) failures.push(`visit3 (restart): constant not replayed: ${JSON.stringify(third)}`);
    if (relayCalls - callsBefore !== 0) failures.push(`visit3 (restart): expected zero AI calls, got ${relayCalls - callsBefore}`);

    report.verdict = failures.length === 0 ? 'PASS' : 'FAIL';
    report.failures = failures;
  } finally {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2));
    await browser.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
    await relay.close();
    await site.close();
  }

  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    console.error(`\nSTEALTH AI: FAIL (${failures.length})`);
    for (const failure of failures) console.error('  -', failure);
    process.exit(1);
  }
  console.log('\nSTEALTH AI: PASS — novel detector learned, persisted, restart-proof, zero-AI revisits');
}

await main();
