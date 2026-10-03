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
async function openPage({ timezoneId, breakDetection = false, startResponses, timezoneLookup }) {
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
      const [status, body] = startResponses[Math.min(calls.start.length, startResponses.length) - 1];
      return json(route, status, body);
    }
    if (url.pathname === '/api/v1/timezone') {
      calls.timezone.push({ lat: url.searchParams.get('lat'), lon: url.searchParams.get('lon') });
      const [status, body] = timezoneLookup;
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
