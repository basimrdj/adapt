import fs from 'node:fs';
import path from 'node:path';
import {
  Filter,
  FilterConverter,
} from '@adguard/dnr-converter';

const root = process.cwd();
const textDir = path.join(root, '.phase31', 'text');
const dist = path.join(root, 'dist');
const manifestPath = path.join(dist, 'manifest.json');
const rulesDir = path.join(dist, 'phase31-rulesets');
const reportPath = path.join(root, '.phase31', 'REPORT-v5.md');

function die(msg) {
  console.error('\nFATAL:', msg);
  process.exit(1);
}
function titleOf(file) {
  const h = fs.readFileSync(file, 'utf8').slice(0, 20000);
  return (
    h.match(/^!\s*Title:\s*(.+)$/im)?.[1] ||
    h.match(/^!\s*Name:\s*(.+)$/im)?.[1] ||
    ''
  ).trim();
}
function family(t) {
  t = t.toLowerCase();
  if (t.startsWith('adguard base')) return 'base';
  if (t.startsWith('adguard tracking protection')) return 'tracking';
  if (t.startsWith('adguard url tracking')) return 'urltracking';
  if (t.includes('adblock warning removal')) return 'antiadblock';
  if (t.includes('popups filter')) return 'popups';
  if (t.includes('other annoyances')) return 'annoyances';
  if (t.includes('online malicious url')) return 'malicious';
  if (t.includes('peter lowe')) return 'peter';
  return '';
}
function priority(f) {
  return {
    base: 1000,
    tracking: 980,
    urltracking: 950,
    antiadblock: 900,
    popups: 850,
    annoyances: 800,
    malicious: 760,
    peter: 720,
  }[f] || 0;
}
function plainSelector(s) {
  if (!s || s.length > 700) return false;
  const bad = [
    '+js(', ':has-text(', ':matches-css', ':xpath(', ':upward(',
    ':remove(', ':remove-attr(', ':remove-class(', ':-abp-',
    ':style(', ':watch-attr(', ':contains(', '#%#', '#$#',
  ];
  return !bad.some(x => s.includes(x));
}
function validateRule(r) {
  return r &&
    Number.isInteger(r.id) &&
    r.id > 0 &&
    r.action &&
    typeof r.action.type === 'string' &&
    r.condition &&
    typeof r.condition === 'object';
}
function isSafeAction(r) {
  // Keep the native fast path conservative.
  // Header mutation/redirect can be integrated later with explicit resources
  // and tests; blocking/allowing remains the production foundation.
  return ['block', 'allow', 'allowAllRequests', 'upgradeScheme']
    .includes(r?.action?.type);
}

if (!fs.existsSync(manifestPath)) die('dist/manifest.json missing');

// ---------------------------------------------------------
// SELF-TEST THE ACTUAL LIBRARY API BEFORE TOUCHING THE BUILD.
// ---------------------------------------------------------
console.log('\n[SELF-TEST] Compiling a synthetic blocker rule...');
{
  const converter = new FilterConverter();
  const f = new Filter(999999, '||adapt-self-test.invalid^$script');
  const results = await converter.convert([f]);
  if (!Array.isArray(results) || results.length !== 1) {
    die('FilterConverter returned an unexpected result');
  }
  const rules = results[0].ruleset.getDeclarativeRules();
  if (!Array.isArray(rules) || rules.length < 1) {
    die('PROGRAMMATIC CONVERTER SELF-TEST FAILED: zero DNR rules');
  }
  if (!rules.some(r => r.action?.type === 'block')) {
    die('PROGRAMMATIC CONVERTER SELF-TEST FAILED: no block rule produced');
  }
  console.log(`[SELF-TEST] PASS — ${rules.length} DNR rule(s) produced`);
}

// ---------------------------------------------------------
// DISCOVER CURRENT FILTERS BY TITLE, NOT HARDCODED ID.
// ---------------------------------------------------------
const sources = fs.readdirSync(textDir)
  .filter(n => /^filter_\d+\.txt$/.test(n))
  .map(name => {
    const file = path.join(textDir, name);
    const id = Number(name.match(/^filter_(\d+)\.txt$/)[1]);
    const title = titleOf(file);
    const fam = family(title);
    return {id, title, fam, priority: priority(fam), file};
  })
  .filter(x => x.priority)
  .sort((a,b) => b.priority - a.priority);

const selected = [];
const seen = new Set();
for (const s of sources) {
  if (seen.has(s.fam)) continue;
  selected.push(s);
  seen.add(s.fam);
}

for (const required of ['base', 'tracking']) {
  if (!selected.some(x => x.fam === required)) {
    die(`Required filter family '${required}' was not found`);
  }
}

console.log('\nSelected maintained filter sources:');
for (const s of selected) {
  console.log(`  #${String(s.id).padEnd(4)} ${s.fam.padEnd(12)} ${s.title}`);
}

// ---------------------------------------------------------
// COMPILE EACH FILTER DIRECTLY THROUGH FilterConverter.
// ---------------------------------------------------------
fs.rmSync(rulesDir, {recursive:true, force:true});
fs.mkdirSync(rulesDir, {recursive:true});

const compiled = [];
for (const s of selected) {
  console.log(`\n[COMPILE] ${s.title} (#${s.id})`);
  const content = fs.readFileSync(s.file, 'utf8');

  const converter = new FilterConverter();
  let results;
  try {
    results = await converter.convert(
      [new Filter(s.id, content)],
      {
        maxNumberOfRules: 30000,
        maxNumberOfRegexpRules: 1000,
      }
    );
  } catch (e) {
    console.error(`  ERROR converter threw: ${e?.stack || e}`);
    continue;
  }

  if (!results?.length) {
    console.error('  ERROR no conversion result');
    continue;
  }

  const result = results[0];
  const raw = result.ruleset.getDeclarativeRules();

  let malformed = 0;
  let unsafeRemoved = 0;
  const safe = [];

  for (const r of raw) {
    if (!validateRule(r)) {
      malformed++;
      continue;
    }
    if (!isSafeAction(r)) {
      unsafeRemoved++;
      continue;
    }
    safe.push(r);
  }

  if (!safe.length) {
    console.error('  ERROR zero usable safe DNR rules');
    continue;
  }

  const outfile = path.join(rulesDir, `filter_${s.id}.json`);
  fs.writeFileSync(outfile, JSON.stringify(safe));

  compiled.push({
    ...s,
    count: safe.length,
    converterErrors: result.errors?.length || 0,
    limitations: result.limitations?.length || 0,
    unsafeRemoved,
    malformed,
  });

  console.log(`  raw=${raw.length} safe=${safe.length} unsafeRemoved=${unsafeRemoved}`);
  console.log(`  converterErrors=${result.errors?.length || 0} limitations=${result.limitations?.length || 0}`);
}

for (const required of ['base', 'tracking']) {
  if (!compiled.some(x => x.fam === required)) {
    die(`Compilation failed for critical '${required}' filter`);
  }
}

// ---------------------------------------------------------
// ENABLE CORE SETS. PACKAGE THE REST.
// ---------------------------------------------------------
// Base + Tracking are the wide-spectrum core.
// URL tracking is tiny/high-value and enabled too.
// Other lists are packaged but disabled until we see Chrome's remaining quota.
const defaultEnabledFamilies = new Set(['base', 'tracking', 'urltracking']);
for (const c of compiled) c.enabled = defaultEnabledFamilies.has(c.fam);

const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

m.permissions ??= [];
if (!m.permissions.includes('declarativeNetRequest')) {
  m.permissions.push('declarativeNetRequest');
}

m.declarative_net_request ??= {};
m.declarative_net_request.rule_resources ??= [];

// Preserve verified Phase 3 rulesets and replace only prior Phase 3.1 artifacts.
m.declarative_net_request.rule_resources =
  m.declarative_net_request.rule_resources.filter(
    x => !String(x.id || '').startsWith('phase31_')
  );

for (const c of compiled) {
  m.declarative_net_request.rule_resources.push({
    id: `phase31_${c.id}`,
    enabled: c.enabled,
    path: `phase31-rulesets/filter_${c.id}.json`,
  });
}

// ---------------------------------------------------------
// GENERIC COSMETIC FILTERING.
// ---------------------------------------------------------
const hide = new Set();
const unhide = new Set();

for (const c of compiled) {
  for (const raw of fs.readFileSync(c.file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('[')) continue;

    if (line.startsWith('#@#')) {
      const selector = line.slice(3).trim();
      if (plainSelector(selector)) unhide.add(selector);
    } else if (line.startsWith('##')) {
      const selector = line.slice(2).trim();
      if (plainSelector(selector)) hide.add(selector);
    }
  }
}

for (const s of unhide) hide.delete(s);
const selectors = [...hide];
const cssChunks = [];

for (let i = 0; i < selectors.length; i += 100) {
  const group = selectors.slice(i, i + 100);
  cssChunks.push(
    `:is(${group.join(',\n')}){display:none!important;}`
  );
}

fs.writeFileSync(
  path.join(dist, 'phase31-generic-cosmetic.css'),
  `/* ADAPT Phase 3.1 v5 generated generic cosmetics */\n${cssChunks.join('\n')}\n`
);

m.content_scripts ??= [];
let contentEntry = m.content_scripts.find(x =>
  Array.isArray(x.matches) &&
  x.matches.includes('<all_urls>') &&
  (x.run_at === 'document_start' || !x.run_at)
);

if (!contentEntry) {
  contentEntry = {
    matches: ['<all_urls>'],
    css: [],
    run_at: 'document_start',
    all_frames: true,
  };
  m.content_scripts.push(contentEntry);
}

contentEntry.css ??= [];
if (!contentEntry.css.includes('phase31-generic-cosmetic.css')) {
  contentEntry.css.push('phase31-generic-cosmetic.css');
}

fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');

// ---------------------------------------------------------
// VERIFY THE BUILD WE JUST WROTE.
// ---------------------------------------------------------
console.log('\n[VERIFY]');

const allResources = m.declarative_net_request.rule_resources;
const p31Resources = allResources.filter(x => String(x.id).startsWith('phase31_'));
const originalResources = allResources.filter(x => !String(x.id).startsWith('phase31_'));

let totalPackaged = 0;
let totalEnabled = 0;
let failures = 0;

for (const r of p31Resources) {
  const f = path.join(dist, r.path);
  if (!fs.existsSync(f)) {
    console.error(`  FAIL missing ${r.path}`);
    failures++;
    continue;
  }

  const rules = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!Array.isArray(rules) || rules.length === 0) {
    console.error(`  FAIL invalid/empty ${r.path}`);
    failures++;
    continue;
  }

  const bad = rules.find(x => !validateRule(x) || !isSafeAction(x));
  if (bad) {
    console.error(`  FAIL malformed/unsafe rule leaked into ${r.id}`);
    failures++;
  }

  totalPackaged += rules.length;
  if (r.enabled) totalEnabled += rules.length;

  console.log(
    `  OK ${r.enabled ? 'ENABLED ' : 'PACKAGED'} ${r.id}: ${rules.length} rules`
  );
}

if (!originalResources.some(x => x.id === 'ruleset_baseline')) {
  console.error('  FAIL verified ruleset_baseline disappeared');
  failures++;
}

if (totalPackaged < 10000) {
  console.error(`  FAIL production corpus unexpectedly tiny: ${totalPackaged}`);
  failures++;
}

const cssPath = path.join(dist, 'phase31-generic-cosmetic.css');
if (!fs.existsSync(cssPath) || fs.statSync(cssPath).size < 100) {
  console.error('  FAIL cosmetic CSS missing/empty');
  failures++;
}

if (failures) {
  die(`${failures} verification failure(s)`);
}

const report = [
  '# ADAPT Phase 3.1 v5 Report',
  '',
  `Generated: ${new Date().toISOString()}`,
  '',
  '## Rulesets',
  ...compiled.map(c =>
    `- ${c.enabled ? 'ENABLED' : 'PACKAGED'} — ${c.title} — ${c.count.toLocaleString()} rules` +
    ` — converter errors ${c.converterErrors}` +
    ` — limitations ${c.limitations}` +
    ` — unsafe removed ${c.unsafeRemoved}`
  ),
  '',
  `Total packaged Phase 3.1 DNR rules: **${totalPackaged.toLocaleString()}**`,
  `Initially enabled Phase 3.1 DNR rules: **${totalEnabled.toLocaleString()}**`,
  `Generic cosmetic selectors: **${selectors.length.toLocaleString()}**`,
  `Verified ADAPT baseline preserved: **YES**`,
  '',
  '## Important',
  '- Existing Phase 3 causal/adaptive source code was not modified.',
  '- Only safe DNR actions were admitted into the new static corpus.',
  '- Header mutation and redirect rules are deliberately excluded from this first production baseline.',
  '- Additional packaged lists can be enabled after checking Chrome static-rule quota.',
].join('\n');

fs.writeFileSync(reportPath, report + '\n');

console.log('\n============================================================');
console.log(' ADAPT PHASE 3.1 v5 — PASS');
console.log('============================================================');
console.log('TOTAL PACKAGED DNR RULES:', totalPackaged);
console.log('TOTAL INITIALLY ENABLED:', totalEnabled);
console.log('GENERIC COSMETIC SELECTORS:', selectors.length);
console.log('PRESERVED BASELINE:', originalResources.map(x => x.id));
console.log('REPORT:', reportPath);
