/* Scratch: render the built popup in real Chrome and screenshot it for visual
 * comparison against the design mock. Not part of any suite. */
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
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
    ],
  });
  try {
    // Extension id comes from the service worker target URL.
    let extensionId = '';
    for (let i = 0; i < 30 && !extensionId; i++) {
      const target = (await browser.targets()).find((t) => t.url().startsWith('chrome-extension://') && t.url().includes('background.js'));
      if (target) extensionId = new URL(target.url()).host;
      else await new Promise((r) => setTimeout(r, 300));
    }
    if (!extensionId) throw new Error('extension service worker not found');

    // Popup needs an active http(s) tab for the site line; give it one.
    const site = await browser.newPage();
    await site.goto('https://example.com', { waitUntil: 'domcontentloaded' }).catch(() => undefined);

    const page = await browser.newPage();
    await page.setViewport({ width: 450, height: 620, deviceScaleFactor: 2 });
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 700));
    await page.screenshot({ path: '/tmp/popup-shot.png' });

    // Second shot: Threat Blocking row expanded.
    await page.click('#row-threat');
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: '/tmp/popup-shot-expanded.png' });
    console.log('SHOTS: /tmp/popup-shot.png /tmp/popup-shot-expanded.png');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
