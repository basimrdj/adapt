import http from 'http';
import fs from 'fs';
import path from 'path';

export interface TestServerInstances {
  appServer: http.Server;
  adServer: http.Server;
  appPort: number;
  adPort: number;
  close: () => Promise<void>;
}

export function startTestServers(appPort = 4000, adPort = 4001): Promise<TestServerInstances> {
  return new Promise((resolve) => {
    // 1. App Server (First-Party)
    const appServer = http.createServer((req, res) => {
      // Enable CORS & headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');

      const urlPath = req.url?.split('?')[0] || '/';

      // Support dynamic service worker script
      if (urlPath === '/sw-test.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' });
        res.end(`
          self.addEventListener('install', (e) => {
            self.skipWaiting();
          });
          self.addEventListener('activate', (e) => {
            e.waitUntil(clients.claim());
          });
          self.addEventListener('fetch', (e) => {
            // Echo or cache
            if (e.request.url.includes('/cached-asset')) {
              e.respondWith(new Response('Cached in Service Worker', { headers: { 'Content-Type': 'text/plain' } }));
            }
          });
        `);
        return;
      }

      let filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const contentType =
          ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'text/plain';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      }
    });

    // 2. Ad Server (Third-Party)
    const adServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const urlPath = req.url || '';

      if (urlPath.includes('synthetic-ad.js')) {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end('window.__ad_loaded = true; console.log("Synthetic ad script executed!");');
      } else if (urlPath.includes('ad-probe.js')) {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end('window.__probe_loaded = true;');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Ad Server Ok');
      }
    });

    appServer.listen(appPort, () => {
      adServer.listen(adPort, () => {
        resolve({
          appServer,
          adServer,
          appPort,
          adPort,
          close: async () => {
            await new Promise<void>((r) => appServer.close(() => r()));
            await new Promise<void>((r) => adServer.close(() => r()));
          },
        });
      });
    });
  });
}
