import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { classifyDetectorBaitSelector } from '../src/page/filtering/compiler';

const root = resolve(process.cwd());
const dist = join(root, 'dist');
const pageDir = join(dist, 'page-filtering');
const manifestPath = join(dist, 'manifest.json');
const buildManifestPath = join(dist, 'phase31', 'BUILD-MANIFEST.json');
const frequencyReportPath = join(dist, 'phase31', 'UNSUPPORTED-SCRIPTLET-FREQUENCY.json');
const phaseArtifactDir = join(root, 'artifacts', 'phase31b');

function fail(message: string): never {
  throw new Error(message);
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

function codeWithoutStringLiterals(source: string): string {
  let output = '';
  let quote = '';
  let escaped = false;
  for (const char of source) {
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      output += ' ';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      output += ' ';
      continue;
    }
    output += char;
  }
  return output;
}

function detectorBaitSelectorsInCss(source: string): string[] {
  const selectors = new Set<string>();
  for (const match of source.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const prelude = match[1]?.trim() || '';
    const candidates = prelude.startsWith(':is(') && prelude.endsWith(')')
      ? prelude.slice(4, -1).split(',').map((selector) => selector.trim())
      : [prelude];
    for (const selector of candidates) {
      if (classifyDetectorBaitSelector(selector) !== 'ORDINARY_COSMETIC') selectors.add(selector);
    }
  }
  return [...selectors];
}

interface EvidenceMetadata {
  verificationRunId?: string;
  sourceCommitSha?: string;
  generatedAt?: string;
  buildFingerprint?: string;
}

function readJson<T>(file: string): T {
  if (!existsSync(file)) fail(`canonical evidence artifact is missing: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function assertSameMetadata(name: string, artifact: EvidenceMetadata, expected: Required<EvidenceMetadata>): void {
  for (const key of ['verificationRunId', 'sourceCommitSha', 'generatedAt', 'buildFingerprint'] as const) {
    if (artifact[key] !== expected[key]) fail(`${name} metadata ${key} does not match canonical run`);
  }
}

function verifyCanonicalEvidence(): void {
  const latest = readJson<{
    verificationRunId?: string;
    sourceCommitSha?: string;
    generatedAt?: string;
    buildFingerprint?: string;
    verdict?: string;
    evidence?: {
      adversarial?: { total?: number; passed?: number; failed?: number; results?: unknown[] };
      stealth?: { total?: number; passed?: number; failed?: number; results?: unknown[] };
      benchmark?: { afterIndexBytes?: number; noFullBundleParsePerFrame?: boolean };
    };
  }>(join(phaseArtifactDir, 'latest.json'));
  const adversarial = readJson<EvidenceMetadata & { total?: number; passed?: number; failed?: number; results?: Array<{ pass?: boolean }> }>(join(phaseArtifactDir, 'adversarial-results.json'));
  const stealth = readJson<EvidenceMetadata & { total?: number; passed?: number; failed?: number; results?: Array<{ pass?: boolean }> }>(join(phaseArtifactDir, 'stealth-results.json'));
  const benchmark = readJson<EvidenceMetadata & { afterIndexBytes?: number; noFullBundleParsePerFrame?: boolean }>(join(phaseArtifactDir, 'page-filter-benchmark.json'));
  const frequency = readJson<EvidenceMetadata & { totalScriptletRules?: number; entries?: unknown[] }>(join(phaseArtifactDir, 'unsupported-scriptlet-frequency.json'));
  const metadata: Required<EvidenceMetadata> = {
    verificationRunId: latest.verificationRunId ?? '',
    sourceCommitSha: latest.sourceCommitSha ?? '',
    generatedAt: latest.generatedAt ?? '',
    buildFingerprint: latest.buildFingerprint ?? '',
  };
  if (Object.values(metadata).some((value) => value.length === 0)) fail('latest.json is missing canonical verification metadata');
  assertSameMetadata('adversarial-results.json', adversarial, metadata);
  assertSameMetadata('stealth-results.json', stealth, metadata);
  assertSameMetadata('page-filter-benchmark.json', benchmark, metadata);
  assertSameMetadata('unsupported-scriptlet-frequency.json', frequency, metadata);
  if (latest.verdict !== 'PENDING' && latest.verdict !== 'PASSED') fail(`latest.json has unsupported verdict: ${latest.verdict}`);
  if (adversarial.total !== 30 || adversarial.passed !== 30 || adversarial.failed !== 0 || adversarial.results?.length !== 30 || adversarial.results.some((result) => result.pass !== true)) fail('adversarial standalone evidence is incomplete or failed');
  if (stealth.total !== 11 || stealth.passed !== 11 || stealth.failed !== 0 || stealth.results?.length !== 11 || stealth.results.some((result) => result.pass !== true)) fail('stealth standalone evidence is incomplete or failed');
  if (latest.evidence?.adversarial?.total !== adversarial.total || latest.evidence?.adversarial?.passed !== adversarial.passed || latest.evidence?.adversarial?.failed !== adversarial.failed || latest.evidence?.adversarial?.results?.length !== adversarial.results.length) fail('latest.json disagrees with adversarial standalone evidence');
  if (latest.evidence?.stealth?.total !== stealth.total || latest.evidence?.stealth?.passed !== stealth.passed || latest.evidence?.stealth?.failed !== stealth.failed || latest.evidence?.stealth?.results?.length !== stealth.results.length) fail('latest.json disagrees with stealth standalone evidence');
  if (latest.evidence?.benchmark?.afterIndexBytes !== benchmark.afterIndexBytes || latest.evidence?.benchmark?.noFullBundleParsePerFrame !== benchmark.noFullBundleParsePerFrame) fail('latest.json disagrees with page-filter benchmark evidence');
}

if (!existsSync(manifestPath)) fail('dist/manifest.json is missing');
if (!existsSync(buildManifestPath)) fail('dist/phase31/BUILD-MANIFEST.json is missing');
if (!existsSync(frequencyReportPath)) fail('unsupported scriptlet frequency report is missing');
for (const resource of ['index.json', 'generic.json', 'domain-index.json', 'early-manifest.json']) {
  if (!existsSync(join(pageDir, resource))) fail(`page filtering artifact is missing: ${resource}`);
}
if (existsSync(join(pageDir, 'early-runtime.js'))) fail('page filtering early runtime bridge must not be packaged');
if (!existsSync(join(pageDir, 'domains')) || !existsSync(join(pageDir, 'early'))) fail('page filtering shard directories are missing');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  content_scripts?: Array<{ css?: unknown }>;
  web_accessible_resources?: Array<{ resources?: unknown; use_dynamic_url?: unknown }>;
};
const buildManifest = JSON.parse(readFileSync(buildManifestPath, 'utf8')) as {
  pagePlane?: {
    artifacts?: string[];
    cosmeticOwners?: number;
    cosmeticOwner?: string;
    scriptletRules?: number;
    supportedScriptletRules?: number;
    unsupportedRules?: number;
    domainShardCount?: number;
    scriptletCoverage?: { parsed?: number; fullyExecutable?: number; unsupportedByName?: number; unsupportedByArguments?: number; unsafe?: number; exceptionSuppressed?: number };
  };
  sources?: Array<{ sha256?: string; inputPath?: string }>;
};
const frequencyReport = JSON.parse(readFileSync(frequencyReportPath, 'utf8')) as {
  schema?: string;
  totalScriptletRules?: number;
  entries?: Array<{ name?: string; unsupported?: number; total?: number }>;
};
if (frequencyReport.schema !== 'adapt-phase31b-unsupported-scriptlet-frequency-v1') fail('unsupported scriptlet frequency report has the wrong schema');
if (frequencyReport.totalScriptletRules !== buildManifest.pagePlane?.scriptletRules) fail('unsupported scriptlet frequency report total does not reconcile');
if (!Array.isArray(frequencyReport.entries) || frequencyReport.entries.some((entry) => !entry.name || (entry.unsupported || 0) <= 0 || (entry.unsupported || 0) > (entry.total || 0))) fail('unsupported scriptlet frequency report contains invalid entries');
const index = JSON.parse(readFileSync(join(pageDir, 'index.json'), 'utf8')) as { schemaVersion?: number; genericArtifact?: string; domainIndexArtifact?: string; counts?: { supportedScriptlets?: number } };
if (index.schemaVersion !== 3 || index.genericArtifact !== 'generic.json' || index.domainIndexArtifact !== 'domain-index.json') fail('page filtering index is not the v3 sharded schema');
if (statSync(join(pageDir, 'index.json')).size >= 4096) fail('page filtering startup index exceeds 4 KiB');

const generic = JSON.parse(readFileSync(join(pageDir, 'generic.json'), 'utf8')) as { scriptlets?: Array<{ name?: string; supported?: boolean; world?: string }> };
const domainIndex = JSON.parse(readFileSync(join(pageDir, 'domain-index.json'), 'utf8')) as Record<string, string>;
const domainFiles = filesUnder(join(pageDir, 'domains')).filter((file) => file.endsWith('.json'));
if (domainFiles.length < 2 || Object.keys(domainIndex).length < domainFiles.length) fail('domain index/shard coverage is incomplete');
const earlyManifest = JSON.parse(readFileSync(join(pageDir, 'early-manifest.json'), 'utf8')) as Array<{ file?: string; matches?: string[] }>;
if (!Array.isArray(earlyManifest)) fail('early scriptlet manifest is not an array');
if (earlyManifest.some((entry) => !entry.file || !entry.matches?.length)) fail('early scriptlet manifest contains an incomplete registration');
const staticEarlyEntries = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { content_scripts?: Array<{ js?: unknown; run_at?: unknown; world?: unknown }> }).content_scripts?.filter((entry) => Array.isArray(entry.js) && (entry.js as unknown[]).some((value) => String(value).startsWith('page-filtering/early/'))) || [];
if (staticEarlyEntries.length !== earlyManifest.length) fail('static early manifest registrations do not reconcile with generated early shards');
if (new Set(staticEarlyEntries.flatMap((entry) => Array.isArray(entry.js) ? entry.js.map(String) : [])).size !== staticEarlyEntries.length) fail('early shard is registered more than once');

for (const file of filesUnder(pageDir).filter((entry) => entry.endsWith('.js'))) {
  const content = readFileSync(file, 'utf8');
  const code = codeWithoutStringLiterals(content);
  if (/\beval\s*\(/.test(code) || /\bnew\s+Function\s*\(/.test(code)) fail(`unsafe dynamic code found in ${file}`);
}
for (const scriptlet of generic.scriptlets || []) {
  if (scriptlet.supported && scriptlet.world === 'MAIN' && !['set-constant', 'abort-current-inline-script', 'abort-on-property-read', 'abort-on-property-write', 'prevent-fetch', 'prevent-xhr', 'prevent-setTimeout', 'prevent-eval-if', 'prevent-window-open', 'json-prune'].includes(scriptlet.name || '')) {
    fail(`unsupported MAIN-world scriptlet escaped the allowlist: ${scriptlet.name}`);
  }
}

for (const resource of manifest.web_accessible_resources || []) {
  const resources = Array.isArray(resource.resources) ? resource.resources : [];
  if (resources.length > 128) fail('web-accessible resource surface exceeds the audited bound');
  if (resource.use_dynamic_url !== true && resources.some((value) => String(value).startsWith('web-accessible-resources/'))) fail('redirect resources must use dynamic URLs');
}
const manifestCss = manifest.content_scripts?.flatMap((entry) => Array.isArray(entry.css) ? entry.css.filter((value): value is string => typeof value === 'string') : []) || [];
const cssFiles = filesUnder(dist)
  .filter((file) => file.endsWith('.css'))
  .map((file) => relative(dist, file).split(sep).join('/'));
const generatedGenericCosmeticCss = cssFiles.filter((file) => file.toLowerCase().includes('generic-cosmetic'));
if (generatedGenericCosmeticCss.length > 0) fail(`legacy generic cosmetic CSS artifacts are present: ${generatedGenericCosmeticCss.join(', ')}`);
if (manifestCss.some((file) => file.toLowerCase().includes('generic-cosmetic'))) fail('manifest references a legacy generic cosmetic CSS artifact');
for (const file of manifestCss) {
  if (!cssFiles.includes(file)) fail(`manifest-declared CSS artifact is missing: ${file}`);
}
const pagePlaneCss = (buildManifest.pagePlane?.artifacts || []).filter((file) => file.endsWith('.css'));
if (buildManifest.pagePlane?.cosmeticOwners !== 1 || buildManifest.pagePlane?.cosmeticOwner !== 'phase31b-page-plane') fail('cosmetic owner registry must report exactly phase31b-page-plane');
if (pagePlaneCss.length !== 1) fail(`page plane must declare exactly one generated CSS artifact, found ${pagePlaneCss.length}`);
if (manifestCss.length !== pagePlaneCss.length || manifestCss.some((file) => !pagePlaneCss.includes(file))) fail(`content-script CSS ownership is not singular: ${manifestCss.join(', ')}`);
const activeCosmeticCss = [...new Set(manifestCss.filter((file) => file.toLowerCase().includes('cosmetic') || pagePlaneCss.includes(file)))];
if (activeCosmeticCss.length !== 1) fail(`more than one generated generic cosmetic baseline is active: ${activeCosmeticCss.join(', ') || 'none'}`);
if (activeCosmeticCss[0] !== pagePlaneCss[0]) fail(`active cosmetic baseline does not match page-plane owner: ${activeCosmeticCss.join(', ')}`);
const detectorSensitiveCss = cssFiles.flatMap((file) => detectorBaitSelectorsInCss(readFileSync(join(dist, file), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ')).map((selector) => ({ file, selector })));
if (detectorSensitiveCss.length > 0) fail(`detector-sensitive selectors appear in production CSS: ${detectorSensitiveCss.map((entry) => `${entry.file}:${entry.selector}`).join(', ')}`);
if ((buildManifest.pagePlane?.supportedScriptletRules || 0) < 1) fail('no packaged scriptlet rules were produced');
if ((buildManifest.pagePlane?.domainShardCount || 0) !== domainFiles.length) fail('build manifest shard count does not match packaged artifacts');
const coverage = buildManifest.pagePlane?.scriptletCoverage;
if (!coverage || (coverage.parsed || 0) < (coverage.fullyExecutable || 0) || (coverage.fullyExecutable || 0) + (coverage.unsupportedByName || 0) + (coverage.unsupportedByArguments || 0) + (coverage.unsafe || 0) !== (buildManifest.pagePlane?.scriptletRules || 0)) fail('scriptlet coverage accounting is incomplete');
if (!buildManifest.sources?.length || buildManifest.sources.some((source) => !/^[a-f0-9]{64}$/.test(source.sha256 || '') || !String(source.inputPath || '').startsWith('.phase31/'))) fail('filter provenance manifest is incomplete or non-reproducible');
if (filesUnder(dist).some((file) => file.endsWith('.map'))) fail('source maps are present in production dist');
verifyCanonicalEvidence();

console.log(JSON.stringify({
  cosmeticOwners: buildManifest.pagePlane?.cosmeticOwners,
  cosmeticOwner: buildManifest.pagePlane?.cosmeticOwner,
  manifestCss,
  generatedCssFiles: cssFiles,
}, null, 2));

console.log('PHASE31B INTEGRITY: PASS');
