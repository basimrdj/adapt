/**
 * PHASE C VERIFICATION — proactive learned behavior + navigation-epoch discovery
 * (H / I / J / T6 / T7 / T8).
 *
 * Drives the REAL built extension against generic self-hosted fixtures. No benchmark
 * knowledge, no reserved sites. Sequence:
 *
 *   S1  EVERYDAY LEARNING CURVE (curve.test + shared-infra family):
 *       visit1 → bounded AI discovery learns the family (narrow durable rule —
 *       G5 refusal keeps infra hosts narrow, so family requests KEEP COMPLETING);
 *       visit2 (new navigation, same worker) → all observable families covered →
 *       ZERO AI calls, learnedFamilyAiAvoided counter increments;
 *       visit3 (after FULL browser restart) → still zero AI (durable coverage, not
 *       any in-memory latch);
 *       visit4 (?newfamily=1 introduces an uncovered family) → bounded AI audit
 *       returns (≥1 and ≤2 calls).
 *   S2  NAVIGATION-EPOCH AUDIT SCOPING: against an always-ABSTAIN relay, two
 *       navigations of the same origin each trigger a bounded audit (2 calls
 *       total) — the latch no longer suppresses re-audit across navigations.
 *   S3  T8 BREAKAGE ROLLBACK: breakage.test learns fragile.test (host-wide). A
 *       storm page fights the block (aggressive retries = synthetic health
 *       regression) → the durable rule is automatically REVOKED with evidence
 *       preserved, Chrome's dynamic ruleset drops it, and the page heals.
 *
 * Writes artifacts/kimi-persistent-learning/{EVERYDAY_LEARNING_CURVE,
 * NAVIGATION_AUDIT_PROOF, BREAKAGE_ROLLBACK_PROOF}.json.
 * Artifact hygiene: hosts projected to first DNS labels only; no credentials.
 *
 * Run: npm run build && npx tsx scripts/kimi-persistent-learning/verify-proactive-learning.ts
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
const LEARN_TOKEN = `dev-learn-token-${Math.random().toString(36).slice(2, 12)}`;
const ABSTAIN_TOKEN = `dev-abstain-token-${Math.random().toString(36).slice(2, 12)}`;

interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

function pageHtml(port: number, mode: 'curve' | 'curve-new' | 'audit' | 'calm' | 'storm'): string {
  const slug = Math.random().toString(36).slice(2, 8);
  const retryWhileLoaded = (host: string, key: string) => `
    (function(){
      var tries=0;
      var tick=function(){
        tries+=1;
        var s=document.createElement('script');
        s.src='http://${host}:${port}/f'+Math.random().toString(36).slice(2)+'/'+Math.random().toString(36).slice(2)+'/x.js';
        s.onload=function(){window.__familyState['${key}']='loaded'; if(tries<10) setTimeout(tick,1500);};
        s.onerror=function(){window.__familyState['${key}']='blocked';};
        document.body.appendChild(s);
      };
      tick();
    })();`;
  let body = '';
  if (mode === 'curve' || mode === 'curve-new') {
    body = `
      <script>${retryWhileLoaded('cdn-cloudflare.test', 'infra')}</script>
      ${mode === 'curve-new' ? `<script>${retryWhileLoaded('track-new.test', 'newfam')}</script>` : ''}`;
  } else if (mode === 'audit') {
    body = `
      <script src="http://track-x.test:${port}/res/a-${slug}.js" onload="window.__familyState['x']='loaded'" onerror="window.__familyState['x']='blocked'"></script>
      <script src="http://track-y.test:${port}/res/b-${slug}.js" onload="window.__familyState['y']='loaded'" onerror="window.__familyState['y']='blocked'"></script>`;
  } else if (mode === 'calm') {
    body = `<script>${retryWhileLoaded('fragile.test', 'fragile')}</script>`;
  } else {
    // Storm: while the family is BLOCKED, retry aggressively (synthetic health
    // regression — the page fights the block). Stop at the first success.
    body = `
      <script>
      window.__stormStates=[];
      (function(){
        var tries=0;
        var tick=function(){
          tries+=1;
          var s=document.createElement('script');
          s.src='http://fragile.test:${port}/s'+Math.random().toString(36).slice(2)+'/'+Math.random().toString(36).slice(2)+'/x.js';
          s.onload=function(){window.__stormStates.push('loaded');window.__familyState['fragile']='loaded';};
          s.onerror=function(){window.__stormStates.push('blocked');window.__familyState['fragile']='blocked'; if(tries<12) setTimeout(tick,700);};
          document.body.appendChild(s);
        };
        tick();
      })();
      </script>`;
  }
  return `<!doctype html><html><body><main><h1>Phase C fixture (${mode})</h1><p>Intended content.</p>
<script>window.__familyState={};</script>
${body}
<script src="/res/own-${slug}.js" onload="window.__familyState['own']='loaded'" onerror="window.__familyState['own']='blocked'"></script>
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
    const isPage = url.pathname === '/'
      || url.pathname.startsWith('/curve')
      || url.pathname.startsWith('/audit')
      || url.pathname.startsWith('/calm')
      || url.pathname.startsWith('/storm');
    if (!isPage) {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end('/* fixture resource */');
      return;
    }
    const port = (server.address() as { port: number }).port;
    const mode = url.pathname.startsWith('/curve')
      ? (url.searchParams.get('newfamily') === '1' ? 'curve-new' : 'curve')
      : url.pathname.startsWith('/audit')
        ? 'audit'
        : url.pathname.startsWith('/calm')
          ? 'calm'
          : 'storm';
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(pageHtml(port, mode));
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

async function startRelay(mode: 'learn' | 'abstain', token: string): Promise<RunningServer> {
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/plan') {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      try {
        const evidence = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { candidateRequests?: Array<{ ref: string }> };
        const targetRef = mode === 'learn' ? evidence.candidateRequests?.[0]?.ref : undefined;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          plan: {
            schemaVersion: 1,
            decision: targetRef ? 'ADAPT' : 'ABSTAIN',
            hypothesis: { category: 'UNKNOWN', confidence: 0.8, explanation: `phase-c ${mode} relay` },
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

const HOSTS = [
  'curve.test', 'cdn-cloudflare.test', 'track-new.test',
  'nav-audit.test', 'track-x.test', 'track-y.test',
  'breakage.test', 'fragile.test',
];

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

function aiCalls(artifact: ForensicsArtifact): number {
  return eventsOf(artifact, 'AI_RUNTIME_CALL_BEGIN').filter((data) => data.triggerReason !== 'CONNECTION_TEST').length;
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

interface DurableRow {
  ruleId: number;
  lifecycle: string;
  hostWide: boolean;
  family: string;
  revokedReason: string | null;
}

const readDurableOwnership = (browser: Browser) =>
  evaluateWorker<DurableRow[]>(
    browser,
    `chrome.storage.local.get("adapt_dnr_dynamic_v1").then((r) => { const f = r.adapt_dnr_dynamic_v1; return f ? Object.values(f.rules).map((x) => ({ ruleId: x.ruleId, lifecycle: x.lifecycle, hostWide: x.hostWide, family: (x.host || "").split(".")[0], revokedReason: x.revokedReason ?? null })) : []; })`
  );
const getDynamicRuleIds = (browser: Browser) =>
  evaluateWorker<number[]>(browser, 'chrome.declarativeNetRequest.getDynamicRules().then((r) => r.map((x) => x.id))');

async function familyState(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => (window as unknown as { __familyState?: Record<string, string> }).__familyState ?? {});
}

async function configureRelay(browser: Browser, relayPort: number, token: string): Promise<void> {
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
  await options.type('#token', token);
  await options.click('#btn-save');
  await new Promise((resolve) => setTimeout(resolve, 800));
  await options.close();
}

async function main(): Promise<void> {
  fs.mkdirSync(artifactDir, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-proactive-profile-'));
  const fixtures = await startFixtureServer();
  const learnRelay = await startRelay('learn', LEARN_TOKEN);
  const abstainRelay = await startRelay('abstain', ABSTAIN_TOKEN);
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  const push = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const curve: Array<{ visit: string; aiCalls: number }> = [];

  let browser = await launchBrowser(userDataDir);
  try {
    await configureRelay(browser, learnRelay.port, LEARN_TOKEN);

    // ---- S1 visit1: bounded AI discovery learns the infra family (narrow durable).
    const page = await browser.newPage();
    await page.goto(`http://curve.test:${fixtures.port}/curve`, { waitUntil: 'domcontentloaded' });
    const learned = await waitFor(async () => {
      const durable = await readDurableOwnership(browser);
      return durable.some((record) => record.family === 'cdn-cloudflare' && record.lifecycle === 'PERSISTED_DYNAMIC');
    }, 60_000, 'narrow durable promotion of infra family');
    const artifact1 = await readArtifact(browser);
    const aiVisit1 = aiCalls(artifact1);
    curve.push({ visit: 'visit1-discovery', aiCalls: aiVisit1 });
    push('S1 visit1: bounded AI discovery learned the family (narrow durable, G5 infra refusal)',
      learned && aiVisit1 >= 1 && aiVisit1 <= 2
        && (await readDurableOwnership(browser)).some((r) => r.family === 'cdn-cloudflare' && r.hostWide === false),
      `learned=${learned} aiCalls=${aiVisit1}`);

    // ---- S1 visit2: new navigation, same worker — all families covered → zero AI.
    await page.goto(`http://curve.test:${fixtures.port}/curve`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const artifact2 = await readArtifact(browser);
    const aiVisit2 = aiCalls(artifact2) - aiVisit1;
    const avoided2 = artifact2.counters?.learnedFamilyAiAvoided ?? 0;
    curve.push({ visit: 'visit2-covered-same-worker', aiCalls: aiVisit2 });
    push('S1 visit2: known-family coverage short-circuits the planner (zero AI)',
      aiVisit2 === 0 && avoided2 >= 1,
      `aiDelta=${aiVisit2} learnedFamilyAiAvoided=${avoided2}`);

    // ---- S1 visit3: full browser restart — durable coverage, still zero AI.
    await page.close().catch(() => undefined);
    await browser.close();
    browser = await launchBrowser(userDataDir);
    await evaluateWorker(browser, '1');
    const revisit = await browser.newPage();
    await revisit.goto(`http://curve.test:${fixtures.port}/curve`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const artifact3 = await readArtifact(browser);
    const aiVisit3 = aiCalls(artifact3);
    const avoided3 = artifact3.counters?.learnedFamilyAiAvoided ?? 0;
    curve.push({ visit: 'visit3-covered-after-browser-restart', aiCalls: aiVisit3 });
    push('S1 visit3: after browser restart, coverage still avoids all AI calls',
      aiVisit3 === 0 && avoided3 >= 1,
      `aiCalls=${aiVisit3} learnedFamilyAiAvoided=${avoided3}`);

    // ---- S1 visit4: a NEW uncovered family restores bounded discovery.
    await revisit.goto(`http://curve.test:${fixtures.port}/curve?newfamily=1`, { waitUntil: 'domcontentloaded' });
    const newFamilyAudited = await waitFor(async () => aiCalls(await readArtifact(browser)) > aiVisit3, 45_000, 'bounded audit for new family');
    const artifact4 = await readArtifact(browser);
    const aiVisit4 = aiCalls(artifact4) - aiVisit3;
    curve.push({ visit: 'visit4-new-family', aiCalls: aiVisit4 });
    push('S1 visit4: uncovered family triggers bounded AI discovery (>=1, <=2 calls)',
      newFamilyAudited && aiVisit4 >= 1 && aiVisit4 <= 2,
      `aiDelta=${aiVisit4}`);
    await revisit.close().catch(() => undefined);

    // ---- S2: navigation-epoch audit scoping under an always-ABSTAIN relay.
    await configureRelay(browser, abstainRelay.port, ABSTAIN_TOKEN);
    const auditPage = await browser.newPage();
    const aiBeforeAudit = aiCalls(await readArtifact(browser));
    await auditPage.goto(`http://nav-audit.test:${fixtures.port}/audit`, { waitUntil: 'domcontentloaded' });
    const firstAudit = await waitFor(async () => aiCalls(await readArtifact(browser)) > aiBeforeAudit, 45_000, 'first navigation audit');
    const aiAfterNav1 = aiCalls(await readArtifact(browser));
    await auditPage.goto(`http://nav-audit.test:${fixtures.port}/audit`, { waitUntil: 'domcontentloaded' });
    const secondAudit = await waitFor(async () => aiCalls(await readArtifact(browser)) > aiAfterNav1, 45_000, 'second navigation audit');
    const aiAfterNav2 = aiCalls(await readArtifact(browser));
    const nav1Calls = aiAfterNav1 - aiBeforeAudit;
    const nav2Calls = aiAfterNav2 - aiAfterNav1;
    push('S2: audit latch is navigation-scoped — each navigation re-audits, bounded <=2',
      firstAudit && secondAudit && nav1Calls === 1 && nav2Calls === 1,
      `nav1Calls=${nav1Calls} nav2Calls=${nav2Calls}`);
    const auditState = await familyState(auditPage);
    push('S2: abstain relay left both families untouched (no learning without evidence)',
      auditState['x'] === 'loaded' && auditState['y'] === 'loaded' && auditState['own'] === 'loaded',
      `familyState=${JSON.stringify(auditState)}`);
    await auditPage.close().catch(() => undefined);

    // ---- S3: T8 breakage rollback — retry storm revokes the durable rule.
    await configureRelay(browser, learnRelay.port, LEARN_TOKEN);
    const calm = await browser.newPage();
    await calm.goto(`http://breakage.test:${fixtures.port}/calm`, { waitUntil: 'domcontentloaded' });
    const fragilePromoted = await waitFor(async () => {
      const durable = await readDurableOwnership(browser);
      return durable.some((record) => record.family === 'fragile' && record.lifecycle === 'PERSISTED_DYNAMIC');
    }, 60_000, 'host-wide promotion of fragile family');
    const fragileRecord = (await readDurableOwnership(browser)).find((record) => record.family === 'fragile');
    push('T8 setup: fragile family learned and promoted (host-wide durable)',
      fragilePromoted && fragileRecord?.hostWide === true,
      `record=${JSON.stringify(fragileRecord)}`);
    await calm.close().catch(() => undefined);

    const storm = await browser.newPage();
    await storm.goto(`http://breakage.test:${fixtures.port}/storm`, { waitUntil: 'domcontentloaded' });
    const healed = await waitFor(async () => (await familyState(storm))['fragile'] === 'loaded', 45_000, 'storm page healed after revocation');
    const stormStates = await storm.evaluate(
      () => (window as unknown as { __stormStates?: string[] }).__stormStates ?? []
    );
    const durableAfterStorm = await readDurableOwnership(browser);
    const revokedRecord = durableAfterStorm.find((record) => record.family === 'fragile');
    const dynamicAfterStorm = await getDynamicRuleIds(browser);
    const artifactStorm = await readArtifact(browser);
    push('T8: retry-storm health regression automatically revoked the durable rule',
      healed
        && revokedRecord?.lifecycle === 'REVOKED'
        && revokedRecord.revokedReason === 'retry-storm-health-regression'
        && (revokedRecord === undefined || !dynamicAfterStorm.includes(revokedRecord.ruleId)),
      `stormStates=${JSON.stringify(stormStates)} record=${JSON.stringify(revokedRecord)} dynamic=${dynamicAfterStorm.join(',')}`);
    push('T8: rollback evidence preserved (counters + REVOKED record retained)',
      (artifactStorm.counters?.rollbackOnRegression ?? 0) >= 1
        && (artifactStorm.counters?.rulesRevoked ?? 0) >= 1
        && revokedRecord !== undefined,
      `rollbackOnRegression=${artifactStorm.counters?.rollbackOnRegression ?? 0} rulesRevoked=${artifactStorm.counters?.rulesRevoked ?? 0}`);
    push('T8: page healed after revocation (family loads again, first-party intact)',
      healed && (await familyState(storm))['own'] === 'loaded',
      `familyState=${JSON.stringify(await familyState(storm))}`);
    await storm.close().catch(() => undefined);

    // ---- Hygiene + artifacts -------------------------------------------------------
    const finalArtifact = await readArtifact(browser);
    const artifactText = JSON.stringify(finalArtifact);
    push('credentials never appear in forensic artifact',
      !artifactText.includes(LEARN_TOKEN) && !artifactText.includes(ABSTAIN_TOKEN),
      `learnToken=${artifactText.includes(LEARN_TOKEN)} abstainToken=${artifactText.includes(ABSTAIN_TOKEN)}`);

    const writeProof = (name: string, subset: string[], extra: Record<string, unknown> = {}) => {
      const mine = checks.filter((check) => subset.some((prefix) => check.name.startsWith(prefix)));
      fs.writeFileSync(
        path.join(artifactDir, name),
        `${JSON.stringify({ ranAt: new Date().toISOString(), pass: mine.every((check) => check.pass) && mine.length > 0, checks: mine, ...extra }, null, 2)}\n`
      );
    };
    writeProof('NAVIGATION_AUDIT_PROOF.json', ['S2']);
    writeProof('BREAKAGE_ROLLBACK_PROOF.json', ['T8']);
    fs.writeFileSync(
      path.join(artifactDir, 'EVERYDAY_LEARNING_CURVE.json'),
      `${JSON.stringify({
        schema: 'kimi-everyday-learning-curve-v1',
        ranAt: new Date().toISOString(),
        curve,
        counters: {
          learnedFamilyAiAvoided: finalArtifact.counters?.learnedFamilyAiAvoided ?? 0,
          dynamicRulesPromoted: finalArtifact.counters?.dynamicRulesPromoted ?? 0,
          rollbackOnRegression: finalArtifact.counters?.rollbackOnRegression ?? 0,
        },
        checks: checks.filter((check) => check.name.startsWith('S1')),
        pass: checks.filter((check) => check.name.startsWith('S1')).every((check) => check.pass),
      }, null, 2)}\n`
    );
    for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}\n      ${check.detail}`);
    console.log(`\nPROACTIVE LEARNING ${checks.every((check) => check.pass) ? 'PASS' : 'FAIL'} — artifacts: artifacts/kimi-persistent-learning/`);
    if (!checks.every((check) => check.pass)) process.exitCode = 1;
  } catch (error) {
    fs.writeFileSync(
      path.join(artifactDir, 'EVERYDAY_LEARNING_CURVE.json'),
      `${JSON.stringify({ schema: 'kimi-everyday-learning-curve-v1', status: 'failed', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
    );
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
    await fixtures.close();
    await learnRelay.close();
    await abstainRelay.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('PROACTIVE LEARNING ERROR:', error);
  process.exitCode = 1;
});
