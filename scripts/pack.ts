/**
 * Release packaging: builds the full extension with NO baked development AI
 * credential, verifies the artifact is complete and leak-free, then zips it as
 * release/adapt-<version>.zip (manifest at zip root, as the Chrome Web Store
 * expects).
 *
 * Leak guard: the packed background bundle must not contain the development
 * endpoint host class or any baked config. Only the ADAPT_SKIP_BAKED_AI=1
 * undefined-stub build may be zipped. Host presence is checked by count only —
 * values are never printed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(projectRoot, 'dist');
const releaseDir = path.join(projectRoot, 'release');

function fail(message: string): never {
  console.error(`PACK FAIL: ${message}`);
  process.exit(1);
}

function main(): void {
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'src/manifest.json'), 'utf8')) as { version: string; name: string };
  const zipPath = path.join(releaseDir, `adapt-${manifest.version}.zip`);

  console.log('pack: building full extension with ADAPT_SKIP_BAKED_AI=1 …');
  execFileSync('npm', ['run', 'build:full'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, ADAPT_SKIP_BAKED_AI: '1' },
  });

  // ---- leak guard -------------------------------------------------------
  // The bare suffix ".openai.azure.com" is legitimate shipping code (legacy
  // config inference, the Azure preset placeholder). A BAKED credential only
  // ever appears as a full account-specific endpoint URL or a token literal.
  const backgroundPath = path.join(distDir, 'background.js');
  if (!existsSync(backgroundPath)) fail('dist/background.js missing after build');
  const background = readFileSync(backgroundPath, 'utf8');
  const bakedEndpointCount = (background.match(/https:\/\/[a-z0-9-]+\.openai\.azure\.com/g) ?? []).length;
  if (bakedEndpointCount > 0) fail(`background bundle contains a baked endpoint URL (${bakedEndpointCount}x) — refusing to pack`);
  const bakedTokenCount = (background.match(/"token"\s*:\s*"[0-9a-f]{32,}"/g) ?? []).length;
  if (bakedTokenCount > 0) fail('background bundle contains a baked token literal — refusing to pack');
  const bakedConfigCount = (background.match(/DEV_DEFAULT_AI_CONFIG\s*=\s*\{/g) ?? []).length;
  if (bakedConfigCount > 0) fail('background bundle contains a baked AI config object — refusing to pack');
  console.log('pack: leak guard clean (no baked endpoint URL, token, or config object)');

  // ---- completeness guard ------------------------------------------------
  const required = ['manifest.json', 'background.js', 'content.js', 'popup/index.html', 'options/index.html'];
  for (const rel of required) {
    if (!existsSync(path.join(distDir, rel))) fail(`dist/${rel} missing`);
  }
  for (const size of [16, 32, 48, 128]) {
    if (!existsSync(path.join(distDir, `icons/icon-${size}.png`))) fail(`dist/icons/icon-${size}.png missing`);
  }
  const rulesetsDir = path.join(distDir, 'phase31-rulesets');
  const rulesets = existsSync(rulesetsDir) ? readdirSync(rulesetsDir).filter((file) => file.endsWith('.json')) : [];
  if (rulesets.length === 0) fail('dist/phase31-rulesets empty — static plane missing');
  let ruleCount = 0;
  for (const file of rulesets) {
    const parsed = JSON.parse(readFileSync(path.join(rulesetsDir, file), 'utf8')) as unknown;
    if (Array.isArray(parsed)) ruleCount += parsed.length; // catalog.json is metadata, not rules
  }
  if (ruleCount < 100_000) fail(`static plane suspiciously small (${ruleCount} rules) — refusing to pack`);
  const builtManifest = JSON.parse(readFileSync(path.join(distDir, 'manifest.json'), 'utf8')) as {
    content_scripts?: unknown[];
    declarative_net_request?: { rule_resources?: unknown[] };
  };
  const contentScripts = builtManifest.content_scripts?.length ?? 0;
  console.log(`pack: completeness ok — ${rulesets.length} rulesets / ${ruleCount} rules, ${contentScripts} content script entries`);

  // ---- zip ----------------------------------------------------------------
  mkdirSync(releaseDir, { recursive: true });
  rmSync(zipPath, { force: true });
  // -X strips extended attributes; run inside dist so the zip root IS the extension.
  execFileSync('zip', ['-q', '-r', '-X', zipPath, '.'], { cwd: distDir, stdio: 'inherit' });
  const sizeKb = Math.round((readFileSync(zipPath).length / 1024) * 10) / 10;
  console.log(`pack: wrote ${path.relative(projectRoot, zipPath)} (${sizeKb} KB)`);
  console.log('PACK OK');
}

main();
