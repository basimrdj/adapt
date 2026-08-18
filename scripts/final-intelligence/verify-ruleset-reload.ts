import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { Browser, Target } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const root = process.cwd();
const extensionPath = process.env.ADAPT_EXTENSION_PATH || path.join(root, 'dist');
const artifactPath = path.join(root, 'artifacts', 'final-intelligence', 'RULESET_RELOAD_FIX.json');

interface RulesetInfo {
  id: string;
  count: number;
  priority: number;
  defaultEnabled: boolean;
  path: string;
}

interface ExtensionState {
  manifestRulesets: RulesetInfo[];
  catalogRulesets: RulesetInfo[];
  countsById: Record<string, number>;
  expectedTotal: number;
}

interface RuntimeProbe {
  label: string;
  elapsedMs: number;
  constants: {
    MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: number;
    GUARANTEED_MINIMUM_STATIC_RULES: number;
  };
  enabledRulesets: string[];
  availableStaticRuleCount: number;
  expectedEnabledRuleCounts: Record<string, number>;
  estimatedEnabledStaticRuleCount: number;
  runtimeState: Record<string, unknown> | null;
}

interface RulesetAttempt {
  rulesetId: string;
  batchIds: string[];
  ruleCount: number;
  availableBefore: number;
  enabledBefore: string[];
  attemptAtMs: number;
  result: 'success' | 'failure';
  exactError: string | null;
  availableAfter: number;
  enabledAfter: string[];
}

interface VariantResult {
  name: string;
  manifestEnabledAll: boolean;
  attempts: RulesetAttempt[];
  finalProbe: RuntimeProbe;
  reloadProbe: RuntimeProbe;
}

interface ServiceWorkerContext {
  browser: Browser;
  worker: Target;
  profile: string;
  startedAt: number;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readExtensionState(extensionRoot: string): ExtensionState {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8')) as {
    declarative_net_request?: {
      rule_resources?: Array<{ id?: string; enabled?: boolean; path?: string }>;
    };
  };
  const manifestRulesets = (manifest.declarative_net_request?.rule_resources || []).flatMap((resource) => {
    if (typeof resource.id !== 'string' || typeof resource.path !== 'string') return [];
    return [{
      id: resource.id,
      count: resource.id === 'ruleset_baseline'
        ? JSON.parse(fs.readFileSync(path.join(extensionRoot, resource.path), 'utf8')).length
        : 0,
      priority: 0,
      defaultEnabled: resource.enabled === true,
      path: resource.path,
    }];
  });
  const catalogPath = path.join(extensionRoot, 'phase31-rulesets', 'catalog.json');
  const catalog = fs.existsSync(catalogPath)
    ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as { rulesets?: Array<Partial<RulesetInfo>> }
    : {};
  const catalogRulesets = (Array.isArray(catalog.rulesets) ? catalog.rulesets : []).flatMap((entry) => {
    if (typeof entry.id !== 'string' || typeof entry.count !== 'number') return [];
    return [{
      id: entry.id,
      count: entry.count,
      priority: typeof entry.priority === 'number' ? entry.priority : 0,
      defaultEnabled: entry.defaultEnabled === true,
      path: typeof entry.path === 'string' ? entry.path : `phase31-rulesets/${entry.id}.json`,
    }];
  });
  const allRulesets = [...manifestRulesets.filter((entry) => entry.count > 0), ...catalogRulesets];
  const countsById = Object.fromEntries(allRulesets.map((entry) => [entry.id, entry.count]));
  return {
    manifestRulesets,
    catalogRulesets,
    countsById,
    expectedTotal: Object.values(countsById).reduce((sum, count) => sum + count, 0),
  };
}

async function waitForWorker(browser: Browser, previous?: Target): Promise<Target> {
  const existing = browser.targets().find(
    (target) => target !== previous
      && target.type() === 'service_worker'
      && target.url().startsWith('chrome-extension://')
  );
  if (existing) return existing;
  return browser.waitForTarget(
    (target) => target !== previous
      && target.type() === 'service_worker'
      && target.url().startsWith('chrome-extension://'),
    { timeout: 15_000 }
  );
}

async function evaluate<T>(target: Target, expression: string): Promise<T> {
  const client = await target.createCDPSession();
  try {
    const response = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || 'service-worker evaluation failed');
    }
    return response.result.value as T;
  } finally {
    await client.detach();
  }
}

function expectedCount(enabledRulesets: string[], state: ExtensionState): number {
  return enabledRulesets.reduce((sum, id) => sum + (state.countsById[id] || 0), 0);
}

async function readProbe(
  target: Target,
  label: string,
  startedAt: number,
  state: ExtensionState,
): Promise<RuntimeProbe> {
  const raw = await evaluate<{
    enabledRulesets: string[];
    availableStaticRuleCount: number;
    constants: RuntimeProbe['constants'];
    runtimeState: Record<string, unknown> | null;
  }>(target, `
    (async () => {
      const [enabledRulesets, availableStaticRuleCount, stored] = await Promise.all([
        chrome.declarativeNetRequest.getEnabledRulesets(),
        chrome.declarativeNetRequest.getAvailableStaticRuleCount(),
        chrome.storage.session.get('adapt_ruleset_runtime_state'),
      ]);
      return {
        enabledRulesets,
        availableStaticRuleCount,
        constants: {
          MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: chrome.declarativeNetRequest.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
          GUARANTEED_MINIMUM_STATIC_RULES: chrome.declarativeNetRequest.GUARANTEED_MINIMUM_STATIC_RULES,
        },
        runtimeState: stored.adapt_ruleset_runtime_state || null,
      };
    })()
  `);
  return {
    label,
    elapsedMs: Date.now() - startedAt,
    constants: raw.constants,
    enabledRulesets: raw.enabledRulesets,
    availableStaticRuleCount: raw.availableStaticRuleCount,
    expectedEnabledRuleCounts: Object.fromEntries(
      raw.enabledRulesets.map((id) => [id, state.countsById[id] || 0])
    ),
    estimatedEnabledStaticRuleCount: expectedCount(raw.enabledRulesets, state),
    runtimeState: raw.runtimeState,
  };
}

async function waitForReconcile(target: Target, notBeforeMs = 0, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluate<{ stage: string | null; capturedAt: string | null }>(target, `
      (async () => {
        const stored = await chrome.storage.session.get('adapt_ruleset_runtime_state');
        return {
          stage: stored.adapt_ruleset_runtime_state?.stage || null,
          capturedAt: stored.adapt_ruleset_runtime_state?.capturedAt || null,
        };
      })()
    `);
    const capturedAt = state.capturedAt ? Date.parse(state.capturedAt) : 0;
    if (capturedAt >= notBeforeMs
      && (state.stage === 'reconcile-complete' || state.stage === 'reconcile-failed' || state.stage === 'catalog-missing')) return;
    await sleep(100);
  }
  throw new Error('ruleset reconciliation did not publish runtime state');
}

async function launch(extensionRoot: string, profile: string): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    executablePath: chromeExecutable(root),
    userDataDir: profile,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });
}

async function startContext(extensionRoot: string, profile: string): Promise<ServiceWorkerContext> {
  const startedAt = Date.now();
  const browser = await launch(extensionRoot, profile);
  const worker = await waitForWorker(browser);
  await sleep(100);
  return { browser, worker, profile, startedAt };
}

async function restartContext(
  current: ServiceWorkerContext,
  extensionRoot: string,
): Promise<ServiceWorkerContext> {
  await current.browser.close();
  return startContext(extensionRoot, current.profile);
}

async function attemptEnable(
  target: Target,
  id: string,
  batchIds: string[],
  startedAt: number,
  state: ExtensionState,
): Promise<RulesetAttempt> {
  return evaluate<RulesetAttempt>(target, `
    (async () => {
      const id = ${JSON.stringify(id)};
      const batchIds = ${JSON.stringify(batchIds)};
      const ruleCount = ${JSON.stringify(state.countsById[id] || 0)};
      const [enabledBefore, availableBefore] = await Promise.all([
        chrome.declarativeNetRequest.getEnabledRulesets(),
        chrome.declarativeNetRequest.getAvailableStaticRuleCount(),
      ]);
      let result = 'success';
      let exactError = null;
      try {
        await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: batchIds });
      } catch (error) {
        result = 'failure';
        exactError = error instanceof Error ? error.message : String(error);
      }
      const [enabledAfter, availableAfter] = await Promise.all([
        chrome.declarativeNetRequest.getEnabledRulesets(),
        chrome.declarativeNetRequest.getAvailableStaticRuleCount(),
      ]);
      return {
        rulesetId: id,
        batchIds,
        ruleCount,
        availableBefore,
        enabledBefore,
        attemptAtMs: Date.now() - ${startedAt},
        result,
        exactError,
        availableAfter,
        enabledAfter,
      };
    })()
  `);
}

function expandBatchAttempt(attempt: RulesetAttempt): RulesetAttempt[] {
  if (attempt.batchIds.length <= 1) return [attempt];
  return attempt.batchIds.map((id) => ({ ...attempt, rulesetId: id, ruleCount: attempt.ruleCount }));
}

async function prepareReloadedProfile(
  extensionRoot: string,
  state: ExtensionState,
): Promise<{ context: ServiceWorkerContext; initial: RuntimeProbe }> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-ruleset-variant-'));
  let context = await startContext(extensionRoot, profile);
  await waitForReconcile(context.worker, context.startedAt);
  const initial = await readProbe(context.worker, 'before-reload-after-reconcile', context.startedAt, state);
  context = await restartContext(context, extensionRoot);
  await waitForReconcile(context.worker, context.startedAt);
  return { context, initial };
}

async function runVariant(
  name: string,
  extensionRoot: string,
  state: ExtensionState,
  operation: (context: ServiceWorkerContext, startedAt: number) => Promise<RulesetAttempt[]>,
): Promise<VariantResult> {
  const prepared = await prepareReloadedProfile(extensionRoot, state);
  const attempts = await operation(prepared.context, prepared.context.startedAt);
  const finalProbe = await readProbe(prepared.context.worker, `${name}:final`, prepared.context.startedAt, state);
  const reloaded = await restartContext(prepared.context, extensionRoot);
  await waitForReconcile(reloaded.worker, reloaded.startedAt);
  const reloadProbe = await readProbe(reloaded.worker, `${name}:reloaded`, reloaded.startedAt, state);
  await reloaded.browser.close();
  fs.rmSync(reloaded.profile, { recursive: true, force: true });
  return {
    name,
    manifestEnabledAll: state.manifestRulesets.every((entry) => entry.defaultEnabled),
    attempts: attempts.flatMap(expandBatchAttempt),
    finalProbe,
    reloadProbe,
  };
}

function makeAllEnabledExtension(): string {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-ruleset-all-enabled-'));
  fs.cpSync(extensionPath, destination, { recursive: true });
  const manifestPath = path.join(destination, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    declarative_net_request?: { rule_resources?: Array<{ enabled?: boolean }> };
  };
  for (const resource of manifest.declarative_net_request?.rule_resources || []) resource.enabled = true;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}

async function runTimeline(
  extensionRoot: string,
  state: ExtensionState,
): Promise<{ timeline: RuntimeProbe[]; preReload: RuntimeProbe; postReload: RuntimeProbe; profile: string }> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-ruleset-timeline-'));
  let context = await startContext(extensionRoot, profile);
  const timeline: RuntimeProbe[] = [];
  timeline.push(await readProbe(context.worker, 'T0:first-install', context.startedAt, state));
  await waitForReconcile(context.worker, context.startedAt);
  const preReload = await readProbe(context.worker, 'T1:immediately-before-reload', context.startedAt, state);
  await context.browser.close();

  context = await startContext(extensionRoot, profile);
  const reloadObservedAt = Date.now();
  const postReload = await readProbe(context.worker, 'T2:immediately-after-reload', reloadObservedAt, state);
  timeline.push(postReload);
  for (const [label, delay] of [['T3:+250ms', 250], ['T4:+1s', 1000], ['T5:+3s', 3000], ['T6:+5s', 5000]] as const) {
    await sleep(Math.max(0, reloadObservedAt + delay - Date.now()));
    timeline.push(await readProbe(context.worker, label, reloadObservedAt, state));
  }
  await context.browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
  return { timeline, preReload, postReload, profile };
}

async function runFocusedPass(
  extensionRoot: string,
  state: ExtensionState,
  pass: number,
): Promise<{ pass: number; fresh: RuntimeProbe; reload: RuntimeProbe; relaunch: RuntimeProbe; passed: boolean }> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `adapt-ruleset-focused-${pass}-`));
  let context = await startContext(extensionRoot, profile);
  await waitForReconcile(context.worker, context.startedAt);
  const fresh = await readProbe(context.worker, `focused-${pass}:fresh`, context.startedAt, state);

  context = await restartContext(context, extensionRoot);
  await waitForReconcile(context.worker, context.startedAt);
  await sleep(5000);
  const reload = await readProbe(context.worker, `focused-${pass}:reload`, context.startedAt, state);

  context = await restartContext(context, extensionRoot);
  await waitForReconcile(context.worker, context.startedAt);
  await sleep(5000);
  const relaunch = await readProbe(context.worker, `focused-${pass}:relaunch`, context.startedAt, state);

  await context.browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
  const expected = state.expectedTotal;
  return {
    pass,
    fresh,
    reload,
    relaunch,
    passed: fresh.estimatedEnabledStaticRuleCount >= expected
      && reload.estimatedEnabledStaticRuleCount >= expected
      && relaunch.estimatedEnabledStaticRuleCount >= expected,
  };
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
    throw new Error('dist/manifest.json is missing; build the extension first');
  }
  const state = readExtensionState(extensionPath);
  const optional = state.catalogRulesets
    .filter((entry) => !entry.defaultEnabled)
    .sort((a, b) => b.priority - a.priority);
  const small = [...optional].sort((a, b) => a.count - b.count)[0];
  const large = [...optional].sort((a, b) => b.count - a.count)[0];
  if (!small || !large) throw new Error('catalog does not contain optional rulesets');

  console.log('[probe] collecting T0-T6 reload timeline');
  const timelineResult = await runTimeline(extensionPath, state);

  const variants: VariantResult[] = [];
  variants.push(await runVariant('small-optional-shard', extensionPath, state, async (context, startedAt) => [
    await attemptEnable(context.worker, small.id, [small.id], startedAt, state),
  ]));
  variants.push(await runVariant('large-optional-shard', extensionPath, state, async (context, startedAt) => [
    await attemptEnable(context.worker, large.id, [large.id], startedAt, state),
  ]));
  variants.push(await runVariant('all-optional-single-call', extensionPath, state, async (context, startedAt) => [
    await attemptEnable(context.worker, optional[0]?.id || small.id, optional.map((entry) => entry.id), startedAt, state),
  ]));
  variants.push(await runVariant('optional-sequential', extensionPath, state, async (context, startedAt) => {
    const attempts: RulesetAttempt[] = [];
    for (const entry of optional) attempts.push(await attemptEnable(context.worker, entry.id, [entry.id], startedAt, state));
    return attempts;
  }));
  variants.push(await runVariant('retry-delays', extensionPath, state, async (context, startedAt) => {
    const attempts: RulesetAttempt[] = [];
    for (const delay of [250, 1000, 3000, 5000]) {
      await sleep(delay);
      attempts.push(await attemptEnable(context.worker, large.id, [large.id], startedAt, state));
    }
    return attempts;
  }));

  const allEnabledExtension = makeAllEnabledExtension();
  let controlProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-ruleset-control-'));
  let control = await startContext(allEnabledExtension, controlProfile);
  const controlBeforeReload = await readProbe(control.worker, 'control:manifest-all-enabled', control.startedAt, readExtensionState(allEnabledExtension));
  await control.browser.close();
  control = await startContext(allEnabledExtension, controlProfile);
  const controlAfterReload = await readProbe(control.worker, 'control:after-reload', control.startedAt, readExtensionState(allEnabledExtension));
  await sleep(5000);
  const controlAfterWait = await readProbe(control.worker, 'control:+5s', control.startedAt, readExtensionState(allEnabledExtension));
  await control.browser.close();
  fs.rmSync(controlProfile, { recursive: true, force: true });
  fs.rmSync(allEnabledExtension, { recursive: true, force: true });

  const baselineRules = state.manifestRulesets.find((entry) => entry.id === 'ruleset_baseline')?.count || 0;
  const fullCatalogRules = state.catalogRulesets.reduce((sum, entry) => sum + entry.count, 0);
  const allDefault = state.manifestRulesets.filter((entry) => entry.defaultEnabled).map((entry) => entry.id);
  const timelineReload = timelineResult.timeline.find((probe) => probe.label === 'T6:+5s');
  const focusedRuns = [];
  for (let pass = 1; pass <= 5; pass += 1) {
    console.log(`[probe] focused reload pass ${pass}/5`);
    focusedRuns.push(await runFocusedPass(extensionPath, state, pass));
  }
  const primaryAssertions = {
    freshLoadHasMaximumObservedState: timelineResult.preReload.estimatedEnabledStaticRuleCount >= timelineReload!.estimatedEnabledStaticRuleCount,
    reloadDoesNotCollapseToGuaranteedMinimum: timelineReload!.estimatedEnabledStaticRuleCount > timelineReload!.constants.GUARANTEED_MINIMUM_STATIC_RULES,
    controlManifestAllEnabled: controlBeforeReload.estimatedEnabledStaticRuleCount >= fullCatalogRules + baselineRules,
    controlSurvivesReload: controlAfterWait.estimatedEnabledStaticRuleCount >= controlBeforeReload.estimatedEnabledStaticRuleCount,
    focusedFivePasses: focusedRuns.length === 5 && focusedRuns.every((run) => run.passed),
  };

  const result = {
    schema: 'adapt-ruleset-reload-fix-v1',
    status: Object.values(primaryAssertions).every(Boolean) ? 'pass' : 'fail',
    observedAt: new Date().toISOString(),
    extensionPath,
    constants: timelineResult.preReload.constants,
    manifestRulesets: state.manifestRulesets,
    catalogRulesets: state.catalogRulesets,
    baselineRules: baselineRules,
    catalogRuleTotal: fullCatalogRules,
    packagedRuleTotal: state.expectedTotal,
    intendedDefaultEnabledRulesets: allDefault,
    timeline: {
      T0: timelineResult.timeline.find((probe) => probe.label.startsWith('T0')),
      T1: timelineResult.preReload,
      T2: timelineResult.postReload,
      T3: timelineResult.timeline.find((probe) => probe.label.startsWith('T3')),
      T4: timelineResult.timeline.find((probe) => probe.label.startsWith('T4')),
      T5: timelineResult.timeline.find((probe) => probe.label.startsWith('T5')),
      T6: timelineReload,
    },
    variants,
    focusedRuns,
    control: {
      manifestEnabledAll: true,
      beforeReload: controlBeforeReload,
      afterReload: controlAfterReload,
      after5s: controlAfterWait,
    },
    primaryAssertions,
    diagnosis: {
      observedFailure: 'same-profile relaunch leaves only manifest defaults enabled while the API reports more apparent capacity; runtime optional re-enable behavior is captured in variants',
      candidateCauses: [
        'transient Chrome reload quota state',
        'incorrect available-count interpretation',
        'aggregate updateEnabledRulesets call',
        'one specific malformed or oversized ruleset',
        'enabled-ruleset-count limit',
        'regex or static sub-limit',
        'stale extension-version state',
        'catalog count mismatch',
        'Chromium unpacked-extension behavior',
      ],
    },
  };

  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    status: result.status,
    constants: result.constants,
    beforeReload: timelineResult.preReload.estimatedEnabledStaticRuleCount,
    afterReload: timelineReload?.estimatedEnabledStaticRuleCount,
    controlAfter5s: controlAfterWait.estimatedEnabledStaticRuleCount,
    primaryAssertions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
