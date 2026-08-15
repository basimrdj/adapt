import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verificationMetadata } from './verification-metadata';

const root = resolve(process.cwd());
const pageDir = join(root, 'dist', 'page-filtering');
const artifactDir = join(root, 'artifacts', 'phase31b');
const metadata = verificationMetadata(root);

function bytes(file: string): number {
  return statSync(file).size;
}

function timedParse(file: string): { bytes: number; parseMs: number } {
  const text = readFileSync(file, 'utf8');
  const startedAt = process.hrtime.bigint();
  JSON.parse(text);
  const parseMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  return { bytes: text.length, parseMs };
}

function domainCandidates(hostname: string): string[] {
  const labels = hostname.split('.').filter(Boolean);
  return labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'));
}

const indexPath = join(pageDir, 'index.json');
const genericPath = join(pageDir, 'generic.json');
const domainIndexPath = join(pageDir, 'domain-index.json');
const domainIndex = JSON.parse(readFileSync(domainIndexPath, 'utf8')) as Record<string, string>;
const hostname = 'www.youtube.com';
const candidates = domainCandidates(hostname);
const shardFiles = [...new Set(candidates.map((candidate) => domainIndex[candidate]).filter((file): file is string => Boolean(file)))];
const parsedFiles = [indexPath, genericPath, domainIndexPath, ...shardFiles.map((file) => join(pageDir, file))];
const parsed = parsedFiles.map((file) => timedParse(file));
const perFrameBytes = parsed.reduce((total, entry) => total + entry.bytes, 0);
const allPageFiles = readdirSync(pageDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));
const afterBundleBytes = allPageFiles.reduce((total, file) => total + bytes(file), 0);
const indexedRules = parsedFiles.slice(3).reduce((total, file) => {
  const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  return total + Object.values(value).reduce<number>((count, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return count;
    const record = entry as { domainRules?: unknown[]; scriptlets?: unknown[] };
    return count + (record.domainRules?.length || 0) + (record.scriptlets?.length || 0);
  }, 0);
}, 0);
const mutationStartedAt = process.hrtime.bigint();
let mutationChecks = 0;
for (let iteration = 0; iteration < 1000; iteration++) {
  for (const candidate of candidates) {
    if (domainIndex[candidate]) mutationChecks += 1;
  }
}
const mutationMs = Number(process.hrtime.bigint() - mutationStartedAt) / 1_000_000;

const report = {
  schema: 'adapt-phase31b-page-filter-benchmark-v1',
  ...metadata,
  hostname,
  candidates,
  shardFiles,
  baselineIndexBytes: 15022819,
  afterIndexBytes: bytes(indexPath),
  afterBundleBytes,
  perFrameBytes,
  perFrameParseMs: parsed.reduce((total, entry) => total + entry.parseMs, 0),
  genericBytes: bytes(genericPath),
  relevantDomainShardBytes: parsed.slice(3).reduce((total, entry) => total + entry.bytes, 0),
  indexedRules,
  mutationChecks,
  mutationBenchmarkMs: mutationMs,
  domainShardCount: readdirSync(join(pageDir, 'domains')).length,
  earlyShardCount: readdirSync(join(pageDir, 'early')).length,
  noFullBundleParsePerFrame: perFrameBytes < 14_000_000,
};

mkdirSync(artifactDir, { recursive: true });
writeFileSync(join(artifactDir, 'page-filter-benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`PAGE FILTER BENCHMARK: ${JSON.stringify(report)}`);
