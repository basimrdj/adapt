/* Scratch: verify the pause/resume affordance visually + functionally in real
 * Chrome. The popup is rendered as a tab (screenshot harness artifact), so
 * chrome.tabs.query is stubbed to point at a real site tab — everything else
 * (storage write, background DNR sync, paused-state render) is the real path.
 * Not part of any suite. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function main(): Promise<void> {
  const extensionPath = path.resolve(__dirname, '../../dist');
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromeExecutable(),
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--headless=new', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox'],
  });
  try {
    let extensionId = '';
    for (let i = 0; i < 30 && !extensionId; i++) {
      const target = (await browser.targets()).find((t) => t.url().startsWith('chrome-extension://') && t.url().includes('background.js'));
      if (target) extensionId = new URL(target.url()).host;
      else await new Promise((r) => setTimeout(r, 300));
    }
    if (!extensionId) throw new Error('extension service worker not found');

    const site = await browser.newPage();
    await site.goto('https://example.com', { waitUntil: 'domcontentloaded' }).catch(() => undefined);

    const page = await browser.newPage();
    await page.setViewport({ width: 450, height: 640, deviceScaleFactor: 2 });
    // Popup-as-tab artifact fix: report the real site tab as active.
    await page.evaluateOnNewDocument(() => {
      const original = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (queryInfo: chrome.tabs.QueryInfo, callback?: (tabs: chrome.tabs.Tab[]) => void) => {
        if (queryInfo.active && callback) {
          callback([{ id: 1, url: 'https://example.com/', active: true } as chrome.tabs.Tab]);
          return undefined as never;
        }
        return original(queryInfo, callback as (tabs: chrome.tabs.Tab[]) => void);
      };
    });
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 700));
    await page.screenshot({ path: '/tmp/popup-pause-default.png' });

    const buttonVisible = await page.evaluate(() => {
      const button = document.getElementById('btn-pause') as HTMLButtonElement | null;
      return button ? { hidden: button.hidden, label: button.textContent } : null;
    });
    console.log('DEFAULT BUTTON:', JSON.stringify(buttonVisible));

    // Real click path: writes storage, background syncs the DNR allowance.
    await page.click('#btn-pause');
    await new Promise((r) => setTimeout(r, 900));
    const pausedState = await page.evaluate(() => ({
      title: document.getElementById('hero-title')?.textContent,
      sub: document.getElementById('hero-sub')?.textContent,
      pill: document.getElementById('live-text')?.textContent,
      pillClass: document.getElementById('live-pill')?.className,
      button: document.getElementById('btn-pause')?.textContent,
      threatState: document.getElementById('state-threat')?.textContent,
    }));
    console.log('PAUSED STATE:', JSON.stringify(pausedState));
    await page.screenshot({ path: '/tmp/popup-pause-paused.png' });

    // Confirm the storage write reached the background (list + DNR rule).
    const swTarget = (await browser.targets()).find((t) => t.url().includes('background.js'));
    const sw = await swTarget?.worker();
    const ground = await sw?.evaluate(async () => {
      const stored = await chrome.storage.local.get(['adapt_paused_hosts']);
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      return {
        list: stored.adapt_paused_hosts,
        bandRules: rules.filter((r) => r.id >= 5_010_000 && r.id <= 5_019_999).length,
      };
    });
    console.log('BACKGROUND GROUND TRUTH:', JSON.stringify(ground));

    // Resume path.
    await page.click('#btn-pause');
    await new Promise((r) => setTimeout(r, 600));
    const resumed = await page.evaluate(() => ({
      title: document.getElementById('hero-title')?.textContent,
      pill: document.getElementById('live-text')?.textContent,
      button: document.getElementById('btn-pause')?.textContent,
    }));
    console.log('RESUMED STATE:', JSON.stringify(resumed));
    console.log('SHOTS: /tmp/popup-pause-default.png /tmp/popup-pause-paused.png');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
