import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { Browser, Page, WebWorker } from 'puppeteer';
import { startTestServers, TestServerInstances } from '../pages/server';
import { chromeExecutable } from '../support/chrome-executable';

interface RecipeRecord {
  lifecycle: 'DRAFT' | 'CONFIRMED' | 'RECIPE_SAFE' | 'INVALIDATED';
  invalidationReason?: string;
  recipe: { id: string; causalSupport: { stableReplays: number } };
  evidence?: Array<{ id: string }>;
}

describe('Phase 3 recipe restart and stale-detector invalidation', () => {
  let browser: Browser;
  let servers: TestServerInstances;
  let worker: WebWorker;
  let profilePath: string;
  let extensionId: string;
  let browserVersion: string;
  const extensionPath = path.resolve(__dirname, '../../dist');

  async function launch(): Promise<void> {
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromeExecutable(),
      userDataDir: profilePath,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--headless=new', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox'],
    });
    const target = await browser.waitForTarget(
      (item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'),
      { timeout: 10_000 }
    );
    const resolved = await target.worker();
    if (!resolved) throw new Error('extension service worker unavailable');
    worker = resolved;
    extensionId = target.url().split('/')[2] ?? 'unknown';
    browserVersion = await browser.version();
  }

  beforeAll(async () => {
    profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-phase3-profile-'));
    servers = await startTestServers(4040, 4041);
    await launch();
  });

  afterAll(async () => {
    await browser?.close();
    await servers?.close();
    if (profilePath?.startsWith(os.tmpdir())) fs.rmSync(profilePath, { recursive: true, force: true });
  });

  async function recipes(): Promise<RecipeRecord[]> {
    return worker.evaluate(async () => {
      const value = await chrome.storage.local.get('adapt_causal_recipes_v1');
      const bundle = value.adapt_causal_recipes_v1 as { items?: Record<string, RecipeRecord> } | undefined;
      return Object.values(bundle?.items ?? {});
    });
  }

  async function experimentCount(): Promise<number> {
    return worker.evaluate(async () => {
      const value = await chrome.storage.session.get('adapt_causal_experiments_v1');
      return Object.keys((value.adapt_causal_experiments_v1 ?? {}) as object).length;
    });
  }

  async function visit(query = '', waitMs = 3000): Promise<Page> {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://localhost:4040/t29-phase3-acceptance/index.html${query}`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return page;
  }

  it('persists RecipeSafe across restart, performs zero exploration, and invalidates a modified detector', async () => {
    let state: RecipeRecord[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const page = await visit();
      await page.close();
      state = await recipes();
      if (state.some((record) => record.lifecycle === 'RECIPE_SAFE')) break;
    }
    expect(state.some(
      (record) => record.lifecycle === 'RECIPE_SAFE' && record.recipe.causalSupport.stableReplays >= 2
    ), JSON.stringify(state, null, 2)).toBe(true);
    const safeRecord = state.find((record) => record.lifecycle === 'RECIPE_SAFE');
    expect(new Set(safeRecord?.evidence?.map((item) => item.id)).size).toBe(safeRecord?.evidence?.length);

    await browser.close();
    await launch();
    expect(await experimentCount()).toBe(0);

    const repeat = await visit('', 1800);
    const repeatState = await repeat.evaluate(() => ({
      applied: Boolean((window as typeof window & { __phase3_true_mechanism_observed?: boolean }).__phase3_true_mechanism_observed),
      gateVisible: Boolean(document.getElementById('phase3-acceptance-gate')),
    }));
    const afterRestartRecipes = await recipes();
    const afterRestartExperimentCount = await experimentCount();
    expect(repeatState.applied, JSON.stringify({ repeatState, afterRestartRecipes, afterRestartExperimentCount }, null, 2)).toBe(true);
    expect(repeatState.gateVisible).toBe(false);
    expect(afterRestartRecipes.some((record) => record.lifecycle === 'RECIPE_SAFE')).toBe(true);
    expect(afterRestartExperimentCount).toBe(0);
    await repeat.close();

    const modified = await visit('?detector=modified', 1800);
    const modifiedState = await recipes();
    expect(modifiedState.some(
      (record) => record.lifecycle === 'INVALIDATED' && record.invalidationReason === 'DETECTOR_MISMATCH'
    ), JSON.stringify(modifiedState, null, 2)).toBe(true);
    console.log('PHASE3_RESTART_EVIDENCE', JSON.stringify({
      profilePath,
      browserVersion,
      extensionId,
      fixture: 't29-phase3-acceptance',
      recipeId: state.find((record) => record.lifecycle === 'RECIPE_SAFE')?.recipe.id,
      stableReplays: state.find((record) => record.lifecycle === 'RECIPE_SAFE')?.recipe.causalSupport.stableReplays,
      explorationRecordsAfterRestart: afterRestartExperimentCount,
      invalidationReason: modifiedState.find((record) => record.lifecycle === 'INVALIDATED')?.invalidationReason,
    }));
    await modified.close();
  }, 60_000);
});
