import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

describe('Production Bundle Cleanliness & Security Invariant', () => {
  const distDir = path.resolve(__dirname, '../../dist');
  const bgPath = path.join(distDir, 'background.js');
  const contentPath = path.join(distDir, 'content.js');
  const manifestPath = path.join(distDir, 'manifest.json');

  it('Proves no provider credential or endpoint is committed to TRACKED sources, and the baked dev config stays gitignored', () => {
    // The private development build intentionally bakes the AI default config into
    // dist/ (user-authorized; dist is gitignored). The security invariant that must
    // hold forever: no credential material in TRACKED files, and the generated
    // credential file must remain ignored.
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const tracked = execSync('git ls-files', { encoding: 'utf8' }) as string;
    // Credential-shaped literals must never appear in tracked files. Endpoint host
    // references (e.g. in the lab relay script) are not credentials.
    const credentialPatterns = [
      /AZURE_OPENAI_API_KEY\s*[:=]\s*['"][^'"]{20,}['"]/,
      /Bearer\s+[A-Za-z0-9_\-]{20,}/,
      /apiKey\s*:\s*['"][^'"]{20,}['"]/,
    ];
    for (const file of tracked.split('\n').filter(Boolean)) {
      if (file.startsWith('node_modules/') || file.startsWith('.') || file === 'tests/unit/production-bundle-clean.test.ts') continue;
      if (!/\.(ts|js|json|md|html)$/.test(file)) continue;
      const abs = path.resolve(__dirname, '../../', file);
      // Tracked-but-absent files are possible mid-verification (the phase31b gate
      // deletes evidence artifacts before regenerating them) — nothing to scan.
      if (!fs.existsSync(abs)) continue;
      const content = fs.readFileSync(abs, 'utf8');
      for (const pattern of credentialPatterns) {
        expect(pattern.test(content), `tracked file ${file} embeds a credential-shaped literal`).toBe(false);
      }
    }
    const ignored = execSync('git check-ignore src/background/ai/dev-defaults.ts || true', { encoding: 'utf8' }).trim();
    expect(ignored).toBe('src/background/ai/dev-defaults.ts');

    // dist must exist and must never embed the OpenAI SDK or test-server origins.
    expect(fs.existsSync(bgPath)).toBe(true);
    expect(fs.existsSync(contentPath)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);
    const bgContent = fs.readFileSync(bgPath, 'utf8');
    const contentScriptContent = fs.readFileSync(contentPath, 'utf8');
    for (const forbidden of ['OpenAIClient', 'localhost:4040', 'localhost:4066']) {
      expect(bgContent).not.toContain(forbidden);
      expect(contentScriptContent).not.toContain(forbidden);
    }
  });

  it('rejects page-visible extension fingerprints and branded page-world errors', () => {
    const pageVisibleArtifacts = [
      contentPath,
      ...filesUnder(path.join(distDir, 'page-filtering', 'early')).filter((file) => file.endsWith('.js')),
    ];
    expect(pageVisibleArtifacts.length).toBeGreaterThan(0);
    const forbidden = [
      /__adapt/i,
      /adapt(?:early|main|blocked|url|method)/i,
      /ADAPT\s+blocked\s+fetch/i,
      /ADAPT\s+scriptlet\s+abort/i,
      /ADAPT\s+rejected\s+promise/i,
      /data-adapt-(?:blocker|hidden)/i,
    ];
    for (const file of pageVisibleArtifacts) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of forbidden) expect(content).not.toMatch(pattern);
    }
  });
});
