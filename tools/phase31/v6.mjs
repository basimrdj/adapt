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
const warDir = path.join(dist, 'web-accessible-resources');
const reportPath = path.join(root, '.phase31', 'REPORT-v6.md');

const GUARANTEED_STATIC_RULES = 30_000;
const MAX_STATIC_REGEX_RULES = 1_000;
const OPTIONAL_SHARD_SIZE = 20_000;
const CONVERTER_RULE_CEILING = 100_000;

function die(msg) {
  console.error('\nFATAL:', msg);
  process.exit(1);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }

  return out;
}

function titleOf(file) {
  const h = fs.readFileSync(file, 'utf8').slice(0, 20000);

  return (
    h.match(/^!\s*Title:\s*(.+)$/im)?.[1] ||
    h.match(/^!\s*Name:\s*(.+)$/im)?.[1] ||
    ''
  ).trim();
}

function family(title) {
  const t = title.toLowerCase();

  if (t.startsWith('adguard base')) return 'base';
  if (t.startsWith('adguard tracking protection')) return 'tracking';
  if (t.startsWith('adguard url tracking')) return 'urltracking';
  if (t.includes('adblock warning removal') || t.includes('anti-adblock')) {
    return 'antiadblock';
  }
  if (t.includes('popups filter')) return 'popups';
  if (t.includes('other annoyances')) return 'annoyances';
  if (t.includes('online malicious url')) return 'malicious';
  if (t.includes('peter lowe')) return 'peter';

  return '';
}

function priority(fam) {
  return {
    base: 1100,
    tracking: 1000,
    urltracking: 950,
    antiadblock: 900,
    popups: 850,
    annoyances: 800,
    malicious: 700,
    peter: 650,
  }[fam] || 0;
}

function validateRule(rule) {
  return (
    rule &&
    Number.isInteger(rule.id) &&
    rule.id > 0 &&
    rule.action &&
    typeof rule.action.type === 'string' &&
    rule.condition &&
    typeof rule.condition === 'object'
  );
}

function supportedStaticAction(rule) {
  return [
    'block',
    'allow',
    'allowAllRequests',
    'upgradeScheme',
    'redirect',
    'modifyHeaders',
  ].includes(rule?.action?.type);
}

function redirectResourceExists(rule) {
  const extensionPath = rule?.action?.redirect?.extensionPath;
  if (!extensionPath) return true;

  const rel = String(extensionPath).replace(/^\/+/, '');
  return fs.existsSync(path.join(dist, rel));
}

function isRegexRule(rule) {
  return (
    typeof rule?.condition?.regexFilter === 'string' &&
    rule.condition.regexFilter.length > 0
  );
}

function countRulesAtManifestPath(entry) {
  const file = path.join(dist, entry.path || '');
  if (!fs.existsSync(file)) {
    die(`enabled pre-existing static ruleset file missing: ${entry.path}`);
  }

  const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(rules)) {
    die(`pre-existing static ruleset is not an array: ${entry.path}`);
  }

  return rules.length;
}

function shardRules({
  source,
  rules,
  guaranteedBaseBudget,
}) {
  const shards = [];

  if (source.fam === 'base') {
    const coreCount = Math.min(guaranteedBaseBudget, rules.length);

    if (coreCount <= 0) {
      die('no guaranteed static-rule budget remains for the Base filter');
    }

    shards.push({
      suffix: 'core',
      rules: rules.slice(0, coreCount),
      defaultEnabled: true,
      priority: source.priority + 50,
    });

    let offset = coreCount;
    let index = 1;

    while (offset < rules.length) {
      const next = rules.slice(offset, offset + OPTIONAL_SHARD_SIZE);
      shards.push({
        suffix: `extra_${index}`,
        rules: next,
        defaultEnabled: false,
        // Base remainder should be consumed before lower-priority families.
        priority: source.priority + 40 - index,
      });
      offset += next.length;
      index++;
    }

    return shards;
  }

  let offset = 0;
  let index = 1;

  while (offset < rules.length) {
    const next = rules.slice(offset, offset + OPTIONAL_SHARD_SIZE);
    shards.push({
      suffix: `part_${index}`,
      rules: next,
      defaultEnabled: false,
      priority: source.priority - index,
    });
    offset += next.length;
    index++;
  }

  return shards;
}

if (!fs.existsSync(manifestPath)) die('dist/manifest.json missing');
if (!fs.existsSync(textDir)) {
  die('.phase31/text missing; run phase31:sync first');
}

console.log('\n[SELF-TEST] programmatic DNR converter...');
{
  const converter = new FilterConverter();
  const [result] = await converter.convert([
    new Filter(999999, '||adapt-self-test.invalid^$script'),
  ]);
  const rules = result?.ruleset?.getDeclarativeRules?.() ?? [];

  if (!rules.some((rule) => rule.action?.type === 'block')) {
    die('converter self-test failed');
  }

  console.log(`[SELF-TEST] PASS — ${rules.length} DNR rule(s)`);
}

const sources = fs
  .readdirSync(textDir)
  .filter((name) => /^filter_\d+\.txt$/.test(name))
  .map((name) => {
    const file = path.join(textDir, name);
    const id = Number(name.match(/^filter_(\d+)\.txt$/)[1]);
    const title = titleOf(file);
    const fam = family(title);

    return {
      id,
      title,
      fam,
      priority: priority(fam),
      file,
    };
  })
  .filter((item) => item.priority)
  .sort((a, b) => b.priority - a.priority);

const selected = [];
const seen = new Set();

for (const source of sources) {
  if (seen.has(source.fam)) continue;
  selected.push(source);
  seen.add(source.fam);
}

for (const required of ['base', 'tracking']) {
  if (!selected.some((item) => item.fam === required)) {
    die(`required filter family '${required}' not found`);
  }
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

manifest.declarative_net_request ??= {};
manifest.declarative_net_request.rule_resources ??= [];

// Build starts from src/manifest.json, but be defensive if a previous generated
// artifact is supplied: Phase 3.1 resources are always regenerated.
manifest.declarative_net_request.rule_resources =
  manifest.declarative_net_request.rule_resources.filter(
    (entry) => !String(entry.id || '').startsWith('phase31_')
  );

const originalResources =
  manifest.declarative_net_request.rule_resources.slice();

const originalEnabledRuleCount = originalResources
  .filter((entry) => entry.enabled)
  .reduce((sum, entry) => sum + countRulesAtManifestPath(entry), 0);

const guaranteedBaseBudget =
  GUARANTEED_STATIC_RULES - originalEnabledRuleCount;

if (guaranteedBaseBudget <= 0) {
  die(
    `pre-existing enabled rules already consume the ${GUARANTEED_STATIC_RULES} guaranteed static-rule budget`
  );
}

console.log(
  `\n[QUOTA] pre-existing enabled static rules=${originalEnabledRuleCount}`
);
console.log(
  `[QUOTA] guaranteed Base budget=${guaranteedBaseBudget}`
);

fs.rmSync(rulesDir, { recursive: true, force: true });
fs.mkdirSync(rulesDir, { recursive: true });

const compiledSources = [];
const packagedShards = [];
let regexBudgetRemaining = MAX_STATIC_REGEX_RULES;
let regexDropped = 0;

for (const source of selected) {
  console.log(`\n[COMPILE] ${source.title} (#${source.id})`);

  const converter = new FilterConverter();
  const content = fs.readFileSync(source.file, 'utf8');

  let results;

  try {
    results = await converter.convert(
      [new Filter(source.id, content)],
      {
        resourcesPath: '/web-accessible-resources',
        maxNumberOfRules: CONVERTER_RULE_CEILING,
        maxNumberOfRegexpRules: MAX_STATIC_REGEX_RULES,
      }
    );
  } catch (error) {
    console.error(error);
    continue;
  }

  const result = results?.[0];
  if (!result) continue;

  const raw = result.ruleset.getDeclarativeRules();
  const rules = [];
  const actionCounts = {};

  let malformed = 0;
  let unsupported = 0;
  let brokenRedirect = 0;
  let sourceRegexKept = 0;
  let sourceRegexDropped = 0;

  for (const rule of raw) {
    if (!validateRule(rule)) {
      malformed++;
      continue;
    }

    if (!supportedStaticAction(rule)) {
      unsupported++;
      continue;
    }

    if (!redirectResourceExists(rule)) {
      brokenRedirect++;
      continue;
    }

    if (isRegexRule(rule)) {
      if (regexBudgetRemaining <= 0) {
        regexDropped++;
        sourceRegexDropped++;
        continue;
      }

      regexBudgetRemaining--;
      sourceRegexKept++;
    }

    actionCounts[rule.action.type] =
      (actionCounts[rule.action.type] || 0) + 1;

    rules.push(rule);
  }

  if (rules.length === 0) {
    console.warn(`SKIP ${source.title}: zero usable DNR rules`);
    continue;
  }

  const sourceRecord = {
    ...source,
    count: rules.length,
    rawCount: raw.length,
    converterErrors: result.errors?.length || 0,
    limitations: result.limitations?.length || 0,
    malformed,
    unsupported,
    brokenRedirect,
    regexKept: sourceRegexKept,
    regexDropped: sourceRegexDropped,
    actionCounts,
  };

  compiledSources.push(sourceRecord);

  console.log(`  usable=${rules.length} raw=${raw.length}`);
  console.log(`  actionCounts=${JSON.stringify(actionCounts)}`);
  console.log(
    `  regexKept=${sourceRegexKept} regexDropped=${sourceRegexDropped}`
  );
  console.log(
    `  converterErrors=${sourceRecord.converterErrors} limitations=${sourceRecord.limitations}`
  );

  const shards = shardRules({
    source,
    rules,
    guaranteedBaseBudget,
  });

  for (const [index, shard] of shards.entries()) {
    const shardId = `phase31_${source.id}_${shard.suffix}`;
    const filename = `filter_${source.id}_${shard.suffix}.json`;

    fs.writeFileSync(
      path.join(rulesDir, filename),
      JSON.stringify(shard.rules)
    );

    const regexCount = shard.rules.reduce(
      (sum, rule) => sum + (isRegexRule(rule) ? 1 : 0),
      0
    );

    packagedShards.push({
      id: shardId,
      family: source.fam,
      title: source.title,
      sourceFilterId: source.id,
      shardIndex: index,
      count: shard.rules.length,
      regexCount,
      priority: shard.priority,
      defaultEnabled: shard.defaultEnabled,
      path: `phase31-rulesets/${filename}`,
    });
  }
}

for (const required of ['base', 'tracking']) {
  if (!compiledSources.some((item) => item.fam === required)) {
    die(`compilation failed for critical '${required}' filter`);
  }
}

for (const shard of packagedShards) {
  manifest.declarative_net_request.rule_resources.push({
    id: shard.id,
    enabled: shard.defaultEnabled,
    path: shard.path,
  });
}

// Expose only exact generated redirect resources and request dynamic URLs to
// avoid publishing one stable extension-resource URL surface.
const warFiles = walk(warDir)
  .filter((file) => fs.statSync(file).isFile())
  .map((file) => path.relative(dist, file).split(path.sep).join('/'));

manifest.web_accessible_resources ??= [];

manifest.web_accessible_resources =
  manifest.web_accessible_resources.filter(
    (entry) =>
      !Array.isArray(entry.resources) ||
      !entry.resources.some((resource) =>
        String(resource).startsWith('web-accessible-resources/')
      )
  );

if (warFiles.length > 0) {
  manifest.web_accessible_resources.push({
    resources: warFiles,
    matches: ['http://*/*', 'https://*/*'],
    use_dynamic_url: true,
  });
}

const catalog = {
  version: 1,
  generatedAt: new Date().toISOString(),
  guaranteedStaticRules: GUARANTEED_STATIC_RULES,
  preExistingEnabledRules: originalEnabledRuleCount,
  regexRuleLimit: MAX_STATIC_REGEX_RULES,
  regexRulesPackaged:
    MAX_STATIC_REGEX_RULES - regexBudgetRemaining,
  rulesets: packagedShards.map((shard) => ({
    id: shard.id,
    family: shard.family,
    title: shard.title,
    sourceFilterId: shard.sourceFilterId,
    shardIndex: shard.shardIndex,
    count: shard.count,
    regexCount: shard.regexCount,
    priority: shard.priority,
    defaultEnabled: shard.defaultEnabled,
  })),
};

fs.writeFileSync(
  path.join(rulesDir, 'catalog.json'),
  JSON.stringify(catalog, null, 2)
);

fs.writeFileSync(
  manifestPath,
  JSON.stringify(manifest, null, 2) + '\n'
);

console.log('\n[VERIFY]');

let totalRules = 0;
let phase31DefaultRules = 0;
let phase31RegexRules = 0;
let failures = 0;

for (const shard of packagedShards) {
  const file = path.join(dist, shard.path);
  const rules = JSON.parse(fs.readFileSync(file, 'utf8'));

  const invalid = rules.find(
    (rule) =>
      !validateRule(rule) ||
      !supportedStaticAction(rule) ||
      !redirectResourceExists(rule)
  );

  if (invalid) {
    console.error(`  FAIL invalid rule in ${shard.id}`);
    failures++;
  }

  const actualRegex = rules.reduce(
    (sum, rule) => sum + (isRegexRule(rule) ? 1 : 0),
    0
  );

  if (actualRegex !== shard.regexCount) {
    console.error(`  FAIL regex count mismatch in ${shard.id}`);
    failures++;
  }

  totalRules += rules.length;
  phase31RegexRules += actualRegex;

  if (shard.defaultEnabled) {
    phase31DefaultRules += rules.length;
  }

  console.log(
    `  OK ${shard.defaultEnabled ? 'DEFAULT ' : 'OPTIONAL'} ${shard.id}: ${rules.length} rules, ${actualRegex} regex`
  );
}

const totalDefaultEnabledRules =
  originalEnabledRuleCount + phase31DefaultRules;

if (
  !originalResources.some(
    (entry) => entry.id === 'ruleset_baseline' && entry.enabled
  )
) {
  console.error('  FAIL verified enabled ruleset_baseline missing');
  failures++;
}

if (totalRules < 50_000) {
  console.error(`  FAIL production corpus too small: ${totalRules}`);
  failures++;
}

if (totalDefaultEnabledRules > GUARANTEED_STATIC_RULES) {
  console.error(
    `  FAIL default enabled corpus exceeds guaranteed static quota: ${totalDefaultEnabledRules}`
  );
  failures++;
}

if (phase31RegexRules > MAX_STATIC_REGEX_RULES) {
  console.error(
    `  FAIL packaged static regex quota exceeded: ${phase31RegexRules}`
  );
  failures++;
}

if (
  packagedShards.filter((shard) => shard.defaultEnabled).length !== 1
) {
  console.error('  FAIL expected exactly one default Phase 3.1 Base shard');
  failures++;
}

if (packagedShards.length > 49) {
  // Keep one slot available for the verified baseline while remaining well
  // inside Chromium's 50-enabled-ruleset runtime limit.
  console.error(`  FAIL too many Phase 3.1 static shards: ${packagedShards.length}`);
  failures++;
}

if (failures > 0) {
  die(`${failures} Phase 3.1 verification failure(s)`);
}

const report = [
  '# ADAPT Phase 3.1 v6 Production Blocking Report',
  '',
  `Generated: ${new Date().toISOString()}`,
  '',
  '## Static quota model',
  `- Chromium guaranteed static floor: **${GUARANTEED_STATIC_RULES.toLocaleString()}**`,
  `- Pre-existing enabled ADAPT rules: **${originalEnabledRuleCount.toLocaleString()}**`,
  `- Guaranteed Base shard: **${phase31DefaultRules.toLocaleString()}**`,
  `- Total default enabled: **${totalDefaultEnabledRules.toLocaleString()}**`,
  '- Remaining shards are enabled at runtime only when Chromium reports capacity.',
  '',
  '## Source filters',
  ...compiledSources.map(
    (item) =>
      `- ${item.title}` +
      ` — ${item.count.toLocaleString()} usable rules` +
      ` — actions ${JSON.stringify(item.actionCounts)}` +
      ` — regex kept ${item.regexKept}` +
      ` — regex dropped ${item.regexDropped}` +
      ` — converter errors ${item.converterErrors}` +
      ` — limitations ${item.limitations}` +
      ` — malformed ${item.malformed}` +
      ` — unsupported ${item.unsupported}` +
      ` — missing redirect resources ${item.brokenRedirect}`
  ),
  '',
  '## Packaged shards',
  ...packagedShards.map(
    (shard) =>
      `- ${shard.defaultEnabled ? 'DEFAULT' : 'OPTIONAL'} — ${shard.id}` +
      ` — ${shard.count.toLocaleString()} rules` +
      ` — ${shard.regexCount} regex` +
      ` — priority ${shard.priority}`
  ),
  '',
  `Total packaged Phase 3.1 DNR rules: **${totalRules.toLocaleString()}**`,
  `Static regex rules packaged: **${phase31RegexRules.toLocaleString()} / ${MAX_STATIC_REGEX_RULES.toLocaleString()}**`,
  `Regex rules dropped for global safety: **${regexDropped.toLocaleString()}**`,
  `Generated redirect resources: **${warFiles.length.toLocaleString()}**`,
  'Cosmetic plane: **delegated to Phase 3.1B page compiler**',
  'Verified Phase 3 ruleset_baseline preserved: **YES**',
].join('\n');

fs.writeFileSync(reportPath, report + '\n');

console.log('\n============================================================');
console.log(' ADAPT PHASE 3.1 v6 — PASS');
console.log('============================================================');
console.log('TOTAL PACKAGED DNR RULES:', totalRules);
console.log('PRE-EXISTING DEFAULT RULES:', originalEnabledRuleCount);
console.log('PHASE31 GUARANTEED BASE RULES:', phase31DefaultRules);
console.log('TOTAL DEFAULT ENABLED RULES:', totalDefaultEnabledRules);
console.log('PACKAGED STATIC REGEX RULES:', phase31RegexRules);
console.log('PHASE31 STATIC SHARDS:', packagedShards.length);
console.log('WAR RESOURCES:', warFiles.length);
console.log('REPORT:', reportPath);

// Stealth plane re-assert (Phase D1): v6 regenerates the manifest and re-walks
// web-accessible-resources, so re-install shims + the adapt_shims ruleset last.
try {
  const { installStealthPlane } = await import('../stealth/install-shims.mjs');
  const stealth = installStealthPlane(dist);
  console.log('STEALTH PLANE:', JSON.stringify(stealth));
} catch (error) {
  console.warn('STEALTH PLANE: install failed —', error?.message || error);
}
