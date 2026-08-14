import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const packagedRelativePaths = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-win64/chrome.exe',
  'chrome-win/chrome.exe',
];

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function packagedChrome(projectRoot: string): string | undefined {
  const chromeDir = path.join(projectRoot, 'chrome');
  if (!fs.existsSync(chromeDir)) return undefined;

  const entries = fs.readdirSync(chromeDir, { withFileTypes: true });
  return firstExisting(
    entries
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => packagedRelativePaths.map((relativePath) => path.join(chromeDir, entry.name, relativePath)))
  );
}

function puppeteerChrome(): string | undefined {
  try {
    const candidate = puppeteer.executablePath();
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function pathChrome(): string | undefined {
  const commands = process.platform === 'darwin'
    ? ['google-chrome', 'chromium', 'chromium-browser']
    : process.platform === 'win32'
      ? ['chrome.exe', 'chromium.exe']
      : ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return firstExisting(pathEntries.flatMap((directory) => commands.map((command) => path.join(directory, command))));
}

export function chromeExecutable(projectRoot = process.cwd()): string {
  const envPath = process.env.CHROME_PATH;
  const systemCandidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];

  const candidate = firstExisting([
    ...(envPath ? [envPath] : []),
    puppeteerChrome(),
    packagedChrome(projectRoot),
    ...systemCandidates,
    pathChrome(),
  ].filter((value): value is string => Boolean(value)));

  if (candidate) return candidate;
  throw new Error('No Chromium executable found; set CHROME_PATH or install Puppeteer Chrome');
}
