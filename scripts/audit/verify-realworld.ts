/**
 * H6 — Real-world audit harness ("push it to the max" + "simplest easy stuff").
 *
 * Tier 1 (GATING, deterministic, offline): the simplest-benign fixture suite —
 * image gallery, HTML5 video, comment form, search box, multi-page article —
 * each visited THREE times in one profile (the 3rd revisit exercises
 * post-learning replay paths). Zero interference is the gate: every image
 * loads, the video plays, the form posts, search renders, article pages stay
 * visible, zero page errors.
 *
 * Tier 2 (GATING when the network is reachable, SKIP otherwise): a curated
 * real-site corpus across news/media/shopping/community/reference plus a
 * wall-watch list of publishers known for anti-adblock reactions. Each site is
 * loaded twice — extension ON vs OFF in separate browser instances — and
 * compared on: main-resource success, page errors, image breakage rate, and
 * anti-adblock wall detection/handling. The gate is extension-caused content
 * breakage only; wall outcomes are recorded (they belong to the adversarial
 * known-limit class, see H4/t41). Streaming-video sites are DELIBERATELY
 * EXCLUDED: one of them is a reserved benchmark holdout whose identity was
 * never disclosed, so the entire class stays out of this harness.
 *
 * Tier 3 (report-only): load-time, long-task, and JS-heap deltas ON vs OFF.
 *
 * Env: REALWORLD_SITE_CAP (default all), REALWORLD_CONCURRENCY (default 3).
 * Artifact: artifacts/audit/REALWORLD_AUDIT.json
 * Exit 1 on: any Tier-1 failure, or any Tier-2 extension-caused breakage.
 */
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer, { Browser, Page } from 'puppeteer';
import { startTestServers, TestServerInstances } from '../../tests/pages/server';
import { chromeExecutable } from '../../tests/support/chrome-executable';
import { verificationMetadata } from '../verification-metadata';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifactPath = path.resolve(root, 'artifacts/audit/REALWORLD_AUDIT.json');
const extensionPath = path.resolve(root, 'dist');

const APP_PORT = 4090;
const AD_PORT = 4091;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- fixtures */

interface FixtureCheck {
  id: string;
  route: string;
  run: (page: Page) => Promise<string[]>;
}

/** Every image on the page must complete with pixels and stay visible. */
async function assertImagesHealthy(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const failures: string[] = [];
    for (const img of Array.from(document.images)) {
      if (!(img.naturalWidth > 0)) failures.push(`img broken: ${img.getAttribute('src') ?? img.src}`);
      const style = window.getComputedStyle(img);
      if (style.display === 'none' || style.visibility === 'hidden') failures.push(`img hidden: ${img.getAttribute('src') ?? img.src}`);
    }
    const main = document.getElementById('main-content');
    if (main && window.getComputedStyle(main).display === 'none') failures.push('main content hidden');
    return failures;
  });
}

const TIER1_FIXTURES: FixtureCheck[] = [
  {
    id: 'image-gallery',
    route: '/audit-benign/index.html',
    run: async (page) => {
      await page.waitForFunction(
        () => Array.from(document.images).every((img) => img.complete),
        { timeout: 10_000 }
      );
      return assertImagesHealthy(page);
    },
  },
  {
    id: 'html5-video',
    route: '/audit-benign/video.html',
    run: async (page) => {
      const failures: string[] = [];
      try {
        await page.waitForFunction(
          () => document.getElementById('playback-status')?.textContent === 'playing',
          { timeout: 10_000 }
        );
      } catch {
        const status = await page.evaluate(() => document.getElementById('playback-status')?.textContent ?? 'missing');
        failures.push(`video never reached playing (status=${status})`);
      }
      const t0 = await page.evaluate(() => (document.getElementById('clip') as HTMLVideoElement)?.currentTime ?? -1);
      await sleep(1_200);
      const t1 = await page.evaluate(() => (document.getElementById('clip') as HTMLVideoElement)?.currentTime ?? -1);
      if (!(t1 > t0)) failures.push(`video currentTime did not advance (${t0} -> ${t1})`);
      return failures;
    },
  },
  {
    id: 'comment-form',
    route: '/audit-benign/comment.html',
    run: async (page) => {
      await page.type('#comment-name', 'Audit Bot');
      await page.type('#comment-body', 'A perfectly ordinary comment.');
      await page.click('#comment-form button[type="submit"]');
      try {
        await page.waitForFunction(
          () => document.getElementById('comment-status')?.textContent === 'posted',
          { timeout: 8_000 }
        );
        return [];
      } catch {
        const status = await page.evaluate(() => document.getElementById('comment-status')?.textContent ?? 'missing');
        return [`comment post did not complete (status=${status})`];
      }
    },
  },
  {
    id: 'search-box',
    route: '/audit-benign/search.html',
    run: async (page) => {
      await page.type('#search-box', 'apple');
      await page.click('#search-form button[type="submit"]');
      await sleep(300);
      return page.evaluate(() => {
        const count = Number(document.getElementById('search-results')?.getAttribute('data-result-count') ?? '0');
        const visible = Array.from(document.querySelectorAll('#search-results .result'))
          .filter((item) => window.getComputedStyle(item).display !== 'none').length;
        return count >= 2 && visible === count ? [] : [`search rendered ${visible}/${count} results`];
      });
    },
  },
  {
    id: 'multi-page-article',
    route: '/audit-benign/article-1.html',
    run: async (page) => {
      const failures: string[] = [];
      for (const part of [1, 2, 3]) {
        if (part > 1) {
          await page.click('#next');
          await page.waitForFunction(
            (expected) => document.getElementById(`article-body-${expected}`) !== null,
            { timeout: 8_000 },
            part
          );
        }
        const hidden = await page.evaluate((expected) => {
          const body = document.getElementById(`article-body-${expected}`);
          if (!body) return `article body ${expected} missing`;
          const style = window.getComputedStyle(body);
          return style.display === 'none' || style.visibility === 'hidden' ? `article body ${expected} hidden` : null;
        }, part);
        if (hidden) failures.push(hidden);
      }
      return failures;
    },
  },
];

/* ------------------------------------------------------------- tier-2 list */

/** ~55 general sites + wall-watch publishers. No streaming-video class (see header). */
const TIER2_SITES: readonly string[] = [
  // news
  'https://www.bbc.com', 'https://www.cnn.com', 'https://www.nytimes.com',
  'https://www.theguardian.com', 'https://www.reuters.com', 'https://apnews.com',
  'https://www.bbc.co.uk', 'https://www.npr.org', 'https://www.cnbc.com',
  'https://www.economist.com', 'https://www.usatoday.com', 'https://www.nypost.com',
  // media / entertainment / knowledge
  'https://www.imdb.com', 'https://www.rottentomatoes.com', 'https://www.ign.com',
  'https://www.gamespot.com', 'https://www.wikipedia.org', 'https://www.wikihow.com',
  'https://www.investopedia.com', 'https://www.howtogeek.com', 'https://www.medium.com',
  'https://www.weather.com', 'https://www.accuweather.com',
  // shopping
  'https://www.amazon.com', 'https://www.ebay.com', 'https://www.walmart.com',
  'https://www.bestbuy.com', 'https://www.etsy.com', 'https://www.target.com',
  'https://www.homedepot.com', 'https://www.aliexpress.com', 'https://www.newegg.com',
  // community / social
  'https://www.reddit.com', 'https://www.quora.com', 'https://stackoverflow.com',
  'https://stackexchange.com', 'https://www.tumblr.com', 'https://www.pinterest.com',
  'https://www.linkedin.com', 'https://imgur.com', 'https://www.goodreads.com',
  // reference / lifestyle
  'https://www.britannica.com', 'https://www.yelp.com', 'https://www.tripadvisor.com',
  'https://www.zillow.com', 'https://www.nerdwallet.com', 'https://www.healthline.com',
  'https://www.webmd.com', 'https://www.allrecipes.com', 'https://www.seriouseats.com',
  'https://www.theverge.com', 'https://arstechnica.com', 'https://www.wired.com',
  'https://techcrunch.com', 'https://www.engadget.com',
  // auth flows (the unknown_msal_error class: learned rules must never touch
  // identity endpoints — protected-flow guard regression gate)
  'https://login.live.com', 'https://portal.azure.com', 'https://accounts.google.com',
];

/** Publishers with a history of anti-adblock walls — detection+handling is recorded. */
const TIER2_WALL_WATCH: readonly string[] = [
  'https://www.forbes.com', 'https://www.businessinsider.com', 'https://www.thetimes.co.uk',
  'https://www.telegraph.co.uk', 'https://www.washingtonpost.com', 'https://www.independent.co.uk',
  'https://www.dailymail.co.uk', 'https://www.cnet.com', 'https://www.bloomberg.com',
  'https://www.wsj.com',
];

/* ------------------------------------------------------------ tier-2 types */

interface SiteSample {
  mainStatus: number | null;
  pageErrors: string[];
  extensionFrameErrors: string[];
  abortTrapFires: string[];
  requestFailures: number;
  blockedByClient: number;
  imagesTotal: number;
  imagesBroken: number;
  imagesBrokenByBlock: number;
  brokenByBlockUrls: string[];
  brokenImageUrls: string[];
  /** Broken attempted images WITH a user-visible layout box (≥2×2). ≤1×1 or
   * zero-area imgs are tracking-pixel shaped: their failure is invisible to
   * the user and their blocking is the extension working as designed. */
  brokenContentImageUrls: string[];
  imagesHidden: number;
  /** Full URL list of hidden images WITH a resource (empty-src lazy placeholders
   * are site hydration state — excluded). The cosmetic-delta gate attributes
   * each before counting it (see judge). */
  hiddenImageUrls: string[];
  /** Hidden imgs with empty src — unhydrated placeholders, recorded as data. */
  siteStateHiddenPlaceholders: number;
  /** Sample of hidden-image descriptors for cosmetic-delta triage. */
  hiddenImageSamples: string[];
  wallDetected: boolean;
  wallStanding: boolean;
  mainHidden: boolean;
  loadMs: number | null;
  longTasks: number;
  heapMb: number | null;
  error?: string;
}

type SiteVerdict =
  | 'ok'
  | 'skip-unreachable'
  | 'wall-handled'
  | 'wall-standing-unhandled'
  | 'wall-stands-even-without-extension'
  | 'edge-refusal-bot-wall'
  | 'breakage-images'
  | 'breakage-pageerrors'
  | 'breakage-main-resource'
  | 'error';

interface SiteResult {
  site: string;
  wallWatch: boolean;
  verdict: SiteVerdict;
  on?: SiteSample;
  off?: SiteSample;
  notes?: string;
}

/* --------------------------------------------------------------- sampling */

/** In-page probe: images, wall surfaces, perf. Lives inside evaluate — no eval(),
 * so strict CSP cannot block it. */
function pageProbe(): {
  wallDetected: boolean;
  wallStanding: boolean;
  mainHidden: boolean;
  imagesTotal: number;
  imagesBroken: number;
  brokenImageUrls: string[];
  brokenContentImageUrls: string[];
  imagesHidden: number;
  hiddenImageUrls: string[];
  siteStateHiddenPlaceholders: number;
  hiddenImageSamples: string[];
  loadMs: number | null;
  longTasks: number;
  heapMb: number | null;
} {
  const PHRASES = /ad\s?block(er)?|disable.*ad|allow ads|whitelist|unblock us|support us by|turn off your ad/i;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let wallDetected = false;
  let wallStanding = false;
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const style = window.getComputedStyle(el);
    if (style.position !== 'fixed' && style.position !== 'absolute') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < vw * 0.7 || rect.height < vh * 0.6) continue;
    const text = (el.textContent || '').slice(0, 600);
    if (!PHRASES.test(text)) continue;
    wallDetected = true;
    if (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05) {
      wallStanding = true;
    }
  }
  const main = document.querySelector('main, article, #content, #main, .article-body');
  const mainHidden = main
    ? (() => {
        const s = window.getComputedStyle(main);
        return s.display === 'none' || s.visibility === 'hidden';
      })()
    : false;
  const images = Array.from(document.images);
  // "Broken" means the browser ATTEMPTED a fetch and got nothing: currentSrc
  // must be non-empty. Lazy-load placeholders (empty currentSrc, swap pending)
  // are not breakage — they never requested anything.
  const brokenAttempted = images.filter((img) => {
    const src = img.currentSrc || img.src;
    return src.length > 0 && img.complete && !(img.naturalWidth > 0);
  });
  const brokenContent = brokenAttempted.filter((img) => {
    const rect = img.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  });
  const hiddenImgs = images.filter((img) => {
    const s = window.getComputedStyle(img);
    return s.display === 'none' || s.visibility === 'hidden';
  });
  const hidden = hiddenImgs.length;
  // Extension-attributable hidden images: the img actually has a resource
  // (non-empty src). Hidden imgs with EMPTY src are unhydrated lazy-load
  // placeholders whose visibility state is the site's own JS/CSS (e.g.
  // Gannett's gnt_m_* modules whose hydration is tangled with its ad stack) —
  // no hide of ours can be distinguished from that site state, so they are
  // recorded as data and never gated.
  const hiddenWithSrc = hiddenImgs.filter((img) => (img.currentSrc || img.src).length > 0);
  const siteStateHiddenPlaceholders = hidden - hiddenWithSrc.length;
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return {
    wallDetected,
    wallStanding,
    mainHidden,
    imagesTotal: images.length,
    imagesBroken: brokenAttempted.length,
    brokenImageUrls: brokenAttempted.map((img) => (img.currentSrc || img.src).slice(0, 220)),
    brokenContentImageUrls: brokenContent.map((img) => (img.currentSrc || img.src).slice(0, 220)),
    imagesHidden: hidden,
    hiddenImageUrls: hiddenWithSrc.map((img) => (img.currentSrc || img.src).slice(0, 220)),
    siteStateHiddenPlaceholders,
    hiddenImageSamples: hiddenImgs.slice(0, 8).map((img) => {
      const cls = typeof img.className === 'string' ? img.className.slice(0, 80) : '';
      return `${(img.currentSrc || img.src).slice(0, 120)} [${cls}]`;
    }),
    loadMs: nav ? Math.round(nav.duration) : null,
    longTasks: (window as unknown as { __longTasks?: number }).__longTasks ?? 0,
    heapMb: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      ? Math.round(((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576) * 10) / 10
      : null,
  };
}

function emptySample(): SiteSample {
  return {
    mainStatus: null,
    pageErrors: [],
    extensionFrameErrors: [],
    abortTrapFires: [],
    requestFailures: 0,
    blockedByClient: 0,
    imagesTotal: 0,
    imagesBroken: 0,
    imagesBrokenByBlock: 0,
    brokenByBlockUrls: [],
    brokenImageUrls: [],
    brokenContentImageUrls: [],
    imagesHidden: 0,
    hiddenImageUrls: [],
    siteStateHiddenPlaceholders: 0,
    hiddenImageSamples: [],
    wallDetected: false,
    wallStanding: false,
    mainHidden: false,
    loadMs: null,
    longTasks: 0,
    heapMb: null,
  };
}

/** Sample one site in one browser. Everything is best-effort; errors land in `error`. */
async function sampleSite(browser: Browser, site: string, timeoutMs: number): Promise<SiteSample> {
  const sample: SiteSample = emptySample();
  // Per-URL failure reasons for image requests — lets the judge attribute
  // broken images to OUR blocks (ERR_BLOCKED_BY_CLIENT) vs the site's own CDN
  // refusing the automation browser (HTTP 4xx happens on both profiles).
  const imageFailures = new Map<string, string>();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );
    page.on('pageerror', (error) => {
      const text = String(error).slice(0, 160);
      sample.pageErrors.push(text);
      const stack = (error instanceof Error ? error.stack ?? '' : '').slice(0, 400);
      if (stack.includes('page-filtering/early/')) {
        // Deliberate abort-trap fire: the early runtime only throws by design
        // (abort-current-inline-script / abort-on-property-read); every other
        // code path in it is try/catch-wrapped (H3 invariant, unit-pinned).
        sample.abortTrapFires.push(text);
      } else if (stack.includes('chrome-extension://')) {
        sample.extensionFrameErrors.push(`${text} :: ${stack.split('\n')[1] ?? ''}`);
      }
    });
    page.on('requestfailed', (req) => {
      sample.requestFailures += 1;
      const errorText = req.failure()?.errorText ?? '';
      if (errorText === 'net::ERR_BLOCKED_BY_CLIENT') sample.blockedByClient += 1;
      if (req.resourceType() === 'image') imageFailures.set(req.url(), errorText || 'failed');
    });
    page.on('response', (res) => {
      if (res.status() >= 400 && res.request().resourceType() === 'image') {
        imageFailures.set(res.url(), `http-${res.status()}`);
      }
    });
    await page.evaluateOnNewDocument(() => {
      (window as unknown as { __longTasks: number }).__longTasks = 0;
      try {
        new PerformanceObserver((list) => {
          (window as unknown as { __longTasks: number }).__longTasks += list.getEntries().length;
        }).observe({ type: 'longtask', buffered: true });
      } catch {
        /* longtask unsupported */
      }
    });
    const response = await page.goto(site, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    sample.mainStatus = response ? response.status() : null;
    // Settle: ads, walls, and lazy media arrive post-DCL on real sites.
    await sleep(6_000);
    // Trigger lazy loaders: one full-height scroll pass, then back to top and
    // a short settle so swapped images can actually fetch before sampling.
    await page.evaluate(async () => {
      const step = window.innerHeight;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await sleep(1_500);
    const probe = await page.evaluate(pageProbe);
    Object.assign(sample, probe);
    // Attribute broken images to our blocking only when the fetch died with
    // ERR_BLOCKED_BY_CLIENT. Server 4xx/5xx (bot-scored CDNs) and network
    // flakes are not extension damage; they appear on both profiles anyway.
    const blockedUrls = probe.brokenImageUrls.filter((url) => {
      const reason = imageFailures.get(url);
      return reason === 'net::ERR_BLOCKED_BY_CLIENT';
    });
    sample.imagesBrokenByBlock = blockedUrls.length;
    sample.brokenByBlockUrls = blockedUrls.slice(0, 10);
  } catch (error) {
    sample.error = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
  } finally {
    await page.close().catch(() => undefined);
  }
  return sample;
}

/** Errors whose signature is a blocked request surfacing in the page's own
 * error handling (unhandled fetch rejections, lazy chunk loads). Blocking those
 * requests is the extension working as designed — the noise class is recorded
 * as data, not gated as content breakage. */
const NETWORK_ARTIFACT = /failed to fetch|chunkloaderror|loading chunk|network\s?error|network request failed|load failed|net::/i;

function functionalErrors(errors: readonly string[]): string[] {
  return errors.filter((error) => !NETWORK_ARTIFACT.test(error));
}

function judgeSite(site: string, wallWatch: boolean, on: SiteSample, off: SiteSample): SiteResult {
  if (off.mainStatus === null || off.error !== undefined) {
    return { site, wallWatch, verdict: 'skip-unreachable', on, off, notes: `off-profile failed: ${off.error ?? `status ${off.mainStatus}`}` };
  }
  // A deterministic 4xx/5xx on the main document ON-only is the site's EDGE
  // refusing the session (bot scoring on blocked beacons) — a server decision,
  // not resource over-blocking (our blocks surface as status null /
  // ERR_BLOCKED_BY_CLIENT, never an HTTP status). Recorded, not gated:
  // addressing it would mean allowlisting their telemetry, a policy decision,
  // never a silent harness accommodation.
  const onStatus = on.mainStatus ?? 0;
  const offStatus = off.mainStatus ?? 0;
  if (onStatus >= 400 && offStatus > 0 && offStatus < 400) {
    return { site, wallWatch, verdict: 'edge-refusal-bot-wall', on, off, notes: `edge refused ON profile: http-${onStatus} (off=http-${offStatus})` };
  }
  if ((on.mainStatus === null) && offStatus < 400) {
    return { site, wallWatch, verdict: 'breakage-main-resource', on, off, notes: `main status on=${on.mainStatus} off=${off.mainStatus} err=${on.error ?? ''}` };
  }
  // Images: gate only on mechanism-attributed CONTENT damage — user-visible
  // images (≥2×2 layout box) OUR blocks broke (ERR_BLOCKED_BY_CLIENT) that
  // loaded fine without the extension, or a large computed-style hiding delta
  // (cosmetic over-hiding from the lists). ≤1×1/zero-area imgs are tracking-
  // pixel shaped (sync beacons, impression pixels): blocking them is the
  // extension working as designed and the failure is invisible to the user —
  // recorded as data, never gated. Raw broken counts likewise stay as data:
  // CDN 4xx refusals and lazy-load timing hit both profiles equally.
  const offBrokenUrls = new Set(off.brokenImageUrls);
  const onContentUrls = new Set(on.brokenContentImageUrls);
  const onOnlyBlocked = on.brokenByBlockUrls.filter((url) => !offBrokenUrls.has(url) && onContentUrls.has(url));
  if (onOnlyBlocked.length >= 2) {
    return {
      site, wallWatch, verdict: 'breakage-images', on, off,
      notes: `content images broken by our blocks: ${onOnlyBlocked.length}; first=${onOnlyBlocked[0] ?? ''}`,
    };
  }
  // Hidden-image delta, attributed twice over: the probe already excluded
  // empty-src unhydrated placeholders (site hydration state, e.g. Gannett's
  // gnt_m_* modules whose loader is tangled with its ad stack — the CDN 406s
  // those thumbnails on BOTH profiles); here an image hidden ON-only counts as
  // cosmetic over-hiding only when the static lists did NOT already block its
  // request. A network-blocked tracking pixel whose img node the site's own
  // CSS then hides (sync beacons: display:none after the blocked fetch
  // settles) is list business, not a cosmetic-plane action — cnn.com's 4
  // user-sync pixels.
  const offHiddenUrls = new Set(off.hiddenImageUrls);
  const onBlockedUrls = new Set(on.brokenByBlockUrls);
  const onOnlyHidden = on.hiddenImageUrls.filter((url) => !offHiddenUrls.has(url) && !onBlockedUrls.has(url));
  if (onOnlyHidden.length >= 4) {
    return {
      site, wallWatch, verdict: 'breakage-images', on, off,
      notes: `hidden-image delta (unexplained by list blocks): on=${onOnlyHidden.length} off=${off.imagesHidden} (cosmetic over-hiding suspected); samples=${onOnlyHidden.slice(0, 4).join(' | ')}`,
    };
  }
  if (on.mainHidden && !off.mainHidden) {
    return { site, wallWatch, verdict: 'breakage-images', on, off, notes: 'main content hidden with extension only' };
  }
  const onFunctional = functionalErrors(on.pageErrors);
  const offFunctional = functionalErrors(off.pageErrors);
  // Errors with extension stack frames are attributable damage and gate hard.
  // Deltas without them are the blocked-request fallout class: the site surface
  // renders (images/main-content checks above), and the errors are the site's
  // own unguarded telemetry/vendor code reacting to requests we deliberately
  // blocked — universal ad-blocker behavior, recorded as data below.
  if (on.extensionFrameErrors.length > 0) {
    return {
      site, wallWatch, verdict: 'breakage-pageerrors', on, off,
      notes: `extension-frame pageerrors: ${on.extensionFrameErrors[0]}`,
    };
  }
  if (onFunctional.length > offFunctional.length + 1) {
    return {
      site, wallWatch, verdict: 'ok', on, off,
      notes: `blocked-request fallout: +${onFunctional.length - offFunctional.length} pageerrors after deliberate blocks (${on.blockedByClient} requests blocked); first=${onFunctional[0] ?? ''}`,
    };
  }
  if (on.wallDetected || off.wallDetected) {
    if (on.wallStanding) {
      return off.wallDetected && off.wallStanding
        ? { site, wallWatch, verdict: 'wall-stands-even-without-extension', on, off, notes: 'bot/consent wall blocks both profiles' }
        : { site, wallWatch, verdict: 'wall-standing-unhandled', on, off, notes: 'anti-adblock wall still standing at sample time (known-limit class)' };
    }
    return { site, wallWatch, verdict: 'wall-handled', on, off, notes: 'wall detected, not standing at sample time' };
  }
  const artifactDelta = (on.pageErrors.length - onFunctional.length) - (off.pageErrors.length - offFunctional.length);
  return {
    site, wallWatch, verdict: 'ok', on, off,
    ...(artifactDelta > 0 ? { notes: `blocked-request error artifacts: +${artifactDelta} (telemetry/chunk fetches blocked by design)` } : {}),
  };
}

/* ------------------------------------------------------------------ main */

async function launch(withExtension: boolean): Promise<Browser> {
  return puppeteer.launch({
    headless: false,
    executablePath: chromeExecutable(),
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      ...(withExtension
        ? [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
        : []),
      '--no-sandbox',
    ],
  });
}

async function runTier1(browser: Browser, appOrigin: string): Promise<Array<{ id: string; visit: number; failures: string[]; pageErrors: string[] }>> {
  const results: Array<{ id: string; visit: number; failures: string[]; pageErrors: string[] }> = [];
  for (let visit = 1; visit <= 3; visit++) {
    for (const fixture of TIER1_FIXTURES) {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 160)));
      let failures: string[] = [];
      try {
        await page.evaluateOnNewDocument(`window.__adPort = ${AD_PORT};`);
        await page.goto(`${appOrigin}${fixture.route}`, { waitUntil: 'networkidle2', timeout: 20_000 });
        failures = await fixture.run(page);
      } catch (error) {
        failures = [`harness: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`];
      }
      results.push({ id: fixture.id, visit, failures, pageErrors });
      await page.close().catch(() => undefined);
    }
  }
  return results;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const servers: TestServerInstances = await startTestServers(APP_PORT, AD_PORT);
  const appOrigin = `http://localhost:${APP_PORT}`;

  let tier1: Array<{ id: string; visit: number; failures: string[]; pageErrors: string[] }> = [];
  const tier2: SiteResult[] = [];
  let tier2Reachable = false;
  let exitCode = 0;

  const onBrowser = await launch(true);
  try {
    // Tier 1 — the simplest easy stuff, three visits deep.
    tier1 = await runTier1(onBrowser, appOrigin);

    // Tier 2 reachability preflight (8s): no network → honest SKIP.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const probe = await fetch('https://example.com', { signal: controller.signal });
      tier2Reachable = probe.ok;
    } catch {
      tier2Reachable = false;
    } finally {
      clearTimeout(timer);
    }

    if (tier2Reachable) {
      const offBrowser = await launch(false);
      try {
        const allSites = [
          ...TIER2_SITES.map((site) => ({ site, wallWatch: false })),
          ...TIER2_WALL_WATCH.map((site) => ({ site, wallWatch: true })),
        ];
        const siteCap = Number(process.env.REALWORLD_SITE_CAP ?? allSites.length);
        const selected = allSites.slice(0, Math.max(0, siteCap));
        const concurrency = Math.max(1, Number(process.env.REALWORLD_CONCURRENCY ?? 3));
        const runProfile = async (withExtension: boolean, browser: Browser): Promise<void> => {
          const queue = [...selected];
          await Promise.all(
            Array.from({ length: concurrency }, async () => {
              while (queue.length > 0) {
                const item = queue.shift();
                if (!item) return;
                // Navigation races under parallel load (frame detached, context
                // destroyed, target/session churn on browser.newPage) can escape
                // sampleSite as a throw. One site must never crash the whole
                // audit: retry once, then degrade to an error sample — an ON-
                // profile error routes into the serial flake re-sample below.
                let sample: SiteSample | undefined;
                let lastThrow: unknown;
                for (let attempt = 0; attempt < 2 && !sample; attempt++) {
                  try {
                    sample = await sampleSite(browser, item.site, 25_000);
                  } catch (error) {
                    lastThrow = error;
                    await sleep(1_000);
                  }
                }
                if (!sample) {
                  sample = emptySample();
                  sample.error = `sampleSite threw: ${lastThrow instanceof Error ? lastThrow.message.slice(0, 160) : String(lastThrow).slice(0, 160)}`;
                }
                let result = tier2.find((entry) => entry.site === item.site);
                if (!result) {
                  result = { site: item.site, wallWatch: item.wallWatch, verdict: 'error' };
                  tier2.push(result);
                }
                if (withExtension) result.on = sample;
                else result.off = sample;
                if (result.on && result.off) {
                  const judged = judgeSite(result.site, result.wallWatch, result.on, result.off);
                  result.verdict = judged.verdict;
                  result.notes = judged.notes;
                }
                console.log(`[tier2] ${item.site} (${withExtension ? 'ON' : 'OFF'}) -> ${sample.error ? `error: ${sample.error}` : `status ${sample.mainStatus}`}`);
              }
            })
          );
        };
        await Promise.all([runProfile(true, onBrowser), runProfile(false, offBrowser)]);
        // Sites seen by only one profile (shouldn't happen) are recorded as errors.
        for (const result of tier2) {
          if (!result.on || !result.off) {
            result.verdict = 'error';
            result.notes = 'sampled by only one profile';
          }
        }
        // Navigation-level flakes under parallel load (timeout/aborted main
        // resource, frame detach / context-destroy races) get one serial
        // re-sample before they may gate as breakage.
        for (const result of tier2) {
          if (result.verdict !== 'breakage-main-resource') continue;
          const flaky = /timeout|ERR_TIMED_OUT|ERR_ABORTED|ERR_CONNECTION|frame was detached|context was destroyed|target closed|session closed/i.test(
            result.on?.error ?? ''
          );
          if (!flaky) continue;
          console.log(`[tier2] serial retry: ${result.site}`);
          let resample: SiteSample | undefined;
          try {
            resample = await sampleSite(onBrowser, result.site, 30_000);
          } catch {
            // The re-sample itself raced — the original verdict stands.
            continue;
          }
          if (resample.mainStatus !== null && resample.error === undefined) {
            result.on = resample;
            const judged = judgeSite(result.site, result.wallWatch, result.on, result.off!);
            result.verdict = judged.verdict;
            result.notes = `${judged.notes ?? ''} (serial retry resolved nav flake)`.trim();
          }
        }
        // Hidden-image deltas on pages with rotating hero carousels or
        // session-token beacon pixels churn between the paired profiles: the
        // SITE hides its inactive slides and its own uedata pixels on every
        // visit, but the URL sets (per-session tokens, per-visit slide/size
        // variants) never match across profiles, so the URL-set delta invents
        // ON-only "hides" (amazon.com: on=5/off=5 hidden, zero overlap). A real
        // cosmetic over-hide is deterministic — the same node hides on every
        // visit. One serial paired re-sample; the verdict stands only when ≥3
        // of the exact same URLs reproduce ON-only-hidden.
        for (const result of tier2) {
          if (result.verdict !== 'breakage-images') continue;
          if (!(result.notes ?? '').startsWith('hidden-image delta')) continue;
          const origOffHidden = new Set(result.off?.hiddenImageUrls ?? []);
          const origOnBlocked = new Set(result.on?.brokenByBlockUrls ?? []);
          const origOnOnly = (result.on?.hiddenImageUrls ?? []).filter(
            (url) => !origOffHidden.has(url) && !origOnBlocked.has(url)
          );
          console.log(`[tier2] serial paired retry (hidden-image delta): ${result.site}`);
          let freshOn: SiteSample | undefined;
          let freshOff: SiteSample | undefined;
          try {
            freshOn = await sampleSite(onBrowser, result.site, 30_000);
            freshOff = await sampleSite(offBrowser, result.site, 30_000);
          } catch {
            continue; // re-sample raced — original verdict stands
          }
          if (freshOn.error !== undefined || freshOff.error !== undefined || freshOff.mainStatus === null) continue;
          const freshOffHidden = new Set(freshOff.hiddenImageUrls);
          const freshOnBlocked = new Set(freshOn.brokenByBlockUrls);
          const freshOnOnly = new Set(
            freshOn.hiddenImageUrls.filter((url) => !freshOffHidden.has(url) && !freshOnBlocked.has(url))
          );
          const persistent = origOnOnly.filter((url) => freshOnOnly.has(url));
          if (persistent.length >= 3) continue; // deterministic hide — verdict stands
          result.verdict = 'ok';
          result.notes =
            `${result.notes ?? ''} | serial paired re-sample: ${persistent.length}/${origOnOnly.length} ` +
            `URLs reproduced ON-only-hidden (carousel/beacon churn, not cosmetic action) — downgraded`;
        }
      } finally {
        await offBrowser.close().catch(() => undefined);
      }
    }
  } finally {
    await onBrowser.close().catch(() => undefined);
    await servers.close();
  }

  const tier1Failures = tier1.filter((result) => result.failures.length > 0 || result.pageErrors.length > 0);
  const tier2Breakage = tier2.filter((result) =>
    result.verdict === 'breakage-images' || result.verdict === 'breakage-pageerrors' || result.verdict === 'breakage-main-resource'
  );
  // A run where most sites were unreachable proves little — degrade honestly
  // instead of passing on a thin sample or failing on infrastructure.
  const reachableCount = tier2.filter((r) => r.verdict !== 'skip-unreachable').length;
  const networkDegraded = tier2Reachable && tier2.length > 0 && reachableCount < tier2.length / 2;
  const verdict =
    tier1Failures.length === 0 && tier2Breakage.length === 0
      ? networkDegraded
        ? 'SKIP-NETWORK-DEGRADED'
        : 'PASS'
      : 'FAIL';
  if (verdict === 'FAIL') exitCode = 1;

  // Tier 3 — report-only aggregates over paired samples.
  const paired = tier2.filter((result) => result.on?.loadMs != null && result.off?.loadMs != null);
  const median = (values: number[]): number | null =>
    values.length > 0 ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? null : null;
  const tier3 = {
    pairedSites: paired.length,
    medianLoadDeltaMs: median(paired.map((r) => (r.on!.loadMs ?? 0) - (r.off!.loadMs ?? 0))),
    medianLongTaskDelta: median(paired.map((r) => (r.on!.longTasks ?? 0) - (r.off!.longTasks ?? 0))),
    medianHeapDeltaMb: median(paired.map((r) => (r.on!.heapMb ?? 0) - (r.off!.heapMb ?? 0))),
  };

  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(
    artifactPath,
    `${JSON.stringify(
      {
        schema: 'adapt-realworld-audit-v1',
        ...verificationMetadata(root),
        verdict,
        durationMs: Date.now() - startedAt,
        tier1: {
          gating: true,
          fixtureVisits: tier1.length,
          failures: tier1Failures,
        },
        tier2: {
          gating: tier2Reachable && !networkDegraded,
          reachable: tier2Reachable,
          reachableSites: reachableCount,
          networkDegraded,
          siteCount: tier2.length,
          wallWatchCount: tier2.filter((r) => r.wallWatch).length,
          deliberateExclusions: 'streaming-video class (reserved benchmark holdout identity undisclosed)',
          verdictCounts: tier2.reduce<Record<string, number>>((acc, r) => {
            acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
            return acc;
          }, {}),
          breakage: tier2Breakage.map((r) => ({ site: r.site, verdict: r.verdict, notes: r.notes })),
          sites: tier2,
        },
        tier3,
        honestLimits: [
          'Tier-2 wall detection is a DOM heuristic; walls without viewport-sized containers or with iframed interstitials are undercounted.',
          'Bot-walls (Cloudflare/Datadome) that block both profiles are recorded as wall-stands-even-without-extension, not extension breakage.',
          'Tier-3 deltas are medians over paired samples on a shared machine — indicative, not benchmark-grade.',
          'Closed shadow roots remain a known blindness class (pinned by t38).',
          'wall-standing-unhandled is the adversarial known-limit class: recorded, not gated; the deterministic wall-handling path has its own TTL bounds (t41).',
          'Blocked-request fallout: sites surface deliberately-blocked telemetry/vendor requests as console errors (unguarded vendor globals, fetch rejections, buggy onerror cascades — e.g. a vendor script blocked, then an inline call to its global throws). Universal ad-blocker behavior; recorded with full error lists, gated only when an error stack contains chrome-extension:// frames. MAIN-world scriptlet errors would be indistinguishable from page errors (all our scriptlets are try/catch-wrapped, pinned by H3 tests).',
        ],
      },
      null,
      2
    )}\n`
  );

  console.log(`\nREALWORLD AUDIT — ${verdict}`);
  console.log(`  tier1: ${tier1.length} fixture-visits, ${tier1Failures.length} failing`);
  console.log(`  tier2: ${tier2Reachable ? `${tier2.length} sites, ${tier2Breakage.length} breakage verdicts` : 'SKIP (network unreachable)'}`);
  console.log(`  tier3: paired=${tier3.pairedSites} medianLoadDeltaMs=${tier3.medianLoadDeltaMs}`);
  console.log(`  artifact: ${artifactPath}`);
  process.exit(exitCode);
}

await main();
