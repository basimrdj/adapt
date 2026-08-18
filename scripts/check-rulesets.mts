import puppeteer from 'puppeteer';
import { chromeExecutable } from '../tests/support/chrome-executable';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
const root = process.cwd();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-ruleset-check-'));
const browser = await puppeteer.launch({
  headless: true,
  executablePath: chromeExecutable(root),
  userDataDir,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--headless=new', `--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`, '--no-sandbox'],
});
const page = await browser.newPage();
await page.goto('about:blank');
await new Promise((r) => setTimeout(r, 6000));
const target = browser.targets().find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
if (!target) { console.log('NO WORKER'); process.exit(1); }
const client = await target.createCDPSession();
const res = await client.send('Runtime.evaluate', { expression: 'chrome.declarativeNetRequest.getEnabledRulesets()', awaitPromise: true, returnByValue: true });
console.log('enabled rulesets:', JSON.stringify(res.result.value));
const res2 = await client.send('Runtime.evaluate', { expression: 'chrome.declarativeNetRequest.getAvailableStaticRuleCount()', awaitPromise: true, returnByValue: true });
console.log('available:', JSON.stringify(res2.result.value));
await browser.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
