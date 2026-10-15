// Browser integration test for the category flow with a quote first, the
// confirmation screen, request_id on /start and /continue, the per-request
// browser record (sessionStorage) and its resume / keep / delete rules, and
// the request timeouts. The API is mocked with page.route; no real backend
// is called. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { API, startHarness, json } = require('./helpers/harness.cjs');

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h?.close(); });

const b64url = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fakeJwt = sub => `h.${b64url(JSON.stringify({ sub, email: `${sub}@example.test`, subscription_tier: 'free', exp: 9999999999 }))}.s`;
const U1 = fakeJwt('u1'), U2 = fakeJwt('u2');
const PREFIX = 'stellafix_pending_interpret:v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const delay = ms => new Promise(r => setTimeout(r, ms));
function gate() { let open; const p = new Promise(r => { open = r; }); return { wait: () => p, open }; }
const never = () => new Promise(() => {});
async function until(cond, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

const Q = {
  sub: () => ({ found_existing: false, would_spend: 'subscription', existing: null }),
  credit: () => ({ found_existing: true, would_spend: 'report_credit', existing: null }),
  none: id => () => ({ found_existing: true, would_spend: 'none',
    existing: { session_id: id, created_at: '2026-10-10T09:30:00+00:00', model: 'm', prompt_style: 'classic', data_version: 3 } }),
  err: (status, error) => () => [status, { error, detail: 'raw backend text' }],
};
const startOk = id => [200, { session_id: id, message: `Rapor metni ${id}`, language: 'tr', reused: false }];
const bal = (free, credits = 0) => ({ questions_included: 1, questions_used: 1 - Math.min(free, 1), questions_remaining_free: free, question_credits_remaining: credits, unlimited: false });
function sess(id, overrides = {}) {
  return {
    session_id: id, chart_id: 'chart-1', chart_name: 'Ayşe', category: 'personality', language: 'tr',
    relationship_type: null, status: 'completed', created_at: '2026-10-10T09:30:00+00:00',
    period_type: null, period_start_utc: null, period_end_utc: null, timezone: null,
    model: 'm', prompt_style: 'classic', system_prompt_version: 'a', data_prompt_version: 'b', data_version: 3,
    is_live: true, superseded: false, ...overrides,
  };
}
const detailOf = id => ({ ...sess(id), messages: [{ role: 'assistant', content: `Rapor metni ${id}`, created_at: '2026-10-10T09:30:00+00:00' }] });

// A responder returns a body (200), a [status, body] tuple, 'abort', or a Promise of either.
async function reply(route, r) {
  r = await r;
  if (r === 'abort') return route.abort('failed');
  if (Array.isArray(r) && typeof r[0] === 'number') return json(route, r[0], r[1]);
  return json(route, 200, r);
}

// Opens the page. `token` null = logged out. `seed`: [[key, value]] written
// to sessionStorage once (before the first load only). `clock`: install the
// fake clock before the first load. `chart`: show the category grid for a chart.
async function openPage({ token = U1, quote = Q.sub, start = () => startOk('S1'), cont = () => [200, { message: 'Cevap', ...bal(0) }],
  history = () => [], detail = id => detailOf(id), balance = () => bal(1, 2), credits = () => ({ report_credits: 3 }),
  subscribed = false, verify = null, seed = [], clock = false, chart = true, timezoneId = 'Europe/Istanbul' } = {}) {
  const context = await h.browser.newContext({ timezoneId });
  const page = await context.newPage();
  const calls = { quote: [], start: [], continue: [], detail: [], balance: [], history: [], credits: 0, log: [] };
  const net = { active: 0, max: 0, failedStart: 0, failedContinue: 0 };
  const isGen = u => /\/api\/v1\/interpret\/(start|continue)$/.test(u);
  page.on('request', r => { if (isGen(r.url())) { net.active += 1; net.max = Math.max(net.max, net.active); } });
  page.on('requestfinished', r => { if (isGen(r.url())) net.active -= 1; });
  page.on('requestfailed', r => {
    if (!isGen(r.url())) return;
    net.active -= 1;
    if (r.url().endsWith('/start')) net.failedStart += 1; else net.failedContinue += 1;
  });
  await page.addInitScript(({ token, seed }) => {
    if (sessionStorage.getItem('__test_init')) return;
    sessionStorage.setItem('__test_init', '1');
    if (token) localStorage.setItem('stellafix_token', token);
    for (const [k, v] of seed) sessionStorage.setItem(k, v);
  }, { token, seed });
  if (clock) await page.clock.install({ time: new Date('2026-10-15T10:00:00Z') });
  await page.route(/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.paddle\.com)\//, r => r.abort());
  await page.route(`${API}/**`, route => handleApi(route).catch(() => {}));
  async function handleApi(route) {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const auth = (req.headers().authorization || '').replace(/^Bearer /, '');
    if (p === '/api/v1/credits/balance') {
      calls.credits += 1;
      const c = await credits();
      if (Array.isArray(c)) return json(route, c[0], c[1]);
      return json(route, 200, { has_active_subscription: subscribed, subscription_status: subscribed ? 'active' : null,
        subscription_ends_at: null, question_credits: 0, scheduled_cancellation_at: null, ...c });
    }
    if (p === '/api/v1/auth/verify' && verify) return json(route, 200, { access_token: verify(), token_type: 'bearer' });
    if (p === '/api/v1/interpret/history') {
      calls.history.push(auth);
      return json(route, 200, { sessions: await history(auth), limit: 20, offset: 0 });
    }
    if (p === '/api/v1/interpret/quote') {
      const raw = req.postData();
      calls.quote.push({ raw, body: JSON.parse(raw), auth });
      calls.log.push('quote');
      return reply(route, quote(JSON.parse(raw), calls.quote.length));
    }
    if (p === '/api/v1/interpret/start' || p === '/api/v1/interpret/continue') {
      const raw = req.postData();
      const kind = p.endsWith('start') ? 'start' : 'continue';
      const entry = { raw, body: JSON.parse(raw), auth, at: null };
      calls[kind].push(entry);
      calls.log.push(kind);
      entry.at = await page.evaluate(() => Date.now()).catch(() => null);
      return reply(route, (kind === 'start' ? start : cont)(entry.body, calls[kind].length, entry));
    }
    let m = p.match(/^\/api\/v1\/interpret\/([^/]+)\/balance$/);
    if (m) { const id = decodeURIComponent(m[1]); calls.balance.push(id); calls.log.push(`balance:${id}`); return reply(route, balance(id)); }
    m = p.match(/^\/api\/v1\/interpret\/([^/]+)$/);
    if (m) { const id = decodeURIComponent(m[1]); calls.detail.push(id); calls.log.push(`detail:${id}`); return reply(route, detail(id)); }
    return json(route, 404, { detail: 'not mocked' });
  }
  const load = async () => {
    await page.waitForFunction(() => typeof scanPending === 'function');
  };
  await page.goto(h.baseUrl);
  await load();
  if (chart && token) await page.evaluate(() => showInterpretArea('chart-1'));
  return { context, page, calls, net, reload: async () => { await page.reload(); await load(); } };
}

const clickCategory = (page, id) => page.click(`button.category-card[onclick="selectCategory('${id}')"]`);
const pendingKeys = page => page.evaluate(p => Object.keys(sessionStorage).filter(k => k.startsWith(p)).sort(), PREFIX);
const pendingRecord = (page, key) => page.evaluate(k => JSON.parse(sessionStorage.getItem(k)), key);
const keyFor = (sub, id) => `${PREFIX}${sub}:${id}`;
const text = (page, sel) => page.textContent(sel);
const count = (page, sel) => page.locator(sel).count();
async function openReports(page) {
  await page.click('#accountChipBtn');
  await page.click('#myReportsBtn');
  await page.waitForSelector('#reportsPanel', { state: 'visible' });
}
async function logoutViaMenu(page) {
  await page.click('#accountChipBtn');
  await page.click('.account-menu-logout');
}
async function loginAs(page, token) {
  await page.evaluate(() => { pendingMagicLinkToken = 'magic'; return confirmMagicLink(); });
  await page.waitForFunction(t => authToken === t, token);
}
// One page turn so a response that already arrived has been handled.
const nextFrame = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));
function seedRecord(sub, id, body, { kind = 'start', created_at = 1, paused = false, spend = 'subscription' } = {}) {
  const raw = JSON.stringify(body);
  return [keyFor(sub, id), JSON.stringify({ v: 1, sub, kind, request_id: id, body: raw,
    approved_spend: kind === 'start' ? spend : null, created_at, paused })];
}
const startBody = (id, category = 'personality', spend = 'subscription') =>
  ({ chart_id: 'chart-1', category, language: 'tr', request_id: id, expected_spend: spend });

// ---------------------------------------------------------------------------
// 1. Quote branches
// ---------------------------------------------------------------------------
test('1 none: a saved report opens from the quote - detail and balance read, no /start, back goes to categories', async () => {
  const { context, page, calls } = await openPage({ quote: Q.none('saved1'), balance: () => bal(1, 2) });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni saved1');
    assert.equal(calls.start.length, 0);
    assert.deepEqual([calls.detail, calls.balance], [['saved1'], ['saved1']]);
    assert.deepEqual(calls.quote[0].body, { chart_id: 'chart-1', category: 'personality', language: 'tr' });
    assert.equal(await text(page, '#chatRemaining'), 'Kalan soru hakkın: 3');
    assert.equal(await text(page, '#chatBackBtn'), '← Kategorilere dön');
    await page.click('#chatBackBtn');
    await page.waitForSelector('#categoryPanel', { state: 'visible' });
    assert.deepEqual(await pendingKeys(page), []);
  } finally { await context.close(); }
});

test('1 subscription: /start goes without a confirmation, carrying request_id and expected_spend "subscription"', async () => {
  const { context, page, calls } = await openPage({ quote: Q.sub, start: () => startOk('S1') });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(await count(page, '.quote-confirm-btn'), 0);
    assert.equal(calls.start.length, 1);
    const { body, raw } = calls.start[0];
    assert.match(body.request_id, UUID);
    assert.equal(raw, JSON.stringify(startBody(body.request_id)));
    for (const q of calls.quote) {
      for (const f of ['request_id', 'expected_spend', 'force_regenerate']) assert.equal(f in q.body, false, `quote has no ${f}`);
    }
    assert.equal('force_regenerate' in body, false);
    assert.deepEqual(await pendingKeys(page), [], '200 deletes the record');
  } finally { await context.close(); }
});

test('1 report_credit: confirm screen with the balance; nothing is sent until confirmed', async () => {
  const { context, page, calls } = await openPage({ quote: Q.credit, credits: () => ({ report_credits: 3 }) });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.report_credits === 3);
    await clickCategory(page, 'personality');
    await page.waitForSelector('.quote-confirm-btn');
    const bubble = await text(page, '.chat-bubble.notice');
    assert.match(bubble, /1 rapor hakkı kullanılacak\./);
    assert.match(bubble, /Kalan rapor hakkın: 3/);
    await delay(200);
    assert.equal(calls.start.length, 0, 'no /start before the confirmation');
    await page.click('.quote-confirm-btn');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(calls.start.length, 1);
    assert.equal(calls.start[0].raw, JSON.stringify(startBody(calls.start[0].body.request_id, 'personality', 'report_credit')));
  } finally { await context.close(); }
});

test('1 report_credit with no credits: "Rapor hakkın yok" and Subscribe, no confirm button', async () => {
  const { context, page, calls } = await openPage({ quote: Q.credit, credits: () => ({ report_credits: 0 }) });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.report_credits === 0);
    await clickCategory(page, 'personality');
    await page.waitForSelector('.chat-bubble.notice >> text=Rapor hakkın yok.');
    assert.equal(await count(page, '.quote-confirm-btn'), 0);
    assert.equal(await text(page, '.chat-bubble.notice .chat-bubble-action'), 'Abone Ol');
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

test('1 report_credit with an unreadable balance: reads it once more, then shows the confirm button without a balance line', async () => {
  const { context, page, calls } = await openPage({ quote: Q.credit, credits: () => [500, {}] });
  try {
    await until(() => calls.credits >= 1, 'the first balance read');
    await page.waitForFunction(() => creditBalance === null);
    const before = calls.credits;
    await clickCategory(page, 'personality');
    await page.waitForSelector('.quote-confirm-btn');
    assert.ok(calls.credits > before, 'balance read again before the confirm screen');
    const bubble = await text(page, '.chat-bubble.notice');
    assert.match(bubble, /1 rapor hakkı kullanılacak\./);
    assert.doesNotMatch(bubble, /Kalan rapor hakkın/);
  } finally { await context.close(); }
});

test('1 403 category_requires_subscription: lock message and Subscribe; 403 category_disabled: its own message', async () => {
  for (const [error, re] of [['category_requires_subscription', /abonelere özel|aboneli/i], ['category_disabled', /Bu kategori şu anda kullanılamıyor\./]]) {
    const { context, page, calls } = await openPage({ quote: Q.err(403, error) });
    try {
      await clickCategory(page, 'weekly_review');
      await page.waitForSelector('.chat-bubble.error');
      const err = await text(page, '.chat-bubble.error');
      if (error === 'category_requires_subscription') {
        assert.equal(err.replace('Abone Ol', ''), await page.evaluate(() => t('errCategoryLocked')));
        assert.equal(await text(page, '.chat-bubble.error .chat-bubble-action'), 'Abone Ol');
      } else {
        assert.match(err, re);
        assert.doesNotMatch(err, /Bu rapora erişimin yok/);
      }
      assert.doesNotMatch(err, /raw backend text/);
      assert.equal(calls.start.length, 0);
    } finally { await context.close(); }
  }
});

test('1 409 generation_in_progress (manual form): message and "Tekrar kontrol et", no /start', async () => {
  const { context, page, calls } = await openPage({ quote: Q.err(409, 'generation_in_progress') });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.quote-check-btn');
    assert.match(await text(page, '.chat-bubble.notice'), /Bu rapor şu anda hazırlanıyor\./);
    assert.equal(await text(page, '.quote-check-btn'), 'Tekrar kontrol et');
    assert.equal(calls.start.length, 0);
    assert.deepEqual(await pendingKeys(page), []);
  } finally { await context.close(); }
});

test('1 quote network error: "Tekrar dene" makes a new quote, no record is created', async () => {
  const { context, page, calls } = await openPage({ quote: (b, n) => (n === 1 ? 'abort' : Q.sub()) });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.quote-retry-btn');
    assert.equal(calls.start.length, 0);
    assert.deepEqual(await pendingKeys(page), []);
    await page.click('.quote-retry-btn');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(calls.quote.length, 2);
    assert.equal(calls.quote[1].raw, calls.quote[0].raw);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// 2, 3. Lock no longer blocks before the API; category_disabled on a question
// ---------------------------------------------------------------------------
test('2: a non-subscriber clicking a locked weekly category gets the saved report from the quote', async () => {
  const { context, page, calls } = await openPage({ subscribed: false, quote: Q.none('wk1'), balance: () => bal(1, 2) });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.has_active_subscription === false);
    assert.equal(await page.evaluate(() => isCategoryLocked('weekly_review')), true, 'lock visual stays');
    await clickCategory(page, 'weekly_review');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni wk1');
    assert.equal(calls.quote.length, 1);
    assert.equal(calls.quote[0].body.timezone, 'Europe/Istanbul');
    assert.equal(calls.start.length, 0);
    assert.equal(await count(page, '.chat-bubble.error'), 0);
    assert.equal(await text(page, '#chatRemaining'), 'Kalan soru hakkın: 3');
  } finally { await context.close(); }
});

test('3: a health report from history - /continue 403 category_disabled shows the new message, report stays, record deleted', async () => {
  const hs = sess('hs', { category: 'health' });
  const { context, page, calls } = await openPage({
    chart: false, history: () => [hs], detail: () => ({ ...hs, messages: [{ role: 'assistant', content: 'Rapor metni hs' }] }),
    cont: () => [403, { error: 'category_disabled', detail: 'raw' }],
  });
  try {
    await openReports(page);
    await page.click('#reportsList .report-row[data-session-id="hs"]');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni hs');
    await page.fill('#chatInput', 'Soru');
    await page.click('#chatSendBtn');
    await page.waitForSelector('.chat-bubble.error');
    assert.match(await text(page, '.chat-bubble.error'), /Bu kategori şu anda kullanılamıyor\./);
    assert.ok(await count(page, '.chat-bubble.assistant >> text=Rapor metni hs'));
    assert.deepEqual(await pendingKeys(page), []);
    assert.equal(calls.continue.length, 1);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// 4. spend_changed
// ---------------------------------------------------------------------------
test('4 spend_changed: no automatic second /start; a new quote and a new confirmation; a new id on confirm', async () => {
  const { context, page, calls } = await openPage({
    quote: (b, n) => (n === 1 ? Q.sub() : Q.credit()), credits: () => ({ report_credits: 2 }),
    start: (b, n) => (n === 1 ? [409, { error: 'spend_changed', quoted: 'subscription', actual: 'report_credit', found_existing: false }] : startOk('S2')),
  });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.report_credits === 2);
    await clickCategory(page, 'personality');
    await page.waitForSelector('.quote-confirm-btn');
    assert.match(await text(page, '#chatMessages'), /Bu raporun bedeli değişti: artık 1 rapor hakkı kullanılacak\./);
    assert.equal(calls.start.length, 1);
    assert.equal(calls.quote.length, 2);
    assert.deepEqual(await pendingKeys(page), [], 'spend_changed deletes the record');
    await delay(200);
    assert.equal(calls.start.length, 1, 'still no second /start before confirming');
    await page.click('.quote-confirm-btn');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S2');
    assert.equal(calls.start.length, 2);
    const [a, b] = calls.start.map(c => c.body);
    assert.notEqual(b.request_id, a.request_id);
    assert.equal(a.expected_spend, 'subscription');
    assert.equal(calls.start[1].raw, JSON.stringify(startBody(b.request_id, 'personality', 'report_credit')));
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// 5, 6, 7. Same id, same bytes; record written before fetch; reload resumes
// ---------------------------------------------------------------------------
test('5: after a network error "Tekrar dene" resends the same id and the byte-identical body, even after a language change', async () => {
  const { context, page, calls } = await openPage({ start: (b, n) => (n === 1 ? 'abort' : startOk('S1')) });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.pending-retry-btn');
    assert.match(await text(page, '#chatMessages'), /Bağlantı sorunu/);
    const keys = await pendingKeys(page);
    assert.deepEqual(keys, [keyFor('u1', calls.start[0].body.request_id)], 'kept');
    await page.evaluate(() => setLocale('en'));
    await page.click('.pending-retry-btn');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(calls.start.length, 2);
    assert.equal(calls.start[1].raw, calls.start[0].raw, 'byte-identical body');
    assert.equal(calls.start[1].body.language, 'tr');
    assert.deepEqual(await pendingKeys(page), []);
  } finally { await context.close(); }
});

test('6: the record already exists in sessionStorage when /start reaches the network', async () => {
  let seen = null;
  const { context, page, calls } = await openPage({
    start: async (body, n, entry) => {
      seen = await pageRef.evaluate(k => sessionStorage.getItem(k), keyFor('u1', body.request_id));
      return startOk('S1');
    },
  });
  const pageRef = page;
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.ok(seen, 'record present at request time');
    const rec = JSON.parse(seen);
    assert.deepEqual(Object.keys(rec).sort(), ['approved_spend', 'body', 'created_at', 'kind', 'paused', 'request_id', 'sub', 'v']);
    assert.equal(rec.request_id, calls.start[0].body.request_id);
    assert.equal(rec.body, calls.start[0].raw, 'stored body is the exact text that was sent');
    assert.equal(typeof rec.body, 'string');
    assert.deepEqual([rec.v, rec.sub, rec.kind, rec.approved_spend, rec.paused], [1, 'u1', 'start', 'subscription', false]);
  } finally { await context.close(); }
});

test('7: a reload during /start resumes it with the same id and body, opens the report and deletes the record', async () => {
  const { context, page, calls, reload } = await openPage({ start: (b, n) => (n === 1 ? never() : startOk('S1')) });
  try {
    await clickCategory(page, 'personality');
    await until(() => calls.start.length === 1, 'first /start');
    await reload();
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(calls.start.length, 2);
    assert.equal(calls.start[1].raw, calls.start[0].raw);
    assert.equal(calls.quote.length, 1, 'no new quote on resume');
    assert.deepEqual(calls.detail, ['S1']);
    assert.deepEqual(await pendingKeys(page), []);
    assert.match(await text(page, '#resumeToastText'), /1 yarım kalan isteğin sürdürülüyor/);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// 8, 15, 16, 17. Account rules
// ---------------------------------------------------------------------------
test('8: a record of u1 is not used under u2 - no /start, the record is deleted', async () => {
  const [k, v] = seedRecord('u1', 'rid-u1', startBody('rid-u1'));
  const { context, page, calls } = await openPage({ token: U2, seed: [[k, v]] });
  try {
    await page.waitForFunction(key => sessionStorage.getItem(key) === null, k);
    await nextFrame(page);
    assert.equal(calls.start.length, 0);
    assert.equal(calls.continue.length, 0);
  } finally { await context.close(); }
});

test('15: 401 keeps the record; after a reload nothing is sent without a token; logging in as u1 resumes the same id and bytes', async () => {
  const { context, page, calls, reload } = await openPage({
    verify: () => U1, start: (b, n) => (n === 1 ? [401, { detail: 'Not authenticated' }] : startOk('S1')),
  });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('#authModalBackdrop', { state: 'visible' });
    assert.equal(await page.evaluate(() => authToken), null);
    const key = keyFor('u1', calls.start[0].body.request_id);
    assert.deepEqual(await pendingKeys(page), [key]);
    await reload();
    await nextFrame(page);
    await delay(200);
    assert.equal(calls.start.length, 1, 'no /start without a token');
    assert.deepEqual(await pendingKeys(page), [key]);
    await loginAs(page, U1);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(calls.start.length, 2);
    assert.equal(calls.start[1].raw, calls.start[0].raw);
    assert.equal(calls.start[1].auth, U1);
    assert.deepEqual(await pendingKeys(page), []);
  } finally { await context.close(); }
});

test('16: without a token the records stay and nothing is sent', async () => {
  const a = seedRecord('u1', 'rid-a', startBody('rid-a'));
  const c = seedRecord('u1', 'rid-c', { session_id: 'A', question: 'q', request_id: 'rid-c' }, { kind: 'continue', created_at: 2 });
  const { context, page, calls } = await openPage({ token: null, seed: [a, c] });
  try {
    await nextFrame(page);
    await delay(200);
    assert.deepEqual(await pendingKeys(page), [a[0], c[0]].sort());
    assert.equal(calls.start.length + calls.continue.length, 0);
  } finally { await context.close(); }
});

test('17: a late u1 /start is not shown to u2; u1 sees the report in the list after signing in again', async () => {
  const g = gate();
  let current = U2;
  const { context, page, calls } = await openPage({
    verify: () => current,
    start: async () => { await g.wait(); return startOk('u1rep'); },
    history: auth => (auth === U1 ? [sess('u1rep')] : []),
  });
  try {
    await clickCategory(page, 'personality');
    await until(() => calls.start.length === 1, 'u1 /start');
    await logoutViaMenu(page);
    await loginAs(page, U2);
    const resp = page.waitForResponse(r => r.url().endsWith('/interpret/start'));
    g.open();
    await resp;
    await nextFrame(page);
    assert.doesNotMatch(await text(page, 'body'), /Rapor metni u1rep/);
    assert.equal(await page.evaluate(() => interpretSessionId), null);
    assert.equal(await page.$eval('#reportReadyToast', el => el.style.display), 'none');
    assert.deepEqual(await pendingKeys(page), []);
    await logoutViaMenu(page);
    current = U1;
    await loginAs(page, U1);
    await openReports(page);
    await page.waitForSelector('#reportsList .report-row[data-session-id="u1rep"]');
  } finally { await context.close(); }
});

test('extra: logout deletes the records of this tab', async () => {
  const { context, page, calls } = await openPage({ start: () => never() });
  try {
    await clickCategory(page, 'personality');
    await until(() => calls.start.length === 1, '/start');
    assert.equal((await pendingKeys(page)).length, 1);
    await logoutViaMenu(page);
    assert.deepEqual(await pendingKeys(page), []);
  } finally { await context.close(); }
});

test('extra: logging in again with the same account keeps the record and resumes it with the same id', async () => {
  const { context, page, calls } = await openPage({
    verify: () => U1, start: (b, n) => (n === 1 ? [401, {}] : startOk('S1')),
  });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('#authModalBackdrop', { state: 'visible' });
    const key = keyFor('u1', calls.start[0].body.request_id);
    await loginAs(page, U1);
    await until(() => calls.start.length === 2, 'resumed /start');
    assert.equal(calls.start[1].raw, calls.start[0].raw);
    await page.waitForFunction(k => sessionStorage.getItem(k) === null, key);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// 10. Refunded / failed results delete the record
// ---------------------------------------------------------------------------
for (const [error, msg] of [['request_failed', 'İstek tamamlanamadı, hakkın iade edildi.'], ['generation_expired', 'Yanıt süre sınırını aştı, hakkın iade edildi.']]) {
  test(`10 /start ${error}: message, record deleted, nothing resent after a reload`, async () => {
    const { context, page, calls, reload } = await openPage({ start: () => [409, { error, detail: 'x' }] });
    try {
      await clickCategory(page, 'personality');
      await page.waitForSelector(`.chat-bubble.error >> text=${msg}`);
      assert.equal(await count(page, '.pending-retry-btn'), 0, 'no automatic or offered retry of the same id');
      assert.deepEqual(await pendingKeys(page), []);
      await reload();
      await nextFrame(page);
      await delay(200);
      assert.equal(calls.start.length, 1);
    } finally { await context.close(); }
  });
}

test('10 /continue report_failed: question box closes, report stays readable, record deleted, nothing resent', async () => {
  const A = sess('A');
  const { context, page, calls, reload } = await openPage({
    chart: false, history: () => [A], cont: () => [409, { error: 'report_failed', detail: 'x' }],
  });
  try {
    await openReports(page);
    await page.click('#reportsList .report-row[data-session-id="A"]');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni A');
    await page.fill('#chatInput', 'Soru');
    await page.click('#chatSendBtn');
    await page.waitForSelector('.chat-bubble.error >> text=Bu rapor oluşturulamadı; soru sorulamaz.');
    assert.equal(await page.isDisabled('#chatInput'), true);
    assert.equal(await page.isDisabled('#chatSendBtn'), true);
    assert.ok(await count(page, '.chat-bubble.assistant >> text=Rapor metni A'));
    assert.equal(await count(page, '.ask-again-btn'), 0);
    assert.deepEqual(await pendingKeys(page), []);
    await reload();
    await nextFrame(page);
    await delay(200);
    assert.equal(calls.continue.length, 1);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// 13. A successful /start is never discarded
// ---------------------------------------------------------------------------
test('13: /start finishing after the user moved to My reports is processed: record deleted, "ready" notice', async () => {
  const g = gate();
  const { context, page, calls } = await openPage({ start: async () => { await g.wait(); return startOk('S9'); }, history: () => [] });
  try {
    await clickCategory(page, 'personality');
    await until(() => calls.start.length === 1, '/start');
    await openReports(page);
    const resp = page.waitForResponse(r => r.url().endsWith('/interpret/start'));
    g.open();
    await resp;
    await page.waitForSelector('#reportReadyToast', { state: 'visible' });
    assert.deepEqual(await pendingKeys(page), []);
    assert.equal(await page.locator('#reportsPanel').isVisible(), true, 'the open screen is not replaced');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// 18. Two requests, two keys; ordered resume, one at a time, 10 s apart
// ---------------------------------------------------------------------------
test('18: a /start and a /continue keep separate keys; after a reload they resume in order, one at a time, 10 s apart', async () => {
  const B = sess('B');
  const gResumedStart = gate();
  const { context, page, calls, reload } = await openPage({
    clock: true, history: () => [B],
    start: (b, n) => (n === 1 ? never() : gResumedStart.wait().then(() => startOk('S1'))),
    cont: (b, n) => (n === 1 ? never() : [200, { message: 'Cevap B', ...bal(0) }]),
  });
  try {
    await clickCategory(page, 'personality');
    await until(() => calls.start.length === 1, '/start');
    await openReports(page);
    await page.click('#reportsList .report-row[data-session-id="B"]');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni B');
    await page.fill('#chatInput', 'B sorusu');
    await page.click('#chatSendBtn');
    await until(() => calls.continue.length === 1, '/continue');
    const sId = calls.start[0].body.request_id, cId = calls.continue[0].body.request_id;
    assert.notEqual(sId, cId);
    assert.deepEqual(await pendingKeys(page), [keyFor('u1', sId), keyFor('u1', cId)].sort());
    assert.equal((await pendingRecord(page, keyFor('u1', sId))).body, calls.start[0].raw);
    assert.equal((await pendingRecord(page, keyFor('u1', cId))).body, calls.continue[0].raw);
    assert.equal(calls.continue[0].raw, JSON.stringify({ session_id: 'B', question: 'B sorusu', request_id: cId }));

    await reload();
    await until(() => calls.start.length === 2, 'resumed /start');
    assert.equal(calls.start[1].raw, calls.start[0].raw);
    await delay(300);
    assert.equal(calls.continue.length, 1, 'the /continue waits while the /start is on the network');
    gResumedStart.open();
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    await delay(200);
    assert.equal(calls.continue.length, 1, 'not before the 10 s gap');
    await page.clock.fastForward(10_000);
    await until(() => calls.continue.length === 2, 'resumed /continue');
    assert.equal(calls.continue[1].raw, calls.continue[0].raw);
    assert.ok(calls.continue[1].at - calls.start[1].at >= 10_000, 'at least 10 s between automatic sends');
    await page.waitForFunction(() => Object.keys(sessionStorage).every(k => !k.startsWith('stellafix_pending_interpret:')));
  } finally { await context.close(); }
});

test('extra: 4 records - 3 are resumed automatically (one at a time, >= 10 s apart), the 4th stays in the list', async () => {
  const seed = [1, 2, 3, 4].map(i => seedRecord('u1', `rid-${i}`, startBody(`rid-${i}`), { created_at: i }));
  let resumed = 0;
  const { context, page, calls, net } = await openPage({
    clock: true, chart: false, seed, start: b => { resumed += 1; return startOk(`S-${b.request_id}`); },
  });
  try {
    await until(() => calls.start.length === 1, 'first resume');
    await page.clock.fastForward(10_000);
    await until(() => calls.start.length === 2, 'second resume');
    await page.clock.fastForward(10_000);
    await until(() => calls.start.length === 3, 'third resume');
    await page.clock.fastForward(60_000);
    await delay(300);
    assert.equal(calls.start.length, 3, 'the 4th is not sent automatically');
    assert.deepEqual(calls.start.map(c => c.body.request_id), ['rid-1', 'rid-2', 'rid-3'], 'created_at order');
    assert.equal(net.max, 1, 'one request on the network at a time');
    for (let i = 1; i < 3; i++) assert.ok(calls.start[i].at - calls.start[i - 1].at >= 10_000);
    assert.deepEqual(await pendingKeys(page), [keyFor('u1', 'rid-4')]);
    await openReports(page);
    await page.waitForSelector('#pendingList .pending-item[data-request-id="rid-4"] .pending-resume');
    assert.equal(await page.locator('#pendingList .pending-item').count(), 1);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// 19. "Beklemeyi durdur"
// ---------------------------------------------------------------------------
test('19: after request_in_progress, "Beklemeyi durdur" keeps the record (paused), nothing is sent automatically, "Sürdür" resends the same id', async () => {
  const { context, page, calls } = await openPage({
    clock: true, start: (b, n) => (n === 1 ? [409, { error: 'request_in_progress', detail: 'x' }] : startOk('S1')),
  });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.pending-stop-btn');
    assert.match(await text(page, '#chatMessages'), /İsteğin hâlâ işleniyor\./);
    const key = keyFor('u1', calls.start[0].body.request_id);
    await page.click('.pending-stop-btn');
    await page.waitForSelector('.chat-bubble.notice >> text=İstek sunucuda işlenmiş olabilir; rapor geçmişte görünebilir.');
    assert.equal((await pendingRecord(page, key)).paused, true);
    await page.clock.fastForward(400_000);
    await delay(200);
    assert.equal(calls.start.length, 1, 'no automatic request');
    await openReports(page);
    const row = `#pendingList .pending-item[data-request-id="${calls.start[0].body.request_id}"]`;
    await page.waitForSelector(row);
    assert.match(await text(page, row), /Yarım kalan istek: Kişilik/);
    await page.click(`${row} .pending-resume`);
    await until(() => calls.start.length === 2, 'resumed /start');
    assert.equal(calls.start[1].raw, calls.start[0].raw);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.deepEqual(await pendingKeys(page), []);
  } finally { await context.close(); }
});

test('19b: "Beklemeyi durdur" while /start is on the network aborts it and keeps the record', async () => {
  const { context, page, calls, net } = await openPage({ start: (b, n) => (n === 1 ? never() : startOk('S1')) });
  try {
    await clickCategory(page, 'personality');
    await until(() => calls.start.length === 1, '/start');
    await page.waitForSelector('#chatStopBtn', { state: 'visible' });
    await page.click('#chatStopBtn');
    await page.waitForSelector('.chat-bubble.notice >> text=İstek sunucuda işlenmiş olabilir; rapor geçmişte görünebilir.');
    await until(() => net.failedStart === 1, 'aborted /start');
    const key = keyFor('u1', calls.start[0].body.request_id);
    assert.equal((await pendingRecord(page, key)).paused, true);
    await page.click('.pending-resume-btn');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(calls.start[1].raw, calls.start[0].raw);
  } finally { await context.close(); }
});

test('extra: the stop-waiting texts promise no cancellation or refund', async () => {
  const { context, page } = await openPage({ chart: false });
  try {
    for (const loc of ['tr', 'en']) {
      const texts = await page.evaluate(l => [I18N[l].btnStopWaiting, I18N[l].stopWaitingNote], loc);
      for (const s of texts) assert.doesNotMatch(s, /iptal|iade|cancel|refund|geri al/i, s);
    }
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// 20. A failed question is asked again in the same report with a new id
// ---------------------------------------------------------------------------
for (const [label, failure, msg] of [
  ['request_failed', [409, { error: 'request_failed', detail: 'x' }], 'Soru yanıtlanamadı, hakkın iade edildi.'],
  ['generation_expired', [409, { error: 'generation_expired', detail: 'x' }], 'Yanıt süre sınırını aştı, hakkın iade edildi.'],
  ['402 question', [402, { error: 'insufficient_credits', credit_type: 'question', detail: 'x' }], null],
]) {
  test(`20 ${label}: "Tekrar sor" reads the balance, then sends /continue with the same session and a new request_id; no quote, no /start`, async () => {
    const A = sess('A');
    const { context, page, calls } = await openPage({
      chart: false, history: () => [A], cont: (b, n) => (n === 1 ? failure : [200, { message: 'Cevap 2', ...bal(0) }]),
    });
    try {
      await openReports(page);
      await page.click('#reportsList .report-row[data-session-id="A"]');
      await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni A');
      await page.fill('#chatInput', 'Soru 1');
      await page.click('#chatSendBtn');
      await page.waitForSelector('.ask-again-btn');
      if (msg) assert.match(await text(page, '#chatMessages'), new RegExp(msg));
      assert.deepEqual(await pendingKeys(page), []);
      const before = calls.log.length;
      await page.click('.ask-again-btn');
      await page.waitForSelector('.chat-bubble.assistant >> text=Cevap 2');
      const after = calls.log.slice(before);
      assert.equal(after[after.length - 1], 'continue');
      assert.ok(after.indexOf('balance:A') !== -1 && after.indexOf('balance:A') < after.indexOf('continue'), `balance first: ${after}`);
      assert.equal(calls.continue.length, 2);
      const [c1, c2] = calls.continue.map(c => c.body);
      assert.equal(c2.session_id, 'A');
      assert.equal(c2.question, 'Soru 1');
      assert.notEqual(c2.request_id, c1.request_id);
      assert.equal(calls.quote.length, 0);
      assert.equal(calls.start.length, 0);
    } finally { await context.close(); }
  });
}

// ---------------------------------------------------------------------------
// 21. Timeouts
// ---------------------------------------------------------------------------
test('21: a hung /start is aborted at 180 s and kept; a retry uses the rest of the 330 s window; nothing is sent after it; a retry after expiry resends the same id and bytes', async () => {
  const { context, page, calls, net } = await openPage({ clock: true, start: () => never() });
  try {
    await clickCategory(page, 'personality');
    await until(() => calls.start.length === 1, '/start');
    await page.clock.fastForward(179_000);
    await delay(100);
    assert.equal(net.failedStart, 0, 'not aborted before 180 s');
    await page.clock.fastForward(1_000);
    await until(() => net.failedStart === 1, 'abort at 180 s');
    await page.waitForSelector('.pending-retry-btn');
    const key = keyFor('u1', calls.start[0].body.request_id);
    assert.deepEqual(await pendingKeys(page), [key], 'kept after the abort');

    await page.click('.pending-retry-btn');
    await until(() => calls.start.length === 2, 'manual retry');
    assert.equal(calls.start[1].raw, calls.start[0].raw);
    await page.clock.fastForward(149_000);
    await delay(100);
    assert.equal(net.failedStart, 1, 'still waiting inside the window');
    await page.clock.fastForward(2_000);
    await until(() => net.failedStart === 2, 'abort at the 330 s limit');

    await page.clock.fastForward(900_000);
    await delay(300);
    assert.equal(calls.start.length, 2, 'no automatic request after the window');
    assert.deepEqual(await pendingKeys(page), [key]);

    await page.locator('.pending-retry-btn').last().click();
    await until(() => calls.start.length === 3, 'retry after expiry');
    assert.equal(calls.start[2].raw, calls.start[0].raw);
  } finally { await context.close(); }
});

test('21: a hung quote is aborted at 20 s, offers "Tekrar dene" and creates no record', async () => {
  const { context, page, calls } = await openPage({ clock: true, quote: () => never() });
  try {
    await clickCategory(page, 'personality');
    await until(() => calls.quote.length === 1, 'quote');
    await page.clock.fastForward(19_000);
    await delay(100);
    assert.equal(await count(page, '.quote-retry-btn'), 0);
    await page.clock.fastForward(1_000);
    await page.waitForSelector('.quote-retry-btn');
    assert.deepEqual(await pendingKeys(page), []);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// E. A quote check never starts a generation by itself
// ---------------------------------------------------------------------------
for (const [label, second, credits, expect] of [
  ['subscription', Q.sub, 3, { button: 'Aboneliğin kapsamında üret', spend: 'subscription' }],
  ['report_credit', Q.credit, 2, { button: '1 rapor hakkı kullanarak üret', spend: 'report_credit' }],
]) {
  test(`E: 409 -> "Tekrar kontrol et" -> ${label}: a priced button; nothing is sent until it is pressed`, async () => {
    const { context, page, calls } = await openPage({
      quote: (b, n) => (n === 1 ? Q.err(409, 'generation_in_progress')() : second()), credits: () => ({ report_credits: credits }),
    });
    try {
      await page.waitForFunction(c => creditBalance && creditBalance.report_credits === c, credits);
      await clickCategory(page, 'personality');
      await page.click('.quote-check-btn');
      await page.waitForSelector('.quote-generate-btn');
      assert.equal(await text(page, '.quote-generate-btn'), expect.button);
      assert.equal(await count(page, '.quote-confirm-btn'), 0, 'no second confirmation screen');
      await delay(200);
      assert.equal(calls.start.length, 0);
      await page.click('.quote-generate-btn');
      await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
      assert.equal(calls.start.length, 1);
      assert.equal(calls.start[0].raw, JSON.stringify(startBody(calls.start[0].body.request_id, 'personality', expect.spend)));
    } finally { await context.close(); }
  });
}

test('E: 409 -> "Tekrar kontrol et" -> report_credit with 0 credits: "Rapor hakkın yok" and Subscribe, no button', async () => {
  const { context, page, calls } = await openPage({
    quote: (b, n) => (n === 1 ? Q.err(409, 'generation_in_progress')() : Q.credit()), credits: () => ({ report_credits: 0 }),
  });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.report_credits === 0);
    await clickCategory(page, 'personality');
    await page.click('.quote-check-btn');
    await page.waitForSelector('.chat-bubble.notice >> text=Rapor hakkın yok.');
    assert.equal(await count(page, '.quote-generate-btn'), 0);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

test('E: 409 -> "Tekrar kontrol et" -> none opens the report; again 409 keeps waiting; another 409 shows no Üret button', async () => {
  const seq = [Q.err(409, 'generation_in_progress'), Q.err(409, 'generation_in_progress'), Q.none('saved7')];
  const { context, page, calls } = await openPage({ quote: (b, n) => seq[n - 1]() });
  try {
    await clickCategory(page, 'personality');
    await page.click('.quote-check-btn');
    await page.waitForFunction(() => document.querySelectorAll('.quote-check-btn').length === 2);
    assert.match(await page.locator('.chat-bubble.notice').last().textContent(), /Bu rapor şu anda hazırlanıyor\./);
    await page.locator('.quote-check-btn').last().click();
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni saved7');
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
  const r2 = await openPage({ quote: (b, n) => (n === 1 ? Q.err(409, 'generation_in_progress')() : Q.err(409, 'request_id_conflict')()) });
  try {
    await clickCategory(r2.page, 'personality');
    await r2.page.click('.quote-check-btn');
    await r2.page.waitForSelector('.chat-bubble.error >> text=Bir şeyler ters gitti, tekrar dene.');
    assert.equal(await count(r2.page, '.quote-generate-btn'), 0);
    assert.equal(r2.calls.start.length, 0);
  } finally { await r2.context.close(); }
});

// ---------------------------------------------------------------------------
// Flow guards and the flight lock
// ---------------------------------------------------------------------------
test('extra: a stale quote is dropped - the confirm screen does not open after the category changed', async () => {
  const g = gate();
  const { context, page, calls } = await openPage({
    quote: async b => { if (b.category === 'career') { await g.wait(); return Q.credit(); } return Q.none('saved-p')(); },
  });
  try {
    await clickCategory(page, 'career');
    await until(() => calls.quote.length === 1, 'career quote');
    await page.click('#chatBackBtn');
    await clickCategory(page, 'personality');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni saved-p');
    const resp = page.waitForResponse(r => r.url().endsWith('/interpret/quote'));
    g.open();
    await resp;
    await nextFrame(page);
    assert.equal(await count(page, '.quote-confirm-btn'), 0);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

test('extra: no /start from the confirm screen after leaving it or changing the category', async () => {
  const { context, page, calls } = await openPage({ quote: Q.credit, credits: () => ({ report_credits: 2 }) });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.report_credits === 2);
    await clickCategory(page, 'personality');
    const btn = await page.waitForSelector('.quote-confirm-btn');
    await page.click('#chatBackBtn');           // leaves the screen (chat stays in the DOM, hidden)
    await btn.evaluate(b => b.click());
    await clickCategory(page, 'career');        // a new screen; the old button is detached
    await page.waitForSelector('.quote-confirm-btn');
    await btn.evaluate(b => b.click());
    await delay(200);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

test('extra: flight lock - "Sürdür" during an auto-resume and a double "Tekrar dene" never put a second request for the same id on the network', async () => {
  const g = gate();
  const seed = [seedRecord('u1', 'rid-1', startBody('rid-1'))];
  const { context, page, calls, net } = await openPage({
    chart: false, seed, start: async () => { await g.wait(); return [409, { error: 'request_in_progress', detail: 'x' }]; },
  });
  try {
    await until(() => calls.start.length === 1, 'auto-resume');
    await openReports(page);
    const resumeBtn = '#pendingList .pending-item[data-request-id="rid-1"] .pending-resume';
    await page.waitForSelector(resumeBtn);
    assert.equal(await page.isDisabled(resumeBtn), true, 'looks disabled while on the network');
    await page.$eval(resumeBtn, b => { b.disabled = false; b.click(); });
    await delay(200);
    assert.equal(calls.start.length, 1);
    g.open();
    await page.waitForFunction(() => !document.querySelector('#pendingList .pending-resume')?.disabled);
    assert.equal(calls.start.length, 1);
    assert.equal(net.max, 1);
  } finally { await context.close(); }

  const g2 = gate();
  const r2 = await openPage({ start: (b, n) => (n === 1 ? 'abort' : g2.wait().then(() => startOk('S1'))) });
  try {
    await clickCategory(r2.page, 'personality');
    await r2.page.waitForSelector('.pending-retry-btn');
    await r2.page.$eval('.pending-retry-btn', b => { b.click(); b.disabled = false; b.click(); });
    await until(() => r2.calls.start.length === 2, 'retry');
    await delay(200);
    assert.equal(r2.calls.start.length, 2, 'one retry on the network');
    g2.open();
    await r2.page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(r2.calls.start.length, 2);
  } finally { await r2.context.close(); }
});
