// Browser integration test: /interpret/start sends `timezone` for the
// period categories, falls back to a location picker when the browser
// time zone is unavailable or rejected, and turns the two standard 422
// timezone errors (loc ["body","timezone"], type timezone_missing /
// timezone_invalid) into the picker instead of a raw error.
//
// Serves this repo locally and mocks https://api.stellafix.io with
// page.route, so no real backend is called. Run: npm test
// (needs Playwright's Chromium; PLAYWRIGHT_BROWSERS_PATH is honored).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const API = 'https://api.stellafix.io';
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };

let server, baseUrl, browser;

before(async () => {
  server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise(r => server.close(r));
});

const json = (route, status, body) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// Opens the page logged in with an active subscription (no category is
// locked) and the interpret area shown for a chart. `startResponses` is
// consumed in order by POST /interpret/start; the last one repeats.
// `startDelayMs` (default 0) delays every /interpret/start response - used
// by the "already sent, must not be discarded" test below.
async function openPage({ timezoneId, breakDetection = false, startResponses, timezoneLookup, startDelayMs = 0 }) {
  const context = await browser.newContext(timezoneId ? { timezoneId } : {});
  const page = await context.newPage();
  const calls = { start: [], timezone: [] };

  await page.addInitScript(({ breakDetection }) => {
    localStorage.setItem('stellafix_token', 'test-token');
    if (breakDetection) {
      const orig = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function () {
        const o = orig.call(this);
        return { ...o, timeZone: undefined };
      };
    }
  }, { breakDetection });

  await page.route(/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.paddle\.com)\//, r => r.abort());
  await page.route(`${API}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/credits/balance') {
      return json(route, 200, { has_active_subscription: true, subscription_status: 'active',
        subscription_ends_at: null, report_credits: 0, question_credits: 0, scheduled_cancellation_at: null });
    }
    if (url.pathname === '/api/v1/interpret/start') {
      calls.start.push(JSON.parse(route.request().postData()));
      if (startDelayMs) await new Promise(r => setTimeout(r, startDelayMs));
      const [status, body] = startResponses[Math.min(calls.start.length, startResponses.length) - 1];
      return json(route, status, body);
    }
    if (url.pathname === '/api/v1/timezone') {
      const lat = url.searchParams.get('lat'), lon = url.searchParams.get('lon');
      calls.timezone.push({ lat, lon });
      // timezoneLookup is either the fixed [status, body] tuple (existing
      // tests) or a function(callIndex) -> [status, body] | Promise<...> for
      // tests that need per-call delay/content (the race tests below), so a
      // delayed response can be told apart from a fast one.
      const resolved = typeof timezoneLookup === 'function'
        ? await timezoneLookup(calls.timezone.length)
        : timezoneLookup;
      const [status, body] = resolved;
      return json(route, status, body);
    }
    return json(route, 404, { detail: 'not mocked' });
  });

  await page.goto(baseUrl);
  await page.waitForFunction(() => typeof showInterpretArea === 'function');
  await page.evaluate(() => showInterpretArea('chart-1'));
  return { context, page, calls };
}

const OK_START = [200, { session_id: 's1', message: 'Rapor metni', language: 'tr' }];
const missing422 = [422, { detail: [{ type: 'timezone_missing', loc: ['body', 'timezone'],
  msg: "timezone is required for category 'monthly_review'", input: null }] }];
const invalid422 = [422, { detail: [{ type: 'timezone_invalid', loc: ['body', 'timezone'],
  msg: "'Mars/Olympus' is not a known IANA timezone", input: 'Mars/Olympus' }] }];

const clickCategory = (page, id) => page.click(`button.category-card[onclick="selectCategory('${id}')"]`);

async function pickBerlin(page) {
  await page.fill('#tzCountryInput', 'Almanya');
  await page.click('#tzCountryDropdown .city-option');
  await page.waitForSelector('#tzCityInput', { state: 'visible' });
  await page.fill('#tzCityInput', 'Berlin');
  await page.click('#tzCityDropdown .city-option');
}

test('detected browser time zone is sent in the /interpret/start body', async () => {
  const { context, page, calls } = await openPage({ timezoneId: 'Asia/Tokyo', startResponses: [OK_START] });
  try {
    await clickCategory(page, 'monthly_review');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni');
    assert.equal(calls.start.length, 1);
    assert.equal(calls.start[0].timezone, 'Asia/Tokyo');
    assert.equal(calls.start[0].category, 'monthly_review');

    // A category without periods sends no timezone.
    await page.evaluate(() => backToCategories());
    await clickCategory(page, 'personality');
    await page.waitForFunction(() => document.querySelectorAll('.chat-bubble.assistant').length === 1);
    assert.equal(calls.start.length, 2);
    assert.equal('timezone' in calls.start[1], false);
  } finally { await context.close(); }
});

test('detection fails -> location picker -> backend lookup -> request carries that time zone', async () => {
  const { context, page, calls } = await openPage({
    breakDetection: true, startResponses: [OK_START], timezoneLookup: [200, { timezone: 'Europe/Berlin' }],
  });
  try {
    await clickCategory(page, 'weekly_review');
    await page.waitForSelector('#tzPickerPanel');
    assert.equal(calls.start.length, 0, 'no request without a time zone');
    const text = await page.textContent('#tzPickerPanel .chat-bubble-text');
    assert.match(text, /bulunduğun yeri seç/);

    await pickBerlin(page);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni');
    assert.deepEqual(calls.timezone, [{ lat: '52.5244', lon: '13.4105' }]);
    assert.equal(calls.start.length, 1);
    assert.equal(calls.start[0].timezone, 'Europe/Berlin');
    assert.equal(await page.$('#tzPickerPanel'), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('stellafix_request_timezone')), 'Europe/Berlin');
  } finally { await context.close(); }
});

test('timezone lookup failure shows a friendly message and keeps the picker', async () => {
  const { context, page, calls } = await openPage({
    breakDetection: true, startResponses: [OK_START], timezoneLookup: [422, { detail: 'No timezone found for this location' }],
  });
  try {
    await clickCategory(page, 'yearly_review');
    await page.waitForSelector('#tzPickerPanel');
    await pickBerlin(page);
    await page.waitForSelector('#tzPickerError', { state: 'visible' });
    assert.match(await page.textContent('#tzPickerError'), /saati bulunamadı/);
    assert.equal(calls.start.length, 0);
    assert.doesNotMatch(await page.textContent('#chatMessages'), /No timezone found/);
  } finally { await context.close(); }
});

test('422 timezone_invalid -> reselect message, rejected zone is not sent again', async () => {
  const { context, page, calls } = await openPage({
    timezoneId: 'Asia/Tokyo', startResponses: [invalid422, OK_START], timezoneLookup: [200, { timezone: 'Europe/Berlin' }],
  });
  try {
    await clickCategory(page, 'yearly_review');
    await page.waitForSelector('#tzPickerPanel');
    assert.equal(calls.start[0].timezone, 'Asia/Tokyo');
    const chat = await page.textContent('#chatMessages');
    assert.match(chat, /yeniden seç/);
    assert.doesNotMatch(chat, /IANA|timezone_invalid|not a known/);

    await pickBerlin(page);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni');
    assert.equal(calls.start.length, 2);
    assert.equal(calls.start[1].timezone, 'Europe/Berlin');
  } finally { await context.close(); }
});

test('422 timezone_missing -> location picker, not a raw error', async () => {
  const { context, page, calls } = await openPage({ timezoneId: 'Asia/Tokyo', startResponses: [missing422] });
  try {
    await clickCategory(page, 'monthly_review');
    await page.waitForSelector('#tzPickerPanel');
    const chat = await page.textContent('#chatMessages');
    assert.match(chat, /bulunduğun yeri seç/);
    assert.doesNotMatch(chat, /required for category/);
    assert.equal(calls.start.length, 1);
  } finally { await context.close(); }
});

test('a 422 on another field keeps the generic invalid-input message', async () => {
  const other422 = [422, { detail: [{ type: 'period_type_not_allowed', loc: ['body', 'period_type'], msg: 'x' }] }];
  const { context, page } = await openPage({ timezoneId: 'Asia/Tokyo', startResponses: [other422] });
  try {
    await clickCategory(page, 'monthly_review');
    await page.waitForSelector('.chat-bubble.error');
    assert.match(await page.textContent('.chat-bubble.error'), /eksik veya geçersiz/);
    assert.equal(await page.$('#tzPickerPanel'), null);
  } finally { await context.close(); }
});

// ============================================================
// Race protection: pickTzCity()'s GET /api/v1/timezone response can arrive
// late, after the user has already picked a different city, changed
// category, or left the picker screen. Without the request-id/flow-id
// guards in index.html (pickTzCity, selectCategory, handleInterpretErrorResponse),
// a stale response can still fire its own /interpret/start -> a double
// report/credit charge, or one for the wrong category.
//
// City A = Berlin (lat 52.5244, lon 13.4105), City B = Munich (lat 48.1374,
// lon 11.5755), both in cities/DE.json served by the local test server (no
// hand-written timezone table involved). The /api/v1/timezone mock returns a
// distinguishable (fictitious, not geographically accurate - that's not what
// this is testing) zone per call index, with a controllable delay per call,
// so arrival order can be forced independently of click order.
// ============================================================
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function pickCity(page, name) {
  await page.fill('#tzCityInput', name);
  await page.click('#tzCityDropdown .city-option');
}

async function pickGermanyThenCity(page, name) {
  await page.fill('#tzCountryInput', 'Almanya');
  await page.click('#tzCountryDropdown .city-option');
  await page.waitForSelector('#tzCityInput', { state: 'visible' });
  await pickCity(page, name);
}

// callIndex 1 = Berlin (A, clicked first), callIndex 2 = Munich (B, clicked
// second). aDelayMs/bDelayMs let a test force either arrival order.
function raceLookup(aDelayMs, bDelayMs) {
  return async (callIndex) => {
    if (callIndex === 1) { await delay(aDelayMs); return [200, { timezone: 'Europe/Berlin' }]; }
    await delay(bDelayMs);
    return [200, { timezone: 'Europe/Vienna' }]; // stand-in for "Munich's zone" - just needs to differ from Berlin's for the assertion
  };
}

async function fastDoubleSelection(t, aDelayMs, bDelayMs) {
  const { context, page, calls } = await openPage({
    breakDetection: true, startResponses: [OK_START], timezoneLookup: raceLookup(aDelayMs, bDelayMs),
  });
  try {
    await clickCategory(page, 'monthly_review');
    await page.waitForSelector('#tzPickerPanel');
    await pickGermanyThenCity(page, 'Berlin'); // A - fetch fires, in flight
    await pickCity(page, 'Munich');            // B - fired before A's response arrives, nothing disables the input meanwhile
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni');
    await delay(Math.max(aDelayMs, bDelayMs) + 100); // let the slower (stale) response land too
    console.log(`[${t.name}] /interpret/start calls: ${calls.start.length}`, calls.start.map(b => b.timezone));
    assert.equal(calls.start.length, 1, 'exactly one /interpret/start, not one per city');
    assert.equal(calls.start[0].timezone, 'Europe/Vienna', "the LAST picked city (B/Munich)'s zone, not A's");
  } finally { await context.close(); }
}

// 300ms/600ms (not 30/150): both city clicks (country pick + two city picks,
// each a real Playwright round-trip) must complete before EITHER response
// resolves, or the "fast" response would win on its own before the second
// click even happens and the test would not exercise the race at all.
test('fast double city selection, A resolves before B -> only B starts a report', async (t) => {
  await fastDoubleSelection(t, 300, 600);
});

test('fast double city selection, reversed arrival: B resolves before A -> still only B', async (t) => {
  await fastDoubleSelection(t, 600, 300);
});

test('leaving the picker screen before the response arrives -> no /interpret/start', async (t) => {
  const { context, page, calls } = await openPage({
    breakDetection: true, startResponses: [OK_START], timezoneLookup: raceLookup(150, 0),
  });
  try {
    await clickCategory(page, 'monthly_review');
    await page.waitForSelector('#tzPickerPanel');
    await pickGermanyThenCity(page, 'Berlin'); // A - fetch fires, in flight (150ms)
    await page.evaluate(() => backToCategories()); // user leaves before the response arrives
    await page.waitForSelector('#categoryPanel', { state: 'visible' });
    await delay(250); // let A's delayed response land
    console.log(`[${t.name}] /interpret/start calls: ${calls.start.length}`);
    assert.equal(calls.start.length, 0, 'the stale response must not start a report after the user left');
  } finally { await context.close(); }
});

test('switching category before the response arrives -> old category gets no /interpret/start', async (t) => {
  const { context, page, calls } = await openPage({
    breakDetection: true, startResponses: [OK_START], timezoneLookup: raceLookup(150, 0),
  });
  try {
    await clickCategory(page, 'monthly_review');
    await page.waitForSelector('#tzPickerPanel');
    await pickGermanyThenCity(page, 'Berlin'); // A - fetch fires, in flight (150ms)
    await page.evaluate(() => backToCategories()); // switching category goes through the category panel
    await page.waitForSelector('#categoryPanel', { state: 'visible' });
    await clickCategory(page, 'personality'); // a different, non-period category
    await page.waitForSelector('.chat-bubble.assistant');
    await delay(250); // let the stale Berlin/monthly_review response land
    console.log(`[${t.name}] /interpret/start calls: ${JSON.stringify(calls.start.map(b => b.category))}`);
    assert.equal(calls.start.length, 1, 'only the new category\'s own request, nothing from the abandoned one');
    assert.equal(calls.start[0].category, 'personality');
    assert.ok(!calls.start.some(b => b.category === 'monthly_review'), 'the old category must not have started a report');
  } finally { await context.close(); }
});

test('normal single city selection still starts exactly one report with the picked time zone', async (t) => {
  const { context, page, calls } = await openPage({
    breakDetection: true, startResponses: [OK_START], timezoneLookup: raceLookup(20, 20),
  });
  try {
    await clickCategory(page, 'monthly_review');
    await page.waitForSelector('#tzPickerPanel');
    await pickGermanyThenCity(page, 'Berlin');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni');
    console.log(`[${t.name}] /interpret/start calls: ${calls.start.length}`);
    assert.equal(calls.start.length, 1);
    assert.equal(calls.start[0].timezone, 'Europe/Berlin');
  } finally { await context.close(); }
});

async function waitForCount(getCount, expected, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (getCount() < expected) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for count >= ${expected}, got ${getCount()}`);
    await delay(10);
  }
}

// Once /interpret/start has actually been sent (network level), a credit is
// already spent on the backend - leaving the picker screen before the
// (delayed) response comes back must NOT discard it. Dropping it here would
// mean the user paid for a report and never got it. This must hold even
// though the request was fired from the tz-picker retry path (the same
// tzRetry token used by the race guards above) - its success path has no
// staleness check, unlike the pre-fetch check and the error path's check,
// which are unaffected.
test('leaving the picker screen AFTER /interpret/start was sent -> the response is still used, not discarded', async (t) => {
  const { context, page, calls } = await openPage({
    breakDetection: true, startResponses: [OK_START], timezoneLookup: [200, { timezone: 'Europe/Berlin' }],
    startDelayMs: 300,
  });
  try {
    await clickCategory(page, 'monthly_review');
    await page.waitForSelector('#tzPickerPanel');
    await pickGermanyThenCity(page, 'Berlin'); // fast /api/v1/timezone, then selectCategory retry fires /interpret/start (delayed 300ms)
    await waitForCount(() => calls.start.length, 1); // wait until the request was actually dispatched
    assert.equal(calls.start.length, 1, 'the request must have been sent before we leave');
    await page.evaluate(() => backToCategories()); // leave BEFORE the delayed response arrives
    await page.waitForSelector('#categoryPanel', { state: 'visible' });
    await delay(300 + 200); // let the delayed response land
    console.log(`[${t.name}] /interpret/start calls after leaving: ${calls.start.length}`);
    assert.equal(calls.start.length, 1, 'no retry/duplicate - still exactly the one request that was already sent');
    const sessionId = await page.evaluate(() => interpretSessionId);
    console.log(`[${t.name}] interpretSessionId after the late response: ${sessionId}`);
    assert.equal(sessionId, 's1', 'the already-sent response must still be processed (handleStartResponse ran), not dropped');
  } finally { await context.close(); }
});
