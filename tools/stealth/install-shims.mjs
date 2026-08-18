/**
 * ADAPT stealth plane installer (Phase D1).
 *
 * Installs the anti-detector shim resources + the high-priority redirect
 * ruleset into dist/, idempotently:
 *   - copies src/page/shims/*  →  dist/web-accessible-resources/shims/
 *   - writes the 1x1.gif pixel (binary, from base64)
 *   - writes dist/phase31-rulesets/adapt-shims.json (redirect, priority 100)
 *   - merges manifest.json:
 *       declarative_net_request.rule_resources += adapt_shims (deduped by id)
 *       web_accessible_resources: shim paths removed from every entry, then one
 *       dedicated dynamic-URL entry added (no stable probeable resource URL)
 *
 * Called from scripts/build.ts (after phase31 plane restore) and tools/phase31/v6.mjs
 * (after its manifest write) so both plain builds and build:full ship the plane.
 *
 * Redirect semantics: when a block rule and these redirect rules both match, the
 * higher priority (100) wins, so detector-bait endpoints get a neutered shim
 * (request "succeeds", detector settles) instead of a hard block. Everything else
 * is still blocked normally — the plane only touches the enumerated bait surface.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const SRC_SHIMS = path.join(root, 'src', 'page', 'shims');
const RULESET_ID = 'adapt_shims';
const RULESET_PATH = 'phase31-rulesets/adapt-shims.json';
const SHIM_WEB_PREFIX = 'web-accessible-resources/shims/';

// 43-byte transparent 1x1 GIF.
const PIXEL_GIF_B64 = 'R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

const shimRedirect = (file) => `/web-accessible-resources/shims/${file}`;

/**
 * Bait surface, deliberately small and detector-shaped:
 *  - Google's ad/analytics entry scripts (the classic tripwires)
 *  - root-level bait filenames on ANY host (the free detector kits' tripwire)
 *  - the named detector families' own scripts → defuser shims
 * Everything here redirects; nothing in this ruleset blocks.
 */
const BAIT_SCRIPT_NAMES = [
  'ads',
  'ad',
  'advert',
  'advertisement',
  'advertising',
  'adsbygoogle',
  'show_ads',
  'pagead',
  'adframe',
  'adserve',
  'adcheck',
  'ad-detect',
  'detectadblock',
];

/**
 * Bait surface, deliberately small and detector-shaped:
 *  - Google's ad/analytics entry scripts (the classic tripwires)
 *  - root-level bait filenames on ANY host (the free detector kits' tripwire)
 *  - the named detector families' own scripts → defuser shims
 * Everything here redirects; nothing in this ruleset blocks.
 *
 * NOTE: root-level bait filenames are emitted as one anchored single-literal
 * rule per name — Chrome's DNR fast-path index silently drops anchored
 * alternation patterns in this position (verified empirically by harness
 * bisect: anchored single-literal rules match; anchored alternations after
 * `[^/?#]+/` never get evaluated).
 */
const RULES = [
  {
    id: 1,
    priority: 100,
    action: { type: 'redirect', redirect: { extensionPath: shimRedirect('adsbygoogle.js') } },
    condition: {
      regexFilter: '^https?://pagead2\\.googlesyndication\\.com/pagead/js/adsbygoogle\\.js',
      resourceTypes: ['script'],
    },
  },
  {
    id: 2,
    priority: 100,
    action: { type: 'redirect', redirect: { extensionPath: shimRedirect('show_ads.js') } },
    condition: {
      regexFilter: '^https?://([a-z0-9-]+\\.)?googlesyndication\\.com/pagead/show_ads\\.js',
      resourceTypes: ['script'],
    },
  },
  {
    id: 3,
    priority: 100,
    action: { type: 'redirect', redirect: { extensionPath: shimRedirect('analytics.js') } },
    condition: {
      regexFilter: '^https?://(www\\.|ssl\\.)?google-analytics\\.com/(analytics|ga|urchin)\\.js',
      resourceTypes: ['script'],
    },
  },
  ...BAIT_SCRIPT_NAMES.map((name, index) => ({
    id: 10 + index,
    priority: 100,
    action: { type: 'redirect', redirect: { extensionPath: shimRedirect('noop.js') } },
    condition: {
      regexFilter: `^https?://[^/?#]+/${name.replace('-', '\\-')}\\.js([?#].*)?$`,
      resourceTypes: ['script'],
    },
  })),
  {
    id: 5,
    priority: 100,
    action: { type: 'redirect', redirect: { extensionPath: shimRedirect('nobab.js') } },
    condition: {
      regexFilter: 'blockadblock[^/?#]*\\.js',
      resourceTypes: ['script'],
    },
  },
  {
    id: 6,
    priority: 100,
    action: { type: 'redirect', redirect: { extensionPath: shimRedirect('nofab.js') } },
    condition: {
      regexFilter: 'fuckadblock[^/?#]*\\.js',
      resourceTypes: ['script'],
    },
  },
  {
    id: 7,
    priority: 100,
    action: { type: 'redirect', redirect: { extensionPath: shimRedirect('noop.html') } },
    condition: {
      regexFilter: '^https?://[^/?#]+/(adframe|ad-frame|adserver|bannerad|ad)\\.(html?|php)([?#].*)?$',
      resourceTypes: ['sub_frame'],
    },
  },
  {
    id: 8,
    priority: 100,
    action: { type: 'redirect', redirect: { extensionPath: shimRedirect('noop.txt') } },
    condition: {
      regexFilter: '^https?://[^/?#]+/(ads|ad|advert|advertisement)\\.txt([?#].*)?$',
      resourceTypes: ['xmlhttprequest'],
    },
  },
];

export function installStealthPlane(distDir = path.join(root, 'dist')) {
  const manifestPath = path.join(distDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { installed: false, reason: 'no-manifest' };

  // 1. Shim files
  const shimsOut = path.join(distDir, 'web-accessible-resources', 'shims');
  fs.mkdirSync(shimsOut, { recursive: true });
  const installed = [];
  for (const file of fs.readdirSync(SRC_SHIMS)) {
    fs.copyFileSync(path.join(SRC_SHIMS, file), path.join(shimsOut, file));
    installed.push(file);
  }
  fs.writeFileSync(path.join(shimsOut, '1x1.gif'), Buffer.from(PIXEL_GIF_B64, 'base64'));
  installed.push('1x1.gif');

  // 2. Redirect ruleset
  const rulesDir = path.join(distDir, 'phase31-rulesets');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, RULESET_PATH), JSON.stringify(RULES, null, 2) + '\n');

  // 3. Manifest merge (idempotent)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.declarative_net_request ??= {};
  manifest.declarative_net_request.rule_resources ??= [];
  manifest.declarative_net_request.rule_resources = manifest.declarative_net_request.rule_resources
    .filter((entry) => entry && entry.id !== RULESET_ID);
  manifest.declarative_net_request.rule_resources.push({
    id: RULESET_ID,
    enabled: true,
    path: RULESET_PATH,
  });

  const shimPaths = installed.map((file) => `${SHIM_WEB_PREFIX}${file}`);
  manifest.web_accessible_resources = (manifest.web_accessible_resources ?? [])
    .map((entry) => {
      if (!Array.isArray(entry?.resources)) return entry;
      const remaining = entry.resources.filter((resource) => !String(resource).startsWith(SHIM_WEB_PREFIX));
      return { ...entry, resources: remaining };
    })
    .filter((entry) => !Array.isArray(entry?.resources) || entry.resources.length > 0);
  manifest.web_accessible_resources.push({
    resources: shimPaths,
    matches: ['http://*/*', 'https://*/*'],
    use_dynamic_url: true,
  });

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { installed: true, shims: installed.length, rules: RULES.length };
}

// CLI entry: `node tools/stealth/install-shims.mjs`
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const result = installStealthPlane();
  console.log('STEALTH PLANE:', JSON.stringify(result));
}
