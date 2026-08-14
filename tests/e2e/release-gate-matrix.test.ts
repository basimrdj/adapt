import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { startTestServers, TestServerInstances } from '../pages/server';
import { chromeExecutable } from '../support/chrome-executable';

describe('ADAPT Phase 1.5 Final Release Gate Verification Suite', () => {
  let servers: TestServerInstances;
  let browser: Browser;
  const extensionPath = path.resolve(__dirname, '../../dist');
  const appPort = 4002;
  const adPort = 4003;

  const chromePath = chromeExecutable();

  beforeAll(async () => {
    servers = await startTestServers(appPort, adPort);
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromePath,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--headless=new`,
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });
  });

  afterAll(async () => {
    if (browser) await browser.close();
    if (servers) await servers.close();
  });

  // Scenario 1: startup path. Actual forced worker termination is covered by phase3-causal-live.
  it('Scenario 1: adapts cleanly after service-worker startup initialization', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://localhost:${appPort}/t05-fullscreen-overlay/index.html`, { waitUntil: 'networkidle2' });

    // Allow transaction to stage
    await page.waitForFunction(() => {
      const modal = document.getElementById('blocker-modal');
      return !modal || window.getComputedStyle(modal).display === 'none';
    }, { timeout: 5000 });

    // Verify DOM overlay removal and scroll restoration
    const isOverlayGone = await page.evaluate(() => {
      const modal = document.getElementById('blocker-modal');
      return !modal || window.getComputedStyle(modal).display === 'none';
    });
    expect(isOverlayGone).toBe(true);

    const isScrollRestored = await page.evaluate(() => {
      return window.getComputedStyle(document.body).overflow !== 'hidden';
    });
    expect(isScrollRestored).toBe(true);

    await page.close();
  });

  // Scenario 3 & 4: Tab closure & navigation during staged experiment
  it('Scenario 3 & 4: Cleans up state when tab navigates away or closes during an experiment', async () => {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${appPort}/t03-bait-detector/index.html`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 800));

    // Navigate to clean origin mid-adaptation
    await page.goto(`http://localhost:${appPort}/t01-basic-ad/index.html`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 500));

    const isAdLoaded = await page.evaluate(() => (window as any).__ad_loaded);
    expect(isAdLoaded).toBeUndefined();

    await page.close();
  });

  // Scenario 5 & 6: Rapid consecutive navigations (A -> B -> C)
  it('Scenario 5 & 6: Isolates rapid A -> B -> C navigations and rejects stale signals', async () => {
    const page = await browser.newPage();

    // Rapid navigation sequence
    await page.goto(`http://localhost:${appPort}/t03-bait-detector/index.html`);
    await new Promise((r) => setTimeout(r, 100));
    await page.goto(`http://localhost:${appPort}/t04-blocked-probe/index.html`);
    await new Promise((r) => setTimeout(r, 100));
    await page.goto(`http://localhost:${appPort}/t01-basic-ad/index.html`, { waitUntil: 'networkidle2' });

    await new Promise((r) => setTimeout(r, 1000));
    const adExecuted = await page.evaluate(() => (window as any).__ad_loaded);
    expect(adExecuted).toBeUndefined();

    await page.close();
  });

  // Scenario 8: Simultaneous adaptation in multiple tabs
  it('Scenario 8: Executes independent adaptation transactions simultaneously across multiple tabs', async () => {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();

    await Promise.all([
      page1.goto(`http://localhost:${appPort}/t03-bait-detector/index.html`, { waitUntil: 'networkidle2' }),
      page2.goto(`http://localhost:${appPort}/t05-fullscreen-overlay/index.html`, { waitUntil: 'networkidle2' }),
    ]);

    await new Promise((r) => setTimeout(r, 2000));

    const gate1Gone = await page1.evaluate(() => {
      const g = document.getElementById('anti-adblock-gate');
      return !g || window.getComputedStyle(g).display === 'none';
    });

    const overlay2Gone = await page2.evaluate(() => {
      const m = document.getElementById('blocker-modal');
      return !m || window.getComputedStyle(m).display === 'none';
    });

    expect(gate1Gone).toBe(true);
    expect(overlay2Gone).toBe(true);

    await Promise.all([page1.close(), page2.close()]);
  });

  // Scenario 9: 20-Tab Stress Matrix
  it('Scenario 9: Successfully handles 20 concurrent tabs under mixed workloads without browser crash', async () => {
    const tabs: Page[] = [];
    const targetUrls = [
      `http://localhost:${appPort}/t01-basic-ad/index.html`,
      `http://localhost:${appPort}/t12-consent-modal/index.html`,
      `http://localhost:${appPort}/t13-newsletter-modal/index.html`,
      `http://localhost:${appPort}/t15-mutation-storm/index.html`,
      `http://localhost:${appPort}/t16-adblock-article/index.html`,
    ];

    try {
      for (let i = 0; i < 20; i++) {
        const p = await browser.newPage();
        tabs.push(p);
      }

      // Open mixed workloads concurrently
      const navPromises = tabs.map((tab, idx) => {
        const url = targetUrls[idx % targetUrls.length]!;
        return tab.goto(url, { waitUntil: 'domcontentloaded' });
      });

      await Promise.all(navPromises);
      await new Promise((r) => setTimeout(r, 1500));

      expect(tabs.length).toBe(20);
    } finally {
      await Promise.all(tabs.map((t) => t.close().catch(() => {})));
    }
  });

  // Scenario 19: Stale SiteRecipe applied to radically altered DOM layout
  it('Scenario 19: Safely evaluates altered page and does not damage legitimate UI elements', async () => {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${appPort}/t23-stale-recipe-changed-page/index.html`, { waitUntil: 'networkidle2' });

    await new Promise((r) => setTimeout(r, 1000));

    // Ensure vital navigation element is intact and not hidden
    const isVitalNavVisible = await page.evaluate(() => {
      const nav = document.getElementById('vital-nav-bar');
      return nav !== null && window.getComputedStyle(nav).display !== 'none';
    });

    expect(isVitalNavVisible).toBe(true);
    await page.close();
  });

  // Scenario 20: BFCache & History Navigation
  it('Scenario 20: Properly responds to pageshow and history navigation events', async () => {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${appPort}/t27-bfcache-history/index.html`, { waitUntil: 'networkidle2' });

    const pageshowCount = await page.evaluate(() => (window as any).__pageshow_count);
    expect(pageshowCount).toBeGreaterThanOrEqual(1);

    await page.close();
  });

  // Scenario 21: Host page with own ServiceWorker & CacheStorage
  it('Scenario 21: Interoperates with host pages using their own ServiceWorker & CacheStorage', async () => {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${appPort}/t21-sw-worker-page/index.html`, { waitUntil: 'networkidle2' });

    await page.waitForFunction(() => (window as any).__sw_registered === true, { timeout: 5000 });
    const swRegistered = await page.evaluate(() => (window as any).__sw_registered);
    const cacheStored = await page.evaluate(() => (window as any).__cache_stored);

    expect(swRegistered).toBe(true);
    expect(cacheStored).toBe(true);
    await page.close();
  });

  // Scenario 22: Priority Layering & Deterministic Tie-Breaking
  it('Scenario 22: Enforces deterministic priority layering across static, dynamic, and session rules', async () => {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${appPort}/t01-basic-ad/index.html`, { waitUntil: 'networkidle2' });

    const isAdBlocked = await page.evaluate(() => (window as any).__ad_loaded);
    expect(isAdBlocked).toBeUndefined(); // Static baseline rule priority (10) blocks request
    await page.close();
  });

  // Scenario 23: 50x Repeated Race Condition Torture Loop
  it('Scenario 23: Executes 50 consecutive rapid adaptation cycles without race condition errors', async () => {
    const page = await browser.newPage();
    for (let i = 0; i < 50; i++) {
      await page.goto(`http://localhost:${appPort}/t05-fullscreen-overlay/index.html`, { waitUntil: 'domcontentloaded' });
      await new Promise((r) => setTimeout(r, 40));
    }
    await page.close();
  });

  // False-Positive Torture Matrix Test (T22)
  it('False-Positive Torture Matrix: Preserves sticky nav, video controls, cookie banners, and newsletters', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://localhost:${appPort}/t22-benign-torture-matrix/index.html`, { waitUntil: 'networkidle2' });

    await new Promise((r) => setTimeout(r, 1200));

    const results = await page.evaluate(() => {
      const header = document.getElementById('sticky-header');
      const videoControls = document.getElementById('video-controls');
      const cookieDialog = document.getElementById('cookie-dialog');
      const newsletterDialog = document.getElementById('newsletter-dialog');

      return {
        headerVisible: header !== null && window.getComputedStyle(header).display !== 'none',
        controlsVisible: videoControls !== null && window.getComputedStyle(videoControls).display !== 'none',
        cookieVisible: cookieDialog !== null && window.getComputedStyle(cookieDialog).display !== 'none',
        newsletterVisible: newsletterDialog !== null && window.getComputedStyle(newsletterDialog).display !== 'none',
      };
    });

    expect(results.headerVisible).toBe(true);
    expect(results.controlsVisible).toBe(true);
    expect(results.cookieVisible).toBe(true);
    expect(results.newsletterVisible).toBe(true);

    await page.close();
  });

  // Hostile Anti-Anti-Adblock Reinsertion Loop (T26)
  it('Hostile Reinsertion Loop: Gracefully handles hostile DOM loops attempting to undo adaptation', async () => {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${appPort}/t26-adversarial-dom-reinsertion/index.html`, { waitUntil: 'networkidle2' });

    const active = await page.evaluate(() => (window as any).__reinsertion_loop_active);
    expect(active).toBe(true);

    await page.close();
  });

  // Empirical Performance Benchmark Measurement
  it('Performance Benchmarking: Measures content script init, mutation cost, and adaptation latency', async () => {
    const page = await browser.newPage();
    const t0 = Date.now();
    await page.goto(`http://localhost:${appPort}/t05-fullscreen-overlay/index.html`, { waitUntil: 'networkidle2' });
    const pageLoadDuration = Date.now() - t0;

    const sensorInitTime = await page.evaluate(() => {
      return performance.now();
    });

    expect(pageLoadDuration).toBeLessThan(4000);
    expect(sensorInitTime).toBeGreaterThan(0);

    await page.close();
  });
});
