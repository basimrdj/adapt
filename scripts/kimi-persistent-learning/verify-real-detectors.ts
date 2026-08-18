/**
 * P5 VERIFICATION — real detector panel.
 *
 * Three tiers of REAL anti-adblock detectors against the REAL built extension:
 *
 *   Tier 1 (gating): vendored copies of the real open-source detector kits —
 *     FuckAdBlock v3 (raw.githubusercontent.com/sitexw/FuckAdBlock) and
 *     BlockAdBlock 3.2.1 (npm/jsDelivr — the successor of blockadblock.com's
 *     sunset hosted service). Fetched at harness run time into an artifacts
 *     cache (cache-first for determinism), served from a third-party fixture
 *     host on a deliberately unlisted path so the kits RUN. The differential is
 *     proven with two baselines: /baseline-sim pages inject aggressive
 *     bait-class hiding CSS (what a naive cosmetic blocker does) — the naked
 *     browser MUST be detected there — and plain /run pages where the naked
 *     browser must NOT be detected (no false positives). Under the extension
 *     the kits must report NOT-detected (the conservative cosmetic plane
 *     refuses to hide bait classes), or be neutralized pre-execution by the
 *     static plane (recorded distinctly). Tier 1b serves the same source under
 *     a filter-invisible filename so the kit provably RUNS — bait refusal is
 *     then the only thing standing between the kit and a detection.
 *
 *   Tier 2 (gating when reachable, SKIP with reason when not): live verdict
 *     sites — detectadblock.com twice (escape-once bait learning means pass 1
 *     may detect; pass 2 must be clean) and adblockanalytics.com once.
 *
 *   Tier 3 (report-only): adblock-tester.com blocking score snapshot — a
 *     regression signal for the blocking plane, never gated (page shape may
 *     drift).
 *
 * Writes artifacts/kimi-persistent-learning/REAL_DETECTORS_PROOF.json.
 * Artifact hygiene: fixture hosts only as labels; no credentials anywhere.
 *
 * Run: npm run build && npx tsx scripts/kimi-persistent-learning/verify-real-detectors.ts
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { Browser } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const root = process.cwd();
const extensionPath = path.join(root, 'dist');
const artifactDir = path.join(root, 'artifacts', 'kimi-persistent-learning');
const kitCacheDir = path.join(artifactDir, 'cache');

const KITS = [
  {
    id: 'fuckadblock',
    file: 'fuckadblock.js',
    url: 'https://raw.githubusercontent.com/sitexw/FuckAdBlock/master/fuckadblock.js',
    // v3: global fuckAdBlock instance with onDetected/onNotDetected.
    driver: `
      window.__verdict = undefined;
      (function () {
        function done(detected) { if (window.__verdict === undefined) window.__verdict = detected; }
        try {
          fuckAdBlock.onDetected(function () { done(true); });
          fuckAdBlock.onNotDetected(function () { done(false); });
          fuckAdBlock.check();
        } catch (e) { window.__verdict = 'error:' + String(e).slice(0, 80); }
        setTimeout(function () { if (window.__verdict === undefined) window.__verdict = 'timeout'; }, 6000);
      })();`,
  },
  {
    id: 'blockadblock',
    file: 'blockadblock.js',
    url: 'https://cdn.jsdelivr.net/npm/blockadblock@3.2.1/blockadblock.js',
    // v3: window.blockAdBlock default instance; check() triggers a bait cycle.
    driver: `
      window.__verdict = undefined;
      (function () {
        function done(detected) { if (window.__verdict === undefined) window.__verdict = detected; }
        try {
          blockAdBlock.onDetected(function () { done(true); });
          blockAdBlock.onNotDetected(function () { done(false); });
          blockAdBlock.check();
        } catch (e) { window.__verdict = 'error:' + String(e).slice(0, 80); }
        setTimeout(function () { if (window.__verdict === undefined) window.__verdict = 'timeout'; }, 6000);
      })();`,
  },
];

async function ensureKitCache(): Promise<Map<string, string>> {
  fs.mkdirSync(kitCacheDir, { recursive: true });
  const sources = new Map<string, string>();
  for (const kit of KITS) {
    const cachePath = path.join(kitCacheDir, kit.file);
    if (!fs.existsSync(cachePath) || fs.statSync(cachePath).size < 1000) {
      const response = await fetch(kit.url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`kit fetch failed: ${kit.id} HTTP ${response.status}`);
      const body = await response.text();
      if (body.length < 1000) throw new Error(`kit fetch truncated: ${kit.id} (${body.length} bytes)`);
      fs.writeFileSync(cachePath, body);
    }
    sources.set(kit.file, fs.readFileSync(cachePath, 'utf8'));
  }
  return sources;
}

interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

const receivedByHost = new Map<string, string[]>();

/** The exact bait class list both kits use (shared author, shared technique). */
const BAIT_CSS = '.pub_300x250, .pub_300x250m, .pub_728x90, .text-ad, .textAd, .text_ad, .text_ads, .text-ads, .text-ad-links, .ad-text, .adSense, .adBlock, .adContent, .adBanner { display: none !important; }';

async function startFixtureServer(kitSources: Map<string, string>): Promise<RunningServer> {
  const server = http.createServer((request, response) => {
    const host = (request.headers.host ?? '').split(':')[0] ?? 'unknown';
    const url = new URL(request.url || '/', 'http://fixture.test');
    const port = (server.address() as { port: number }).port;
    if (url.pathname === '/__received') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(Object.fromEntries(receivedByHost)));
      return;
    }
    const kitMatch = url.pathname.match(/^\/vendor-lib\/([\w.-]+)$/);
    if (kitMatch) {
      // Neutral-name aliases (lib-<n>.js by kit index) carry no filter-list
      // substring, so the same kit source runs past filename rules — this
      // exercises the bait-refusal branch instead of pre-execution blocking.
      const file = kitMatch[1]!;
      const alias = file.match(/^lib-(\d+)\.js$/);
      const sourceKey = alias ? KITS[Number(alias[1])]?.file : file;
      if (sourceKey && kitSources.has(sourceKey)) {
        receivedByHost.set(host, [...(receivedByHost.get(host) ?? []), url.pathname]);
        response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
        response.end(kitSources.get(sourceKey));
        return;
      }
    }
    const simMatch = url.pathname.match(/^\/baseline-sim\/(\w+)$/);
    if (simMatch) {
      const kit = KITS.find((entry) => entry.id === simMatch![1]);
      if (kit) {
        // Aggressive-blocker simulation: hides every bait class. A functional
        // kit MUST fire onDetected here.
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<!doctype html><html><head><style>${BAIT_CSS}</style></head><body><main><h1>Baseline sim: ${kit.id}</h1></main>
<script src="http://detector-vendor.test:${port}/vendor-lib/${kit.file}"></script>
<script>${kit.driver}</script>
</body></html>`);
        return;
      }
    }
    const pageMatch = url.pathname.match(/^\/run(\-neutral)?\/(\w+)$/);
    if (pageMatch) {
      const kit = KITS.find((entry) => entry.id === pageMatch![2]);
      if (kit) {
        const kitPath = pageMatch![1] ? `lib-${KITS.indexOf(kit)}.js` : kit.file;
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<!doctype html><html><body><main><h1>Real kit: ${kit.id}</h1><p>Intended content.</p></main>
<script src="http://detector-vendor.test:${port}/vendor-lib/${kitPath}"></script>
<script>${kit.driver}</script>
</body></html>`);
        return;
      }
    }
    receivedByHost.set(host, [...(receivedByHost.get(host) ?? []), url.pathname]);
    response.writeHead(200, { 'content-type': 'application/javascript' });
    response.end('/* fixture resource */');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return {
    port: (server.address() as { port: number }).port,
    close: async () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const HOSTS = ['kit-target.test', 'detector-vendor.test'];

async function launchBrowser(userDataDir: string, withExtension: boolean): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    executablePath: chromeExecutable(root),
    userDataDir,
    ignoreDefaultArgs: withExtension ? ['--disable-extensions'] : [],
    args: [
      '--headless=new',
      ...(withExtension ? [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] : []),
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--host-resolver-rules=${HOSTS.map((host) => `MAP ${host} 127.0.0.1`).join(',')}`,
    ],
  });
}

interface KitVerdict {
  kit: string;
  verdict: boolean | string;
  kitScriptReceipts: number;
}

async function runKitPanel(browser: Browser, port: number, neutral = false): Promise<KitVerdict[]> {
  const results: KitVerdict[] = [];
  for (let index = 0; index < KITS.length; index++) {
    const kit = KITS[index]!;
    const scriptPath = neutral ? `/vendor-lib/lib-${index}.js` : `/vendor-lib/${kit.file}`;
    const before = (receivedByHost.get('detector-vendor.test') ?? []).filter((p) => p === scriptPath).length;
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.log(`  [pageerror ${kit.id}${neutral ? ' neutral' : ''}]`, String(error).slice(0, 140)));
    if (process.env.ADAPT_DETECT_DEBUG === '1') {
      page.on('response', (res) => {
        const u = res.url();
        if (!u.includes('vendor-lib') && !u.includes('shims/')) return;
        console.log(`  [resp ${kit.id}${neutral ? ' neutral' : ''}]`, res.status(), u.slice(-64), 'loc=' + (res.headers()['location'] ?? '-'));
        if (res.status() === 200) void res.text().then((body) => console.log(`  [body ${kit.id}]`, JSON.stringify(body.slice(0, 90)))).catch(() => undefined);
      });
    }
    try {
      await page.goto(`http://kit-target.test:${port}/${neutral ? 'run-neutral' : 'run'}/${kit.id}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForFunction('window.__verdict !== undefined', { timeout: 12_000 }).catch(() => undefined);
      const verdict = await page.evaluate(() => (window as unknown as { __verdict?: boolean | string }).__verdict ?? 'page-timeout');
      const after = (receivedByHost.get('detector-vendor.test') ?? []).filter((p) => p === scriptPath).length;
      results.push({ kit: kit.id, verdict, kitScriptReceipts: after - before });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
  return results;
}

/** Baseline differential: aggressive-blocker sim MUST be detected; plain page MUST NOT. */
async function runBaselinePanel(browser: Browser, port: number): Promise<{ sim: Array<{ kit: string; verdict: boolean | string }>; plain: KitVerdict[] }> {
  const sim: Array<{ kit: string; verdict: boolean | string }> = [];
  for (const kit of KITS) {
    const page = await browser.newPage();
    try {
      await page.goto(`http://kit-target.test:${port}/baseline-sim/${kit.id}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForFunction('window.__verdict !== undefined', { timeout: 12_000 }).catch(() => undefined);
      const verdict = await page.evaluate(() => (window as unknown as { __verdict?: boolean | string }).__verdict ?? 'page-timeout');
      sim.push({ kit: kit.id, verdict });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
  const plain = await runKitPanel(browser, port);
  return { sim, plain };
}

interface LiveVerdict {
  url: string;
  pass?: number;
  reachable: boolean;
  saysBlocking?: boolean;
  saysClean?: boolean;
  error?: string;
}

async function liveVerdict(browser: Browser, url: string, pass?: number): Promise<LiveVerdict> {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 7000));
    const text = await page.evaluate('document.body ? document.body.innerText.slice(0, 600) : ""') as string;
    const saysBlocking = /you('re| are) blocking|adblock(er)? (is )?(detected|enabled|on)|disable (your )?ad/i.test(String(text));
    const saysClean = /not blocking|no ad ?block|adblock(er)? (is )?(not detected|disabled|off)|don'?t have/i.test(String(text));
    return { url, pass, reachable: true, saysBlocking, saysClean };
  } catch (error) {
    return { url, pass, reachable: false, error: String(error).slice(0, 160) };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function testerScore(browser: Browser): Promise<Record<string, unknown>> {
  const page = await browser.newPage();
  try {
    await page.goto('https://adblock-tester.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    const text = await page.evaluate('document.body ? document.body.innerText.slice(0, 3000) : ""') as string;
    const scoreMatch = String(text).match(/(\d{1,3})\s*\/\s*100/);
    return { reachable: true, score: scoreMatch ? Number(scoreMatch[1]) : null, rawExcerpt: String(text).slice(0, 300) };
  } catch (error) {
    return { reachable: false, error: String(error).slice(0, 160) };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(artifactDir, { recursive: true });
  const checks: Array<{ tier: string; name: string; pass: boolean | 'SKIP'; detail: string }> = [];
  const push = (tier: string, name: string, pass: boolean | 'SKIP', detail: string) => checks.push({ tier, name, pass, detail });

  const kitSources = await ensureKitCache();
  const fixtures = await startFixtureServer(kitSources);
  const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-detect-base-'));
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-detect-ext-'));

  try {
    // ---- Tier 0: baseline differential — the kits MUST fire under aggressive
    // bait hiding (functional) and MUST NOT fire on a plain page (no false positive).
    const baseline = await launchBrowser(baselineDir, false);
    const baselinePanel = await runBaselinePanel(baseline, fixtures.port);
    await baseline.close();
    for (const result of baselinePanel.sim) {
      push('T0-baseline', `${result.kit}: real kit fires under aggressive bait hiding (functional sanity)`,
        result.verdict === true,
        `verdict=${JSON.stringify(result.verdict)}`);
    }
    for (const result of baselinePanel.plain) {
      push('T0-baseline', `${result.kit}: no false positive on a plain page`,
        result.verdict === false,
        `verdict=${JSON.stringify(result.verdict)}`);
    }

    // ---- Tier 1: extension run — every kit must come back clean.
    const ext = await launchBrowser(extDir, true);
    const extResults = await runKitPanel(ext, fixtures.port);
    for (const result of extResults) {
      const neutralizedPreExecution = result.kitScriptReceipts === 0;
      push('T1-vendored-kit', `${result.kit}: no detection under the extension`,
        result.verdict === false || neutralizedPreExecution,
        `verdict=${JSON.stringify(result.verdict)}${neutralizedPreExecution ? ' (kit script redirected to the bundled defuser shim — nofab/nobab answer not-detected)' : ' (kit RAN and found its bait untouched — conservative cosmetic plane)'}`);
    }

    // ---- Tier 1b: same kit source under a filter-invisible name must actually
    // RUN and still not detect — this exercises the bait-refusal branch (the
    // conservative cosmetic plane refuses to hide bait classes; stealth-kit D1
    // pins the same property) rather than pre-execution blocking.
    const neutralResults = await runKitPanel(ext, fixtures.port, true);
    for (const result of neutralResults) {
      push('T1b-kit-live-bait', `${result.kit}: kit runs under a neutral name and finds its bait untouched`,
        result.verdict === false && result.kitScriptReceipts >= 1,
        `verdict=${JSON.stringify(result.verdict)} scriptReceipts=${result.kitScriptReceipts}`);
    }

    // ---- Tier 2: live verdict sites (gating when reachable).
    const live: LiveVerdict[] = [];
    live.push(await liveVerdict(ext, 'https://detectadblock.com/', 1));
    live.push(await liveVerdict(ext, 'https://detectadblock.com/', 2));
    live.push(await liveVerdict(ext, 'https://adblockanalytics.com/'));
    for (const verdict of live) {
      if (!verdict.reachable) {
        push('T2-live', `${new URL(verdict.url).hostname} ${verdict.pass ? `pass ${verdict.pass} ` : ''}— SKIP (unreachable)`,
          'SKIP', `error=${verdict.error ?? 'unreachable'}`);
        continue;
      }
      push('T2-live', `${new URL(verdict.url).hostname}${verdict.pass ? ` pass ${verdict.pass}` : ''}: site does not report blocking`,
        verdict.saysBlocking === false,
        `saysBlocking=${verdict.saysBlocking} saysClean=${verdict.saysClean}`);
    }

    // ---- Tier 3: tester score snapshot (report-only regression signal).
    const tester = await testerScore(ext);
    push('T3-report-only', 'adblock-tester.com blocking score snapshot (not gated)',
      tester.reachable === true || true, // never gates
      `reachable=${tester.reachable} score=${tester.score ?? 'unparsed'}/100`);

    await ext.close();

    // ---- Artifact --------------------------------------------------------------
    const pass = checks.every((check) => check.pass === true || check.pass === 'SKIP');
    fs.writeFileSync(
      path.join(artifactDir, 'REAL_DETECTORS_PROOF.json'),
      `${JSON.stringify({
        schema: 'kimi-real-detectors-proof-v1',
        ranAt: new Date().toISOString(),
        kitSources: KITS.map((kit) => ({ id: kit.id, fetchedFrom: new URL(kit.url).hostname })),
        baseline: baselinePanel,
        extension: extResults,
        extensionNeutralName: neutralResults,
        live,
        tester,
        checks,
        pass,
      }, null, 2)}\n`
    );
    for (const check of checks) console.log(`${check.pass === 'SKIP' ? 'SKIP' : check.pass ? 'PASS' : 'FAIL'}  [${check.tier}] ${check.name}\n      ${check.detail}`);
    console.log(`\nREAL DETECTORS ${pass ? 'PASS' : 'FAIL'} — artifacts: artifacts/kimi-persistent-learning/`);
    if (!pass) process.exitCode = 1;
  } catch (error) {
    fs.writeFileSync(
      path.join(artifactDir, 'REAL_DETECTORS_PROOF.json'),
      `${JSON.stringify({ schema: 'kimi-real-detectors-proof-v1', status: 'failed', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
    );
    throw error;
  } finally {
    await fixtures.close();
    fs.rmSync(baselineDir, { recursive: true, force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('REAL DETECTORS ERROR:', error);
  process.exitCode = 1;
});
