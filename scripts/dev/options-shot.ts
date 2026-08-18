/* Scratch: render the built Options page in real Chrome, screenshot it, and run
 * the live connection test against the baked dev credential (result text only —
 * the credential never leaves the service worker). Not part of any suite. */
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
    let extensionId = '';
    for (let i = 0; i < 30 && !extensionId; i++) {
      const target = (await browser.targets()).find((t) => t.url().startsWith('chrome-extension://') && t.url().includes('background.js'));
      if (target) extensionId = new URL(target.url()).host;
      else await new Promise((r) => setTimeout(r, 300));
    }
    if (!extensionId) throw new Error('extension service worker not found');

    const page = await browser.newPage();
    await page.setViewport({ width: 760, height: 1000, deviceScaleFactor: 2 });
    await page.goto(`chrome-extension://${extensionId}/options/index.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: '/tmp/options-shot.png' });

    // Live test of the baked dev credential through the NEW transport dispatch.
    await page.click('#btn-test');
    let resultText = '';
    for (let i = 0; i < 90; i++) {
      resultText = await page.$eval('#test-result', (n) => n.textContent ?? '');
      if (resultText && resultText !== 'Testing…') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log('LIVE TEST RESULT:', resultText);
    const badge = await page.$eval('#status-badge', (n) => n.textContent ?? '');
    console.log('BADGE:', badge);
    await page.screenshot({ path: '/tmp/options-tested.png' });

    // Anthropic segment selected state.
    await page.click('.segment[data-provider="anthropic"]');
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: '/tmp/options-anthropic.png' });
    console.log('SHOTS: /tmp/options-shot.png /tmp/options-tested.png /tmp/options-anthropic.png');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
