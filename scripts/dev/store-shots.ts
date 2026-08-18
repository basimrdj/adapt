/* Scratch: capture store-quality screenshots (1280×800) from real Chrome —
 * the action popup over a live article fixture, its paused state, and the
 * options page. Not part of any suite. */
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const OUT = path.resolve(__dirname, '../../store');

const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:Georgia,'Times New Roman',serif;background:#fafaf7;color:#1a1a1a}
  header{padding:22px 60px;border-bottom:1px solid #e4e4de;display:flex;justify-content:space-between;align-items:center;background:#fff}
  .masthead{font-size:26px;font-weight:700;letter-spacing:.02em}
  nav{font-family:-apple-system,sans-serif;font-size:13px;color:#777;display:flex;gap:22px}
  article{max-width:680px;margin:44px auto;padding:0 24px}
  h1{font-size:38px;line-height:1.15;margin:0 0 14px}
  .byline{font-family:-apple-system,sans-serif;font-size:13px;color:#8a8a82;margin-bottom:28px}
  p{font-size:18px;line-height:1.65;margin:0 0 20px}
  .hero-img{width:100%;height:300px;background:linear-gradient(135deg,#dfe7ef,#c3d2e0);border-radius:6px;margin-bottom:26px}
</style></head><body>
<header><span class="masthead">The Daily Fixture</span><nav><span>World</span><span>Tech</span><span>Science</span><span>Culture</span></nav></header>
<article><h1>Local journalism discovers the joy of deterministic builds</h1>
<div class="byline">By A. Reporter · August 16, 2026 · 6 min read</div>
<div class="hero-img"></div>
<p>Newsrooms have long relied on hope as a deployment strategy. But a quiet movement of engineers is proving that reproducible artifacts make calmer mornings.</p>
<p>"We stopped shipping credentials to production," said one relieved maintainer, "and started shipping zips that unzip to exactly what we tested."</p>
<p>The approach, known locally as 'testing what you ship', has been linked to a 100% reduction in Friday-evening incidents.</p></article></body></html>`;

function startArticleServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(ARTICLE);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('bind failed'));
      resolve({ port: address.port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function main(): Promise<void> {
  const extensionPath = path.resolve(__dirname, '../../dist');
  const article = await startArticleServer();
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromeExecutable(),
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--headless=new', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox', '--window-size=1280,800'],
    defaultViewport: { width: 1280, height: 800 },
  });
  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && /chrome-extension:\/\/[^/]+\/background\.js$/.test(t.url()),
      { timeout: 15_000 }
    );
    const extensionId = new URL(swTarget.url()).host;
    const sw = await swTarget.worker();
    if (!sw) throw new Error('no service worker');

    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${article.port}/article`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 800));

    // Open the real action popup over the live page. Popup targets expose no
    // puppeteer Page — drive them over raw CDP.
    await sw.evaluate(() => chrome.action.openPopup());
    const popupTarget = await browser.waitForTarget(
      (t) => t.url() === `chrome-extension://${extensionId}/popup/index.html`,
      { timeout: 8_000 }
    );
    const popupCdp = await popupTarget.createCDPSession();
    await popupCdp.send('Page.enable');
    await popupCdp.send('Runtime.enable');
    const shotPopup = async (file: string) => {
      const { data } = await popupCdp.send('Page.captureScreenshot', { format: 'png' });
      (await import('node:fs')).writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
    };
    const popupClick = async (id: string) => {
      await popupCdp.send('Runtime.evaluate', { expression: `document.getElementById(${JSON.stringify(id)})?.click()` });
    };
    await new Promise((r) => setTimeout(r, 900));
    await shotPopup('screenshot-popup.png');
    console.log('SHOT store/screenshot-popup.png');

    // Paused state.
    await popupClick('btn-pause');
    await new Promise((r) => setTimeout(r, 900));
    await shotPopup('screenshot-popup-paused.png');
    console.log('SHOT store/screenshot-popup-paused.png');
    await popupClick('btn-pause'); // resume — leave the fixture unpaused

    // Options page, full tab.
    const options = await browser.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/index.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 700));
    await options.screenshot({ path: path.join(OUT, 'screenshot-options.png') });
    console.log('SHOT store/screenshot-options.png');
  } finally {
    await browser.close();
    await article.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
