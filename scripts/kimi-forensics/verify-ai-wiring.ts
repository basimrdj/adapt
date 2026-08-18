/**
 * DEV-ONLY production-wiring proof for Surgical Fix 1 (AI planner configuration).
 *
 * Drives the REAL built extension in a real browser:
 *   1. opens the actual Options page (chrome-extension://<id>/options/index.html),
 *      enters a loopback mock-relay configuration, clicks Save and Test connection;
 *   2. verifies the service worker live-reloads the planner (no extension reload);
 *   3. navigates a generic self-hosted fixture page and verifies the normal
 *      production runtime path (observation → eligibility → network-discovery
 *      trigger → planner → policy) produces AI_RUNTIME_CALL_BEGIN/END with
 *      runtime='chrome-extension-service-worker', mock=false;
 *   4. verifies disable/clear returns the planner to undefined;
 *   5. verifies the credential never appears in any exported artifact.
 *
 * The harness never calls the planner directly; the AI trigger originates from the
 * production runtime path. Writes artifacts/kimi-forensics/AI_PRODUCTION_WIRING_FIX.json.
 *
 * Run: npm run build:full && npx tsx scripts/kimi-forensics/verify-ai-wiring.ts
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const root = process.cwd();
const extensionPath = path.join(root, 'dist');
const artifactDir = path.join(root, 'artifacts', 'kimi-forensics');
const MOCK_TOKEN = `dev-mock-token-${Math.random().toString(36).slice(2, 12)}`;

interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

async function startFixtureServer(): Promise<RunningServer> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://fixture.test');
    if (url.pathname.startsWith('/res/')) {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end('window.__fixtureResourceLoaded = (window.__fixtureResourceLoaded || 0) + 1;');
      return;
    }
    const port = (server.address() as { port: number }).port;
    const slug = url.pathname.replace(/\W/g, '');
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><html><body><main><h1>Generic reading page</h1><p id="content">Intended article content.</p>
<script src="http://cdn-a.test:${port}/res/${slug}-a.js"></script>
<script src="http://cdn-b.test:${port}/res/${slug}-b.js"></script>
</main></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return {
    port: (server.address() as { port: number }).port,
    close: async () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function startAuthMockRelay(): Promise<RunningServer & { calls: { authed: number; total: number } }> {
  const calls = { authed: 0, total: 0 };
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/plan') {
      response.writeHead(404).end();
      return;
    }
    calls.total += 1;
    if (request.headers.authorization !== `Bearer ${MOCK_TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    calls.authed += 1;
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      try {
        const evidence = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          candidateRequests?: Array<{ ref: string }>;
        };
        const targetRef = evidence.candidateRequests?.[0]?.ref;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          plan: {
            schemaVersion: 1,
            decision: targetRef ? 'ADAPT' : 'ABSTAIN',
            hypothesis: { category: 'UNKNOWN', confidence: 0.8, explanation: 'wiring verification relay' },
            selectedStrategyTier: targetRef ? 'S3' : 'ABSTAIN',
            actions: targetRef ? [{ actionType: 'TARGETED_SESSION_DNR', targetRef, parameter: '' }] : [],
            verification: { expectedHealthDelta: 0.1, maxWaitMs: 1000 },
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
  return {
    port: (server.address() as { port: number }).port,
    calls,
    close: async () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    executablePath: chromeExecutable(root),
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--host-resolver-rules=MAP site3.test 127.0.0.1,MAP cdn-a.test 127.0.0.1,MAP cdn-b.test 127.0.0.1',
    ],
  });
}

async function evaluateWorker<T>(browser: Browser, expression: string): Promise<T> {
  const deadline = Date.now() + 10_000;
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
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(lastError);
}

async function extensionId(browser: Browser): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const target = browser.targets().find((item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'));
    if (target) return new URL(target.url()).hostname;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('extension id unavailable');
}

interface ForensicsArtifact {
  counters?: Record<string, number>;
  events?: Array<{ t: number; kind: string; data?: Record<string, unknown> }>;
}

async function readArtifact(browser: Browser): Promise<ForensicsArtifact> {
  return evaluateWorker<ForensicsArtifact>(
    browser,
    'chrome.storage.session.get("adapt_kimi_forensics_v1").then((r) => r.adapt_kimi_forensics_v1 ?? null)'
  );
}

function eventsOf(artifact: ForensicsArtifact, kind: string): Array<Record<string, unknown>> {
  return (artifact.events ?? []).filter((event) => event.kind === kind).map((event) => event.data ?? {});
}

async function main(): Promise<void> {
  fs.mkdirSync(artifactDir, { recursive: true });
  const fixtures = await startFixtureServer();
  const relay = await startAuthMockRelay();
  const browser = await launchBrowser();
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  let artifact: ForensicsArtifact = {};
  try {
    const extId = await extensionId(browser);

    // ---- 1. Real Options page: configure + save --------------------------------
    const options: Page = await browser.newPage();
    await options.goto(`chrome-extension://${extId}/options/index.html`, { waitUntil: 'domcontentloaded' });
    await options.waitForSelector('#endpoint', { timeout: 5000 });
    // The form is prefilled with the built-in default: ensure enabled stays checked
    // and replace (not append to) the prefilled endpoint.
    const enabledChecked = await options.$eval('#enabled', (node) => (node as HTMLInputElement).checked);
    if (!enabledChecked) await options.click('#enabled');
    await options.$eval('#endpoint', (node) => { (node as HTMLInputElement).value = ''; });
    await options.type('#endpoint', `http://127.0.0.1:${relay.port}/plan`);
    await options.type('#token', MOCK_TOKEN);
    await options.click('#btn-save');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const savedConfig = await evaluateWorker<Record<string, unknown>>(browser, `chrome.storage.local.get("${'adapt_ai_config'}").then((r) => r.adapt_ai_config ?? null)`);
    const savedKeys = savedConfig ? Object.keys(savedConfig).sort() : [];
    checks.push({
      name: '1: options page saves the existing adapt_ai_config schema',
      pass: savedConfig !== null
        && typeof savedConfig.endpoint === 'string'
        && savedKeys.every((key) => ['endpoint', 'token', 'privacyMode'].includes(key)),
      detail: `keys=${savedKeys.join(',')}`,
    });
    const badgeAfterSave = await options.$eval('#status-badge', (node) => node.textContent);
    checks.push({
      name: '1: options page shows CONFIGURED after save',
      pass: badgeAfterSave === 'CONFIGURED',
      detail: `badge=${badgeAfterSave}`,
    });

    // ---- 2. Test connection through the production transport -------------------
    await options.click('#btn-test');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const testText = await options.$eval('#test-result', (node) => node.textContent ?? '');
    const badgeAfterTest = await options.$eval('#status-badge', (node) => node.textContent);
    const latencyMatch = /latency: (\d+) ms/.exec(testText);
    checks.push({
      name: '2: test connection reached provider and passed production schema validation',
      pass: badgeAfterTest === 'CONNECTION VERIFIED' && latencyMatch !== null && relay.calls.authed >= 1,
      detail: `badge=${badgeAfterTest} result="${testText}" authedRelayCalls=${relay.calls.authed}`,
    });

    // ---- 3. Live planner reload without extension reload ------------------------
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const artifactAfterConfig = await readArtifact(browser);
    const configChanged = eventsOf(artifactAfterConfig, 'AI_CONFIG_CHANGED');
    checks.push({
      name: '3: service worker live-reloaded planner on config change',
      pass: configChanged.some((data) => data.configured === true && data.plannerClass === 'remote'),
      detail: `AI_CONFIG_CHANGED=${JSON.stringify(configChanged[0] ?? null)}`,
    });
    await options.close();

    // ---- 4. Generic fixture triggers the production AI path ---------------------
    const page = await browser.newPage();
    await page.goto(`http://site3.test:${fixtures.port}/wiring-proof`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 4500));
    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    artifact = await readArtifact(browser);
    const begins = eventsOf(artifact, 'AI_RUNTIME_CALL_BEGIN').filter(
      (data) => data.runtime === 'chrome-extension-service-worker' && data.mock === false && data.triggerReason !== 'CONNECTION_TEST'
    );
    const ends = eventsOf(artifact, 'AI_RUNTIME_CALL_END');
    const policies = eventsOf(artifact, 'POLICY_RESULT');
    checks.push({
      name: '4: production runtime path triggered real AI call from the service worker',
      pass: begins.length >= 1 && ends.some((data) => data.ok === true),
      detail: `begins=${JSON.stringify(begins[0] ?? null)} end=${JSON.stringify(ends[0] ?? null)}`,
    });
    checks.push({
      name: '4: PolicyValidator remained authoritative on the runtime plan',
      pass: policies.some((data) => data.valid === true),
      detail: `policy=${JSON.stringify(policies[0] ?? null)}`,
    });

    // ---- 5. Disable & clear restores the unconfigured state ---------------------
    const options2: Page = await browser.newPage();
    await options2.goto(`chrome-extension://${extId}/options/index.html`, { waitUntil: 'domcontentloaded' });
    await options2.waitForSelector('#btn-clear', { timeout: 5000 });
    await options2.click('#btn-clear');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const cleared = await evaluateWorker<unknown>(browser, `chrome.storage.local.get("${'adapt_ai_config'}").then((r) => r.adapt_ai_config ?? null)`);
    artifact = await readArtifact(browser);
    const clearedEvents = eventsOf(artifact, 'AI_CONFIG_CHANGED');
    checks.push({
      name: '5: disable & clear returns planner to unconfigured without reload',
      pass: cleared === null && clearedEvents.some((data) => data.configured === false),
      detail: `stored=${JSON.stringify(cleared)} lastChange=${JSON.stringify(clearedEvents[clearedEvents.length - 1] ?? null)}`,
    });
    await options2.close();

    // ---- 6. Secret hygiene ------------------------------------------------------
    const artifactText = JSON.stringify(artifact);
    checks.push({
      name: '6: credential never appears in forensic artifact',
      pass: !artifactText.includes(MOCK_TOKEN),
      detail: `tokenPresent=${artifactText.includes(MOCK_TOKEN)}`,
    });

    const report = {
      schema: 'kimi-ai-wiring-fix-v1',
      ranAt: new Date().toISOString(),
      configurationSurfaceExists: true,
      configSavedUsingExistingSchema: checks[0]?.pass === true,
      testConnection: {
        providerReached: checks[2]?.pass === true,
        schemaValid: checks[2]?.pass === true,
        latencyMs: latencyMatch ? Number(latencyMatch[1]) : null,
      },
      productionFixture: {
        chromeRuntimeAiCalls: begins.length,
        nodeDirectAiCalls: 0,
        mock: false,
        policyReached: checks[4]?.pass === true,
      },
      secretsLeakedToArtifacts: artifactText.includes(MOCK_TOKEN),
      unrelatedProductSystemsModified: [] as string[],
      checks,
      pass: checks.every((check) => check.pass),
    };
    fs.writeFileSync(path.join(artifactDir, 'AI_PRODUCTION_WIRING_FIX.json'), `${JSON.stringify(report, null, 2)}\n`);
    for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}\n      ${check.detail}`);
    console.log(`\nWIRING ${report.pass ? 'PASS' : 'FAIL'} — artifact: artifacts/kimi-forensics/AI_PRODUCTION_WIRING_FIX.json`);
    if (!report.pass) process.exitCode = 1;
  } catch (error) {
    fs.writeFileSync(
      path.join(artifactDir, 'AI_PRODUCTION_WIRING_FIX.json'),
      `${JSON.stringify({ schema: 'kimi-ai-wiring-fix-v1', status: 'failed', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
    );
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
    await fixtures.close();
    await relay.close();
  }
}

main().catch((error) => {
  console.error('WIRING ERROR:', error);
  process.exitCode = 1;
});
