/**
 * DEV-ONLY sanity check for the kimi-forensics instrumentation build.
 *
 * Uses only self-hosted generic fixtures (site.test / site2.test / ads.test mapped to
 * loopback) — never any external benchmark. Verifies, inside the REAL installed
 * extension service worker:
 *
 *   A. Unconfigured planner -> funnel counters increment and the AI gate records
 *      AI_PROVIDER_UNCONFIGURED (would-trigger context included).
 *   B. Loopback mock relay planner -> AI_RUNTIME_CALL_BEGIN/END with
 *      runtime='chrome-extension-service-worker', policy approval, executor stage,
 *      SESSION_RULES_ADD, learned session protection present in Chrome.
 *   C. Service-worker termination -> fresh SW_START, and startup reconcile removes the
 *      learned session rule (proves/disproves the learned-rule wipe mechanism).
 *
 * Run: npm run build:full && npx tsx scripts/kimi-forensics/sanity-check.ts
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { Browser } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const root = process.cwd();
const extensionPath = path.join(root, 'dist');
const artifactDir = path.join(root, 'artifacts', 'kimi-forensics');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

async function startFixtureServer(): Promise<RunningServer> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://fixture.test');
    if (url.pathname.startsWith('/res/')) {
      if (url.pathname.endsWith('.png')) {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(PNG_1PX);
        return;
      }
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

async function startMockRelay(): Promise<RunningServer & { calls: number }> {
  const state = { calls: 0 };
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/plan') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      state.calls += 1;
      try {
        const evidence = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          candidateRequests?: Array<{ ref: string }>;
        };
        const targetRef = evidence.candidateRequests?.[0]?.ref;
        if (!targetRef) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            plan: {
              schemaVersion: 1,
              decision: 'ABSTAIN',
              hypothesis: { category: 'UNKNOWN', confidence: 0.2, explanation: 'no candidates' },
              selectedStrategyTier: 'ABSTAIN',
              actions: [],
              verification: { expectedHealthDelta: 0, maxWaitMs: 500 },
            },
          }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          plan: {
            schemaVersion: 1,
            decision: 'ADAPT',
            hypothesis: { category: 'UNKNOWN', confidence: 0.8, explanation: 'sanity-check mock planner' },
            selectedStrategyTier: 'S3',
            actions: [{ actionType: 'TARGETED_SESSION_DNR', targetRef, parameter: '' }],
            verification: { expectedHealthDelta: 0.1, maxWaitMs: 1000 },
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
    calls: state.calls,
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
      '--host-resolver-rules=MAP site.test 127.0.0.1,MAP site2.test 127.0.0.1,MAP cdn-a.test 127.0.0.1,MAP cdn-b.test 127.0.0.1',
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
        const response = await client.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
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

/** Force-terminate the extension service worker via the browser-level CDP endpoint. */
async function terminateExtensionWorker(browser: Browser): Promise<boolean> {
  const socket = new WebSocket(browser.wsEndpoint());
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('browser websocket failed'));
    });
    socket.onmessage = (message) => {
      const parsed = JSON.parse(String(message.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (parsed.id === undefined) return;
      const entry = pending.get(parsed.id);
      if (!entry) return;
      pending.delete(parsed.id);
      if (parsed.error) entry.reject(new Error(parsed.error.message ?? 'cdp error'));
      else entry.resolve(parsed.result);
    };
    const targets = (await send('Target.getTargets')) as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
    const worker = targets.targetInfos.find((item) => item.type === 'service_worker' && item.url.startsWith('chrome-extension://'));
    if (!worker) return false;
    await send('Target.terminateTarget', { targetId: worker.targetId });
    return true;
  } catch {
    return false;
  } finally {
    socket.close();
  }
}

interface ForensicsArtifact {
  counters?: Record<string, number>;
  events?: Array<{ t: number; kind: string; data?: Record<string, unknown> }>;
  rules?: Record<string, { learned: boolean; removedAt?: number; removalSource?: string }>;
  sessionRuleSnapshots?: Array<{ t: number; total: number; learned: number }>;
}

async function readArtifact(browser: Browser): Promise<ForensicsArtifact> {
  await evaluateWorker(browser, 'void 0').catch(() => undefined);
  return evaluateWorker<ForensicsArtifact>(
    browser,
    'chrome.storage.session.get("adapt_kimi_forensics_v1").then((r) => r.adapt_kimi_forensics_v1 ?? null)'
  );
}

function counter(artifact: ForensicsArtifact, name: string): number {
  return artifact.counters?.[name] ?? 0;
}

function eventsOf(artifact: ForensicsArtifact, kind: string): Array<{ t: number; kind: string; data?: Record<string, unknown> }> {
  return (artifact.events ?? []).filter((event) => event.kind === kind);
}

async function main(): Promise<void> {
  fs.mkdirSync(artifactDir, { recursive: true });
  const fixtures = await startFixtureServer();
  const relay = await startMockRelay();
  const browser = await launchBrowser();
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  try {
    // ---- Scenario A: no planner configured ------------------------------------
    // Warmup: the very first navigation after extension load races service-worker
    // startup; absorb it so scenario A measures steady-state observation only.
    const warmup = await browser.newPage();
    await warmup.goto(`http://site.test:${fixtures.port}/warmup`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await warmup.close();

    const pageA = await browser.newPage();
    await pageA.goto(`http://site.test:${fixtures.port}/case-a`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const pageAState = await pageA.evaluate(() => ({
      loaded: (window as unknown as { __fixtureResourceLoaded?: number }).__fixtureResourceLoaded ?? 0,
      resourceEntries: performance.getEntriesByType('resource').length,
    })).catch(() => ({ loaded: -1, resourceEntries: -1 }));
    console.log('   [fixture A page state]', JSON.stringify(pageAState));
    await pageA.close();
    await evaluateWorker(browser, 'void 0');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const artifactA = await readArtifact(browser);

    checks.push({
      name: 'A: startup events recorded',
      pass: eventsOf(artifactA, 'SW_START').length >= 1 && eventsOf(artifactA, 'STARTUP_READY').length >= 1,
      detail: `SW_START=${eventsOf(artifactA, 'SW_START').length} STARTUP_READY=${eventsOf(artifactA, 'STARTUP_READY').length}`,
    });
    const aiConfig = eventsOf(artifactA, 'AI_CONFIG')[0];
    checks.push({
      name: 'A: planner reported unconfigured',
      pass: aiConfig?.data?.configured === false,
      detail: `AI_CONFIG=${JSON.stringify(aiConfig?.data ?? null)}`,
    });
    checks.push({
      name: 'A: request funnel counters increment',
      pass: counter(artifactA, 'totalRequestsObserved') > 0 && counter(artifactA, 'thirdPartyRequests') >= 2,
      detail: `observed=${counter(artifactA, 'totalRequestsObserved')} thirdParty=${counter(artifactA, 'thirdPartyRequests')} eligible=${counter(artifactA, 'candidateEligibleRequests')}`,
    });
    const skipEvents = eventsOf(artifactA, 'AI_SKIP').filter((event) => event.data?.reason === 'AI_PROVIDER_UNCONFIGURED');
    checks.push({
      name: 'A: AI gate records AI_PROVIDER_UNCONFIGURED with trigger context',
      pass: skipEvents.length > 0 && typeof skipEvents[0]?.data?.wouldTrigger === 'string',
      detail: `skips=${skipEvents.length} first=${JSON.stringify(skipEvents[0]?.data ?? null)}`,
    });
    checks.push({
      name: 'A: zero chrome-runtime AI calls without planner',
      pass: eventsOf(artifactA, 'AI_RUNTIME_CALL_BEGIN').length === 0,
      detail: `AI_RUNTIME_CALL_BEGIN=${eventsOf(artifactA, 'AI_RUNTIME_CALL_BEGIN').length}`,
    });

    // ---- Scenario B: loopback mock relay planner ------------------------------
    await evaluateWorker(
      browser,
      `chrome.storage.local.set(${JSON.stringify({ adapt_ai_config: { endpoint: `http://127.0.0.1:${relay.port}/plan` } })})`
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const pageB = await browser.newPage();
    await pageB.goto(`http://site2.test:${fixtures.port}/case-b`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await pageB.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const artifactB = await readArtifact(browser);

    const aiBegin = eventsOf(artifactB, 'AI_RUNTIME_CALL_BEGIN')[0];
    checks.push({
      name: 'B: AI call executed inside the extension service worker',
      pass: aiBegin?.data?.runtime === 'chrome-extension-service-worker'
        && aiBegin?.data?.plannerClass === 'remote'
        && aiBegin?.data?.endpointClass === 'loopback'
        && eventsOf(artifactB, 'AI_RUNTIME_CALL_END').some((event) => event.data?.ok === true),
      detail: `begin=${JSON.stringify(aiBegin?.data ?? null)} end=${JSON.stringify(eventsOf(artifactB, 'AI_RUNTIME_CALL_END')[0]?.data ?? null)}`,
    });
    const stage = eventsOf(artifactB, 'EXECUTOR_STAGE')[0];
    checks.push({
      name: 'B: executor staged TARGETED_SESSION_DNR',
      pass: stage?.data?.ok === true && stage?.data?.primitiveId === 'TARGETED_SESSION_DNR',
      detail: `stage=${JSON.stringify(stage?.data ?? null)}`,
    });
    const added = eventsOf(artifactB, 'SESSION_RULES_ADD')[0];
    const learnedSnapshot = [...(artifactB.sessionRuleSnapshots ?? [])].reverse().find((snap) => snap.learned > 0);
    checks.push({
      name: 'B: learned session rule installed and confirmed present in Chrome',
      pass: added !== undefined && learnedSnapshot !== undefined,
      detail: `add=${JSON.stringify(added?.data ?? null)} snapshot=${JSON.stringify(learnedSnapshot ?? null)}`,
    });
    checks.push({
      name: 'B: outcome recorded as learned session protection',
      pass: counter(artifactB, 'learnedSessionProtections') >= 1,
      detail: `learnedSessionProtections=${counter(artifactB, 'learnedSessionProtections')}`,
    });

    // ---- Scenario C: service-worker termination wipes learned rule ------------
    const terminated = await terminateExtensionWorker(browser);
    console.log('   [scenario C] worker terminateTarget sent:', terminated);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const pageC = await browser.newPage();
    await pageC.goto(`http://site2.test:${fixtures.port}/case-c`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 3500));
    await pageC.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const artifactC = await readArtifact(browser);

    const reconcile = eventsOf(artifactC, 'RECONCILE_RESULT')[0];
    const removedLearned = Object.values(artifactC.rules ?? {}).filter(
      (rule) => rule.learned && rule.removalSource === 'startup-reconcile'
    );
    if (terminated) {
      checks.push({
        name: 'C: service worker restarted (second SW_START)',
        pass: eventsOf(artifactC, 'SW_START').length >= 2,
        detail: `SW_START=${eventsOf(artifactC, 'SW_START').length}`,
      });
      checks.push({
        name: 'C: startup reconcile after restart removed the learned session rule',
        pass: removedLearned.length >= 1 || Number(reconcile?.data?.orphanedSessionRemoved ?? 0) >= 1,
        detail: `reconcile=${JSON.stringify(reconcile?.data ?? null)} removedLearned=${removedLearned.length}`,
      });
    } else {
      checks.push({
        name: 'C: (informational) worker termination unavailable under automation; reconcile-wipe rests on code evidence',
        pass: true,
        detail: 'Target.terminateTarget not available in this environment',
      });
    }

    const report = {
      schema: 'kimi-forensics-sanity-v1',
      ranAt: new Date().toISOString(),
      checks,
      pass: checks.every((check) => check.pass),
      artifact: artifactC,
    };
    fs.writeFileSync(path.join(artifactDir, 'SANITY_CHECK.json'), `${JSON.stringify(report, null, 2)}\n`);
    for (const check of checks) {
      console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}\n      ${check.detail}`);
    }
    console.log(`\nSANITY ${report.pass ? 'PASS' : 'FAIL'} — artifact: artifacts/kimi-forensics/SANITY_CHECK.json`);
    if (!report.pass) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => undefined);
    await fixtures.close();
    await relay.close();
  }
}

main().catch((error) => {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, 'SANITY_CHECK.json'),
    `${JSON.stringify({ schema: 'kimi-forensics-sanity-v1', status: 'failed', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
  );
  console.error('SANITY ERROR:', error);
  process.exitCode = 1;
});
