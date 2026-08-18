/**
 * BRUTAL REAL-WORLD RUN — drives the REAL built extension through 20 ad-heavy
 * publisher sites in a persistent Chrome for Testing profile, then revisits the
 * first three to measure adaptation. No benchmark/tester source involved — these
 * are ordinary public sites browsed like a user would.
 *
 *   batch A: sites 1–10  (fresh profile)
 *   batch B: sites 11–20 in the SAME profile (cross-restart durability of the
 *            learning from batch A comes free), then revisits sites 1–3
 *
 * Per site: land → best-effort consent accept → ~18s settle → scroll → one
 * internal article navigation → ~12s → snapshot worker counters.
 *
 * Writes artifacts/kimi-persistent-learning/realworld/batch{A,B}.json.
 * Artifact hygiene: hosts projected to first DNS labels; no credentials.
 *
 * Run: npx tsx scripts/kimi-persistent-learning/brutal-realworld-run.ts --batch=A
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { Browser } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const SITES = [
  'news4jax.com', 'nj1015.com', 'tomandlorenzo.com', 'visualcapitalist.com', 'byrdie.com',
  'koreaboo.com', 'stocktwits.com', 'oregonlive.com', 'mlive.com', 'masslive.com',
  'ndtv.com', 'thesun.co.uk', 'dailymail.co.uk', 'fandom.com', 'weather.com',
  'tmz.com', 'forbes.com', 'torontosun.com', 'kentonline.co.uk', 'wnd.com',
];

const root = process.cwd();
const extensionPath = path.join(root, 'dist');
const outDir = path.join(root, 'artifacts', 'kimi-persistent-learning', 'realworld');
const PROFILE = path.join(os.tmpdir(), 'adapt-realworld-brutal-profile');

const batch = process.argv.includes('--batch=C') ? 'C' : process.argv.includes('--batch=B') ? 'B' : 'A';
// Batch C: recovery after the tmz browser crash — snapshot surviving durable state
// first (crash-durability proof), then the remaining sites, then the revisits.
const siteList = batch === 'A' ? SITES.slice(0, 10) : batch === 'B' ? SITES.slice(10) : SITES.slice(16);
const revisits = batch === 'B' || batch === 'C' ? SITES.slice(0, 3) : [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluateWorker<T>(browser: Browser, expression: string): Promise<T> {
  const deadline = Date.now() + 12_000;
  let lastError = 'extension worker unavailable';
  while (Date.now() < deadline) {
    const target = browser.targets().find((item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'));
    if (target) {
      const client = await target.createCDPSession();
      try {
        const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (!response.exceptionDetails) return response.result.value as T;
        lastError = response.exceptionDetails.exception?.description || 'worker evaluation failed';
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        await client.detach().catch(() => undefined);
      }
    }
    await sleep(200);
  }
  throw new Error(lastError);
}

interface DurableRow {
  ruleId: number;
  lifecycle: string;
  hostWide: boolean;
  family: string;
  scoped: boolean;
  siteKeys: number;
  matchCount: number;
  refusal: string | null;
  revoked: string | null;
}

interface Snapshot {
  counters: Record<string, number>;
  durable: DurableRow[];
  personalRuleCount: number;
}

async function snapshot(browser: Browser): Promise<Snapshot> {
  const artifact = await evaluateWorker<{ counters?: Record<string, number> } | null>(
    browser,
    'chrome.storage.session.get("adapt_kimi_forensics_v1").then((r) => r.adapt_kimi_forensics_v1 ?? null)'
  ).catch(() => null);
  const durable = await evaluateWorker<DurableRow[]>(
    browser,
    `chrome.storage.local.get("adapt_dnr_dynamic_v1").then((r) => { const f = r.adapt_dnr_dynamic_v1; return f ? Object.values(f.rules).map((x) => ({ ruleId: x.ruleId, lifecycle: x.lifecycle, hostWide: x.hostWide, family: (x.host || "").split(".")[0], scoped: Array.isArray(x.initiatorDomains) && x.initiatorDomains.length > 0, siteKeys: (x.observedSiteKeys || []).length, matchCount: x.matchCount, refusal: x.widthRefusalReason ?? null, revoked: x.revokedReason ?? null })) : []; })`
  ).catch(() => [] as DurableRow[]);
  const personalRuleCount = durable.filter((row) => row.lifecycle === 'PERSISTED_DYNAMIC' || row.lifecycle === 'DEMOTED').length;
  return { counters: artifact?.counters ?? {}, durable, personalRuleCount };
}

const TRACKED_COUNTERS = [
  'aiCallsStarted', 'aiCallsSucceeded', 'sessionRulesInstalled', 'learnedSessionProtections',
  'dynamicRulesPromoted', 'learnedRuleMatches', 'hostLevelRuleMatches', 'rulesGlobalized',
  'crossSiteFamilyRecurrence', 'learnedFamilyAiAvoided', 'rollbackOnRegression', 'rulesRevoked',
  'totalRequestsObserved', 'failedRequests', 'successfulRequests', 'thirdPartyRequests',
];

function deltaCounters(prev: Record<string, number>, next: Record<string, number>): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const key of TRACKED_COUNTERS) delta[key] = (next[key] ?? 0) - (prev[key] ?? 0);
  return delta;
}

interface SiteRecord {
  site: string;
  revisit: boolean;
  navError: string | null;
  consentClicked: boolean;
  clickedThrough: boolean;
  delta: Record<string, number>;
  personalRuleCount: number;
}

async function visitSite(browser: Browser, site: string, revisit: boolean, prev: Record<string, number>): Promise<SiteRecord> {
  const page = await browser.newPage();
  let navError: string | null = null;
  let consentClicked = false;
  let clickedThrough = false;
  try {
    await page.goto(`https://${site}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((error) => {
      navError = error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120);
    });
    await sleep(4000);
    // Best-effort consent accept so the page behaves like a real visit.
    consentClicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, a')];
      const target = buttons.find((node) => {
        const text = (node.textContent ?? '').trim();
        return text.length > 0 && text.length < 32 && /accept all|accept|i agree|agree|consent|got it/i.test(text);
      });
      if (target) { (target as HTMLElement).click(); return true; }
      return false;
    }).catch(() => false);
    await sleep(14_000);
    await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => undefined);
    await sleep(1500);
    await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => undefined);
    await sleep(1500);
    // One internal article navigation — the recurrence/promotion opportunity.
    const href = await page.evaluate(() => {
      const origin = location.origin;
      const links = [...document.querySelectorAll('a[href]')]
        .map((node) => (node as HTMLAnchorElement).href)
        .filter((link) => {
          try {
            const url = new URL(link);
            return url.origin === origin && url.pathname.length > 15 && !url.pathname.includes('#') && !/signin|login|subscribe|newsletter/i.test(url.pathname);
          } catch { return false; }
        });
      const unique = [...new Set(links)];
      return unique[Math.floor(Math.random() * Math.min(unique.length, 10))] ?? null;
    }).catch(() => null);
    if (href) {
      clickedThrough = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30_000 }).then(() => true).catch(() => false);
      await sleep(12_000);
    }
  } finally {
    const snap = await snapshot(browser);
    const record: SiteRecord = {
      site, revisit, navError, consentClicked, clickedThrough,
      delta: deltaCounters(prev, snap.counters),
      personalRuleCount: snap.personalRuleCount,
    };
    await page.close().catch(() => undefined);
    return record;
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromeExecutable(root),
    userDataDir: PROFILE,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
  });
  const records: SiteRecord[] = [];
  try {
    await evaluateWorker(browser, '1'); // confirm the extension worker is alive
    const bootSnap = await snapshot(browser);
    if (batch === 'C') {
      console.log(`CRASH-SURVIVAL: durableRules=${bootSnap.durable.length} persisted=${bootSnap.durable.filter((d) => d.lifecycle === 'PERSISTED_DYNAMIC').length} families=${JSON.stringify(bootSnap.durable.map((d) => `${d.family}:${d.lifecycle.slice(0, 9)}:m${d.matchCount}`))}`);
    }
    let prevCounters: Record<string, number> = bootSnap.counters;
    for (const site of siteList) {
      const record = await visitSite(browser, site, false, prevCounters);
      records.push(record);
      prevCounters = (await snapshot(browser)).counters;
      console.log(`${site}: ai=${record.delta.aiCallsStarted ?? 0} staged=${record.delta.sessionRulesInstalled ?? 0} promoted=${record.delta.dynamicRulesPromoted ?? 0} matches=${record.delta.learnedRuleMatches ?? 0} blockedReq=${record.delta.failedRequests ?? 0} learned=${record.personalRuleCount}${record.navError ? ' NAVERR' : ''}`);
    }
    for (const site of revisits) {
      const record = await visitSite(browser, site, true, prevCounters);
      records.push(record);
      prevCounters = (await snapshot(browser)).counters;
      console.log(`REVISIT ${site}: ai=${record.delta.aiCallsStarted ?? 0} matches=${record.delta.learnedRuleMatches ?? 0} avoided=${record.delta.learnedFamilyAiAvoided ?? 0} blockedReq=${record.delta.failedRequests ?? 0} learned=${record.personalRuleCount}`);
    }
    const finalSnap = await snapshot(browser);
    const out = {
      schema: 'adapt-realworld-brutal-v1',
      batch,
      ranAt: new Date().toISOString(),
      bootSnapshot: batch === 'C' ? bootSnap : undefined,
      sites: records,
      finalCounters: finalSnap.counters,
      durableRules: finalSnap.durable,
      personalRuleCount: finalSnap.personalRuleCount,
    };
    fs.writeFileSync(path.join(outDir, `batch${batch}.json`), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`\nBATCH ${batch} DONE — learnedRules=${finalSnap.personalRuleCount} durable=${finalSnap.durable.length} → artifacts/kimi-persistent-learning/realworld/batch${batch}.json`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('REALWORLD RUN ERROR:', error);
  process.exitCode = 1;
});
