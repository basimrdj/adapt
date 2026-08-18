/**
 * DEV-ONLY live proof that the baked-in AI default makes a fresh install of the
 * extension functional with zero manual configuration:
 *   1. a fresh profile boots with the planner configured from the built-in default
 *      (source='built-in-default', endpointClass='https-remote');
 *   2. the bounded connection test reaches the real provider through the production
 *      transport and passes production PolicyValidator schema validation;
 *   3. a generic self-hosted fixture page drives the normal production runtime path
 *      (observation → eligibility → network-discovery trigger → planner → policy)
 *      producing a real remote AI call from the service worker (mock=false);
 *   4. the credential never appears in any exported artifact.
 *
 * The harness never calls the planner directly; runtime triggers originate from the
 * production path. Writes artifacts/kimi-forensics/BUILTIN_AI_PROOF.json.
 *
 * Run: npm run build && npx tsx scripts/kimi-forensics/verify-builtin-ai.ts
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { Browser } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';
import { requireAzureApiKey } from '../azure-env';

const root = process.cwd();
const extensionPath = path.join(root, 'dist');
const artifactDir = path.join(root, 'artifacts', 'kimi-forensics');

function realToken(): string {
  return requireAzureApiKey();
}

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
      '--host-resolver-rules=MAP site4.test 127.0.0.1,MAP cdn-a.test 127.0.0.1,MAP cdn-b.test 127.0.0.1',
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

type EventData = Record<string, unknown>;

interface ForensicsArtifact {
  counters?: Record<string, number>;
  events?: Array<{ t: number; kind: string; data?: EventData }>;
}

async function readArtifact(browser: Browser): Promise<ForensicsArtifact> {
  const artifact = await evaluateWorker<ForensicsArtifact | null>(
    browser,
    'chrome.storage.session.get("adapt_kimi_forensics_v1").then((r) => r.adapt_kimi_forensics_v1 ?? null)'
  );
  return artifact ?? {};
}

function eventsOf(artifact: ForensicsArtifact, kind: string): EventData[] {
  return (artifact.events ?? []).filter((event) => event.kind === kind).map((event) => event.data ?? {});
}

async function waitForEvent(browser: Browser, kind: string, timeoutMs: number): Promise<ForensicsArtifact> {
  const deadline = Date.now() + timeoutMs;
  let artifact = await readArtifact(browser);
  while (Date.now() < deadline) {
    if (eventsOf(artifact, kind).length > 0) return artifact;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    artifact = await readArtifact(browser);
  }
  return artifact;
}

interface ConnectionTestResult {
  providerReached: boolean;
  schemaValid: boolean;
  latencyMs: number | null;
  decision?: string;
  errorClass?: string;
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

async function main(): Promise<void> {
  fs.mkdirSync(artifactDir, { recursive: true });
  const token = realToken();
  const fixtures = await startFixtureServer();
  const browser = await launchBrowser();
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  let artifact: ForensicsArtifact = {};
  try {
    // ---- 1. Fresh boot configures the planner from the built-in default ---------
    const startup = await waitForEvent(browser, 'AI_CONFIG', 10_000);
    const aiConfig = eventsOf(startup, 'AI_CONFIG')[0] ?? {};
    checks.push({
      name: '1: fresh install is configured from the built-in default (no Options setup)',
      pass: aiConfig.configured === true && aiConfig.source === 'built-in-default'
        && aiConfig.plannerClass === 'remote' && aiConfig.endpointClass === 'https-remote',
      detail: `AI_CONFIG=${JSON.stringify(aiConfig)}`,
    });

    // ---- 2. Bounded connection test against the real provider -------------------
    // Drives the real Options page: with the built-in default active and no override
    // token typed, Test connection exercises the baked config end-to-end.
    const extId = await extensionId(browser);
    const options = await browser.newPage();
    await options.goto(`chrome-extension://${extId}/options/index.html`, { waitUntil: 'domcontentloaded' });
    await options.waitForSelector('#btn-test', { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const badgeAtBoot = await options.$eval('#status-badge', (node) => node.textContent);
    await options.click('#btn-test');
    const testDeadline = Date.now() + 45_000;
    let testText = '';
    while (Date.now() < testDeadline) {
      testText = await options.$eval('#test-result', (node) => node.textContent ?? '');
      if (testText.length > 0 && testText !== 'Testing…') break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const badgeAfterTest = await options.$eval('#status-badge', (node) => node.textContent);
    await options.close().catch(() => undefined);
    const latencyMatch = /latency: (\d+) ms/.exec(testText);
    const test: ConnectionTestResult = {
      providerReached: badgeAfterTest === 'CONNECTION VERIFIED',
      schemaValid: badgeAfterTest === 'CONNECTION VERIFIED' && latencyMatch !== null,
      latencyMs: latencyMatch ? Number(latencyMatch[1]) : null,
    };
    checks.push({
      name: '2: connection test reached the real provider and passed production schema validation',
      pass: badgeAtBoot === 'CONFIGURED' && test.providerReached && test.schemaValid,
      detail: `bootBadge=${badgeAtBoot} badge=${badgeAfterTest} result="${testText}"`,
    });

    // ---- 3. Generic fixture triggers the real remote AI path --------------------
    const page = await browser.newPage();
    await page.goto(`http://site4.test:${fixtures.port}/builtin-proof`, { waitUntil: 'domcontentloaded' });
    artifact = await waitForEvent(browser, 'POLICY_RESULT', 45_000);
    await page.close().catch(() => undefined);
    const begins = eventsOf(artifact, 'AI_RUNTIME_CALL_BEGIN').filter(
      (data) => data.runtime === 'chrome-extension-service-worker' && data.mock === false && data.triggerReason !== 'CONNECTION_TEST'
    );
    const ends = eventsOf(artifact, 'AI_RUNTIME_CALL_END');
    const policies = eventsOf(artifact, 'POLICY_RESULT');
    checks.push({
      name: '3: production runtime path made a real remote AI call from the service worker',
      pass: begins.some((data) => data.endpointClass === 'https-remote') && ends.some((data) => data.ok === true),
      detail: `begin=${JSON.stringify(begins[0] ?? null)} end=${JSON.stringify(ends[0] ?? null)}`,
    });
    checks.push({
      name: '3: PolicyValidator remained authoritative on the real provider plan',
      pass: policies.some((data) => data.valid === true),
      detail: `policy=${JSON.stringify(policies[0] ?? null)}`,
    });

    // ---- 4. Secret hygiene -------------------------------------------------------
    const artifactText = JSON.stringify(artifact);
    checks.push({
      name: '4: credential never appears in the forensic artifact',
      pass: token.length > 0 && !artifactText.includes(token),
      detail: `tokenPresent=${artifactText.includes(token)}`,
    });

    const report = {
      schema: 'kimi-builtin-ai-proof-v1',
      ranAt: new Date().toISOString(),
      zeroTouchConfigured: checks[0]?.pass === true,
      testConnection: {
        providerReached: test.providerReached,
        schemaValid: test.schemaValid,
        latencyMs: test.latencyMs,
      },
      productionFixture: {
        chromeRuntimeAiCalls: begins.length,
        remoteEndpointCalls: begins.filter((data) => data.endpointClass === 'https-remote').length,
        nodeDirectAiCalls: 0,
        mock: false,
        policyReached: checks[3]?.pass === true,
      },
      secretsLeakedToArtifacts: artifactText.includes(token),
      checks,
      pass: checks.every((check) => check.pass),
    };
    fs.writeFileSync(path.join(artifactDir, 'BUILTIN_AI_PROOF.json'), `${JSON.stringify(report, null, 2)}\n`);
    for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}\n      ${check.detail}`);
    console.log(`\nBUILT-IN AI ${report.pass ? 'PASS' : 'FAIL'} — artifact: artifacts/kimi-forensics/BUILTIN_AI_PROOF.json`);
    if (!report.pass) process.exitCode = 1;
  } catch (error) {
    fs.writeFileSync(
      path.join(artifactDir, 'BUILTIN_AI_PROOF.json'),
      `${JSON.stringify({ schema: 'kimi-builtin-ai-proof-v1', status: 'failed', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
    );
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
    await fixtures.close();
  }
}

main().catch((error) => {
  console.error('BUILT-IN AI ERROR:', error);
  process.exitCode = 1;
});
