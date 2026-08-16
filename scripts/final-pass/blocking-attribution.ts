import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import puppeteer, { Browser, WebWorker } from 'puppeteer';
import { Filter, FilterConverter } from '@adguard/dnr-converter';
import { chromeExecutable } from '../../tests/support/chrome-executable';

const root = process.cwd();
const artifactPath = path.join(root, 'artifacts', 'final-pass', 'BLOCKING_MISS_ATTRIBUTION.json');
const textDir = path.join(root, '.phase31', 'text');
const rulesDir = path.join(root, 'dist', 'phase31-rulesets');
const catalogPath = path.join(rulesDir, 'catalog.json');

type DnrRule = {
  id: number;
  priority?: number;
  action?: { type?: string };
  condition?: {
    urlFilter?: string;
    regexFilter?: string;
    resourceTypes?: string[];
    initiatorDomains?: string[];
    excludedInitiatorDomains?: string[];
  };
};

type Source = {
  id: number;
  title: string;
  file: string;
};

type Candidate = {
  sourceId: number;
  requestClass: string;
  line: string;
};

type AttributionEntry = {
  testId: string;
  requestClass: string;
  filterSourceMatch: {
    matched: boolean;
    sourceId: number | null;
    sourceTitle: string | null;
    lineHash: string | null;
  };
  compilerStatus: 'accepted' | 'rejected' | 'no-block-rule';
  rejectReason: string | null;
  generatedRuleRef: {
    rulesetId: string;
    ruleId: number;
  } | null;
  rulesetEnabled: boolean;
  runtimeRuleMatched: boolean;
  exceptionRef: string | null;
  finalRootCause: string | null;
  fixClass: string;
  diagnostic: {
    resourceType: string;
    matchOutcome: 'matched' | 'not-matched' | 'not-run';
  };
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function titleOf(text: string): string {
  return text.match(/^!\s*(?:Title|Name):\s*(.+)$/im)?.[1]?.trim() || `Filter ${text}`;
}

function sourceFiles(): Source[] {
  return fs.readdirSync(textDir)
    .filter((name) => /^filter_\d+\.txt$/.test(name))
    .map((name) => {
      const id = Number(name.match(/^filter_(\d+)\.txt$/)?.[1]);
      const file = path.join(textDir, name);
      return { id, file, title: titleOf(fs.readFileSync(file, 'utf8')) };
    });
}

function isBlockCandidate(line: string): boolean {
  const trimmed = line.trim();
  return Boolean(
    trimmed &&
      !trimmed.startsWith('!') &&
      !trimmed.startsWith('[') &&
      !trimmed.startsWith('@@') &&
      !trimmed.includes('##') &&
      !trimmed.includes('#@#') &&
      !trimmed.includes('#%#') &&
      !trimmed.includes('#?#') &&
      (trimmed.startsWith('||') || trimmed.startsWith('|http'))
  );
}

function candidateForSource(source: Source, requestClass: string): Candidate | null {
  const lines = fs.readFileSync(source.file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!isBlockCandidate(line)) continue;
    const optionIndex = line.indexOf('$');
    const pattern = optionIndex >= 0 ? line.slice(0, optionIndex) : line;
    if (pattern.length < 5 || pattern.length > 180 || pattern.includes('##')) continue;
    if (pattern.includes('/') && !pattern.startsWith('||')) continue;
    return { sourceId: source.id, requestClass, line };
  }
  return null;
}

function makeRequestUrl(urlFilter: string): string {
  if (urlFilter.startsWith('||')) {
    const body = urlFilter.slice(2).replace(/\|$/, '');
    const hostEnd = body.search(/[\^/|]/);
    const host = (hostEnd >= 0 ? body.slice(0, hostEnd) : body).replace(/\*/g, 'fixture');
    const suffix = hostEnd >= 0 ? body.slice(hostEnd).replace(/\^/g, '/').replace(/\*/g, 'fixture').replace(/\|/g, '') : '/asset.js';
    return `https://${host}${suffix || '/asset.js'}`;
  }
  const cleaned = urlFilter.replace(/^\|/, '').replace(/\|$/, '');
  if (cleaned.startsWith('http')) {
    return cleaned.replace(/\*/g, 'fixture').replace(/\^/g, '/');
  }
  return `https://fixture.invalid/${cleaned.replace(/\*/g, 'fixture').replace(/\^/g, '/')}`;
}

function chooseResourceType(rule: DnrRule): chrome.declarativeNetRequest.ResourceType {
  const allowed = rule.condition?.resourceTypes || [];
  return (allowed.find((type) => ['script', 'image', 'xmlhttprequest', 'sub_frame', 'ping'].includes(type)) || 'script') as chrome.declarativeNetRequest.ResourceType;
}

function loadPackagedRules(): Map<number, { rulesetId: string; rule: DnrRule }[]> {
  const index = new Map<number, { rulesetId: string; rule: DnrRule }[]>();
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
    rulesets: Array<{ id: string; family: string; sourceFilterId: number; shardIndex: number }>;
  };
  for (const entry of catalog.rulesets) {
    const suffix = entry.family === 'base'
      ? (entry.shardIndex === 0 ? 'core' : `extra_${entry.shardIndex}`)
      : `part_${entry.shardIndex + 1}`;
    const rulesPath = path.join(rulesDir, `filter_${entry.sourceFilterId}_${suffix}.json`);
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8')) as DnrRule[];
    for (const rule of rules) {
      const current = index.get(rule.id) || [];
      current.push({ rulesetId: entry.id, rule });
      index.set(rule.id, current);
    }
  }
  return index;
}

async function waitForWorker(browser: Browser): Promise<WebWorker> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const target = browser.targets().find((candidate) => candidate.type() === 'service_worker' && candidate.url().includes('background.js'));
    if (target) {
      const worker = await target.worker();
      if (worker) return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('extension service worker did not start');
}

async function main(): Promise<void> {
  const sources = sourceFiles();
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const familyClasses = new Map<number, string>([
    [2, 'ad-network-script'],
    [3, 'tracker-script'],
    [19, 'popup-request'],
    [21, 'annoyance-request'],
    [208, 'malware-request'],
  ]);
  const candidates = [...familyClasses.entries()]
    .map(([sourceId, requestClass]) => {
      const source = sourceById.get(sourceId);
      return source ? candidateForSource(source, requestClass) : null;
    })
    .filter((candidate): candidate is Candidate => candidate !== null);

  const converter = new FilterConverter();
  const packagedRules = loadPackagedRules();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromeExecutable(root),
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      `--disable-extensions-except=${path.join(root, 'dist')}`,
      `--load-extension=${path.join(root, 'dist')}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  try {
    const worker = await waitForWorker(browser);
    const expectedRulesets = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).rulesets.length + 1;
    const enabledRulesets = await (async () => {
      const deadline = Date.now() + 4000;
      let current: string[] = [];
      while (Date.now() < deadline) {
        current = await worker.evaluate(async () => chrome.declarativeNetRequest.getEnabledRulesets());
        if (current.length >= expectedRulesets) return current;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return current;
    })();
    const entries: AttributionEntry[] = [];

    for (const [index, candidate] of candidates.entries()) {
      const source = sourceById.get(candidate.sourceId);
      const testId = `controlled-${candidate.requestClass}-${index + 1}`;
      const lineHash = sha256(candidate.line);
      const result = await converter.convert([new Filter(candidate.sourceId, candidate.line)], {
        resourcesPath: '/web-accessible-resources',
        maxNumberOfRules: 1000,
        maxNumberOfRegexpRules: 1000,
      });
      const converted = result?.[0];
      const rawRules = converted?.ruleset?.getDeclarativeRules?.() || [];
      const blockRule = rawRules.find((rule) => rule.action?.type === 'block') as DnrRule | undefined;
      const rejectReason = converted?.errors?.length
        ? `converter-error:${converted.errors.length}`
        : converted?.limitations?.length
          ? `converter-limitation:${converted.limitations.length}`
          : null;

      if (!blockRule) {
        entries.push({
          testId,
          requestClass: candidate.requestClass,
          filterSourceMatch: { matched: Boolean(source), sourceId: source?.id ?? null, sourceTitle: source?.title ?? null, lineHash },
          compilerStatus: rawRules.length > 0 ? 'no-block-rule' : 'rejected',
          rejectReason: rejectReason || 'no-block-rule-generated',
          generatedRuleRef: null,
          rulesetEnabled: false,
          runtimeRuleMatched: false,
          exceptionRef: null,
          finalRootCause: 'maintained-rule-does-not-compile-to-network-block',
          fixClass: 'unsupported-or-non-network-filter-construct',
          diagnostic: { resourceType: 'not-applicable', matchOutcome: 'not-run' },
        });
        continue;
      }

      const packaged = packagedRules.get(blockRule.id)?.find((item) => item.rule.action?.type === 'block');
      const requestUrl = makeRequestUrl(blockRule.condition?.urlFilter || blockRule.condition?.regexFilter || candidate.line);
      const resourceType = chooseResourceType(blockRule);
      const initiator = blockRule.condition?.initiatorDomains?.[0]
        ? `https://${blockRule.condition.initiatorDomains[0]}`
        : 'https://publisher.invalid';
      const match = await worker.evaluate(async ({ url, initiator: requestInitiator, resourceType }) => {
        const outcome = await (chrome.declarativeNetRequest.testMatchOutcome({
          url,
          initiator: requestInitiator,
          type: resourceType,
          tabId: -1,
        }) as unknown as Promise<{ matchedRules?: Array<{ ruleId?: number }> }>);
        return {
          matchedRules: outcome.matchedRules || [],
          enabledRulesets: await chrome.declarativeNetRequest.getEnabledRulesets(),
        };
      }, { url: requestUrl, initiator, resourceType });
      const runtimeRuleMatched = match.matchedRules.some((item: { ruleId?: number }) => item.ruleId === blockRule.id);
      const rulesetEnabled = packaged ? enabledRulesets.includes(packaged.rulesetId) : false;
      let finalRootCause: string | null = null;
      let fixClass = 'controlled-maintained-rule-coverage';
      if (!packaged) {
        finalRootCause = 'compiled-rule-not-packaged';
        fixClass = 'packaging-or-capacity';
      } else if (!rulesetEnabled) {
        finalRootCause = 'compiled-ruleset-disabled-at-runtime';
        fixClass = 'ruleset-reconciliation';
      } else if (!runtimeRuleMatched) {
        finalRootCause = 'runtime-match-not-observed';
        fixClass = 'condition-or-precedence';
      }

      entries.push({
        testId,
        requestClass: candidate.requestClass,
        filterSourceMatch: { matched: true, sourceId: source?.id ?? null, sourceTitle: source?.title ?? null, lineHash },
        compilerStatus: 'accepted',
        rejectReason: null,
        generatedRuleRef: packaged ? { rulesetId: packaged.rulesetId, ruleId: blockRule.id } : null,
        rulesetEnabled,
        runtimeRuleMatched,
        exceptionRef: match.matchedRules.some((item: { ruleId?: number }) => item.ruleId !== blockRule.id) ? 'matched-rule-set-present' : null,
        finalRootCause,
        fixClass,
        diagnostic: { resourceType, matchOutcome: runtimeRuleMatched ? 'matched' : 'not-matched' },
      });
    }

    const matched = entries.filter((entry) => entry.runtimeRuleMatched).length;
    const misses = entries.filter((entry) => !entry.runtimeRuleMatched);
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceCommitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      mode: 'development-controlled-attribution',
      externalBenchmark: 'USER MANUAL RETEST REQUIRED',
      controlledRequests: entries.length,
      controlledMatches: matched,
      controlledMisses: misses.length,
      unexplainedEscapes: misses.filter((entry) => entry.finalRootCause === null).length,
      enabledRulesets,
      entries,
    };
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ controlledRequests: entries.length, controlledMatches: matched, controlledMisses: misses.length, enabledRulesets }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
