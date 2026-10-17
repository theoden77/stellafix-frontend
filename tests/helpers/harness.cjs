// Shared harness for the browser integration tests: serves this repo on a
// local port and launches Chromium. The API (https://api.stellafix.io) is
// always mocked per test with page.route; no real backend is called.
// Not a test file itself (the npm test glob only runs tests/*.test.cjs).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const API = 'https://api.stellafix.io';
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };

async function startHarness() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  return {
    baseUrl,
    browser,
    async close() {
      await browser.close();
      await new Promise(r => server.close(r));
    },
  };
}

// Per-test and per-hook limits, so a hung test fails by name and its file
// still ends. The longest normal test measured 26.1 s (six copies of the
// suite at once; 12.4 s in CI, 18.3 s alone); 60 s leaves more than 2x.
// Hooks start or close the browser and the local server (normally < 1 s).
const TEST_TIMEOUT_MS = 60_000;
const HOOK_TIMEOUT_MS = 30_000;

const json = (route, status, body) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

module.exports = { API, startHarness, json, TEST_TIMEOUT_MS, HOOK_TIMEOUT_MS };
