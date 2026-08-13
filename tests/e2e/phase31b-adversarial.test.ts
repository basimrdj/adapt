import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { Browser } from 'puppeteer';
import { startTestServers, TestServerInstances } from '../pages/server';

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

describe('Phase 3.1B deterministic adversarial lab', () => {
  let browser: Browser;
  let servers: TestServerInstances;
  const extensionPath = path.resolve(__dirname, '../../dist');

  beforeAll(async () => {
    servers = await startTestServers(4060, 4061);
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromeExecutable(),
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--headless=new', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox'],
    });
  });

  afterAll(async () => {
    await browser?.close();
    await servers?.close();
  });

  it('keeps content visible while removing a generic ad fixture', async () => {
    const page = await browser.newPage();
    await page.goto('http://localhost:4060/t32-phase31b-lab/index.html', { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 350));

    const result = await page.evaluate(() => ({
      adDisplay: window.getComputedStyle(document.querySelector('.ad-slot-wrapper') as Element).display,
      mainText: document.querySelector('#main-content')?.textContent || '',
      churnComplete: (window as unknown as { __phase31b?: { churnComplete?: boolean } }).__phase31b?.churnComplete === true,
    }));

    expect(result.adDisplay).toBe('none');
    expect(result.mainText).toContain('Phase 3.1B lab');
    expect(result.churnComplete).toBe(true);
    await page.close();
  });
});
