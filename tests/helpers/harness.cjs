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
  const launched = await launchBrowser();
  return {
    baseUrl,
    browser: launched.browser,
    async close() {
      await closeBrowser(launched);
      await closeServer(server);
    },
  };
}

// Real-time limit for closing a context, the browser or the local server.
const CLOSE_LIMIT_MS = 10_000;
// Resolves to true if `work` settles within `ms`, false otherwise.
function settlesWithin(work, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(work).then(() => true, () => true),
    new Promise(r => { timer = setTimeout(() => r(false), ms); }),
  ]).finally(() => clearTimeout(timer));
}
// The browser runs as a launched server so that its process can be killed if
// it does not close in time; a browser left running would keep the test file's
// process alive after its tests ended.
async function launchBrowser() {
  const browserServer = await chromium.launchServer();
  const browser = await chromium.connect(browserServer.wsEndpoint());
  return { browser, browserServer };
}
async function closeBrowser({ browser, browserServer }) {
  await settlesWithin(browser.close(), CLOSE_LIMIT_MS);
  if (!(await settlesWithin(browserServer.close(), CLOSE_LIMIT_MS))) await browserServer.kill();
}
async function closeServer(server) {
  server.closeAllConnections();
  await settlesWithin(new Promise(r => server.close(r)), CLOSE_LIMIT_MS);
}
// Closes every browser context still open, each within the limit. Run after
// each test so a test that timed out does not leave its context (and the call
// it was waiting on) open until the end of the file.
async function closeOpenContexts(browser) {
  for (const context of browser?.contexts() || []) await settlesWithin(context.close(), CLOSE_LIMIT_MS);
}

// Per-test and per-hook limits, so a hung test fails by name and its file
// still ends. The longest normal test measured 26.1 s (six copies of the
// suite at once; 12.4 s in CI, 18.3 s alone); 60 s leaves more than 2x.
// Hooks start or close the browser and the local server (normally < 1 s);
// the hook limit is above the bounded close below (3 x CLOSE_LIMIT_MS).
const TEST_TIMEOUT_MS = 60_000;
const HOOK_TIMEOUT_MS = 45_000;

const json = (route, status, body) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

module.exports = { API, startHarness, json, TEST_TIMEOUT_MS, HOOK_TIMEOUT_MS, CLOSE_LIMIT_MS, settlesWithin, launchBrowser, closeBrowser, closeServer, closeOpenContexts };
