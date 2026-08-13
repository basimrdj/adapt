import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const dist = join(root, 'dist');
const manifestPath = join(dist, 'manifest.json');
const buildManifestPath = join(dist, 'phase31', 'BUILD-MANIFEST.json');

function fail(message: string): never {
  throw new Error(message);
}

if (!existsSync(manifestPath)) fail('dist/manifest.json is missing');
if (!existsSync(buildManifestPath)) fail('dist/phase31/BUILD-MANIFEST.json is missing');
if (!existsSync(join(dist, 'page-filtering', 'index.json'))) fail('page filtering bundle is missing');
if (!existsSync(join(dist, 'phase31-page-cosmetic.css'))) fail('page filtering CSS is missing');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  content_scripts?: Array<{ css?: unknown }>;
  web_accessible_resources?: Array<{ resources?: unknown; use_dynamic_url?: unknown }>;
};
const buildManifest = JSON.parse(readFileSync(buildManifestPath, 'utf8')) as {
  pagePlane?: { supportedScriptletRules?: number; unsupportedRules?: number };
  sources?: Array<{ sha256?: string; inputPath?: string }>;
};

const css = manifest.content_scripts?.flatMap((entry) => Array.isArray(entry.css) ? entry.css : []) || [];
if (!css.includes('phase31-page-cosmetic.css')) fail('page filtering CSS is not declared in content_scripts');

for (const resource of manifest.web_accessible_resources || []) {
  const resources = Array.isArray(resource.resources) ? resource.resources : [];
  if (resources.length > 128) fail('web-accessible resource surface exceeds the audited bound');
  if (resource.use_dynamic_url !== true && resources.some((value) => String(value).startsWith('web-accessible-resources/'))) {
    fail('redirect resources must use dynamic URLs');
  }
}

const pageBundle = JSON.parse(readFileSync(join(dist, 'page-filtering', 'index.json'), 'utf8')) as {
  scriptlets?: Array<{ name?: string; supported?: boolean; world?: string }>;
};
for (const scriptlet of pageBundle.scriptlets || []) {
  if (scriptlet.supported && scriptlet.world === 'MAIN' && scriptlet.name !== 'set-constant') {
    fail(`unsupported MAIN-world scriptlet escaped the allowlist: ${scriptlet.name}`);
  }
}

for (const file of readdirSync(dist).filter((name) => name.endsWith('.js'))) {
  const content = readFileSync(join(dist, file), 'utf8');
  if (/\beval\s*\(/.test(content) || /\bnew\s+Function\s*\(/.test(content)) fail(`unsafe dynamic code found in ${file}`);
  if (/AZURE_OPENAI_API_KEY|openai\.azure\.com|localhost:\d{4}/i.test(content)) fail(`development endpoint or secret marker found in ${file}`);
}

if ((buildManifest.pagePlane?.supportedScriptletRules || 0) < 1) fail('no packaged scriptlet rules were produced');
if (!buildManifest.sources?.length || buildManifest.sources.some((source) => !/^[a-f0-9]{64}$/.test(source.sha256 || '') || !String(source.inputPath || '').startsWith('.phase31/'))) {
  fail('filter provenance manifest is incomplete or non-reproducible');
}

if (readdirSync(dist, { withFileTypes: true }).some((entry) => entry.name.endsWith('.map'))) fail('source maps are present in production dist');

console.log('PHASE31B INTEGRITY: PASS');
