import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Phase 3.1B indexed page plane', () => {
  const root = path.resolve(__dirname, '../..');
  const reportPath = path.join(root, 'artifacts/phase31b/page-filter-benchmark.json');

  it('keeps the startup index compact and the relevant frame load bounded', () => {
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { baselineIndexBytes: number; afterIndexBytes: number; perFrameBytes: number; noFullBundleParsePerFrame: boolean; domainShardCount: number };
    expect(report.afterIndexBytes).toBeLessThan(4096);
    expect(report.afterIndexBytes).toBeLessThan(report.baselineIndexBytes / 1000);
    expect(report.perFrameBytes).toBeLessThan(14_000_000);
    expect(report.noFullBundleParsePerFrame).toBe(true);
    expect(report.domainShardCount).toBeGreaterThan(1);
  });
});
