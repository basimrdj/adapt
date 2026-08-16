import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const root = process.cwd();
const extensionPath = path.join(root, 'dist');
const artifactDir = path.join(root, 'artifacts', 'final-pass');

interface TrialServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

function html(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font:16px system-ui;margin:24px}main{max-width:760px;margin:auto}.warning{position:fixed;left:16px;right:16px;bottom:16px;padding:12px;background:#fee2e2;color:#7f1d1d;border:1px solid #ef4444;border-radius:8px}
  </style></head><body>${body}</body></html>`;
}

async function startServer(): Promise<TrialServer> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/popup') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html(`<main><h1>Popup fixture</h1><button id="hostile">Continue</button><a id="legit" target="_blank" href="/legit">Open help</a><button id="oauth">Sign in</button><script>
        window.popupAttempts = 0;
        document.querySelector('#hostile').addEventListener('click', () => {
          window.popupAttempts += 1; window.open('/ad?first=1'); window.open('/ad?second=1');
        });
        document.querySelector('#oauth').addEventListener('click', () => {
          window.popupAttempts += 1; window.open('/oauth/authorize');
        });
      </script></main>`));
      return;
    }
    if (url.pathname === '/semantic') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html(`<main><h1>Readable article</h1><p id="content">The intended content remains available.</p></main><div id="warning" class="warning" role="alert" aria-live="assertive">Please disable your ad blocker to continue.</div><script>
        let reinserts = 0;
        const watch = setInterval(() => {
          const warning = document.querySelector('#warning');
          if (warning && getComputedStyle(warning).display === 'none' && reinserts < 1) {
            reinserts += 1;
            const replacement = warning.cloneNode(true);
            replacement.id = 'warning-reinserted';
            warning.replaceWith(replacement);
          }
          if (reinserts >= 1) clearInterval(watch);
        }, 180);
      </script>`));
      return;
    }
    if (url.pathname === '/semantic-control') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html(`<main><article><h1>Ad blocker explainer</h1><p>This article explains how ad blockers work and why publishers discuss them.</p></article><section id="faq"><p>FAQ: ad blockers are common browser tools.</p></section><section id="settings"><p>DNS blocking settings are available here.</p></section></main><footer>Ad blocker policy and legal information.</footer><div role="status" id="toast">Settings saved</div>`));
      return;
    }
    if (url.pathname === '/ad') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html('<main><h1>Unexpected target</h1></main>'));
      return;
    }
    if (url.pathname === '/legit') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html('<main><h1>Expected help page</h1></main>'));
      return;
    }
    if (url.pathname === '/oauth/authorize') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html('<main><h1>OAuth sign-in</h1></main>'));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not expose a port');
  return {
    server,
    port: address.port,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function launch(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    executablePath: chromeExecutable(root),
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });
}

async function waitForPage(browser: Browser, predicate: (page: Page) => boolean, timeoutMs = 800): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await browser.pages()).some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runPopupTrials(port: number): Promise<Record<string, unknown>> {
  let attempts = 0;
  let preventedBeforeTargetCreation = 0;
  let unexpectedTargetsCreated = 0;
  let fallbackClosures = 0;
  let legitimateTargetsAllowed = 0;
  let protectedFlowsPreserved = 0;

  for (let trial = 0; trial < 20; trial += 1) {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/popup`, { waitUntil: 'domcontentloaded' });
      await page.click('#hostile');
      await new Promise((resolve) => setTimeout(resolve, 220));
      await page.click('#hostile');
      await new Promise((resolve) => setTimeout(resolve, 220));
      const hostileAttempts = await page.evaluate(() => Number((window as unknown as { popupAttempts?: number }).popupAttempts || 0));
      attempts += hostileAttempts;
      const hostileTargets = (await browser.pages()).filter((candidate) => candidate.url().includes('/ad'));
      unexpectedTargetsCreated += hostileTargets.length;
      if (hostileAttempts === 2 && hostileTargets.length === 0) preventedBeforeTargetCreation += 2;

      await page.click('#legit');
      await waitForPage(browser, (candidate) => candidate.url().includes('/legit'));
      if ((await browser.pages()).some((candidate) => candidate.url().includes('/legit'))) legitimateTargetsAllowed += 1;

      await page.bringToFront();
      await page.click('#oauth');
      await waitForPage(browser, (candidate) => candidate.url().includes('/oauth/authorize'));
      if ((await browser.pages()).some((candidate) => candidate.url().includes('/oauth/authorize'))) protectedFlowsPreserved += 1;
    } finally {
      fallbackClosures += (await browser.pages()).filter((candidate) => candidate.url().includes('/ad')).length;
      await browser.close();
    }
  }

  return {
    attempts,
    preventedBeforeTargetCreation,
    unexpectedTargetsCreated,
    fallbackClosures,
    legitimateTargetsAllowed,
    protectedFlowsPreserved,
    firstEncounterTrials: 20,
    zeroUnwantedTargetCreation: unexpectedTargetsCreated === 0 && fallbackClosures === 0,
  };
}

async function runSemanticProbe(port: number): Promise<Record<string, unknown>> {
  const browser = await launch();
  const started = Date.now();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/semantic`, { waitUntil: 'domcontentloaded' });
    let resolved = false;
    let reinsertResolved = false;
    let elapsedMs = 0;
    while (Date.now() - started < 4200) {
      const state = await page.evaluate(() => {
        const warning = document.querySelector('#warning, #warning-reinserted');
        const content = document.querySelector('#content');
        return {
          warningVisible: warning instanceof HTMLElement && getComputedStyle(warning).display !== 'none',
          contentPresent: content instanceof HTMLElement,
          reinsertPresent: Boolean(document.querySelector('#warning-reinserted')),
        };
      });
      if (!state.warningVisible && state.contentPresent && !state.reinsertPresent) {
        resolved = true;
        elapsedMs = Date.now() - started;
      }
      if (resolved && state.reinsertPresent && !state.warningVisible) {
        reinsertResolved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { resolved, reinsertResolved, elapsedMs, falsePositive: !resolved ? false : !(await page.$('#content')) };
  } finally {
    await browser.close();
  }
}

async function runSemanticControls(port: number): Promise<Record<string, unknown>> {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/semantic-control`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const state = await page.evaluate(() => ({
      article: getComputedStyle(document.querySelector('article')!).display,
      faq: getComputedStyle(document.querySelector('#faq')!).display,
      settings: getComputedStyle(document.querySelector('#settings')!).display,
      footer: getComputedStyle(document.querySelector('footer')!).display,
      toast: getComputedStyle(document.querySelector('#toast')!).display,
    }));
    return { preserved: Object.values(state).every((value) => value !== 'none'), state };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(artifactDir, { recursive: true });
  const fixture = await startServer();
  try {
    const popup = await runPopupTrials(fixture.port);
    const semantic = await runSemanticProbe(fixture.port);
    const semanticControls = await runSemanticControls(fixture.port);
    fs.writeFileSync(path.join(artifactDir, 'FIRST_POPUP_PREVENTION.json'), `${JSON.stringify(popup, null, 2)}\n`);
    fs.writeFileSync(path.join(artifactDir, 'SEMANTIC_REACTION_PROBE.json'), `${JSON.stringify(semantic, null, 2)}\n`);
    fs.writeFileSync(path.join(artifactDir, 'SEMANTIC_NEGATIVE_CONTROLS.json'), `${JSON.stringify(semanticControls, null, 2)}\n`);
    console.log(JSON.stringify({ popup, semantic, semanticControls }, null, 2));
  } finally {
    await fixture.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
