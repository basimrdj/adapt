import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer, { Browser, Page } from 'puppeteer';
import corpus from '../fixtures/phase31b/adversarial-corpus.json';
import { parseFilterLists } from '../../src/page/filtering/compiler';
import { exceptionMatches, matchesDomain, scriptletExceptionMatches } from '../../src/page/filtering/matching';
import { runMainScriptlet } from '../../src/shared/main-scriptlet';
import { startTestServers, TestServerInstances } from '../pages/server';

type ScenarioClass = 'BLOCKING_PASS' | 'NEGATIVE_CONTROL_PASS' | 'LIFECYCLE_PASS' | 'PRESENCE_ONLY';

interface ScenarioResult {
  id: string;
  pass: boolean;
  resultClass: ScenarioClass;
  durationMs: number;
  detail?: string;
}

function chromeExecutable(): string {
  const envPath = process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const chromeDir = path.resolve(__dirname, '../../chrome');
  if (fs.existsSync(chromeDir)) {
    for (const sub of fs.readdirSync(chromeDir)) {
      const candidate = path.join(chromeDir, sub, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

async function settle(page: Page, ms = 350): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await page.evaluate(() => document.readyState);
}

const source = (text: string) => [{ id: 31, text }];

describe('Phase 3.1B deterministic adversarial corpus', () => {
  let browser: Browser;
  let servers: TestServerInstances;
  const results: ScenarioResult[] = [];
  const extensionPath = path.resolve(__dirname, '../../dist');

  beforeAll(async () => {
    servers = await startTestServers(4060, 4061);
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromeExecutable(),
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--headless=new', '--host-resolver-rules=MAP 1bit.space 127.0.0.1,MAP *.1bit.space 127.0.0.1,MAP kasilyrics.co.za 127.0.0.1,MAP *.kasilyrics.co.za 127.0.0.1,MAP marriedgames.com.br 127.0.0.1,MAP *.marriedgames.com.br 127.0.0.1', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox'],
    });
  });

  afterAll(async () => {
    const artifactDir = path.resolve(__dirname, '../../artifacts/phase31b');
    mkdirSync(artifactDir, { recursive: true });
    const passed = results.filter((result) => result.pass).length;
    const classCounts = results.reduce<Record<string, number>>((counts, result) => {
      counts[result.resultClass] = (counts[result.resultClass] || 0) + 1;
      return counts;
    }, {});
    writeFileSync(path.join(artifactDir, 'adversarial-results.json'), `${JSON.stringify({ schema: 'adapt-phase31b-adversarial-v3', total: corpus.length, passed, failed: corpus.length - passed, classCounts, results }, null, 2)}\n`);
    await browser?.close();
    await servers?.close();
  });

  function defaultClass(id: string): ScenarioClass {
    const entry = corpus.find((candidate) => candidate.id === id);
    if (entry?.negativeControl) return 'NEGATIVE_CONTROL_PASS';
    if (['spa-route-change', 'body-replacement', 'worker-restart'].includes(id)) return 'LIFECYCLE_PASS';
    return 'BLOCKING_PASS';
  }

  async function scenario(id: string, run: () => Promise<void> | void, resultClass = defaultClass(id)): Promise<void> {
    const startedAt = Date.now();
    try {
      await run();
      results.push({ id, pass: true, resultClass, durationMs: Date.now() - startedAt });
    } catch (error) {
      results.push({ id, pass: false, resultClass, durationMs: Date.now() - startedAt, detail: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  it('network ad request', async () => scenario('network-ad-request', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t01-basic-ad/index.html', { waitUntil: 'networkidle2' });
    expect(await page.evaluate(() => (window as unknown as { __ad_loaded?: boolean }).__ad_loaded)).toBeUndefined();
    await page.close();
  }));

  it('early MAIN-world race', async () => {
    const page = await browser.newPage();
    await page.goto('http://marriedgames.com.br:4060/t34-early-race/index.html', { waitUntil: 'domcontentloaded' });
    const evidence = await page.evaluate(() => ({
      observed: (window as unknown as { __early_observed?: boolean }).__early_observed,
      observedAt: (window as unknown as { __early_observed_at?: number }).__early_observed_at,
    }));
    console.log('EARLY_RACE_EVIDENCE', JSON.stringify({ fixture: 'main-world', ...evidence }));
    expect(evidence.observed).toBe(true);
    expect(evidence.observedAt).toEqual(expect.any(Number));
    await page.close();
  });

  it('early abort-current-inline-script race', async () => {
    const page = await browser.newPage();
    await page.goto('http://kasilyrics.co.za:4060/t34-early-race/index.html', { waitUntil: 'domcontentloaded' });
    const evidence = await page.evaluate(() => ({
      caught: (window as unknown as { __inline_abort_caught?: boolean }).__inline_abort_caught,
      caughtAt: (window as unknown as { __inline_abort_caught_at?: number }).__inline_abort_caught_at,
    }));
    console.log('EARLY_RACE_EVIDENCE', JSON.stringify({ fixture: 'abort-current-inline-script', ...evidence }));
    expect(evidence.caught).toBe(true);
    expect(evidence.caughtAt).toEqual(expect.any(Number));
    await page.close();
  });

  it('early abort-on-property-read race', async () => {
    const page = await browser.newPage();
    await page.goto('http://marriedgames.com.br:4060/t34-early-race/index.html', { waitUntil: 'domcontentloaded' });
    const evidence = await page.evaluate(() => ({
      caught: (window as unknown as { __property_abort_caught?: boolean }).__property_abort_caught,
      caughtAt: (window as unknown as { __property_abort_caught_at?: number }).__property_abort_caught_at,
    }));
    console.log('EARLY_RACE_EVIDENCE', JSON.stringify({ fixture: 'abort-on-property-read', ...evidence }));
    expect(evidence.caught).toBe(true);
    expect(evidence.caughtAt).toEqual(expect.any(Number));
    await page.close();
  });

  it('generic cosmetic', async () => scenario('generic-cosmetic-ad', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t32-phase31b-lab/index.html', { waitUntil: 'networkidle2' });
    await settle(page);
    expect(await page.$eval('.ad-slot-wrapper', (element) => getComputedStyle(element).display)).toBe('none');
    await page.close();
  }));

  it('domain cosmetic', async () => scenario('domain-specific-cosmetic', () => {
    const bundle = parseFilterLists(source('example.com##.domain-ad'));
    expect(bundle.domainRules).toHaveLength(1);
    expect(matchesDomain('www.example.com', bundle.domainRules[0]?.domains || [], [])).toBe(true);
  }));

  it('cosmetic exception', async () => scenario('cosmetic-exception', () => {
    const bundle = parseFilterLists(source(['example.com##.domain-ad', 'example.com#@#.domain-ad'].join('\n')));
    expect(exceptionMatches('example.com', '.domain-ad', bundle.exceptions)).toBe(true);
  }));

  it('specific-generic', async () => scenario('specific-generic-rule', () => {
    const bundle = parseFilterLists(source('#@#.generic-ad\nexample.com##.generic-ad'));
    expect(bundle.genericRules).toHaveLength(0);
    expect(bundle.domainRules[0]?.selector).toBe('.generic-ad');
    expect(exceptionMatches('example.com', '.generic-ad', bundle.exceptions)).toBe(true);
  }));

  it('extended CSS', async () => scenario('extended-css-target', () => {
    const bundle = parseFilterLists(source('example.com#?#.card:has-text(Advertisement)'));
    expect(bundle.domainRules[0]).toMatchObject({ kind: 'has-text', selector: '.card', argument: 'Advertisement' });
  }));

  it('procedural has-text', async () => scenario('procedural-has-text', () => {
    const bundle = parseFilterLists(source('example.com##.card:has-text(Sponsored)'));
    expect(bundle.domainRules[0]?.kind).toBe('has-text');
    expect(bundle.domainRules[0]?.argument).toBe('Sponsored');
  }));

  it('scriptlet target', async () => scenario('scriptlet-target', () => {
    const bundle = parseFilterLists(source("example.com#%#//scriptlet('set-constant', 'adblockDetected', 'false')"));
    expect(bundle.scriptlets[0]).toMatchObject({ supported: true, world: 'MAIN', lifecycle: 'PERSISTENT_MAIN_WORLD' });
  }));

  it('scriptlet exception', async () => scenario('scriptlet-exception', () => {
    const bundle = parseFilterLists(source(["example.com#%#//scriptlet('set-constant', 'adblockDetected', 'false')", "example.com#@%#//scriptlet('set-constant', 'adblockDetected', 'false')"].join('\n')));
    expect(scriptletExceptionMatches('example.com', 'set-constant', ['adblockDetected', 'false'], bundle.exceptions)).toBe(true);
  }));

  it('MAIN-world detector', async () => scenario('main-world-detector', () => {
    const key = '__phase31b_main_world_detector__';
    expect(runMainScriptlet('set-constant', [key, 'false'])).toBe(true);
    expect((globalThis as Record<string, unknown>)[key]).toBe(false);
    delete (globalThis as Record<string, unknown>)[key];
  }));

  it('offsetHeight bait', async () => scenario('offset-height-bait', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t03-bait-detector/index.html', { waitUntil: 'networkidle2' });
    await settle(page, 700);
    const result = await page.$eval('#ad-container', (element) => ({ height: element.getBoundingClientRect().height, gate: Boolean(document.querySelector('#anti-adblock-gate')) }));
    expect(result.height).toBeGreaterThan(0);
    expect(result.gate).toBe(false);
    await page.close();
  }));

  it('getBoundingClientRect bait', async () => scenario('bounding-rect-bait', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t03-bait-detector/index.html', { waitUntil: 'networkidle2' });
    await settle(page, 700);
    expect(await page.$eval('#ad-container', (element) => element.getBoundingClientRect().width)).toBeGreaterThan(0);
    await page.close();
  }));

  it('getComputedStyle bait', async () => scenario('computed-style-bait', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t03-bait-detector/index.html', { waitUntil: 'networkidle2' });
    await settle(page, 700);
    expect(await page.$eval('#ad-container', (element) => getComputedStyle(element).display)).not.toBe('none');
    await page.close();
  }));

  it('removal detector', async () => scenario('element-removal-detector', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t26-adversarial-dom-reinsertion/index.html', { waitUntil: 'networkidle2' });
    await settle(page);
    expect(await page.$eval('#content', (element) => element.textContent)).toContain('Hostile Page Content');
    await page.close();
  }));

  it('bait reinsertion', async () => scenario('bait-reinsertion', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t26-adversarial-dom-reinsertion/index.html', { waitUntil: 'networkidle2' });
    await settle(page, 700);
    expect(await page.evaluate(() => (window as unknown as { __reinsertion_loop_active?: boolean }).__reinsertion_loop_active)).toBe(true);
    await page.close();
  }));

  it('timer detection', async () => scenario('timer-detection', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t03-bait-detector/index.html', { waitUntil: 'networkidle2' });
    await settle(page, 700);
    expect(await page.evaluate(() => Boolean(document.querySelector('#anti-adblock-gate')))).toBe(false);
    await page.close();
  }));

  it('scroll lock', async () => scenario('scroll-lock-gate', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t05-fullscreen-overlay/index.html', { waitUntil: 'networkidle2' });
    await settle(page, 700);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
    await page.close();
  }));

  it('pointer lock', async () => scenario('pointer-events-gate', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t05-fullscreen-overlay/index.html', { waitUntil: 'networkidle2' });
    await settle(page, 700);
    expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).not.toBe('none');
    await page.close();
  }));

  it('nested frame', async () => scenario('nested-frame', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t06-nested-iframes/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as unknown as { __frames_loaded?: boolean }).__frames_loaded === true);
    const nestedFrames = page.frames().filter((frame) => frame !== page.mainFrame());
    expect(nestedFrames.length).toBeGreaterThanOrEqual(3);
    let contentFrames = 0;
    for (const frame of nestedFrames) {
      const ad = await frame.$('.ad-slot-wrapper');
      if (ad) expect(await ad.evaluate((element) => getComputedStyle(element).display)).toBe('none');
      if (await frame.$('#frame-content')) contentFrames += 1;
    }
    expect(contentFrames).toBeGreaterThanOrEqual(2);
    await page.close();
  }));

  it('cross-origin frame', async () => scenario('cross-origin-frame', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t32-phase31b-lab/index.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'cross-origin-fixture';
      frame.src = 'http://localhost:4061/cross-origin-fixture.html';
      document.body.appendChild(frame);
    });
    await page.waitForFunction(() => Boolean(document.querySelector('#cross-origin-fixture')));
    const child = page.frames().find((frame) => frame.url().includes('cross-origin-fixture.html'));
    expect(child).toBeDefined();
    await child?.waitForSelector('.ad-slot-wrapper');
    expect(await child?.$eval('.ad-slot-wrapper', (element) => getComputedStyle(element).display)).toBe('none');
    expect(await child?.$eval('#child-content', (element) => element.textContent)).toContain('Cross-origin content survives');
    await page.close();
  }));

  it('open shadow DOM', async () => scenario('open-shadow-dom', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t07-shadow-dom/index.html', { waitUntil: 'networkidle2' });
    expect(await page.evaluate(() => {
      const root = document.querySelector('#host-element')?.shadowRoot;
      const modal = root?.querySelector('#shadow-modal');
      const ad = root?.querySelector('.ad-slot-wrapper');
      return { mounted: Boolean(modal), adDisplay: ad ? getComputedStyle(ad).display : null, text: modal?.textContent || '' };
    })).toEqual({ mounted: true, adDisplay: 'block', text: expect.stringContaining('Anti-Adblock') });
    await page.close();
  }, 'NEGATIVE_CONTROL_PASS'));

  it('CSP-heavy page', async () => scenario('csp-heavy-page', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t33-csp-heavy-page/index.html', { waitUntil: 'networkidle2' });
    expect(await page.evaluate(() => (window as unknown as { __csp_fixture_loaded?: boolean }).__csp_fixture_loaded)).toBe(true);
    expect(await page.$eval('.ad-slot-wrapper', (element) => getComputedStyle(element).display)).toBe('none');
    expect(await page.$eval('#csp-content', (element) => element.textContent)).toContain('CSP content survives');
    await page.close();
  }));

  it('SPA navigation', async () => scenario('spa-route-change', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t08-spa-transitions/index.html', { waitUntil: 'networkidle2' });
    await page.click('#link-article');
    await settle(page);
    expect(await page.evaluate(() => (window as unknown as { __spa_navigated?: boolean }).__spa_navigated)).toBe(true);
    await page.close();
  }));

  it('body replacement', async () => scenario('body-replacement', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t31-runtime-dom-churn/index.html', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => (window as unknown as { __churn_done?: boolean }).__churn_done === true, { timeout: 10000 });
    expect(await page.$eval('#content', (element) => element.textContent)).toContain('replacement body');
    await page.close();
  }));

  it('mutation storm', async () => scenario('mutation-storm', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t15-mutation-storm/index.html', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => (window as unknown as { __storm_completed?: boolean }).__storm_completed === true, { timeout: 10000 });
    expect(await page.$eval('h1', (element) => element.textContent)).toContain('Mutation Storm');
    expect(await page.evaluate(() => document.body.children.length)).toBeGreaterThan(1);
    await page.close();
  }));

  it('worker restart', async () => scenario('worker-restart', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t21-sw-worker-page/index.html', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => (window as unknown as { __sw_registered?: boolean }).__sw_registered === true, { timeout: 10000 });
    expect(await page.evaluate(() => (window as unknown as { __cache_stored?: boolean }).__cache_stored)).toBe(true);
    const extensionWorker = browser.targets().find((target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'));
    expect(extensionWorker).toBeDefined();
    const browserSession = await page.target().createCDPSession();
    const targetId = (extensionWorker as unknown as { _targetId?: string })._targetId;
    if (!targetId) throw new Error('extension service worker target id is unavailable');
    await browserSession.send('Target.closeTarget', { targetId });
    const restartedPage = await browser.newPage();
    await restartedPage.goto('http://localhost:4060/t32-phase31b-lab/index.html', { waitUntil: 'networkidle2' });
    await settle(restartedPage);
    expect(await restartedPage.$eval('.ad-slot-wrapper', (element) => getComputedStyle(element).display)).toBe('none');
    expect(await restartedPage.$eval('#main-content', (element) => element.textContent)).toContain('Phase 3.1B lab');
    await restartedPage.close();
    await page.close();
  }));

  it('consent negative control', async () => scenario('consent-modal', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t12-consent-modal/index.html', { waitUntil: 'networkidle2' });
    expect(await page.$eval('#cookie-dialog', (element) => getComputedStyle(element).display)).not.toBe('none');
    await page.close();
  }));

  it('login negative control', async () => scenario('login-modal', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t14-paywall-login/index.html', { waitUntil: 'networkidle2' });
    expect(await page.$eval('#login-form-dialog', (element) => getComputedStyle(element).display)).not.toBe('none');
    await page.close();
  }));

  it('paywall negative control', async () => scenario('paywall', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t14-paywall-login/index.html', { waitUntil: 'networkidle2' });
    expect(await page.$eval('h1', (element) => element.textContent)).toContain('Subscriber Content');
    await page.close();
  }));

  it('benign advertisement text negative control', async () => scenario('benign-advertisement-text', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t32-phase31b-lab/index.html', { waitUntil: 'networkidle2' });
    expect(await page.$eval('#benign-copy', (element) => getComputedStyle(element).display)).not.toBe('none');
    await page.close();
  }));

  it('reports every corpus row', () => {
    expect(results.map((result) => result.id).sort()).toEqual(corpus.map((entry) => entry.id).sort());
    expect(results.filter((result) => result.pass)).toHaveLength(corpus.length);
  });
});
