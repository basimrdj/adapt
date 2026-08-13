import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { Browser, WebWorker } from 'puppeteer';
import { startTestServers, TestServerInstances } from '../pages/server';

function chromeExecutable(): string {
  const chromeDir = path.resolve(__dirname, '../../chrome');
  if (fs.existsSync(chromeDir)) {
    for (const sub of fs.readdirSync(chromeDir)) {
      const candidate = path.join(
        chromeDir,
        sub,
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

interface StoredRecipe {
  lifecycle: 'DRAFT' | 'CONFIRMED' | 'RECIPE_SAFE' | 'INVALIDATED';
  recipe: { id: string; causalSupport: { stableReplays: number } };
}

describe('Phase 3 recipe lifecycle in real Chromium', () => {
  let browser: Browser;
  let servers: TestServerInstances;
  let worker: WebWorker;
  const extensionPath = path.resolve(__dirname, '../../dist');

  beforeAll(async () => {
    servers = await startTestServers(4020, 4021);
    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromeExecutable(),
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox'],
    });
    const target = await browser.waitForTarget(
      (item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'),
      { timeout: 10_000 }
    );
    const resolved = await target.worker();
    if (!resolved) throw new Error('extension service worker unavailable');
    worker = resolved;
  });

  afterAll(async () => {
    await browser?.close();
    await servers?.close();
  });

  async function recipes(): Promise<StoredRecipe[]> {
    return worker.evaluate(async () => {
      const result = await chrome.storage.local.get('adapt_causal_recipes_v1');
      const bundle = result.adapt_causal_recipes_v1 as { items?: Record<string, StoredRecipe> } | undefined;
      return Object.values(bundle?.items ?? {});
    });
  }

  async function diagnostics(): Promise<unknown> {
    return worker.evaluate(async () => {
      const local = await chrome.storage.local.get('adapt_causal_recipes_v1');
      const session = await chrome.storage.session.get([
        'adapt_causal_experiments_v1',
        'adapt_causal_session_state_v1',
      ]);
      const experiments = Object.values(
        (session.adapt_causal_experiments_v1 ?? {}) as Record<string, {
          hypothesisId: string;
          documentId: string;
          navigationEpoch: number;
          record: { id: string; status: string; healthDelta?: number };
        }>
      );
      const snapshot = session.adapt_causal_session_state_v1 as {
        belief?: { beliefs?: unknown[] };
        graphs?: Array<{
          scope: { documentId: string; navigationEpoch: number };
          experiments: unknown[];
          hypotheses: Array<{
            id: string;
            mechanismClass: string;
            status: string;
            posterior: number;
            updatedByExperiments: string[];
          }>;
        }>;
      } | undefined;
      return {
        recipes: local.adapt_causal_recipes_v1 ?? null,
        experiments: experiments.map((entry) => ({
          id: entry.record.id,
          status: entry.record.status,
          healthDelta: entry.record.healthDelta,
          hypothesisId: entry.hypothesisId,
          documentId: entry.documentId,
          navigationEpoch: entry.navigationEpoch,
        })),
        beliefs: snapshot?.belief?.beliefs ?? [],
        graphs: (snapshot?.graphs ?? []).map((graph) => ({
          scope: graph.scope,
          experimentCount: graph.experiments.length,
          hypotheses: graph.hypotheses,
        })),
      };
    });
  }

  async function visit(): Promise<void> {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('http://localhost:4020/t28-causal-bait/index.html', { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 2400));
    await page.close();
  }

  it('promotes a supported draft after two distinct successful replay visits', async () => {
    let state: StoredRecipe[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await visit();
      state = await recipes();
      if (state.some((entry) => entry.lifecycle === 'RECIPE_SAFE')) break;
    }
    const diagnosticState = await diagnostics();
    expect(state.some(
      (entry) => entry.lifecycle === 'RECIPE_SAFE' && entry.recipe.causalSupport.stableReplays >= 2
    ), JSON.stringify(diagnosticState, null, 2)).toBe(true);
  }, 35_000);
});
