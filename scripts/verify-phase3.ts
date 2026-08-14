import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startTestServers } from '../tests/pages/server';
import { chromeExecutable } from '../tests/support/chrome-executable';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = path.join(root, 'artifacts', 'phase3');
const startedAt = new Date();

interface GateResult {
  name: string;
  command: string;
  pass: boolean;
  durationMs: number;
}

function run(name: string, command: string, args: string[], env?: NodeJS.ProcessEnv): GateResult {
  const start = Date.now();
  console.log(`\n[Phase 3] ${name}: ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  return {
    name,
    command: [command, ...args].join(' '),
    pass: result.status === 0,
    durationMs: Date.now() - start,
  };
}

async function openManualDemo(): Promise<void> {
  const servers = await startTestServers(4050, 4051);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-phase3-manual-'));
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromeExecutable(),
    userDataDir: profile,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${path.join(root, 'dist')}`,
      `--load-extension=${path.join(root, 'dist')}`,
      '--no-sandbox',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://localhost:4050/t29-phase3-acceptance/index.html', { waitUntil: 'networkidle2' });
  console.log('\n[Phase 3] Manual demo is open in a fresh Chromium profile.');
  console.log('[Phase 3] Expected: the scroll-only hypothesis rolls back; bait preservation resolves the gate.');
  console.log('[Phase 3] Press Enter here after inspection to close Chromium.');
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
  await browser.close();
  await servers.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const results: GateResult[] = [];
  results.push(run('TypeScript typecheck', 'npm', ['run', 'typecheck']));
  results.push(run('Unit, property, policy, and integration tests', 'npm', ['run', 'test:unit']));
  results.push(run('Production build', 'npm', ['run', 'build']));
  results.push(run('Real Chromium suites and 20-step acceptance coverage', 'npm', ['run', 'test:e2e']));

  const labTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-phase3-m7-'));
  const labPython = path.join(labTemp, 'venv', 'bin', 'python');
  results.push(run('M7 clean environment', 'python3', ['-m', 'venv', path.join(labTemp, 'venv')]));
  results.push(run('M7 pinned dependency install', path.join(labTemp, 'venv', 'bin', 'pip'), [
    'install', '--disable-pip-version-check', '-q', '-r', 'tools/causal-lab/requirements.txt',
  ]));
  results.push(run('M7 algorithm tests', labPython, ['-m', 'unittest', '-v', 'tools/causal-lab/test_benchmark.py']));
  results.push(run('M7 deterministic benchmark', labPython, ['tools/causal-lab/run_benchmark.py']));
  results.push(run('M7 independent raw-metric recomputation', labPython, ['tools/causal-lab/verify_results.py']));
  fs.rmSync(labTemp, { recursive: true, force: true });

  results.push(run('Bundle and security tests', 'npx', [
    'vitest', 'run',
    'tests/unit/production-bundle-clean.test.ts',
    'tests/unit/ai-oracle-security-redteam.test.ts',
    'tests/unit/ai-prompt-injection-adv.test.ts',
  ]));
  results.push(run('Graphify portable artifact check', 'graphify', ['portable-check', '.']));
  results.push(run('Graphify structural graph parse and integrity check', 'graphify', [
    'summary', '.graphify/graph.json',
  ]));

  const pass = results.every((result) => result.pass);
  const report = {
    schema: 'adapt-phase3-verification-v1',
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    gates: results,
    verdict: pass ? 'PHASE 3 VERIFIED' : 'PHASE 3 NOT VERIFIED',
  };
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(artifactDir, 'latest.md'), [
    '# ADAPT Phase 3 verification runner', '',
    `Started: ${report.startedAt}`, `Completed: ${report.completedAt}`, '',
    '| Gate | Result | Duration ms |', '|---|---|---:|',
    ...results.map((result) => `| ${result.name} | ${result.pass ? 'PASS' : 'FAIL'} | ${result.durationMs} |`),
    '', `## ${report.verdict}`, '',
  ].join('\n'));

  console.log(`\n${report.verdict}`);
  console.log(`[Phase 3] Machine result: ${path.join(artifactDir, 'latest.json')}`);
  console.log(`[Phase 3] Human result: ${path.join(artifactDir, 'latest.md')}`);
  if (!pass) process.exitCode = 1;

  const manual = process.argv.includes('--manual')
    || (process.env.ADAPT_PHASE3_MANUAL !== '0' && Boolean(process.stdin.isTTY));
  if (pass && manual) await openManualDemo();
}

await main();
