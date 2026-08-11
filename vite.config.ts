import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, rmSync } from 'fs';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/entrypoints/background.ts'),
        content: resolve(__dirname, 'src/entrypoints/content.ts'),
        popup: resolve(__dirname, 'src/entrypoints/popup/index.html')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') return 'background.js';
          if (chunkInfo.name === 'content') return 'content.js';
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      }
    }
  },
  plugins: [
    {
      name: 'copy-manifest-and-rules',
      closeBundle() {
        mkdirSync(resolve(__dirname, 'dist/rules'), { recursive: true });
        mkdirSync(resolve(__dirname, 'dist/popup'), { recursive: true });

        // Copy manifest.json
        if (existsSync(resolve(__dirname, 'src/manifest.json'))) {
          copyFileSync(
            resolve(__dirname, 'src/manifest.json'),
            resolve(__dirname, 'dist/manifest.json')
          );
        }

        // Copy baseline static rules
        if (existsSync(resolve(__dirname, 'src/rules/static/baseline.json'))) {
          copyFileSync(
            resolve(__dirname, 'src/rules/static/baseline.json'),
            resolve(__dirname, 'dist/rules/baseline.json')
          );
        }

        // Fix popup path if generated under dist/src/entrypoints/popup/
        const srcPopupHtml = resolve(__dirname, 'dist/src/entrypoints/popup/index.html');
        const targetPopupHtml = resolve(__dirname, 'dist/popup/index.html');
        if (existsSync(srcPopupHtml)) {
          copyFileSync(srcPopupHtml, targetPopupHtml);
          rmSync(resolve(__dirname, 'dist/src'), { recursive: true, force: true });
        }
      }
    }
  ]
});
