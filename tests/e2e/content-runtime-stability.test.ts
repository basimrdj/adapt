import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import puppeteer, { Browser } from 'puppeteer';
import { startTestServers, TestServerInstances } from '../pages/server';
import { chromeExecutable } from '../support/chrome-executable';

describe('content-script runtime stability', () => {
  let browser: Browser;
  let servers: TestServerInstances;
  const extensionPath = path.resolve(__dirname, '../../dist');

  beforeAll(async () => {
    servers = await startTestServers(4050, 4051);
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromeExecutable(),
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--headless=new',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-sandbox',
      ],
    });
  });

  afterAll(async () => {
    await browser?.close();
    await servers?.close();
  });

  it('does not emit extension exceptions during body replacement and mutation churn', async () => {
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Runtime.enable');

    const extensionExceptions: string[] = [];

    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      const url = exceptionDetails.url || '';
      const description =
        exceptionDetails.exception?.description ||
        exceptionDetails.text ||
        '';

      if (
        url.startsWith('chrome-extension://') ||
        description.includes('getComputedStyle')
      ) {
        extensionExceptions.push(`${url}\n${description}`);
      }
    });

    await page.goto(
      'http://localhost:4050/t31-runtime-dom-churn/index.html',
      { waitUntil: 'networkidle2' }
    );

    await page.waitForFunction(
      () => (window as unknown as { __churn_done?: boolean }).__churn_done === true,
      { timeout: 10_000 }
    );

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(extensionExceptions).toEqual([]);
    await page.close();
  });
});
