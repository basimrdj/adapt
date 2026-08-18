/**
 * PHASE F VERIFICATION — within-run host-wide session staging.
 *
 * Drives the REAL built extension against generic self-hosted fixtures. No benchmark
 * knowledge, no reserved sites. Sequence:
 *
 *   F1  visit wide-learn.test/a → production AI stages a NARROW session rule for the
 *       fam-wide family (single attempt, so no recurrence can fire yet); once the
 *       outcome verifier marks it healthy, a HOST-WIDE SESSION TWIN appears
 *       (requestDomains=[fam-wide host], initiatorDomains=[learning site], no
 *       urlFilter) while ZERO durable rules exist for the family — protection
 *       widened within the run, pre-promotion
 *   F2  a second page on the same site requests a BRAND-NEW random path on the
 *       family host → blocked pre-request on the FIRST attempt with zero AI calls
 *       (the narrow learned urlFilter could never match that path — only the twin
 *       can); server-side log proves the request never reached the network
 *   F3  the blocked observation is family recurrence → durable HOST-WIDE promotion
 *       lands and BOTH session rules (narrow + twin) are cleaned up — no stale
 *       session state behind the durable rule
 *   F4  G5 width guard intact: a shared-infra-looking host (cdn-cloudflare.test) is
 *       learned narrow, HOST_WIDE_STAGE_REFUSED is recorded, no requestDomains
 *       session rule ever appears for it, and a different path on that host keeps
 *       loading
 *   CTL first-party + never-learned sibling controls load on every page; the mock
 *       credential never appears in the forensic artifact
 *
 * Writes artifacts/kimi-persistent-learning/HOST_WIDE_STAGING_PROOF.json.
 * Artifact hygiene: hosts projected to first DNS labels only; no credentials.
 *
 * Run: npm run build && npx tsx scripts/kimi-persistent-learning/verify-host-wide-staging.ts
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

/** Server-side request log: host → paths actually received (blocked requests never arrive). */
const receivedByHost = new Map<string, string[]>();

/**
 * One family attempt per page, fired only after the sibling settled — the relay is
 * latest-first, so the intended family is always candidateRequests[0]. Single-shot
 * by design: a retry loop would create recurrence and trigger durable promotion
 * before the session twin can be observed in isolation.
 */
function pageHtml(port: number, slug: string, mode: 'single' | 'infra' | 'probe'): string {
  const familyHost = mode === 'single' ? 'fam-wide.test' : 'cdn-cloudflare.test';
  const withSibling = mode !== 'probe';
  const sibling = withSibling
    ? `<script src="http://sibling-unlearned.test:${port}/res/sib-${slug}.js"
        onload="window.__familyState['sibling']='loaded';window.__startFamily&&window.__startFamily()"
        onerror="window.__familyState['sibling']='blocked';window.__startFamily&&window.__startFamily()"></script>`
    : `<script>window.__familyState['sibling']='n/a';setTimeout(function(){window.__startFamily&&window.__startFamily();},0);</script>`;
  return `<!doctype html><html><body><main><h1>Phase F fixture (${mode})</h1><p>Intended content.</p>
<script>window.__familyState={};window.__attempts=[];</script>
<script>window.__startFamily=function(){
  if(window.__started)return;window.__started=true;
  var path='/p'+Math.random().toString(36).slice(2)+'/'+Math.random().toString(36).slice(2)+'/fam.js?v='+Math.random().toString(36).slice(2);
  var s=document.createElement('script');
  s.src='http://${familyHost}:${port}'+path;
  s.onload=function(){window.__attempts.push('loaded');window.__familyState['fam']='loaded';};
  s.onerror=function(){window.__attempts.push('blocked');window.__familyState['fam']='blocked';};
  document.body.appendChild(s);};</script>
${sibling}
<script src="/res/own-${slug}.js" onload="window.__familyState['own']='loaded'" onerror="window.__familyState['own']='blocked'"></script>
</main></body></html>`;
}

async function startFixtureServer(): Promise<RunningServer> {
  const server = http.createServer((request, response) => {
    const host = (request.headers.host ?? '').split(':')[0] ?? 'unknown';
    const url = new URL(request.url || '/', 'http://fixture.test');
    if (url.pathname === '/__received') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(Object.fromEntries(receivedByHost)));
      return;
    }
    if (url.pathname.startsWith('/wake')) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body>wake</body></html>');
      return;
    }
    const isPage = url.pathname === '/a' || url.pathname === '/b'
      || url.pathname.startsWith('/infra') || url.pathname.startsWith('/probe');
    if (!isPage) {
      receivedByHost.set(host, [...(receivedByHost.get(host) ?? []), url.pathname]);
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end('/* fixture resource */');
      return;
    }
    const port = (server.address() as { port: number }).port;
    const mode = url.pathname.startsWith('/infra') ? 'infra' : url.pathname.startsWith('/probe') ? 'probe' : 'single';
    const slug = Math.random().toString(36).slice(2, 8);
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(pageHtml(port, slug, mode));
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
            hypothesis: { category: 'UNKNOWN', confidence: 0.8, explanation: 'phase-f fixture relay' },
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

const HOSTS = ['wide-learn.test', 'fam-wide.test', 'cdn-cloudflare.test', 'sibling-unlearned.test'];

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

async function evaluateWorker<T>(browser: Browser, expression: string, wakePort: number): Promise<T> {
  const deadline = Date.now() + 15_000;
  let lastError = 'extension worker unavailable';
  while (Date.now() < deadline) {
    const target = browser.targets().find((item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'));
    if (!target) {
      await wakeWorker(browser, wakePort);
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

let wakePortGlobal = 0;
async function readArtifact(browser: Browser): Promise<ForensicsArtifact> {
  const artifact = await evaluateWorker<ForensicsArtifact | null>(
    browser,
    'chrome.storage.session.get("adapt_kimi_forensics_v1").then((r) => r.adapt_kimi_forensics_v1 ?? null)',
    wakePortGlobal
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
  widthRefusal: string | null;
}

interface ConditionRow {
  id: number;
  urlFilter: string | null;
  requestDomains: string[] | null;
  initiatorDomains: string[] | null;
}

const readDurableOwnership = (browser: Browser) =>
  evaluateWorker<DurableRow[]>(
    browser,
    `chrome.storage.local.get("adapt_dnr_dynamic_v1").then((r) => { const f = r.adapt_dnr_dynamic_v1; return f ? Object.values(f.rules).map((x) => ({ ruleId: x.ruleId, lifecycle: x.lifecycle, hostWide: x.hostWide, family: (x.host || "").split(".")[0], widthRefusal: x.widthRefusalReason ?? null })) : []; })`,
    wakePortGlobal
  );

const readSessionConditions = (browser: Browser) =>
  evaluateWorker<ConditionRow[]>(
    browser,
    'chrome.declarativeNetRequest.getSessionRules().then((rs) => rs.map((r) => ({ id: r.id, urlFilter: r.condition.urlFilter ?? null, requestDomains: r.condition.requestDomains ?? null, initiatorDomains: r.condition.initiatorDomains ?? null })))',
    wakePortGlobal
  );

async function familyState(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => (window as unknown as { __familyState?: Record<string, string> }).__familyState ?? {});
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
  await options.type('#token', MOCK_TOKEN);
  await options.click('#btn-save');
  await new Promise((resolve) => setTimeout(resolve, 800));
  await options.close();
}

async function main(): Promise<void> {
  fs.mkdirSync(artifactDir, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-hostwide-profile-'));
  const fixtures = await startFixtureServer();
  const relay = await startMockRelay();
  wakePortGlobal = fixtures.port;
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  const push = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  const browser = await launchBrowser(userDataDir);
  try {
    await configureRelay(browser, relay.port);

    // ---- F1: learn on page A (single attempt) → narrow staged → healthy → twin.
    const pageA = await browser.newPage();
    await pageA.goto(`http://wide-learn.test:${fixtures.port}/a`, { waitUntil: 'domcontentloaded' });
    // The physical rule lands inside addSessionExperimentRules; the HOST_WIDE_STAGED
    // forensic event follows the ownership flush — wait for BOTH so the artifact
    // read below cannot race the trace.
    const twinStaged = await waitFor(async () => {
      const session = await readSessionConditions(browser);
      const artifact = await readArtifact(browser);
      return session.some((rule) => (rule.requestDomains ?? []).some((domain) => domain.startsWith('fam-wide')))
        && eventsOf(artifact, 'HOST_WIDE_STAGED').length >= 1;
    }, 60_000, 'host-wide session twin for fam-wide');
    const sessionAtTwin = await readSessionConditions(browser);
    const twinRule = sessionAtTwin.find((rule) => (rule.requestDomains ?? []).some((domain) => domain.startsWith('fam-wide')));
    const artifactAtTwin = await readArtifact(browser);
    const stagedEvents = eventsOf(artifactAtTwin, 'HOST_WIDE_STAGED');
    const promotedAtTwin = eventsOf(artifactAtTwin, 'RULE_PROMOTED');
    const durableAtTwin = await readDurableOwnership(browser);
    push('F1: healthy narrow rule staged a HOST-WIDE SESSION TWIN (requestDomains, no urlFilter)',
      twinStaged
        && twinRule !== undefined
        && twinRule.urlFilter === null
        && (twinRule.requestDomains ?? []).length === 1,
      `rule=${JSON.stringify(twinRule)} stagedEvents=${stagedEvents.length}`);
    push('F1: twin is site-scoped to the learning site (initiatorDomains)',
      twinRule !== undefined
        && (twinRule.initiatorDomains ?? []).some((domain) => domain.startsWith('wide-learn')),
      `initiators=${JSON.stringify(twinRule?.initiatorDomains)}`);
    push('F1: staging preceded durable promotion (zero durable rules for the family at stage time)',
      stagedEvents.length >= 1
        && promotedAtTwin.length === 0
        && !durableAtTwin.some((record) => record.family === 'fam-wide' && record.lifecycle === 'PERSISTED_DYNAMIC')
        && (artifactAtTwin.counters?.hostWideSessionStaged ?? 0) >= 1,
      `staged=${stagedEvents.length} promoted=${promotedAtTwin.length} counter=${artifactAtTwin.counters?.hostWideSessionStaged ?? 0} durable=${JSON.stringify(durableAtTwin)}`);
    const stateA = await familyState(pageA);
    push('CTL: first-party + never-learned sibling controls loaded during learning',
      stateA['own'] === 'loaded' && stateA['sibling'] === 'loaded' && stateA['fam'] === 'loaded',
      `familyState=${JSON.stringify(stateA)}`);

    // ---- F2: page B — brand-new random path blocked on the FIRST attempt, zero AI.
    const aiBeforeB = aiCallCount(artifactAtTwin);
    const pageB = await browser.newPage();
    await pageB.goto(`http://wide-learn.test:${fixtures.port}/b`, { waitUntil: 'domcontentloaded' });
    await waitFor(async () => (await familyState(pageB))['fam'] !== undefined, 15_000, 'page B family attempt settled');
    const stateB = await familyState(pageB);
    const artifactAfterB = await readArtifact(browser);
    const aiDeltaB = aiCallCount(artifactAfterB) - aiBeforeB;
    push('F2: first-visit repeat on a NEW path blocked host-wide within the run, zero AI calls',
      stateB['fam'] === 'blocked' && stateB['own'] === 'loaded' && stateB['sibling'] === 'loaded' && aiDeltaB === 0,
      `familyState=${JSON.stringify(stateB)} aiDelta=${aiDeltaB}`);

    // Server-side proof: exactly one fam-wide request ever arrived (page A's loaded
    // attempt); page B's blocked attempt never reached the network.
    const received = await fetch(`http://127.0.0.1:${fixtures.port}/__received`).then((res) => res.json() as Promise<Record<string, string[]>>);
    const famReceived = received['fam-wide.test'] ?? [];
    push('F2: blocked repeat never reached the network (server-side log)',
      famReceived.length === 1,
      `famWideRequestsReceived=${famReceived.length} paths=${JSON.stringify(famReceived.map((p) => p.split('/').slice(0, 2).join('/')))}`);

    // ---- F3: recurrence → durable host-wide promotion; BOTH session rules cleaned.
    const promoted = await waitFor(async () => {
      const durable = await readDurableOwnership(browser);
      return durable.some((record) => record.family === 'fam-wide' && record.lifecycle === 'PERSISTED_DYNAMIC' && record.hostWide);
    }, 30_000, 'durable host-wide promotion of fam-wide');
    const sessionCleaned = await waitFor(async () => {
      const session = await readSessionConditions(browser);
      return !session.some((rule) => (rule.requestDomains ?? []).some((domain) => domain.startsWith('fam-wide')));
    }, 15_000, 'session twin cleanup after promotion');
    const durableAfter = await readDurableOwnership(browser);
    const famDurable = durableAfter.find((record) => record.family === 'fam-wide');
    push('F3: blocked observation promoted the family to a durable HOST-WIDE rule',
      promoted && famDurable?.hostWide === true,
      `record=${JSON.stringify(famDurable)}`);
    push('F3: promotion cleaned up the session twin (no stale session state)',
      sessionCleaned,
      `sessionFamWideRules=${JSON.stringify((await readSessionConditions(browser)).filter((rule) => (rule.requestDomains ?? []).some((domain) => domain.startsWith('fam-wide'))))}`);
    await pageA.close().catch(() => undefined);
    await pageB.close().catch(() => undefined);

    // ---- F4: G5 width guard — shared-infra-looking host stays narrow.
    const infra = await browser.newPage();
    await infra.goto(`http://wide-learn.test:${fixtures.port}/infra`, { waitUntil: 'domcontentloaded' });
    const refusalSeen = await waitFor(async () => {
      const artifact = await readArtifact(browser);
      return eventsOf(artifact, 'HOST_WIDE_STAGE_REFUSED').some((data) => data.refusal === 'shared-infra');
    }, 60_000, 'shared-infra host-wide refusal');
    const sessionInfra = await readSessionConditions(browser);
    push('F4: shared-infra host refused host-wide staging (HOST_WIDE_STAGE_REFUSED, no requestDomains rule)',
      refusalSeen
        && !sessionInfra.some((rule) => (rule.requestDomains ?? []).some((domain) => domain.startsWith('cdn-cloudflare'))),
      `refused=${refusalSeen} sessionRulesForHost=${JSON.stringify(sessionInfra.filter((rule) => JSON.stringify(rule).includes('cdn-cloudflare')))}`);

    // A different path on the infra host must keep loading (no host-wide block).
    const aiBeforeProbe = aiCallCount(await readArtifact(browser));
    const probe = await browser.newPage();
    await probe.goto(`http://wide-learn.test:${fixtures.port}/probe`, { waitUntil: 'domcontentloaded' });
    await waitFor(async () => (await familyState(probe))['fam'] !== undefined, 15_000, 'infra probe settled');
    const probeState = await familyState(probe);
    const aiDeltaProbe = aiCallCount(await readArtifact(browser)) - aiBeforeProbe;
    push('F4: different path on the infra host still loads (widening refused, narrow only)',
      probeState['fam'] === 'loaded' && probeState['own'] === 'loaded',
      `familyState=${JSON.stringify(probeState)}`);
    push('F4: probe page triggered no additional AI call',
      aiDeltaProbe === 0,
      `aiDelta=${aiDeltaProbe}`);
    await infra.close().catch(() => undefined);
    await probe.close().catch(() => undefined);

    // ---- Final hygiene ---------------------------------------------------------
    const finalArtifact = await readArtifact(browser);
    const artifactText = JSON.stringify(finalArtifact);
    push('credential never appears in forensic artifact', !artifactText.includes(MOCK_TOKEN), `tokenPresent=${artifactText.includes(MOCK_TOKEN)}`);

    // ---- Artifact -----------------------------------------------------------------
    fs.writeFileSync(
      path.join(artifactDir, 'HOST_WIDE_STAGING_PROOF.json'),
      `${JSON.stringify({ schema: 'kimi-host-wide-staging-proof-v1', ranAt: new Date().toISOString(), checks, pass: checks.every((check) => check.pass) }, null, 2)}\n`
    );
    for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}\n      ${check.detail}`);
    console.log(`\nHOST-WIDE STAGING ${checks.every((check) => check.pass) ? 'PASS' : 'FAIL'} — artifacts: artifacts/kimi-persistent-learning/`);
    if (!checks.every((check) => check.pass)) process.exitCode = 1;
  } catch (error) {
    fs.writeFileSync(
      path.join(artifactDir, 'HOST_WIDE_STAGING_PROOF.json'),
      `${JSON.stringify({ schema: 'kimi-host-wide-staging-proof-v1', status: 'failed', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
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
  console.error('HOST-WIDE STAGING ERROR:', error);
  process.exitCode = 1;
});
