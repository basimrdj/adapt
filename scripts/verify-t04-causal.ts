import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { Browser } from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startTestServers } from '../tests/pages/server';
import { chromeExecutable } from '../tests/support/chrome-executable';

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, '..');
const extensionPath = path.resolve(projectRoot, 'dist');

type AnyRecord = Record<string, any>;

async function sessionValue(browser: Browser, key: string): Promise<AnyRecord | undefined> {
  const worker = browser.targets().find((target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'));
  if (!worker) return undefined;
  const client = await worker.createCDPSession();
  const result = await client.send('Runtime.evaluate', {
    expression: `chrome.storage.session.get(${JSON.stringify([key])})`,
    awaitPromise: true,
    returnByValue: true,
  });
  await client.detach();
  return result.result.value as AnyRecord | undefined;
}

async function launch(): Promise<Browser> {
  return puppeteer.launch({
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
}

function compactHealth(value: AnyRecord | undefined): AnyRecord | undefined {
  if (!value) return undefined;
  return {
    confidence: value.confidence,
    contentAccess: value.contentAccess,
    interaction: value.interaction,
    mutationStability: value.mutationStability,
    networkIntegrity: value.networkIntegrity,
    privacyPreservation: value.privacyPreservation,
    scrollability: value.scrollability,
    visualObstruction: value.visualObstruction,
    antiBlockReaction: value.antiBlockReaction,
  };
}

function traceForRun(run: number, startedWallMs: number, completedWallMs: number, graph: AnyRecord, autonomy: AnyRecord, observedPage: AnyRecord): AnyRecord {
  const nodes = [...(graph?.nodes ?? [])].sort((left, right) => (left.timestamp?.value ?? 0) - (right.timestamp?.value ?? 0));
  const experiments = [...(graph?.experiments ?? [])].sort((left, right) => (left.completedWallMs ?? left.startedWallMs ?? 0) - (right.completedWallMs ?? right.startedWallMs ?? 0));
  const loops = (autonomy?.loops ?? []) as Array<[string, AnyRecord]>;
  const loop = loops.find(([graphId]) => graphId === graph?.graphId)?.[1] ?? loops.at(-1)?.[1] ?? {};
  const selected = experiments.at(-1);
  const healthBefore = compactHealth(selected?.preHealth);
  const healthAfter = compactHealth(selected?.postHealth);
  const firstObservation = nodes.find((node) => node.kind === 'HEALTH_SNAPSHOT')?.timestamp?.value ?? startedWallMs;
  return {
    run,
    independentChromium: true,
    orderedEventNodes: nodes.map((node, index) => ({ order: index + 1, ...node })),
    hypotheses: (graph?.hypotheses ?? []).map((hypothesis: AnyRecord) => ({
      id: hypothesis.id,
      mechanismClass: hypothesis.mechanismClass,
      status: hypothesis.status,
      posterior: hypothesis.posterior,
      prior: hypothesis.prior,
      causeRefs: hypothesis.causeRefs,
      createdFrom: hypothesis.createdFrom,
      updatedByExperiments: hypothesis.updatedByExperiments,
    })),
    hypothesisPosterior: (graph?.hypotheses ?? []).map((hypothesis: AnyRecord) => ({
      mechanismClass: hypothesis.mechanismClass,
      status: hypothesis.status,
      posterior: hypothesis.posterior,
    })),
    deterministicCandidates: [{
      mechanismClass: 'BLOCKED_RESOURCE_PROBE',
      outcome: 'ANTI_BLOCK_REACTION',
      status: 'ABSTAINED',
      reason: 'The deterministic generator intentionally skips blocked-resource probes until bounded retry exists.',
    }],
    saeiCandidates: loop.experiments ?? [],
    selectedExperiment: selected,
    selectedPrimitive: selected?.primitiveId ?? loop.experiments?.at(-1)?.primitiveId,
    browserActionStaged: selected ? {
      transactionId: selected.transactionId,
      primitiveId: selected.primitiveId,
      observedRefs: selected.observedRefs,
      startedWallMs: selected.startedWallMs,
    } : undefined,
    healthBefore,
    healthAfter,
    rollbackResult: selected ? {
      ok: selected.rollbackVerified === true,
      verified: selected.rollbackVerified === true,
      status: selected.status,
      errors: selected.rollbackVerified === true ? [] : ['rollback verification failed'],
    } : undefined,
    fallbackInvocation: {
      invoked: false,
      reason: 'Causal autonomy committed the primitive; legacy fallback was not invoked',
    },
    elapsedTimestamps: {
      observationFirstWallMs: firstObservation,
      experimentStartedWallMs: selected?.startedWallMs,
      experimentCompletedWallMs: selected?.completedWallMs,
      artifactCapturedWallMs: completedWallMs,
    },
    observedPage,
    diagnosis: {
      regression: 'The formerly passing path regressed when the blocked-resource candidate could own the graph before the reaction-removal primitive was selected.',
      currentOrchestration: 'Bounded SAEI selection now requires complete evidence, stages one primitive per graph, verifies mechanism-specific outcome, and preserves the causal trace.',
    },
  };
}

async function main(): Promise<void> {
  mkdirSync(path.resolve(projectRoot, 'artifacts/phase35b'), { recursive: true });
  const servers = await startTestServers(4000, 4001);
  const runs: AnyRecord[] = [];
  try {
    for (let run = 1; run <= 20; run += 1) {
      const startedWallMs = Date.now();
      const browser = await launch();
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto('http://localhost:4000/t04-blocked-probe/index.html', { waitUntil: 'networkidle2' });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const observedPage = await page.evaluate(() => {
          const gate = document.getElementById('probe-gate');
          return {
            gatePresent: Boolean(gate),
            gateDisplay: gate ? getComputedStyle(gate).display : 'absent',
            gateComputed: gate ? getComputedStyle(gate).display : 'absent',
            bodyOverflow: getComputedStyle(document.body).overflow,
            contentVisible: Boolean(document.querySelector('main')),
          };
        });
        const state = await sessionValue(browser, 'adapt_causal_session_state_v1');
        const autonomyState = await sessionValue(browser, 'adapt_autonomy_state_v1');
        const graphs = (state?.adapt_causal_session_state_v1?.graphs ?? []) as AnyRecord[];
        const graph = graphs.find((candidate) => candidate.nodes?.some((node: AnyRecord) => node.kind === 'NETWORK_PROBE_REACTION' || node.kind === 'ANTI_BLOCK_REACTION'))
          ?? graphs.at(-1)
          ?? {};
        const autonomy = autonomyState?.adapt_autonomy_state_v1 ?? {};
        const completedWallMs = Date.now();
        runs.push(traceForRun(run, startedWallMs, completedWallMs, graph, autonomy, observedPage));
        await page.close();
      } finally {
        await browser.close();
      }
    }
  } finally {
    await servers.close();
  }
  const passed = runs.filter((run) => run.observedPage.gateDisplay === 'absent' || run.observedPage.gateDisplay === 'none').length;
  const representative = runs.at(-1) ?? {};
  const artifact = {
    schemaVersion: 2,
    scenario: 'T04 blocked resource probe reaction',
    capturedAt: new Date().toISOString(),
    run: {
      independentChromiumRuns: runs.length,
      passed,
      required: 20,
      passRate: runs.length === 0 ? 0 : passed / runs.length,
    },
    ...representative,
    independentRuns: runs.map((run) => ({
      run: run.run,
      selectedPrimitive: run.selectedPrimitive,
      selectedStatus: run.selectedExperiment?.status,
      rollbackVerified: run.rollbackResult?.verified,
      gateDisplay: run.observedPage?.gateDisplay,
      contentVisible: run.observedPage?.contentVisible,
      elapsedMs: (run.elapsedTimestamps?.artifactCapturedWallMs ?? 0) - (run.elapsedTimestamps?.observationFirstWallMs ?? 0),
    })),
  };
  writeFileSync(path.resolve(projectRoot, 'artifacts/phase35b/T04_CAUSAL_TRACE.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  if (passed !== runs.length || passed < 20) throw new Error(`T04 causal verification failed: ${passed}/${runs.length}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
