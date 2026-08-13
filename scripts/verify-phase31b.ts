import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const results: Array<{ name: string; command: string; pass: boolean; durationMs: number }> = [];
const startedAt = new Date().toISOString();

function run(name: string, command: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const started = Date.now();
  console.log(`\n[Phase 3.1B] ${name}: ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  results.push({ name, command: [command, ...args].join(' '), pass: result.status === 0, durationMs: Date.now() - started });
  if (result.status !== 0) throw new Error(`${name} failed with status ${result.status}`);
}

try {
  run('TypeScript typecheck', 'npm', ['run', 'typecheck']);
  run('Full reproducible build and filter compilation', 'npm', ['run', 'build:full']);
  run('Page filter compiler unit suite', 'npm', ['run', 'test:page']);
  run('Filter compiler and package integrity', 'npm', ['run', 'verify:phase31b:integrity']);
  run('All unit and Phase 3 regression tests', 'npm', ['run', 'test:unit']);
  run('Synthetic adversarial page lab', 'npm', ['run', 'test:anti-adblock']);
  run('Content runtime stability regression', 'npm', ['run', 'test:runtime']);
  run('Chromium Phase 3 and Phase 3.1B E2E suites', 'npm', ['run', 'test:e2e']);
  run('Bundle security and packaging checks', 'npx', ['vitest', 'run', 'tests/unit/production-bundle-clean.test.ts', 'tests/unit/ai-oracle-security-redteam.test.ts', 'tests/unit/ai-prompt-injection-adv.test.ts']);
} catch (error) {
  const report = { schema: 'adapt-phase31b-verification-v1', startedAt, completedAt: new Date().toISOString(), verdict: 'FAILED', gates: results, error: error instanceof Error ? error.message : String(error) };
  const artifactDir = join(root, 'artifacts', 'phase31b');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.error(`\nPHASE 3.1B VERIFICATION FAILED: ${report.error}`);
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  const report = { schema: 'adapt-phase31b-verification-v1', startedAt, completedAt: new Date().toISOString(), verdict: 'PASSED', gates: results };
  const artifactDir = join(root, 'artifacts', 'phase31b');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log('\nPHASE 3.1B VERIFICATION PASSED');
}
