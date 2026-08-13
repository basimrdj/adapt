/**
 * M0 SPIKE — webNavigation.documentId behavior (architecture-critical for Phase 3).
 *
 * Phase 3's causal identity key is { tabId, navigationEpoch, documentId, frameId }.
 * This spike empirically proves in real Chromium:
 *   S1. documentId is a non-empty string on every onCommitted / onHistoryStateUpdated.
 *   S2. documentId CHANGES when the main frame navigates to a new document (pageA → pageB).
 *   S3. documentId STAYS THE SAME across an SPA history.pushState (same document, new route).
 *   S4. frameId stays 0 across both navigations (frame container is reused — proving
 *       frameId alone is insufficient and documentId is necessary).
 *
 * Self-contained: builds a throwaway instrumented MV3 extension in a temp dir,
 * loads it via Puppeteer + Chrome for Testing, captures webNavigation events
 * through a local logger, then asserts the four properties above.
 *
 * Run:  npx tsx tools/spikes/document-id-spike.ts
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer, { Browser } from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface NavEvent {
  event: string;
  tabId: number;
  frameId: number;
  documentId?: string;
  parentFrameId?: number;
  url: string;
  transitionType?: string;
  ts: number;
}

const events: NavEvent[] = [];

// 1. Minimal logger server — the instrumented SW POSTs events here.
function startLogger(): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            events.push(JSON.parse(body));
          } catch {
            /* ignore */
          }
          res.writeHead(204);
          res.end();
        });
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!doctype html><meta charset=utf-8><title>spike</title>` +
            `<body><h1 id=a>Page</h1><script>window.markPage=true;</script></body>`
        );
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// 2. Throwaway instrumented extension.
function buildInstrumentedExtension(extDir: string, loggerPort: number): void {
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'documentId Spike',
      version: '0.0.1',
      permissions: ['webNavigation'],
      host_permissions: ['http://127.0.0.1/*'],
      background: { service_worker: 'bg.js' },
    })
  );
  const events = ['onBeforeNavigate', 'onCommitted', 'onCompleted', 'onHistoryStateUpdated'];
  fs.writeFileSync(
    path.join(extDir, 'bg.js'),
    `${events
      .map(
        (ev) =>
          `chrome.webNavigation.${ev}.addListener((d) => {` +
          `try{fetch("http://127.0.0.1:${loggerPort}/log",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({event:"${ev}",tabId:d.tabId,frameId:d.frameId,documentId:d.documentId,parentFrameId:d.parentFrameId,url:d.url,transitionType:d.transitionType,ts:Date.now()})});}catch(e){}});`
      )
      .join('\n')}`
  );
}

// 3. Locate Chrome for Testing (mirror tests/e2e discovery).
function findChrome(): string {
  const dir = path.resolve(__dirname, '../../chrome');
  if (fs.existsSync(dir)) {
    for (const sub of fs.readdirSync(dir)) {
      const c = path.join(dir, sub, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (fs.existsSync(c)) return c;
    }
  }
  const sys = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return fs.existsSync(sys) ? sys : sys; // let puppeteer error clearly if absent
}

async function main() {
  const logger = await startLogger();
  const extDir = path.join(os.tmpdir(), `adapt-docid-spike-${Date.now()}`);
  buildInstrumentedExtension(extDir, logger.port);
  const extPath = path.join(extDir);
  console.log(`[spike] extension: ${extPath}`);
  console.log(`[spike] logger:    http://127.0.0.1:${logger.port}`);

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      headless: false,
      executablePath: findChrome(),
      args: [`--headless=new`, `--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, '--no-sandbox'],
    });

    // Allow the SW to boot.
    await new Promise((r) => setTimeout(r, 1500));

    const page = await browser.newPage();

    // --- Navigation 1: load page A (root) ---
    await page.goto(`http://127.0.0.1:${logger.port}/a`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 500));

    // --- SPA route change via history.pushState (same document) ---
    await page.evaluate(() => history.pushState({}, '', '/spa-route'));
    await new Promise((r) => setTimeout(r, 800)); // give onHistoryStateUpdated time to fire

    // --- Navigation 2: load page B (new document, same frame 0) ---
    await page.goto(`http://127.0.0.1:${logger.port}/b`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 500));

    await page.close();
  } finally {
    if (browser) await browser.close();
    await logger.close();
  }

  // --- Analyze ---
  const committed = events.filter((e) => e.event === 'onCommitted' && e.frameId === 0);
  const hist = events.filter((e) => e.event === 'onHistoryStateUpdated' && e.frameId === 0);

  console.log(`\n[spike] captured ${events.length} webNavigation events (${committed.length} onCommitted main-frame, ${hist.length} onHistoryStateUpdated main-frame)`);

  const committedA = committed.find((e) => e.url.endsWith('/a'));
  const committedB = committed.find((e) => e.url.endsWith('/b'));

  const checks: { name: string; pass: boolean; detail: string }[] = [];

  // S1: documentId present + non-empty on every onCommitted
  const allHaveDocId = committed.every((e) => typeof e.documentId === 'string' && e.documentId.length > 0);
  checks.push({ name: 'S1 documentId present & non-empty on every onCommitted', pass: allHaveDocId, detail: `${committed.length}/${committed.length} have documentId` });

  // S2: documentId CHANGES A -> B (different documents)
  const docIdA = committedA?.documentId;
  const docIdB = committedB?.documentId;
  const changed = !!docIdA && !!docIdB && docIdA !== docIdB;
  checks.push({ name: 'S2 documentId CHANGES across document navigation (A -> B)', pass: changed, detail: `A=${docIdA} B=${docIdB}` });

  // S3: documentId SAME across SPA history.pushState
  // The onHistoryStateUpdated for /spa-route should carry the SAME documentId as onCommitted /a.
  const spaEvent = hist.find((e) => e.url.includes('/spa-route'));
  const spaSame = !!spaEvent?.documentId && !!docIdA && spaEvent.documentId === docIdA;
  checks.push({ name: 'S3 documentId STABLE across SPA history.pushState', pass: spaSame, detail: `spa=${spaEvent?.documentId} A=${docIdA}` });

  // S4: frameId stays 0 across both navigations (proving reuse -> documentId is necessary)
  const frameZeroThroughout = committedA?.frameId === 0 && committedB?.frameId === 0;
  checks.push({ name: 'S4 frameId reused (stays 0) across navigations -> documentId necessary', pass: frameZeroThroughout, detail: `A.frameId=${committedA?.frameId} B.frameId=${committedB?.frameId}` });

  console.log('\n================ SPIKE RESULTS ================');
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  [${c.detail}]`);
  const allPass = checks.every((c) => c.pass);
  console.log('===============================================');
  console.log(allPass ? '\n✅ ALL CHECKS PASSED — documentId is stable per-document and changes per navigation. Phase 3 causal key is valid.' : '\n❌ ONE OR MORE CHECKS FAILED — re-examine before depending on documentId.');

  // Dump raw timeline for the ledger if needed.
  if (!allPass) {
    console.log('\n--- raw main-frame timeline ---');
    for (const e of [...committed, ...hist].sort((a, b) => a.ts - b.ts)) console.log(JSON.stringify({ event: e.event, frameId: e.frameId, documentId: e.documentId, url: e.url }));
  }

  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error('[spike] fatal:', e);
  process.exit(2);
});
