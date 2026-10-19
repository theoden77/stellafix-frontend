// Browser integration test for "My reports" (Raporlarım): the saved-report
// list (GET /interpret/history), opening a report (GET /interpret/{id} +
// /balance), read-only cases, follow-up errors, account changes and late
// responses. The API is mocked with page.route; no real backend is called.
// Run: npm test
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { API, startHarness, json, TEST_TIMEOUT_MS, HOOK_TIMEOUT_MS, closeOpenContexts } = require('./helpers/harness.cjs');

let h;
before(async () => { h = await startHarness(); }, { timeout: HOOK_TIMEOUT_MS });
afterEach(async () => { await closeOpenContexts(h?.browser); }, { timeout: HOOK_TIMEOUT_MS });
after(async () => { await h?.close(); }, { timeout: HOOK_TIMEOUT_MS });

// Unsigned fake JWT; the page only decodes the payload for display/account id.
const b64url = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fakeJwt = sub => `h.${b64url(JSON.stringify({ sub, email: `${sub}@example.test`, subscription_tier: 'free', exp: 9999999999 }))}.s`;
const U1 = fakeJwt('u1'), U2 = fakeJwt('u2');

const delay = ms => new Promise(r => setTimeout(r, ms));
function gate() { let open; const p = new Promise(r => { open = r; }); return { wait: () => p, open }; }

function sess(id, overrides = {}) {
  return {
    session_id: id, chart_id: 'chart-1', chart_name: 'Ayşe', category: 'personality', language: 'tr',
    relationship_type: null, status: 'completed', created_at: '2026-10-10T09:30:00+00:00',
    period_type: null, period_start_utc: null, period_end_utc: null, timezone: null,
    model: 'm', prompt_style: 'classic', system_prompt_version: 'a', data_prompt_version: 'b', data_version: 3,
    is_live: true, superseded: false, ...overrides,
  };
}
function detail(s, messages) {
  return { ...s, messages: messages || [{ role: 'assistant', content: `Rapor metni ${s.session_id}`, created_at: s.created_at }] };
}
const bal = (free, credits = 0) => ({ questions_included: 1, questions_used: 1 - Math.min(free, 1), questions_remaining_free: free, question_credits_remaining: credits, unlimited: false });

// Every responder may return a body (200), a [status, body] tuple, or a Promise of either.
async function reply(route, r) {
  r = await r;
  if (Array.isArray(r) && typeof r[0] === 'number') return json(route, r[0], r[1]);
  return json(route, 200, r);
}

// A category click first asks POST /interpret/quote; tests that click a
// category pass `quote` (QUOTE_SUB: generate with the subscription, no
// confirmation step).
const QUOTE_SUB = () => ({ found_existing: false, would_spend: 'subscription', existing: null });
async function openPage({ token = U1, history = () => [], detail: detailFn = () => [404, { detail: 'not found' }],
  balance = () => bal(1), start = () => [500, {}], cont = () => [200, { message: 'Cevap', ...bal(0) }],
  quote = null, subscribed = true, verifyToken = null, viewport } = {}) {
  const context = await h.browser.newContext({ timezoneId: 'Europe/Istanbul', ...(viewport ? { viewport } : {}) });
  const page = await context.newPage();
  const calls = { history: [], detail: [], balance: [], start: [], continue: [], quote: [] };
  await page.addInitScript(t => { localStorage.setItem('stellafix_token', t); }, token);
  await page.route(/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.paddle\.com)\//, r => r.abort());
  // A gated (delayed) response may be released after the test already
  // failed and closed the context; fulfilling then throws - ignore it so one
  // failing test cannot take the whole file down.
  await page.route(`${API}/**`, route => handleApi(route).catch(() => {}));
  async function handleApi(route) {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const auth = (req.headers().authorization || '').replace(/^Bearer /, '');
    if (p === '/api/v1/credits/balance') {
      return json(route, 200, { has_active_subscription: subscribed, subscription_status: subscribed ? 'active' : null,
        subscription_ends_at: null, report_credits: 0, question_credits: 0, scheduled_cancellation_at: null });
    }
    if (p === '/api/v1/auth/verify' && verifyToken) return json(route, 200, { access_token: verifyToken, token_type: 'bearer' });
    if (p === '/api/v1/interpret/history') {
      const offset = Number(url.searchParams.get('offset'));
      calls.history.push({ limit: Number(url.searchParams.get('limit')), offset, auth });
      const r = await history(offset, auth);
      if (Array.isArray(r) && typeof r[0] === 'number') return json(route, r[0], r[1]);
      return json(route, 200, { sessions: r, limit: 20, offset });
    }
    if (p === '/api/v1/interpret/quote' && quote) {
      const body = JSON.parse(req.postData());
      calls.quote.push(body);
      return reply(route, quote(body, auth));
    }
    if (p === '/api/v1/interpret/start') {
      const body = JSON.parse(req.postData());
      calls.start.push(body);
      return reply(route, start(body, auth));
    }
    if (p === '/api/v1/interpret/continue') {
      const body = JSON.parse(req.postData());
      calls.continue.push(body);
      return reply(route, cont(body, auth));
    }
    let m = p.match(/^\/api\/v1\/interpret\/([^/]+)\/balance$/);
    if (m) { const id = decodeURIComponent(m[1]); calls.balance.push(id); return reply(route, balance(id, auth)); }
    m = p.match(/^\/api\/v1\/interpret\/([^/]+)$/);
    if (m) { const id = decodeURIComponent(m[1]); calls.detail.push(id); return reply(route, detailFn(id, auth)); }
    return json(route, 404, { detail: 'not mocked' });
  }
  await page.goto(h.baseUrl);
  await page.waitForFunction(() => typeof openReportsList === 'function');
  return { context, page, calls };
}

async function openReports(page) {
  await page.click('#accountChipBtn');
  await page.click('#myReportsBtn');
  await page.waitForSelector('#reportsPanel', { state: 'visible' });
}
const rowSel = id => `#reportsList .report-row[data-session-id="${id}"]`;
const rowText = (page, id, sel) => page.textContent(`${rowSel(id)} ${sel}`);
const rowCount = page => page.$$eval('#reportsList .report-row', els => els.length);
async function waitRows(page, n) {
  await page.waitForFunction(n => document.querySelectorAll('#reportsList .report-row').length === n, n);
}
async function openRow(page, id) {
  await page.click(rowSel(id));
  await page.waitForSelector('#chatPanel', { state: 'visible' });
}
const visible = (page, sel) => page.$eval(sel, el => el.offsetParent !== null || getComputedStyle(el).position === 'fixed' && getComputedStyle(el).display !== 'none');
async function logoutViaMenu(page) {
  await page.click('#accountChipBtn');
  await page.click('.account-menu-logout');
}
async function loginAs(page, token) {
  await page.evaluate(() => { pendingMagicLinkToken = 'magic'; return confirmMagicLink(); });
  await page.waitForFunction(t => authToken === t, token);
}

test('a: My reports opens without a chart, calls /history and renders the rows', { timeout: TEST_TIMEOUT_MS }, async () => {
  const s1 = sess('s1', { chart_name: 'Ayşe', category: 'career' });
  const { context, page, calls } = await openPage({ history: () => [s1] });
  try {
    assert.equal(await visible(page, '#interpretArea'), false, 'no chart yet: interpret area hidden');
    await openReports(page);
    await waitRows(page, 1);
    assert.deepEqual(calls.history.map(c => [c.limit, c.offset]), [[20, 0]]);
    assert.equal(calls.history[0].auth, U1, 'Bearer token sent');
    assert.equal(await visible(page, '#categoryPanel'), false, 'category grid stays hidden');
    assert.equal(await rowText(page, 's1', '.report-row-title'), await page.evaluate(() => t('catCareerTitle')));
    assert.equal(await rowText(page, 's1', '.report-row-person'), 'Ayşe');
    const expected = await page.evaluate(() => new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date('2026-10-10T09:30:00Z')));
    assert.equal(await rowText(page, 's1', '.report-row-created'), expected);
    assert.match(expected, /12:30/, 'shown in the browser time zone (Istanbul, +03)');
    assert.equal(await page.locator('#reportsList .report-row-badge').count(), 0, 'live report: no badge');
    assert.equal(await page.locator('#reportsList .report-row-period').count(), 0, 'no period fields: no period');
  } finally { await context.close(); }
});

test('a2: the menu item is not reachable while logged out', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await openPage();
  try {
    await page.evaluate(() => logout());
    await page.evaluate(() => toggleAccountMenu());
    assert.equal(await visible(page, '#accountMenu'), false);
    assert.equal(await visible(page, '#myReportsBtn'), false);
  } finally { await context.close(); }
});

test('b: person label - a real name is shown as is; null, empty, blank and placeholders become "Kişi"', { timeout: TEST_TIMEOUT_MS }, async () => {
  const names = { n1: '  Mehmet ', n2: null, n3: '', n4: '   ', n5: 'Natal Harita', n6: 'Natal Chart', n7: ' Natal Harita ' };
  const sessions = Object.entries(names).map(([id, chart_name]) => sess(id, { chart_name }));
  const { context, page } = await openPage({ history: () => sessions });
  try {
    await openReports(page);
    await waitRows(page, 7);
    assert.equal(await rowText(page, 'n1', '.report-row-person'), '  Mehmet ', 'shown unchanged');
    for (const id of ['n2', 'n3', 'n4', 'n5', 'n6', 'n7']) assert.equal(await rowText(page, id, '.report-row-person'), 'Kişi', id);
    await page.evaluate(() => setLocale('en'));
    assert.equal(await rowText(page, 'n2', '.report-row-person'), 'Person');
    assert.equal(await rowText(page, 'n6', '.report-row-person'), 'Person');
  } finally { await context.close(); }
});

test('c: chart_name is rendered as text, never as HTML', { timeout: TEST_TIMEOUT_MS }, async () => {
  const evil = '<img src=x onerror=window.__xss=1>';
  const { context, page } = await openPage({ history: () => [sess('x1', { chart_name: evil })] });
  try {
    await openReports(page);
    await waitRows(page, 1);
    assert.equal(await rowText(page, 'x1', '.report-row-person'), evil);
    await delay(200);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('#reportsPanel img').count(), 0);
  } finally { await context.close(); }
});

test('d: period last day uses the report time zone and the exclusive end, also across DST', { timeout: TEST_TIMEOUT_MS }, async () => {
  const sessions = [
    sess('ist', { category: 'weekly_review', period_type: 'rolling_7d', timezone: 'Europe/Istanbul',
      period_start_utc: '2026-10-14T21:00:00+00:00', period_end_utc: '2026-10-21T21:00:00+00:00' }),
    // Calendar week Mon 2 - Sun 8 Mar 2026 in New York. DST starts on 8 Mar, so
    // that Sunday has 23 hours: end - 24h would land on 7 Mar.
    sess('ny', { category: 'weekly_review', period_type: 'calendar_week', timezone: 'America/New_York',
      period_start_utc: '2026-03-02T05:00:00+00:00', period_end_utc: '2026-03-09T04:00:00+00:00' }),
    sess('none', { category: 'monthly_review', period_type: 'rolling_30d' }),
  ];
  const { context, page } = await openPage({ history: () => sessions });
  try {
    await openReports(page);
    await waitRows(page, 3);
    // Expected days from plain calendar dates, independent of the code under test.
    const day = (y, m, d) => page.evaluate(([y, m, d]) => new Intl.DateTimeFormat('tr-TR',
      { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d, 12))), [y, m, d]);
    assert.equal(await rowText(page, 'ist', '.report-row-period'), `Dönem: ${await day(2026, 10, 15)} – ${await day(2026, 10, 21)}`);
    assert.equal(await rowText(page, 'ny', '.report-row-period'), `Dönem: ${await day(2026, 3, 2)} – ${await day(2026, 3, 8)}`);
    assert.equal(await page.locator(`${rowSel('none')} .report-row-period`).count(), 0);
  } finally { await context.close(); }
});

test('e: pagination - offset grows by the returned count, duplicates collapse, short page hides the button', { timeout: TEST_TIMEOUT_MS }, async () => {
  const first = Array.from({ length: 20 }, (_, i) => sess(`p${i}`));
  const second = [sess('p19'), sess('p20'), sess('p21'), sess('p22')];
  const { context, page, calls } = await openPage({ history: off => (off === 0 ? first : second) });
  try {
    await openReports(page);
    await waitRows(page, 20);
    assert.equal(await visible(page, '#reportsMoreBtn'), true);
    await page.click('#reportsMoreBtn');
    await waitRows(page, 23);
    assert.deepEqual(calls.history.map(c => [c.limit, c.offset]), [[20, 0], [20, 20]]);
    assert.equal(await page.$$eval(rowSel('p19'), els => els.length), 1);
    assert.equal(await visible(page, '#reportsMoreBtn'), false, 'short page: no more button');
  } finally { await context.close(); }
});

test('e2: empty list shows the empty state and no more button', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await openPage({ history: () => [] });
  try {
    await openReports(page);
    // The status line first shows "loading"; wait for the empty-state text itself.
    await page.waitForSelector('#reportsStatus >> text=Henüz kayıtlı bir raporun yok');
    assert.equal(await page.textContent('#reportsStatus'), 'Henüz kayıtlı bir raporun yok.');
    assert.equal(await visible(page, '#reportsMoreBtn'), false);
  } finally { await context.close(); }
});

test('f: badges - legacy rows get none, regenerated opens, pending opens read-only', { timeout: TEST_TIMEOUT_MS }, async () => {
  const legacy = sess('old', { is_live: false, superseded: false });
  const sup = sess('sup', { is_live: false, superseded: true });
  const pend = sess('pen', { status: 'pending' });
  const details = { sup: detail(sup), pen: detail(pend, []) };
  const { context, page, calls } = await openPage({ history: () => [legacy, sup, pend], detail: id => details[id] });
  try {
    await openReports(page);
    await waitRows(page, 3);
    assert.equal(await page.locator(`${rowSel('old')} .report-row-badge`).count(), 0);
    assert.doesNotMatch(await page.textContent('#reportsList'), /eski|geçersiz|old|invalid/i);
    assert.equal(await rowText(page, 'sup', '.report-row-badge'), 'Yeniden üretildi');
    assert.equal(await rowText(page, 'pen', '.report-row-badge'), 'Hazırlanıyor');

    await openRow(page, 'sup');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni sup');
    await page.waitForFunction(() => !document.getElementById('chatInput').disabled);

    await page.click('#chatBackBtn');
    await page.waitForSelector('#reportsPanel', { state: 'visible' });
    await openRow(page, 'pen');
    await page.waitForSelector('.chat-bubble.notice >> text=hâlâ hazırlanıyor');
    assert.equal(await page.isDisabled('#chatInput'), true);
    assert.equal(await page.isDisabled('#chatSendBtn'), true);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

test('g: a non-subscriber opens a saved weekly report - no lock, no /start, balance from /balance', { timeout: TEST_TIMEOUT_MS }, async () => {
  const wk = sess('wk', { category: 'weekly_review', period_type: 'rolling_7d', timezone: 'Europe/Istanbul',
    period_start_utc: '2026-10-14T21:00:00+00:00', period_end_utc: '2026-10-21T21:00:00+00:00' });
  const { context, page, calls } = await openPage({
    subscribed: false, history: () => [wk], detail: () => detail(wk), balance: () => bal(1, 2),
  });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.has_active_subscription === false);
    await openReports(page);
    await waitRows(page, 1);
    await openRow(page, 'wk');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni wk');
    assert.equal(await page.textContent('#chatRemaining'), 'Kalan soru hakkın: 3');
    assert.equal(await page.locator('.chat-bubble.error').count(), 0, 'no lock message');
    assert.equal(await page.isDisabled('#chatInput'), false);
    assert.deepEqual([calls.detail, calls.balance], [['wk'], ['wk']]);
    assert.equal(calls.start.length, 0);
    assert.equal(await page.evaluate(() => interpretSessionId), 'wk');
  } finally { await context.close(); }
});

test('h: category_disabled on a follow-up shows its own message and keeps the report', { timeout: TEST_TIMEOUT_MS }, async () => {
  const hs = sess('hs', { category: 'health' });
  const { context, page, calls } = await openPage({
    history: () => [hs], detail: () => detail(hs),
    cont: () => [403, { error: 'category_disabled', detail: 'raw backend text' }],
  });
  try {
    await openReports(page);
    await waitRows(page, 1);
    await openRow(page, 'hs');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni hs');
    await page.fill('#chatInput', 'Bir sorum var');
    await page.click('#chatSendBtn');
    await page.waitForSelector('.chat-bubble.error');
    const err = await page.textContent('.chat-bubble.error');
    assert.match(err, /Bu kategori şu anda kullanılamıyor\./);
    assert.doesNotMatch(err, /Bu rapora erişimin yok/);
    assert.doesNotMatch(err, /raw backend text/);
    assert.equal(calls.continue.length, 1);
    const { request_id: continueId, ...continueBody } = calls.continue[0];
    assert.deepEqual(continueBody, { session_id: 'hs', question: 'Bir sorum var' });
    assert.match(continueId, /^[0-9a-f-]{36}$/);
    assert.equal(await visible(page, '#chatPanel'), true);
    assert.ok(await page.locator('.chat-bubble.assistant >> text=Rapor metni hs').count(), 'report messages stay');
    await page.click('.chat-bubble.error .chat-bubble-action');
    await page.waitForSelector('#reportsPanel', { state: 'visible' });
  } finally { await context.close(); }
});

test('i: an unknown category opens with a generic title, readable, question box closed', { timeout: TEST_TIMEOUT_MS }, async () => {
  const mr = sess('mr', { category: 'timing' });
  const { context, page, calls } = await openPage({ history: () => [mr], detail: () => detail(mr) });
  try {
    await openReports(page);
    await waitRows(page, 1);
    assert.equal(await rowText(page, 'mr', '.report-row-title'), 'Rapor');
    await openRow(page, 'mr');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni mr');
    assert.equal(await page.textContent('#chatCategoryTitle'), 'Rapor');
    assert.equal(await page.isDisabled('#chatInput'), true);
    await page.evaluate(() => { const i = document.getElementById('chatInput'); i.disabled = false; i.value = 'x'; sendFollowUp(); });
    await delay(150);
    assert.equal(calls.continue.length, 0, 'read-only: no /continue');
  } finally { await context.close(); }
});

test('j1: without a chart, "back" from an opened report returns to the list', { timeout: TEST_TIMEOUT_MS }, async () => {
  const s1 = sess('s1');
  const { context, page, calls } = await openPage({ history: () => [s1], detail: () => detail(s1) });
  try {
    await openReports(page);
    await waitRows(page, 1);
    await openRow(page, 's1');
    await page.click('#chatBackBtn');
    await page.waitForSelector('#reportsPanel', { state: 'visible' });
    assert.equal(await visible(page, '#categoryPanel'), false);
    assert.equal(await visible(page, '#chatPanel'), false);
    await waitRows(page, 1);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

test('j2: without a chart, a direct selectCategory sends no /start and opens no category chat', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage();
  try {
    await page.evaluate(() => selectCategory('personality'));
    await delay(250);
    assert.equal(calls.start.length, 0);
    assert.equal(await page.$eval('#chatPanel', el => el.style.display), 'none');
    assert.equal(await page.$eval('#chatCategoryTitle', el => el.textContent), '');
  } finally { await context.close(); }
});

test('k: after /start, /{id}/balance fills the counter; a failed balance keeps the report and offers a retry', { timeout: TEST_TIMEOUT_MS }, async () => {
  let n = 0;
  const { context, page, calls } = await openPage({
    quote: QUOTE_SUB,
    start: () => [200, { session_id: 'new1', message: 'Yeni rapor', language: 'tr', reused: false }],
    balance: () => (++n === 1 ? bal(1) : n === 2 ? [500, {}] : bal(0, 4)),
  });
  try {
    await page.evaluate(() => showInterpretArea('chart-1'));
    await page.click(`button.category-card[onclick="selectCategory('personality')"]`);
    await page.waitForSelector('.chat-bubble.assistant >> text=Yeni rapor');
    await page.waitForFunction(() => document.getElementById('chatRemaining').textContent !== '');
    assert.equal(await page.textContent('#chatRemaining'), 'Kalan soru hakkın: 1');
    assert.deepEqual(calls.balance, ['new1']);
    assert.equal(calls.continue.length, 0);

    // Second report: its balance read fails.
    await page.click('#chatBackBtn');
    await page.click(`button.category-card[onclick="selectCategory('career')"]`);
    await page.waitForSelector('#balanceError', { state: 'visible' });
    assert.ok(await page.locator('.chat-bubble.assistant >> text=Yeni rapor').count(), 'report stays on screen');
    assert.equal(await page.isDisabled('#chatInput'), true);
    assert.equal(await page.isDisabled('#chatSendBtn'), true);
    await page.click('#balanceRetryBtn');
    await page.waitForSelector('#balanceError', { state: 'hidden' });
    assert.equal(await page.isDisabled('#chatInput'), false);
    assert.equal(await page.textContent('#chatRemaining'), 'Kalan soru hakkın: 4');
    assert.equal(calls.start.length, 2);
  } finally { await context.close(); }
});

test('l: logout clears the list and the opened report; a new login does not show old rows', { timeout: TEST_TIMEOUT_MS }, async () => {
  const s1 = sess('s1', { chart_name: 'Eski Hesap' });
  const { context, page } = await openPage({ history: (o, auth) => (auth === U1 ? [s1] : []), detail: () => detail(s1), verifyToken: U2 });
  try {
    await openReports(page);
    await waitRows(page, 1);
    await openRow(page, 's1');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni s1');
    await logoutViaMenu(page);
    assert.equal(await rowCount(page), 0);
    assert.equal(await page.$$eval('#chatMessages > *', els => els.length), 0);
    assert.equal(await visible(page, '#interpretArea'), false);
    assert.equal(JSON.stringify(await page.evaluate(() => [interpretSessionId, questionCreditInfo])), '[null,null]');
    await loginAs(page, U2);
    assert.equal(await rowCount(page), 0);
    assert.doesNotMatch(await page.textContent('body'), /Eski Hesap/);
    await openReports(page);
    await page.waitForSelector('#reportsStatus >> text=Henüz kayıtlı');
    assert.equal(await rowCount(page), 0);
  } finally { await context.close(); }
});

test('m: detail ok but /balance fails - the report opens read-only for questions with a retry that only re-reads /balance', { timeout: TEST_TIMEOUT_MS }, async () => {
  const s1 = sess('s1');
  let n = 0;
  const { context, page, calls } = await openPage({
    history: () => [s1], detail: () => detail(s1), balance: () => (++n === 1 ? [500, {}] : bal(1, 1)),
  });
  try {
    await openReports(page);
    await waitRows(page, 1);
    await openRow(page, 's1');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni s1');
    assert.equal(await visible(page, '#balanceError'), true);
    assert.match(await page.textContent('#balanceError'), /Soru hakkın yüklenemedi/);
    assert.equal(await page.isDisabled('#chatInput'), true);
    assert.equal(await page.isDisabled('#chatSendBtn'), true);
    await page.click('#balanceRetryBtn');
    await page.waitForSelector('#balanceError', { state: 'hidden' });
    assert.equal(await page.isDisabled('#chatInput'), false);
    assert.equal(await page.textContent('#chatRemaining'), 'Kalan soru hakkın: 2');
    assert.deepEqual(calls.detail, ['s1'], 'retry does not re-read the report');
    assert.deepEqual(calls.balance, ['s1', 's1']);
  } finally { await context.close(); }
});

test('n: a late A response does not overwrite report B opened afterwards', { timeout: TEST_TIMEOUT_MS }, async () => {
  const A = sess('A'), B = sess('B');
  const gA = gate();
  const { context, page } = await openPage({
    history: () => [A, B],
    detail: async id => { if (id === 'A') await gA.wait(); return detail(id === 'A' ? A : B); },
    balance: async id => { if (id === 'A') { await gA.wait(); return bal(1, 4); } return bal(1, 1); },
  });
  try {
    await openReports(page);
    await waitRows(page, 2);
    await page.click(rowSel('A'));
    await openRow(page, 'B');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni B');
    assert.equal(await page.textContent('#chatRemaining'), 'Kalan soru hakkın: 2');
    gA.open();
    await delay(300);
    assert.equal(await page.locator('.chat-bubble >> text=Rapor metni A').count(), 0);
    assert.ok(await page.locator('.chat-bubble.assistant >> text=Rapor metni B').count());
    assert.equal(await page.textContent('#chatRemaining'), 'Kalan soru hakkın: 2');
    assert.equal(await page.evaluate(() => interpretSessionId), 'B');
  } finally { await context.close(); }
});

test('o: responses for a signed-out account are not applied after a new sign-in', { timeout: TEST_TIMEOUT_MS }, async () => {
  const u1row = sess('u1a', { chart_name: 'U1 Kişisi' });
  const gList = gate(), gDetail = gate();
  const { context, page } = await openPage({
    verifyToken: U2,
    history: async (o, auth) => { if (auth === U1) { await gList.wait(); return [u1row]; } return []; },
    detail: async () => { await gDetail.wait(); return detail(u1row, [{ role: 'assistant', content: 'U1 rapor içeriği' }]); },
  });
  try {
    // (1) u1's /history is still in flight while the account changes.
    await openReports(page);
    await logoutViaMenu(page);
    await loginAs(page, U2);
    gList.open();
    await delay(300);
    assert.equal(await rowCount(page), 0);
    assert.doesNotMatch(await page.textContent('body'), /U1 Kişisi/);
  } finally { await context.close(); }

  // (2) u1's report detail/balance are still in flight while the account changes.
  const ctx2 = await openPage({
    verifyToken: U2,
    history: (o, auth) => (auth === U1 ? [u1row] : []),
    detail: async () => { await gDetail.wait(); return detail(u1row, [{ role: 'assistant', content: 'U1 rapor içeriği' }]); },
  });
  try {
    await openReports(ctx2.page);
    await waitRows(ctx2.page, 1);
    await ctx2.page.click(rowSel('u1a'));
    await logoutViaMenu(ctx2.page);
    await loginAs(ctx2.page, U2);
    gDetail.open();
    await delay(300);
    assert.doesNotMatch(await ctx2.page.textContent('body'), /U1 rapor içeriği/);
    assert.equal(await ctx2.page.evaluate(() => interpretSessionId), null);
  } finally { await ctx2.context.close(); }
});

test('p: a late /start for a signed-out account is not shown and raises no notice', { timeout: TEST_TIMEOUT_MS }, async () => {
  const g = gate();
  const { context, page, calls } = await openPage({
    verifyToken: U2, quote: QUOTE_SUB,
    start: async () => { await g.wait(); return [200, { session_id: 'u1rep', message: 'U1 rapor metni', language: 'tr' }]; },
  });
  try {
    await page.evaluate(() => showInterpretArea('chart-1'));
    await page.click(`button.category-card[onclick="selectCategory('personality')"]`);
    await page.waitForFunction(() => document.getElementById('chatLoading').style.display === 'flex');
    await logoutViaMenu(page);
    await loginAs(page, U2);
    g.open();
    await delay(300);
    assert.equal(calls.start.length, 1);
    assert.doesNotMatch(await page.textContent('body'), /U1 rapor metni/);
    assert.equal(await page.evaluate(() => interpretSessionId), null);
    assert.equal(await visible(page, '#reportReadyToast'), false);
  } finally { await context.close(); }
});

test('q: a /start that finishes after the user opened an old report does not overwrite it; a "ready" notice appears', { timeout: TEST_TIMEOUT_MS }, async () => {
  const old = sess('old1');
  const g = gate();
  const { context, page, calls } = await openPage({
    history: () => [old], detail: () => detail(old), balance: () => bal(1, 0), quote: QUOTE_SUB,
    start: async () => { await g.wait(); return [200, { session_id: 'new9', message: 'Yeni rapor metni', language: 'tr' }]; },
  });
  try {
    await page.evaluate(() => showInterpretArea('chart-1'));
    await page.click(`button.category-card[onclick="selectCategory('personality')"]`);
    await page.waitForFunction(() => document.getElementById('chatLoading').style.display === 'flex');
    await openReports(page);
    await waitRows(page, 1);
    await openRow(page, 'old1');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni old1');
    g.open();
    await page.waitForSelector('#reportReadyToast', { state: 'visible' });
    assert.match(await page.textContent('#reportReadyToast'), /Raporun hazır/);
    assert.equal(await page.locator('.chat-bubble >> text=Yeni rapor metni').count(), 0);
    assert.equal(await page.$$eval('#chatMessages .chat-bubble.assistant', els => els.length), 1);
    assert.equal(await page.evaluate(() => interpretSessionId), 'old1');
    assert.equal(await page.textContent('#chatRemaining'), 'Kalan soru hakkın: 1');
    assert.equal(calls.start.length, 1);
    await page.click('#reportReadyOpenBtn');
    await page.waitForSelector('#reportsPanel', { state: 'visible' });
  } finally { await context.close(); }
});

test('r: a late /continue answer for report A does not touch report B', { timeout: TEST_TIMEOUT_MS }, async () => {
  const A = sess('A'), B = sess('B');
  const g = gate();
  const { context, page } = await openPage({
    history: () => [A, B], detail: id => detail(id === 'A' ? A : B),
    balance: id => (id === 'A' ? bal(1, 0) : bal(1, 1)),
    cont: async () => { await g.wait(); return [200, { message: 'A cevabı', ...bal(0, 7) }]; },
  });
  try {
    await openReports(page);
    await waitRows(page, 2);
    await openRow(page, 'A');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni A');
    await page.fill('#chatInput', 'A sorusu');
    await page.click('#chatSendBtn');
    await page.click('#chatBackBtn');
    await page.waitForSelector('#reportsPanel', { state: 'visible' });
    await openRow(page, 'B');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni B');
    g.open();
    await delay(300);
    assert.equal(await page.locator('.chat-bubble >> text=A cevabı').count(), 0);
    assert.equal(await page.textContent('#chatRemaining'), 'Kalan soru hakkın: 2');
    assert.equal(await page.evaluate(() => interpretSessionId), 'B');
    assert.equal(await page.isDisabled('#chatInput'), false);
  } finally { await context.close(); }
});

test('s: read errors use the friendly messages, never the raw backend text', { timeout: TEST_TIMEOUT_MS }, async () => {
  const s1 = sess('s1');
  const { context, page } = await openPage({ history: () => [s1], detail: () => [404, { detail: "session_id 's1' not found" }] });
  try {
    await openReports(page);
    await waitRows(page, 1);
    await page.click(rowSel('s1'));
    await page.waitForFunction(() => document.getElementById('reportsStatus').classList.contains('error'));
    assert.equal(await page.textContent('#reportsStatus'), 'Bu rapor bulunamadı.');
    assert.equal(await visible(page, '#chatPanel'), false);
  } finally { await context.close(); }
});

test('t: switching the language re-renders the open list', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await openPage({ history: () => [sess('s1', { category: 'timing', chart_name: null })] });
  try {
    await openReports(page);
    await waitRows(page, 1);
    assert.equal(await rowText(page, 's1', '.report-row-title'), 'Rapor');
    await page.evaluate(() => setLocale('en'));
    assert.equal(await rowText(page, 's1', '.report-row-title'), 'Report');
    assert.equal(await rowText(page, 's1', '.report-row-person'), 'Person');
    assert.equal(await page.textContent('#reportsPanel .panel-title'), 'My reports');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// Late /balance responses (after /start, and from "Try again") must never
// touch another report, the same report reopened later, or another account.
// Each test waits until the late response has reached the browser and the
// page has had a turn to process it before asserting.
// ---------------------------------------------------------------------------
const balanceUrl = id => r => r.url().endsWith(`/api/v1/interpret/${id}/balance`);
const settle = page => page.evaluate(() => new Promise(r => setTimeout(r, 50)));
// Wait for a request to reach the mock (bounded, so a missing request fails the test).
async function until(cond, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}
async function assertShowsB(page) {
  assert.equal(await page.textContent('#chatRemaining'), 'Kalan soru hakkın: 4');
  assert.equal(await page.$eval('#balanceError', el => el.style.display), 'none');
  assert.equal(await page.evaluate(() => interpretSessionId), 'B');
  assert.equal(await page.isDisabled('#chatInput'), false);
  assert.equal(await page.isDisabled('#chatSendBtn'), false);
}

for (const [label, lateS] of [['500', [500, {}]], ['200 with other values', bal(1, 0)]]) {
  test(`u: a late /balance (${label}) for a new report does not touch report B opened meanwhile`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const B = sess('B');
    const gS = gate();
    const { context, page, calls } = await openPage({
      history: () => [B], detail: () => detail(B), quote: QUOTE_SUB,
      start: () => [200, { session_id: 'S', message: 'Yeni rapor S', language: 'tr' }],
      balance: async id => { if (id === 'S') { await gS.wait(); return lateS; } return bal(0, 4); },
    });
    try {
      await page.evaluate(() => showInterpretArea('chart-1'));
      await page.click(`button.category-card[onclick="selectCategory('personality')"]`);
      await page.waitForSelector('.chat-bubble.assistant >> text=Yeni rapor S');
      await until(() => calls.balance.includes('S'), 'the S /balance request'); // held by the gate
      await openReports(page);
      await waitRows(page, 1);
      await openRow(page, 'B');
      await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni B');
      await page.waitForFunction(() => document.getElementById('chatRemaining').textContent === 'Kalan soru hakkın: 4');
      const late = page.waitForResponse(balanceUrl('S'));
      gS.open();
      await late;
      await settle(page);
      await assertShowsB(page);
    } finally { await context.close(); }
  });
}

test('v: a late "Try again" /balance for report A does not touch report B opened meanwhile', { timeout: TEST_TIMEOUT_MS }, async () => {
  const A = sess('A'), B = sess('B');
  const gRetry = gate();
  let aCalls = 0;
  const { context, page, calls } = await openPage({
    history: () => [A, B], detail: id => detail(id === 'A' ? A : B),
    balance: async id => {
      if (id === 'B') return bal(0, 4);
      aCalls += 1;
      if (aCalls === 1) return [500, {}];
      await gRetry.wait();
      return bal(1, 9);
    },
  });
  try {
    await openReports(page);
    await waitRows(page, 2);
    await openRow(page, 'A');
    await page.waitForSelector('#balanceError', { state: 'visible' });
    await page.click('#balanceRetryBtn');
    await until(() => calls.balance.filter(x => x === 'A').length === 2, 'the retry /balance request');
    await page.click('#chatBackBtn');
    await page.waitForSelector('#reportsPanel', { state: 'visible' });
    await openRow(page, 'B');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni B');
    await page.waitForFunction(() => document.getElementById('chatRemaining').textContent === 'Kalan soru hakkın: 4');
    const late = page.waitForResponse(balanceUrl('A'));
    gRetry.open();
    await late;
    await settle(page);
    await assertShowsB(page);
  } finally { await context.close(); }
});

test('w: a late /balance for a new report is not applied after logout and a new sign-in', { timeout: TEST_TIMEOUT_MS }, async () => {
  const gS = gate();
  const { context, page, calls } = await openPage({
    verifyToken: U2, quote: QUOTE_SUB,
    start: () => [200, { session_id: 'S', message: 'Yeni rapor S', language: 'tr' }],
    balance: async () => { await gS.wait(); return bal(1, 3); },
  });
  try {
    await page.evaluate(() => showInterpretArea('chart-1'));
    await page.click(`button.category-card[onclick="selectCategory('personality')"]`);
    await page.waitForSelector('.chat-bubble.assistant >> text=Yeni rapor S');
    await until(() => calls.balance.includes('S'), 'the S /balance request');
    await logoutViaMenu(page);
    await loginAs(page, U2);
    const late = page.waitForResponse(balanceUrl('S'));
    gS.open();
    await late;
    await settle(page);
    assert.equal(await page.textContent('#chatRemaining'), '');
    assert.equal(await page.$eval('#balanceError', el => el.style.display), 'none');
    assert.equal(await page.evaluate(() => questionCreditInfo), null);
    assert.equal(await page.evaluate(() => interpretSessionId), null);
  } finally { await context.close(); }
});

test('x: a late "Try again" /balance does not overwrite the same report reopened afterwards', { timeout: TEST_TIMEOUT_MS }, async () => {
  const A = sess('A');
  const gRetry = gate();
  let aCalls = 0;
  const { context, page, calls } = await openPage({
    history: () => [A], detail: () => detail(A),
    balance: async () => {
      aCalls += 1;
      if (aCalls === 1) return [500, {}];
      if (aCalls === 2) { await gRetry.wait(); return bal(1, 9); } // stale
      return bal(0, 4);                                            // fresh, after reopening
    },
  });
  try {
    await openReports(page);
    await waitRows(page, 1);
    await openRow(page, 'A');
    await page.waitForSelector('#balanceError', { state: 'visible' });
    await page.click('#balanceRetryBtn');
    await until(() => calls.balance.length === 2, 'the retry /balance request');
    await page.click('#chatBackBtn');
    await page.waitForSelector('#reportsPanel', { state: 'visible' });
    await openRow(page, 'A');
    await page.waitForFunction(() => document.getElementById('chatRemaining').textContent === 'Kalan soru hakkın: 4');
    const late = page.waitForResponse(balanceUrl('A'));
    gRetry.open();
    await late;
    await settle(page);
    assert.equal(await page.textContent('#chatRemaining'), 'Kalan soru hakkın: 4');
    assert.equal(await page.$eval('#balanceError', el => el.style.display), 'none');
    assert.equal(await page.evaluate(() => interpretSessionId), 'A');
    assert.equal(calls.balance.length, 3);
  } finally { await context.close(); }
});

test('y: the My reports top button reads "Kapat" without a chart and "Kategorilere dön" once a chart exists, in both languages and after logging in again', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await openPage({ verifyToken: U1 });
  try {
    await openReports(page);
    assert.equal(await page.textContent('#reportsCloseBtn'), 'Kapat');
    await page.evaluate(() => setLocale('en'));
    assert.equal(await page.textContent('#reportsCloseBtn'), 'Close');
    await page.evaluate(() => setLocale('tr'));
    await page.click('#reportsCloseBtn');
    assert.equal(await visible(page, '#reportsPanel'), false);
    assert.equal(await visible(page, '#interpretArea'), false, 'back on the main screen');

    await page.evaluate(() => showInterpretArea('chart-1'));
    await openReports(page);
    assert.equal(await page.textContent('#reportsCloseBtn'), '← Kategorilere dön');
    await page.evaluate(() => setLocale('en'));
    assert.equal(await page.textContent('#reportsCloseBtn'), '← Back to categories');
    await page.click('#reportsCloseBtn');
    assert.equal(await visible(page, '#categoryPanel'), true, 'back on the categories');
    assert.equal(await visible(page, '#reportsPanel'), false);

    // Logout and login again: the chart of this page session is still there.
    await page.evaluate(() => setLocale('tr'));
    await logoutViaMenu(page);
    await loginAs(page, U1);
    await openReports(page);
    assert.equal(await page.textContent('#reportsCloseBtn'), '← Kategorilere dön');
    await page.click('#reportsCloseBtn');
    assert.equal(await visible(page, '#categoryPanel'), true, 'back on the categories after logging in again');
  } finally { await context.close(); }
});
