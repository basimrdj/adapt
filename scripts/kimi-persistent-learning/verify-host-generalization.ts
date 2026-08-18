/**
 * PHASE B VERIFICATION — safe host-level generalization (G1–G5 / T4 / T5).
 *
 * Drives the REAL built extension against generic self-hosted fixtures. No benchmark
 * knowledge, no reserved sites. Sequence:
 *
 *   T4a  visit learn-random.test → production AI stages a NARROW session rule for
 *        the track-random family whose URL path is randomized per attempt; host-family
 *        recurrence promotes it to a durable HOST-WIDE dynamic rule (requestDomains,
 *        no fragile URL string), site-scoped to the learning site
 *   G3   same-run consequential blocking: after promotion, a brand-new random path
 *        injected into the SAME page session is blocked pre-request
 *   G4   randomization: reload with fresh random paths → blocked with zero new AI
 *        calls; after a full browser restart → still blocked, still zero AI
 *   T5a  site scoping: the same host embedded on a DIFFERENT site loads at first
 *        (rule scoped to the learning site), the cross-site sighting globalizes the
 *        rule atomically, and a reload is then blocked
 *   T5b  G5 collateral guard: a shared-infra-looking host (cdn-cloudflare.test) is
 *        promoted NARROW ONLY (widthRefusalReason=shared-infra, no requestDomains);
 *        a different path on that host keeps loading
 *   CTL  protected controls: first-party script and a never-learned sibling tracker
 *        load on every page; exactly two durable learned rules exist at the end
 *
 * Writes artifacts/kimi-persistent-learning/HOST_GENERALIZATION_PROOF.json.
 * Artifact hygiene: hosts projected to first DNS labels only; no credentials.
 *
 * Run: npm run build && npx tsx scripts/kimi-persistent-learning/verify-host-generalization.ts
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

function pageHtml(port: number, slug: string, mode: 'random' | 'infra' | 'embed' | 'probe'): string {
  const familyHost = mode === 'infra' ? 'cdn-cloudflare.test' : 'track-random.test';
  const familyKey = mode === 'infra' ? 'infra' : 'track';
  // Sibling loads FIRST; the family chain starts only after the sibling settled, so
  // the deterministic relay (latest-first) always picks the intended family.
  const sibling = mode === 'random'
    ? `<script src="http://sibling-unlearned.test:${port}/res/sib-${slug}.js"
        onload="window.__familyState['sibling']='loaded';window.__startFamily&&window.__startFamily()"
        onerror="window.__familyState['sibling']='blocked';window.__startFamily&&window.__startFamily()"></script>`
    : `<script>window.__familyState['sibling']='n/a';setTimeout(()=>window.__startFamily&&window.__startFamily(),0);</script>`;
  const probe = mode === 'probe'
    ? `window.__startFamily=function(){var s=document.createElement('script');
        s.src='http://cdn-cloudflare.test:${port}/probe-'+Math.random().toString(36).slice(2)+'/z.js';
        s.onload=function(){window.__familyState['probe']='loaded';};
        s.onerror=function(){window.__familyState['probe']='blocked';};
        document.body.appendChild(s);};`
    : `window.__attempts=[];
       window.__injectFamily=function(path){return new Promise(function(resolve){
         var s=document.createElement('script');
         s.src='http://${familyHost}:${port}'+path;
         s.onload=function(){resolve('loaded');};
         s.onerror=function(){resolve('blocked');};
         document.body.appendChild(s);});};
       window.__startFamily=function(){
         var tries=0;
         var tick=function(){
           tries+=1;
           var path='/p'+Math.random().toString(36).slice(2)+'/'+Math.random().toString(36).slice(2)+'/fam.js?v='+Math.random().toString(36).slice(2);
           window.__injectFamily(path).then(function(state){
             window.__attempts.push(state);
             window.__familyState['${familyKey}']=state;
             if(tries<8 && state==='loaded') setTimeout(tick,1200);
           });
         };
         tick();};`;
  return `<!doctype html><html><body><main><h1>Phase B fixture (${mode})</h1><p>Intended content.</p>
<script>window.__familyState={};</script>
<script>${probe}</script>
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
    const isPage = url.pathname === '/'
      || url.pathname.startsWith('/r/')
      || url.pathname.startsWith('/infra')
      || url.pathname.startsWith('/embed');
    if (!isPage) {
      receivedByHost.set(host, [...(receivedByHost.get(host) ?? []), url.pathname]);
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end('/* fixture resource */');
      return;
    }
    const port = (server.address() as { port: number }).port;
    const mode = url.pathname.startsWith('/infra-probe')
      ? 'probe'
      : url.pathname.startsWith('/infra')
        ? 'infra'
        : url.pathname.startsWith('/embed')
          ? 'embed'
          : 'random';
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
            hypothesis: { category: 'UNKNOWN', confidence: 0.8, explanation: 'phase-b fixture relay' },
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

const HOSTS = ['learn-random.test', 'other-random.test', 'track-random.test', 'cdn-cloudflare.test', 'sibling-unlearned.test'];

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
  matchCount: number;
  family: string;
  scoped: boolean;
  siteKeys: number;
  widthRefusal: string | null;
}

interface DynamicRuleRow {
  id: number;
  urlFilter: string | null;
  requestDomains: string[] | null;
  initiatorDomains: string[] | null;
}

const readDurableOwnership = (browser: Browser) =>
  evaluateWorker<DurableRow[]>(
    browser,
    `chrome.storage.local.get("adapt_dnr_dynamic_v1").then((r) => { const f = r.adapt_dnr_dynamic_v1; return f ? Object.values(f.rules).map((x) => ({ ruleId: x.ruleId, lifecycle: x.lifecycle, hostWide: x.hostWide, matchCount: x.matchCount, family: (x.host || "").split(".")[0], scoped: Array.isArray(x.initiatorDomains) && x.initiatorDomains.length > 0, siteKeys: (x.observedSiteKeys || []).length, widthRefusal: x.widthRefusalReason ?? null })) : []; })`
  );
const readDynamicConditions = (browser: Browser) =>
  evaluateWorker<DynamicRuleRow[]>(
    browser,
    'chrome.declarativeNetRequest.getDynamicRules().then((rs) => rs.map((r) => ({ id: r.id, urlFilter: r.condition.urlFilter ?? null, requestDomains: r.condition.requestDomains ?? null, initiatorDomains: r.condition.initiatorDomains ?? null })))'
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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-hostgen-profile-'));
  const fixtures = await startFixtureServer();
  const relay = await startMockRelay();
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  const push = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  let browser = await launchBrowser(userDataDir);
  try {
    await configureRelay(browser, relay.port);

    // ---- T4a: learn the randomized-path family, promote HOST-WIDE + site-scoped.
    const page = await browser.newPage();
    await page.goto(`http://learn-random.test:${fixtures.port}/r/one`, { waitUntil: 'domcontentloaded' });
    const promoted = await waitFor(async () => {
      const durable = await readDurableOwnership(browser);
      return durable.some((record) => record.family === 'track-random' && record.lifecycle === 'PERSISTED_DYNAMIC');
    }, 60_000, 'host-wide promotion of track-random');
    const durableAfterPromote = await readDurableOwnership(browser);
    const trackRecord = durableAfterPromote.find((record) => record.family === 'track-random');
    const conditions = await readDynamicConditions(browser);
    const trackCondition = trackRecord ? conditions.find((row) => row.id === trackRecord.ruleId) : undefined;
    push('T4a: randomized-path family promoted to durable HOST-WIDE rule (requestDomains, no urlFilter)',
      promoted
        && trackRecord?.hostWide === true
        && trackCondition !== undefined
        && trackCondition.urlFilter === null
        && Array.isArray(trackCondition.requestDomains) && trackCondition.requestDomains.length === 1,
      `record=${JSON.stringify(trackRecord)} condition=${JSON.stringify(trackCondition)}`);
    push('T4a: promoted rule is site-scoped to the learning site (initiatorDomains set)',
      trackRecord?.scoped === true
        && trackCondition?.initiatorDomains != null
        && trackCondition.initiatorDomains.length === 1,
      `scoped=${trackRecord?.scoped} conditionInitiators=${JSON.stringify(trackCondition?.initiatorDomains)}`);
    const stateAfterLearn = await familyState(page);
    push('CTL: first-party + never-learned sibling controls loaded during learning',
      stateAfterLearn['own'] === 'loaded' && stateAfterLearn['sibling'] === 'loaded',
      `familyState=${JSON.stringify(stateAfterLearn)}`);

    // ---- G3: same-run consequential blocking — a brand-new random path injected
    // into the SAME page session must be blocked pre-request by the host-wide rule.
    const injectedPath = `/g3-${Math.random().toString(36).slice(2)}/${Math.random().toString(36).slice(2)}/fam.js`;
    const injectedState = await page.evaluate((injected) => {
      const win = window as unknown as { __injectFamily?: (path: string) => Promise<string> };
      return win.__injectFamily ? win.__injectFamily(injected) : Promise.resolve('no-hook');
    }, injectedPath);
    push('G3: same-session request to a NEW random path blocked pre-request (host-wide protection)',
      injectedState === 'blocked',
      `injectedPath=${injectedPath} state=${injectedState}`);

    // ---- G4: randomized reload — different path family, blocked, zero new AI calls.
    const artifactBeforeReload = await readArtifact(browser);
    const aiBefore = eventsOf(artifactBeforeReload, 'AI_RUNTIME_CALL_BEGIN').length;
    await page.goto(`http://learn-random.test:${fixtures.port}/r/two`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const stateReload = await familyState(page);
    const artifactAfterReload = await readArtifact(browser);
    const aiDelta = eventsOf(artifactAfterReload, 'AI_RUNTIME_CALL_BEGIN').length - aiBefore;
    push('G4: randomized revisit blocked with zero new AI calls; controls intact',
      stateReload['track'] === 'blocked' && stateReload['own'] === 'loaded' && stateReload['sibling'] === 'loaded' && aiDelta === 0,
      `familyState=${JSON.stringify(stateReload)} aiDelta=${aiDelta}`);

    // Server-side proof: blocked attempts never reached the fixture server.
    const received = await fetch(`http://127.0.0.1:${fixtures.port}/__received`).then((res) => res.json() as Promise<Record<string, string[]>>);
    const trackReceived = received['track-random.test'] ?? [];
    push('G4: blocked randomized requests never reached the network (server-side log)',
      trackReceived.length >= 1 && trackReceived.every((p) => p.startsWith('/p')),
      `trackRequestsReceived=${trackReceived.length}`);

    // ---- Browser restart: durable host-wide rule still protects, still zero AI.
    await page.close().catch(() => undefined);
    await browser.close();
    browser = await launchBrowser(userDataDir);
    await evaluateWorker(browser, '1');
    const revisit = await browser.newPage();
    await revisit.goto(`http://learn-random.test:${fixtures.port}/r/three`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const statePostRestart = await familyState(revisit);
    const freshArtifact = await readArtifact(browser);
    const aiAfterRestart = eventsOf(freshArtifact, 'AI_RUNTIME_CALL_BEGIN')
      .filter((data) => data.triggerReason !== 'CONNECTION_TEST').length;
    push('G4: after full browser restart, randomized path blocked with zero AI calls',
      statePostRestart['track'] === 'blocked' && statePostRestart['own'] === 'loaded' && aiAfterRestart === 0,
      `familyState=${JSON.stringify(statePostRestart)} aiCalls=${aiAfterRestart}`);
    await revisit.close().catch(() => undefined);

    // ---- T5a: site scoping — the same host on a DIFFERENT site loads at first.
    // The cross-site sighting itself is globalization evidence and fires within
    // milliseconds, so the honest "was allowed" signal is the FIRST attempt's
    // recorded outcome (immutable history), not a late familyState snapshot.
    const embed = await browser.newPage();
    await embed.goto(`http://other-random.test:${fixtures.port}/embed`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const embedFirst = await familyState(embed);
    const embedAttempts = await embed.evaluate(
      () => (window as unknown as { __attempts?: string[] }).__attempts ?? []
    );
    push('T5a: site-scoped learned rule does NOT block the same host on a different site',
      embedAttempts[0] === 'loaded' && embedFirst['own'] === 'loaded',
      `firstAttempt=${embedAttempts[0] ?? 'none'} attempts=${JSON.stringify(embedAttempts)} own=${embedFirst['own']}`);

    // The cross-site sighting is multi-site evidence → atomic globalization.
    const globalized = await waitFor(async () => {
      const durable = await readDurableOwnership(browser);
      const track = durable.find((record) => record.family === 'track-random');
      return track !== undefined && !track.scoped && track.siteKeys >= 2;
    }, 30_000, 'rule globalization after second-site evidence');
    const conditionsGlobal = await readDynamicConditions(browser);
    const trackGlobal = trackRecord ? conditionsGlobal.find((row) => row.id === trackRecord.ruleId) : undefined;
    const artifactGlobal = await readArtifact(browser);
    push('T5a: repeated multi-site evidence globalized the rule atomically (initiatorDomains dropped)',
      globalized && trackGlobal !== undefined && trackGlobal.initiatorDomains === null
        && ((artifactGlobal.counters?.rulesGlobalized ?? 0) >= 1 || eventsOf(artifactGlobal, 'RULE_GLOBALIZED').length >= 1),
      `globalized=${globalized} condition=${JSON.stringify(trackGlobal)} counters.rulesGlobalized=${artifactGlobal.counters?.rulesGlobalized ?? 0}`);

    await embed.goto(`http://other-random.test:${fixtures.port}/embed`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const embedSecond = await familyState(embed);
    push('T5a: after globalization the second site is protected too',
      embedSecond['track'] === 'blocked' && embedSecond['own'] === 'loaded',
      `familyState=${JSON.stringify(embedSecond)}`);
    await embed.close().catch(() => undefined);

    // ---- T5b: G5 collateral guard — shared-infra-looking host stays NARROW.
    const infra = await browser.newPage();
    await infra.goto(`http://learn-random.test:${fixtures.port}/infra`, { waitUntil: 'domcontentloaded' });
    const infraPromoted = await waitFor(async () => {
      const durable = await readDurableOwnership(browser);
      return durable.some((record) => record.family === 'cdn-cloudflare' && record.lifecycle === 'PERSISTED_DYNAMIC');
    }, 60_000, 'infra-family promotion (narrow expected)');
    const durableInfra = await readDurableOwnership(browser);
    const infraRecord = durableInfra.find((record) => record.family === 'cdn-cloudflare');
    const conditionsInfra = await readDynamicConditions(browser);
    const infraCondition = infraRecord ? conditionsInfra.find((row) => row.id === infraRecord.ruleId) : undefined;
    push('T5b: shared-infra host promoted NARROW ONLY (G5 refusal recorded, no requestDomains)',
      infraPromoted
        && infraRecord?.hostWide === false
        && infraRecord.widthRefusal === 'shared-infra'
        && infraCondition !== undefined
        && infraCondition.requestDomains === null
        && typeof infraCondition.urlFilter === 'string',
      `record=${JSON.stringify(infraRecord)} condition=${JSON.stringify(infraCondition)}`);

    // A different path on the infra host must keep loading (widening refused).
    const probe = await browser.newPage();
    await probe.goto(`http://learn-random.test:${fixtures.port}/infra-probe`, { waitUntil: 'domcontentloaded' });
    await waitFor(async () => (await familyState(probe))['probe'] !== undefined, 10_000, 'infra probe settled');
    const probeState = await familyState(probe);
    push('T5b: different path on the infra host still loads (narrow rule preserved)',
      probeState['probe'] === 'loaded' && probeState['own'] === 'loaded',
      `familyState=${JSON.stringify(probeState)}`);
    await infra.close().catch(() => undefined);
    await probe.close().catch(() => undefined);

    // ---- Final hygiene: exactly two durable learned rules, no credential leakage.
    const finalDurable = await readDurableOwnership(browser);
    const finalArtifact = await readArtifact(browser);
    push('CTL: exactly two durable learned rules exist (no rule explosion)',
      finalDurable.filter((record) => record.lifecycle === 'PERSISTED_DYNAMIC').length === 2,
      `durable=${JSON.stringify(finalDurable.map((record) => ({ family: record.family, lifecycle: record.lifecycle, hostWide: record.hostWide })))}`);
    const artifactText = JSON.stringify(finalArtifact);
    push('credential never appears in forensic artifact', !artifactText.includes(MOCK_TOKEN), `tokenPresent=${artifactText.includes(MOCK_TOKEN)}`);

    // ---- Artifact -----------------------------------------------------------------
    fs.writeFileSync(
      path.join(artifactDir, 'HOST_GENERALIZATION_PROOF.json'),
      `${JSON.stringify({ schema: 'kimi-host-generalization-proof-v1', ranAt: new Date().toISOString(), checks, pass: checks.every((check) => check.pass) }, null, 2)}\n`
    );
    for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}\n      ${check.detail}`);
    console.log(`\nHOST GENERALIZATION ${checks.every((check) => check.pass) ? 'PASS' : 'FAIL'} — artifacts: artifacts/kimi-persistent-learning/`);
    if (!checks.every((check) => check.pass)) process.exitCode = 1;
  } catch (error) {
    fs.writeFileSync(
      path.join(artifactDir, 'HOST_GENERALIZATION_PROOF.json'),
      `${JSON.stringify({ schema: 'kimi-host-generalization-proof-v1', status: 'failed', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
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
  console.error('HOST GENERALIZATION ERROR:', error);
  process.exitCode = 1;
});
