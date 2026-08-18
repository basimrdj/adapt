import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { OpenAI } from 'openai';
import puppeteer, { Browser } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';
import { requireAzureApiKey, requireAzureBaseURL, requireAzureModel } from '../azure-env';
import { ADAPTATION_PLAN_JSON_SCHEMA } from '../../src/shared/ai/schemas';

const root = process.cwd();
const extensionPath = path.join(root, 'dist');
const artifactDir = path.join(root, 'artifacts', 'final-intelligence');

type FixtureFamily =
  | 'third-party-script-surface'
  | 'third-party-iframe'
  | 'successful-fetch-surface'
  | 'two-scripts-one-causal'
  | 'benign-cdn-plus-ad'
  | 'network-only'
  | 'repeated-request'
  | 'reinserting-surface'
  | 'popup-attempt'
  | 'anti-block-confounder'
  | 'two-visual-targets'
  | 'delayed-survivor'
  | 'interaction-survivor'
  | 'spa-survivor'
  | 'ad-named-benign'
  | 'neutral-host-hostile';

interface Fixture {
  token: string;
  family: FixtureFamily;
  protected: boolean;
}

interface RunningServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

const INVENTORY: FixtureFamily[] = [
  'third-party-script-surface',
  'third-party-iframe',
  'successful-fetch-surface',
  'two-scripts-one-causal',
  'benign-cdn-plus-ad',
  'network-only',
  'repeated-request',
  'reinserting-surface',
  'popup-attempt',
  'anti-block-confounder',
  'two-visual-targets',
  'delayed-survivor',
  'interaction-survivor',
  'spa-survivor',
  'ad-named-benign',
  'neutral-host-hostile',
];

const ACTIVE_RUN: FixtureFamily[] = [
  'third-party-script-surface',
  'two-scripts-one-causal',
  'network-only',
  'neutral-host-hostile',
];

const PROTECTED_RUN: FixtureFamily[] = ['third-party-iframe', 'ad-named-benign'];

function token(): string {
  return Math.random().toString(36).slice(2, 12);
}

async function startRelay(): Promise<RunningServer> {
  const client = new OpenAI({
    apiKey: requireAzureApiKey(),
    baseURL: requireAzureBaseURL(),
    timeout: 5000,
    maxRetries: 0,
  });
  const model = requireAzureModel();
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/plan') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const evidence = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    try {
      const completion = await client.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: [
              'You are the ADAPT survivor attribution planner.',
              'Return only the strict AdaptationPlan JSON schema.',
              'Use only supplied opaque refs and supplied safe action IDs.',
              'Never emit URLs, code, selectors, or invented refs.',
              'For TARGETED_SESSION_DNR, set targetRef to a supplied request ref and parameter to the empty string.',
              'Do not copy any URL, filter, host, or path into parameter.',
              'For ambiguous third-party survivor evidence, prefer one TARGETED_SESSION_DNR action on the strongest supplied request ref.',
              'Abstain for protected auth, payment, media, download, or user-intent contexts.',
            ].join(' '),
          },
          { role: 'user', content: JSON.stringify(evidence) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'adapt_survivor_plan', strict: true, schema: ADAPTATION_PLAN_JSON_SCHEMA as never },
        },
        reasoning_effort: 'low',
        max_completion_tokens: 600,
      });
      const content = completion.choices[0]?.message?.content;
      if (!content) throw new Error('empty-provider-response');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ plan: JSON.parse(content) }));
    } catch (error) {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'provider-error' }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('relay did not bind');
  return {
    server,
    port: address.port,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startFixtureServer(fixtures: Fixture[]): Promise<RunningServer> {
  const byToken = new Map(fixtures.map((fixture) => [fixture.token, fixture]));
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://site.test');
    const segments = requestUrl.pathname.split('/').filter(Boolean);
    const fixture = segments[0] === 'case' ? byToken.get(segments[1] || '') : undefined;
    const resourceFixture = segments[0] === 'resource' ? byToken.get(segments[1] || '') : undefined;
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : 0;
    if (fixture) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(pageHtml(fixture, port));
      return;
    }
    if (resourceFixture) {
      response.writeHead(200, { 'content-type': resourceFixture.family === 'third-party-iframe' ? 'text/html' : 'application/javascript' });
      response.end(resourceBody(resourceFixture, port));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  return {
    server,
    port: address.port,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function pageHtml(fixture: Fixture, resourcePort: number): string {
  const thirdParty = `http://ads.test:${resourcePort}/resource/${fixture.token}`;
  const protectedMarkup = fixture.protected
    ? `<iframe title="sign in" src="http://auth.test:${resourcePort}/resource/${fixture.token}" style="width:640px;height:360px"></iframe>`
    : '';
  const bootstrap = fixture.family === 'third-party-iframe'
    ? `<iframe src="${thirdParty}" style="width:640px;height:360px"></iframe>`
    : `<script src="${thirdParty}"></script>`;
  return `<!doctype html><html><body><main><h1>Reading page</h1><p id="content">The intended article content remains available.</p>${protectedMarkup}${bootstrap}<button id="action">Continue</button><div id="app"></div></main></body></html>`;
}

function resourceBody(fixture: Fixture, resourcePort: number): string {
  const surface = `const add=()=>{const e=document.createElement('div');e.dataset.adSlot='1';e.className='promo-surface';e.style.cssText='position:fixed;inset:auto 20px 20px auto;width:280px;height:140px;background:#f59e0b;z-index:1000';e.textContent='Sponsored content';document.body.appendChild(e)};`;
  switch (fixture.family) {
    case 'third-party-iframe': return '<!doctype html><html><body>Embedded content</body></html>';
    case 'third-party-script-surface': return `${surface}add();`;
    case 'two-scripts-one-causal': return `fetch('/resource/${fixture.token}/benign.js').catch(()=>{});${surface}setTimeout(add,40);`;
    case 'successful-fetch-surface': return `fetch('/resource/${fixture.token}/ad.js').then(()=>{${surface}add()});`;
    case 'network-only': return `fetch('/resource/${fixture.token}/beacon.js').catch(()=>{});const probe=new Image();probe.src='http://ads.test:${resourcePort}/resource/${fixture.token}/third-party-beacon.js';`;
    case 'repeated-request': return `let n=0;const tick=()=>{fetch('/resource/${fixture.token}/repeat.js').catch(()=>{});if(++n<3)setTimeout(tick,80);};tick();`;
    case 'reinserting-surface': return `${surface}add();setInterval(()=>{if(!document.querySelector('[data-ad-slot]'))add()},100);`;
    case 'popup-attempt': return `document.querySelector('#action')?.addEventListener('click',()=>window.open('${locationPath(fixture.token)}','_blank'));`;
    case 'anti-block-confounder': return `${surface}add();`;
    case 'two-visual-targets': return `${surface}add();const benign=document.createElement('div');benign.style.cssText='position:fixed;left:20px;bottom:20px;width:220px;height:80px;background:#ddd';benign.textContent='Settings';document.body.appendChild(benign);`;
    case 'delayed-survivor': return `setTimeout(()=>{${surface}add()},220);`;
    case 'interaction-survivor': return `document.querySelector('#action')?.addEventListener('click',()=>{${surface}add()});`;
    case 'spa-survivor': return `setTimeout(()=>{history.pushState({},'',location.pathname+'#next');${surface}add()},220);`;
    case 'ad-named-benign': return `const img=document.createElement('img');img.src='/resource/${fixture.token}/ad-assets.js';img.alt='site logo';document.body.appendChild(img);`;
    case 'neutral-host-hostile': return `${surface}add();`;
    case 'benign-cdn-plus-ad': return `${surface}add();`;
  }
}

function locationPath(tokenValue: string): string {
  return `/case/${tokenValue}/target`;
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
      '--host-resolver-rules=MAP site.test 127.0.0.1,MAP ads.test 127.0.0.1,MAP auth.test 127.0.0.1,MAP cdn.test 127.0.0.1',
    ],
  });
}

async function evaluateWorker<T>(browser: Browser, expression: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  let lastError = 'extension worker unavailable';
  while (Date.now() < deadline) {
    const target = browser.targets().find((item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'))
      ?? await browser.waitForTarget(
        (item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'),
        { timeout: 1000 }
      ).catch(() => undefined);
    if (target) {
      const client = await target.createCDPSession();
      try {
        const response = await client.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (!response.exceptionDetails) return response.result.value as T;
        lastError = response.exceptionDetails.exception?.description || 'extension worker evaluation failed';
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        await client.detach().catch(() => undefined);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(lastError);
}

async function configurePlanner(browser: Browser, relayPort: number): Promise<void> {
  await evaluateWorker(browser, `chrome.storage.local.set(${JSON.stringify({ adapt_ai_config: { endpoint: `http://127.0.0.1:${relayPort}/plan` } })})`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

async function readTrace(browser: Browser): Promise<Record<string, unknown>[]> {
  const trace = await evaluateWorker<{ adapt_survivor_ai_trace?: Record<string, unknown>[] }>(browser, 'chrome.storage.session.get("adapt_survivor_ai_trace")');
  return trace.adapt_survivor_ai_trace ?? [];
}

async function readCausalSummary(browser: Browser): Promise<Record<string, unknown>> {
  type CausalState = {
    adapt_causal_session_state_v1?: {
      graphs?: Array<{
        graphId?: string;
        nodes?: Array<{
          kind?: string;
          features?: Record<string, unknown>;
          scope?: { navigationEpoch?: number; documentId?: string; frameId?: number };
          refs?: string[];
        }>;
        hypotheses?: unknown[];
      }>;
    };
  };
  const value = await evaluateWorker<CausalState>(browser, 'chrome.storage.session.get("adapt_causal_session_state_v1")');
  const graphs = value.adapt_causal_session_state_v1?.graphs ?? [];
  const nodes = graphs.flatMap((graph) => graph.nodes ?? []);
  const count = (predicate: (node: { kind?: string; features?: Record<string, unknown> }) => boolean): number => nodes.filter(predicate).length;
  return {
    graphCount: graphs.length,
    nodeCount: nodes.length,
    requestStartCount: count((node) => node.kind === 'REQUEST_START'),
    requestCompleteCount: count((node) => node.kind === 'REQUEST_COMPLETE'),
    thirdPartyRequestCompleteCount: count((node) => node.kind === 'REQUEST_COMPLETE' && node.features?.thirdParty === true),
    visibleSurvivorCount: count((node) => node.kind === 'VISIBLE_AD_CANDIDATE'),
    hypothesisCount: graphs.reduce((total, graph) => total + (graph.hypotheses?.length ?? 0), 0),
    graphSummaries: graphs.map((graph) => ({
      graphId: graph.graphId ?? null,
      navigationEpoch: graph.nodes?.[0]?.scope?.navigationEpoch ?? null,
      documentId: graph.nodes?.[0]?.scope?.documentId ?? null,
      frameId: graph.nodes?.[0]?.scope?.frameId ?? null,
      coarsePaths: (graph.nodes ?? []).filter((node) => node.kind === 'REQUEST_COMPLETE').map((node) => node.features?.coarsePath ?? null),
      nodeKinds: (graph.nodes ?? []).map((node) => node.kind ?? 'unknown'),
      refs: (graph.nodes ?? []).flatMap((node) => (node as { refs?: string[] }).refs ?? []).filter((ref) => ref.startsWith('request:') || ref.startsWith('survivor:') || ref.startsWith('element:')),
      requestFeatures: (graph.nodes ?? []).filter((node) => node.kind === 'REQUEST_COMPLETE').map((node) => ({
        thirdParty: node.features?.thirdParty ?? null,
        resourceType: node.features?.resourceType ?? null,
      })),
      hypothesisCount: graph.hypotheses?.length ?? 0,
    })),
  };
}

async function runCorpus(browser: Browser, port: number, fixtures: Fixture[], traceOffset = 0): Promise<Record<string, unknown>> {
  const observed: Record<string, unknown>[] = [];
  for (const fixture of fixtures) {
    const page = await browser.newPage();
    try {
      await page.goto(`http://site.test:${port}/case/${fixture.token}`, { waitUntil: 'domcontentloaded' });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const state = await page.evaluate(() => ({
        visibleAdSurfaces: document.querySelectorAll('[data-ad-slot]').length,
        thirdPartyFrames: document.querySelectorAll('iframe').length,
        contentPresent: Boolean(document.querySelector('#content')),
        url: location.href,
      }));
      observed.push({ family: fixture.family, protected: fixture.protected, ...state });
    } finally {
      await page.close();
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const trace = (await readTrace(browser)).slice(traceOffset);
  const causalSummary = await readCausalSummary(browser);
  const activeObserved = observed.filter((item) => item.protected !== true);
  return {
    observed,
    survivors: activeObserved.filter((item) => Number(item.visibleAdSurfaces) > 0 || Number(item.thirdPartyFrames) > 0).length,
    protectedFlows: observed.filter((item) => item.protected === true).length,
    protectedFlowFalsePositives: observed.filter((item) => item.protected && Number(item.visibleAdSurfaces) === 0 && Number(item.thirdPartyFrames) === 0).length,
    aiCalls: trace.length,
    aiCallsNovelNetworkDiscovery: trace.filter((item) => item.triggerReason === 'NOVEL_NETWORK_DISCOVERY').length,
    aiCallsAmbiguousSurvivor: trace.filter((item) => item.triggerReason === 'SURVIVOR_ATTRIBUTION').length,
    successfulExperiments: trace.filter((item) => item.sessionProtectionInstalled === true || item.survivorResolved === true).length,
    learnedSessionProtections: trace.filter((item) => item.sessionProtectionInstalled === true).length,
    causalSummary,
    trace,
  };
}

async function main(): Promise<void> {
  fs.mkdirSync(artifactDir, { recursive: true });
  const aiEnabled = process.env.ADAPT_LAB_DISABLE_AI !== '1';
  const fixtures: Fixture[] = [...INVENTORY, ...PROTECTED_RUN].map((family) => ({
    token: token(),
    family,
    protected: PROTECTED_RUN.includes(family),
  }));
  const relay = await startRelay();
  const fixtureServer = await startFixtureServer(fixtures);
  const active = fixtures.filter((fixture) => ACTIVE_RUN.includes(fixture.family));
  const protectedFixtures = fixtures.filter((fixture) => PROTECTED_RUN.includes(fixture.family));
  const browser = await launchBrowser();
  try {
    if (aiEnabled) await configurePlanner(browser, relay.port);
    let traceOffset = 0;
    const run1 = await runCorpus(browser, fixtureServer.port, [...active, ...protectedFixtures], traceOffset);
    traceOffset += (run1.trace as unknown[]).length;
    const run2 = await runCorpus(browser, fixtureServer.port, [...active, ...protectedFixtures], traceOffset);
    traceOffset += (run2.trace as unknown[]).length;
    const run3 = await runCorpus(browser, fixtureServer.port, [...active, ...protectedFixtures], traceOffset);
    await browser.close();

    const fresh = await launchBrowser();
    if (aiEnabled) await configurePlanner(fresh, relay.port);
    const freshProfileControl = await runCorpus(fresh, fixtureServer.port, [...active, ...protectedFixtures], 0);
    await fresh.close();

    const result = {
      schema: 'adapt-final-survivor-intelligence-v1',
      provider: { liveProviderConfigured: aiEnabled, mockPlanner: false, modelClass: process.env.AZURE_OPENAI_MODEL ?? 'unset' },
      inventory: INVENTORY,
      executedFamilies: [...ACTIVE_RUN, ...PROTECTED_RUN],
      run1,
      run2,
      run3,
      freshProfileControl,
      note: 'The executed corpus is intentionally generic and tokenized; evaluator truth remains outside the extension runtime.',
    };
    fs.writeFileSync(path.join(artifactDir, 'SELF_IMPROVEMENT.json'), `${JSON.stringify(result, null, 2)}\n`);
    fs.writeFileSync(path.join(artifactDir, 'SURVIVOR_AI_TRACE.json'), `${JSON.stringify({ run1: run1.trace, run2: run2.trace, run3: run3.trace, freshProfileControl: freshProfileControl.trace }, null, 2)}\n`);
  } finally {
    await browser.close().catch(() => undefined);
    await fixtureServer.close();
    await relay.close();
  }
}

main().catch((error) => {
  fs.writeFileSync(path.join(artifactDir, 'SELF_IMPROVEMENT.json'), `${JSON.stringify({ schema: 'adapt-final-survivor-intelligence-v1', status: 'failed', error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2)}\n`);
  process.exitCode = 1;
});
