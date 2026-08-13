import { build } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, mkdirSync, rmSync } from 'fs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFilterLists, renderGenericCosmeticCss } from '../src/page/filtering/compiler';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const sourcemap = process.argv.includes('--sourcemap');

function generatedGenericCss(): string {
  const textDir = resolve(__dirname, '../.phase31/text');
  if (!existsSync(textDir)) return '';
  const names = readdirSync(textDir).filter((name) => /^filter_\d+\.txt$/.test(name));
  if (names.length === 0) return '';
  const sources = names.map((name) => ({ id: Number(name.match(/\d+/)?.[0] || 0), text: readFileSync(join(textDir, name), 'utf8') }));
  return renderGenericCosmeticCss(parseFilterLists(sources));
}

async function buildExtension() {
  const distDir = resolve(__dirname, '../dist');
  const genericCss = generatedGenericCss();
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  mkdirSync(resolve(distDir, 'rules'), { recursive: true });
  mkdirSync(resolve(distDir, 'popup'), { recursive: true });

  // 1. Build Background Service Worker (Self-contained, no external chunk imports)
  await build({
    configFile: false,
    define: { __ADAPT_GENERIC_CSS__: JSON.stringify(genericCss) },
    build: {
      outDir: distDir,
      emptyOutDir: false,
      lib: {
        entry: resolve(__dirname, '../src/entrypoints/background.ts'),
        name: 'background',
        formats: ['es'],
        fileName: () => 'background.js',
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  });

  // 2. Build Content Script (Self-contained IIFE, no external chunk imports)
  await build({
    configFile: false,
    define: { __ADAPT_GENERIC_CSS__: JSON.stringify(genericCss) },
    build: {
      outDir: distDir,
      emptyOutDir: false,
      sourcemap,
      minify: sourcemap ? false : 'esbuild',
      lib: {
        entry: resolve(__dirname, '../src/entrypoints/content.ts'),
        name: 'content',
        formats: ['iife'],
        fileName: () => 'content.js',
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  });

  // 3. Build Popup HTML / CSS / TS
  await build({
    configFile: false,
    root: resolve(__dirname, '../src/entrypoints/popup'),
    base: '',
    build: {
      outDir: resolve(distDir, 'popup'),
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(__dirname, '../src/entrypoints/popup/index.html'),
      },
    },
  });

  // 4. Copy manifest.json & static rules
  copyFileSync(
    resolve(__dirname, '../src/manifest.json'),
    resolve(distDir, 'manifest.json')
  );

  copyFileSync(
    resolve(__dirname, '../src/rules/static/baseline.json'),
    resolve(distDir, 'rules/baseline.json')
  );

  console.log('ADAPT extension successfully built to dist/');
}

buildExtension().catch((err) => {
  console.error(err);
  process.exit(1);
});
