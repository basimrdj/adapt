/**
 * Clean-profile verification of the PACKED artifact (release/adapt-<version>.zip).
 *
 * Unzips the release into a temp dir, loads exactly that into a fresh Chrome
 * profile, and proves the shipped extension works end to end:
 *   1. static plane intact — a fixture page's tracker request is blocked;
 *   2. no baked AI — the in-product status channel reports configured:false,
 *      source 'none' (the bring-your-own-key surface is the only AI story);
 *   3. popup renders (hero + pause affordance) with zero page errors;
 *   4. options renders (AI planner form) with zero page errors.
 *
 * Writes artifacts/release/PACKAGED_VERIFY.json and exits nonzero on failure.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { Browser } from 'puppeteer';
import { chromeExecutable } from '../tests/support/chrome-executable';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function startFixtureServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const html = `<!doctype html><html><body><h1>packaged verify fixture</h1>
    <script src="https://doubleclick.net/packaged-verify-pixel.js"></script></body></html>`;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('fixture server failed to bind'));
      resolve({ port: address.port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'src/manifest.json'), 'utf8')) as { version: string };
  const zipPath = path.join(projectRoot, 'release', `adapt-${manifest.version}.zip`);
  if (!existsSync(zipPath)) {
    console.error(`VERIFY-PACKAGED FAIL: ${path.relative(projectRoot, zipPath)} not found — run npm run pack first`);
    process.exit(1);
  }

  const unpackDir = mkdtempSync(path.join(os.tmpdir(), 'adapt-packaged-'));
  const artifactDir = path.join(projectRoot, 'artifacts', 'release');
  mkdirSync(artifactDir, { recursive: true });
  const checks: CheckResult[] = [];
  let browser: Browser | undefined;
  let fixture: { port: number; close: () => Promise<void> } | undefined;

  try {
    execFileSync('unzip', ['-q', zipPath, '-d', unpackDir]);
    if (!existsSync(path.join(unpackDir, 'manifest.json'))) throw new Error('unzipped artifact has no manifest.json at root');

    fixture = await startFixtureServer();
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromeExecutable(),
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--headless=new', `--disable-extensions-except=${unpackDir}`, `--load-extension=${unpackDir}`, '--no-sandbox'],
    });

    // Our service worker, matched by script name.
    const swTarget = await browser.waitForTarget(
      (target) => target.type() === 'service_worker' && /chrome-extension:\/\/[^/]+\/background\.js$/.test(target.url()),
      { timeout: 15_000 }
    );
    const extensionId = new URL(swTarget.url()).host;
    checks.push({ name: 'service-worker-boot', ok: true, detail: extensionId.slice(0, 8) });

    // 1. Static plane blocks the fixture tracker.
    {
      const page = await browser.newPage();
      const failure = new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 12_000);
        page.on('requestfailed', (request) => {
          if (request.url().startsWith('https://doubleclick.net/')) {
            clearTimeout(timer);
            resolve(request.failure()?.errorText ?? null);
          }
        });
      });
      await page.goto(`http://127.0.0.1:${fixture.port}/fixture`, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
      const reason = await failure;
      checks.push({ name: 'static-plane-blocks', ok: reason === 'net::ERR_BLOCKED_BY_CLIENT', detail: reason ?? 'no failure observed' });
      await page.close();
    }

    // 2. No baked AI: in-product status from the real options page.
    {
      const options = await browser.newPage();
      const pageErrors: string[] = [];
      options.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 120)));
      await options.goto(`chrome-extension://${extensionId}/options/index.html`, { waitUntil: 'networkidle0', timeout: 20_000 });
      const status = await options.evaluate(async () => {
        const response = await chrome.runtime.sendMessage({ scope: 'adapt-ai-admin', type: 'AI_GET_STATUS' });
        return response as { configured?: boolean; source?: string; endpoint?: string | null } | undefined;
      });
      const formPresent = await options.evaluate(() => {
        return ['status-badge', 'endpoint', 'model', 'token', 'btn-test', 'btn-save'].every((id) => document.getElementById(id) !== null);
      });
      const noBaked = status?.configured === false && status?.source === 'none' && status?.endpoint === null;
      checks.push({ name: 'no-baked-ai', ok: noBaked, detail: JSON.stringify({ configured: status?.configured, source: status?.source, endpoint: status?.endpoint }) });
      checks.push({ name: 'options-renders', ok: formPresent && pageErrors.length === 0, detail: pageErrors[0] ?? `form fields present: ${formPresent}` });
      await options.close();
    }

    // 3. Popup renders with hero + pause affordance and zero page errors.
    {
      const popup = await browser.newPage();
      const pageErrors: string[] = [];
      popup.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 120)));
      await popup.goto(`chrome-extension://${extensionId}/popup/index.html`, { waitUntil: 'networkidle0', timeout: 20_000 });
      const state = await popup.evaluate(() => ({
        title: document.getElementById('hero-title')?.textContent ?? null,
        pauseButton: document.getElementById('btn-pause') !== null,
        optionsButton: document.getElementById('btn-options') !== null,
        rows: ['row-threat', 'row-privacy', 'row-performance'].every((id) => document.getElementById(id) !== null),
      }));
      const ok = state.title === 'Protection Active' && state.pauseButton && state.optionsButton && state.rows && pageErrors.length === 0;
      checks.push({ name: 'popup-renders', ok, detail: pageErrors[0] ?? JSON.stringify(state) });
      await popup.close();
    }
  } catch (error) {
    checks.push({ name: 'harness', ok: false, detail: String(error).slice(0, 200) });
  } finally {
    await browser?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    rmSync(unpackDir, { recursive: true, force: true });
  }

  const passed = checks.filter((check) => check.ok).length;
  const verdict = { version: manifest.version, zip: path.relative(projectRoot, zipPath), passed, total: checks.length, checks };
  writeFileSync(path.join(artifactDir, 'PACKAGED_VERIFY.json'), JSON.stringify(verdict, null, 2));
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}  ${check.detail}`);
  console.log(passed === checks.length ? 'VERIFY-PACKAGED OK' : 'VERIFY-PACKAGED FAIL');
  if (passed !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
