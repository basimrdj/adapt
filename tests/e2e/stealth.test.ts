import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer, { Browser, Page } from 'puppeteer';
import { startTestServers, TestServerInstances } from '../pages/server';

type ResultClass = 'BLOCKING_PASS' | 'NEGATIVE_CONTROL_PASS' | 'LIFECYCLE_PASS' | 'PRESENCE_ONLY';
interface StealthResult { id: string; pass: boolean; resultClass: ResultClass; detail?: string }

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

async function settle(page: Page, ms = 900): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await page.evaluate(() => document.readyState);
}

const ids = [
  'passive-bait-height',
  'passive-bait-offsetHeight',
  'passive-bait-boundingRect',
  'passive-bait-computedStyle',
  'passive-bait-existence',
  'timed-bait-recheck',
  'bait-reinsertion',
  'network-probe-detector',
  'hybrid-detector',
];

describe('Phase 3.1B passive detector-bait stealth gate', () => {
  let browser: Browser;
  let servers: TestServerInstances;
  const results: StealthResult[] = [];
  const extensionPath = path.resolve(__dirname, '../../dist');

  beforeAll(async () => {
    servers = await startTestServers(4070, 4071);
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromeExecutable(),
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--headless=new',
        '--host-resolver-rules=MAP 1bit.space 127.0.0.1,MAP *.1bit.space 127.0.0.1,MAP kasilyrics.co.za 127.0.0.1,MAP *.kasilyrics.co.za 127.0.0.1',
        '--disable-extensions-except=' + extensionPath,
        '--load-extension=' + extensionPath,
        '--no-sandbox',
      ],
    });
  });

  afterAll(async () => {
    const artifactDir = path.resolve(__dirname, '../../artifacts/phase31b');
    mkdirSync(artifactDir, { recursive: true });
    const passed = results.filter((result) => result.pass).length;
    writeFileSync(path.join(artifactDir, 'stealth-results.json'), `${JSON.stringify({
      schema: 'adapt-phase31b-stealth-v1',
      total: results.length,
      passed,
      failed: results.length - passed,
      resultClasses: results.reduce<Record<string, number>>((counts, result) => {
        counts[result.resultClass] = (counts[result.resultClass] || 0) + 1;
        return counts;
      }, {}),
      results,
      liveCanYouBlockIt: 'NOT_OBSERVED',
    }, null, 2)}\n`);
    await browser?.close();
    await servers?.close();
  });

  it('passes passive bait and network-probe detector families', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4070/t35-stealth/index.html', { waitUntil: 'domcontentloaded' });
    await settle(page);

    const state = await page.evaluate(() => {
      const stealth = (window as typeof window & { __stealth?: Record<string, any> }).__stealth || {};
      return {
        detector: typeof stealth.detector === 'function' ? stealth.detector() : null,
        initial: stealth.initial,
        recheck: stealth.recheck,
        timed: stealth.timed,
        reinsertion: stealth.reinsertion,
        adBlocked: stealth.adBlocked === true,
        adLoaded: stealth.adLoaded === true,
        fetchProbe: stealth.fetchProbe,
        contentVisible: getComputedStyle(document.querySelector('.ordinary-content')!).display !== 'none',
      };
    });

    const detector = state.detector;
    expect(detector).not.toBeNull();
    const checks: Record<string, boolean> = {
      'passive-bait-height': detector.height === true,
      'passive-bait-offsetHeight': detector.offsetHeight === true,
      'passive-bait-boundingRect': detector.boundingRect === true,
      'passive-bait-computedStyle': detector.computedStyle === true,
      'passive-bait-existence': detector.existence === true,
      'timed-bait-recheck': state.timed === true && Array.isArray(state.recheck),
      'bait-reinsertion': state.reinsertion === true,
      'network-probe-detector': state.fetchProbe === 'blocked' && state.adLoaded === false,
      'hybrid-detector': detector.hybrid === true && state.fetchProbe === 'blocked',
    };

    for (const id of ids) {
      const pass = checks[id] === true;
      results.push({ id, pass, resultClass: 'BLOCKING_PASS', detail: pass ? undefined : JSON.stringify(state) });
      console.log(`${id} ${pass ? 'PASS' : 'FAIL'}`);
      expect(pass, id).toBe(true);
    }

    const negativePass = state.contentVisible === true;
    results.push({ id: 'negative-control-content', pass: negativePass, resultClass: 'NEGATIVE_CONTROL_PASS' });
    console.log(`negative-control-content ${negativePass ? 'PASS' : 'FAIL'}`);
    expect(negativePass).toBe(true);
    await page.close();
  });

  it('does not ship detector bait selectors in static cosmetic CSS', () => {
    const css = fs.readFileSync(path.resolve(extensionPath, 'phase31-page-cosmetic.css'), 'utf8');
    const leaked = ['.ad-widget', '.adsbox', '.ad-banner', '#adblock'].filter((selector) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[,{\\s])${escaped}(?=\\s*\\{)`).test(css);
    });
    const pass = leaked.length === 0;
    results.push({ id: 'negative-control-static-bait-css', pass, resultClass: 'NEGATIVE_CONTROL_PASS', detail: leaked.join(',') || undefined });
    console.log(`negative-control-static-bait-css ${pass ? 'PASS' : 'FAIL'}`);
    expect(leaked).toEqual([]);
  });
});
