import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseFilterLists } from '../src/page/filtering/compiler';
import { PageFilterRule, ScriptletSupportStatus } from '../src/page/filtering/types';

interface SourceManifest {
  id: number;
  title: string;
  version?: string;
  lastModified?: string;
  sha256: string;
  inputPath: string;
}

const root = resolve(process.cwd());
const textDir = join(root, '.phase31', 'text');
const distDir = join(root, 'dist');
const pageDir = join(distDir, 'page-filtering');
const phaseDir = join(distDir, 'phase31');
const manifestPath = join(distDir, 'manifest.json');
const earlyRuntimeSource = join(root, 'src', 'page', 'filtering', 'early-runtime.js');

function titleOf(text: string): string {
  return text.match(/^!\s*(?:Title|Name):\s*(.+)$/im)?.[1]?.trim() || 'Unknown filter';
}

function metadataOf(text: string, name: string): string | undefined {
  return text.match(new RegExp(`^!\\s*${name}:\\s*(.+)$`, 'im'))?.[1]?.trim();
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function safeCssSelector(selector: string): boolean {
  if (!selector || selector.length > 1000 || /[{};]/.test(selector)) return false;
  if (/:has-text\(|:matches-css\(|:xpath\(|:upward\(|:remove\b|:remove-attr\(/i.test(selector)) return false;
  try {
    const probe = selector.replace(/:is\(/gi, ':is(');
    if (!probe) return false;
    return true;
  } catch {
    return false;
  }
}

function genericCssRules(rules: PageFilterRule[], exceptions: ReturnType<typeof parseFilterLists>['exceptions']): string[] {
  const selectors = new Set<string>();
  for (const rule of rules) {
    if (rule.kind !== 'css' || rule.domains.length > 0 || !safeCssSelector(rule.selector)) continue;
    if (rule.detectorBait && rule.detectorBait !== 'ORDINARY_COSMETIC') continue;
    const hasException = exceptions.some((exception) => !exception.scriptletName && exception.selector === rule.selector);
    if (!hasException) selectors.add(rule.selector);
  }
  return [...selectors].slice(0, 20000);
}

function updateManifest(): void {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    content_scripts?: Array<Record<string, unknown>>;
    web_accessible_resources?: Array<Record<string, unknown>>;
  };
  manifest.content_scripts ??= [];
  let contentEntry = manifest.content_scripts.find((entry) => Array.isArray(entry.matches) && entry.matches.includes('http://*/*') && entry.matches.includes('https://*/*'));
  if (!contentEntry) {
    contentEntry = {
      matches: ['http://*/*', 'https://*/*'],
      js: ['content.js'],
      run_at: 'document_start',
      all_frames: true,
      match_about_blank: true,
      match_origin_as_fallback: true,
    };
    manifest.content_scripts.push(contentEntry);
  }
  const css = Array.isArray(contentEntry.css) ? contentEntry.css.filter((value): value is string => typeof value === 'string') : [];
  if (!css.includes('phase31-page-cosmetic.css')) css.push('phase31-page-cosmetic.css');
  contentEntry.css = css;
  manifest.web_accessible_resources ??= [];
  const pageResources = manifest.web_accessible_resources.find((entry) => Array.isArray(entry.resources) && (entry.resources as unknown[]).includes('page-filtering/index.json'));
  const resourceEntry = pageResources || {
    resources: [],
    matches: ['http://*/*', 'https://*/*'],
    use_dynamic_url: true,
  };
  const resources = Array.isArray(resourceEntry.resources) ? resourceEntry.resources.filter((value): value is string => typeof value === 'string') : [];
  for (const resource of ['page-filtering/index.json', 'page-filtering/generic.json', 'page-filtering/domain-index.json', 'phase31-page-cosmetic.css']) {
    if (!resources.includes(resource)) resources.push(resource);
  }
  resourceEntry.resources = resources;
  resourceEntry.matches = ['http://*/*', 'https://*/*'];
  resourceEntry.use_dynamic_url = true;
  if (!pageResources) manifest.web_accessible_resources.push(resourceEntry);
  const earlyEntries = earlyManifest.map((entry) => ({
    matches: ['http://*/*', 'https://*/*'],
    include_globs: [...new Set(entry.matches.map((match) => `*${match.replace(/^\*:\/\/(?:\*\.)?/, '').replace(/\/\*$/, '')}*`))],
    js: [entry.file],
    run_at: 'document_start',
    all_frames: true,
    match_about_blank: true,
    match_origin_as_fallback: true,
    world: 'MAIN',
  }));
  const normalEntries = manifest.content_scripts.filter((entry) => {
    const js = Array.isArray(entry.js) ? entry.js : [];
    return !js.includes('page-filtering/early-runtime.js');
  });
  manifest.content_scripts = [...earlyEntries, ...normalEntries];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (!existsSync(textDir)) throw new Error(`missing validated filter cache: ${textDir}`);
if (!existsSync(manifestPath)) throw new Error(`missing built manifest: ${manifestPath}`);

const inputNames = [
  ...new Set(
    readdirSync(textDir)
      .filter((name: string) => /^filter_\d+\.txt$/.test(name))
      .sort((a: string, b: string) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0))
  ),
];

const sources = inputNames.map((name) => {
  const inputPath = join(textDir, name);
  const text = readFileSync(inputPath, 'utf8');
  return { id: Number(name.match(/\d+/)?.[0] || 0), text, inputPath };
});

if (sources.length === 0) throw new Error('validated filter cache contains no filter text');

const generatedAt = new Date().toISOString();
const bundle = parseFilterLists(sources, generatedAt);
const genericSelectors = genericCssRules(bundle.genericRules, bundle.exceptions);
const earlyRuntimeTemplate = readFileSync(earlyRuntimeSource, 'utf8');
if (!earlyRuntimeTemplate.includes('__EARLY_RULES__')) throw new Error('early runtime template is missing its rules placeholder');

mkdirSync(pageDir, { recursive: true });
mkdirSync(phaseDir, { recursive: true });
mkdirSync(join(root, 'artifacts', 'phase31b'), { recursive: true });
rmSync(join(pageDir, 'domains'), { recursive: true, force: true });
rmSync(join(pageDir, 'early'), { recursive: true, force: true });
mkdirSync(join(pageDir, 'domains'), { recursive: true });
mkdirSync(join(pageDir, 'early'), { recursive: true });

const genericRules = bundle.genericRules.filter((rule) => rule.kind !== 'css');
const genericScriptlets = bundle.scriptlets.filter((rule) => rule.domains.length === 0);
const genericExceptions = bundle.exceptions.filter((exception) => exception.domains.length === 0);
const scriptletFrequency = new Map<string, { total: number; fullyExecutable: number; unsupported: number; statuses: Record<ScriptletSupportStatus, number> }>();
for (const scriptlet of bundle.scriptlets) {
  const current = scriptletFrequency.get(scriptlet.name) || {
    total: 0,
    fullyExecutable: 0,
    unsupported: 0,
    statuses: {
      'fully-executable': 0,
      'unsupported-by-name': 0,
      'unsupported-by-arguments': 0,
      unsafe: 0,
    },
  };
  current.total += 1;
  current.statuses[scriptlet.supportStatus] += 1;
  if (scriptlet.supported) current.fullyExecutable += 1;
  else current.unsupported += 1;
  scriptletFrequency.set(scriptlet.name, current);
}
const frequencyReport = {
  schema: 'adapt-phase31b-unsupported-scriptlet-frequency-v1',
  generatedAt,
  totalScriptletRules: bundle.counts.scriptlets,
  unsupportedScriptletRules: bundle.counts.scriptlets - bundle.counts.fullyExecutable,
  entries: [...scriptletFrequency.entries()]
    .map(([name, counts]) => ({ name, ...counts }))
    .filter((entry) => entry.unsupported > 0)
    .sort((left, right) => right.unsupported - left.unsupported || right.total - left.total || left.name.localeCompare(right.name)),
};
const domainData = new Map<string, { domainRules: PageFilterRule[]; scriptlets: typeof bundle.scriptlets; exceptions: typeof bundle.exceptions }>();
for (const rule of bundle.domainRules) {
  for (const domain of rule.domains) {
    const key = domain.replace(/^\*\./, '');
    const current = domainData.get(key) || { domainRules: [], scriptlets: [], exceptions: [] };
    if (!current.domainRules.some((entry) => entry.id === rule.id)) current.domainRules.push(rule);
    domainData.set(key, current);
  }
}
for (const rule of bundle.scriptlets.filter((entry) => entry.domains.length > 0)) {
  for (const domain of rule.domains) {
    const key = domain.replace(/^\*\./, '');
    const current = domainData.get(key) || { domainRules: [], scriptlets: [], exceptions: [] };
    if (!current.scriptlets.some((entry) => entry.id === rule.id)) current.scriptlets.push(rule);
    domainData.set(key, current);
  }
}
for (const exception of bundle.exceptions.filter((entry) => entry.domains.length > 0)) {
  for (const domain of exception.domains) {
    const key = domain.replace(/^\*\./, '');
    const current = domainData.get(key) || { domainRules: [], scriptlets: [], exceptions: [] };
    const marker = `${exception.scriptletName || 'cosmetic'}|${exception.selector}|${JSON.stringify(exception.scriptletArgs || [])}`;
    if (!current.exceptions.some((entry) => `${entry.scriptletName || 'cosmetic'}|${entry.selector}|${JSON.stringify(entry.scriptletArgs || [])}` === marker)) current.exceptions.push(exception);
    domainData.set(key, current);
  }
}

const domainIndex: Record<string, string> = {};
const earlyManifest: Array<{ file: string; matches: string[] }> = [];
let shardNumber = 0;
const sortedDomainEntries = [...domainData.entries()].sort(([a], [b]) => a.localeCompare(b));
const domainBucketSize = 128;
for (let offset = 0; offset < sortedDomainEntries.length; offset += domainBucketSize) {
  shardNumber += 1;
  const file = `domains/${String(shardNumber).padStart(4, '0')}.json`;
  const bucket = sortedDomainEntries.slice(offset, offset + domainBucketSize);
  const scopedShard: Record<string, { domainRules: PageFilterRule[]; scriptlets: typeof bundle.scriptlets; exceptions: typeof bundle.exceptions }> = {};
  const earlyShard: Record<string, Array<{ name: string; args: string[] }>> = {};
  const matches: string[] = [];
  for (const [domain, data] of bucket) {
    scopedShard[domain] = {
      domainRules: data.domainRules.map((rule) => ({ ...rule, domains: [] })),
      scriptlets: data.scriptlets.map((rule) => ({ ...rule, domains: [] })),
      exceptions: data.exceptions.map((exception) => ({ ...exception, domains: [] })),
    };
    const earlyRules = data.scriptlets.filter((rule) => rule.supported && rule.early && rule.world === 'MAIN');
    const validEarlyDomain = !domain.includes('*') && /^[a-z0-9.-]+$/i.test(domain) && domain.length <= 253;
    domainIndex[domain] = file;
    if (validEarlyDomain) {
      matches.push(`*://${domain}/*`, `*://*.${domain}/*`);
      if (earlyRules.length > 0) earlyShard[domain] = earlyRules.map((rule) => ({ name: rule.name, args: rule.args }));
    }
  }
  writeFileSync(join(pageDir, file), `${JSON.stringify(scopedShard)}\n`);
  if (Object.keys(earlyShard).length > 0) {
    const earlyFile = `early/${String(shardNumber).padStart(4, '0')}.js`;
    writeFileSync(join(pageDir, earlyFile), `${earlyRuntimeTemplate.replace('__EARLY_RULES__', JSON.stringify(earlyShard))}\n`);
    earlyManifest.push({ file: `page-filtering/${earlyFile}`, matches: [...new Set(matches)] });
  }
}

rmSync(join(pageDir, 'early-runtime.js'), { force: true });
writeFileSync(join(pageDir, 'generic.json'), `${JSON.stringify({ genericRules, scriptlets: genericScriptlets, exceptions: genericExceptions })}\n`);
writeFileSync(join(pageDir, 'domain-index.json'), `${JSON.stringify(domainIndex)}\n`);
writeFileSync(join(pageDir, 'early-manifest.json'), `${JSON.stringify(earlyManifest)}\n`);
writeFileSync(join(pageDir, 'index.json'), `${JSON.stringify({ schemaVersion: 3, generatedAt, genericArtifact: 'generic.json', domainIndexArtifact: 'domain-index.json', counts: bundle.counts })}\n`);
writeFileSync(join(phaseDir, 'UNSUPPORTED-SCRIPTLET-FREQUENCY.json'), `${JSON.stringify(frequencyReport, null, 2)}\n`);
writeFileSync(join(root, 'artifacts', 'phase31b', 'unsupported-scriptlet-frequency.json'), `${JSON.stringify(frequencyReport, null, 2)}\n`);
writeFileSync(
  join(distDir, 'phase31-page-cosmetic.css'),
  `${genericSelectors.map((selector) => `${selector}{display:none!important;}`).join('\n')}\n`
);

const sourceManifest: SourceManifest[] = sources.map((source) => {
  const text = source.text;
  return {
    id: source.id,
    title: titleOf(text),
    version: metadataOf(text, 'Version'),
    lastModified: metadataOf(text, 'Last modified') || metadataOf(text, 'Last modified date'),
    sha256: sha256(text),
    inputPath: relative(root, source.inputPath),
  };
});

const buildManifest = {
  schemaVersion: 1,
  generatedAt,
  compiler: 'ADAPT-authored page filtering compiler',
  sources: sourceManifest,
  pagePlane: {
    genericCosmeticCss: genericSelectors.length,
    genericRules: bundle.counts.generic,
    domainSpecificRules: bundle.counts.domainSpecific,
    exceptions: bundle.counts.exceptions,
    scriptletRules: bundle.counts.scriptlets,
    supportedScriptletRules: bundle.counts.supportedScriptlets,
    unsupportedRules: bundle.counts.unsupported,
    scriptletCoverage: {
      parsed: bundle.counts.parsed,
      fullyExecutable: bundle.counts.fullyExecutable,
      fullyExecutableEarly: bundle.counts.fullyExecutableEarly,
      unsupportedByName: bundle.counts.unsupportedByName,
      unsupportedByArguments: bundle.counts.unsupportedByArguments,
      unsafe: bundle.counts.unsafe,
      exceptionSuppressed: bundle.counts.exceptionSuppressed,
    },
    artifacts: ['page-filtering/index.json', 'page-filtering/generic.json', 'page-filtering/domain-index.json', 'page-filtering/domains/', 'page-filtering/early/', 'phase31-page-cosmetic.css'],
    domainShardCount: shardNumber,
    indexedDomainCount: domainData.size,
    earlyDomainCount: earlyManifest.reduce((count, entry) => count + entry.matches.length / 2, 0),
    scriptletFrequencyArtifact: 'dist/phase31/UNSUPPORTED-SCRIPTLET-FREQUENCY.json',
    detectorSensitiveCosmeticRules: bundle.counts.possibleDetectorBait + bundle.counts.confirmedDetectorBait,
  },
  networkPlane: {
    artifacts: ['rules/baseline.json', 'phase31-rulesets/catalog.json'],
    provenance: '.phase31/REPORT-v6.md',
  },
  licensing: {
    implementation: 'ADAPT-authored code',
    filterData: 'Source-specific metadata and headers retained in the source cache',
    review: 'docs/phase31b/LICENSE_REVIEW.md',
  },
};

writeFileSync(join(phaseDir, 'BUILD-MANIFEST.json'), `${JSON.stringify(buildManifest, null, 2)}\n`);
updateManifest();

console.log(`PAGE FILTERING: ${JSON.stringify(bundle.counts)}`);
console.log(`PAGE FILTERING GENERIC CSS: ${genericSelectors.length}`);
console.log(`PAGE FILTERING DETECTOR-SENSITIVE COSMETIC: ${bundle.counts.possibleDetectorBait + bundle.counts.confirmedDetectorBait}`);
console.log(`PAGE FILTERING MANIFEST: ${join(phaseDir, 'BUILD-MANIFEST.json')}`);
