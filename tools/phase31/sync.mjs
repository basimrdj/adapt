import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const phaseDir = path.join(root, '.phase31');
const cacheDir = path.join(phaseDir, 'text');
const nextDir = path.join(phaseDir, 'text.next');
const stampFile = path.join(cacheDir, '.adapt-sync.json');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// These are the only maintained source lists Phase 3.1 currently consumes.
// Downloading them serially avoids the dozens of concurrent requests that
// caused the AdGuard loader ECONNRESET on the large Base list.
const REQUIRED = [
  { id: 2, family: 'base', expected: /^AdGuard Base filter$/i },
  { id: 3, family: 'tracking', expected: /^AdGuard Tracking Protection filter$/i },
  { id: 17, family: 'urltracking', expected: /^AdGuard URL Tracking filter$/i },
  { id: 19, family: 'popups', expected: /^AdGuard Popups filter$/i },
  { id: 21, family: 'annoyances', expected: /^AdGuard Other Annoyances filter$/i },
  { id: 208, family: 'malicious', expected: /^Online Malicious URL Blocklist$/i },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function titleOf(file) {
  if (!fs.existsSync(file)) return '';

  const head = fs.readFileSync(file, 'utf8').slice(0, 20000);
  return (
    head.match(/^!\s*Title:\s*(.+)$/im)?.[1] ||
    head.match(/^!\s*Name:\s*(.+)$/im)?.[1] ||
    ''
  ).trim();
}

function validateDirectory(dir, verbose = false) {
  for (const spec of REQUIRED) {
    const file = path.join(dir, `filter_${spec.id}.txt`);

    if (!fs.existsSync(file)) {
      if (verbose) console.error(`missing filter ${spec.id} (${spec.family})`);
      return false;
    }

    const stat = fs.statSync(file);
    if (stat.size < 100) {
      if (verbose) console.error(`filter ${spec.id} is unexpectedly small`);
      return false;
    }

    const title = titleOf(file);
    if (!spec.expected.test(title)) {
      if (verbose) {
        console.error(
          `filter ${spec.id} title mismatch: expected ${spec.expected}, got "${title}"`
        );
      }
      return false;
    }
  }

  return true;
}

function cacheIsFresh() {
  if (!validateDirectory(cacheDir)) return false;
  if (!fs.existsSync(stampFile)) return false;

  try {
    const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
    return (
      typeof stamp.syncedAt === 'number' &&
      Date.now() - stamp.syncedAt < CACHE_TTL_MS
    );
  } catch {
    return false;
  }
}

async function fetchTextWithRetry(url, label) {
  let lastError;

  for (let attempt = 1; attempt <= 8; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);

    try {
      console.log(
        `[download] ${label} — attempt ${attempt}/8`
      );

      const response = await fetch(url, {
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'accept': 'text/plain,*/*;q=0.8',
          'user-agent': 'ADAPT-Phase31-FilterSync/1.0',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const text = await response.text();

      if (text.length < 100) {
        throw new Error(`response unexpectedly small (${text.length} bytes)`);
      }

      return text;
    } catch (error) {
      lastError = error;
      console.warn(
        `[download] ${label} failed: ${error?.message || String(error)}`
      );

      if (attempt < 8) {
        const delay = Math.min(30_000, 2_000 * attempt);
        console.log(`[download] retrying in ${delay / 1000}s...`);
        await sleep(delay);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error(`download failed for ${label}`);
}

fs.mkdirSync(phaseDir, { recursive: true });

if (process.env.ADAPT_PHASE31_OFFLINE === '1') {
  if (!validateDirectory(cacheDir, true)) {
    console.error(
      'ERROR: ADAPT_PHASE31_OFFLINE=1 but validated curated cache is unavailable'
    );
    process.exit(1);
  }

  console.log('Phase 3.1 filter sync: using validated cache (offline mode)');
  process.exit(0);
}

if (
  process.env.ADAPT_PHASE31_FORCE_SYNC !== '1' &&
  cacheIsFresh()
) {
  console.log('Phase 3.1 filter sync: using fresh validated curated cache');
  process.exit(0);
}

fs.rmSync(nextDir, { recursive: true, force: true });
fs.mkdirSync(nextDir, { recursive: true });

let freshComplete = false;

try {
  for (const spec of REQUIRED) {
    const url =
      `https://filters.adtidy.org/extension/chromium-mv3/filters/${spec.id}.txt`;

    const text = await fetchTextWithRetry(
      url,
      `filter ${spec.id} (${spec.family})`
    );

    const outfile = path.join(nextDir, `filter_${spec.id}.txt`);
    fs.writeFileSync(outfile, text);

    const title = titleOf(outfile);
    if (!spec.expected.test(title)) {
      throw new Error(
        `filter ${spec.id} validation failed: title "${title}"`
      );
    }

    console.log(
      `[validated] filter ${spec.id} — ${title} — ${Buffer.byteLength(text).toLocaleString()} bytes`
    );
  }

  if (!validateDirectory(nextDir, true)) {
    throw new Error('fresh curated filter directory failed final validation');
  }

  freshComplete = true;
} catch (error) {
  console.error(
    `Fresh Phase 3.1 filter sync failed: ${error?.stack || error}`
  );
}

if (freshComplete) {
  // Never destroy the previous cache until the complete next generation is
  // validated. Rename makes the transition effectively atomic for our build.
  const oldDir = path.join(phaseDir, 'text.previous');
  fs.rmSync(oldDir, { recursive: true, force: true });

  if (fs.existsSync(cacheDir)) {
    fs.renameSync(cacheDir, oldDir);
  }

  fs.renameSync(nextDir, cacheDir);

  fs.writeFileSync(
    stampFile,
    JSON.stringify(
      {
        syncedAt: Date.now(),
        filterIds: REQUIRED.map((x) => x.id),
      },
      null,
      2
    )
  );

  fs.rmSync(oldDir, { recursive: true, force: true });

  console.log('Phase 3.1 filter sync: OK — fresh curated corpus installed');
  process.exit(0);
}

fs.rmSync(nextDir, { recursive: true, force: true });

if (validateDirectory(cacheDir, true)) {
  console.warn(
    'WARNING: fresh sync failed; continuing with previous fully validated cache'
  );
  process.exit(0);
}

console.error(
  'ERROR: fresh sync failed and no complete validated fallback cache exists'
);
process.exit(1);
