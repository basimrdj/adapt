/**
 * PHASE D1 VERIFICATION — deterministic stealth kit vs. real detector classes.
 *
 * Drives the REAL built extension (dist/) against self-hosted fixture pages that
 * implement the five canonical adblock-detector classes, plus controls:
 *
 *   D1  div-bait:        .adsbox + FuckAdBlock compound-class bait divs — detected
 *                        when a blocker hides them (offsetHeight 0 / display:none)
 *   D2  script-bait:     /ads.js + /advertisement.js — detected on script onerror
 *   D3  google-global:   real pagead2 adsbygoogle.js — detected unless
 *                        window.adsbygoogle.loaded === true after load
 *   D4  BAB-class:       /blockadblock.js + BlockAdBlock instance protocol —
 *                        detected when the detector script fails or fires onDetected
 *   D5  xhr-bait:        XHR GET /ads.txt — detected on request failure
 *   D6  iframe-bait:     /adframe.html sub_frame — detected on load failure
 *   D7  global-flags:    window.adblock / canRunAds / adsbygoogle stub probes
 *   CTL blocking intact: doubleclick img must STAY blocked; plain /app.js must load
 *
 * Causality is proven two ways:
 *   - the fixture server logs every request that actually arrives (redirected or
 *     blocked requests never reach it) — asserted per-run
 *   - a no-extension BASELINE run records each detector's raw behavior
 *
 * Real-site spot-check (best-effort, SKIPPED when offline): the public detector
 * demo pages from the bug report family (adblockanalytics.com, detectadblock.com).
 *
 * Artifact: artifacts/kimi-persistent-learning/STEALTH_KIT_PROOF.json (no hosts
 * beyond fixture labels; no credentials).
 *
 * Run: npm run build && npx tsx scripts/kimi-persistent-learning/verify-stealth-kit.ts
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { Browser } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const root = process.cwd();
const extensionPath = path.join(root, 'dist');
const artifactPath = path.join(root, 'artifacts', 'kimi-persistent-learning', 'STEALTH_KIT_PROOF.json');

/** Server-side arrival log — requests that were redirected/blocked never appear. */
const arrived: string[] = [];

const BAIT_404 = new Set(['/ads.js', '/advertisement.js', '/blockadblock.js', '/ads.txt', '/adframe.html']);

function makePage(name: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title></head>
<body><h1>${name}</h1><script>${body}</script></body></html>`;
}

const PAGES: Record<string, string> = {
  '/d1': makePage('d1-div-bait', `
    window.__result = undefined;
    var bait1 = document.createElement('div'); bait1.className = 'adsbox';
    bait1.style.cssText = 'position:absolute;left:0;top:0;width:300px;height:250px;';
    document.body.appendChild(bait1);
    var bait2 = document.createElement('div');
    bait2.className = 'pub_300x250 pub_300x250m pub_728x90 text-ad textAd text_ad text_ads text-ads text-ad-links ad-text adSense adBlock adContent adBanner';
    bait2.style.cssText = 'position:absolute;left:400px;top:0;width:300px;height:250px;';
    document.body.appendChild(bait2);
    setTimeout(function(){
      var hidden = function(el){
        var cs = getComputedStyle(el);
        return el.offsetHeight === 0 || el.offsetWidth === 0 || el.offsetParent === null
          || cs.display === 'none' || cs.visibility === 'hidden';
      };
      window.__result = { detected: hidden(bait1) || hidden(bait2),
        bait1Hidden: hidden(bait1), bait2Hidden: hidden(bait2) };
    }, 600);
  `),
  '/d2': makePage('d2-script-bait', `
    window.__result = undefined;
    var state = { adsJs: 'pending', advJs: 'pending' };
    function done(){ if (state.adsJs !== 'pending' && state.advJs !== 'pending') {
      window.__result = { detected: state.adsJs !== 'loaded' || state.advJs !== 'loaded', state: state };
    } }
    var s1 = document.createElement('script');
    s1.src = '/ads.js'; s1.onload = function(){ state.adsJs = 'loaded'; done(); };
    s1.onerror = function(){ state.adsJs = 'blocked'; done(); };
    document.head.appendChild(s1);
    var s2 = document.createElement('script');
    s2.src = '/advertisement.js'; s2.onload = function(){ state.advJs = 'loaded'; done(); };
    s2.onerror = function(){ state.advJs = 'blocked'; done(); };
    document.head.appendChild(s2);
    setTimeout(function(){ if (window.__result === undefined) {
      window.__result = { detected: true, state: state, timeout: true };
    } }, 4000);
  `),
  '/d3': makePage('d3-google-global', `
    window.__result = undefined;
    var s = document.createElement('script');
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
    var failed = false;
    s.onerror = function(){ failed = true; };
    document.head.appendChild(s);
    setTimeout(function(){
      var abg = window.adsbygoogle;
      var loaded = !!(abg && abg.loaded === true);
      window.__result = { detected: failed || !loaded, scriptFailed: failed, adsbygoogleLoaded: loaded };
    }, 2500);
  `),
  '/d4': makePage('d4-bab-class', `
    window.__result = undefined;
    var s = document.createElement('script');
    s.src = '/blockadblock.js';
    s.onerror = function(){ window.__result = { detected: true, scriptBlocked: true }; };
    s.onload = function(){
      try {
        if (typeof BlockAdBlock !== 'function') {
          window.__result = { detected: true, reason: 'no-BlockAdBlock-global' }; return;
        }
        var bab = new BlockAdBlock();
        var settled = false;
        bab.onDetected(function(){ if (!settled) { settled = true; window.__result = { detected: true, callback: 'onDetected' }; } });
        bab.onNotDetected(function(){ if (!settled) { settled = true; window.__result = { detected: false, callback: 'onNotDetected' }; } });
        setTimeout(function(){ if (!settled) { window.__result = { detected: true, reason: 'no-callback-settled' }; } }, 1500);
      } catch (e) { window.__result = { detected: true, reason: 'threw' }; }
    };
    document.head.appendChild(s);
    setTimeout(function(){ if (window.__result === undefined) window.__result = { detected: true, timeout: true }; }, 5000);
  `),
  '/d5': makePage('d5-xhr-bait', `
    window.__result = undefined;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/ads.txt', true);
      xhr.onload = function(){ window.__result = { detected: false, status: xhr.status }; };
      xhr.onerror = function(){ window.__result = { detected: true, error: true }; };
      xhr.send();
    } catch (e) { window.__result = { detected: true, threw: true }; }
    setTimeout(function(){ if (window.__result === undefined) window.__result = { detected: true, timeout: true }; }, 4000);
  `),
  '/d6': makePage('d6-iframe-bait', `
    window.__result = undefined;
    var f = document.createElement('iframe');
    f.src = '/adframe.html';
    f.onload = function(){ window.__result = { detected: false, loaded: true }; };
    f.onerror = function(){ window.__result = { detected: true, error: true }; };
    document.body.appendChild(f);
    setTimeout(function(){ if (window.__result === undefined) window.__result = { detected: true, timeout: true }; }, 4000);
  `),
  '/d7': makePage('d7-global-flags', `
    window.__result = undefined;
    setTimeout(function(){
      var probes = {
        adblock: window.adblock,
        canRunAds: window.canRunAds,
        isAdBlockActive: window.isAdBlockActive,
        adsbygoogleLoaded: !!(window.adsbygoogle && window.adsbygoogle.loaded === true),
        jobrunner: typeof window.google_jobrunner === 'object' && window.google_jobrunner !== null,
      };
      var detected = probes.adblock !== false || probes.canRunAds !== true
        || probes.isAdBlockActive !== false || !probes.adsbygoogleLoaded || !probes.jobrunner;
      window.__result = { detected: detected, probes: probes };
    }, 400);
  `),
  '/control': makePage('control-blocking-intact', `
    window.__result = undefined;
    var state = { appJs: 'pending', doubleclickImg: 'pending' };
    function done(){ if (state.appJs !== 'pending' && state.doubleclickImg !== 'pending') {
      window.__result = { detected: false, blockingIntact: state.doubleclickImg === 'blocked' && state.appJs === 'loaded', state: state };
    } }
    var s = document.createElement('script');
    s.src = '/app.js'; s.onload = function(){ state.appJs = 'loaded'; done(); };
    s.onerror = function(){ state.appJs = 'blocked'; done(); };
    document.head.appendChild(s);
    var img = new Image();
    img.src = 'https://googleads.g.doubleclick.net/pagead/ads?adapt=stealthctl';
    img.onload = function(){ state.doubleclickImg = 'loaded'; done(); };
    img.onerror = function(){ state.doubleclickImg = 'blocked'; done(); };
    setTimeout(function(){ if (state.doubleclickImg === 'pending') { state.doubleclickImg = 'timeout-treated-blocked'; done(); } }, 6000);
  `),
  '/d8': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>d8-vendor-bait</title></head>
<body><h1>d8 vendor-bait parse-time checker (trap territory)</h1>
<script type="text/javascript" src="https://www.adblockanalytics.com/google-adsense.js"></script>
<div id="adaptWallDiv01" style="display:none">You are blocking ads</div>
<div id="adaptOkDiv02" style="display:none">clean</div>
<script>
// Exact checker shape of the detectadblock.com / Adblock Analytics kit.
if (document.getElementById('adaptfixturebait42')) {
  document.getElementById('adaptOkDiv02').style.display = 'block';
  document.getElementById('adaptWallDiv01').style.display = 'none';
} else {
  document.getElementById('adaptOkDiv02').style.display = 'none';
  document.getElementById('adaptWallDiv01').style.display = 'block';
}
</script>
<script>
window.__result = undefined;
setTimeout(function(){
  var wall = document.getElementById('adaptWallDiv01');
  window.__result = { detected: getComputedStyle(wall).display !== 'none',
    baitPresent: !!document.getElementById('adaptfixturebait42') };
}, 1200);
</script></body></html>`,
  '/d9': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>d9-delayed-checker</title></head>
<body><h1>d9 vendor-bait delayed checker (learn + replay territory)</h1>
<script type="text/javascript" src="https://www.adblockanalytics.com/google-adsense.js"></script>
<div id="adaptWallDiv09" style="display:none">You are blocking ads</div>
<div id="adaptOkDiv09" style="display:none">clean</div>
<script>
// Same kit, but the probe runs in a timer — document.currentScript is null there,
// so the parse-time trap cannot fire; only learned replay covers this shape.
setTimeout(function () {
  if (document.getElementById('kq8zmvlaq3p7xwt2n')) {
    document.getElementById('adaptOkDiv09').style.display = 'block';
    document.getElementById('adaptWallDiv09').style.display = 'none';
  } else {
    document.getElementById('adaptOkDiv09').style.display = 'none';
    document.getElementById('adaptWallDiv09').style.display = 'block';
  }
}, 1400);
</script>
<script>
window.__result = undefined;
setTimeout(function(){
  var wall = document.getElementById('adaptWallDiv09');
  window.__result = { detected: getComputedStyle(wall).display !== 'none',
    baitPresent: !!document.getElementById('kq8zmvlaq3p7xwt2n') };
}, 2200);
</script></body></html>`,
};

async function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    arrived.push(url.pathname);
    if (url.pathname === '/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('window.__appJsLoaded = true;');
      return;
    }
    if (BAIT_404.has(url.pathname)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const page = PAGES[url.pathname];
    if (page) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function launchBrowser(userDataDir: string, withExtension: boolean): Promise<Browser> {
  return puppeteer.launch({
    headless: false,
    executablePath: chromeExecutable(root),
    userDataDir,
    args: [
      ...(withExtension ? [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] : ['--disable-extensions']),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
  });
}

interface DetectorResult {
  detected?: boolean;
  blockingIntact?: boolean;
  [key: string]: unknown;
}

const ROUTES = ['/d1', '/d2', '/d3', '/d4', '/d5', '/d6', '/d7', '/control'];

async function runSuite(browser: Browser, port: number): Promise<Record<string, DetectorResult>> {
  const page = await browser.newPage();
  const results: Record<string, DetectorResult> = {};
  for (const route of ROUTES) {
    try {
      await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForFunction('window.__result !== undefined', { timeout: 9000 });
      results[route] = (await page.evaluate('window.__result')) as DetectorResult;
    } catch (error) {
      results[route] = { detected: true, harnessError: String(error).slice(0, 120) };
    }
  }
  await page.close();
  return results;
}

async function spotCheckRealDetector(browser: Browser, url: string): Promise<Record<string, unknown>> {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 7000));
    const text = await page.evaluate('document.body ? document.body.innerText.slice(0, 600) : ""') as string;
    const saysBlocking = /you('re| are) blocking|adblock(er)? (is )?(detected|enabled|on)|disable (your )?ad/i.test(String(text));
    const saysClean = /not blocking|no ad ?block|adblock(er)? (is )?(not detected|disabled|off)|don'?t have/i.test(String(text));
    return { url, reachable: true, saysBlocking, saysClean, snippet: String(text).slice(0, 200) };
  } catch (error) {
    return { url, reachable: false, error: String(error).slice(0, 160) };
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const server = await startServer();
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-stealth-base-'));
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-stealth-ext-'));
  const failures: string[] = [];
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  try {
    // ---- Baseline (no extension): detectors observe the naked browser. ----------
    arrived.length = 0;
    const baseline = await launchBrowser(baseDir, false);
    const baselineResults = await runSuite(baseline, server.port);
    await baseline.close();
    const baselineArrived = [...arrived];
    report.baseline = { results: baselineResults, serverArrivals: baselineArrived };

    // Baseline sanity: bait resources must actually reach the server with no
    // extension (proves the fixtures exercise the network path).
    for (const bait of ['/ads.js', '/advertisement.js', '/blockadblock.js', '/ads.txt', '/adframe.html']) {
      if (!baselineArrived.includes(bait)) failures.push(`baseline: ${bait} never reached server — fixture broken`);
    }
    if (baselineResults['/d2']?.detected !== true) failures.push('baseline: d2 script-bait failed to detect a naked 404');
    if (baselineResults['/d4']?.detected !== true) failures.push('baseline: d4 BAB-class failed to detect a naked 404');
    if (baselineResults['/d7']?.detected !== true) failures.push('baseline: d7 global flags unexpectedly benign without extension');
    if (baselineResults['/d1']?.detected === true) failures.push('baseline: d1 div-bait detected with no blocker — fixture broken');

    // ---- Stealth run (real built extension). ------------------------------------
    arrived.length = 0;
    let ext = await launchBrowser(extDir, true);
    const stealthResults = await runSuite(ext, server.port);
    const stealthArrived = [...arrived];

    // D8 (phantom-marker trap, parse-time checker): the trap must neutralize the
    // checker on the FIRST visit — zero-escape for this detector class.
    const d8: Record<string, DetectorResult> = {};
    const d9: Record<string, DetectorResult> = {};
    {
      const page = await ext.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/d8`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForFunction('window.__result !== undefined', { timeout: 9000 });
      d8.visit1 = (await page.evaluate('window.__result')) as DetectorResult;
      await page.close();
    }
    // D9 (delayed checker): scan→learn→immediate-replay may save visit 1; the
    // learned profile must cover visit 2 and survive a full browser restart (3).
    {
      const page = await ext.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/d9`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForFunction('window.__result !== undefined', { timeout: 9000 });
      d9.visit1 = (await page.evaluate('window.__result')) as DetectorResult;
      if (process.env.ADAPT_STEALTH_KIT_DEBUG === '1') {
        const dbgTarget = (await ext.targets()).find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
        const dbgWorker = dbgTarget ? await dbgTarget.worker() : null;
        const dbg = dbgWorker ? await dbgWorker.evaluate(async () => {
          const forensics = (await chrome.storage.session.get('adapt_kimi_forensics_v1'))['adapt_kimi_forensics_v1'] as { counters?: Record<string, number>; events?: Array<{ kind: string; data?: unknown }> } | undefined;
          const profiles = (await chrome.storage.local.get('adapt_stealth_profiles_v1'))['adapt_stealth_profiles_v1'];
          return {
            profiles,
            stealthCounters: Object.fromEntries(Object.entries(forensics?.counters ?? {}).filter(([k]) => /stealth|REQ|blocked/i.test(k))),
            stealthEvents: (forensics?.events ?? []).filter((e) => /STEALTH|REQ_ERROR/.test(e.kind)).slice(-16),
          };
        }).catch((error) => ({ error: String(error) })) : { error: 'no worker' };
        console.log('  [d9-debug]', JSON.stringify(dbg).slice(0, 2500));
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      await page.goto(`http://127.0.0.1:${server.port}/d9`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForFunction('window.__result !== undefined', { timeout: 9000 });
      d9.visit2 = (await page.evaluate('window.__result')) as DetectorResult;
      await page.close();
    }
    // Persistence proof BEFORE closing: the learned profile must be in storage.local
    // (learn flushes immediately — a debounced write can die with the worker).
    const swTarget = (await ext.targets()).find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
    const sw = swTarget ? await swTarget.worker() : null;
    const persisted = sw ? await sw.evaluate(async () => {
      const stored = await chrome.storage.local.get('adapt_stealth_profiles_v1');
      const shape = stored['adapt_stealth_profiles_v1'] as { sites?: Record<string, { baitIds: string[] }> } | undefined;
      return Object.values(shape?.sites ?? {}).flatMap((site) => site.baitIds);
    }).catch(() => [] as string[]) : [];
    report.d9PersistedIds = persisted;
    await ext.close();
    ext = await launchBrowser(extDir, true);
    {
      const page = await ext.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/d9`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForFunction('window.__result !== undefined', { timeout: 9000 });
      d9.visit3AfterRestart = (await page.evaluate('window.__result')) as DetectorResult;
      await page.close();
    }
    report.d8Trap = d8;
    report.d9BaitReplay = d9;

    // Real-site spot checks (best-effort; never fail the suite on network).
    // detectadblock.com: two passes — pass 1 learns the live vendor bait id,
    // pass 2 replays it (escape-once semantics for the screenshot case).
    const detectFirst = await spotCheckRealDetector(ext, 'https://detectadblock.com/');
    const detectSecond = await spotCheckRealDetector(ext, 'https://detectadblock.com/');
    report.realSites = [
      await spotCheckRealDetector(ext, 'https://adblockanalytics.com/'),
      { ...detectFirst, pass: 1 },
      { ...detectSecond, pass: 2 },
    ];
    await ext.close();
    report.stealth = { results: stealthResults, serverArrivals: stealthArrived };

    // D1: bait divs must remain unhidden.
    if (stealthResults['/d1']?.detected !== false) failures.push(`d1 div-bait DETECTED under extension: ${JSON.stringify(stealthResults['/d1'])}`);
    // D2: bait scripts redirect to noop.js — onload, never reach the server.
    if (stealthResults['/d2']?.detected !== false) failures.push(`d2 script-bait DETECTED: ${JSON.stringify(stealthResults['/d2'])}`);
    for (const bait of ['/ads.js', '/advertisement.js']) {
      if (stealthArrived.includes(bait)) failures.push(`d2: ${bait} reached the server — redirect did not fire`);
    }
    // D3: adsbygoogle shim provides loaded=true.
    if (stealthResults['/d3']?.detected !== false) failures.push(`d3 google-global DETECTED: ${JSON.stringify(stealthResults['/d3'])}`);
    // D4: BAB defuser settles onNotDetected, script never reaches the server.
    if (stealthResults['/d4']?.detected !== false) failures.push(`d4 BAB-class DETECTED: ${JSON.stringify(stealthResults['/d4'])}`);
    if (stealthArrived.includes('/blockadblock.js')) failures.push('d4: /blockadblock.js reached the server — defuser redirect did not fire');
    // D5/D6: bait subresources resolve through shims without server contact.
    if (stealthResults['/d5']?.detected !== false) failures.push(`d5 xhr-bait DETECTED: ${JSON.stringify(stealthResults['/d5'])}`);
    if (stealthResults['/d6']?.detected !== false) failures.push(`d6 iframe-bait DETECTED: ${JSON.stringify(stealthResults['/d6'])}`);
    // D7: deterministic global flags seeded.
    if (stealthResults['/d7']?.detected !== false) failures.push(`d7 global-flags DETECTED: ${JSON.stringify(stealthResults['/d7'])}`);
    // CTL: blocking plane intact — doubleclick stays blocked, normal script loads.
    if (stealthResults['/control']?.blockingIntact !== true) failures.push(`control: blocking plane weakened: ${JSON.stringify(stealthResults['/control'])}`);
    // D8: phantom-marker trap — parse-time checker neutralized from the first visit.
    if (d8.visit1?.detected !== false) failures.push(`d8 visit1: trap failed on parse-time checker: ${JSON.stringify(d8.visit1)}`);
    if (d8.visit1?.baitPresent !== true) failures.push(`d8 visit1: no phantom marker created: ${JSON.stringify(d8.visit1)}`);
    // D9: delayed checker — learn + replay path. Visit 1 may be saved by immediate
    // replay (baitPresent proves learn happened); visit 2 + post-restart 3 must pass.
    if (d9.visit1?.baitPresent !== true) failures.push(`d9 visit1: learn+replay never materialized: ${JSON.stringify(d9.visit1)}`);
    if (d9.visit2?.detected !== false) failures.push(`d9 visit2: learned bait replay failed: ${JSON.stringify(d9.visit2)}`);
    if (!persisted.includes('kq8zmvlaq3p7xwt2n')) failures.push(`d9: bait id not persisted to storage.local before close: ${JSON.stringify(persisted)}`);
    if (d9.visit3AfterRestart?.detected !== false) failures.push(`d9 visit3 (after restart): replay not persistent: ${JSON.stringify(d9.visit3AfterRestart)}`);

    report.verdict = failures.length === 0 ? 'PASS' : 'FAIL';
    report.failures = failures;
  } finally {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2));
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
    await server.close();
  }

  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    console.error(`\nSTEALTH KIT: FAIL (${failures.length})`);
    for (const failure of failures) console.error('  -', failure);
    process.exit(1);
  }
  console.log('\nSTEALTH KIT: PASS — all 7 detector classes neutralized, blocking plane intact');
}

await main();
