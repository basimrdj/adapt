import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const dist = join(root, 'dist');
const pageDir = join(dist, 'page-filtering');
const manifestPath = join(dist, 'manifest.json');
const buildManifestPath = join(dist, 'phase31', 'BUILD-MANIFEST.json');
const frequencyReportPath = join(dist, 'phase31', 'UNSUPPORTED-SCRIPTLET-FREQUENCY.json');

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

if (!existsSync(manifestPath)) fail('dist/manifest.json is missing');
if (!existsSync(buildManifestPath)) fail('dist/phase31/BUILD-MANIFEST.json is missing');
if (!existsSync(frequencyReportPath)) fail('unsupported scriptlet frequency report is missing');
for (const resource of ['index.json', 'generic.json', 'domain-index.json', 'early-manifest.json', 'early-runtime.js']) {
  if (!existsSync(join(pageDir, resource))) fail(`page filtering artifact is missing: ${resource}`);
}
if (!existsSync(join(pageDir, 'domains')) || !existsSync(join(pageDir, 'early'))) fail('page filtering shard directories are missing');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  content_scripts?: Array<{ css?: unknown }>;
  web_accessible_resources?: Array<{ resources?: unknown; use_dynamic_url?: unknown }>;
};
const buildManifest = JSON.parse(readFileSync(buildManifestPath, 'utf8')) as {
  pagePlane?: {
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

for (const file of filesUnder(pageDir).filter((entry) => entry.endsWith('.js'))) {
  const content = readFileSync(file, 'utf8');
  if (/\beval\s*\(/.test(content) || /\bnew\s+Function\s*\(/.test(content)) fail(`unsafe dynamic code found in ${file}`);
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
const css = manifest.content_scripts?.flatMap((entry) => Array.isArray(entry.css) ? entry.css : []) || [];
if (!css.includes('phase31-page-cosmetic.css')) fail('page filtering CSS is not declared in content_scripts');
if ((buildManifest.pagePlane?.supportedScriptletRules || 0) < 1) fail('no packaged scriptlet rules were produced');
if ((buildManifest.pagePlane?.domainShardCount || 0) !== domainFiles.length) fail('build manifest shard count does not match packaged artifacts');
const coverage = buildManifest.pagePlane?.scriptletCoverage;
if (!coverage || (coverage.parsed || 0) < (coverage.fullyExecutable || 0) || (coverage.fullyExecutable || 0) + (coverage.unsupportedByName || 0) + (coverage.unsupportedByArguments || 0) + (coverage.unsafe || 0) !== (buildManifest.pagePlane?.scriptletRules || 0)) fail('scriptlet coverage accounting is incomplete');
if (!buildManifest.sources?.length || buildManifest.sources.some((source) => !/^[a-f0-9]{64}$/.test(source.sha256 || '') || !String(source.inputPath || '').startsWith('.phase31/'))) fail('filter provenance manifest is incomplete or non-reproducible');
if (filesUnder(dist).some((file) => file.endsWith('.map'))) fail('source maps are present in production dist');

console.log('PHASE31B INTEGRITY: PASS');
