/**
 * Phase E verification — cosmetic/DOM learning persistence with rollback guard.
 *
 * Fixture: sponsor-site.test carries a first-party "sponsored" widget whose class
 * (sponsored-offer-xq7) is deliberately absent from every static list, plus one
 * harmless third-party vendor script (survivor-AI network context). A mock relay
 * plays the remote planner: it proposes DOM_HIDE_CANDIDATE on the widget once.
 *
 * Proves:
 *   v1 — the AI hide is applied live, its stable selector is captured and
 *        PERSISTED per site after the healthy-outcome verdict;
 *   v2 — revisit: the learned CSS is injected at navigation commit, so the
 *   v3 — (after a full browser restart) widget is display:none FROM INSERTION
 *        (pre-paint), with ZERO new planner calls;
 *   v4-6 — "site redesign" (the learned selector now wraps the whole article):
 *        the replay guard detects the content collapse, un-hides live, and the
 *        rule is dropped after repeated failures;
 *   v7 — the dropped rule is never replayed again.
 *
 * Artifact: artifacts/kimi-persistent-learning/COSMETIC_PERSISTENCE_PROOF.json
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { Browser } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const root = process.cwd();
const extensionPath = path.join(root, 'dist');
const artifactPath = path.join(root, 'artifacts', 'kimi-persistent-learning', 'COSMETIC_PERSISTENCE_PROOF.json');
const RELAY_TOKEN = `dev-mock-token-${Math.random().toString(36).slice(2, 12)}`;
const HOSTS = ['sponsor-site.test', 'sponsor-vendor.test'];
const WIDGET_CLASS = 'sponsored-offer-xq7';
const LEARNED_SELECTOR = `div.${WIDGET_CLASS}`;

let relayCalls = 0;

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
        };
        const available = new Set(evidence.availableActions ?? []);
        const widget = (evidence.candidateElements ?? []).find((element) => element.role !== 'ANTI_BLOCK_REACTION')
          ?? (evidence.candidateElements ?? [])[0];
        const plan = widget && available.has('DOM_HIDE_CANDIDATE')
          ? {
              schemaVersion: 1,
              decision: 'ADAPT',
              hypothesis: { category: 'UNKNOWN', confidence: 0.85, explanation: 'promotional surface survivor' },
              selectedStrategyTier: 'S3',
              actions: [{ actionType: 'DOM_HIDE_CANDIDATE', targetRef: widget.ref, parameter: '' }],
              verification: { expectedHealthDelta: 0.1, maxWaitMs: 1500 },
              abortConditions: [],
              explanationCodes: ['HIDE_SPONSORED_SURFACE'],
            }
          : {
              schemaVersion: 1,
              decision: 'ABSTAIN',
              hypothesis: { category: 'UNKNOWN', confidence: 0.9, explanation: 'no sponsored survivor' },
              selectedStrategyTier: 'ABSTAIN',
              actions: [{ actionType: 'ABSTAIN', targetRef: '', parameter: '' }],
              verification: { expectedHealthDelta: 0, maxWaitMs: 500 },
              abortConditions: [],
              explanationCodes: [],
            };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ plan }));
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
    const url = new URL(req.url || '/', 'http://sponsor-site.test');
    if (url.pathname === '/widget.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('window.__vendorWidgetLoaded = true;');
      return;
    }
    const article = 'Local news worth reading. '.repeat(12);
    if (url.searchParams.get('redesign') === '1') {
      // "Site redesign": the learned class now wraps the ENTIRE article — a
      // replayed hide would collapse all visible content (the guard's case).
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>sponsor site redesigned</title></head>
<body><div class="${WIDGET_CLASS}"><main><h1>Redesigned sponsor site</h1><p>${article}</p></main></div>
<script src="http://sponsor-vendor.test:${serverPort}/widget.js"></script>
</body></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>sponsor site</title></head>
<body><main><h1>Sponsor site</h1><p>${article}</p></main>
<script src="http://sponsor-vendor.test:${serverPort}/widget.js"></script>
<script>
setTimeout(function () {
  var w = document.createElement('div');
  w.className = '${WIDGET_CLASS}';
  w.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:99999;background:#ffe9a8;border:2px solid #e0a800;padding:14px;width:220px;';
  w.textContent = 'Sponsored: premium widgets for less';
  document.body.appendChild(w);
  // Pre-paint replay proof: with learned CSS injected at commit, the widget is
  // already display:none in the SAME task that inserts it.
  window.__widgetInsertedVisible = getComputedStyle(w).display !== 'none' && w.offsetHeight > 0;
}, 500);
</script>
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

interface WidgetState {
  insertedVisible: boolean | null;
  currentlyVisible: boolean | null;
  articleVisible: boolean;
}

async function readWidget(pageUrl: string, browser: Browser): Promise<WidgetState> {
  const page = await browser.newPage();
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const state = await page.evaluate(`(() => {
    var widget = document.querySelector('div.${WIDGET_CLASS}');
    function visible(el) {
      if (!el) return false;
      var style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
    }
    return {
      insertedVisible: window.__widgetInsertedVisible ?? null,
      currentlyVisible: widget ? visible(widget) : null,
      articleVisible: visible(document.querySelector('main')),
    };
  })()`) as WidgetState;
  await page.close();
  return state;
}

async function readPersistedSelectors(browser: Browser): Promise<string[]> {
  return evaluateWorker<string[]>(
    browser,
    `chrome.storage.local.get("adapt_cosmetic_profiles_v1").then((r) => {
      const f = r.adapt_cosmetic_profiles_v1;
      return f && f.sites ? Object.values(f.sites).flatMap((s) => (s.hides || []).map((h) => h.selector)) : [];
    })`
  );
}

async function main(): Promise<void> {
  const relay = await startRelay();
  const site = await startSite();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-cosmetic-e-'));
  const pageUrl = `http://sponsor-site.test:${site.port}/`;
  const failures: string[] = [];
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  let browser = await launchBrowser(userDataDir);
  try {
    await configureRelay(browser, relay.port);

    // ---- v1: the widget escapes once; the AI hide is applied, verified, persisted.
    const first = await readWidget(pageUrl, browser);
    report.visit1 = first;
    if (first.insertedVisible !== true) failures.push(`v1: fixture broken — widget should insert visible: ${JSON.stringify(first)}`);
    const aiFired = await waitFor(async () => relayCalls >= 1, 45_000, 'relay call on visit 1');
    if (!aiFired) failures.push('v1: planner never called for the sponsored survivor');
    report.relayCallsVisit1 = relayCalls;
    const persisted1 = await readPersistedSelectors(browser);
    report.persistedAfterVisit1 = persisted1;
    if (!persisted1.includes(LEARNED_SELECTOR)) {
      failures.push(`v1: learned selector not persisted: ${JSON.stringify(persisted1)}`);
    }

    // ---- v2: revisit — replay hides the widget pre-paint, zero new AI calls.
    const callsBefore2 = relayCalls;
    const second = await readWidget(pageUrl, browser);
    report.visit2 = second;
    report.relayCallsVisit2 = relayCalls - callsBefore2;
    if (second.insertedVisible !== false) failures.push(`v2: replay did not hide pre-paint (insertedVisible=${second.insertedVisible})`);
    if (second.articleVisible !== true) failures.push(`v2: replay broke the article: ${JSON.stringify(second)}`);
    if (relayCalls - callsBefore2 !== 0) failures.push(`v2: expected zero AI calls, got ${relayCalls - callsBefore2}`);

    // ---- v3: full browser restart — durable memory must carry the hide.
    await browser.close();
    browser = await launchBrowser(userDataDir);
    const callsBefore3 = relayCalls;
    const third = await readWidget(pageUrl, browser);
    report.visit3AfterRestart = third;
    report.relayCallsVisit3 = relayCalls - callsBefore3;
    if (third.insertedVisible !== false) failures.push(`v3 (restart): replay lost — widget inserted visible: ${JSON.stringify(third)}`);
    if (third.articleVisible !== true) failures.push(`v3 (restart): article hidden by replay: ${JSON.stringify(third)}`);
    if (relayCalls - callsBefore3 !== 0) failures.push(`v3 (restart): expected zero AI calls, got ${relayCalls - callsBefore3}`);

    // ---- v4-6: site redesign turns the learned selector into a content killer.
    const redesignUrl = `${pageUrl}?redesign=1`;
    const redesignStates: WidgetState[] = [];
    for (let visit = 4; visit <= 6; visit++) {
      const state = await readWidget(redesignUrl, browser);
      redesignStates.push(state);
      // The guard must have un-hidden the page by sample time (broke → removeCSS).
      if (state.articleVisible !== true) failures.push(`v${visit} (redesign): guard did not restore the article: ${JSON.stringify(state)}`);
    }
    report.redesignVisits = redesignStates;
    const persistedAfterGuard = await readPersistedSelectors(browser);
    report.persistedAfterGuard = persistedAfterGuard;
    if (persistedAfterGuard.includes(LEARNED_SELECTOR)) {
      failures.push(`rollback guard: rule still persisted after repeated breakage: ${JSON.stringify(persistedAfterGuard)}`);
    }

    // ---- v7: dropped rule never replays — article visible from the start.
    const seventh = await readWidget(redesignUrl, browser);
    report.visit7AfterDrop = seventh;
    if (seventh.articleVisible !== true) failures.push(`v7: dropped rule still affects the page: ${JSON.stringify(seventh)}`);

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
    console.error(`\nCOSMETIC PERSISTENCE: FAIL (${failures.length})`);
    for (const failure of failures) console.error('  -', failure);
    process.exit(1);
  }
  console.log('\nCOSMETIC PERSISTENCE: PASS — learned hide persisted, replayed pre-paint across restart, guard dropped the regressive rule');
}

await main();
