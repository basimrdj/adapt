import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const results: Array<{ name: string; command: string; pass: boolean; durationMs: number }> = [];
const startedAt = new Date().toISOString();
const artifactDir = join(root, 'artifacts', 'phase31b');

function run(name: string, command: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const started = Date.now();
  console.log(`\n[Phase 3.1B] ${name}: ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  const pass = result.status === 0;
  results.push({ name, command: [command, ...args].join(' '), pass, durationMs: Date.now() - started });
  if (!pass) throw new Error(`${name} failed with status ${result.status}`);
}

function readArtifact<T>(name: string): T {
  const file = join(artifactDir, name);
  if (!existsSync(file)) throw new Error(`required evidence artifact is missing: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function validateEvidence(): Record<string, unknown> {
  const adversarial = readArtifact<{
    total: number;
    passed: number;
    failed: number;
    results?: Array<{ id: string; pass: boolean; resultClass?: string }>;
    classCounts?: Record<string, number>;
  }>('adversarial-results.json');
  if (adversarial.total !== 30 || adversarial.passed !== 30 || adversarial.failed !== 0) throw new Error(`adversarial corpus evidence is ${adversarial.passed}/${adversarial.total}`);
  if (!adversarial.results || adversarial.results.length !== 30 || adversarial.results.some((result) => !result.pass || !result.resultClass)) throw new Error('adversarial evidence is missing executable result classifications');
  const corpus = JSON.parse(readFileSync(join(root, 'tests/fixtures/phase31b/adversarial-corpus.json'), 'utf8')) as Array<{ id: string; category: string; negativeControl: boolean }>;
  const categories = new Map(corpus.map((entry) => [entry.id, entry]));
  if (adversarial.results.some((result) => result.resultClass === 'PRESENCE_ONLY' && categories.get(result.id)?.category === 'anti-adblock')) throw new Error('anti-adblock success is being counted from a presence-only scenario');
  const benchmark = readArtifact<{ baselineIndexBytes: number; afterIndexBytes: number; perFrameBytes: number; perFrameParseMs: number; mutationBenchmarkMs: number; noFullBundleParsePerFrame: boolean }>('page-filter-benchmark.json');
  if (!benchmark.noFullBundleParsePerFrame || benchmark.afterIndexBytes >= 4096 || benchmark.perFrameBytes >= 14_000_000) throw new Error('page-filter benchmark exceeded startup/per-frame bounds');
  const buildManifest = readArtifact<{ pagePlane?: { scriptletRules?: number; supportedScriptletRules?: number; scriptletCoverage?: Record<string, number>; detectorSensitiveCosmeticRules?: number } }>(join('..', '..', 'dist/phase31/BUILD-MANIFEST.json'));
  const frequency = readArtifact<{ totalScriptletRules: number; unsupportedScriptletRules: number; entries: Array<{ name: string; unsupported: number }> }>('unsupported-scriptlet-frequency.json');
  const coverage = buildManifest.pagePlane?.scriptletCoverage || {};
  const coverageTotal = ['fullyExecutable', 'unsupportedByName', 'unsupportedByArguments', 'unsafe'].reduce((total, key) => total + (coverage[key] || 0), 0);
  if ((buildManifest.pagePlane?.scriptletRules || 0) !== coverageTotal) throw new Error('scriptlet coverage totals do not reconcile');
  if (frequency.totalScriptletRules !== buildManifest.pagePlane?.scriptletRules) throw new Error('unsupported scriptlet frequency evidence does not reconcile');
  const stealth = readArtifact<{
    total: number;
    passed: number;
    failed: number;
    results?: Array<{ id: string; pass: boolean; resultClass?: string }>;
    resultClasses?: Record<string, number>;
    liveCanYouBlockIt?: string;
  }>('stealth-results.json');
  if (stealth.total !== 11 || stealth.passed !== 11 || stealth.failed !== 0) throw new Error(`stealth corpus evidence is ${stealth.passed}/${stealth.total}`);
  if (!stealth.results || stealth.results.length !== 11 || stealth.results.some((result) => !result.pass || !result.resultClass)) throw new Error('stealth evidence is missing executable result classifications');
  if (stealth.results.some((result) => result.resultClass === 'PRESENCE_ONLY')) throw new Error('stealth evidence contains presence-only success');
  if (stealth.liveCanYouBlockIt !== 'NOT_OBSERVED') throw new Error('live CanYouBlockIt status must remain NOT_OBSERVED before manual acceptance');
  if ((buildManifest.pagePlane?.detectorSensitiveCosmeticRules || 0) < 1) throw new Error('detector-sensitive cosmetic rule count is missing');
  return { adversarial, stealth, benchmark, detectorSensitiveCosmeticRules: buildManifest.pagePlane?.detectorSensitiveCosmeticRules, scriptletCoverage: coverage, scriptletRules: buildManifest.pagePlane?.scriptletRules, supportedScriptletRules: buildManifest.pagePlane?.supportedScriptletRules, unsupportedScriptletFrequency: frequency };
}

let evidence: Record<string, unknown> | undefined;
try {
  run('TypeScript typecheck', 'npm', ['run', 'typecheck']);
  run('Full reproducible build and indexed page compilation', 'npm', ['run', 'build:full']);
  run('Indexed page-plane benchmark', 'npm', ['run', 'benchmark:page']);
  run('Page filter compiler and index unit suite', 'npm', ['run', 'test:page']);
  run('Filter compiler and package integrity', 'npm', ['run', 'verify:phase31b:integrity']);
  run('All unit and Phase 3 regression tests', 'npm', ['run', 'test:unit']);
  run('Passive detector-bait stealth corpus', 'npm', ['run', 'test:stealth']);
  run('30-scenario executable adversarial corpus', 'npm', ['run', 'test:anti-adblock']);
  evidence = validateEvidence();
  run('Content runtime stability regression', 'npm', ['run', 'test:runtime']);
  run('Chromium Phase 3 and Phase 3.1B E2E suites', 'npm', ['run', 'test:e2e']);
  run('Bundle security and packaging checks', 'npx', ['vitest', 'run', 'tests/unit/production-bundle-clean.test.ts', 'tests/unit/ai-oracle-security-redteam.test.ts', 'tests/unit/ai-prompt-injection-adv.test.ts']);
} catch (error) {
  const report = { schema: 'adapt-phase31b-verification-v2', startedAt, completedAt: new Date().toISOString(), verdict: 'FAILED', gates: results, evidence, error: error instanceof Error ? error.message : String(error) };
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.error(`\nPHASE 3.1B VERIFICATION FAILED: ${report.error}`);
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  const report = { schema: 'adapt-phase31b-verification-v2', startedAt, completedAt: new Date().toISOString(), verdict: 'PASSED', gates: results, evidence };
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log('\nPHASE 3.1B VERIFICATION PASSED');
}
