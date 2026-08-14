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

  it('Proves production bundle contains ZERO Azure endpoints, deployment names, or OpenAI SDK code', () => {
    expect(fs.existsSync(bgPath)).toBe(true);
    expect(fs.existsSync(contentPath)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);

    const bgContent = fs.readFileSync(bgPath, 'utf8');
    const contentScriptContent = fs.readFileSync(contentPath, 'utf8');
    const manifestContent = fs.readFileSync(manifestPath, 'utf8');

    const forbiddenStrings = [
      'azure.com',
      'openai.azure.com',
      'buzz-gpt-5-4-mini',
      'basim-agent3',
      'AZURE_OPENAI_API_KEY',
      'OpenAIClient',
      'http://127.0.0.1',
      '127.0.0.1',
      'localhost:4040',
      'localhost:4066',
    ];

    for (const forbidden of forbiddenStrings) {
      expect(bgContent).not.toContain(forbidden);
      expect(contentScriptContent).not.toContain(forbidden);
      expect(manifestContent).not.toContain(forbidden);
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
