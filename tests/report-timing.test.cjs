// Browser integration test for the "Zamanlama" (timing) category: the form
// opened before any quote, the action place (birth place by default, always
// sent as location), client checks, quote -> price/confirm -> /start, the
// four timing 422s, resume of an uncertain request, midnight cases, "Bu
// ayarlarla yeni tarama", My reports and late responses. The API is mocked
// with page.route; no real backend is called. Run: npm test
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness, API, json, TEST_TIMEOUT_MS, HOOK_TIMEOUT_MS, closeOpenContexts } = require('./helpers/harness.cjs');
const {
  useHarness, U1, U2, UUID, delay, gate, until, Q, startOk, bal, sess, openPage, text, count, openReports, nextFrame,
  seedRecord, pendingKeys, pendingRecord, keyFor, logoutViaMenu, loginAs,
} = require('./helpers/interpret-page.cjs');

let h;
before(async () => { h = await startHarness(); useHarness(h); }, { timeout: HOOK_TIMEOUT_MS });
afterEach(async () => { await closeOpenContexts(h?.browser); }, { timeout: HOOK_TIMEOUT_MS });
after(async () => { await h?.close(); }, { timeout: HOOK_TIMEOUT_MS });

// Birth place sent to /natal: many decimals, so a rounded value would show.
const BIRTH = { name: 'Istanbul', lat: 41.0138429, lon: 28.9496605, label: 'Istanbul, Türkiye' };
const BERLIN = { lat: 52.5244, lon: 13.4105 }, MUNICH = { lat: 48.1374, lon: 11.5755 };
const natalResp = id => ({
  chart_id: id, asc: 120, asc_sign: 'Leo', mc: 30, cusps: Array.from({ length: 12 }, (_, i) => (120 + i * 30) % 360),
  houses: Array.from({ length: 12 }, (_, i) => ({ house: i + 1, sign_index: (4 + i) % 12, cusp: (120 + i * 30) % 360 })),
  planets: [
    { key: 'sun', name: 'Gunes', lon: 359.7, sign_index: 11, degree_fmt: "29°43'", dignity: ['peregrine'], dignity_score: 0, retrograde: false, house: 9 },
    { key: 'moon', name: 'Ay', lon: 7.7, sign_index: 0, degree_fmt: "07°42'", dignity: ['peregrine'], dignity_score: 0, retrograde: false, house: 9 },
  ],
});
// Calculates the chart through the birth form's /natal request (mocked).
async function computeChart(page, place = BIRTH) {
  return page.evaluate(p => {
    selectedCity = { name: p.name, countryCode: 'TR', region: '', lat: p.lat, lon: p.lon, tz: 'Europe/Istanbul' };
    document.getElementById('birthDate').value = '1990-01-01';
    document.getElementById('birthTime').value = '12:00';
    return calculateChart();
  }, place);
}
// openPage + a chart from /natal (chart-1, BIRTH).
async function ready(opts = {}) {
  const r = await openPage({ chart: false, ...opts });
  await r.page.route(`${API}/natal**`, route => json(route, 200, natalResp('chart-1')));
  await computeChart(r.page);
  await r.page.waitForFunction(() => lastChartId === 'chart-1');
  return r;
}
const CARD = `button.category-card[onclick="selectCategory('timing')"]`;
async function openForm(page) {
  await page.click(CARD);
  await page.waitForSelector('#timingFormPanel');
}
const RANGE = { action: 'contract_signing', start: '2026-11-02', end: '2026-11-15' };
async function fill(page, v = RANGE) {
  if (v.action) await page.selectOption('#timingAction', v.action);
  if (v.start !== undefined) await page.fill('#timingStart', v.start);
  if (v.end !== undefined) await page.fill('#timingEnd', v.end);
}
const submit = page => page.click('#timingSubmitBtn');
const submitDisabled = page => page.isDisabled('#timingSubmitBtn');
const formValues = page => page.evaluate(() => ({
  action: document.getElementById('timingAction').value,
  start: document.getElementById('timingStart').value,
  end: document.getElementById('timingEnd').value,
  place: document.getElementById('timingPlaceText').textContent,
}));
const BODY = (over = {}) => ({
  chart_id: 'chart-1', category: 'timing', language: 'tr', action_type: RANGE.action,
  date_range_start: RANGE.start, date_range_end: RANGE.end, location: { latitude: BIRTH.lat, longitude: BIRTH.lon }, ...over,
});
const t422 = (type, field) => [422, { detail: [{ type, loc: ['body', field], msg: 'raw backend text' }] }];
const ERRORS = [
  ['timing_date_in_past', 'date_range_start', 'Başlangıç tarihi, eylemin yapılacağı yerde geçmişte kaldı. Yeni bir başlangıç tarihi seç.', 'start'],
  ['timing_no_candidates', 'date_range_start', 'Bu aralıkta taranacak saat kalmadı. Yeni tarihler seç.', null],
  ['timing_range_too_long', 'date_range_end', 'Aralık 90 günü aşıyor.', null],
  ['timing_timezone_unknown', 'location', 'Bu yerin saat dilimi belirlenemedi. Başka bir yer seç.', 'place'],
];
const FORM_VALUES = { action: RANGE.action, start: RANGE.start, end: RANGE.end, place: `${BIRTH.label} (41.01, 28.95)` };
async function settle(page) { await nextFrame(page); await delay(150); await nextFrame(page); }
async function pickCity(page, country, city) {
  await page.click('#timingPlaceChange');
  await page.fill('#tzCountryInput', country);
  await page.click('#tzCountryDropdown .city-option');
  await page.waitForSelector('#tzCityInput', { state: 'visible' });
  await page.fill('#tzCityInput', city);
  await page.click('#tzCityDropdown .city-option');
}
const formError = page => text(page, '#timingFormError');
const noteRows = page => page.$$eval('#pendingNotes .pending-note', els => els.map(e => e.textContent));
// A saved timing report (My reports / detail).
const TOKYO = { latitude: 35.6895123, longitude: 139.6917456 };
const timingSess = (id, timing = {}, more = {}) => sess(id, {
  category: 'timing', timing: { action_type: 'travel', date_range_start: '2026-11-02', date_range_end: '2026-11-10', location: TOKYO, timezone: 'Asia/Tokyo', ...timing }, ...more,
});
const msgsOf = id => [{ role: 'assistant', content: `Rapor metni ${id}`, created_at: '2026-10-10T09:30:00+00:00' }];
const detailFrom = list => id => {
  const s = list.find(x => x.session_id === id);
  return s ? { ...s, messages: msgsOf(id) } : [404, { detail: 'x' }];
};
const rowSel = id => `#reportsList .report-row[data-session-id="${id}"]`;
async function openRow(page, id) {
  await openReports(page);
  await page.click(rowSel(id));
  await page.waitForSelector(`.chat-bubble.assistant >> text=Rapor metni ${id}`);
}
const day = (page, y, m, d) => page.evaluate(([y, m, d]) => new Intl.DateTimeFormat('tr-TR',
  { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d, 12))), [y, m, d]);

// ---------------------------------------------------------------------------
// Card and form
// ---------------------------------------------------------------------------
test('card: in "Özel" next to the eclipse card, with ⏳ and the TR/EN texts; a click opens the form, no quote', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await ready();
  try {
    for (const [locale, title, desc, group] of [['tr', 'Zamanlama', 'Önemli bir adım için uygun saatler', 'Özel'], ['en', 'Timing', 'Favourable times for an important step', 'Special']]) {
      await page.evaluate(l => setLocale(l), locale);
      assert.equal(await text(page, `${CARD} .category-card-title`), title);
      assert.equal(await text(page, `${CARD} .category-card-desc`), desc);
      assert.equal(await page.$eval(CARD, el => el.closest('.category-group').querySelector('.category-group-label').textContent), group);
      const order = await page.$$eval('.category-card', els => els.map(e => e.getAttribute('onclick')));
      assert.equal(order.indexOf(`selectCategory('timing')`), order.indexOf(`selectCategory('eclipse_nearest')`) + 1);
      assert.equal(await page.$eval(CARD, el => el.classList.contains('locked') || !!el.querySelector('.category-lock-icon')), false);
    }
    assert.ok((await text(page, '#categoryPreview')).includes('⏳'), 'badge icon');
    await page.evaluate(() => setLocale('tr'));
    await openForm(page);
    await settle(page);
    assert.equal(calls.quote.length, 0, 'no quote on the click');
    assert.equal(await text(page, '#chatCategoryTitle'), 'Zamanlama');
  } finally { await context.close(); }
});

test('form fields: no default action, no default or min date, the place is the birth place with its note, the info line; submit off', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await ready();
  try {
    await openForm(page);
    assert.equal(await page.$eval('#timingAction', s => s.value), '');
    assert.deepEqual(await page.$$eval('#timingAction option:not([disabled])', os => os.map(o => o.textContent)),
      ['Sözleşme imzalama', 'İş kurma/başlatma', 'Seyahat', 'Taşınma']);
    for (const id of ['#timingStart', '#timingEnd']) {
      assert.deepEqual(await page.$eval(id, i => [i.type, i.value, i.min, i.hasAttribute('min')]), ['date', '', '', false], id);
    }
    assert.equal(await text(page, '#timingPlaceText'), `${BIRTH.label} (41.01, 28.95)`);
    assert.equal(await text(page, '#timingPlaceNote'), 'Varsayılan doğum yerin. Eylem başka bir yerde olacaksa değiştir.');
    assert.ok((await text(page, '#timingFormPanel')).includes('Saatler eylemin yapılacağı yerin yerel saatiyle verilir.'));
    assert.equal(await text(page, '#timingSubmitBtn'), 'Uygun saatleri bul');
    assert.equal(await submitDisabled(page), true, 'nothing chosen yet');
    await fill(page, { action: 'travel' });
    assert.equal(await submitDisabled(page), true, 'no dates yet');
    await fill(page, { start: '2026-11-02', end: '2026-11-02' });
    assert.equal(await submitDisabled(page), false, 'one day is fine');
  } finally { await context.close(); }
});

test('client checks: 90 days (both ends) is allowed; 91 days turns submit off with "En fazla 90 gün seçebilirsin."', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await ready();
  try {
    await openForm(page);
    await fill(page, { action: 'travel', start: '2026-11-01', end: '2027-01-29' });
    assert.equal(await submitDisabled(page), false, '90 days');
    assert.equal(await page.isVisible('#timingRangeHint'), false);
    await fill(page, { end: '2027-01-30' });
    assert.equal(await submitDisabled(page), true, '91 days');
    assert.equal(await text(page, '#timingRangeHint'), 'En fazla 90 gün seçebilirsin.');
    assert.equal(await page.isVisible('#timingRangeHint'), true);
  } finally { await context.close(); }
});

test('client checks: end before start turns submit off', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await ready();
  try {
    await openForm(page);
    await fill(page, { action: 'travel', start: '2026-11-10', end: '2026-11-09' });
    assert.equal(await submitDisabled(page), true);
    await fill(page, { end: '2026-11-10' });
    assert.equal(await submitDisabled(page), false);
  } finally { await context.close(); }
});

test('client checks with a DST browser zone (Europe/Berlin): 90 and 91 days across both DST changes', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await ready({ timezoneId: 'Europe/Berlin' });
  try {
    await openForm(page);
    await fill(page, { action: 'travel' });
    // 29 March 2026: clocks go forward; 25 October 2026: clocks go back.
    for (const [start, end90, end91] of [['2026-03-01', '2026-05-29', '2026-05-30'], ['2026-10-01', '2026-12-29', '2026-12-30']]) {
      await fill(page, { start, end: end90 });
      assert.equal(await submitDisabled(page), false, `${start}..${end90}: 90 days`);
      await fill(page, { end: end91 });
      assert.equal(await submitDisabled(page), true, `${start}..${end91}: 91 days`);
    }
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------
test('body: the place unchanged still sends location = the exact coordinates sent to /natal; quote and /start carry the same fields; no period_type/timezone', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await ready({ quote: Q.sub });
  try {
    await openForm(page);
    await fill(page);
    await submit(page);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(calls.quote[0].raw, JSON.stringify(BODY()));
    const { request_id, expected_spend, ...rest } = calls.start[0].body;
    assert.deepEqual(rest, calls.quote[0].body, 'same fields');
    assert.match(request_id, UUID);
    assert.equal(expected_spend, 'subscription');
    for (const c of [calls.quote[0].body, calls.start[0].body]) {
      assert.equal('period_type' in c, false);
      assert.equal('timezone' in c, false);
    }
    assert.equal(await count(page, '#timingFormPanel'), 0, 'the form closes on the new report');
  } finally { await context.close(); }
});

test('body: the saved record text equals the text sent to /start', { timeout: TEST_TIMEOUT_MS }, async () => {
  const g = gate();
  const { context, page, calls } = await ready({ start: async () => { await g.wait(); return startOk('S1'); } });
  try {
    await openForm(page);
    await fill(page);
    await submit(page);
    await until(() => calls.start.length === 1, '/start');
    const rec = await pendingRecord(page, keyFor('u1', calls.start[0].body.request_id));
    assert.equal(rec.body, calls.start[0].raw);
    g.open();
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
  } finally { await context.close(); }
});

test('body: a changed place sends the chosen city; the birth form selection is not changed', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await ready({ quote: Q.sub });
  try {
    await openForm(page);
    await fill(page);
    await pickCity(page, 'Almanya', 'Berlin');
    assert.equal(await text(page, '#timingPlaceText'), 'Berlin, Almanya (52.52, 13.41)');
    assert.equal(await page.isVisible('#timingPlaceNote'), false, 'no birth place note');
    await submit(page);
    await until(() => calls.start.length === 1, '/start');
    assert.deepEqual(calls.quote[0].body.location, { latitude: BERLIN.lat, longitude: BERLIN.lon });
    assert.deepEqual(calls.start[0].body.location, { latitude: BERLIN.lat, longitude: BERLIN.lon });
    assert.deepEqual(await page.evaluate(() => [selectedCity.name, selectedCity.lat]), [BIRTH.name, BIRTH.lat], 'birth form unchanged');
  } finally { await context.close(); }
});

test('body: a chart without a saved birth place leaves the place empty and submit off until a place is chosen', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ quote: Q.sub }); // chart shown without /natal
  try {
    await openForm(page);
    await fill(page);
    assert.equal(await text(page, '#timingPlaceText'), 'Bir yer seç.');
    assert.equal(await submitDisabled(page), true);
    await page.evaluate(() => submitTimingForm(timingForm));
    await settle(page);
    assert.equal(calls.quote.length, 0, 'no quote');
    await pickCity(page, 'Almanya', 'Berlin');
    assert.equal(await submitDisabled(page), false);
  } finally { await context.close(); }
});

test('coordinates: two decimals on screen, the exact value in the body and in the saved record', { timeout: TEST_TIMEOUT_MS }, async () => {
  const g = gate();
  const { context, page, calls } = await ready({ start: async () => { await g.wait(); return startOk('S1'); } });
  try {
    await openForm(page);
    assert.equal(await text(page, '#timingPlaceText'), `${BIRTH.label} (41.01, 28.95)`);
    await fill(page);
    await submit(page);
    await until(() => calls.start.length === 1, '/start');
    assert.deepEqual(calls.quote[0].body.location, { latitude: 41.0138429, longitude: 28.9496605 });
    const rec = await pendingRecord(page, keyFor('u1', calls.start[0].body.request_id));
    assert.deepEqual(JSON.parse(rec.body).location, { latitude: 41.0138429, longitude: 28.9496605 });
    g.open();
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// Quote branches (card form)
// ---------------------------------------------------------------------------
test('quote "none": the saved report opens and the form closes; no /start', { timeout: TEST_TIMEOUT_MS }, async () => {
  const list = [timingSess('saved-t')];
  const { context, page, calls } = await ready({ quote: Q.none('saved-t'), detail: detailFrom(list) });
  try {
    await openForm(page);
    await fill(page);
    await submit(page);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni saved-t');
    assert.equal(await count(page, '#timingFormPanel'), 0);
    await settle(page);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

test('quote "subscription" from the card: /start without a confirm', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await ready({ quote: Q.sub });
  try {
    await openForm(page);
    await fill(page);
    await submit(page);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(await count(page, '.quote-confirm-btn'), 0);
    assert.equal(calls.start[0].body.expected_spend, 'subscription');
  } finally { await context.close(); }
});

test('quote "report_credit": a confirm with the action, date range and place; /start only after the confirm', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await ready({ quote: Q.credit, credits: () => ({ report_credits: 2 }) });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.report_credits === 2);
    await openForm(page);
    await fill(page);
    await submit(page);
    await page.waitForSelector('.quote-confirm-btn');
    const shown = await text(page, '.chat-bubble:has(.quote-confirm-btn)');
    assert.ok(shown.includes(`Sözleşme imzalama · ${await day(page, 2026, 11, 2)} – ${await day(page, 2026, 11, 15)} · ${BIRTH.label} (41.01, 28.95)`), shown);
    assert.ok(shown.includes('1 rapor hakkı kullanılacak.') && shown.includes('Kalan rapor hakkın: 2'), shown);
    await settle(page);
    assert.equal(calls.start.length, 0, 'no /start before the confirm');
    await page.click('.quote-confirm-btn');
    await until(() => calls.start.length === 1, '/start');
    assert.equal(calls.start[0].body.expected_spend, 'report_credit');
  } finally { await context.close(); }
});

test('quote "report_credit" with no credits: "Rapor hakkın yok", no confirm, no /start', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await ready({ quote: Q.credit, credits: () => ({ report_credits: 0 }) });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.report_credits === 0);
    await openForm(page);
    await fill(page);
    await submit(page);
    await page.waitForSelector('.chat-bubble.notice >> text=Rapor hakkın yok.');
    assert.equal(await count(page, '.quote-confirm-btn'), 0);
    await settle(page);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// The four timing 422s, quote and /start separately
// ---------------------------------------------------------------------------
for (const [type, field, msg, mark] of ERRORS) {
  test(`422 ${type} on the quote: the message, the form open with every field kept, no /start, no credit read`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { context, page, calls } = await ready({ quote: () => t422(type, field) });
    try {
      await openForm(page);
      await fill(page);
      const credits = calls.credits;
      await submit(page);
      await page.waitForSelector('#timingFormError', { state: 'visible' });
      assert.equal(await formError(page), msg);
      assert.deepEqual(await formValues(page), FORM_VALUES);
      assert.equal(await page.$eval('.timing-start-field', e => e.classList.contains('timing-field-error')), mark === 'start');
      assert.equal(await page.$eval('#timingPlaceField', e => e.classList.contains('timing-field-error')), mark === 'place');
      assert.ok(!(await text(page, '#chatMessages')).includes('raw backend text'));
      await settle(page);
      assert.equal(calls.start.length, 0);
      assert.equal(calls.credits, credits, 'no credit read');
      assert.deepEqual(await pendingKeys(page), []);
      assert.equal(await submitDisabled(page), false, 'can be sent again');
    } finally { await context.close(); }
  });

  test(`422 ${type} on /start: the message, the form open with every field kept, the record deleted, no credit read`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { context, page, calls } = await ready({ quote: Q.sub, start: () => t422(type, field) });
    try {
      await openForm(page);
      await fill(page);
      const credits = calls.credits;
      await submit(page);
      await page.waitForSelector('#timingFormError', { state: 'visible' });
      assert.equal(await formError(page), msg);
      assert.deepEqual(await formValues(page), FORM_VALUES);
      assert.equal(await page.$eval('.timing-start-field', e => e.classList.contains('timing-field-error')), mark === 'start');
      assert.equal(await page.$eval('#timingPlaceField', e => e.classList.contains('timing-field-error')), mark === 'place');
      await settle(page);
      assert.equal(calls.start.length, 1);
      assert.equal(calls.credits, credits, 'no credit read');
      assert.deepEqual(await pendingKeys(page), [], 'record deleted');
      assert.equal(await count(page, '.chat-bubble.error'), 0, 'the message is in the form');
    } finally { await context.close(); }
  });
}

test('another 422 (plain text) keeps the form with the general message', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await ready({ quote: () => [422, { detail: 'date_range_start/date_range_end must be YYYY-MM-DD' }] });
  try {
    await openForm(page);
    await fill(page);
    await submit(page);
    await page.waitForSelector('#timingFormError', { state: 'visible' });
    assert.equal(await formError(page), 'Gönderilen bilgi eksik veya geçersiz, tekrar dene.');
    assert.deepEqual(await formValues(page), FORM_VALUES);
  } finally { await context.close(); }
});

test('after a /start 422, sending again (unchanged, then changed) is a new quote with a NEW request_id and a new body; the old id is never sent again', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await ready({
    quote: Q.sub, start: (b, n) => (n === 1 ? t422('timing_no_candidates', 'date_range_start') : n === 2 ? t422('timing_no_candidates', 'date_range_start') : startOk('S3')),
  });
  try {
    await openForm(page);
    await fill(page);
    await submit(page);
    await page.waitForSelector('#timingFormError', { state: 'visible' });
    await submit(page); // unchanged
    await until(() => calls.start.length === 2, 'the second /start');
    await page.waitForSelector('#timingFormError', { state: 'visible' });
    await fill(page, { start: '2026-11-20', end: '2026-11-30' }); // changed
    await submit(page);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S3');
    assert.equal(calls.quote.length, 3, 'a new quote each time');
    const ids = calls.start.map(s => s.body.request_id);
    assert.equal(new Set(ids).size, 3, 'three different ids');
    assert.equal(calls.start[1].raw, JSON.stringify({ ...BODY(), request_id: ids[1], expected_spend: 'subscription' }));
    assert.equal(calls.start[2].body.date_range_start, '2026-11-20');
    assert.notEqual(calls.start[2].raw, calls.start[0].raw);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// Resume of an uncertain result: same id, byte-identical body
// ---------------------------------------------------------------------------
for (const [name, fail] of [
  ['a network error', () => 'abort'],
  ['a 5xx', () => [503, { detail: 'x' }]],
  ['a 429', () => [429, { detail: 'x' }]],
  ['409 request_in_progress', () => [409, { error: 'request_in_progress', detail: 'x' }]],
]) {
  test(`resume after ${name}: the same request_id and byte-identical body, even after the form was edited`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { context, page, calls, reload } = await ready({ quote: Q.sub, start: (b, n) => (n === 1 ? fail() : startOk('S1')) });
    try {
      await openForm(page);
      await fill(page);
      await submit(page);
      await until(() => calls.start.length === 1, 'the first /start');
      const first = calls.start[0];
      await fill(page, { action: 'travel', start: '2026-12-01', end: '2026-12-05' }); // edited after sending
      await reload();
      await until(() => calls.start.length >= 2, 'the resumed /start');
      for (const s of calls.start) assert.equal(s.raw, first.raw, 'byte-identical body');
      assert.equal(calls.quote.length, 1, 'no new quote');
      await page.waitForFunction(() => Object.keys(sessionStorage).every(k => !k.startsWith('stellafix_pending_interpret:')));
    } finally { await context.close(); }
  });
}

test('an edited form sent again is a new request; "Sürdür" still sends the old record with the old text', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await ready({ quote: Q.sub, start: (b, n) => (n === 1 ? 'abort' : startOk(`S${n}`)) });
  try {
    await openForm(page);
    await fill(page);
    await submit(page);
    await page.waitForSelector('.pending-retry-btn');
    const old = calls.start[0];
    await fill(page, { start: '2026-12-01', end: '2026-12-05' });
    await submit(page);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S2');
    const fresh = calls.start[1];
    assert.notEqual(fresh.body.request_id, old.body.request_id);
    assert.equal(fresh.body.date_range_start, '2026-12-01');
    await openReports(page);
    await page.click(`#pendingItems .pending-item[data-request-id="${old.body.request_id}"] .pending-resume`);
    await until(() => calls.start.length === 3, '"Sürdür"');
    assert.equal(calls.start[2].raw, old.raw, 'the old text');
  } finally { await context.close(); }
});

test('no confirm on resume: a saved record is resumed on load without a quote or a confirm, same id and body', { timeout: TEST_TIMEOUT_MS }, async () => {
  const body = { ...BODY(), request_id: 'rid-t', expected_spend: 'report_credit' };
  const { context, page, calls } = await openPage({ chart: false, seed: [seedRecord('u1', 'rid-t', body, { spend: 'report_credit' })], start: () => startOk('S1') });
  try {
    await until(() => calls.start.length === 1, 'the resumed /start');
    assert.equal(calls.start[0].raw, JSON.stringify(body));
    await settle(page);
    assert.equal(calls.quote.length, 0, 'no quote');
    assert.equal(await count(page, '.quote-confirm-btn, .quote-generate-btn'), 0, 'no confirm');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// Midnight (fake clock). Browser zone Europe/Istanbul; the page clock starts
// at 13:00 local, so 23:59:50 local is 10 h 59 min 50 s later.
// ---------------------------------------------------------------------------
const TO_2359_50 = (10 * 3600 + 59 * 60 + 50) * 1000;
async function readyAtMidnight(opts) {
  const r = await ready({ clock: true, ...opts });
  await r.page.clock.fastForward(TO_2359_50);
  return r;
}
test('midnight 1: quote "none" just before midnight only reads the saved report; no /start at all', { timeout: TEST_TIMEOUT_MS }, async () => {
  const list = [timingSess('saved-t')];
  const g = gate();
  const { context, page, calls } = await readyAtMidnight({ quote: async () => { await g.wait(); return Q.none('saved-t')(); }, detail: detailFrom(list) });
  try {
    await openForm(page);
    await fill(page);
    await submit(page);
    await until(() => calls.quote.length === 1, 'the quote');
    await page.clock.fastForward(12_000); // past midnight, inside the quote's own time limit
    g.open();
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni saved-t');
    await page.clock.fastForward(60_000);
    await settle(page);
    assert.equal(calls.start.length, 0);
    assert.ok(calls.log.every(e => e === 'quote' || e === 'detail:saved-t' || e === 'balance:saved-t'), calls.log.join());
  } finally { await context.close(); }
});

test('midnight 2: priced quote at 23:59:50, confirm and /start after midnight -> 422 timing_date_in_past: the message, the form kept, nothing started by itself', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await readyAtMidnight({ quote: Q.credit, start: () => t422('timing_date_in_past', 'date_range_start') });
  try {
    await openForm(page);
    await fill(page);
    await submit(page);
    await page.waitForSelector('.quote-confirm-btn');
    await page.clock.fastForward(20_000);
    await page.click('.quote-confirm-btn');
    await page.waitForSelector('#timingFormError', { state: 'visible' });
    assert.equal(await formError(page), ERRORS[0][2]);
    assert.deepEqual(await formValues(page), FORM_VALUES);
    await page.clock.fastForward(120_000);
    await settle(page);
    assert.equal(calls.start.length, 1, 'no new production by itself');
    assert.equal(calls.quote.length, 1);
  } finally { await context.close(); }
});

test('midnight 3: /start 409 spend_changed after midnight -> a new quote and a new confirm; no production by itself', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await readyAtMidnight({ quote: Q.credit, start: () => [409, { error: 'spend_changed', detail: 'x' }] });
  try {
    await openForm(page);
    await fill(page);
    await submit(page);
    await page.waitForSelector('.quote-confirm-btn');
    await page.clock.fastForward(20_000);
    await page.click('.quote-confirm-btn');
    await until(() => calls.quote.length === 2, 'the new quote');
    await page.waitForSelector('.quote-confirm-btn:not([disabled])');
    await page.clock.fastForward(120_000);
    await settle(page);
    assert.equal(calls.start.length, 1, 'no /start without the new confirm');
    assert.equal(calls.quote[1].raw, calls.quote[0].raw, 'the same request content');
  } finally { await context.close(); }
});

test('midnight 4: a range starting in the future - quote "none" the day before, priced on the start day -> a new production only with a confirm', { timeout: TEST_TIMEOUT_MS }, async () => {
  // The saved report's range starts tomorrow (16 Oct local).
  const saved = timingSess('saved-t', { date_range_start: '2026-10-16', date_range_end: '2026-10-20', timezone: 'Europe/Istanbul' });
  const list = [saved];
  const { context, page, calls } = await readyAtMidnight({
    quote: (b, n) => (n === 1 ? Q.none('saved-t')() : Q.sub()), history: (a, off) => (off ? [] : list), detail: detailFrom(list),
  });
  try {
    await openRow(page, 'saved-t');
    await page.click('#regenBtn');
    await page.waitForSelector('#timingFormPanel');
    await submit(page);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni saved-t');
    assert.equal(calls.start.length, 0, 'day before: the saved report, no production');
    await page.clock.fastForward(20_000); // the start day
    await page.click('#regenBtn');
    await page.waitForSelector('#timingFormPanel');
    assert.deepEqual([await page.$eval('#timingStart', i => i.value), await page.$eval('#timingEnd', i => i.value)], ['2026-10-16', '2026-10-20'], 'dates not updated');
    await submit(page);
    await page.waitForSelector('.quote-confirm-btn');
    await page.clock.fastForward(60_000);
    await settle(page);
    assert.equal(calls.start.length, 0, 'no production without the confirm');
    await page.click('.quote-confirm-btn');
    await until(() => calls.start.length === 1, '/start');
    assert.equal(calls.start[0].body.expected_spend, 'subscription');
    assert.equal('force_regenerate' in calls.start[0].body, false);
  } finally { await context.close(); }
});

test('midnight 5a: an unfinished record resumed after midnight that the server finished opens the saved result', { timeout: TEST_TIMEOUT_MS }, async () => {
  const body = { ...BODY(), request_id: 'rid-t', expected_spend: 'subscription' };
  const { context, page, calls } = await openPage({ chart: false, clock: true, seed: [seedRecord('u1', 'rid-t', body)], start: () => startOk('S9') });
  try {
    await until(() => calls.start.length === 1, 'the resumed /start');
    assert.equal(calls.start[0].raw, JSON.stringify(body));
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S9');
    assert.deepEqual(await pendingKeys(page), []);
  } finally { await context.close(); }
});

test('midnight 5b: an unfinished record resumed after midnight that gets 422 is deleted with a "Sonuçlanan istekler" note; no form opens', { timeout: TEST_TIMEOUT_MS }, async () => {
  const body = { ...BODY(), request_id: 'rid-t', expected_spend: 'subscription' };
  const { context, page, calls } = await openPage({ chart: false, seed: [seedRecord('u1', 'rid-t', body)], start: () => t422('timing_date_in_past', 'date_range_start'), history: () => [] });
  try {
    await until(() => calls.start.length === 1, 'the resumed /start');
    await page.waitForFunction(() => Object.keys(sessionStorage).every(k => !k.startsWith('stellafix_pending_interpret:')));
    await openReports(page);
    await page.waitForSelector('#pendingNotes .pending-note');
    assert.deepEqual(await noteRows(page), ['Rapor isteği: ZamanlamaTarih geçmişte kaldı, yeni tarih seç.']);
    assert.equal(await count(page, '#timingFormPanel'), 0);
    assert.equal(await count(page, '#pendingItems .pending-item'), 0);
  } finally { await context.close(); }
});

test('midnight 6: an open form across midnight keeps its dates', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await readyAtMidnight();
  try {
    await openForm(page);
    await fill(page);
    await page.clock.fastForward(60_000);
    await settle(page);
    assert.deepEqual(await formValues(page), FORM_VALUES);
    assert.equal(await submitDisabled(page), false);
    assert.equal(calls.quote.length, 0);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// "Bu ayarlarla yeni tarama"
// ---------------------------------------------------------------------------
const OLD = timingSess('old-t');
async function readyRescan(opts) {
  const list = [OLD];
  const r = await ready({ history: (a, off) => (off ? [] : list), detail: detailFrom(list), ...opts });
  await openRow(r.page, 'old-t');
  assert.equal(await text(r.page, '#regenBtn'), 'Bu ayarlarla yeni tarama');
  await r.page.click('#regenBtn');
  await r.page.waitForSelector('#timingFormPanel');
  return r;
}
test('new scan: the form is filled from the report (action, dates, place as time zone + coordinates); the body carries the exact location', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await readyRescan({ quote: Q.credit });
  try {
    assert.deepEqual(await formValues(page), { action: 'travel', start: '2026-11-02', end: '2026-11-10', place: 'Asia/Tokyo (35.69, 139.69)' });
    await submit(page);
    await page.waitForSelector('.quote-confirm-btn');
    assert.deepEqual(calls.quote[0].body, { chart_id: 'chart-1', category: 'timing', language: 'tr', action_type: 'travel',
      date_range_start: '2026-11-02', date_range_end: '2026-11-10', location: TOKYO });
    assert.equal('force_regenerate' in calls.quote[0].body, false);
  } finally { await context.close(); }
});

test('new scan, quote "subscription": a separate confirm with the price; no /start before it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await readyRescan({ quote: Q.sub });
  try {
    await submit(page);
    await page.waitForSelector('.quote-confirm-btn');
    const shown = await text(page, '.chat-bubble:has(.quote-confirm-btn)');
    assert.ok(shown.includes('Aboneliğin kapsamında (ek ücret yok)'), shown);
    assert.ok(shown.includes('Seyahat'), shown);
    await settle(page);
    assert.equal(calls.start.length, 0, 'no unapproved /start');
    await page.click('.quote-confirm-btn');
    await until(() => calls.start.length === 1, '/start');
    assert.equal(calls.start[0].body.expected_spend, 'subscription');
    assert.equal('force_regenerate' in calls.start[0].body, false);
  } finally { await context.close(); }
});

test('new scan, quote "report_credit": a confirm; /start only after it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await readyRescan({ quote: Q.credit });
  try {
    await submit(page);
    await page.waitForSelector('.quote-confirm-btn');
    assert.ok((await text(page, '.chat-bubble:has(.quote-confirm-btn)')).includes('1 rapor hakkı kullanılacak.'));
    await settle(page);
    assert.equal(calls.start.length, 0);
    await page.click('.quote-confirm-btn');
    await until(() => calls.start.length === 1, '/start');
    assert.equal(calls.start[0].body.expected_spend, 'report_credit');
  } finally { await context.close(); }
});

test('new scan, quote "none": the saved report opens at no charge; the dates sent are the report\'s, unchanged', { timeout: TEST_TIMEOUT_MS }, async () => {
  const list = [OLD, timingSess('same-t')];
  const { context, page, calls } = await ready({ quote: Q.none('same-t'), history: (a, off) => (off ? [] : list), detail: detailFrom(list) });
  try {
    await openRow(page, 'old-t');
    await page.click('#regenBtn');
    await page.waitForSelector('#timingFormPanel');
    await submit(page);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni same-t');
    await settle(page);
    assert.equal(calls.start.length, 0);
    assert.deepEqual([calls.quote[0].body.date_range_start, calls.quote[0].body.date_range_end], ['2026-11-02', '2026-11-10']);
  } finally { await context.close(); }
});

test('the two sources differ: the card form generates on "subscription" without a confirm; the new-scan form asks first', { timeout: TEST_TIMEOUT_MS }, async () => {
  const list = [OLD];
  const { context, page, calls } = await ready({ quote: Q.sub, history: (a, off) => (off ? [] : list), detail: detailFrom(list) });
  try {
    await openForm(page);
    await fill(page);
    await submit(page);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(calls.start.length, 1, 'card: no confirm');
    await openRow(page, 'old-t');
    await page.click('#regenBtn');
    await page.waitForSelector('#timingFormPanel');
    await submit(page);
    await page.waitForSelector('.quote-confirm-btn');
    await settle(page);
    assert.equal(calls.start.length, 1, 'new scan: waits for the confirm');
    await page.click('.quote-confirm-btn');
    await until(() => calls.start.length === 2, 'the second /start');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// "Aralık geçti" note: today in the report's own time zone. Browser zone
// Pacific/Honolulu (UTC-10); page time 2026-10-15 16:00 UTC, which is
// 16 Oct in Tokyo and 15 Oct in Honolulu.
// ---------------------------------------------------------------------------
for (const [name, timing, note] of [
  ['fully past in Tokyo (only partly past by the browser date)', { date_range_start: '2026-10-10', date_range_end: '2026-10-15' }, 'Bu aralık geçti; güncel adaylar için yeni tarama gerekir. Bu rapor okunabilir kalır.'],
  ['partly past in Tokyo (not started by the browser date)', { date_range_start: '2026-10-15', date_range_end: '2026-10-20' }, 'Bu aralığın bir kısmı geçti; geçmiş saatlerdeki adaylar artık kullanılamaz. Bu rapor okunabilir kalır.'],
  ['starting today in Tokyo', { date_range_start: '2026-10-16', date_range_end: '2026-10-20' }, null],
  ['no time zone (past by any date)', { date_range_start: '2026-10-01', date_range_end: '2026-10-05', timezone: null }, null],
  ['an unknown time zone', { date_range_start: '2026-10-01', date_range_end: '2026-10-05', timezone: 'Mars/Olympus' }, null],
]) {
  test(`range note: ${name}`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const list = [timingSess('rn', timing)];
    const { context, page } = await openPage({ chart: false, clock: true, timezoneId: 'Pacific/Honolulu', history: (a, off) => (off ? [] : list), detail: detailFrom(list) });
    try {
      await page.clock.fastForward(6 * 3600 * 1000);
      await openRow(page, 'rn');
      const notes = await page.$$eval('#chatMessages .chat-bubble.notice', els => els.map(e => e.textContent));
      const rangeNotes = notes.filter(n => n.includes('aralı'));
      assert.deepEqual(rangeNotes, note ? [note] : []);
    } finally { await context.close(); }
  });
}

// ---------------------------------------------------------------------------
// View and account ownership, quote and /start separately
// ---------------------------------------------------------------------------
const late422 = () => t422('timing_no_candidates', 'date_range_start');
async function sendHeld(page, calls, kind) {
  await openForm(page);
  await fill(page);
  await submit(page);
  await until(() => calls[kind].length === 1, kind);
}
for (const kind of ['quote', 'start']) {
  test(`ownership (${kind}): a late 422 while still on the same form shows the message and keeps the fields`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const g = gate();
    const held = async () => { await g.wait(); return late422(); };
    const { context, page, calls } = await ready(kind === 'quote' ? { quote: held } : { quote: Q.sub, start: held });
    try {
      await sendHeld(page, calls, kind);
      g.open();
      await page.waitForSelector('#timingFormError', { state: 'visible' });
      assert.deepEqual(await formValues(page), FORM_VALUES);
    } finally { await context.close(); }
  });

  test(`ownership (${kind}): a late 422 after leaving the form (same account) does not reopen it or print a message${kind === 'start' ? '; a "Sonuçlanan istekler" note' : '; nothing at all'}`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const g = gate();
    const held = async () => { await g.wait(); return late422(); };
    const { context, page, calls } = await ready({ ...(kind === 'quote' ? { quote: held } : { quote: Q.sub, start: held }), history: () => [] });
    try {
      await sendHeld(page, calls, kind);
      await page.click('#chatBackBtn');
      await page.waitForSelector('#categoryPanel', { state: 'visible' });
      const resp = page.waitForResponse(r => r.url().endsWith(`/interpret/${kind}`));
      g.open();
      await resp;
      await settle(page);
      assert.equal(await count(page, '#timingFormPanel'), 0, 'not reopened');
      assert.equal(await page.isVisible('#chatPanel'), false);
      assert.equal(await count(page, '.chat-bubble.error'), 0);
      await openReports(page);
      if (kind === 'start') {
        await page.waitForSelector('#pendingNotes .pending-note');
        assert.deepEqual(await noteRows(page), ['Rapor isteği: ZamanlamaBu aralıkta taranacak saat kalmadı. Yeni tarihler seç.']);
      } else {
        await settle(page);
        assert.equal(await count(page, '#pendingNotes .pending-note'), 0);
      }
      assert.equal(calls.start.length, kind === 'start' ? 1 : 0);
    } finally { await context.close(); }
  });

  test(`ownership (${kind}): a late 422 after the account changed prints nothing on the new account`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const g = gate();
    const held = async () => { await g.wait(); return late422(); };
    const { context, page, calls } = await ready({ ...(kind === 'quote' ? { quote: held } : { quote: Q.sub, start: held }), history: () => [], verify: () => U2 });
    try {
      await sendHeld(page, calls, kind);
      await logoutViaMenu(page);
      await loginAs(page, U2);
      const resp = page.waitForResponse(r => r.url().endsWith(`/interpret/${kind}`));
      g.open();
      await resp;
      await settle(page);
      assert.equal(await count(page, '#timingFormPanel'), 0);
      assert.equal(await count(page, '.chat-bubble.error'), 0);
      await openReports(page);
      await settle(page);
      assert.equal(await count(page, '#pendingNotes .pending-note'), 0, 'no note on the new account');
    } finally { await context.close(); }
  });
}

test('late successful /start while on another screen (same account): "Raporun hazır" and a balance refresh', { timeout: TEST_TIMEOUT_MS }, async () => {
  const g = gate();
  const { context, page, calls } = await ready({ quote: Q.sub, start: async () => { await g.wait(); return startOk('S1'); } });
  try {
    await sendHeld(page, calls, 'start');
    await page.click('#chatBackBtn');
    const credits = calls.credits;
    const resp = page.waitForResponse(r => r.url().endsWith('/interpret/start'));
    g.open();
    await resp;
    await page.waitForSelector('#reportReadyToast', { state: 'visible' });
    await until(() => calls.credits > credits, 'the balance refresh');
    assert.equal(await count(page, '#timingFormPanel'), 0);
  } finally { await context.close(); }
});

test('late successful /start after the account changed: nothing is shown', { timeout: TEST_TIMEOUT_MS }, async () => {
  const g = gate();
  const { context, page, calls } = await ready({ quote: Q.sub, start: async () => { await g.wait(); return startOk('S1'); }, verify: () => U2 });
  try {
    await sendHeld(page, calls, 'start');
    await logoutViaMenu(page);
    await loginAs(page, U2);
    const resp = page.waitForResponse(r => r.url().endsWith('/interpret/start'));
    g.open();
    await resp;
    await settle(page);
    assert.equal(await page.isVisible('#reportReadyToast'), false);
    assert.equal(await count(page, '.chat-bubble.assistant'), 0);
  } finally { await context.close(); }
});

for (const [name, leave] of [
  ['sign out and in', async page => { await logoutViaMenu(page); await loginAs(page, U1); }],
  ['My reports', async page => { await openReports(page); }],
  ['another card', async page => { await page.click('#chatBackBtn'); await page.click(`button.category-card[onclick="selectCategory('personality')"]`); }],
]) {
  test(`screen change (${name}) with the form open: a late priced quote shows no confirm`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const g = gate();
    const { context, page, calls } = await ready({
      quote: async b => { if (b.category === 'timing') await g.wait(); return Q.credit(); }, verify: () => U1, history: () => [],
    });
    try {
      await sendHeld(page, calls, 'quote');
      await leave(page);
      const resp = page.waitForResponse(r => r.url().endsWith('/interpret/quote') && r.request().postData().includes('timing'));
      g.open();
      await resp;
      await settle(page);
      assert.equal(await count(page, '#timingFormPanel'), 0);
      assert.equal(await count(page, '.chat-bubble:has(.quote-confirm-btn) >> text=Sözleşme imzalama'), 0, 'no timing confirm');
      assert.equal(calls.start.length, 0);
    } finally { await context.close(); }
  });
}

// ---------------------------------------------------------------------------
// Birth place race and the place picker
// ---------------------------------------------------------------------------
test('birth place race: an older /natal answered last does not overwrite the newer chart\'s saved birth place', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ chart: false, quote: Q.sub });
  try {
    const g = gate();
    let n = 0;
    await page.route(`${API}/natal**`, async route => {
      n += 1;
      if (n === 1) { await g.wait(); return json(route, 200, natalResp('chart-old')); }
      return json(route, 200, natalResp('chart-new'));
    });
    const OLDP = { name: 'Izmir', lat: 38.4127, lon: 27.1384, label: 'Izmir, Türkiye' };
    page.evaluate(p => {
      selectedCity = { name: p.name, countryCode: 'TR', region: '', lat: p.lat, lon: p.lon, tz: 'Europe/Istanbul' };
      document.getElementById('birthDate').value = '1990-01-01';
      document.getElementById('birthTime').value = '12:00';
      calculateChart();
    }, OLDP);
    await until(() => n === 1, 'the first /natal');
    await computeChart(page, BIRTH);
    await page.waitForFunction(() => lastChartId === 'chart-new');
    const resp = page.waitForResponse(r => r.url().includes('/natal'));
    g.open();
    await resp;
    await page.waitForFunction(() => birthPlaceFor('chart-old') !== null);
    assert.deepEqual(await page.evaluate(() => birthPlaceFor('chart-new')), { seq: 2, name: BIRTH.label, lat: BIRTH.lat, lon: BIRTH.lon }, 'the newer chart keeps its birth place');
    // The page now shows the older chart (it was drawn last); the form sends that chart's own birth place.
    assert.equal(await page.evaluate(() => lastChartId), 'chart-old');
    await openForm(page);
    assert.equal(await text(page, '#timingPlaceText'), `${OLDP.label} (38.41, 27.14)`);
    await fill(page);
    await submit(page);
    await until(() => calls.quote.length === 1, 'the quote');
    assert.deepEqual([calls.quote[0].body.chart_id, calls.quote[0].body.location], ['chart-old', { latitude: OLDP.lat, longitude: OLDP.lon }]);
  } finally { await context.close(); }
});

test('place picker: two quick city choices - only the last one goes into the body', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await ready({ quote: Q.sub });
  try {
    await openForm(page);
    await fill(page);
    await pickCity(page, 'Almanya', 'Berlin');
    await page.fill('#tzCityInput', 'Munich');
    await page.click('#tzCityDropdown .city-option');
    assert.equal(await text(page, '#timingPlaceText'), 'Munich, Almanya (48.14, 11.58)');
    await submit(page);
    await until(() => calls.quote.length === 1, 'the quote');
    assert.deepEqual(calls.quote[0].body.location, { latitude: MUNICH.lat, longitude: MUNICH.lon });
  } finally { await context.close(); }
});

test('place picker: submit is off while a new place is being chosen', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await ready();
  try {
    await openForm(page);
    await fill(page);
    assert.equal(await submitDisabled(page), false);
    await page.click('#timingPlaceChange');
    assert.equal(await submitDisabled(page), true);
    await page.fill('#tzCountryInput', 'Almanya');
    await page.click('#tzCountryDropdown .city-option');
    await page.waitForSelector('#tzCityInput', { state: 'visible' });
    await page.fill('#tzCityInput', 'Berlin');
    await page.click('#tzCityDropdown .city-option');
    assert.equal(await submitDisabled(page), false);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// My reports
// ---------------------------------------------------------------------------
test('My reports: the row label "Zamanlama · <action> · <start>–<end>" with the end day included', { timeout: TEST_TIMEOUT_MS }, async () => {
  const list = [timingSess('t1')];
  const { context, page } = await openPage({ chart: false, history: (a, off) => (off ? [] : list), detail: detailFrom(list) });
  try {
    await openReports(page);
    await page.waitForSelector(rowSel('t1'));
    assert.equal(await text(page, `${rowSel('t1')} .report-row-title`), `Zamanlama · Seyahat · ${await day(page, 2026, 11, 2)}–${await day(page, 2026, 11, 10)}`);
  } finally { await context.close(); }
});

test('report view: the line "Eylemin yapılacağı yer: <time zone> (<lat>, <lon>)"; "Bu ayarlarla yeni tarama" instead of "Yeniden üret"', { timeout: TEST_TIMEOUT_MS }, async () => {
  const list = [timingSess('t1')];
  const { context, page } = await openPage({ chart: false, history: (a, off) => (off ? [] : list), detail: detailFrom(list) });
  try {
    await openRow(page, 't1');
    assert.equal(await text(page, '#chatSubtitle'), 'Eylemin yapılacağı yer: Asia/Tokyo (35.69, 139.69)');
    assert.equal(await text(page, '#regenBtn'), 'Bu ayarlarla yeni tarama');
    await page.evaluate(() => setLocale('en'));
    assert.equal(await text(page, '#chatSubtitle'), 'Where the action will take place: Asia/Tokyo (35.69, 139.69)');
    assert.equal(await text(page, '#regenBtn'), 'New scan with these settings');
  } finally { await context.close(); }
});

test('a timing report with a null summary: the generic "Zamanlama" title, readable, questions open, no new scan', { timeout: TEST_TIMEOUT_MS }, async () => {
  const list = [sess('tn', { category: 'timing', timing: null })];
  const { context, page, calls } = await openPage({ chart: false, history: (a, off) => (off ? [] : list), detail: detailFrom(list), balance: () => bal(1, 2) });
  try {
    await openReports(page);
    await page.waitForSelector(rowSel('tn'));
    assert.equal(await text(page, `${rowSel('tn')} .report-row-title`), 'Zamanlama');
    await page.click(rowSel('tn'));
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni tn');
    assert.equal(await text(page, '#chatCategoryTitle'), 'Zamanlama');
    await page.waitForFunction(() => !document.getElementById('chatInput').disabled);
    assert.equal(await page.$eval('#regenBtn', b => b.style.display), 'none');
    assert.equal(await page.isVisible('#chatSubtitle'), false);
    await page.fill('#chatInput', 'Bir sorum var');
    await page.click('#chatSendBtn');
    await until(() => calls.continue.length === 1, '/continue');
  } finally { await context.close(); }
});
