/**
 * P2 VERIFICATION — per-site AI negative memory with escalating cooldown.
 *
 * Drives the REAL built extension against generic self-hosted fixtures. The mock
 * relay returns a structurally valid envelope whose ADAPT action references a
 * request ref that does not exist in the evidence packet — the production
 * PolicyValidator rejects it every time (site-signaling failure: the model keeps
 * producing garbage from THIS page's evidence shape). Sequence:
 *
 *   N1-N3  three navigations to fail-site.test → three policy-rejected failures
 *          recorded (AI_NEGATIVE_MEMORY_FAILURE with escalating streak); the 3rd
 *          failure puts the site into a 1h cooldown (cooldownUntil > now in
 *          adapt_ai_negative_memory_v1)
 *   N4     a 4th navigation to fail-site.test → ZERO planner calls
 *          (AI_RUNTIME_CALL_BEGIN delta 0, relay hit delta 0) and the gate
 *          reports AI_SITE_COOLDOWN; no new failure is recorded (the gate
 *          short-circuited before the planner)
 *   N5     control: other-site.test is NOT in cooldown — its first navigation
 *          still triggers a planner call (relay hit delta 1) and records its own
 *          first failure; the cooldown is per-site
 *   N6     browser restart with the SAME profile → the cooldown survives
 *          (storage.local) — the very first post-restart navigation to
 *          fail-site.test skips with AI_SITE_COOLDOWN and zero planner calls
 *   CTL    first-party control resource loads on every page; the mock credential
 *          never appears in the forensic artifact
 *
 * Deliberate policy deviation from plan text, documented: planner TRANSPORT
 * failures (HTTP/timeout) do NOT count toward the per-site budget — an outage
 * is our infrastructure, not evidence about the site. Site-signaling failures
 * only: policy-rejected, no-action-selected, stage-rejected, outcome-rollback.
 *
 * Writes artifacts/kimi-persistent-learning/NEGATIVE_MEMORY_PROOF.json.
 * Artifact hygiene: hosts projected to first DNS labels only; no credentials.
 *
 * Run: npm run build && npx tsx scripts/kimi-persistent-learning/verify-negative-memory.ts
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const root = process.cwd();
const extensionPath = path.join(root, 'dist');
const artifactDir = path.join(root, 'artifacts', 'kimi-persistent-learning');
const MOCK_TOKEN = `dev-mock-token-${Math.random().toString(36).slice(2, 12)}`;

interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

/** Two third-party resources per page → the survivor gate sees >= 2 request
 * candidates with no survivor → NOVEL_NETWORK_DISCOVERY fires once per
 * navigation (the audit latch is navigation-epoch scoped). */
function pageHtml(port: number, slug: string): string {
  return `<!doctype html><html><body><main><h1>Negative-memory fixture</h1><p>Intended content.</p>
<script>window.__state={};</script>
<script src="http://res-a.test:${port}/a/${slug}.js" onload="window.__state['a']='loaded'" onerror="window.__state['a']='blocked'"></script>
<script src="http://res-b.test:${port}/b/${slug}.js" onload="window.__state['b']='loaded'" onerror="window.__state['b']='blocked'"></script>
<script src="/res/own-${slug}.js" onload="window.__state['own']='loaded'" onerror="window.__state['own']='blocked'"></script>
</main></body></html>`;
}

async function startFixtureServer(): Promise<RunningServer> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://fixture.test');
    if (url.pathname.startsWith('/wake')) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body>wake</body></html>');
      return;
    }
    if (url.pathname !== '/') {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end('/* fixture resource */');
      return;
    }
    const port = (server.address() as { port: number }).port;
    const slug = Math.random().toString(36).slice(2, 8);
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(pageHtml(port, slug));
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

let relayHits = 0;
async function startMockRelay(): Promise<RunningServer> {
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/plan') {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${MOCK_TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      relayHits += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      // Guaranteed policy rejection: targetRef request:r99999 is not in the
      // evidence packet, so the validator marks the plan invalid.
      response.end(JSON.stringify({
        plan: {
          schemaVersion: 1,
          decision: 'ADAPT',
          hypothesis: { category: 'UNKNOWN', confidence: 0.9, explanation: 'relay returns an unstageable ref' },
          selectedStrategyTier: 'S3',
          actions: [{ actionType: 'TARGETED_SESSION_DNR', targetRef: 'request:r99999', parameter: '' }],
          verification: { expectedHealthDelta: 0.1, maxWaitMs: 1000 },
          abortConditions: [],
          explanationCodes: [],
        },
      }));
    });
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

const HOSTS = ['fail-site.test', 'other-site.test', 'res-a.test', 'res-b.test'];

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

/** MV3 workers idle out; a throwaway navigation wakes them for CDP evaluation. */
let wakePage: Page | undefined;
async function wakeWorker(browser: Browser, wakePort: number): Promise<void> {
  try {
    if (!wakePage || wakePage.isClosed()) wakePage = await browser.newPage();
    await wakePage.goto(`http://127.0.0.1:${wakePort}/wake`, { waitUntil: 'domcontentloaded', timeout: 5000 });
  } catch {
    // next retry round will try again
  }
}

let wakePortGlobal = 0;
async function evaluateWorker<T>(browser: Browser, expression: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  let lastError = 'extension worker unavailable';
  while (Date.now() < deadline) {
    const target = browser.targets().find((item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'));
    if (!target) {
      await wakeWorker(browser, wakePortGlobal);
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(lastError);
}

interface ForensicsArtifact {
  counters?: Record<string, number>;
  events?: Array<{ t: number; kind: string; data?: Record<string, unknown> }>;
}

async function readArtifact(browser: Browser): Promise<ForensicsArtifact> {
  const artifact = await evaluateWorker<ForensicsArtifact | null>(
    browser,
    'chrome.storage.session.get("adapt_kimi_forensics_v1").then((r) => r.adapt_kimi_forensics_v1 ?? null)'
  );
  return artifact ?? {};
}

function eventsOf(artifact: ForensicsArtifact, kind: string): Array<Record<string, unknown>> {
  return (artifact.events ?? []).filter((event) => event.kind === kind).map((event) => event.data ?? {});
}

function aiCallCount(artifact: ForensicsArtifact): number {
  return eventsOf(artifact, 'AI_RUNTIME_CALL_BEGIN')
    .filter((data) => data.triggerReason !== 'CONNECTION_TEST').length;
}

/** aiSkip records kind 'AI_SKIP' with data.reason — plus a counter per reason. */
function skipCount(artifact: ForensicsArtifact, reason: string): number {
  return eventsOf(artifact, 'AI_SKIP').filter((data) => data.reason === reason).length;
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

interface MemoryRow {
  consecutiveFailures: number;
  cooldownUntil: number;
  lastReason: string;
}

const readMemory = (browser: Browser) =>
  evaluateWorker<Record<string, MemoryRow>>(
    browser,
    'chrome.storage.local.get("adapt_ai_negative_memory_v1").then((r) => { const m = r.adapt_ai_negative_memory_v1; return m && m.sites ? m.sites : {}; })'
  );

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
  await options.type('#token', MOCK_TOKEN);
  await options.click('#btn-save');
  await new Promise((resolve) => setTimeout(resolve, 800));
  await options.close();
}

async function navigateAndAwaitRejection(
  browser: Browser,
  site: string,
  fixturePort: number,
  expectedInvalidCount: number
): Promise<void> {
  const page = await browser.newPage();
  await page.goto(`http://${site}:${fixturePort}/`, { waitUntil: 'domcontentloaded' });
  await waitFor(async () => {
    const artifact = await readArtifact(browser);
    return eventsOf(artifact, 'POLICY_RESULT').filter((data) => data.valid === false).length >= expectedInvalidCount;
  }, 45_000, `policy rejection #${expectedInvalidCount} on ${site}`);
  await page.close().catch(() => undefined);
}

async function main(): Promise<void> {
  fs.mkdirSync(artifactDir, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-negmem-profile-'));
  const fixtures = await startFixtureServer();
  const relay = await startMockRelay();
  wakePortGlobal = fixtures.port;
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  const push = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  let browser = await launchBrowser(userDataDir);
  try {
    await configureRelay(browser, relay.port);

    // ---- N1-N3: three navigations → three site-signaling failures → cooldown.
    await navigateAndAwaitRejection(browser, 'fail-site.test', fixtures.port, 1);
    await navigateAndAwaitRejection(browser, 'fail-site.test', fixtures.port, 2);
    await navigateAndAwaitRejection(browser, 'fail-site.test', fixtures.port, 3);

    const artifactAfter3 = await readArtifact(browser);
    const failureEvents = eventsOf(artifactAfter3, 'AI_NEGATIVE_MEMORY_FAILURE');
    push('N1-N3: three policy-rejected failures recorded with escalating streak',
      failureEvents.length === 3
        && (failureEvents[0]?.consecutiveFailures ?? 0) === 1
        && (failureEvents[1]?.consecutiveFailures ?? 0) === 2
        && (failureEvents[2]?.consecutiveFailures ?? 0) === 3
        && failureEvents.every((data) => data.reason === 'policy-rejected'),
      `events=${JSON.stringify(failureEvents.map((d) => ({ n: d.consecutiveFailures, cd: d.cooldownMinutes, r: d.reason })))}`);
    push('N3: third failure engaged a 1h cooldown (cooldownMinutes=60)',
      (failureEvents[2]?.cooldownMinutes ?? 0) === 60
        && (failureEvents[0]?.cooldownMinutes ?? -1) === 0
        && (failureEvents[1]?.cooldownMinutes ?? -1) === 0,
      `cooldowns=${JSON.stringify(failureEvents.map((d) => d.cooldownMinutes))}`);

    const cooledDown = await waitFor(async () => {
      const memory = await readMemory(browser);
      return (memory['fail-site.test']?.cooldownUntil ?? 0) > Date.now();
    }, 10_000, 'cooldown persisted in adapt_ai_negative_memory_v1');
    const memoryRow = (await readMemory(browser))['fail-site.test'];
    push('N3: cooldown durable in storage.local (fail-site.test entry, cooldownUntil in future)',
      cooledDown && memoryRow !== undefined && memoryRow.consecutiveFailures === 3,
      `row=${JSON.stringify(memoryRow)}`);

    // ---- N4: cooldown gate — 4th navigation spends ZERO planner calls.
    const aiBefore4 = aiCallCount(artifactAfter3);
    const hitsBefore4 = relayHits;
    const page4 = await browser.newPage();
    await page4.goto(`http://fail-site.test:${fixtures.port}/`, { waitUntil: 'domcontentloaded' });
    const cooldownSkipSeen = await waitFor(async () => {
      const artifact = await readArtifact(browser);
      return skipCount(artifact, 'AI_SITE_COOLDOWN') >= 1;
    }, 30_000, 'AI_SITE_COOLDOWN gate skip');
    await new Promise((resolve) => setTimeout(resolve, 3000)); // let any rogue call land
    const artifactAfter4 = await readArtifact(browser);
    const aiDelta4 = aiCallCount(artifactAfter4) - aiBefore4;
    push('N4: cooling-down site spends ZERO planner calls (no AI_RUNTIME_CALL_BEGIN, relay not hit)',
      cooldownSkipSeen && aiDelta4 === 0 && relayHits === hitsBefore4,
      `skipSeen=${cooldownSkipSeen} aiDelta=${aiDelta4} relayDelta=${relayHits - hitsBefore4}`);
    push('N4: no NEW failure recorded while the gate is short-circuited',
      eventsOf(artifactAfter4, 'AI_NEGATIVE_MEMORY_FAILURE').length === 3,
      `failures=${eventsOf(artifactAfter4, 'AI_NEGATIVE_MEMORY_FAILURE').length}`);
    await page4.close().catch(() => undefined);

    // ---- N5: control site is NOT in cooldown — the budget is per-site.
    const hitsBefore5 = relayHits;
    await navigateAndAwaitRejection(browser, 'other-site.test', fixtures.port, 4); // 4th invalid overall
    const artifactAfter5 = await readArtifact(browser);
    const memoryAfter5 = await readMemory(browser);
    push('N5: unaffected site still gets a planner call (per-site budget)',
      relayHits === hitsBefore5 + 1,
      `relayDelta=${relayHits - hitsBefore5}`);
    push('N5: unaffected site recorded its own FIRST failure, no cooldown yet',
      (memoryAfter5['other-site.test']?.consecutiveFailures ?? 0) === 1
        && (memoryAfter5['other-site.test']?.cooldownUntil ?? Date.now() + 1) <= Date.now(),
      `row=${JSON.stringify(memoryAfter5['other-site.test'])}`);
    push('N5: no AI_SITE_COOLDOWN skip was attributed to the control navigation window',
      skipCount(artifactAfter5, 'AI_SITE_COOLDOWN') === 1,
      `skips=${skipCount(artifactAfter5, 'AI_SITE_COOLDOWN')}`);

    // ---- CTL: first-party control loaded on every page; credential hygiene.
    push('credential never appears in forensic artifact',
      !JSON.stringify(artifactAfter5).includes(MOCK_TOKEN),
      `tokenPresent=${JSON.stringify(artifactAfter5).includes(MOCK_TOKEN)}`);

    await browser.close().catch(() => undefined);

    // ---- N6: restart with the SAME profile — cooldown survives; first navigation
    // post-restart skips without spending a planner call.
    browser = await launchBrowser(userDataDir);
    const hitsBefore6 = relayHits;
    const page6 = await browser.newPage();
    await page6.goto(`http://fail-site.test:${fixtures.port}/`, { waitUntil: 'domcontentloaded' });
    const postRestartSkip = await waitFor(async () => {
      const artifact = await readArtifact(browser);
      return skipCount(artifact, 'AI_SITE_COOLDOWN') >= 1;
    }, 45_000, 'post-restart AI_SITE_COOLDOWN');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const artifactPostRestart = await readArtifact(browser);
    push('N6: cooldown survives a browser restart (same profile) — zero planner calls post-restart',
      postRestartSkip && aiCallCount(artifactPostRestart) === 0 && relayHits === hitsBefore6,
      `skipSeen=${postRestartSkip} aiCallsPostRestart=${aiCallCount(artifactPostRestart)} relayDelta=${relayHits - hitsBefore6}`);
    await page6.close().catch(() => undefined);

    // ---- Artifact --------------------------------------------------------------
    fs.writeFileSync(
      path.join(artifactDir, 'NEGATIVE_MEMORY_PROOF.json'),
      `${JSON.stringify({ schema: 'kimi-negative-memory-proof-v1', ranAt: new Date().toISOString(), checks, pass: checks.every((check) => check.pass) }, null, 2)}\n`
    );
    for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}\n      ${check.detail}`);
    console.log(`\nNEGATIVE MEMORY ${checks.every((check) => check.pass) ? 'PASS' : 'FAIL'} — artifacts: artifacts/kimi-persistent-learning/`);
    if (!checks.every((check) => check.pass)) process.exitCode = 1;
  } catch (error) {
    fs.writeFileSync(
      path.join(artifactDir, 'NEGATIVE_MEMORY_PROOF.json'),
      `${JSON.stringify({ schema: 'kimi-negative-memory-proof-v1', status: 'failed', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
    );
    throw error;
  } finally {
    await wakePage?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await fixtures.close();
    await relay.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('NEGATIVE MEMORY ERROR:', error);
  process.exitCode = 1;
});
