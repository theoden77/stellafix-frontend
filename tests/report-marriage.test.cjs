// Browser integration test for the "Evlilik" (marriage) category: the card,
// the time zone in the quote, the quote branches, "My reports" and
// "Yeniden üret". The API is mocked with page.route; no real backend is
// called. Run: npm test
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness, API, json, TEST_TIMEOUT_MS, HOOK_TIMEOUT_MS, closeOpenContexts } = require('./helpers/harness.cjs');
const {
  useHarness, UUID, delay, until, Q, startOk, bal, sess, openPage, clickCategory, text, count, openReports, nextFrame,
} = require('./helpers/interpret-page.cjs');

let h;
before(async () => { h = await startHarness(); useHarness(h); }, { timeout: HOOK_TIMEOUT_MS });
afterEach(async () => { await closeOpenContexts(h?.browser); }, { timeout: HOOK_TIMEOUT_MS });
after(async () => { await h?.close(); }, { timeout: HOOK_TIMEOUT_MS });

const CARD = `button.category-card[onclick="selectCategory('marriage')"]`;
const TEXTS = {
  tr: { title: 'Evlilik', desc: 'Önümüzdeki 12 ayda evlilik ve birliktelik temaları', group: 'Kişilik & Yaşam',
    target: 'Bugünden başlayan 12 aylık dönem için yeni rapor' },
  en: { title: 'Marriage', desc: 'Marriage and partnership themes over the next 12 months', group: 'Personality & Life',
    target: 'A new report for the 12-month period starting today' },
};
const PERIOD = { category: 'marriage', period_type: 'next_12_months', timezone: 'Europe/Istanbul',
  period_start_utc: '2026-10-14T21:00:00+00:00', period_end_utc: '2027-10-14T21:00:00+00:00' };
const msgsOf = id => [{ role: 'assistant', content: `Rapor metni ${id}`, created_at: '2026-10-10T09:30:00+00:00' }];
const detailFrom = list => id => {
  const s = list.find(x => x.session_id === id);
  return s ? { ...s, messages: msgsOf(id) } : [404, { detail: 'x' }];
};
function breakTz() {
  const orig = Intl.DateTimeFormat.prototype.resolvedOptions;
  Intl.DateTimeFormat.prototype.resolvedOptions = function () { return { ...orig.call(this), timeZone: undefined }; };
}
async function pickBerlin(page) {
  await page.waitForSelector('#tzCountryInput');
  await page.fill('#tzCountryInput', 'Almanya');
  await page.click('#tzCountryDropdown .city-option');
  await page.waitForSelector('#tzCityInput', { state: 'visible' });
  await page.fill('#tzCityInput', 'Berlin');
  await page.click('#tzCityDropdown .city-option');
}
async function settle(page) { await nextFrame(page); await delay(150); await nextFrame(page); }
const rowSel = id => `#reportsList .report-row[data-session-id="${id}"]`;
async function openRow(page, id) {
  await openReports(page);
  await page.click(rowSel(id));
  await page.waitForSelector(`.chat-bubble.assistant >> text=Rapor metni ${id}`);
}
// Forces the question box open and calls sendFollowUp, as a user could not.
const forceSend = page => page.evaluate(() => {
  const i = document.getElementById('chatInput'); i.disabled = false; i.value = 'Bir sorum var'; return sendFollowUp();
});

// ---------------------------------------------------------------------------
// a. Card
// ---------------------------------------------------------------------------
test('a card: in the life group with the TR and EN title and description; never locked', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await openPage({ subscribed: false });
  try {
    for (const locale of ['tr', 'en']) {
      await page.evaluate(l => setLocale(l), locale);
      const card = page.locator(CARD);
      assert.equal(await card.count(), 1, `${locale}: one card`);
      assert.equal(await card.locator('.category-card-title').textContent(), TEXTS[locale].title);
      assert.equal(await card.locator('.category-card-desc').textContent(), TEXTS[locale].desc);
      const group = await card.evaluate(el => el.closest('.category-group').querySelector('.category-group-label').textContent);
      assert.equal(group, TEXTS[locale].group, `${locale}: life group`);
      const order = await page.$$eval('.category-card', els => els.map(e => e.getAttribute('onclick')));
      assert.equal(order.indexOf(`selectCategory('marriage')`), order.indexOf(`selectCategory('finance')`) + 1, 'right after finance');
      assert.equal(await card.locator('.category-lock-icon').count(), 0, `${locale}: no lock icon`);
      assert.equal(await card.evaluate(el => el.classList.contains('locked')), false, `${locale}: not locked`);
    }
    // Before the balance is known (logged-out grid included) it is not locked either.
    assert.equal(await page.evaluate(() => { creditBalance = null; return isCategoryLocked('marriage'); }), false);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// b. Time zone
// ---------------------------------------------------------------------------
test('b time zone: the browser zone is sent; the quote body is exactly {chart_id, category, language, timezone}', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ timezoneId: 'Asia/Tokyo', quote: Q.sub, start: () => startOk('M1') });
  try {
    await clickCategory(page, 'marriage');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni M1');
    assert.equal(calls.quote.length, 1);
    assert.deepEqual(calls.quote[0].body, { chart_id: 'chart-1', category: 'marriage', language: 'tr', timezone: 'Asia/Tokyo' });
  } finally { await context.close(); }
});

test('b time zone: none available -> the picker opens and no quote is sent; picking a city sends the quote', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ afterClock: breakTz, quote: Q.sub, start: () => startOk('M1') });
  try {
    await page.route(`${API}/api/v1/timezone**`, r => json(r, 200, { timezone: 'Europe/Berlin' }));
    await clickCategory(page, 'marriage');
    await page.waitForSelector('#tzPickerPanel');
    await settle(page);
    assert.equal(calls.quote.length, 0, 'no quote without a time zone');
    assert.equal(calls.start.length, 0);
    await pickBerlin(page);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni M1');
    assert.equal(calls.quote.length, 1);
    assert.deepEqual(calls.quote[0].body, { chart_id: 'chart-1', category: 'marriage', language: 'tr', timezone: 'Europe/Berlin' });
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// c-e. Quote branches
// ---------------------------------------------------------------------------
test('c quote "none": the saved report opens, no /start', { timeout: TEST_TIMEOUT_MS }, async () => {
  const det = { ...sess('saved-m', PERIOD), messages: msgsOf('saved-m') };
  const { context, page, calls } = await openPage({ quote: Q.none('saved-m'), detail: () => det });
  try {
    await clickCategory(page, 'marriage');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni saved-m');
    assert.equal(await text(page, '#chatCategoryTitle'), 'Evlilik');
    assert.deepEqual(calls.detail, ['saved-m']);
    await settle(page);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

test('d quote "subscription": /start without a confirm, with timezone, request_id and expected_spend "subscription"', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ quote: Q.sub, start: () => startOk('M1') });
  try {
    await clickCategory(page, 'marriage');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni M1');
    assert.equal(await count(page, '.quote-confirm-btn'), 0, 'no confirm');
    assert.equal(calls.start.length, 1);
    const b = calls.start[0].body;
    assert.deepEqual(Object.keys(b).sort(), ['category', 'chart_id', 'expected_spend', 'language', 'request_id', 'timezone']);
    assert.equal(b.category, 'marriage');
    assert.equal(b.timezone, 'Europe/Istanbul');
    assert.match(b.request_id, UUID);
    assert.equal(b.expected_spend, 'subscription');
  } finally { await context.close(); }
});

test('e quote "report_credit": the confirm screen; /start only after the confirm, with expected_spend "report_credit"', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ quote: Q.credit, credits: () => ({ report_credits: 2 }), start: () => startOk('M1') });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.report_credits === 2);
    await clickCategory(page, 'marriage');
    await page.waitForSelector('.quote-confirm-btn');
    const bubble = await text(page, '.chat-bubble.notice');
    assert.match(bubble, /1 rapor hakkı kullanılacak\./);
    assert.match(bubble, /Kalan rapor hakkın: 2/);
    await settle(page);
    assert.equal(calls.start.length, 0, 'no /start before the confirm');
    await page.click('.quote-confirm-btn');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni M1');
    assert.equal(calls.start.length, 1);
    const b = calls.start[0].body;
    assert.equal(b.expected_spend, 'report_credit');
    assert.equal(b.timezone, 'Europe/Istanbul');
    assert.match(b.request_id, UUID);
  } finally { await context.close(); }
});

test('e quote "report_credit" with no credits: "Rapor hakkın yok" and Subscribe, no confirm, no /start', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ quote: Q.credit, credits: () => ({ report_credits: 0 }) });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.report_credits === 0);
    await clickCategory(page, 'marriage');
    await page.waitForSelector('.chat-bubble.notice >> text=Rapor hakkın yok.');
    assert.equal(await count(page, '.quote-confirm-btn'), 0);
    assert.equal(await text(page, '.chat-bubble.notice .chat-bubble-action'), 'Abone Ol');
    await settle(page);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// f. My reports
// ---------------------------------------------------------------------------
test('f My reports: the marriage row shows "Evlilik" and its period; with question rights the question goes by /continue', { timeout: TEST_TIMEOUT_MS }, async () => {
  const list = [sess('mr', PERIOD)];
  const { context, page, calls } = await openPage({
    chart: false, history: (a, off) => (off ? [] : list), detail: detailFrom(list), balance: () => bal(1, 2),
    cont: () => [200, { message: 'Evlilik cevabı', ...bal(0, 2) }],
  });
  try {
    await openReports(page);
    await page.waitForSelector(rowSel('mr'));
    assert.equal(await text(page, `${rowSel('mr')} .report-row-title`), 'Evlilik');
    const day = (y, m, d) => page.evaluate(([y, m, d]) => new Intl.DateTimeFormat('tr-TR',
      { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d, 12))), [y, m, d]);
    assert.equal(await text(page, `${rowSel('mr')} .report-row-period`), `Dönem: ${await day(2026, 10, 15)} – ${await day(2027, 10, 14)}`);
    await page.click(rowSel('mr'));
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni mr');
    assert.equal(await text(page, '#chatCategoryTitle'), 'Evlilik');
    await page.waitForFunction(() => !document.getElementById('chatInput').disabled);
    await page.fill('#chatInput', 'Bir sorum var');
    await page.click('#chatSendBtn');
    await page.waitForSelector('.chat-bubble.assistant >> text=Evlilik cevabı');
    assert.equal(calls.continue.length, 1);
    const { request_id, ...rest } = calls.continue[0].body;
    assert.deepEqual(rest, { session_id: 'mr', question: 'Bir sorum var' });
    assert.match(request_id, UUID);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

for (const [name, src, balance, check] of [
  ['no question rights (free 0, credits 0, no subscription): the box is closed', {}, () => bal(0, 0),
    async page => { assert.equal(await text(page, '#chatRemaining'), 'Bu rapor için soru hakkın doldu.'); }],
  ['/balance fails: the box is closed and "Tekrar dene" shows', {}, () => [500, {}],
    async page => {
      await page.waitForSelector('#balanceError', { state: 'visible' });
      assert.equal(await page.isVisible('#balanceRetryBtn'), true);
      assert.equal(await text(page, '#balanceRetryBtn'), 'Tekrar dene');
    }],
  ['a pending report is read-only', { status: 'pending' }, () => bal(1, 2),
    async page => { await page.waitForSelector('.chat-bubble.notice >> text=hâlâ hazırlanıyor'); }],
]) {
  test(`f My reports, marriage does not lift the locks: ${name}; no /continue`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const s = sess('mr', { ...PERIOD, ...src });
    const list = [s];
    const det = id => (id === 'mr' ? { ...s, messages: s.status === 'pending' ? [] : msgsOf('mr') } : [404, { detail: 'x' }]);
    const { context, page, calls } = await openPage({ chart: false, subscribed: false, history: (a, off) => (off ? [] : list), detail: det, balance });
    try {
      await openReports(page);
      await page.click(rowSel('mr'));
      await page.waitForSelector('#chatPanel', { state: 'visible' });
      if (s.status !== 'pending') await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni mr');
      await check(page);
      await settle(page);
      assert.equal(await page.isDisabled('#chatInput'), true, 'question box closed');
      assert.equal(await page.isDisabled('#chatSendBtn'), true);
      await forceSend(page);
      await settle(page);
      assert.equal(calls.continue.length, 0, 'no /continue');
      assert.equal(calls.start.length, 0);
    } finally { await context.close(); }
  });
}

// ---------------------------------------------------------------------------
// g. Yeniden üret
// ---------------------------------------------------------------------------
// Every test first generates a marriage report by a category click (request
// R0, session M0), so there is an earlier request whose id the new one must
// not reuse. Branch (i) regenerates M0 itself; branch (ii) opens an older
// marriage report (SRC) from My reports.
const SRC = 'old-marriage';
async function regenSetup(quote, { others = [] } = {}) {
  const list = [sess(SRC, { ...PERIOD, period_start_utc: '2025-10-14T21:00:00+00:00', period_end_utc: '2026-10-14T21:00:00+00:00' }), ...others];
  const r = await openPage({
    quote, history: (a, off) => (off ? [] : list), detail: detailFrom(list),
    start: (b, n) => startOk(n === 1 ? 'M0' : 'NEW'),
  });
  await clickCategory(r.page, 'marriage');
  await r.page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni M0');
  assert.equal(r.calls.start.length, 1);
  return { ...r, r0: r.calls.start[0].body.request_id };
}
const confirmBubble = page => page.locator('.chat-bubble:has(.regen-confirm-btn)').last().textContent();
async function confirmAndCheck({ page, calls, r0 }, spend, forced) {
  await page.waitForSelector('.regen-confirm-btn');
  const shown = await confirmBubble(page);
  assert.ok(shown.includes(TEXTS.tr.target), shown);
  assert.ok(shown.includes(spend === 'subscription' ? 'Aboneliğin kapsamında (ek ücret yok)' : '1 rapor hakkı kullanılacak.'), shown);
  await settle(page);
  assert.equal(calls.start.length, 1, 'no /start while the confirm is on screen');
  await page.click('.regen-confirm-btn');
  await until(() => calls.start.length === 2, 'the regen /start');
  const b = calls.start[1].body;
  assert.match(b.request_id, UUID);
  assert.notEqual(b.request_id, r0, 'a new request_id, not the earlier request\'s');
  assert.ok(![SRC, 'M0'].includes(b.request_id), 'not the open report\'s id');
  assert.equal(b.expected_spend, spend, 'the price the quote returned');
  assert.equal(b.category, 'marriage');
  assert.equal(b.timezone, 'Europe/Istanbul');
  assert.equal(b.force_regenerate === true, forced, 'force_regenerate');
  if (!forced) assert.equal('force_regenerate' in b, false);
  await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni NEW');
}

for (const [spend, priced] of [['subscription', Q.sub], ['report_credit', Q.credit]]) {
  test(`g (i) today's live report, ${spend}: forced quote, the 12-month target text, /start with force_regenerate and timezone`, { timeout: TEST_TIMEOUT_MS }, async () => {
    // 1: category click; 2: regen step (a) says the open report is today's target; 3: forced quote.
    const quote = (b, n) => (n === 1 ? Q.sub() : n === 2 ? Q.none('M0')() : priced());
    const r = await regenSetup(quote);
    try {
      await r.page.click('#regenBtn');
      await r.page.waitForSelector('.regen-confirm-btn');
      assert.equal(r.calls.quote.length, 3);
      assert.equal('force_regenerate' in r.calls.quote[1].body, false, 'step (a) unforced');
      assert.equal(r.calls.quote[2].body.force_regenerate, true, 'forced quote');
      assert.equal(r.calls.quote[2].body.timezone, 'Europe/Istanbul');
      await confirmAndCheck(r, spend, true);
    } finally { await r.context.close(); }
  });

  test(`g (ii) an older-period report, ${spend}: unforced confirm with the same target text, /start without force_regenerate`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const quote = (b, n) => (n === 1 ? Q.sub() : priced());
    const r = await regenSetup(quote);
    try {
      await r.page.click('#chatBackBtn');
      await openRow(r.page, SRC);
      await r.page.click('#regenBtn');
      await r.page.waitForSelector('.regen-confirm-btn');
      assert.equal(r.calls.quote.length, 2, 'no forced quote');
      assert.equal('force_regenerate' in r.calls.quote[1].body, false);
      await confirmAndCheck(r, spend, false);
    } finally { await r.context.close(); }
  });
}

test('g (ii) an older-period report, quote "none" for another session: no production, "Raporu aç" opens it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const quote = (b, n) => (n === 1 ? Q.sub() : Q.none('M0')());
  const r = await regenSetup(quote, { others: [sess('M0', PERIOD)] });
  try {
    await r.page.click('#chatBackBtn');
    await openRow(r.page, SRC);
    await r.page.click('#regenBtn');
    await r.page.waitForSelector('.regen-open-btn');
    await settle(r.page);
    assert.equal(r.calls.quote.length, 2, 'no forced quote');
    assert.equal(await count(r.page, '.regen-confirm-btn'), 0);
    assert.equal(r.calls.start.length, 1, 'no production');
    await r.page.click('.regen-open-btn');
    await r.page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni M0');
    assert.equal(r.calls.start.length, 1);
  } finally { await r.context.close(); }
});
