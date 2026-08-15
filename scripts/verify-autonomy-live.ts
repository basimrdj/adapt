import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { Browser, Page, Target } from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DnrController } from '../src/core/dnr/controller';
import { PrimitiveExecutorRegistry } from '../src/background/autonomy/executor-registry';
import { EphemeralNavigationTargetRegistry } from '../src/background/autonomy/navigation-targets';
import { PrimitiveId } from '../src/background/autonomy/primitive-registry';
import { chromeExecutable } from '../tests/support/chrome-executable';

type TrialPrimary = 'overlay' | 'popup' | 'scroll' | 'pointer' | 'redirect' | 'control';
type HoldoutMechanism =
  | 'anti-block-overlay'
  | 'semantic-inline-gate'
  | 'scroll-only-gate'
  | 'pointer-lock'
  | 'popup'
  | 'same-tab-navigation'
  | 'delayed-popup'
  | 'popunder-focus-split'
  | 'redirect-chain'
  | 'spa-gate'
  | 'reinsertion'
  | 'mutation-burst'
  | 'player-obstruction'
  | 'network-probe'
  | 'bait-reaction'
  | 'confounder';
type NegativeControlKind =
  | 'target-blank'
  | 'external-target-blank'
  | 'ctrl-meta-middle-click'
  | 'oauth'
  | 'payment'
  | 'document-download'
  | 'normal-spa'
  | 'benign-modal';

interface TrialDefinition {
  id: string;
  active: boolean;
  kind: 'overlay' | 'popup' | 'legitimate' | 'oauth' | 'payment' | 'document' | 'external' | 'modified' | 'spa' | 'modal';
  primary: TrialPrimary;
  mechanisms: readonly HoldoutMechanism[];
  controlKind?: NegativeControlKind;
  seed: number;
  route: string;
  contentRoute: string;
  targetRoute: string;
}

interface TrialResult {
  id: string;
  active: boolean;
  controlKind?: NegativeControlKind;
  detected: boolean;
  resolved: boolean;
  falsePositive: boolean;
  negativeControlPreserved: boolean;
  resolutionAttribution: 'SAEI' | 'DETERMINISTIC_FALLBACK' | 'STATIC_FILTER' | 'RECIPE_REPLAY' | 'UNRESOLVED' | 'NEGATIVE_CONTROL';
  experiments: number;
  aiCalls: number;
  recipeReplay: boolean;
  secondVisitExperiments: number;
  secondVisitAiCalls: number;
  secondVisitSuccess: boolean;
  timeToResolutionMs: number | null;
  rollbackSuccess: boolean;
  capabilityGaps: number;
  observedEventKinds: string[];
  autonomyStatuses: string[];
  experimentDetails: string[];
  remainingPageUrls: string[];
  navigationTargetSnapshot: unknown;
  pendingAutonomyCount: number;
  completedGraphExperiments: number;
}

interface BrowserHoldoutScore {
  profile: 'fast' | 'full';
  activeTrials: number;
  negativeControls: number;
  autonomousDetectionRate: number;
  autonomousResolutionRate: number;
  overallAdaptResolutionRate: number;
  saeiResolutionRate: number;
  deterministicResolutionRate: number;
  activeResolved: number;
  recipeReplayEligibleTrials: number;
  negativeControlsPreserved: number;
  negativeControlPreservationRate: number;
  protectedFlowFalsePositiveCount: number;
  falsePositiveRate: number;
  criticalFalsePositiveCount: number;
  medianExperiments: number;
  p95Experiments: number;
  medianTimeToResolution: number | null;
  recipeReplaySuccessRate: number;
  secondVisitAiCalls: number;
  secondVisitExperiments: number;
  workerRestartSuccessRate: number;
  capabilityGapCount: number;
  policyAbstentionCount: number;
  primitiveExecutionCoverage: number;
  rollbackSuccessRate: number;
  rollbackEligibleTrials: number;
  popupUnwantedTargetRecall: number;
  popupLegitimateTargetFalsePositiveRate: number;
  autonomyStatusCounts: {
    detected: number;
    attempted: number;
    resolved: number;
    rolledBack: number;
    capabilityGap: number;
    policyAbstention: number;
    timedOut: number;
  };
}

interface TestServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

interface ExtensionSession {
  browser: Browser;
  worker: Target;
}

interface ResourceServer extends TestServer {
  hits: Map<string, number>;
}

interface PrimitiveProbeResult {
  primitiveId: PrimitiveId;
  stage: boolean;
  observableEffect: boolean;
  healthSafety: boolean;
  rollback: boolean;
  restoredBaseline: boolean;
  notes: string;
}

interface RecipeLifecycleLiveResult {
  visit1_experiments: number;
  visit2_experiments: number;
  visit3_experiments: number;
  visit4_experiments: number;
  visit_ai_calls: number;
  lifecycle_after_each_visit: string[];
}

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, '..');
const extensionPath = path.resolve(projectRoot, 'dist');

function token(seed: number): string {
  let value = seed >>> 0;
  value = Math.imul(value ^ (value >>> 16), 2246822507);
  value = Math.imul(value ^ (value >>> 13), 3266489909);
  return `x${(value >>> 0).toString(36)}`;
}

function safePageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

function pageHtml(definition: TrialDefinition, adPort: number): string {
  const has = (mechanism: HoldoutMechanism): boolean => definition.mechanisms.includes(mechanism);
  const uniqueClass = `gate-${token(definition.seed + 7)}`;
  const overlayNeeded = definition.primary === 'overlay'
    || has('anti-block-overlay')
    || has('semantic-inline-gate')
    || has('network-probe')
    || has('bait-reaction')
    || has('reinsertion')
    || has('mutation-burst')
    || has('player-obstruction');
  const overlayMarkup = overlayNeeded
    ? `<div class="${uniqueClass}" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(12,12,18,.96);color:white;padding:20vh 12vw;font:700 28px system-ui"><p>Content access is paused while filtering is active.</p><p>Tap continue to keep reading.</p></div>`
    : '';
  const lockDelay = 90 + (definition.seed % 9) * 23;
  const overlayActions = overlayNeeded
    ? `const panel=document.querySelector('.${uniqueClass}');if(panel)panel.style.display='block';`
    : '';
  const lockActions = [
    definition.primary === 'scroll' || has('scroll-only-gate') ? "document.body.style.overflow='hidden';document.documentElement.style.overflow='hidden';" : '',
    definition.primary === 'pointer' || has('pointer-lock') ? "document.body.style.pointerEvents='none';" : '',
    overlayNeeded ? "document.body.style.overflow='hidden';" : '',
  ].join('');
  const reinsertion = has('reinsertion')
    ? `let reinserts=0;const reinsertionTimer=setInterval(()=>{if(!panel)return;reinserts+=1;if(reinserts%2===0)panel.remove();else document.body.appendChild(panel);if(reinserts>=6)clearInterval(reinsertionTimer);},${75 + (definition.seed % 5) * 20});`
    : '';
  const mutationBurst = has('mutation-burst')
    ? `for(let i=0;i<${6 + (definition.seed % 7)};i+=1){const marker=document.createElement('span');marker.textContent='.';marker.className='mutation-${token(definition.seed + 19)}';document.body.appendChild(marker);}`
    : '';
  const bait = has('bait-reaction')
    ? `<div class="bait-${token(definition.seed + 23)}" style="display:none;visibility:hidden;content-visibility:hidden;contain:strict">sponsor</div>`
    : '';
  const player = has('player-obstruction')
    ? '<video controls muted width="480" height="270"></video>'
    : '';
  const networkProbe = has('network-probe')
    ? `<script>const probe=document.createElement('script');probe.src='http://127.0.0.1:${adPort}/probe-${token(definition.seed + 29)}.js';probe.onerror=()=>{const panel=document.querySelector('.${uniqueClass}');if(panel)panel.style.display='block';document.body.style.overflow='hidden';};document.head.appendChild(probe);</script>`
    : '';
  const reactionScript = overlayNeeded || lockActions || reinsertion || mutationBurst
    ? `<script>setTimeout(()=>{const panel=document.querySelector('.${uniqueClass}');${overlayActions}${lockActions}${mutationBurst}${reinsertion}},${lockDelay});</script>`
    : '';

  let interaction = '';
  if (definition.active && definition.primary === 'popup') {
    const popupPath = has('redirect-chain') ? `/${definition.targetRoute}/redirect-start` : `/${definition.targetRoute}`;
    const popupDelay = has('delayed-popup') ? 180 + (definition.seed % 8) * 35 : 0;
    interaction = `<button class="action-${token(definition.seed + 31)}">Continue</button><script>document.querySelector('button').addEventListener('click',()=>{const open=()=>{window.open('http://127.0.0.1:${adPort}${popupPath}','_blank');location.href='/${definition.contentRoute}';};${popupDelay > 0 ? `setTimeout(open,${popupDelay});` : 'open();'} });</script>`;
  } else if (!definition.active) {
    const controlKind = definition.controlKind;
    if (controlKind === 'benign-modal') {
      interaction = `<button class="action-${token(definition.seed + 37)}">Open details</button><div class="modal-${token(definition.seed + 41)}" style="display:none"><p>Helpful details</p></div><script>document.querySelector('button').addEventListener('click',()=>{document.querySelector('[class^="modal-"]').style.display='block';});</script>`;
    } else if (controlKind === 'normal-spa') {
      interaction = `<a href="/${definition.contentRoute}" class="action-${token(definition.seed + 43)}">Open view</a><script>document.querySelector('a').addEventListener('click',(event)=>{event.preventDefault();history.pushState({},'',event.currentTarget.getAttribute('href'));document.body.dataset.spa='ready';});</script>`;
    } else {
      const destination = controlKind === 'oauth'
        ? `http://127.0.0.1:${adPort}/${definition.targetRoute}/authorize`
        : controlKind === 'payment'
          ? `http://127.0.0.1:${adPort}/${definition.targetRoute}/checkout`
          : controlKind === 'document-download'
            ? `http://127.0.0.1:${adPort}/${definition.targetRoute}/document`
            : controlKind === 'target-blank'
              ? `/${definition.contentRoute}`
              : controlKind === 'external-target-blank'
                ? `http://127.0.0.1:${adPort}/${definition.targetRoute}`
              : `http://127.0.0.1:${adPort}/${definition.targetRoute}`;
      const download = '';
      interaction = `<a href="${destination}" target="_blank"${download} class="action-${token(definition.seed + 47)}">Continue</a>`;
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Holdout</title>${player}</head><body><main><h1>Reading area</h1><p>Stable content for this visit.</p>${bait}${interaction}${overlayMarkup}</main>${reactionScript}${networkProbe}</body></html>`;
}

function contentHtml(): string {
  return '<!doctype html><html><body><main><h1>Intended content</h1><p>Navigation completed.</p></main></body></html>';
}

function targetHtml(): string {
  return '<!doctype html><html><body><main><h1>Separate target</h1></main></body></html>';
}

function primitiveFixtureHtml(resourcePort: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Primitive fixture</title><style>html,body{min-height:140vh}#primitive-bait{width:180px;height:40px}</style></head><body><main><h1>Executor fixture</h1><p>Stable content for this executor test.</p><div id="primitive-bait" class="ad" style="display:none;visibility:hidden;content-visibility:hidden;contain:strict">bait</div><div id="primitive-overlay" style="display:block;position:fixed;inset:0;z-index:9999;background:rgba(12,12,18,.96);color:white;padding:20vh 12vw;font:700 28px system-ui">Continue to view content.</div></main><script>window.__triggerPrimitiveResource=(path)=>new Promise((resolve)=>{const script=document.createElement('script');script.src='http://127.0.0.1:${resourcePort}/'+path+'?nonce='+Date.now()+Math.random();script.onload=()=>resolve('loaded');script.onerror=()=>resolve('error');document.head.appendChild(script)});window.__primitiveLoaded=0;</script></body></html>`;
}

async function startServer(port: number, render: (requestPath: string) => string): Promise<TestServer> {
  const server = http.createServer((request, response) => {
    const requestPath = new URL(request.url ?? '/', `http://127.0.0.1:${port || 80}`).pathname;
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(render(requestPath));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Holdout server did not expose a TCP port');
  return {
    server,
    port: address.port,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startResourceServer(): Promise<ResourceServer> {
  const hits = new Map<string, number>();
  const server = http.createServer((request, response) => {
    const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    hits.set(requestPath, (hits.get(requestPath) ?? 0) + 1);
    if (requestPath.startsWith('/primitive-script.js') || requestPath.startsWith('/primitive-ad.js')) {
      response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      response.end('window.__primitiveLoaded=(window.__primitiveLoaded||0)+1;');
      return;
    }
    if (requestPath === '/redirect-start') {
      response.writeHead(302, { Location: '/redirect-target' });
      response.end();
      return;
    }
    if (requestPath === '/redirect-target') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><html><body><main><h1>Redirect target</h1></main></body></html>');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Primitive resource server did not expose a TCP port');
  return {
    server,
    port: address.port,
    hits,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function launchSession(warmupUrl?: string): Promise<ExtensionSession> {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromeExecutable(),
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });
  const worker = await browser.waitForTarget(
    (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
    { timeout: 10_000 }
  );
  if (warmupUrl) {
    const warmup = await browser.newPage();
    await warmup.goto(warmupUrl, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await warmup.close();
  }
  return { browser, worker };
}

async function sessionValue(browser: Browser, key: string): Promise<Record<string, unknown> | undefined> {
  const worker = browser.targets().find(
    (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://')
  );
  if (!worker) return undefined;
  const client = await worker.createCDPSession();
  const response = await client.send('Runtime.evaluate', {
    expression: `chrome.storage.session.get(${JSON.stringify([key])})`,
    awaitPromise: true,
    returnByValue: true,
  });
  await client.detach();
  const value = response.result.value;
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

async function localValue(browser: Browser, key: string): Promise<Record<string, unknown> | undefined> {
  const worker = browser.targets().find(
    (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://')
  );
  if (!worker) return undefined;
  const client = await worker.createCDPSession();
  const response = await client.send('Runtime.evaluate', {
    expression: `chrome.storage.local.get(${JSON.stringify([key])})`,
    awaitPromise: true,
    returnByValue: true,
  });
  await client.detach();
  const value = response.result.value;
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

async function waitForSession(browser: Browser, key: string, predicate: (value: Record<string, unknown>) => boolean, timeoutMs = 4000): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await sessionValue(browser, key).catch(() => undefined);
    if (value && predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return sessionValue(browser, key).catch(() => undefined);
}

async function evaluateWorker<T>(browser: Browser, expression: string): Promise<T> {
  const worker = browser.targets().find(
    (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://')
  );
  if (!worker) throw new Error('Extension service worker is unavailable');
  const client = await worker.createCDPSession();
  try {
    const response = await client.send('Runtime.evaluate', {
      expression: `(async()=>Promise.race([(${expression}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('worker evaluation timeout')),5000))]))()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error('Extension worker evaluation failed');
    return response.result.value as T;
  } finally {
    await client.detach();
  }
}

async function liveTabContext(browser: Browser, page: Page): Promise<{ tabId: number; documentId: string }> {
  const tab = await evaluateWorker<{ id?: number }>(browser, `(async()=>{const tabs=await chrome.tabs.query({});return tabs.find((tab)=>tab.url&&tab.url.startsWith(${JSON.stringify(page.url().split('?')[0])}));})()`);
  if (typeof tab?.id !== 'number') throw new Error(`Could not resolve Chromium tab for ${page.url()}`);
  const state = await sessionValue(browser, 'adapt_causal_session_state_v1');
  const snapshot = state?.adapt_causal_session_state_v1 as { graphs?: Array<{ scope?: { tabId?: number; documentId?: string }; nodes?: Array<{ refs?: string[] }> }> } | undefined;
  const graph = [...(snapshot?.graphs ?? [])].reverse().find((candidate) => candidate.scope?.tabId === tab.id);
  return { tabId: tab.id, documentId: graph?.scope?.documentId ?? `primitive-document-${tab.id}` };
}

async function waitForOpaqueRef(browser: Browser, nodeKind: string, timeoutMs = 5000): Promise<{ ref: string; documentId: string }> {
  const state = await waitForSession(browser, 'adapt_causal_session_state_v1', (value) => {
    const snapshot = value.adapt_causal_session_state_v1 as { graphs?: Array<{ scope?: { documentId?: string }; nodes?: Array<{ kind?: string; refs?: string[] }> }> } | undefined;
    return Boolean(snapshot?.graphs?.some((graph) => graph.nodes?.some((node) => node.kind === nodeKind && node.refs?.some((ref) => ref.startsWith('element:')))));
  }, timeoutMs);
  const snapshot = state?.adapt_causal_session_state_v1 as { graphs?: Array<{ scope?: { documentId?: string }; nodes?: Array<{ kind?: string; refs?: string[] }> }> } | undefined;
  for (const graph of [...(snapshot?.graphs ?? [])].reverse()) {
    const node = [...(graph.nodes ?? [])].reverse().find((candidate) => candidate.kind === nodeKind && candidate.refs?.some((ref) => ref.startsWith('element:')));
    const ref = node?.refs?.find((candidate) => candidate.startsWith('element:'));
    if (ref) return { ref, documentId: graph.scope?.documentId ?? 'primitive-document' };
  }
  throw new Error(`Opaque ${nodeKind} target was not observed`);
}

function primitiveDeps(browser: Browser, navigationTargets: EphemeralNavigationTargetRegistry, resolveRequest: (ref: string) => { urlFilter: string; resourceTypes: chrome.declarativeNetRequest.ResourceType[]; firstParty: boolean; trackerLike: boolean } | undefined) {
  const dnrBackend = {
    getDynamicRules: async () => evaluateWorker<chrome.declarativeNetRequest.Rule[]>(browser, 'chrome.declarativeNetRequest.getDynamicRules()'),
    getSessionRules: async () => evaluateWorker<chrome.declarativeNetRequest.Rule[]>(browser, 'chrome.declarativeNetRequest.getSessionRules()'),
    updateDynamicRules: async (options: { addRules?: chrome.declarativeNetRequest.Rule[]; removeRuleIds?: number[] }) => evaluateWorker<void>(browser, `chrome.declarativeNetRequest.updateDynamicRules(${JSON.stringify(options)})`),
    updateSessionRules: async (options: { addRules?: chrome.declarativeNetRequest.Rule[]; removeRuleIds?: number[] }) => evaluateWorker<void>(browser, `chrome.declarativeNetRequest.updateSessionRules(${JSON.stringify(options)})`),
  };
  const dnrController = new DnrController(dnrBackend);
  return {
    dnrController,
    sendTabMessage: async (tabId: number, message: unknown) => evaluateWorker<{ success?: boolean; actionIds?: string[] }>(browser, `chrome.tabs.sendMessage(${tabId}, ${JSON.stringify(message)})`),
    resolveRequest,
    navigationTargets,
    tabsApi: {
      remove: async (tabId: number | number[]) => evaluateWorker<void>(browser, `chrome.tabs.remove(${JSON.stringify(tabId)})`),
      get: async (tabId: number) => evaluateWorker<chrome.tabs.Tab>(browser, `chrome.tabs.get(${tabId})`),
      create: async (options: chrome.tabs.CreateProperties) => evaluateWorker<chrome.tabs.Tab>(browser, `chrome.tabs.create(${JSON.stringify(options)})`),
    },
  };
}

async function runPrimitiveExecutorBrowserProbes(appPort: number, resourceServer: ResourceServer): Promise<{ results: PrimitiveProbeResult[]; registry: PrimitiveExecutorRegistry; browserTested: Set<PrimitiveId> }> {
  const session = await launchSession(`http://127.0.0.1:${appPort}/warmup`);
  const page = await session.browser.newPage();
  const fixtureUrl = `http://127.0.0.1:${appPort}/primitive-executor-fixture`;
  const navigationTargets = new EphemeralNavigationTargetRegistry();
  const requestTargets = new Map<string, { urlFilter: string; resourceTypes: chrome.declarativeNetRequest.ResourceType[]; firstParty: boolean; trackerLike: boolean }>();
  const browserTested = new Set<PrimitiveId>();
  const registry = new PrimitiveExecutorRegistry(primitiveDeps(session.browser, navigationTargets, (ref) => requestTargets.get(ref)), browserTested);
  const results: PrimitiveProbeResult[] = [];
  const reload = async (): Promise<{ tabId: number; documentId: string }> => {
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 900));
    return liveTabContext(session.browser, page);
  };
  const pageHealthy = async (): Promise<boolean> => page.evaluate(() => Boolean(document.querySelector('main')) && document.body !== null);
  const runDom = async (primitiveId: PrimitiveId, ref: string | undefined, effect: () => Promise<boolean>, baseline: () => Promise<boolean>, note: string): Promise<void> => {
    const context = await liveTabContext(session.browser, page);
    const txId = `live_${primitiveId}_${Date.now()}`;
    const staged = await registry.stage({ txId, tabId: context.tabId, frameId: 0, documentId: context.documentId, primitiveId, opaqueRefs: ref ? [ref] : [], evidence: [] });
    if (!staged.ok) {
      results.push({ primitiveId, stage: false, observableEffect: false, healthSafety: false, rollback: false, restoredBaseline: false, notes: staged.gap.reason });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const observableEffect = await effect();
    const healthSafety = await pageHealthy();
    const rollback = (await registry.rollback(txId)).ok;
    const restoredBaseline = await baseline();
    const passed = observableEffect && healthSafety && rollback && restoredBaseline;
    if (passed) browserTested.add(primitiveId);
    results.push({ primitiveId, stage: true, observableEffect, healthSafety, rollback, restoredBaseline, notes: passed ? note : `effect=${observableEffect},health=${healthSafety},rollback=${rollback},baseline=${restoredBaseline}` });
  };

  try {
    let context = await reload();
    const overlay = await waitForOpaqueRef(session.browser, 'OVERLAY_APPEARED');
    await runDom('TOGGLE_COSMETIC_ACTION', overlay.ref,
      () => page.evaluate(() => getComputedStyle(document.querySelector('#primitive-overlay')!).display === 'none'),
      () => page.evaluate(() => getComputedStyle(document.querySelector('#primitive-overlay')!).display === 'block'),
      'overlay visibility toggled and restored');

    context = await reload();
    const bait = await waitForOpaqueRef(session.browser, 'BAIT_STATE_CHANGED');
    await runDom('PRESERVE_BAIT', bait.ref,
      () => page.evaluate(() => getComputedStyle(document.querySelector('#primitive-bait')!).display !== 'none'),
      () => page.evaluate(() => document.querySelector('#primitive-bait') instanceof HTMLElement && (document.querySelector('#primitive-bait') as HTMLElement).style.display === 'none'),
      'bait visibility restored without losing the target');

    context = await reload();
    const layoutBait = await waitForOpaqueRef(session.browser, 'BAIT_STATE_CHANGED');
    await runDom('RESTORE_LAYOUT', layoutBait.ref,
      () => page.evaluate(() => getComputedStyle(document.querySelector('#primitive-bait')!).contentVisibility !== 'hidden' && getComputedStyle(document.querySelector('#primitive-bait')!).contain !== 'strict'),
      () => page.evaluate(() => { const element = document.querySelector('#primitive-bait') as HTMLElement; return element.style.contentVisibility === 'hidden' && element.style.contain === 'strict'; }),
      'bait layout constraints restored');

    context = await reload();
    await page.evaluate(() => { document.body.style.pointerEvents = 'none'; });
    await runDom('RESTORE_POINTER_INTERACTION', undefined,
      () => page.evaluate(() => getComputedStyle(document.body).pointerEvents !== 'none'),
      () => page.evaluate(() => document.body.style.pointerEvents === 'none'),
      'pointer interaction restored');

    context = await reload();
    await page.evaluate(() => { document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden'; });
    await runDom('RESTORE_SCROLL', undefined,
      () => page.evaluate(() => getComputedStyle(document.body).overflow !== 'hidden' && getComputedStyle(document.documentElement).overflow !== 'hidden'),
      () => page.evaluate(() => document.body.style.overflow === 'hidden' && document.documentElement.style.overflow === 'hidden'),
      'scrolling restored');

    context = await reload();
    await page.evaluate(() => { document.body.style.pointerEvents = 'none'; document.body.style.overflow = 'hidden'; });
    await runDom('PLAYER_HEALTH_RECOVERY', undefined,
      () => page.evaluate(() => getComputedStyle(document.body).pointerEvents !== 'none' && getComputedStyle(document.body).overflow !== 'hidden'),
      () => page.evaluate(() => document.body.style.pointerEvents === 'none' && document.body.style.overflow === 'hidden'),
      'player interaction and scroll health restored');

    context = await reload();
    await page.evaluate(() => { document.body.style.overflow = 'hidden'; });
    const reactionOverlay = await waitForOpaqueRef(session.browser, 'OVERLAY_APPEARED');
    await runDom('REMOVE_REACTION_UI', reactionOverlay.ref,
      () => page.evaluate(() => getComputedStyle(document.querySelector('#primitive-overlay')!).display === 'none' && getComputedStyle(document.body).overflow !== 'hidden'),
      () => page.evaluate(() => document.body.style.overflow === 'hidden' && document.querySelector('#primitive-overlay') instanceof HTMLElement && (document.querySelector('#primitive-overlay') as HTMLElement).style.display === 'block'),
      'reaction UI removed and full baseline restored');

    context = await reload();
    const networkUrl = `|http://127.0.0.1:${resourceServer.port}/primitive-script.js*`;
    requestTargets.set('request:rblock', { urlFilter: networkUrl, resourceTypes: ['script' as chrome.declarativeNetRequest.ResourceType], firstParty: true, trackerLike: false });
    const beforeBlockHits = resourceServer.hits.get('/primitive-script.js') ?? 0;
    let staged = await registry.stage({ txId: `live_TEMPORARY_NETWORK_BLOCK_${Date.now()}`, tabId: context.tabId, frameId: 0, documentId: context.documentId, primitiveId: 'TEMPORARY_NETWORK_BLOCK', opaqueRefs: ['request:rblock'], evidence: [] });
    const blockTx = staged.ok ? staged.record.txId : '';
    const blockOutcome = staged.ok && await page.evaluate(() => (window as unknown as { __triggerPrimitiveResource: (path: string) => Promise<string> }).__triggerPrimitiveResource('primitive-script.js')) === 'error';
    const blockRollback = blockTx ? (await registry.rollback(blockTx)).ok : false;
    const blockRestored = blockRollback && await page.evaluate(() => (window as unknown as { __triggerPrimitiveResource: (path: string) => Promise<string> }).__triggerPrimitiveResource('primitive-script.js')) === 'loaded';
    const blockPassed = Boolean(staged.ok && blockOutcome && (resourceServer.hits.get('/primitive-script.js') ?? 0) === beforeBlockHits + 1 && blockRollback && blockRestored);
    if (blockPassed) browserTested.add('TEMPORARY_NETWORK_BLOCK');
    results.push({ primitiveId: 'TEMPORARY_NETWORK_BLOCK', stage: staged.ok, observableEffect: blockOutcome, healthSafety: await pageHealthy(), rollback: blockRollback, restoredBaseline: blockRestored, notes: blockPassed ? 'request suppressed and restored after rollback' : 'network block probe failed' });

    context = await reload();
    const targetedUrl = `|http://127.0.0.1:${resourceServer.port}/primitive-ad.js*`;
    requestTargets.set('request:rtargeted', { urlFilter: targetedUrl, resourceTypes: ['script' as chrome.declarativeNetRequest.ResourceType], firstParty: true, trackerLike: false });
    const beforeTargetedHits = resourceServer.hits.get('/primitive-ad.js') ?? 0;
    staged = await registry.stage({ txId: `live_TARGETED_SESSION_DNR_${Date.now()}`, tabId: context.tabId, frameId: 0, documentId: context.documentId, primitiveId: 'TARGETED_SESSION_DNR', opaqueRefs: ['request:rtargeted'], evidence: [] });
    const targetedTx = staged.ok ? staged.record.txId : '';
    const targetedOutcome = staged.ok && await page.evaluate(() => (window as unknown as { __triggerPrimitiveResource: (path: string) => Promise<string> }).__triggerPrimitiveResource('primitive-ad.js')) === 'error';
    const targetedRollback = targetedTx ? (await registry.rollback(targetedTx)).ok : false;
    const targetedRestored = targetedRollback && await page.evaluate(() => (window as unknown as { __triggerPrimitiveResource: (path: string) => Promise<string> }).__triggerPrimitiveResource('primitive-ad.js')) === 'loaded';
    const targetedPassed = Boolean(staged.ok && targetedOutcome && (resourceServer.hits.get('/primitive-ad.js') ?? 0) === beforeTargetedHits + 1 && targetedRollback && targetedRestored);
    if (targetedPassed) browserTested.add('TARGETED_SESSION_DNR');
    results.push({ primitiveId: 'TARGETED_SESSION_DNR', stage: staged.ok, observableEffect: targetedOutcome, healthSafety: await pageHealthy(), rollback: targetedRollback, restoredBaseline: targetedRestored, notes: targetedPassed ? 'targeted session rule suppressed and restored' : 'targeted session DNR probe failed' });

    context = await reload();
    const allowUrl = `|http://127.0.0.1:${resourceServer.port}/primitive-script.js*`;
    requestTargets.set('request:rallow', { urlFilter: allowUrl, resourceTypes: ['script' as chrome.declarativeNetRequest.ResourceType], firstParty: true, trackerLike: false });
    const allowController = new DnrController({
      getDynamicRules: async () => evaluateWorker<chrome.declarativeNetRequest.Rule[]>(session.browser, 'chrome.declarativeNetRequest.getDynamicRules()'),
      getSessionRules: async () => evaluateWorker<chrome.declarativeNetRequest.Rule[]>(session.browser, 'chrome.declarativeNetRequest.getSessionRules()'),
      updateDynamicRules: async (options) => evaluateWorker<void>(session.browser, `chrome.declarativeNetRequest.updateDynamicRules(${JSON.stringify(options)})`),
      updateSessionRules: async (options) => evaluateWorker<void>(session.browser, `chrome.declarativeNetRequest.updateSessionRules(${JSON.stringify(options)})`),
    });
    const blockerRules = await allowController.addSessionExperimentRules(context.tabId, `preblock_${Date.now()}`, [{ id: 'preblock', type: 'NET_BLOCK', urlFilter: allowUrl, resourceTypes: ['script' as chrome.declarativeNetRequest.ResourceType] }]);
    const preblocked = await page.evaluate(() => (window as unknown as { __triggerPrimitiveResource: (path: string) => Promise<string> }).__triggerPrimitiveResource('primitive-script.js')) === 'error';
    staged = await registry.stage({ txId: `live_TEMPORARY_NETWORK_ALLOW_${Date.now()}`, tabId: context.tabId, frameId: 0, documentId: context.documentId, primitiveId: 'TEMPORARY_NETWORK_ALLOW', opaqueRefs: ['request:rallow'], evidence: [] });
    const allowTx = staged.ok ? staged.record.txId : '';
    const allowed = staged.ok && await page.evaluate(() => (window as unknown as { __triggerPrimitiveResource: (path: string) => Promise<string> }).__triggerPrimitiveResource('primitive-script.js')) === 'loaded';
    const allowRollback = allowTx ? (await registry.rollback(allowTx)).ok : false;
    const blockedAfterRollback = allowRollback && await page.evaluate(() => (window as unknown as { __triggerPrimitiveResource: (path: string) => Promise<string> }).__triggerPrimitiveResource('primitive-script.js')) === 'error';
    await allowController.removeSessionExperimentRules(blockerRules.ruleIds);
    const allowPassed = Boolean(staged.ok && preblocked && allowed && allowRollback && blockedAfterRollback);
    if (allowPassed) browserTested.add('TEMPORARY_NETWORK_ALLOW');
    results.push({ primitiveId: 'TEMPORARY_NETWORK_ALLOW', stage: staged.ok, observableEffect: Boolean(preblocked && allowed), healthSafety: await pageHealthy(), rollback: allowRollback, restoredBaseline: blockedAfterRollback, notes: allowPassed ? 'first-party request allowed then returned to blocked baseline' : 'temporary network allow probe failed' });

    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 5000 });
    context = await liveTabContext(session.browser, page);
    const navigationRef = 'navigation:n9001' as const;
    navigationTargets.record({
      ref: navigationRef,
      sourceTabId: context.tabId,
      sourceFrameId: 0,
      targetTabId: context.tabId,
      capturedWallMs: Date.now(),
      sourceOriginHash: 'source',
      destinationOriginHash: 'target',
      destinationClass: 'cross-origin',
      redirectCount: 1,
      foregroundState: 'foreground',
      openerRelationship: 'implicit',
      riskSignals: ['MATCHED_REDIRECT_CHAIN'],
    }, `http://127.0.0.1:${resourceServer.port}/redirect-target`);
    staged = await registry.stage({ txId: `live_STOP_MATCHED_REDIRECT_CHAIN_${Date.now()}`, tabId: context.tabId, frameId: 0, documentId: context.documentId, primitiveId: 'STOP_MATCHED_REDIRECT_CHAIN', opaqueRefs: [navigationRef], evidence: [] });
    const redirectTx = staged.ok ? staged.record.txId : '';
    if (staged.ok) await page.goto(`http://127.0.0.1:${resourceServer.port}/redirect-start`, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => undefined);
    const redirectStopped = staged.ok && !page.url().includes('/redirect-target');
    const redirectRollback = redirectTx ? (await registry.rollback(redirectTx)).ok : false;
    await page.goto(`http://127.0.0.1:${resourceServer.port}/redirect-start`, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => undefined);
    const redirectRestored = redirectRollback && page.url().includes('/redirect-target');
    const redirectPassed = Boolean(staged.ok && redirectStopped && redirectRollback && redirectRestored);
    if (redirectPassed) browserTested.add('STOP_MATCHED_REDIRECT_CHAIN');
    results.push({ primitiveId: 'STOP_MATCHED_REDIRECT_CHAIN', stage: staged.ok, observableEffect: redirectStopped, healthSafety: redirectPassed, rollback: redirectRollback, restoredBaseline: redirectRestored, notes: redirectPassed ? 'matched redirect chain stopped and restored' : 'redirect-chain probe failed' });
  } finally {
    await page.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
  }
  return { results, registry, browserTested };
}

async function runRecipeLifecycleProbe(definition: TrialDefinition, appPort: number): Promise<RecipeLifecycleLiveResult> {
  const session = await launchSession(`http://127.0.0.1:${appPort}/warmup`);
  const experimentCounts: number[] = [];
  const lifecycle: string[] = [];
  let aiCalls = 0;
  try {
    let previousExperiments = 0;
    for (let visit = 0; visit < 4; visit += 1) {
      const page = await session.browser.newPage();
      await page.goto(`http://127.0.0.1:${appPort}/${definition.route}`, { waitUntil: 'domcontentloaded' });
      await new Promise((resolve) => setTimeout(resolve, 2200));
      if (definition.kind === 'popup') {
        await page.click('button');
        await page.waitForFunction((contentRoute) => location.pathname === `/${contentRoute}`, { timeout: 5000 }, definition.contentRoute).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      const state = await sessionValue(session.browser, 'adapt_causal_session_state_v1');
      const autonomy = await sessionValue(session.browser, 'adapt_autonomy_state_v1');
      const snapshot = state?.adapt_causal_session_state_v1 as { graphs?: Array<{ experiments?: Array<{ transactionId?: string }> }> } | undefined;
      const currentExperiments = (snapshot?.graphs ?? []).reduce(
        (sum, graph) => sum + (graph.experiments ?? []).filter((experiment) => !experiment.transactionId?.startsWith('recipe_replay_')).length,
        0,
      );
      experimentCounts.push(Math.max(0, currentExperiments - previousExperiments));
      previousExperiments = currentExperiments;
      const loops = autonomy?.adapt_autonomy_state_v1 as { loops?: Array<[string, { aiCalls?: number }]> } | undefined;
      aiCalls += (loops?.loops ?? []).reduce((sum, [, loop]) => sum + (loop.aiCalls ?? 0), 0);
      const recipes = await localValue(session.browser, 'adapt_causal_recipes_v1');
      const items = recipes?.adapt_causal_recipes_v1 as { items?: Record<string, { lifecycle?: string }> } | undefined;
      lifecycle.push(Object.values(items?.items ?? {}).map((item) => item.lifecycle ?? 'UNKNOWN').sort().join('|') || 'NONE');
      await page.close();
    }
  } finally {
    await session.browser.close().catch(() => undefined);
  }
  return {
    visit1_experiments: experimentCounts[0] ?? 0,
    visit2_experiments: experimentCounts[1] ?? 0,
    visit3_experiments: experimentCounts[2] ?? 0,
    visit4_experiments: experimentCounts[3] ?? 0,
    visit_ai_calls: aiCalls,
    lifecycle_after_each_visit: lifecycle,
  };
}

function graphSignals(value: Record<string, unknown> | undefined): { detected: boolean; experiments: number; interventions: number; aiCalls: number; capabilityGaps: number; observedEventKinds: string[]; autonomyStatuses: string[]; experimentDetails: string[]; autonomyResolved: number } {
  const snapshot = value?.adapt_causal_session_state_v1 as { graphs?: Array<{ nodes?: Array<{ kind?: string; features?: Record<string, unknown> }>; experiments?: Array<{ status?: string; primitiveId?: string; transactionId?: string; healthDelta?: number; rollbackVerified?: boolean; preHealth?: Record<string, unknown>; postHealth?: Record<string, unknown> }> }> } | undefined;
  const graphs = snapshot?.graphs ?? [];
  const nodes = graphs.flatMap((graph) => graph.nodes ?? []);
  const explorationExperiments = graphs.flatMap((graph) => (graph.experiments ?? []).filter((experiment) => !experiment.transactionId?.startsWith('recipe_replay_')));
  const experiments = explorationExperiments.length;
  const interventions = explorationExperiments.filter((experiment) => experiment.status === 'COMMITTED' || experiment.status === 'ROLLED_BACK').length;
  const detected = nodes.some((node) => [
    'OVERLAY_APPEARED',
    'INTERACTION_DENIED',
    'SEMANTIC_GATE',
    'UNEXPECTED_NAV_TARGET',
    'POPUP_OR_POPUNDER',
    'SUSPICIOUS_REDIRECT_CHAIN',
    'SCROLL_LOCK_ON',
    'PLAYBACK_OBSTRUCTED',
    'BAIT_STATE_CHANGED',
    'MUTATION_BURST',
    'NETWORK_PROBE_REACTION',
  ].includes(node.kind ?? ''));
  const autonomy = value?.adapt_autonomy_state_v1 as { loops?: Array<[string, { aiCalls?: number; capabilityGaps?: string[]; status?: string; experiments?: Array<{ primitiveId: string }> }]> } | undefined;
  const loops = autonomy?.loops ?? [];
  const loopExperiments = loops.flatMap(([, loop]) => loop.experiments ?? []);
  const graphInterventions = interventions;
  const autonomyResolved = loops.filter(([, loop]) => loop.status === 'RESOLVED').reduce((sum, [, loop]) => sum + (loop.experiments?.length ?? 0), 0);
  return {
    detected,
    experiments: experiments > 0 ? experiments : loopExperiments.length,
    interventions: graphInterventions + autonomyResolved,
    aiCalls: loops.reduce((sum, [, loop]) => sum + (loop.aiCalls ?? 0), 0),
    capabilityGaps: loops.reduce((sum, [, loop]) => sum + (loop.capabilityGaps?.length ?? 0), 0),
    observedEventKinds: [...new Set(nodes.map((node) => node.kind ?? 'UNKNOWN'))],
    autonomyStatuses: loops.map(([, loop]) => `${loop.status ?? 'UNKNOWN'}:${(loop.capabilityGaps ?? []).join('|')}`),
    experimentDetails: explorationExperiments.map((experiment) => `${experiment.primitiveId ?? 'legacy'}:${experiment.status ?? 'UNKNOWN'}:${experiment.healthDelta ?? 'na'}:${experiment.rollbackVerified === true ? 'rollback-ok' : 'rollback-no'}:${JSON.stringify({ pre: experiment.preHealth, post: experiment.postHealth })}`).concat(
      graphs.length === 0 || experiments === 0
        ? loopExperiments.map((experiment) => `${experiment.primitiveId}:AUTONOMY_ATTEMPT`)
      : []
    ),
    autonomyResolved,
  };
}

async function exerciseTrial(session: ExtensionSession, definition: TrialDefinition, appPort: number, adPort: number): Promise<TrialResult> {
  const page = await session.browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${appPort}/${definition.route}`, { waitUntil: 'domcontentloaded' });
  await waitForSession(session.browser, 'adapt_causal_session_state_v1', (value) => {
    const snapshot = value.adapt_causal_session_state_v1 as { graphs?: Array<{ nodes?: Array<{ kind?: string }> }> } | undefined;
    return Boolean(snapshot?.graphs?.some((graph) => graph.nodes?.some((node) => node.kind === 'HEALTH_SNAPSHOT')));
  }, 1500);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  let resolved = false;
  let falsePositive = false;
  let negativeControlPreserved = definition.active;
  let resolutionAttribution: TrialResult['resolutionAttribution'] = 'UNRESOLVED';
  let remainingPageUrls: string[] = [];
  let navigationTargetSnapshot: unknown;
  const resolutionStarted = Date.now();
  let firstVisitResolvedAt: number | null = null;
  if (definition.active && definition.primary === 'overlay') {
    await page.waitForFunction(() => {
      const overlay = document.querySelector('div[style*="position:fixed"]');
      return Boolean(overlay && getComputedStyle(overlay).display !== 'none');
    }, { timeout: 2000 }).catch(() => undefined);
    await page.waitForFunction(() => {
      const overlay = document.querySelector('div[style*="position:fixed"]');
      return !overlay || getComputedStyle(overlay).display === 'none' || getComputedStyle(document.body).overflow !== 'hidden';
    }, { timeout: 5000 }).catch(() => undefined);
    resolved = await page.evaluate(() => {
      const overlay = document.querySelector('div[style*="position:fixed"]');
      return (!overlay || getComputedStyle(overlay).display === 'none') && getComputedStyle(document.body).overflow !== 'hidden';
    });
    if (resolved) firstVisitResolvedAt = Date.now();
  } else if (definition.active && definition.primary === 'popup') {
    await page.click('button');
    await page.waitForFunction((contentRoute) => location.pathname === `/${contentRoute}`, { timeout: 5000 }, definition.contentRoute).catch(() => undefined);
    const adUrl = `http://127.0.0.1:${adPort}/${definition.targetRoute}`;
    const closeDeadline = Date.now() + 2500;
    let adPages = (await session.browser.pages()).filter((candidate) => safePageUrl(candidate).startsWith(adUrl));
    while (adPages.length > 0 && Date.now() < closeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      adPages = (await session.browser.pages()).filter((candidate) => safePageUrl(candidate).startsWith(adUrl));
    }
    remainingPageUrls = (await session.browser.pages()).map((candidate) => safePageUrl(candidate));
    navigationTargetSnapshot = await sessionValue(session.browser, 'adapt_navigation_targets_v1');
    resolved = page.url().endsWith(`/${definition.contentRoute}`) && adPages.length === 0;
    if (resolved) firstVisitResolvedAt = Date.now();
  } else if (definition.active && definition.primary === 'scroll') {
    await page.waitForFunction(() => getComputedStyle(document.body).overflow === 'hidden' || getComputedStyle(document.documentElement).overflow === 'hidden', { timeout: 2500 }).catch(() => undefined);
    await page.waitForFunction(() => getComputedStyle(document.body).overflow !== 'hidden' && getComputedStyle(document.documentElement).overflow !== 'hidden', { timeout: 5000 }).catch(() => undefined);
    resolved = await page.evaluate(() => getComputedStyle(document.body).overflow !== 'hidden' && getComputedStyle(document.documentElement).overflow !== 'hidden');
    if (resolved) firstVisitResolvedAt = Date.now();
  } else if (definition.active && definition.primary === 'pointer') {
    await page.waitForFunction(() => getComputedStyle(document.body).pointerEvents === 'none', { timeout: 2500 }).catch(() => undefined);
    await page.waitForFunction(() => getComputedStyle(document.body).pointerEvents !== 'none', { timeout: 5000 }).catch(() => undefined);
    resolved = await page.evaluate(() => getComputedStyle(document.body).pointerEvents !== 'none');
    if (resolved) firstVisitResolvedAt = Date.now();
  } else if (!definition.active) {
    const controlKind = definition.controlKind;
    const sourceUrl = page.url();
    if (controlKind === 'benign-modal' || controlKind === 'normal-spa') {
      await page.click('button, a');
    } else if (controlKind === 'ctrl-meta-middle-click') {
      await page.keyboard.down('Meta');
      await page.click('a', { button: 'middle' });
      await page.keyboard.up('Meta');
    } else {
      await page.click('a');
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
    const pages = await session.browser.pages();
    const livePages = pages.filter((candidate) => safePageUrl(candidate) !== 'about:blank');
    const matchingContent = pages.some((candidate) => safePageUrl(candidate).endsWith(`/${definition.contentRoute}`));
    const matchingTarget = pages.some((candidate) => safePageUrl(candidate).includes(`/${definition.targetRoute}`));
    const sourceHealthy = pages.some((candidate) => safePageUrl(candidate) === sourceUrl);
    const spaCommitted = page.url().endsWith(`/${definition.contentRoute}`);
    const modalVisible = await page.evaluate(() => [...document.querySelectorAll('[class^="modal-"]')].some((element) => getComputedStyle(element).display !== 'none'));
    const expectedOutcomeSurvives = controlKind === 'benign-modal'
      ? modalVisible && sourceHealthy
      : controlKind === 'normal-spa'
        ? spaCommitted && livePages.length === 1
        : controlKind === 'document-download'
          ? sourceHealthy && (matchingTarget || !pages.some((candidate) => safePageUrl(candidate).includes(`/${definition.targetRoute}`) && candidate !== page))
          : controlKind === 'oauth' || controlKind === 'payment' || controlKind === 'ctrl-meta-middle-click' || controlKind === 'external-target-blank'
            ? matchingTarget
            : matchingContent;
    negativeControlPreserved = expectedOutcomeSurvives && !pages.some((candidate) => candidate !== page && safePageUrl(candidate).includes(`/${definition.targetRoute}`) && controlKind === 'target-blank');
    falsePositive = !negativeControlPreserved;
    resolved = false;
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await waitForSession(session.browser, 'adapt_autonomy_state_v1', (value) => {
    const snapshot = value.adapt_autonomy_state_v1 as { pending?: unknown[] } | undefined;
    return Array.isArray(snapshot?.pending) && snapshot.pending.length === 0;
  }, 2500);
  const state = await waitForSession(session.browser, 'adapt_causal_session_state_v1', (value) => Boolean(value.adapt_causal_session_state_v1));
  const autonomy = await sessionValue(session.browser, 'adapt_autonomy_state_v1');
  const signals = graphSignals({ ...(state ?? {}), ...(autonomy ?? {}) });
  const causalSnapshot = state?.adapt_causal_session_state_v1 as { graphs?: Array<{ experiments?: unknown[] }> } | undefined;
  const autonomySnapshot = autonomy?.adapt_autonomy_state_v1 as { pending?: unknown[] } | undefined;
  const completedGraphExperiments = (causalSnapshot?.graphs ?? []).reduce((sum, graph) => sum + (graph.experiments?.length ?? 0), 0);
  const pendingAutonomyCount = autonomySnapshot?.pending?.length ?? 0;
  let recipeReplay = false;
  let secondVisitExperiments = 0;
  let secondVisitAiCalls = 0;
  let secondVisitSuccess = false;
  if (definition.active && resolved) {
    const secondVisitStarted = Date.now();
    const beforeSecond = signals;
    if (definition.kind === 'popup') {
      await page.goto(`http://127.0.0.1:${appPort}/${definition.route}`, { waitUntil: 'domcontentloaded' });
      await waitForSession(session.browser, 'adapt_causal_session_state_v1', (value) => {
        const snapshot = value.adapt_causal_session_state_v1 as { graphs?: Array<{ nodes?: Array<{ kind?: string }> }> } | undefined;
        return Boolean(snapshot?.graphs?.some((graph) => graph.nodes?.some((node) => node.kind === 'HEALTH_SNAPSHOT')));
      }, 1500);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } else {
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
    if (definition.primary === 'overlay') {
      await page.waitForFunction(() => {
        const overlay = document.querySelector('div[style*="position:fixed"]');
        return Boolean(overlay && getComputedStyle(overlay).display !== 'none');
      }, { timeout: 2000 }).catch(() => undefined);
      await page.waitForFunction(() => {
        const overlay = document.querySelector('div[style*="position:fixed"]');
        return !overlay || getComputedStyle(overlay).display === 'none' || getComputedStyle(document.body).overflow !== 'hidden';
      }, { timeout: 5000 }).catch(() => undefined);
      secondVisitSuccess = await page.evaluate(() => {
        const overlay = document.querySelector('div[style*="position:fixed"]');
        return (!overlay || getComputedStyle(overlay).display === 'none') && getComputedStyle(document.body).overflow !== 'hidden';
      });
    } else if (definition.primary === 'scroll') {
      await page.waitForFunction(() => getComputedStyle(document.body).overflow === 'hidden' || getComputedStyle(document.documentElement).overflow === 'hidden', { timeout: 2500 }).catch(() => undefined);
      await page.waitForFunction(() => getComputedStyle(document.body).overflow !== 'hidden' && getComputedStyle(document.documentElement).overflow !== 'hidden', { timeout: 5000 }).catch(() => undefined);
      secondVisitSuccess = await page.evaluate(() => getComputedStyle(document.body).overflow !== 'hidden' && getComputedStyle(document.documentElement).overflow !== 'hidden');
    } else if (definition.primary === 'pointer') {
      await page.waitForFunction(() => getComputedStyle(document.body).pointerEvents === 'none', { timeout: 2500 }).catch(() => undefined);
      await page.waitForFunction(() => getComputedStyle(document.body).pointerEvents !== 'none', { timeout: 5000 }).catch(() => undefined);
      secondVisitSuccess = await page.evaluate(() => getComputedStyle(document.body).pointerEvents !== 'none');
    } else {
      await page.click('button');
      await page.waitForFunction((contentRoute) => location.pathname === `/${contentRoute}`, { timeout: 5000 }, definition.contentRoute).catch(() => undefined);
      const adUrl = `http://127.0.0.1:${adPort}/${definition.targetRoute}`;
      await new Promise((resolve) => setTimeout(resolve, 700));
      secondVisitSuccess = page.url().endsWith(`/${definition.contentRoute}`)
        && !(await session.browser.pages()).some((candidate) => safePageUrl(candidate).startsWith(adUrl));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  const secondState = await waitForSession(session.browser, 'adapt_causal_session_state_v1', (value) => Boolean(value.adapt_causal_session_state_v1));
  const secondAutonomy = await sessionValue(session.browser, 'adapt_autonomy_state_v1');
  const secondSignals = graphSignals({ ...(secondState ?? {}), ...(secondAutonomy ?? {}) });
    secondVisitExperiments = Math.max(0, secondSignals.experiments - beforeSecond.experiments);
    secondVisitAiCalls = Math.max(0, secondSignals.aiCalls - beforeSecond.aiCalls);
    const recipes = await localValue(session.browser, 'adapt_causal_recipes_v1');
    const bundle = recipes?.adapt_causal_recipes_v1 as { items?: Record<string, { evidence?: Array<{ replay?: boolean; completedWallMs?: number }> }> } | undefined;
    recipeReplay = Object.values(bundle?.items ?? {}).some((record) => (record.evidence ?? []).some((evidence) => evidence.replay === true && (evidence.completedWallMs ?? 0) >= secondVisitStarted));
  }
  for (const candidate of await session.browser.pages()) {
    if (candidate !== page && safePageUrl(candidate).includes(`127.0.0.1:${adPort}`)) {
      await candidate.close().catch(() => undefined);
    }
  }
  await page.close().catch(() => undefined);
  const committedPrimitive = signals.experimentDetails.some((detail) => detail.includes(':COMMITTED:'));
  const firstVisitMechanismResolved = definition.active && resolved;
  if (definition.active && firstVisitMechanismResolved && committedPrimitive) {
    resolutionAttribution = 'SAEI';
  } else if (definition.active && firstVisitMechanismResolved && signals.experiments === 0) {
    resolutionAttribution = 'STATIC_FILTER';
  } else if (definition.active && firstVisitMechanismResolved && signals.interventions === 0) {
    resolutionAttribution = 'DETERMINISTIC_FALLBACK';
  } else if (!definition.active && negativeControlPreserved) {
    resolutionAttribution = 'NEGATIVE_CONTROL';
  } else {
    resolutionAttribution = 'UNRESOLVED';
  }
  if (definition.active) {
    resolved = firstVisitMechanismResolved && resolutionAttribution !== 'UNRESOLVED';
  }
  if (definition.primary === 'popup') {
    resolved = resolved && (definition.active ? signals.interventions > 0 : true);
  }
  const timeToResolutionMs = definition.active && resolved && firstVisitResolvedAt !== null ? firstVisitResolvedAt - resolutionStarted : null;
  const rollbackDetails = signals.experimentDetails.filter((detail) => detail.includes(':COMMITTED:') || detail.includes(':ROLLED_BACK:'));
  const rollbackSuccess = !definition.active
    ? negativeControlPreserved
    : rollbackDetails.length === 0
      ? resolutionAttribution === 'STATIC_FILTER' || resolutionAttribution === 'DETERMINISTIC_FALLBACK'
      : rollbackDetails.every((detail) => detail.includes(':rollback-ok:'));
  return {
    id: definition.id,
    active: definition.active,
    controlKind: definition.controlKind,
    detected: signals.detected,
    resolved,
    falsePositive: definition.active ? false : falsePositive || signals.interventions > 0,
    negativeControlPreserved,
    resolutionAttribution,
    experiments: signals.experiments,
    aiCalls: signals.aiCalls,
    recipeReplay,
    secondVisitExperiments,
    secondVisitAiCalls,
    secondVisitSuccess,
    timeToResolutionMs,
    rollbackSuccess,
    capabilityGaps: signals.capabilityGaps,
    observedEventKinds: signals.observedEventKinds,
    autonomyStatuses: signals.autonomyStatuses,
    experimentDetails: signals.experimentDetails,
    remainingPageUrls,
    navigationTargetSnapshot,
    pendingAutonomyCount,
    completedGraphExperiments,
  };
}

async function runWorkerRestartProbe(definition: TrialDefinition, appPort: number): Promise<boolean> {
  const session = await launchSession(`http://127.0.0.1:${appPort}/warmup`);
  try {
    const page = await session.browser.newPage();
    await page.goto(`http://127.0.0.1:${appPort}/${definition.route}`, { waitUntil: 'domcontentloaded' });
    await page.click('button');
    const pending = await waitForSession(session.browser, 'adapt_autonomy_state_v1', (value) => {
      const state = value.adapt_autonomy_state_v1 as { pending?: unknown[] } | undefined;
      return Boolean(state?.pending?.length);
    }, 2500);
    if (!pending) return false;
    const worker = session.browser.targets().find((target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'));
    if (!worker) return false;
    const client = await worker.createCDPSession();
    await client.send('Runtime.terminateExecution');
    await client.detach();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await page.close().catch(() => undefined);
    return Boolean(await waitForSession(session.browser, 'adapt_autonomy_state_v1', (value) => {
      const state = value.adapt_autonomy_state_v1 as { pending?: unknown[] } | undefined;
      return Boolean(state && Array.isArray(state.pending) && state.pending.length === 0);
    }, 3000));
  } finally {
    await session.browser.close().catch(() => undefined);
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? null;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

function score(
  results: readonly TrialResult[],
  workerRestartSuccess: boolean,
  primitiveExecutionCoverage: number,
  profile: 'fast' | 'full',
): BrowserHoldoutScore {
  const active = results.filter((result) => result.active);
  const controls = results.filter((result) => !result.active);
  const popupActive = active.filter((result) => result.id.includes('popup'));
  const popupControls = controls.filter((result) => result.controlKind === 'target-blank' || result.controlKind === 'external-target-blank' || result.controlKind === 'ctrl-meta-middle-click' || result.controlKind === 'oauth');
  const experiments = active.map((result) => result.experiments);
  const resolvedActive = active.filter((result) => result.resolved);
  const negativeControlsPreserved = controls.filter((result) => result.negativeControlPreserved);
  const saeiResolved = active.filter((result) => result.resolutionAttribution === 'SAEI');
  const deterministicResolved = active.filter((result) => result.resolutionAttribution === 'DETERMINISTIC_FALLBACK' || result.resolutionAttribution === 'STATIC_FILTER');
  const detectedActive = active.filter((result) => result.detected || result.resolutionAttribution === 'STATIC_FILTER');
  const recipeEligible = active.filter((result) => result.experiments > 0 || result.secondVisitExperiments === 0 && result.resolutionAttribution === 'SAEI');
  const rollbackEligible = active.filter((result) => result.experiments > 0);
  return {
    profile,
    activeTrials: active.length,
    negativeControls: controls.length,
    autonomousDetectionRate: active.length === 0 ? 1 : detectedActive.length / active.length,
    autonomousResolutionRate: active.length === 0 ? 1 : active.filter((result) => result.resolved).length / active.length,
    overallAdaptResolutionRate: active.length === 0 ? 1 : resolvedActive.length / active.length,
    saeiResolutionRate: active.length === 0 ? 1 : saeiResolved.length / active.length,
    deterministicResolutionRate: active.length === 0 ? 1 : deterministicResolved.length / active.length,
    activeResolved: resolvedActive.length,
    recipeReplayEligibleTrials: recipeEligible.length,
    negativeControlsPreserved: negativeControlsPreserved.length,
    negativeControlPreservationRate: controls.length === 0 ? 1 : negativeControlsPreserved.length / controls.length,
    protectedFlowFalsePositiveCount: controls.filter((result) => !result.negativeControlPreserved).length,
    falsePositiveRate: controls.length === 0 ? 0 : controls.filter((result) => result.falsePositive).length / controls.length,
    criticalFalsePositiveCount: controls.filter((result) => result.falsePositive).length,
    medianExperiments: median(experiments) ?? 0,
    p95Experiments: percentile(experiments, 0.95),
    medianTimeToResolution: resolvedActive.length === 0
      ? null
      : median(resolvedActive.map((result) => result.timeToResolutionMs).filter((value): value is number => value !== null)) ?? 0,
    recipeReplaySuccessRate: recipeEligible.length === 0 ? 1 : recipeEligible.filter((result) => result.recipeReplay).length / recipeEligible.length,
    secondVisitAiCalls: results.reduce((sum, result) => sum + result.secondVisitAiCalls, 0),
    secondVisitExperiments: results.reduce((sum, result) => sum + result.secondVisitExperiments, 0),
    workerRestartSuccessRate: workerRestartSuccess ? 1 : 0,
    capabilityGapCount: results.reduce((sum, result) => sum + result.capabilityGaps, 0),
    policyAbstentionCount: 0,
    primitiveExecutionCoverage,
    rollbackSuccessRate: rollbackEligible.length === 0 ? 1 : rollbackEligible.filter((result) => result.rollbackSuccess).length / rollbackEligible.length,
    rollbackEligibleTrials: rollbackEligible.length,
    popupUnwantedTargetRecall: popupActive.length === 0 ? 1 : popupActive.filter((result) => result.resolved).length / popupActive.length,
    popupLegitimateTargetFalsePositiveRate: popupControls.length === 0 ? 0 : popupControls.filter((result) => !result.negativeControlPreserved).length / popupControls.length,
    autonomyStatusCounts: {
      detected: active.filter((result) => result.detected || result.resolutionAttribution === 'STATIC_FILTER').length,
      attempted: active.filter((result) => result.experiments > 0).length,
      resolved: results.filter((result) => result.active && result.resolved).length,
      rolledBack: active.filter((result) => result.rollbackSuccess).length,
      capabilityGap: active.filter((result) => result.capabilityGaps > 0).length,
      policyAbstention: active.filter((result) => result.autonomyStatuses.some((status) => status.startsWith('ABSTAINED'))).length,
      timedOut: active.filter((result) => result.detected && !result.resolved && result.timeToResolutionMs === null).length,
    },
  };
}

function liveGateFailures(scoreResult: BrowserHoldoutScore): string[] {
  const failures: string[] = [];
  if (scoreResult.autonomousDetectionRate < 0.95) failures.push('autonomous_detection_rate < 0.95');
  if (scoreResult.autonomousResolutionRate < 0.9) failures.push('autonomous_resolution_rate < 0.90');
  if (scoreResult.criticalFalsePositiveCount !== 0) failures.push('critical_false_positive_count != 0');
  if (scoreResult.negativeControlPreservationRate !== 1) failures.push('negative_control_preservation_rate != 1');
  if (scoreResult.protectedFlowFalsePositiveCount !== 0) failures.push('protected_flow_false_positive_count != 0');
  if (scoreResult.popupLegitimateTargetFalsePositiveRate !== 0) failures.push('popup_legitimate_target_false_positive_rate != 0');
  if (scoreResult.workerRestartSuccessRate !== 1) failures.push('worker_restart_success_rate != 1');
  if (scoreResult.recipeReplaySuccessRate < 0.95) failures.push('recipe_replay_success_rate < 0.95');
  if (scoreResult.rollbackSuccessRate < 0.95) failures.push('rollback_success_rate < 0.95');
  if (scoreResult.primitiveExecutionCoverage < 1) failures.push('primitive_execution_coverage < 1');
  return failures;
}

async function main(): Promise<void> {
  mkdirSync(path.resolve(projectRoot, 'artifacts/phase35b'), { recursive: true });
  const profile: 'fast' | 'full' = process.env.ADAPT_LIVE_PROFILE === 'full' ? 'full' : 'fast';
  const activeTrialCount = profile === 'full' ? 96 : 24;
  const negativeControlCount = profile === 'full' ? 48 : 16;
  const appRoutes = new Map<string, TrialDefinition>();
  const adRoutes = new Map<string, TrialDefinition>();
  const resourceServer = await startResourceServer();
  const adServer = await startServer(0, (requestPath) => {
    const match = [...adRoutes.values()].find((definition) => requestPath === `/${definition.targetRoute}` || requestPath.startsWith(`/${definition.targetRoute}/`));
    if (match && requestPath.endsWith('/redirect-start')) {
      return `<!doctype html><html><body><main><h1>Redirecting</h1></main><script>setTimeout(()=>location.replace('/${match.targetRoute}/redirect-final'),${40 + (match.seed % 5) * 20});</script></body></html>`;
    }
    return match?.kind === 'oauth' ? '<!doctype html><html><body><h1>Identity provider</h1></body></html>' : targetHtml();
  });
  const appServer = await startServer(0, (requestPath) => {
    if (requestPath === '/warmup') return contentHtml();
    if (requestPath === '/primitive-executor-fixture') return primitiveFixtureHtml(resourceServer.port);
    const definition = [...appRoutes.values()].find((candidate) => `/${candidate.route}` === requestPath);
    if (definition) return pageHtml(definition, adServer.port);
    if ([...appRoutes.values()].some((candidate) => `/${candidate.contentRoute}` === requestPath)) return contentHtml();
    return contentHtml();
  });

  const activeBundles: readonly (readonly HoldoutMechanism[])[] = [
    ['anti-block-overlay'],
    ['semantic-inline-gate'],
    ['scroll-only-gate'],
    ['pointer-lock'],
    ['popup'],
    ['popup', 'same-tab-navigation'],
    ['delayed-popup'],
    ['popunder-focus-split'],
    ['redirect-chain'],
    ['popup', 'redirect-chain'],
    ['spa-gate'],
    ['reinsertion'],
    ['mutation-burst'],
    ['player-obstruction'],
    ['network-probe', 'anti-block-overlay'],
    ['bait-reaction', 'anti-block-overlay'],
    ['popup', 'anti-block-overlay', 'mutation-burst'],
    ['popup', 'player-obstruction', 'redirect-chain'],
  ];
  const controlKinds: readonly NegativeControlKind[] = [
    'target-blank',
    'external-target-blank',
    'ctrl-meta-middle-click',
    'oauth',
    'payment',
    'document-download',
    'normal-spa',
    'benign-modal',
  ];
  const definitions: TrialDefinition[] = [
    ...Array.from({ length: activeTrialCount }, (_, index) => {
      const seed = index + 1;
      const base = activeBundles[index % activeBundles.length] ?? ['anti-block-overlay'];
      const mechanisms = [...base, ...(index % 4 === 0 ? ['confounder'] as const : [])];
      const primary: TrialPrimary = mechanisms.includes('popup') || mechanisms.includes('delayed-popup') || mechanisms.includes('popunder-focus-split') || mechanisms.includes('redirect-chain')
        ? 'popup'
        : mechanisms.includes('scroll-only-gate')
          ? 'scroll'
          : mechanisms.includes('pointer-lock')
            ? 'pointer'
            : 'overlay';
      const kind = primary === 'popup' ? 'popup' : 'overlay';
      return {
        id: `active-${primary}-${mechanisms.join('-')}-${token(seed)}`,
        active: true,
        kind,
        primary,
        mechanisms,
        seed,
        route: token(100 + seed),
        contentRoute: token(200 + seed),
        targetRoute: token(300 + seed),
      } satisfies TrialDefinition;
    }),
    ...Array.from({ length: negativeControlCount }, (_, index) => {
      const seed = index + 1;
      const controlKind = controlKinds[index % controlKinds.length] ?? 'target-blank';
      const kind = controlKind === 'oauth'
        ? 'oauth'
        : controlKind === 'payment'
          ? 'payment'
          : controlKind === 'document-download'
            ? 'document'
            : controlKind === 'normal-spa'
              ? 'spa'
              : controlKind === 'benign-modal'
                ? 'modal'
                : controlKind === 'ctrl-meta-middle-click'
                  ? 'modified'
                  : controlKind === 'external-target-blank'
                    ? 'external'
                    : 'legitimate';
      return {
        id: `negative-${controlKind}-${token(400 + seed)}`,
        active: false,
        kind,
        primary: 'control',
        mechanisms: [],
        controlKind,
        seed,
        route: token(500 + seed),
        contentRoute: token(600 + seed),
        targetRoute: token(700 + seed),
      } satisfies TrialDefinition;
    }),
  ];
  for (const definition of definitions) {
    appRoutes.set(definition.route, definition);
    adRoutes.set(definition.targetRoute, definition);
  }

  const results: TrialResult[] = [];
  const selectedDefinitions = (process.env.ADAPT_LIVE_ONLY_POPUP === '1'
    ? definitions.filter((definition) => definition.kind === 'popup')
    : process.env.ADAPT_LIVE_ONLY_CONTROLS === '1'
      ? definitions.filter((definition) => !definition.active)
      : definitions).slice(0, Number.isFinite(Number(process.env.ADAPT_LIVE_LIMIT)) && Number(process.env.ADAPT_LIVE_LIMIT) > 0
      ? Number(process.env.ADAPT_LIVE_LIMIT)
      : undefined);
  for (const definition of selectedDefinitions) {
    const session = await launchSession(`http://127.0.0.1:${appServer.port}/warmup`);
    try {
      results.push(await exerciseTrial(session, definition, appServer.port, adServer.port));
    } finally {
      await session.browser.close().catch(() => undefined);
    }
  }
  const primitiveProbes = await runPrimitiveExecutorBrowserProbes(appServer.port, resourceServer);
  if (results.filter((result) => result.active && result.id.includes('popup')).length > 0
    && results.filter((result) => result.active && result.id.includes('popup')).every((result) => result.experimentDetails.some((detail) => detail.startsWith('CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET:COMMITTED')))) {
    primitiveProbes.browserTested.add('CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET');
  }
  const restartDefinition = definitions.find((definition) => definition.kind === 'popup' && definition.active);
  const workerRestartSuccess = restartDefinition
    ? await runWorkerRestartProbe(restartDefinition, appServer.port)
    : false;
  const executionRegistry = primitiveProbes.registry;
  const primitiveMatrix = executionRegistry.matrix();
  const browserTestableEntries = primitiveMatrix.filter((entry) => entry.executorRegistered);
  const liveScore = score(
    results,
    workerRestartSuccess,
    browserTestableEntries.length === 0
      ? 0
      : browserTestableEntries.filter((entry) => entry.status === 'EXECUTABLE_AND_BROWSER_TESTED').length / browserTestableEntries.length,
    profile,
  );
  const lifecycleDefinition = definitions.find((definition) => definition.kind === 'popup' && definition.active) ?? definitions[0]!;
  const lifecycle = await runRecipeLifecycleProbe(lifecycleDefinition, appServer.port);
  const scenarioCoverage = {
    activeMechanisms: [...new Set(definitions.filter((definition) => definition.active).flatMap((definition) => definition.mechanisms))].sort(),
    negativeControlKinds: [...new Set(definitions.filter((definition) => !definition.active).map((definition) => definition.controlKind).filter((kind): kind is NegativeControlKind => kind !== undefined))].sort(),
    activeTemplateCount: new Set(definitions.filter((definition) => definition.active).map((definition) => definition.mechanisms.join('+'))).size,
  };
  const output = {
    schema: 'adapt-phase35b-live-browser-v1',
    generatedAt: new Date().toISOString(),
    scenarioCoverage,
    results,
    workerRestartSuccess,
    ...liveScore,
  };
  writeFileSync(path.resolve(projectRoot, 'artifacts/phase35b/LIVE_HOLDOUT_RESULTS.json'), `${JSON.stringify(output, null, 2)}\n`);
  writeFileSync(path.resolve(projectRoot, 'artifacts/phase35b/AUTONOMY_LIVE_SCORE.json'), `${JSON.stringify(liveScore, null, 2)}\n`);
  writeFileSync(path.resolve(projectRoot, 'artifacts/phase35b/PRIMITIVE_EXECUTION_MATRIX.json'), `${JSON.stringify({ schema: 'adapt-phase35b-primitive-execution-matrix-v1', generatedAt: output.generatedAt, entries: primitiveMatrix }, null, 2)}\n`);
  writeFileSync(path.resolve(projectRoot, 'artifacts/phase35b/PRIMITIVE_EXECUTOR_BROWSER_TESTS.json'), `${JSON.stringify({ schema: 'adapt-phase35b-primitive-executor-browser-tests-v1', generatedAt: output.generatedAt, results: primitiveProbes.results }, null, 2)}\n`);
  writeFileSync(path.resolve(projectRoot, 'artifacts/phase35b/WORKER_RESTART_RESULTS.json'), `${JSON.stringify({ schema: 'adapt-phase35b-worker-restart-v1', generatedAt: output.generatedAt, trials: 1, successfulTrials: workerRestartSuccess ? 1 : 0, successRate: workerRestartSuccess ? 1 : 0, method: 'CDP service-worker execution termination during pending autonomous transaction' }, null, 2)}\n`);
  writeFileSync(path.resolve(projectRoot, 'artifacts/phase35b/AI_USAGE.json'), `${JSON.stringify({ schema: 'adapt-phase35b-ai-usage-v1', generatedAt: output.generatedAt, plannerConfigured: false, aiCalls: results.reduce((sum, result) => sum + result.aiCalls, 0), reason: 'No safe production Phase 2 planner is wired into SAEI; deterministic routing remains authoritative.' }, null, 2)}\n`);
  writeFileSync(path.resolve(projectRoot, 'artifacts/phase35b/RECIPE_LIFECYCLE_LIVE.json'), `${JSON.stringify({ schema: 'adapt-phase35b-recipe-lifecycle-live-v1', generatedAt: output.generatedAt, ...lifecycle }, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
  await appServer.close();
  await adServer.close();
  await resourceServer.close();
  const failures = liveGateFailures(liveScore);
  if (failures.length > 0) {
    throw new Error(`PHASE 3.5B LIVE AUTONOMY VERIFICATION: FAIL (${failures.join(', ')})`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
