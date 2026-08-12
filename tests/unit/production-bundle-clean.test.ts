import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

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
});
