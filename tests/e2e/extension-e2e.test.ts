import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import puppeteer, { Browser } from 'puppeteer';
import { startTestServers, TestServerInstances } from '../pages/server';
import { isPageSignalBatch, isHealthVector, isDomAction } from '../../src/shared/guards';

describe('ADAPT Extension E2E Laboratory Matrix (Complete Suite)', () => {
  let servers: TestServerInstances;
  let browser: Browser;
  const extensionPath = path.resolve(__dirname, '../../dist');

  // Locate Chrome for Testing binary dynamically
  const chromeDir = path.resolve(__dirname, '../../chrome');
  let chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(chromeDir)) {
    const subdirs = fs.readdirSync(chromeDir);
    for (const sub of subdirs) {
      const candidate = path.join(
        chromeDir,
        sub,
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      );
      if (fs.existsSync(candidate)) {
        chromePath = candidate;
        break;
      }
    }
  }

  beforeAll(async () => {
    servers = await startTestServers(4000, 4001);
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

  it('T01: Blocks baseline third-party ad script via Declarative Net Request', async () => {
    const page = await browser.newPage();
    await page.goto(`http://localhost:4000/t01-basic-ad/index.html`, { waitUntil: 'networkidle2' });

    const adExecuted = await page.evaluate(() => (window as any).__ad_loaded);
    expect(adExecuted).toBeUndefined(); // Blocked by native DNR!
    await page.close();
  });

  it('T03: Bait detector reaction is identified and resolved by preserving bait layout', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://localhost:4000/t03-bait-detector/index.html`, { waitUntil: 'networkidle2' });

    // Allow sensor to detect bait and trigger adaptation
    await new Promise((r) => setTimeout(r, 1500));

    const isGateActive = await page.evaluate(() => {
      const gate = document.getElementById('anti-adblock-gate');
      return gate !== null && window.getComputedStyle(gate).display !== 'none';
    });

    const isScrollUnlocked = await page.evaluate(() => {
      return window.getComputedStyle(document.body).overflow !== 'hidden';
    });

    expect(isGateActive).toBe(false);
    expect(isScrollUnlocked).toBe(true);
    await page.close();
  });

  it('T04: Blocked-probe detector reaction is detected and handled by removing gate', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://localhost:4000/t04-blocked-probe/index.html`, { waitUntil: 'networkidle2' });

    await new Promise((r) => setTimeout(r, 1500));

    const isGateRemoved = await page.evaluate(() => {
      const gate = document.getElementById('probe-gate');
      return !gate || window.getComputedStyle(gate).display === 'none';
    });
    expect(isGateRemoved).toBe(true);
    await page.close();
  });

  it('T05: Adapts to full-screen anti-adblock overlay and restores scroll', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://localhost:4000/t05-fullscreen-overlay/index.html`, { waitUntil: 'networkidle2' });

    await new Promise((r) => setTimeout(r, 1500));

    const isOverlayVisible = await page.evaluate(() => {
      const modal = document.getElementById('blocker-modal');
      if (!modal) return false;
      const style = window.getComputedStyle(modal);
      return style.display !== 'none' && parseFloat(style.opacity || '1') > 0.1;
    });

    const isScrollUnlocked = await page.evaluate(() => {
      const overflow = window.getComputedStyle(document.body).overflow;
      return overflow !== 'hidden';
    });

    expect(isOverlayVisible).toBe(false);
    expect(isScrollUnlocked).toBe(true);
    await page.close();
  });

  it('T12 & T13: Negative controls — does not falsely adapt on benign consent or newsletter modals', async () => {
    const page1 = await browser.newPage();
    await page1.goto(`http://localhost:4000/t12-consent-modal/index.html`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 800));

    const consentModalExists = await page1.evaluate(() => {
      const banner = document.getElementById('cookie-dialog');
      return banner !== null && window.getComputedStyle(banner).display !== 'none';
    });
    expect(consentModalExists).toBe(true); // Legitimate modal preserved!
    await page1.close();

    const page2 = await browser.newPage();
    await page2.goto(`http://localhost:4000/t13-newsletter-modal/index.html`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 800));

    const newsletterModalExists = await page2.evaluate(() => {
      const modal = document.getElementById('newsletter-box');
      return modal !== null && window.getComputedStyle(modal).display !== 'none';
    });
    expect(newsletterModalExists).toBe(true); // Newsletter preserved!
    await page2.close();
  });

  it('T15: Degrades gracefully under mutation storm without crashing page', async () => {
    const page = await browser.newPage();
    await page.goto(`http://localhost:4000/t15-mutation-storm/index.html`, { waitUntil: 'networkidle2' });

    await page.waitForFunction(() => (window as any).__storm_completed === true, { timeout: 8000 });
    const completed = await page.evaluate(() => (window as any).__storm_completed);
    expect(completed).toBe(true);
    await page.close();
  });

  it('T20: Zero extension globals or fingerprint markers leaked to hostile page', async () => {
    const page = await browser.newPage();
    await page.goto(`http://localhost:4000/t20-fingerprint-probe/index.html`, { waitUntil: 'networkidle2' });

    const probeResults = await page.evaluate(() => (window as any).__fingerprint_probe_results);
    expect(probeResults.windowAdaptGlobal).toBe(false);
    expect(probeResults.windowCustomGlobals).toHaveLength(0);
    expect(probeResults.domMarkersFound).toBe(false);
    await page.close();
  });

  it('T25: Hostile IPC message schema validation rejects malformed payloads', () => {
    expect(isPageSignalBatch({ malicious: 'true' })).toBe(false);
    expect(isPageSignalBatch(null)).toBe(false);
    expect(isHealthVector({ antiBlockReaction: 'not_a_number' })).toBe(false);
    expect(isDomAction({ type: 'EXECUTE_ARBITRARY_JS', id: 'hack' })).toBe(false);
  });
});
