/**
 * H4 — hostile-page + stress e2e program (real Chrome, extension loaded).
 *
 * Twelve scenarios pinning behavior at the hostile boundary:
 *   1. t36  hostile intrinsics freeze — page locks globals/prototypes; the
 *           isolated-world pipeline must be unaffected, zero page errors.
 *   2. t37  sub-threshold mutation drip — main thread stays responsive while
 *           the debounced batcher faces a forever-drip (post-H3 max-wait).
 *   3. t41  re-hide war endgame — an unbounded 40ms re-shower vs the bounded
 *           re-hide watch: fight engages, stays bounded, final state recorded.
 *   4. t38  closed shadow root — documented blindness: the wall honestly
 *           stands; the outer document and open-shadow content are untouched.
 *   5. t39  READY/hashchange flood — 200 flips; worker stays responsive; the
 *           pipeline still functions after the flood.
 *   6. t40  synthetic click flood — 1000 untrusted clicks; page healthy.
 *   7. bfcache — back/forward restore: no crash, no duplicate side effects.
 *   8. stale-document apply — navigate away mid-adaptation; the new document
 *           is never touched by the dead document's work.
 *   9. t43  long-task starvation — 3s main-thread block; pipeline recovers.
 *  9b. t45  SPA pushState gate — a gate raised after history.pushState (no
 *           popstate) must still be detected and resolved; pins the
 *           stale-navigationId epoch re-resolution against STALE_EPOCH
 *           blindness for the rest of the document's life.
 *  10. soak — 10k-node churn × 25 SPA navs (heap bounded) + 50-tab flood.
 *  11. worker-kill storm — repeated SW termination during staging windows;
 *           recovery leaves zero orphan session rules.
 *  12. corrupted/quota storage boot — poisoned payloads + near-quota session
 *           storage: extension boots, static plane holds, clean boot recovers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer, { Browser, Page } from 'puppeteer';
import { startTestServers, TestServerInstances } from '../pages/server';
import { chromeExecutable } from '../support/chrome-executable';
import { verificationMetadata } from '../../scripts/verification-metadata';

interface ScenarioRecord {
  id: string;
  pass: boolean;
  durationMs: number;
  detail?: string;
  observations?: Record<string, unknown>;
}

describe('H4 hostile-page + stress program', () => {
  let browser: Browser;
  let servers: TestServerInstances;
  const results: ScenarioRecord[] = [];
  const extensionPath = path.resolve(__dirname, '../../dist');
  const app = 'http://localhost:4070';

  const launchBrowser = () =>
    puppeteer.launch({
      headless: false,
      executablePath: chromeExecutable(),
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--headless=new',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        // Per-scenario host isolation: learned recipes/cosmetic profiles are
        // keyed by registrable site, so war/longtask fixtures get their own
        // eTLD+1 and cannot inherit another scenario's learning.
        '--host-resolver-rules=MAP *.test 127.0.0.1',
        '--no-sandbox',
      ],
    });

  beforeAll(async () => {
    servers = await startTestServers(4070, 4071);
    browser = await launchBrowser();
  }, 60_000);

  afterAll(async () => {
    const artifactDir = path.resolve(__dirname, '../../artifacts/h4');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(artifactDir, 'H4_HOSTILE_STRESS.json'),
      `${JSON.stringify(
        {
          schema: 'adapt-h4-hostile-stress-v1',
          ...verificationMetadata(path.resolve(__dirname, '../..')),
          total: results.length,
          passed: results.filter((r) => r.pass).length,
          results,
        },
        null,
        2
      )}\n`
    );
    await browser?.close();
    await servers?.close();
  });

  async function scenario(
    id: string,
    run: (record: (obs: Record<string, unknown>) => void) => Promise<void>
  ): Promise<void> {
    const startedAt = Date.now();
    let observations: Record<string, unknown> = {};
    try {
      await run((obs) => {
        observations = { ...observations, ...obs };
      });
      results.push({ id, pass: true, durationMs: Date.now() - startedAt, observations });
    } catch (error) {
      results.push({
        id,
        pass: false,
        durationMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message : String(error),
        observations,
      });
      throw error;
    }
  }

  function watchPageErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    return errors;
  }

  /** Evaluate an expression in the extension service worker. Uses a raw CDP
   * session with an explicit detach: a puppeteer worker() handle left attached
   * across a Target.closeTarget permanently wedges the SW registration in this
   * Chrome build (restart target never executes). Attach→evaluate→detach is
   * the verified-safe pattern. */
  async function workerEvaluate<T>(browserInstance: Browser, expression: string): Promise<T | undefined> {
    const candidates = browserInstance
      .targets()
      .filter((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
    for (const candidate of candidates) {
      let session;
      try {
        session = await candidate.createCDPSession();
        // A zombie target accepts the session but never answers evaluates —
        // cap every round-trip so the probe loop can't wedge on it.
        const result = (await Promise.race([
          session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
          sleep(4_000).then(() => null),
        ])) as { result?: { value?: T }; exceptionDetails?: unknown } | null;
        // A dead/zombie candidate must not shadow a healthy one listed later.
        if (result && !result.exceptionDetails) return result.result?.value;
      } catch {
        /* try the next candidate */
      } finally {
        await session?.detach().catch(() => undefined);
      }
    }
    return undefined;
  }

  /** workerEvaluate single-shots can land mid-restart and return undefined;
   * retry until defined or the budget runs out. When repeated rounds go
   * unanswered the listed target is a ZOMBIE (accepts CDP sessions, never
   * executes) — polling it forever starves the test under chain load, so every
   * fourth failure loads a fresh page: its content-script registration queues a
   * real SW wake event and Chrome restarts the worker (the waitForLiveWorker
   * pattern). */
  async function workerEvaluateRetry<T>(browserInstance: Browser, expression: string, attempts = 6, gapMs = 700): Promise<T | undefined> {
    for (let i = 0; i < attempts; i++) {
      const value = await workerEvaluate<T>(browserInstance, expression);
      if (value !== undefined) return value;
      if (i > 0 && i % 4 === 3) {
        const wakePage = await browserInstance.newPage().catch(() => null);
        if (wakePage) {
          await wakePage.goto(`${app}/t16-adblock-article/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
          await wakePage.close().catch(() => undefined);
        }
      }
      await sleep(gapMs);
    }
    return undefined;
  }

  /** A listed SW target is not proof of life — a zombie can stay listed while
   * never executing. Only an answered evaluate() counts as alive. Every 10s
   * without a live worker, load a fresh page so its content-script messages
   * re-trigger the SW start (a page loaded mid-teardown can race the restart
   * and leave no queued wake event behind). */
  async function waitForLiveWorker(browserInstance: Browser, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let lastWake = Date.now();
    const wakePages: Page[] = [];
    try {
      while (Date.now() < deadline) {
        if (Date.now() - lastWake > 10_000) {
          lastWake = Date.now();
          const wakePage = await browserInstance.newPage().catch(() => null);
          if (wakePage) {
            wakePages.push(wakePage);
            await wakePage.goto(`${app}/t16-adblock-article/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
          }
        }
        const alive = await workerEvaluate<number>(browserInstance, '2');
        if (alive === 2) return true;
        await sleep(700);
      }
      return false;
    } finally {
      await Promise.all(wakePages.map((p) => p.close().catch(() => undefined)));
    }
  }

  async function killExtensionWorker(browserInstance: Browser, cdpSource: Page): Promise<void> {
    // Find the target WITHOUT attaching — attach-then-close wedges the SW.
    const target = browserInstance
      .targets()
      .find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
    if (!target) throw new Error('extension service worker target unavailable');
    const targetId = (target as unknown as { _targetId?: string })._targetId;
    if (!targetId) throw new Error('extension service worker target id is unavailable');
    const session = await cdpSource.target().createCDPSession();
    await session.send('Target.closeTarget', { targetId });
    await session.detach().catch(() => undefined);
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // -------------------------------------------------------------------------
  // 1. Hostile intrinsics freeze
  // -------------------------------------------------------------------------
  it('t36: hostile intrinsics freeze — pipeline unaffected, cosmetic plane intact', async () => {
    await scenario('t36-hostile-intrinsics', async () => {
      const page = await browser.newPage();
      const errors = watchPageErrors(page);
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(`${app}/t36-hostile-intrinsics/index.html`, { waitUntil: 'networkidle2' });

      expect(await page.evaluate(() => (window as any).__intrinsics_frozen)).toBe(true);
      // Static plane: the synthetic ad script stays blocked on frozen pages.
      expect(await page.evaluate(() => (window as any).__ad_loaded)).toBeUndefined();
      // Deterministic adaptation still removes the gate (isolated world is unfrozen).
      await page.waitForFunction(
        () => {
          const modal = document.getElementById('blocker-modal');
          return !modal || window.getComputedStyle(modal).display === 'none';
        },
        { timeout: 8_000 }
      );
      const articleIntact = await page.evaluate(() => {
        const body = document.getElementById('article-body');
        return body !== null && window.getComputedStyle(body).display !== 'none';
      });
      expect(articleIntact).toBe(true);
      expect(errors).toEqual([]);
      await page.close();
    });
  }, 30_000);

  // -------------------------------------------------------------------------
  // 2. Continuous sub-threshold mutation drip
  // -------------------------------------------------------------------------
  it('t37: sub-threshold mutation drip — main thread and drip stay healthy', async () => {
    await scenario('t37-mutation-drip', async (record) => {
      const page = await browser.newPage();
      const errors = watchPageErrors(page);
      await page.goto(`${app}/t37-mutation-drip/index.html`, { waitUntil: 'networkidle2' });

      await sleep(3500);
      const first = await page.evaluate(() => ({
        drips: (window as any).__drip_count,
        frames: (window as any).__raf_frames,
      }));
      await sleep(1500);
      const second = await page.evaluate(() => ({
        drips: (window as any).__drip_count,
        frames: (window as any).__raf_frames,
      }));

      // The drip itself runs at 2/s; rAF at display cadence. Both must advance
      // — a starving or thrashing content-script scheduler would stall frames.
      expect(second.drips).toBeGreaterThan(first.drips);
      expect(second.frames - first.frames).toBeGreaterThan(10);
      expect(errors).toEqual([]);
      record({ dripDelta: second.drips - first.drips, frameDelta: second.frames - first.frames });
      await page.close();
    });
  }, 30_000);

  // -------------------------------------------------------------------------
  // 3. Re-hide war endgame
  // -------------------------------------------------------------------------
  it('t41: re-hide war endgame — bounded fight, honest final state', async () => {
    await scenario('t41-rehide-war-endgame', async (record) => {
      const page = await browser.newPage();
      const errors = watchPageErrors(page);
      await page.setViewport({ width: 1280, height: 800 });
      // Isolated host (h4war.test): no inherited recipe/profile from other
      // scenarios — the war is fought by fresh staging only.
      await page.goto(`http://h4war.test:4070/t41-rehide-war/index.html`, { waitUntil: 'networkidle2' });

      // The fight engages: the fixture's monotonic re-show counter only moves
      // when it finds the wall suppressed. (It can out-run a hidden-window
      // poll, so the counter — not the gate state — is the engagement pin.)
      await page.waitForFunction(() => (window as any).__war_reshows >= 1, { timeout: 10_000 });

      // Let the war run well past the watch cap. An unbounded hot war would
      // rack up hundreds of re-shows; a bounded endgame freezes the counter.
      await sleep(22_000);
      const mid = await page.evaluate(() => (window as any).__war_reshows as number);
      await sleep(2_000);
      const late = await page.evaluate(() => ({
        reshows: (window as any).__war_reshows as number,
        wallVisible: (() => {
          const gate = document.getElementById('war-gate');
          return gate !== null && window.getComputedStyle(gate).display !== 'none';
        })(),
      }));

      expect(late.reshows).toBeLessThan(150);
      // Bounded endgame: the fight is over — the counter no longer moves.
      expect(late.reshows - mid).toBeLessThan(20);
      expect(errors).toEqual([]);
      // Main thread still healthy deep into the war.
      const framesA = await page.evaluate(() => (window as any).__raf_frames_war as number);
      await sleep(700);
      const framesB = await page.evaluate(() => (window as any).__raf_frames_war as number);
      expect(framesB).toBeGreaterThan(framesA);
      record({
        reshowsAt22s: mid,
        reshowsAt24s: late.reshows,
        wallVisibleAt24s: late.wallVisible,
        note: 'The wall standing at the end is the honest bounded-watch endgame (TTL/cap), not a failure.',
      });
      await page.close();
    });
  }, 60_000);

  // -------------------------------------------------------------------------
  // 4. Closed shadow root blindness (honesty pin)
  // -------------------------------------------------------------------------
  it('t38: closed shadow root — wall honestly stands, outer document untouched', async () => {
    await scenario('t38-closed-shadow', async (record) => {
      const page = await browser.newPage();
      const errors = watchPageErrors(page);
      await page.goto(`${app}/t38-closed-shadow/index.html`, { waitUntil: 'networkidle2' });
      await sleep(2500);

      const state = await page.evaluate(() => {
        const host = document.getElementById('gate-host');
        const article = document.getElementById('article-body');
        const openCopy = document.getElementById('open-host')?.shadowRoot?.getElementById('benign-shadow-copy');
        return {
          rootClosed: host !== null && host.shadowRoot === null,
          articleVisible: article !== null && window.getComputedStyle(article).display !== 'none',
          openShadowIntact: Boolean(openCopy),
        };
      });

      // Closed root: the sensor cannot see the wall, so nothing may break
      // outside it either. This is the documented blindness boundary.
      expect(state.rootClosed).toBe(true);
      expect(state.articleVisible).toBe(true);
      expect(state.openShadowIntact).toBe(true);
      expect(errors).toEqual([]);
      record({ knownLimit: 'closed shadow roots are opaque to the sensor — walls inside them stand' });
      await page.close();
    });
  }, 30_000);

  // -------------------------------------------------------------------------
  // 5. READY / hashchange flood
  // -------------------------------------------------------------------------
  it('t39: 200 hashchange flips — worker responsive, pipeline functional after flood', async () => {
    await scenario('t39-ready-flood', async (record) => {
      const page = await browser.newPage();
      const errors = watchPageErrors(page);
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(`${app}/t39-ready-flood/index.html`, { waitUntil: 'networkidle2' });

      await page.waitForFunction(() => (window as any).__flood_done === true, { timeout: 15_000 });

      // The worker must answer a storage ping promptly after the flood.
      const pingStart = Date.now();
      const pong = await workerEvaluate<boolean>(browser, 'chrome.storage.session.get(null).then(() => true)');
      const pingMs = Date.now() - pingStart;
      expect(pong).toBe(true);
      expect(pingMs).toBeLessThan(5_000);

      // The pipeline still functions: a gate spawned post-flood is handled.
      await page.evaluate(() => (window as any).__spawn_gate());
      await page.waitForFunction(
        () => {
          const gate = document.getElementById('blocker-modal');
          return !gate || gate.style.display === 'none' || window.getComputedStyle(gate).display === 'none';
        },
        { timeout: 8_000 }
      );
      expect(errors).toEqual([]);
      record({ workerPingMs: pingMs });
      await page.close();
    });
  }, 40_000);

  // -------------------------------------------------------------------------
  // 6. Synthetic click flood
  // -------------------------------------------------------------------------
  it('t40: 1000 synthetic clicks — page healthy, no navigation storm', async () => {
    await scenario('t40-click-flood', async (record) => {
      const page = await browser.newPage();
      const errors = watchPageErrors(page);
      await page.goto(`${app}/t40-click-flood/index.html`, { waitUntil: 'networkidle2' });

      await page.waitForFunction(() => (window as any).__click_flood_done === true, { timeout: 10_000 });
      // No navigation storm: still on the fixture page.
      expect(page.url()).toContain('/t40-click-flood/');
      const framesA = await page.evaluate(() => (window as any).__raf_frames_click as number);
      await sleep(700);
      const framesB = await page.evaluate(() => (window as any).__raf_frames_click as number);
      expect(framesB).toBeGreaterThan(framesA);
      // Stealth plane still alive and readable after the flood.
      expect(await page.evaluate(() => (window as any).adblock)).toBe(false);
      expect(errors).toEqual([]);
      record({ framesDelta: framesB - framesA });
      await page.close();
    });
  }, 30_000);

  // -------------------------------------------------------------------------
  // 7. bfcache restore semantics
  // -------------------------------------------------------------------------
  it('bfcache: restore after away-navigation — no crash, no duplicate side effects', async () => {
    await scenario('bfcache-restore', async (record) => {
      const page = await browser.newPage();
      const errors = watchPageErrors(page);
      await page.goto(`${app}/t27-bfcache-history/index.html`, { waitUntil: 'networkidle2' });
      const stylesBefore = await page.evaluate(() => document.querySelectorAll('style').length);

      await page.goto(`${app}/t01-basic-ad/index.html`, { waitUntil: 'networkidle2' });
      await page.goBack({ waitUntil: 'networkidle2' });
      await sleep(1200);

      const state = await page.evaluate(() => ({
        pageshows: (window as any).__pageshow_count as number,
        persisted: (window as any).__bfcache_persisted as boolean | undefined,
        styles: document.querySelectorAll('style').length,
        stealthFlag: (window as any).adblock,
      }));
      // NOTE: in this headless environment Chrome reports backForwardCacheNotUsed
      // reason=CacheFlushed — the restore is a FRESH load, not a bfcache hit.
      // Either path is pinned: a fresh restore gets pageshows===1 with a clean
      // single-observer document; a bfcache hit gets pageshows===2 with the
      // original document and no duplicate extension side effects.
      expect(state.pageshows).toBeGreaterThanOrEqual(1);
      expect(state.styles).toBe(stylesBefore);
      expect(state.stealthFlag).toBe(false);
      expect(errors).toEqual([]);
      record({
        persisted: state.persisted ?? 'not-persisted (fresh load)',
        harnessLimit: 'headless Chrome flushes bfcache here (CacheFlushed); the fresh-restore path is what is pinned',
      });
      await page.close();
    });
  }, 30_000);

  // -------------------------------------------------------------------------
  // 8. Stale-document apply
  // -------------------------------------------------------------------------
  it('stale-document: navigating away mid-adaptation never leaks into the new document', async () => {
    await scenario('stale-document-apply', async () => {
      const page = await browser.newPage();
      const errors = watchPageErrors(page);
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(`${app}/t05-fullscreen-overlay/index.html`, { waitUntil: 'domcontentloaded' });
      // The sensor is up and the first batch is in flight; kill the document
      // before the adaptation transaction can settle.
      await sleep(150);
      await page.goto(`${app}/t16-adblock-article/index.html`, { waitUntil: 'networkidle2' });
      await sleep(2500);

      const intact = await page.evaluate(() => {
        const author = document.getElementById('author-bio');
        const h1 = document.querySelector('h1');
        const anyHidden = Array.from(document.querySelectorAll('main, article, p, h1, h2')).some(
          (el) => window.getComputedStyle(el).display === 'none'
        );
        return {
          authorVisible: author !== null && window.getComputedStyle(author).display !== 'none',
          titlePresent: (h1?.textContent || '').includes('History of Ad Blocking'),
          anyHidden,
        };
      });
      expect(intact.authorVisible).toBe(true);
      expect(intact.titlePresent).toBe(true);
      expect(intact.anyHidden).toBe(false);
      expect(errors).toEqual([]);
      await page.close();
    });
  }, 30_000);

  // -------------------------------------------------------------------------
  // 9. Long-task starvation
  // -------------------------------------------------------------------------
  it('t43: 3s main-thread block — pipeline recovers and handles the gate', async () => {
    await scenario('t43-longtask-recovery', async (record) => {
      const page = await browser.newPage();
      const errors = watchPageErrors(page);
      await page.setViewport({ width: 1280, height: 800 });
      const t0 = Date.now();
      // Isolated host: the gate must be handled by fresh staging that recovers
      // after the 3s block, not by a pre-paint learned hide from another test.
      await page.goto(`http://h4long.test:4070/t43-longtask/index.html`, { waitUntil: 'networkidle2' });

      await page.waitForFunction(
        () => {
          const modal = document.getElementById('blocker-modal');
          return !modal || window.getComputedStyle(modal).display === 'none';
        },
        { timeout: 12_000 }
      );
      const handledMs = Date.now() - t0;
      // The 3s block delays everything; recovery must complete well under 12s.
      expect(handledMs).toBeGreaterThan(2_500);
      expect(errors).toEqual([]);
      record({ gateHandledMs: handledMs });
      await page.close();
    });
  }, 30_000);

  // -------------------------------------------------------------------------
  // 9b. t45 SPA pushState gate — post-route-change blindness regression pin
  // -------------------------------------------------------------------------
  it('t45: gate raised after history.pushState is still detected and resolved', async () => {
    await scenario('t45-spa-pushstate-gate', async (record) => {
      // history.pushState fires no popstate/hashchange, so the content sensor
      // keeps signing batches with the birth navigationId while the registry
      // mints a fresh epoch for the same documentId. captureContentEpoch must
      // re-resolve the sender to the live epoch, or every post-route-change
      // observation is rejected STALE_EPOCH and the pipeline goes blind.
      const gateState = () => {
        const panel = document.querySelector('.gate-t45') as HTMLElement | null;
        return {
          visible: panel !== null && window.getComputedStyle(panel).display !== 'none',
          bodyLocked: document.body.style.overflow === 'hidden',
        };
      };

      const direct = await browser.newPage();
      const directErrors = watchPageErrors(direct);
      await direct.setViewport({ width: 1280, height: 800 });
      // Isolated hosts per mode: no inherited recipes from other scenarios.
      await direct.goto(`http://h4spadirect.test:4070/t45-spa-gate/index.html?mode=direct`, { waitUntil: 'networkidle2' });
      // Manifestation is latched page-side (__t45_gate_visible): the extension
      // may resolve the gate faster than the first poll tick can observe the
      // visible window, so computed style cannot be the manifestation signal.
      await direct.waitForFunction(
        () => (window as any).__t45_gate_visible === true,
        { timeout: 5_000 }
      );
      await direct.waitForFunction(
        `(${gateState.toString()})().visible === false && (${gateState.toString()})().bodyLocked === false`,
        { timeout: 15_000 }
      );
      expect(directErrors).toEqual([]);
      await direct.close();

      const page = await browser.newPage();
      const errors = watchPageErrors(page);
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(`http://h4spa.test:4070/t45-spa-gate/index.html`, { waitUntil: 'networkidle2' });
      await page.click('#open-view');
      await page.waitForFunction(
        () => (window as any).__t45_gate_visible === true,
        { timeout: 5_000 }
      );
      const routed = await page.evaluate(() => ({
        routed: (window as any).__t45_routed === true,
        url: window.location.pathname,
      }));
      expect(routed.routed).toBe(true);
      expect(routed.url).toBe('/t45-spa-gate/content.html');

      // The load-bearing pin: after the pushState route change the gate must
      // be resolved exactly as in direct mode — hidden and scroll restored.
      await page.waitForFunction(
        `(${gateState.toString()})().visible === false && (${gateState.toString()})().bodyLocked === false`,
        { timeout: 15_000 }
      );
      expect(errors).toEqual([]);
      record({ mode: 'spa', resolved: true });
      await page.close();
    });
  }, 45_000);

  // -------------------------------------------------------------------------
  // 10a. Soak: 10k-node churn × 25 SPA navs
  // -------------------------------------------------------------------------
  it('soak: 25 SPA navigations on a 10k-node churn page keep heap bounded', async () => {
    await scenario('soak-spa-churn', async (record) => {
      const page = await browser.newPage();
      const errors = watchPageErrors(page);
      await page.goto(`${app}/t42-churn-soak/index.html`, { waitUntil: 'networkidle2' });
      const cdp = await page.createCDPSession();
      await cdp.send('HeapProfiler.enable');

      await sleep(1_000);
      await cdp.send('HeapProfiler.collectGarbage');
      const baseline = (await page.metrics()).JSHeapUsedSize ?? 0;
      const workerBaseline =
        (await workerEvaluate<number>(browser, 'performance.memory ? performance.memory.usedJSHeapSize : -1')) ?? -1;

      for (let i = 1; i <= 25; i++) {
        await page.evaluate((index) => (window as any).__spaNav(index), i);
        await sleep(200);
      }
      expect(await page.evaluate(() => (window as any).__soak_navs)).toBe(25);
      expect(await page.evaluate(() => document.querySelectorAll('.cell').length)).toBe(9900);

      await cdp.send('HeapProfiler.collectGarbage');
      const after = (await page.metrics()).JSHeapUsedSize ?? 0;
      const workerAfter =
        (await workerEvaluate<number>(browser, 'performance.memory ? performance.memory.usedJSHeapSize : -1').catch(() => -1)) ?? -1;

      const pageDelta = after - baseline;
      const workerDelta = workerBaseline >= 0 && workerAfter >= 0 ? workerAfter - workerBaseline : -1;
      expect(pageDelta).toBeLessThan(64 * 1024 * 1024);
      if (workerDelta >= 0) expect(workerDelta).toBeLessThan(64 * 1024 * 1024);
      expect(errors).toEqual([]);
      record({ pageHeapDeltaMB: +(pageDelta / 1048576).toFixed(1), workerHeapDeltaMB: workerDelta >= 0 ? +(workerDelta / 1048576).toFixed(1) : 'unavailable' });
      await page.close();
    });
  }, 60_000);

  // -------------------------------------------------------------------------
  // 10b. 50-tab mixed flood
  // -------------------------------------------------------------------------
  it('flood: 50 concurrent tabs across mixed fixtures — worker survives, tabs isolated', async () => {
    await scenario('flood-50-tabs', async (record) => {
      const fixtures = [
        't01-basic-ad',
        't05-fullscreen-overlay',
        't15-mutation-storm',
        't16-adblock-article',
        't26-adversarial-dom-reinsertion',
        't31-runtime-dom-churn',
        't37-mutation-drip',
        't40-click-flood',
      ];
      const tabs: Page[] = [];
      try {
        for (let i = 0; i < 50; i++) {
          const tab = await browser.newPage();
          tabs.push(tab);
          await tab.goto(`${app}/${fixtures[i % fixtures.length]}/index.html`, { waitUntil: 'domcontentloaded' });
        }
        await sleep(2_000);

        // Sampled tabs remain responsive and isolated.
        for (const index of [0, 17, 33, 49]) {
          const alive = await tabs[index]!.evaluate(() => 1 + 1);
          expect(alive).toBe(2);
        }
        // First tab (t01): static plane blocked the ad in exactly this tab.
        expect(await tabs[0]!.evaluate(() => (window as any).__ad_loaded)).toBeUndefined();
        // Worker still answers.
        const floodPong = await workerEvaluate<boolean>(browser, 'chrome.storage.session.get(null).then(() => true)');
        expect(floodPong).toBe(true);
        record({ tabs: tabs.length });
      } finally {
        await Promise.all(tabs.map((tab) => tab.close().catch(() => undefined)));
      }
    });
  }, 150_000);

  // -------------------------------------------------------------------------
  // 11. Worker-kill storm
  // -------------------------------------------------------------------------
  it('worker-kill storm: repeated SW termination during staging — zero orphan rules, full recovery', async () => {
    await scenario('worker-kill-storm', async (record) => {
      // One kill per browser session, three independent sessions. Rapidly
      // stacking closeTarget kills in one session can leave Chrome-for-Testing
      // holding a non-executing zombie SW target (a harness artifact this
      // environment never recovers from); a single kill per session is the
      // proven-reliable pattern, and each session independently pins
      // kill-during-staging → reconcile → zero orphans → full recovery.
      for (let cycle = 0; cycle < 3; cycle++) {
        const sessionBrowser = await launchBrowser();
        try {
          const anchorPage = await sessionBrowser.newPage();
          await anchorPage.goto(`${app}/t16-adblock-article/index.html`, { waitUntil: 'domcontentloaded' });

          const live = await waitForLiveWorker(sessionBrowser, 45_000);
          expect(live, `worker alive before kill cycle ${cycle}`).toBe(true);
          // Capture the extension id while the worker is provably alive: the
          // session-rule poll below reads via an extension page so it does not
          // depend on MV3 worker liveness (an idle-killed worker answers no
          // evaluates, and static recovery pages emit nothing to restart it).
          const extensionUrl = sessionBrowser.targets().find((t) => t.url().startsWith('chrome-extension://'))?.url() ?? '';
          let extensionId = '';
          try { extensionId = extensionUrl ? new URL(extensionUrl).host : ''; } catch { extensionId = ''; }

          const page = await sessionBrowser.newPage();
          await page.goto(`${app}/t05-fullscreen-overlay/index.html`, { waitUntil: 'domcontentloaded' });
          await sleep(400); // mid-staging window
          await killExtensionWorker(sessionBrowser, anchorPage);
          await page.close().catch(() => undefined);

          // Recovery: a fresh benign page wakes the worker; reconcile settles.
          const recovery = await sessionBrowser.newPage();
          const errors = watchPageErrors(recovery);
          await recovery.goto(`${app}/t16-adblock-article/index.html`, { waitUntil: 'networkidle2' });

          const liveAfter = await waitForLiveWorker(sessionBrowser, 45_000);
          expect(liveAfter, `worker recovered after kill cycle ${cycle}`).toBe(true);
          await sleep(3_000);

          let sessionRuleCount = -1;
          const ruleDeadline = Date.now() + 20_000;
          let diag: Page | undefined;
          if (extensionId) {
            diag = await sessionBrowser.newPage();
            await diag.goto(`chrome-extension://${extensionId}/options/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
          }
          try {
            while (Date.now() < ruleDeadline) {
              // Session rules are profile-scoped: reading them from an extension
              // page measures the same store the worker reconciles, without
              // needing the worker to be awake.
              const count = diag
                ? await diag.evaluate(() => chrome.declarativeNetRequest.getSessionRules().then((rules) => rules.length)).catch(() => undefined)
                : await workerEvaluate<number>(
                    sessionBrowser,
                    'chrome.declarativeNetRequest.getSessionRules().then((rules) => rules.length)'
                  );
              if (count !== undefined) sessionRuleCount = count;
              if (sessionRuleCount === 0) break;
              await sleep(1_000);
            }
          } finally {
            await diag?.close().catch(() => undefined);
          }
          expect(sessionRuleCount).toBe(0);

          // Functional recovery: static plane still blocks.
          const adCheck = await sessionBrowser.newPage();
          await adCheck.goto(`${app}/t01-basic-ad/index.html`, { waitUntil: 'networkidle2' });
          expect(await adCheck.evaluate(() => (window as any).__ad_loaded)).toBeUndefined();
          await adCheck.close();
          expect(errors).toEqual([]);
          await recovery.close();
          await anchorPage.close();
        } finally {
          await sessionBrowser.close().catch(() => undefined);
        }
      }
      record({ killCycles: 3, sessionRulesAfterEachCycle: 0 });
    });
  }, 240_000);

  // -------------------------------------------------------------------------
  // 12. Corrupted / quota-exhausted storage boot
  // -------------------------------------------------------------------------
  it('corrupted storage boot: poisoned payloads + near-quota session — boots, static plane holds, clean boot recovers', async () => {
    await scenario('corrupted-storage-boot', async () => {
      // Dedicated browser session: storage is per-profile, so the poison and
      // both restarts must share one browser — and it must not inherit the
      // main session's kill history.
      const sessionBrowser = await launchBrowser();
      try {
        const anchor = await sessionBrowser.newPage();
        await anchor.goto(`${app}/t16-adblock-article/index.html`, { waitUntil: 'domcontentloaded' });

        const aliveBefore = await waitForLiveWorker(sessionBrowser, 45_000);
        expect(aliveBefore, 'worker alive before poisoning').toBe(true);
        // Capture the extension id while a worker target exists — the stall
        // dump below reads storage.session via the options page, which works
        // even when the service worker itself is dead or wedged.
        const extensionId = (() => {
          const target = sessionBrowser.targets().find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
          try { return target ? new URL(target.url()).host : ''; } catch { return ''; }
        })();
        const poisoned = await workerEvaluateRetry<boolean>(
          sessionBrowser,
          `(async () => {
            await chrome.storage.session.set({
              adapt_dnr_ownership_session_v1: 'POISON-STRING',
              adapt_causal_session_state_v1: 12345,
            });
            await chrome.storage.local.set({ adapt_dnr_dynamic_v1: [1, 2, 3] });
            return true;
          })()`,
          // Under full-chain load Chrome defers SW re-start well past the
          // default 4.2s retry budget — the worker was just proven alive, so
          // an unanswered evaluate is availability lag, not product failure.
          // Observed on a machine at load-average 26: >84s of SW unavailability.
          40
        );
        expect(poisoned).toBe(true);
        // Near-quota session fill (10MB quota) in 2MB chunks — written ONE
        // CHUNK PER EVALUATE. A single 8MB poison evaluate exceeds the 4s
        // zombie-cap under chain load: every attempt timed out mid-write and
        // the retry re-ran it, so the test starved itself. Small writes fit
        // the cap; the fill stays best-effort (quota reached is the point).
        for (let i = 0; i < 4; i++) {
          await workerEvaluateRetry<boolean>(
            sessionBrowser,
            `(async () => {
              try {
                await chrome.storage.session.set({ h4_filler_${i}: 'x'.repeat(2 * 1024 * 1024) });
              } catch {
                /* quota reached — that is the point */
              }
              return true;
            })()`,
            6
          );
        }

        await killExtensionWorker(sessionBrowser, anchor);

        // Boot against poisoned, near-quota storage: static plane must hold.
        const probe = await sessionBrowser.newPage();
        const errors = watchPageErrors(probe);
        await probe.goto(`${app}/t01-basic-ad/index.html`, { waitUntil: 'networkidle2' });
        await sleep(2_000);
        expect(await probe.evaluate(() => (window as any).__ad_loaded)).toBeUndefined();
        expect(errors).toEqual([]);
        await probe.close();

        // Clean boot recovery: wipe the poison, restart, full function returns.
        const cleanAlive = await waitForLiveWorker(sessionBrowser, 45_000);
        expect(cleanAlive, 'worker alive after poisoned boot').toBe(true);
        const cleaned = await workerEvaluateRetry<boolean>(
          sessionBrowser,
          `(async () => {
            await chrome.storage.session.clear();
            await chrome.storage.local.remove(['adapt_dnr_dynamic_v1']);
            return true;
          })()`,
          20
        );
        expect(cleaned).toBe(true);
        await killExtensionWorker(sessionBrowser, anchor);

        const recovered = await sessionBrowser.newPage();
        const recoveredErrors = watchPageErrors(recovered);
        await recovered.setViewport({ width: 1280, height: 800 });
        await recovered.goto(`${app}/t05-fullscreen-overlay/index.html`, { waitUntil: 'networkidle2' });
        try {
          await recovered.waitForFunction(
            () => {
              const modal = document.getElementById('blocker-modal');
              return !modal || window.getComputedStyle(modal).display === 'none';
            },
            { timeout: 12_000 }
          );
        } catch (stall) {
          // Stall forensics via the options page: storage.session is readable
          // from any extension page even when the SW is dead, so this dump
          // cannot go blind at exactly the moment it is needed.
          let stallState: unknown;
          let swTargetPresent = false;
          try {
            swTargetPresent = sessionBrowser.targets().some((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
            const diag = await sessionBrowser.newPage();
            await diag.goto(`chrome-extension://${extensionId}/options/index.html`, { waitUntil: 'domcontentloaded' });
            stallState = await diag.evaluate(async () => {
              const s = await chrome.storage.session.get(null);
              const causal = s.adapt_causal_session_state_v1 as { graphs?: unknown[] } | undefined;
              const f = s.adapt_kimi_forensics_v1 as
                | { counters?: Record<string, number>; events?: Array<{ kind?: string }> }
                | undefined;
              return {
                causalGraphCount: causal && causal.graphs ? causal.graphs.length : -1,
                forensicsCounters: f && f.counters ? f.counters : 'none',
                eventKinds: f && f.events ? f.events.map((e) => e.kind).join(',') : 'none',
                epochEvents: f && f.events
                  ? JSON.stringify(
                      f.events.filter((e) =>
                        ['EPOCH_CREATED_FROM_CONTENT', 'NAV_COMMIT_SEEN', 'NAV_COMMIT_REPLACED_EPOCH', 'ENGINE_DROP_STALE_NAV', 'DEAD_DOCUMENT_MESSAGE_DROPPED', 'SURVIVORS_OBSERVED'].includes(String(e.kind))
                      )
                    ).slice(0, 2400)
                  : 'none',
              };
            });
            await diag.close();
          } catch (diagError) {
            stallState = `diag failed: ${diagError instanceof Error ? diagError.message : String(diagError)}`;
          }
          throw Object.assign(stall instanceof Error ? stall : new Error(String(stall)), {
            message: `${stall instanceof Error ? stall.message : stall} | swTargetPresent=${swTargetPresent} stallState=${JSON.stringify(stallState)?.slice(0, 2400)}`,
          });
        }
        expect(recoveredErrors).toEqual([]);
        await recovered.close();
        await anchor.close();
      } finally {
        await sessionBrowser.close().catch(() => undefined);
      }
    });
  }, 150_000);

  it('reports every scenario', () => {
    expect(results.filter((r) => r.pass)).toHaveLength(results.length);
      expect(results.map((r) => r.id).sort()).toEqual(
      [
        'bfcache-restore',
        'corrupted-storage-boot',
        'flood-50-tabs',
        'soak-spa-churn',
        'stale-document-apply',
        't36-hostile-intrinsics',
        't37-mutation-drip',
        't38-closed-shadow',
        't39-ready-flood',
        't40-click-flood',
        't41-rehide-war-endgame',
        't43-longtask-recovery',
        't45-spa-pushstate-gate',
        'worker-kill-storm',
      ].sort()
    );
  });
});
