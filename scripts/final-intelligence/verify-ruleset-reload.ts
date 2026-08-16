import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { Browser, Target } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const root = process.cwd();
const extensionPath = process.env.ADAPT_EXTENSION_PATH || path.join(root, 'dist');
const artifactPath = path.join(root, 'artifacts', 'final-intelligence', 'RULESET_RUNTIME_STATE.json');

interface RuntimeProbe {
  enabledRulesets: string[];
  availableStaticRuleCount: number | null;
  runtimeState: Record<string, unknown> | null;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForWorker(browser: Browser): Promise<Target> {
  const existing = browser.targets().find(
    (target) => target.type() === 'service_worker'
      && target.url().startsWith('chrome-extension://')
  );
  if (existing) return existing;
  return browser.waitForTarget(
    (target) => target.type() === 'service_worker'
      && target.url().startsWith('chrome-extension://'),
    { timeout: 10_000 }
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
    if (response.exceptionDetails) throw new Error('service-worker evaluation failed');
    return response.result.value as T;
  } finally {
    await client.detach();
  }
}

async function readProbe(target: Target): Promise<RuntimeProbe> {
  return evaluate<RuntimeProbe>(target, `
    (async () => {
      const [enabledRulesets, availableStaticRuleCount, stored] = await Promise.all([
        chrome.declarativeNetRequest.getEnabledRulesets(),
        chrome.declarativeNetRequest.getAvailableStaticRuleCount(),
        chrome.storage.session.get('adapt_ruleset_runtime_state'),
      ]);
      return {
        enabledRulesets,
        availableStaticRuleCount,
        runtimeState: stored.adapt_ruleset_runtime_state || null,
      };
    })()
  `);
}

async function readRuntimeState(target: Target): Promise<Record<string, unknown> | null> {
  return evaluate<Record<string, unknown> | null>(target, `
    (async () => {
      const stored = await chrome.storage.session.get('adapt_ruleset_runtime_state');
      return stored.adapt_ruleset_runtime_state || null;
    })()
  `);
}

async function waitForReconcile(target: Target): Promise<RuntimeProbe> {
  const deadline = Date.now() + 10_000;
  let runtimeState = await readRuntimeState(target);
  while (Date.now() < deadline) {
    if (runtimeState?.stage === 'reconcile-complete'
      || runtimeState?.stage === 'catalog-missing'
      || runtimeState?.stage === 'reconcile-failed') {
      const probe = await readProbe(target);
      return { ...probe, runtimeState };
    }
    await sleep(100);
    runtimeState = await readRuntimeState(target);
  }
  throw new Error('ruleset reconciliation did not publish runtime state');
}

function manifestState(): {
  manifestDefaultRulesets: string[];
  catalogRulesets: string[];
  expectedEnabledRuleCount: number | null;
} {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8')) as {
    declarative_net_request?: { rule_resources?: Array<{ id?: string; enabled?: boolean }> };
  };
  const resources = manifest.declarative_net_request?.rule_resources || [];
  const manifestDefaultRulesets = resources
    .filter((resource) => resource.enabled === true && typeof resource.id === 'string')
    .map((resource) => resource.id as string);
  const catalogPath = path.join(extensionPath, 'phase31-rulesets', 'catalog.json');
  if (!fs.existsSync(catalogPath)) {
    return { manifestDefaultRulesets, catalogRulesets: [], expectedEnabledRuleCount: null };
  }
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
    rulesets?: Array<{ id?: string; count?: number; defaultEnabled?: boolean }>;
  };
  const rulesets = Array.isArray(catalog.rulesets) ? catalog.rulesets : [];
  return {
    manifestDefaultRulesets,
    catalogRulesets: rulesets.flatMap((entry) => typeof entry.id === 'string' ? [entry.id] : []),
    expectedEnabledRuleCount: rulesets
      .filter((entry) => entry.defaultEnabled === true && typeof entry.count === 'number')
      .reduce((sum, entry) => sum + (entry.count as number), 0),
  };
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
    throw new Error('dist/manifest.json is missing; build the extension first');
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-ruleset-reload-'));
  const manifest = manifestState();
  let browser: Browser | undefined;
  const launch = async (): Promise<Browser> => puppeteer.launch({
    headless: true,
    executablePath: chromeExecutable(root),
    userDataDir: profile,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  const warmupAndProbe = async (label: string): Promise<RuntimeProbe> => {
    if (!browser) throw new Error('browser is unavailable');
    console.log(`[probe] ${label}: opening warmup page`);
    const warmup = await browser.newPage();
    await warmup.goto('about:blank');
    await sleep(600);
    const worker = await waitForWorker(browser);
    const extensionId = new URL(worker.url()).host;
    const inspector = await browser.newPage();
    await inspector.goto(`chrome-extension://${extensionId}/popup/index.html`);
    const inspectorTarget = inspector.target();
    const immediate = await readRuntimeState(inspectorTarget);
    const afterReconcile = await waitForReconcile(inspectorTarget);
    return {
      enabledRulesets: afterReconcile.enabledRulesets,
      availableStaticRuleCount: afterReconcile.availableStaticRuleCount,
      runtimeState: afterReconcile.runtimeState || immediate,
    };
  };
  try {
    console.log('[probe] launching fresh Chromium profile');
    browser = await launch();
    console.log('[probe] Chromium launched');

    const immediate = await warmupAndProbe('fresh load');
    const afterReconcile = immediate;
    console.log('[probe] immediate state captured');
    console.log('[probe] reconciliation state captured');

    await browser.close();
    browser = await launch();
    const afterReload = await warmupAndProbe('same-profile reload');
    console.log('[probe] reload state captured');

    const result = {
      schema: 'adapt-ruleset-runtime-state-v1',
      status: 'pass',
      provider: 'fresh unpacked Chromium extension load and same-profile Chromium relaunch probe',
      observedAt: new Date().toISOString(),
      extension: {
        manifestDefaultRulesets: manifest.manifestDefaultRulesets,
        catalogRulesets: manifest.catalogRulesets,
        expectedEnabledRuleCount: manifest.expectedEnabledRuleCount,
      },
      freshLoad: {
        immediate,
      },
      afterReload,
      assertions: {
        baselinePresentAfterLoad: afterReconcile.enabledRulesets.includes('ruleset_baseline'),
        expectedDefaultRulesEnabled: manifest.manifestDefaultRulesets.every((id) => afterReconcile.enabledRulesets.includes(id)),
        reconciliationRecorded: ['reconcile-complete', 'catalog-missing', 'reconcile-failed'].includes(String(afterReconcile.runtimeState?.stage)),
        reloadReconciliationRecorded: ['reconcile-complete', 'catalog-missing', 'reconcile-failed'].includes(String(afterReload.runtimeState?.stage)),
        reloadPreservedExpectedState: afterReload.enabledRulesets.length === afterReconcile.enabledRulesets.length
          && afterReload.enabledRulesets.every((id) => afterReconcile.enabledRulesets.includes(id)),
        optionalRulesReconciledAfterReload: manifest.catalogRulesets
          .filter((id) => !manifest.manifestDefaultRulesets.includes(id))
          .every((id) => afterReload.enabledRulesets.includes(id)),
      },
    };

    const failed = Object.entries(result.assertions).filter(([, value]) => value !== true);
    result.status = failed.length === 0 ? 'pass' : 'fail';
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({
      status: result.status,
      enabledAfterReconcile: afterReconcile.enabledRulesets,
      enabledAfterReload: afterReload.enabledRulesets,
      availableAfterReconcile: afterReconcile.availableStaticRuleCount,
      availableAfterReload: afterReload.availableStaticRuleCount,
      assertions: result.assertions,
    }, null, 2));
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await browser?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
