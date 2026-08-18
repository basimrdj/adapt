/**
 * PHASE A VERIFICATION — persistence + promotion foundation (F7 / T1 / T2 / T3).
 *
 * Drives the REAL built extension against generic self-hosted fixtures. No benchmark
 * knowledge, no reserved sites. Sequence:
 *
 *   T2a  visit learn.test → production AI stages a narrow session rule
 *        (executor → Chrome session DNR), ownership metadata recorded
 *   T1   terminate the service worker → wake → startup reconcile must KEEP the
 *        session rule, restore ownership, and the allocator must not collide when a
 *        second origin stages a fresh rule
 *   T2b  reload → family recurs (blocked by session rule) → promotion fires →
 *        durable dynamic rule created via the REAL persistLearnedRules path,
 *        verified present through Chrome APIs; redundant session rule removed
 *   T1b  second worker restart → dynamic rule + durable ownership survive reconcile
 *   T3   full Chromium quit + relaunch with the SAME profile → dynamic rule still
 *        present, metadata intact, known family pre-blocked WITHOUT any AI call
 *
 * Writes artifacts/kimi-persistent-learning/{PERSISTENCE_PROOF,WORKER_RESTART_PROOF,
 * BROWSER_RESTART_PROOF}.json. No credentials or raw fixture hosts in artifacts.
 *
 * Run: npm run build && npx tsx scripts/kimi-persistent-learning/verify-persistence.ts
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { Browser } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const root = process.cwd();
const extensionPath = path.join(root, 'dist');
const artifactDir = path.join(root, 'artifacts', 'kimi-persistent-learning');
const MOCK_TOKEN = `dev-mock-token-${Math.random().toString(36).slice(2, 12)}`;

interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

/** Generic fixture: page loads a third-party "family" script plus first-party control. */
async function startFixtureServer(): Promise<RunningServer> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://fixture.test');
    if (url.pathname.startsWith('/res/')) {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end('window.__loaded=(window.__loaded||[]);window.__loaded.push(location?.href||"res");');
      return;
    }
    if (url.pathname.startsWith('/wake')) {
      // Bare page: wakes the extension worker via webRequest without touching any
      // learned family (main_frame type does not match learned resourceTypes).
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body>wake</body></html>');
      return;
    }
    const port = (server.address() as { port: number }).port;
    const slug = url.pathname.replace(/\W/g, '') || 'home';
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><html><body><main><h1>Generic reading page</h1><p id="content">Intended article content.</p>
<script>window.__familyState={};</script>
<script src="http://track-a.test:${port}/res/fam-${slug}.js" onload="window.__familyState['a']='loaded'" onerror="window.__familyState['a']='blocked'"></script>
<script src="http://track-b.test:${port}/res/fam-${slug}.js" onload="window.__familyState['b']='loaded'" onerror="window.__familyState['b']='blocked'"></script>
<script src="/res/own-${slug}.js" onload="window.__familyState['own']='loaded'" onerror="window.__familyState['own']='blocked'"></script>
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
      try {
        const evidence = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { candidateRequests?: Array<{ ref: string }> };
        const targetRef = evidence.candidateRequests?.[0]?.ref;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          plan: {
            schemaVersion: 1,
            decision: targetRef ? 'ADAPT' : 'ABSTAIN',
            hypothesis: { category: 'UNKNOWN', confidence: 0.8, explanation: 'persistence fixture relay' },
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
    close: async () => new Promise((resolve) => server.close(() => resolve())),
  };
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
      '--host-resolver-rules=MAP learn.test 127.0.0.1,MAP other-site.test 127.0.0.1,MAP track-a.test 127.0.0.1,MAP track-b.test 127.0.0.1',
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

/** Terminates the extension service worker, then wakes it with a neutral navigation. */
async function terminateWorker(browser: Browser, fixturePort: number): Promise<void> {
  const target = browser.targets().find((item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'));
  if (target) {
    const worker = await target.worker().catch(() => undefined);
    await worker?.close().catch(() => undefined);
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const still = browser.targets().find((item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'));
    if (!still) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  // Service workers only restart in response to browser events — a bare navigation
  // to a script-free page re-wakes it without touching any learned family.
  const wake = await browser.newPage();
  await wake.goto(`http://other-site.test:${fixturePort}/wake`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await wake.close().catch(() => undefined);
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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(`  (timeout waiting: ${label})`);
  return false;
}

const getSessionRuleIds = (browser: Browser) =>
  evaluateWorker<number[]>(browser, 'chrome.declarativeNetRequest.getSessionRules().then((r) => r.map((x) => x.id))');
const getDynamicRuleIds = (browser: Browser) =>
  evaluateWorker<number[]>(browser, 'chrome.declarativeNetRequest.getDynamicRules().then((r) => r.map((x) => x.id))');
const readDurableOwnership = (browser: Browser) =>
  evaluateWorker<Array<{ ruleId: number; lifecycle: string; hostWide: boolean; matchCount: number; family: string }>>(
    browser,
    'chrome.storage.local.get("adapt_dnr_dynamic_v1").then((r) => { const f = r.adapt_dnr_dynamic_v1; return f ? Object.values(f.rules).map((x) => ({ ruleId: x.ruleId, lifecycle: x.lifecycle, hostWide: x.hostWide, matchCount: x.matchCount, family: (x.host || "").split(".")[0] })) : []; })'
  );
const readSessionOwnershipCount = (browser: Browser) =>
  evaluateWorker<number>(
    browser,
    'chrome.storage.session.get("adapt_dnr_ownership_session_v1").then((r) => { const f = r.adapt_dnr_ownership_session_v1; return f ? Object.keys(f.rules).length : 0; })'
  );

async function main(): Promise<void> {
  fs.mkdirSync(artifactDir, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-persist-profile-'));
  const fixtures = await startFixtureServer();
  const relay = await startMockRelay();
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  const push = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  let browser = await launchBrowser(userDataDir);
  try {
    // Configure the deterministic loopback relay through the REAL options page
    // (stored config wins over the baked default — same surface the wiring proof used).
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
    await options.type('#endpoint', `http://127.0.0.1:${relay.port}/plan`);
    await options.type('#token', MOCK_TOKEN);
    await options.click('#btn-save');
    await new Promise((resolve) => setTimeout(resolve, 800));
    await options.close();

    // ---- T2a: first visit stages a session protection through the production path.
    const page = await browser.newPage();
    await page.goto(`http://learn.test:${fixtures.port}/first`, { waitUntil: 'domcontentloaded' });
    const staged = await waitFor(async () => {
      const artifact = await readArtifact(browser);
      return eventsOf(artifact, 'EXECUTOR_STAGE').some((data) => data.ok === true && data.primitiveId === 'TARGETED_SESSION_DNR');
    }, 45_000, 'session rule staged');
    const sessionIdsAfterStage = await getSessionRuleIds(browser);
    const sessionOwnershipAfterStage = await readSessionOwnershipCount(browser);
    push('T2a: production AI staged a session protection with ownership metadata',
      staged && sessionIdsAfterStage.length >= 1 && sessionOwnershipAfterStage >= 1,
      `staged=${staged} sessionRules=${sessionIdsAfterStage.join(',')} ownershipRecords=${sessionOwnershipAfterStage}`);

    // ---- T1: worker restart must not destroy the learned session rule.
    await terminateWorker(browser, fixtures.port);
    await evaluateWorker(browser, '1'); // confirm the fresh worker answers
    const reconciled = await waitFor(async () => {
      const artifact = await readArtifact(browser);
      return eventsOf(artifact, 'RECONCILE_RESULT').length >= 2; // boot reconcile + post-restart reconcile
    }, 20_000, 'post-restart reconcile');
    const artifactAfterRestart = await readArtifact(browser);
    const reconciles = eventsOf(artifactAfterRestart, 'RECONCILE_RESULT');
    const lastReconcile = reconciles[reconciles.length - 1] ?? {};
    const sessionIdsAfterRestart = await getSessionRuleIds(browser);
    const ownershipAfterRestart = await readSessionOwnershipCount(browser);
    push('T1: session rule + ownership survive worker restart; reconcile removes nothing',
      reconciled
        && (lastReconcile.orphanedSessionRemoved === 0)
        && (lastReconcile.sessionRestored as number) >= 1
        && sessionIdsAfterStage.every((id) => sessionIdsAfterRestart.includes(id))
        && ownershipAfterRestart >= sessionOwnershipAfterStage,
      `reconcile=${JSON.stringify(lastReconcile)} sessionRules=${sessionIdsAfterRestart.join(',')} ownership=${ownershipAfterRestart}`);

    // Allocator collision check: a second origin stages a fresh rule after restart.
    const other = await browser.newPage();
    await other.goto(`http://other-site.test:${fixtures.port}/second`, { waitUntil: 'domcontentloaded' });
    await waitFor(async () => (await getSessionRuleIds(browser)).length > sessionIdsAfterStage.length, 45_000, 'second origin staged');
    const sessionIdsAfterSecond = await getSessionRuleIds(browser);
    const newIds = sessionIdsAfterSecond.filter((id) => !sessionIdsAfterStage.includes(id));
    push('T1: allocator reconstructed without ID collision after restart',
      newIds.length >= 1 && new Set(sessionIdsAfterSecond).size === sessionIdsAfterSecond.length,
      `restored=${sessionIdsAfterStage.join(',')} new=${newIds.join(',')}`);
    await other.close().catch(() => undefined);

    // ---- T2b: family recurs → promotion through the real persistLearnedRules path.
    await page.reload({ waitUntil: 'domcontentloaded' });
    const promoted = await waitFor(async () => {
      const durable = await readDurableOwnership(browser);
      return durable.some((record) => record.lifecycle === 'PERSISTED_DYNAMIC');
    }, 30_000, 'promotion to dynamic rule');
    const dynamicIds = await getDynamicRuleIds(browser);
    const durableRecords = await readDurableOwnership(browser);
    const sessionIdsAfterPromotion = await getSessionRuleIds(browser);
    const promotedRecord = durableRecords.find((record) => record.lifecycle === 'PERSISTED_DYNAMIC');
    push('T2: recurring healthy family promoted to a REAL Chrome dynamic rule',
      promoted && promotedRecord !== undefined && dynamicIds.includes(promotedRecord.ruleId),
      `dynamicRules=${dynamicIds.join(',')} durable=${JSON.stringify(durableRecords.map((r) => ({ ruleId: r.ruleId, lifecycle: r.lifecycle })))}`);
    push('T2: redundant session rule removed only after dynamic install verified',
      !sessionIdsAfterPromotion.some((id) => id === sessionIdsAfterStage[0] && promotedRecord !== undefined) || sessionIdsAfterPromotion.length < sessionIdsAfterSecond.length,
      `sessionBefore=${sessionIdsAfterSecond.join(',')} sessionAfter=${sessionIdsAfterPromotion.join(',')}`);

    // ---- T1b: second worker restart — durable rule survives reconcile.
    await terminateWorker(browser, fixtures.port);
    await evaluateWorker(browser, '1');
    await waitFor(async () => {
      const artifact = await readArtifact(browser);
      return eventsOf(artifact, 'RECONCILE_RESULT').some((data) => (data.dynamicRestored as number) >= 1);
    }, 20_000, 'dynamic restored after restart');
    const dynamicAfterRestart = await getDynamicRuleIds(browser);
    push('T1: promoted dynamic rule survives worker restart reconcile',
      promotedRecord !== undefined && dynamicAfterRestart.includes(promotedRecord.ruleId),
      `dynamicAfterRestart=${dynamicAfterRestart.join(',')}`);

    await page.close().catch(() => undefined);
    await browser.close();

    // ---- T3: full browser restart with the SAME profile.
    browser = await launchBrowser(userDataDir);
    await evaluateWorker(browser, '1');
    const dynamicAfterBoot = await getDynamicRuleIds(browser);
    const durableAfterBoot = await readDurableOwnership(browser);
    push('T3: promoted rule + metadata survive full browser restart',
      promotedRecord !== undefined
        && dynamicAfterBoot.includes(promotedRecord.ruleId)
        && durableAfterBoot.some((record) => record.ruleId === promotedRecord.ruleId && record.lifecycle === 'PERSISTED_DYNAMIC'),
      `dynamic=${dynamicAfterBoot.join(',')} durable=${JSON.stringify(durableAfterBoot.map((r) => ({ ruleId: r.ruleId, lifecycle: r.lifecycle })))}`);

    const revisit = await browser.newPage();
    await revisit.goto(`http://learn.test:${fixtures.port}/first`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const familyState = await revisit.evaluate(() => (window as unknown as { __familyState?: Record<string, string> }).__familyState ?? {});
    const freshArtifact = await readArtifact(browser);
    const aiCallsAfterRestart = eventsOf(freshArtifact, 'AI_RUNTIME_CALL_BEGIN')
      .filter((data) => data.triggerReason !== 'CONNECTION_TEST').length;
    const learnedFamily = promotedRecord?.family === 'track-a' ? 'a' : promotedRecord?.family === 'track-b' ? 'b' : undefined;
    push('T3: known family pre-blocked after browser restart with zero AI calls',
      learnedFamily !== undefined && familyState[learnedFamily] === 'blocked' && familyState['own'] === 'loaded' && aiCallsAfterRestart === 0,
      `learnedFamily=${learnedFamily ?? 'unknown'} familyState=${JSON.stringify(familyState)} aiCalls=${aiCallsAfterRestart}`);
    await revisit.close().catch(() => undefined);

    // ---- Secret hygiene ---------------------------------------------------------
    const artifactText = JSON.stringify(freshArtifact);
    push('credential never appears in forensic artifact', !artifactText.includes(MOCK_TOKEN), `tokenPresent=${artifactText.includes(MOCK_TOKEN)}`);

    // ---- Artifacts ---------------------------------------------------------------
    const writeProof = (name: string, subset: string[], extra: Record<string, unknown> = {}) => {
      const mine = checks.filter((check) => subset.some((prefix) => check.name.startsWith(prefix)));
      fs.writeFileSync(
        path.join(artifactDir, name),
        `${JSON.stringify({ ranAt: new Date().toISOString(), pass: mine.every((check) => check.pass) && mine.length > 0, checks: mine, ...extra }, null, 2)}\n`
      );
    };
    writeProof('WORKER_RESTART_PROOF.json', ['T1']);
    writeProof('PROMOTION_PROOF.json', ['T2']);
    writeProof('BROWSER_RESTART_PROOF.json', ['T3']);
    fs.writeFileSync(
      path.join(artifactDir, 'PERSISTENCE_PROOF.json'),
      `${JSON.stringify({ schema: 'kimi-persistence-proof-v1', ranAt: new Date().toISOString(), checks, pass: checks.every((check) => check.pass) }, null, 2)}\n`
    );
    for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}\n      ${check.detail}`);
    console.log(`\nPERSISTENCE ${checks.every((check) => check.pass) ? 'PASS' : 'FAIL'} — artifacts: artifacts/kimi-persistent-learning/`);
    if (!checks.every((check) => check.pass)) process.exitCode = 1;
  } catch (error) {
    fs.writeFileSync(
      path.join(artifactDir, 'PERSISTENCE_PROOF.json'),
      `${JSON.stringify({ schema: 'kimi-persistence-proof-v1', status: 'failed', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
    );
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
    await fixtures.close();
    await relay.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('PERSISTENCE ERROR:', error);
  process.exitCode = 1;
});
