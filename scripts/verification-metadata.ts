import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface VerificationMetadata {
  verificationRunId: string;
  sourceCommitSha: string;
  generatedAt: string;
  buildFingerprint: string;
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

export function buildFingerprint(projectRoot = resolve(process.cwd())): string {
  const inputs = [
    join(projectRoot, 'package-lock.json'),
    join(projectRoot, 'dist', 'manifest.json'),
    ...filesUnder(join(projectRoot, '.phase31')).sort(),
  ].filter(existsSync);
  const hash = createHash('sha256');
  for (const file of inputs) {
    hash.update(relative(projectRoot, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function verificationMetadata(projectRoot = resolve(process.cwd())): VerificationMetadata {
  const sourceCommitSha = process.env.ADAPT_SOURCE_COMMIT_SHA
    ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  const generatedAt = process.env.ADAPT_VERIFICATION_GENERATED_AT ?? new Date().toISOString();
  const verificationRunId = process.env.ADAPT_VERIFICATION_RUN_ID
    ?? `phase31b-${Date.now()}-${sourceCommitSha.slice(0, 12)}`;
  const fingerprint = process.env.ADAPT_VERIFICATION_BUILD_FINGERPRINT ?? buildFingerprint(projectRoot);
  return {
    verificationRunId,
    sourceCommitSha,
    generatedAt,
    buildFingerprint: fingerprint,
  };
}
