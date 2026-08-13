import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseFilterLists } from '../src/page/filtering/compiler';
import { PageFilterRule } from '../src/page/filtering/types';

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
  for (const resource of ['page-filtering/index.json', 'phase31-page-cosmetic.css']) {
    if (!resources.includes(resource)) resources.push(resource);
  }
  resourceEntry.resources = resources;
  resourceEntry.matches = ['http://*/*', 'https://*/*'];
  resourceEntry.use_dynamic_url = true;
  if (!pageResources) manifest.web_accessible_resources.push(resourceEntry);
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

mkdirSync(pageDir, { recursive: true });
mkdirSync(phaseDir, { recursive: true });

writeFileSync(join(pageDir, 'index.json'), `${JSON.stringify(bundle)}\n`);
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
    artifacts: ['page-filtering/index.json', 'phase31-page-cosmetic.css'],
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
console.log(`PAGE FILTERING MANIFEST: ${join(phaseDir, 'BUILD-MANIFEST.json')}`);
