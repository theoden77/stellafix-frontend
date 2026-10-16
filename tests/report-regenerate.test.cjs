// Browser integration test for "Yeniden üret" (generate a report again): the
// button, the captured context, the target texts, the forced and unforced
// quote/confirm/start paths, the source report stored in the pending record,
// 409 report_changed, picker returns and late responses. The API is mocked
// with page.route; no real backend is called. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness, API, json } = require('./helpers/harness.cjs');
const {
  useHarness, U1, U2, UUID, delay, gate, never, until, Q, startOk, sess, openPage, pendingKeys, pendingRecord, keyFor,
  text, count, openReports, logoutViaMenu, loginAs, nextFrame, seedRecord, startBody, clickCategory,
} = require('./helpers/interpret-page.cjs');

let h;
before(async () => { h = await startHarness(); useHarness(h); });
after(async () => { await h?.close(); });

const SRC = 'src-session-77';
const GIP = [409, { error: 'generation_in_progress', detail: 'x' }];
const invalidTz = [422, { detail: [{ type: 'timezone_invalid', loc: ['body', 'timezone'], msg: 'x', input: 'x' }] }];
const msgsOf = id => [{ role: 'assistant', content: `Rapor metni ${id}`, created_at: '2026-10-10T09:30:00+00:00' }];
// Responders in order; the last one repeats.
const seq = (...rs) => (b, n) => rs[Math.min(n, rs.length) - 1](b, n);
// Detail mock from a list of sessions.
const detailFrom = list => id => {
  const s = list.find(x => x.session_id === id);
  return s ? { ...s, messages: msgsOf(id) } : [404, { detail: 'x' }];
};

// One source report in "Raporlarım" (plus `others`); opened unless open:false.
async function setup({ src = {}, others = [], open = true, history, ...page } = {}) {
  const list = [sess(SRC, src), ...others];
  const r = await openPage({ chart: false, history: history || ((a, off) => (off ? [] : list)), detail: detailFrom(list), ...page });
  if (open) await openSource(r.page, SRC);
  return { ...r, list };
}
async function openSource(page, id) {
  await openReports(page);
  await page.click(`#reportsList .report-row[data-session-id="${id}"]`);
  await page.waitForSelector(`.chat-bubble.assistant >> text=Rapor metni ${id}`);
}
const regenShown = page => page.locator('#regenBtn').isVisible();
const confirmBubble = page => page.locator('.chat-bubble:has(.regen-confirm-btn)').last().textContent();
const lastError = page => page.locator('.chat-bubble.error').last().textContent();
const noRegenFields = (b, what) => {
  assert.equal('period_type' in b, false, `${what}: no period_type`);
};
const quoteClean = (q, what) => {
  noRegenFields(q, what);
  assert.equal('request_id' in q, false, `${what}: no request_id`);
  assert.equal('expected_spend' in q, false, `${what}: no expected_spend`);
};
// Settles: no pending response is handled after this.
async function settle(page) { await nextFrame(page); await delay(150); await nextFrame(page); }

// ---------------------------------------------------------------------------
// R1 visibility
// ---------------------------------------------------------------------------
test('R1 button: only on a completed report of a known category with a chart_id while logged in', async () => {
  const list = [
    sess(SRC), sess('pen', { status: 'pending' }), sess('fail', { status: 'failed' }),
    sess('unk', { category: 'marriage' }), sess('nochart', { chart_id: null }), sess('emptychart', { chart_id: '' }),
  ];
  const { context, page } = await openPage({
    chart: false, history: (a, off) => (off ? [] : list), detail: detailFrom(list),
  });
  try {
    await openSource(page, SRC);
    assert.equal(await regenShown(page), true, 'completed + known category + chart_id');
    for (const id of ['pen', 'fail', 'unk', 'nochart', 'emptychart']) {
      await openSource(page, id);
      assert.equal(await regenShown(page), false, `no button: ${id}`);
    }
    await openSource(page, SRC);
    assert.equal(await regenShown(page), true);
    await logoutViaMenu(page);
    assert.equal(await page.$eval('#regenBtn', b => b.style.display), 'none', 'logged out: no button');
  } finally { await context.close(); }
});

test('R1 button: a saved report opened by a category click takes chart_id from the flow; a new report from /start shows it', async () => {
  const det = { ...sess('saved', { chart_id: null }), messages: msgsOf('saved') };
  const { context, page, calls } = await openPage({
    quote: (b, n) => (b.category === 'career' ? Q.none('saved')() : Q.sub()), detail: () => det,
    start: () => startOk('fresh'),
  });
  try {
    await clickCategory(page, 'career');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni saved');
    assert.equal(await regenShown(page), true, 'chart_id from the flow');
    await page.click('#chatBackBtn');
    await clickCategory(page, 'personality');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni fresh');
    assert.equal(await regenShown(page), true, 'a report just generated');
    // The regen quote of the saved report uses the flow's chart.
    await page.click('#chatBackBtn');
    await clickCategory(page, 'career');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni saved');
    const before = calls.quote.length;
    await page.click('#regenBtn');
    await until(() => calls.quote.length > before, 'the regen quote');
    assert.equal(calls.quote[before].body.chart_id, 'chart-1');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// R2 target texts
// ---------------------------------------------------------------------------
const TARGETS = {
  tr: {
    weekly_review: 'Bugünden başlayan 7 günlük dönem için yeni rapor',
    monthly_review: 'Bugünden başlayan 30 günlük dönem için yeni rapor',
    yearly_review: 'Bugünden başlayan 12 aylık dönem için yeni rapor',
    eclipse_nearest: 'Şu anki en yakın tutulma için yeni rapor',
    same: 'Bu rapor yeniden üretilecek; mevcut rapor okunabilir kalır.',
  },
  en: {
    weekly_review: 'A new report for the 7-day period starting today',
    monthly_review: 'A new report for the 30-day period starting today',
    yearly_review: 'A new report for the 12-month period starting today',
    eclipse_nearest: 'A new report for the current nearest eclipse',
    same: 'This report will be generated again; the current report stays readable.',
  },
};
const ALL8 = ['weekly_review', 'monthly_review', 'yearly_review', 'personality', 'career', 'finance', 'health', 'eclipse_nearest'];
for (const locale of ['tr', 'en']) {
  test(`R2 target texts (${locale}) for all 8 categories; no period_type in the quote or /start`, async () => {
    const list = ALL8.map(c => sess(`r-${c}`, { category: c, period_type: 'rolling_7d', timezone: 'Europe/Istanbul' }));
    const { context, page, calls } = await openPage({
      chart: false, history: (a, off) => (off ? [] : list), detail: detailFrom(list),
      quote: Q.sub, start: b => startOk(`new-${b.category}`),
    });
    try {
      await page.evaluate(l => setLocale(l), locale);
      for (const c of ALL8) {
        await openSource(page, `r-${c}`);
        const starts = calls.start.length;
        await page.click('#regenBtn');
        await page.waitForSelector('.regen-confirm-btn');
        const shown = await confirmBubble(page);
        assert.ok(shown.includes(TARGETS[locale][c] || TARGETS[locale].same), `${c}: ${shown}`);
        await page.click('.regen-confirm-btn');
        await until(() => calls.start.length === starts + 1, `/start for ${c}`);
        await page.waitForSelector(`.chat-bubble.assistant >> text=Rapor metni new-${c}`);
      }
      for (const q of calls.quote) noRegenFields(q.body, 'quote');
      for (const s of calls.start) noRegenFields(s.body, '/start');
    } finally { await context.close(); }
  });
}

// ---------------------------------------------------------------------------
// R3, R4: (b) the report on screen is today's target -> forced quote, confirm
// ---------------------------------------------------------------------------
test('R3 (b) subscription: second quote has force_regenerate; confirm; one /start with a new id, force, expected_spend "subscription"', async () => {
  const { context, page, calls } = await setup({ quote: seq(Q.none(SRC), Q.sub), start: () => startOk('NEW') });
  try {
    await page.click('#regenBtn');
    await page.waitForSelector('.regen-confirm-btn');
    assert.equal(calls.quote.length, 2);
    assert.equal('force_regenerate' in calls.quote[0].body, false, 'the first quote has no force_regenerate');
    assert.equal(calls.quote[1].body.force_regenerate, true);
    for (const q of calls.quote) quoteClean(q.body, 'quote');
    const shown = await confirmBubble(page);
    assert.ok(shown.includes(TARGETS.tr.same), shown);
    assert.ok(shown.includes('Aboneliğin kapsamında (ek ücret yok)'), shown);
    await settle(page);
    assert.equal(calls.start.length, 0, 'no /start before the confirm');
    await page.click('.regen-confirm-btn');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni NEW');
    assert.equal(calls.start.length, 1);
    const b = calls.start[0].body;
    assert.match(b.request_id, UUID);
    assert.equal(b.force_regenerate, true);
    assert.equal(b.expected_spend, 'subscription');
    assert.equal(b.chart_id, 'chart-1');
    assert.equal(await count(page, '.chat-bubble.assistant >> text=Rapor metni src-session-77'), 0, 'the result is in a new view');
  } finally { await context.close(); }
});

for (const [name, credits, expect] of [
  ['balance 2: confirm with the balance line', () => ({ report_credits: 2 }), 'confirm-balance'],
  ['balance unreadable: confirm without the balance line', () => [500, { detail: 'x' }], 'confirm'],
  ['balance 0: "Rapor hakkın yok" + Abone Ol, no confirm', () => ({ report_credits: 0 }), 'none'],
]) {
  test(`R4 (b) report_credit, ${name}`, async () => {
    const { context, page, calls } = await setup({ quote: seq(Q.none(SRC), Q.credit), credits, start: () => startOk('NEW') });
    try {
      await page.click('#regenBtn');
      if (expect === 'none') {
        await page.waitForSelector('.chat-bubble >> text=Rapor hakkın yok.');
        assert.equal(await count(page, '.chat-bubble-action >> text=Abone Ol'), 1);
        assert.equal(await count(page, '.regen-confirm-btn'), 0);
        await settle(page);
        assert.equal(calls.start.length, 0);
        return;
      }
      await page.waitForSelector('.regen-confirm-btn');
      assert.equal(calls.quote[1].body.force_regenerate, true);
      const shown = await confirmBubble(page);
      assert.ok(shown.includes(TARGETS.tr.same), shown);
      assert.ok(shown.includes('1 rapor hakkı kullanılacak.'), shown);
      assert.equal(shown.includes('Kalan rapor hakkın: 2'), expect === 'confirm-balance', shown);
      await settle(page);
      assert.equal(calls.start.length, 0);
      await page.click('.regen-confirm-btn');
      await until(() => calls.start.length === 1, '/start');
      assert.equal(calls.start[0].body.expected_spend, 'report_credit');
      assert.equal(calls.start[0].body.force_regenerate, true);
    } finally { await context.close(); }
  });
}

// ---------------------------------------------------------------------------
// R5 (c), R6 (d), R7 (e)
// ---------------------------------------------------------------------------
test('R5 (c) another saved report is today\'s target: no production, "Raporu aç" opens it (no auto open)', async () => {
  const other = sess('OTHER');
  const { context, page, calls } = await setup({ others: [other], quote: Q.none('OTHER') });
  try {
    await page.click('#regenBtn');
    await page.waitForSelector('.regen-open-btn');
    assert.ok((await text(page, '#chatMessages')).includes('Bu dönem için kayıtlı bir rapor var'));
    await settle(page);
    assert.equal(calls.quote.length, 1, 'no forced quote');
    assert.ok(!calls.detail.includes('OTHER'), 'not opened by itself');
    assert.ok(await count(page, '.chat-bubble.assistant >> text=Rapor metni src-session-77'), 'the source stays on screen');
    await page.click('.regen-open-btn');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni OTHER');
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

for (const [spend, quote] of [['subscription', Q.sub], ['report_credit', Q.credit]]) {
  test(`R6 (d) first quote ${spend}: confirm, no unapproved /start; /start without force`, async () => {
    const { context, page, calls } = await setup({ quote, start: () => startOk('NEW') });
    try {
      await page.click('#regenBtn');
      await page.waitForSelector('.regen-confirm-btn');
      await settle(page);
      assert.equal(calls.quote.length, 1);
      assert.equal(calls.start.length, 0, 'no /start before the confirm');
      await page.click('.regen-confirm-btn');
      await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni NEW');
      assert.equal(calls.start.length, 1);
      assert.equal('force_regenerate' in calls.start[0].body, false);
      assert.equal(calls.start[0].body.expected_spend, spend);
    } finally { await context.close(); }
  });
}

test('R7 (e) 409 generation_in_progress on the forced quote: the check loop runs without force; a price shows an Üret button, no /start', async () => {
  const { context, page, calls } = await setup({ clock: true, quote: seq(Q.none(SRC), () => GIP, Q.sub), start: () => startOk('NEW') });
  try {
    await page.click('#regenBtn');
    await until(() => calls.quote.length === 2, 'the forced quote');
    for (let i = 0; i < 10 && calls.quote.length < 3; i++) { await page.clock.fastForward(3_500); await nextFrame(page); await delay(20); }
    await page.waitForSelector('.quote-generate-btn');
    assert.equal(calls.quote[1].body.force_regenerate, true);
    for (const q of calls.quote.slice(2)) assert.equal('force_regenerate' in q.body, false, 'loop quotes: no force');
    for (let i = 0; i < 4; i++) await page.clock.fastForward(30_000);
    await settle(page);
    assert.equal(calls.start.length, 0, 'no /start on a price');
    await page.click('.quote-generate-btn');
    await until(() => calls.start.length === 1, '/start');
    assert.equal('force_regenerate' in calls.start[0].body, false);
    assert.equal(calls.start[0].body.expected_spend, 'subscription');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// R8 captured context
// ---------------------------------------------------------------------------
test('R8 language from the source report, today\'s time zone, chart from the report; quote has no request_id/expected_spend', async () => {
  const { context, page, calls } = await setup({
    chart: true, timezoneId: 'Asia/Tokyo',
    src: { category: 'weekly_review', language: 'tr', chart_id: 'chart-src', timezone: 'America/New_York', period_type: 'rolling_7d' },
    quote: seq(Q.none(SRC), Q.sub), start: () => startOk('NEW'),
  });
  try {
    await page.evaluate(() => setLocale('en'));
    await page.click('#regenBtn');
    await page.waitForSelector('.regen-confirm-btn');
    await page.click('.regen-confirm-btn');
    await until(() => calls.start.length === 1, '/start');
    for (const q of calls.quote) {
      quoteClean(q.body, 'quote');
      assert.equal(q.body.language, 'tr');
      assert.equal(q.body.chart_id, 'chart-src');
      assert.equal(q.body.timezone, 'Asia/Tokyo');
    }
    const b = calls.start[0].body;
    assert.deepEqual(Object.keys(b).sort(), ['category', 'chart_id', 'expected_spend', 'force_regenerate', 'language', 'request_id', 'timezone']);
    assert.equal(b.language, 'tr');
    assert.equal(b.chart_id, 'chart-src');
    assert.equal(b.timezone, 'Asia/Tokyo');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// R9 uncertain forced request
// ---------------------------------------------------------------------------
test('R9 a forced /start that is aborted is resent with the same id and bytes; the same after a reload', async () => {
  const { context, page, calls, reload } = await setup({
    clock: true, quote: seq(Q.none(SRC), Q.sub), start: (b, n) => (n === 1 ? 'abort' : n === 2 ? never() : startOk('NEW')),
  });
  try {
    await page.click('#regenBtn');
    await page.waitForSelector('.regen-confirm-btn');
    await page.click('.regen-confirm-btn');
    await until(() => calls.start.length === 1, 'the first send');
    for (let i = 0; i < 20 && calls.start.length < 2; i++) { await page.clock.fastForward(2_000); await nextFrame(page); await delay(20); }
    await until(() => calls.start.length === 2, 'the automatic resend');
    assert.equal(calls.start[1].raw, calls.start[0].raw);
    assert.equal(calls.start[0].body.force_regenerate, true);
    const key = keyFor('u1', calls.start[0].body.request_id);
    assert.equal((await pendingRecord(page, key)).source_session_id, SRC);
    await reload();
    for (let i = 0; i < 20 && calls.start.length < 3; i++) { await page.clock.fastForward(2_000); await delay(20); }
    await until(() => calls.start.length === 3, 'the resend after the reload');
    assert.equal(calls.start[2].raw, calls.start[0].raw);
    for (const s of calls.start) assert.ok(!s.raw.includes(SRC), 'the source id is not sent');
    await page.waitForFunction(k => !sessionStorage.getItem(k), key);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// R10 spend_changed
// ---------------------------------------------------------------------------
test('R10 spend_changed on a forced /start: same force, a new confirm (subscription too), a NEW request_id', async () => {
  const { context, page, calls } = await setup({
    quote: seq(Q.none(SRC), Q.sub), start: (b, n) => (n === 1 ? [409, { error: 'spend_changed', detail: 'x' }] : startOk('NEW')),
  });
  try {
    await page.click('#regenBtn');
    await page.waitForSelector('.regen-confirm-btn');
    await page.click('.regen-confirm-btn');
    await until(() => calls.start.length === 1, '/start');
    await until(() => calls.quote.length === 3, 'the new quote');
    assert.equal(calls.quote[2].body.force_regenerate, true, 'same force value');
    await page.waitForSelector('.regen-confirm-btn:not([disabled])');
    assert.ok((await text(page, '#chatMessages')).includes('Bu raporun bedeli değişti'));
    assert.deepEqual(await pendingKeys(page), [], 'record deleted');
    await settle(page);
    assert.equal(calls.start.length, 1, 'a new confirm is needed (subscription too)');
    await page.click('.regen-confirm-btn:not([disabled])');
    await until(() => calls.start.length === 2, 'the second /start');
    const [a, b] = calls.start.map(s => s.body);
    assert.notEqual(b.request_id, a.request_id);
    assert.equal(b.force_regenerate, true);
    assert.equal(b.expected_spend, 'subscription');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// R11 failed forced /start: "Önceki raporu aç"
// ---------------------------------------------------------------------------
for (const [err, msg] of [['request_failed', 'İstek tamamlanamadı, hakkın iade edildi.'], ['generation_expired', 'Yanıt süre sınırını aştı, hakkın iade edildi.']]) {
  test(`R11 (a) live 409 ${err}: refund message + "Önceki raporu aç" opens the source; badges only from the list`, async () => {
    const { context, page, calls } = await setup({
      quote: seq(Q.none(SRC), Q.sub), start: () => [409, { error: err, detail: 'x' }],
    });
    try {
      await page.click('#regenBtn');
      await page.waitForSelector('.regen-confirm-btn');
      await page.click('.regen-confirm-btn');
      await page.waitForSelector('.prev-report-btn');
      assert.ok((await lastError(page)).includes(msg));
      assert.deepEqual(await pendingKeys(page), []);
      const before = calls.detail.length;
      await page.click('.prev-report-btn');
      await page.waitForSelector(`.chat-bubble.assistant >> text=Rapor metni ${SRC}`);
      assert.deepEqual(calls.detail.slice(before), [SRC]);
      assert.equal(calls.start.length, 1, 'no new production');
      await openReports(page);
      await page.waitForSelector(`#reportsList .report-row[data-session-id="${SRC}"]`);
      assert.equal(await count(page, `#reportsList .report-row[data-session-id="${SRC}"] .report-row-badge`), 0, 'no local badge');
    } finally { await context.close(); }
  });
}

test('R11 (b) reload: the forced /start resumes with the same id, request_failed shows "Önceki raporu aç" in My reports, opening the source', async () => {
  const hold = gate();
  const { context, page, calls, reload } = await setup({
    quote: seq(Q.none(SRC), Q.sub), start: (b, n) => (n === 1 ? hold.wait().then(never) : [409, { error: 'request_failed', detail: 'x' }]),
  });
  try {
    await page.click('#regenBtn');
    await page.waitForSelector('.regen-confirm-btn');
    await page.click('.regen-confirm-btn');
    await until(() => calls.start.length === 1, 'the first send');
    await reload();
    await until(() => calls.start.length === 2, 'the resend after the reload');
    assert.equal(calls.start[1].raw, calls.start[0].raw);
    for (const s of calls.start) assert.ok(!s.raw.includes(SRC), 'the source id is not sent');
    await page.waitForFunction(() => Object.keys(sessionStorage).every(k => !k.startsWith('stellafix_pending_interpret:')));
    await openReports(page);
    await page.waitForSelector('.pending-note .pending-prev-report');
    assert.ok((await text(page, '.pending-note')).includes('İstek tamamlanamadı, hakkın iade edildi.'));
    await page.click('.pending-note .pending-prev-report');
    await page.waitForSelector(`.chat-bubble.assistant >> text=Rapor metni ${SRC}`);
    assert.ok(calls.detail.includes(SRC));
    assert.equal(calls.start.length, 2, 'no new production');
  } finally { await context.close(); }
});

test('R11 (c) an old forced record without the source field gets no "Önceki raporu aç"', async () => {
  const seed = [seedRecord('u1', 'rid-old', { ...startBody('rid-old'), force_regenerate: true })];
  const { context, page, calls } = await setup({ open: false, seed, start: () => [409, { error: 'request_failed', detail: 'x' }] });
  try {
    await until(() => calls.start.length === 1, 'the resume');
    await page.waitForFunction(() => Object.keys(sessionStorage).every(k => !k.startsWith('stellafix_pending_interpret:')));
    await openReports(page);
    await page.waitForSelector('.pending-note');
    assert.equal(await count(page, '.pending-prev-report'), 0);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// R12 the old report stays readable
// ---------------------------------------------------------------------------
test('R12 during a regen the old report stays readable; badges come from the list', async () => {
  const hold = gate();
  let phase = 0;
  const list = () => (phase === 0 ? [sess(SRC)]
    : [sess('NEW', { status: 'pending' }), sess(SRC, { superseded: true, is_live: false })]);
  const { context, page, calls } = await setup({
    history: (a, off) => (off ? [] : list()), quote: seq(Q.none(SRC), Q.sub), start: () => hold.wait().then(() => startOk('NEW')),
  });
  try {
    await page.click('#regenBtn');
    await page.waitForSelector('.regen-confirm-btn');
    await page.click('.regen-confirm-btn');
    await until(() => calls.start.length === 1, '/start');
    phase = 1;
    await openReports(page);
    await page.waitForSelector(`#reportsList .report-row[data-session-id="NEW"]`);
    const badge = id => text(page, `#reportsList .report-row[data-session-id="${id}"] .report-row-badge`);
    assert.equal((await badge('NEW')).trim(), 'Hazırlanıyor');
    assert.equal((await badge(SRC)).trim(), 'Yeniden üretildi');
    await page.click(`#reportsList .report-row[data-session-id="${SRC}"]`);
    await page.waitForSelector(`.chat-bubble.assistant >> text=Rapor metni ${SRC}`);
    hold.open();
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// R13 report_changed
// ---------------------------------------------------------------------------
const RC = [409, { error: 'report_changed', detail: 'x' }];
async function toReportChanged(page, calls) {
  await page.click('#regenBtn');
  await page.waitForSelector('.regen-confirm-btn');
  await page.click('.regen-confirm-btn');
  await until(() => calls.start.length === 1, '/start');
  await page.waitForSelector('.chat-bubble.error >> text=Bu rapor az önce yeniden üretildi.');
  assert.deepEqual(await pendingKeys(page), [], 'record deleted');
  await until(() => calls.quote.length === 3, 'the check quote');
  assert.equal('force_regenerate' in calls.quote[2].body, false, 'the check quote has no force');
}

test('R13 (i) report_changed, check quote "none": the current report opens, no second /start', async () => {
  const cur = sess('CUR');
  // The check quote is held until the message is checked: "none" opens the
  // current report, which replaces the view and the message with it.
  const hold = gate();
  const { context, page, calls } = await setup({
    others: [cur], quote: seq(Q.none(SRC), Q.sub, () => hold.wait().then(Q.none('CUR'))), start: () => RC,
  });
  try {
    await toReportChanged(page, calls);
    hold.open();
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni CUR');
    await settle(page);
    assert.equal(calls.start.length, 1);
  } finally { await context.close(); }
});

test('R13 (ii) report_changed, check quote subscription: "Aboneliğin kapsamında üret"; /start only on press, new id, no force', async () => {
  const { context, page, calls } = await setup({ quote: seq(Q.none(SRC), Q.sub, Q.sub), start: (b, n) => (n === 1 ? RC : startOk('NEW')) });
  try {
    await toReportChanged(page, calls);
    await page.waitForSelector('.quote-generate-btn >> text=Aboneliğin kapsamında üret');
    await settle(page);
    assert.equal(calls.start.length, 1, 'no automatic /start');
    await page.click('.quote-generate-btn');
    await until(() => calls.start.length === 2, 'the second /start');
    const [a, b] = calls.start.map(s => s.body);
    assert.notEqual(b.request_id, a.request_id);
    assert.equal('force_regenerate' in b, false);
    assert.equal(b.expected_spend, 'subscription');
  } finally { await context.close(); }
});

for (const [name, credits] of [['balance 2', () => ({ report_credits: 2 })], ['balance 0', () => ({ report_credits: 0 })]]) {
  test(`R13 (iii) report_changed, check quote report_credit, ${name}`, async () => {
    const { context, page, calls } = await setup({
      credits, quote: seq(Q.none(SRC), Q.sub, Q.credit), start: (b, n) => (n === 1 ? RC : startOk('NEW')),
    });
    try {
      await toReportChanged(page, calls);
      if (name === 'balance 0') {
        await page.waitForSelector('.chat-bubble >> text=Rapor hakkın yok.');
        assert.equal(await count(page, '.quote-generate-btn'), 0);
        await settle(page);
        assert.equal(calls.start.length, 1);
        return;
      }
      await page.waitForSelector('.quote-generate-btn >> text=1 rapor hakkı kullanarak üret');
      await settle(page);
      assert.equal(calls.start.length, 1);
      await page.click('.quote-generate-btn');
      await until(() => calls.start.length === 2, 'the second /start');
      assert.equal(await count(page, '.regen-confirm-btn:not([disabled]), .quote-confirm-btn'), 0, 'no second confirm');
      assert.equal(calls.start[1].body.expected_spend, 'report_credit');
      assert.equal('force_regenerate' in calls.start[1].body, false);
    } finally { await context.close(); }
  });
}

// ---------------------------------------------------------------------------
// R14 double clicks
// ---------------------------------------------------------------------------
test('R14 double click on the button: one quote flow; double click on the confirm: one /start', async () => {
  const hold = gate();
  const { context, page, calls } = await setup({
    quote: seq(() => hold.wait().then(Q.none(SRC)), Q.sub), start: () => startOk('NEW'),
  });
  try {
    await page.evaluate(() => { const b = document.getElementById('regenBtn'); b.click(); b.click(); });
    await page.click('#regenBtn');
    await until(() => calls.quote.length === 1, 'the first quote');
    hold.open();
    await page.waitForSelector('.regen-confirm-btn');
    await settle(page);
    assert.equal(calls.quote.length, 2, 'one flow: a + b');
    assert.equal(await count(page, '.regen-confirm-btn'), 1);
    await page.evaluate(() => { const b = document.querySelector('.regen-confirm-btn'); b.click(); b.click(); });
    await settle(page);
    assert.equal(calls.start.length, 1);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// R15 leaving the flow
// ---------------------------------------------------------------------------
const LEAVE = {
  account: async page => { await logoutViaMenu(page); await loginAs(page, U2); },
  report: async page => { await openSource(page, 'OTHER'); },
  categories: async page => { await page.click('#chatBackBtn'); await page.waitForSelector('#categoryPanel', { state: 'visible' }); },
};
// For "categories" the source is opened by a category click, so "back" goes to the grid.
async function setupLeave(how, quote) {
  const other = sess('OTHER');
  if (how !== 'categories') return setup({ others: [other], verify: () => U2, quote });
  const det = { ...sess(SRC, { category: 'career' }), messages: msgsOf(SRC) };
  const r = await openPage({ detail: () => det, quote: (b, n) => (n === 1 ? Q.none(SRC)() : quote(b, n - 1)) });
  await clickCategory(r.page, 'career');
  await r.page.waitForSelector(`.chat-bubble.assistant >> text=Rapor metni ${SRC}`);
  return r;
}
for (const how of Object.keys(LEAVE)) {
  test(`R15 confirm open, then ${how} changes: the confirm sends nothing`, async () => {
    const { context, page, calls } = await setupLeave(how, seq(Q.none(SRC), Q.sub));
    try {
      await page.click('#regenBtn');
      const btn = await page.waitForSelector('.regen-confirm-btn');
      await LEAVE[how](page);
      await btn.evaluate(b => b.click());
      await settle(page);
      assert.equal(calls.start.length, 0);
    } finally { await context.close(); }
  });

  test(`R15 a delayed forced quote arriving after ${how} changes shows nothing`, async () => {
    const hold = gate();
    const { context, page, calls } = await setupLeave(how, seq(Q.none(SRC), () => hold.wait().then(Q.sub)));
    try {
      const q0 = calls.quote.length;
      await page.click('#regenBtn');
      await until(() => calls.quote.length === q0 + 2, 'the forced quote');
      await LEAVE[how](page);
      const bubbles = await count(page, '#chatMessages .chat-bubble');
      const resp = page.waitForResponse(r => r.url().endsWith('/interpret/quote'));
      hold.open();
      await resp;
      await settle(page);
      assert.equal(await count(page, '.regen-confirm-btn'), 0);
      assert.equal(await count(page, '#chatMessages .chat-bubble'), bubbles, 'nothing new on screen');
      assert.equal(calls.start.length, 0);
    } finally { await context.close(); }
  });
}

// ---------------------------------------------------------------------------
// R16 health disabled
// ---------------------------------------------------------------------------
test('R16 health disabled: 403 category_disabled message, the open report stays readable, no /start', async () => {
  const { context, page, calls } = await setup({ src: { category: 'health' }, quote: () => [403, { error: 'category_disabled', detail: 'raw' }] });
  try {
    await page.click('#regenBtn');
    await page.waitForSelector('.chat-bubble.error');
    assert.ok((await lastError(page)).includes('Bu kategori şu anda kullanılamıyor.'));
    assert.ok(!(await lastError(page)).includes('raw'));
    assert.ok(await count(page, `.chat-bubble.assistant >> text=Rapor metni ${SRC}`));
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// R17, R18 picker returns to the same step
// ---------------------------------------------------------------------------
async function routeTimezone(page) {
  await page.route(`${API}/api/v1/timezone**`, r => json(r, 200, { timezone: 'Europe/Berlin' }));
}
async function pickBerlin(page) {
  await page.waitForSelector('#tzCountryInput');
  await page.fill('#tzCountryInput', 'Almanya');
  await page.click('#tzCountryDropdown .city-option');
  await page.waitForSelector('#tzCityInput', { state: 'visible' });
  await page.fill('#tzCityInput', 'Berlin');
  await page.click('#tzCityDropdown .city-option');
}
function breakTz() {
  const orig = Intl.DateTimeFormat.prototype.resolvedOptions;
  Intl.DateTimeFormat.prototype.resolvedOptions = function () { return { ...orig.call(this), timeZone: undefined }; };
}
const weekly = { category: 'weekly_review', period_type: 'rolling_7d', timezone: 'Europe/Istanbul' };

for (const [name, opts, quote] of [
  ['missing time zone', { afterClock: breakTz }, seq(Q.sub)],
  ['422 timezone_invalid', {}, seq(() => invalidTz, Q.sub)],
]) {
  test(`R17 picker on the first quote (${name}): continues from step (a) with the context, not the category flow`, async () => {
    const { context, page, calls } = await setup({ src: weekly, quote, start: () => startOk('NEW'), ...opts });
    try {
      await routeTimezone(page);
      await page.click('#regenBtn');
      await pickBerlin(page);
      await page.waitForSelector('.regen-confirm-btn');
      const q = calls.quote[calls.quote.length - 1].body;
      assert.equal(q.timezone, 'Europe/Berlin');
      assert.equal('force_regenerate' in q, false, 'step (a)');
      assert.equal(q.chart_id, 'chart-1');
      assert.equal(q.category, 'weekly_review');
      await settle(page);
      assert.equal(calls.start.length, 0, 'the category flow would have started without a confirm');
    } finally { await context.close(); }
  });
}

test('R18 picker on the forced quote: the forced quote is redone, then the confirm; /start with force and the new time zone', async () => {
  const { context, page, calls } = await setup({ src: weekly, quote: seq(Q.none(SRC), () => invalidTz, Q.sub), start: () => startOk('NEW') });
  try {
    await routeTimezone(page);
    await page.click('#regenBtn');
    await pickBerlin(page);
    await page.waitForSelector('.regen-confirm-btn');
    assert.equal(calls.quote.length, 3);
    assert.equal(calls.quote[2].body.force_regenerate, true);
    assert.equal(calls.quote[2].body.timezone, 'Europe/Berlin');
    await settle(page);
    assert.equal(calls.start.length, 0, 'no /start before the confirm');
    await page.click('.regen-confirm-btn');
    await until(() => calls.start.length === 1, '/start');
    assert.equal(calls.start[0].body.force_regenerate, true);
    assert.equal(calls.start[0].body.timezone, 'Europe/Berlin');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// A: /start 422 time zone in the regen view -> back to the regen quote step
// ---------------------------------------------------------------------------
for (const forced of [true, false]) {
  test(`A ${forced ? '(a) forced' : '(b) unforced'} /start 422: the picker returns to the ${forced ? 'forced' : 'first'} quote with the source chart; a new confirm and a new request_id`, async () => {
    const { context, page, calls } = await setup({
      chart: true, src: { ...weekly, chart_id: 'chart-9' },
      quote: forced ? seq(Q.none(SRC), Q.sub) : seq(Q.sub), start: (b, n) => (n === 1 ? invalidTz : startOk('NEW')),
    });
    try {
      await routeTimezone(page);
      await page.click('#regenBtn');
      await page.waitForSelector('.regen-confirm-btn');
      const q0 = calls.quote.length;
      await page.click('.regen-confirm-btn');
      await pickBerlin(page);
      await until(() => calls.quote.length === q0 + 1, 'the quote after the picker');
      const q = calls.quote[q0].body;
      assert.equal(q.chart_id, 'chart-9', 'the source chart, not the selected chart');
      assert.equal(q.timezone, 'Europe/Berlin');
      assert.equal(q.force_regenerate === true, forced, 'the same force value');
      await settle(page);
      assert.equal(calls.start.length, 1, 'no /start before the new confirm');
      await page.waitForSelector('.regen-confirm-btn:not([disabled])');
      assert.equal(calls.quote.length, q0 + 1, 'one quote after the picker');
      assert.deepEqual(await pendingKeys(page), [], 'the 422 record is deleted');
      await settle(page);
      assert.equal(calls.start.length, 1, 'still no /start before the new confirm');
      await page.click('.regen-confirm-btn:not([disabled])');
      await until(() => calls.start.length === 2, 'the second /start');
      const [a, b] = calls.start.map(s => s.body);
      assert.notEqual(b.request_id, a.request_id);
      assert.equal(b.chart_id, 'chart-9');
      assert.equal(b.force_regenerate === true, forced);
      assert.equal(b.timezone, 'Europe/Berlin');
    } finally { await context.close(); }
  });
}

test('A (c) the flow becomes invalid while the picker is open (another report opens): the city pick sends nothing', async () => {
  const lookup = gate();
  const { context, page, calls } = await setup({
    chart: true, src: { ...weekly, chart_id: 'chart-9' }, others: [sess('OTHER')],
    quote: seq(Q.none(SRC), Q.sub), start: () => invalidTz,
  });
  try {
    await page.route(`${API}/api/v1/timezone**`, async r => { await lookup.wait(); return json(r, 200, { timezone: 'Europe/Berlin' }); });
    await page.click('#regenBtn');
    await page.waitForSelector('.regen-confirm-btn');
    await page.click('.regen-confirm-btn');
    await pickBerlin(page);
    await openSource(page, 'OTHER');
    const q = calls.quote.length;
    lookup.open();
    await page.waitForResponse(r => r.url().includes('/api/v1/timezone'));
    await settle(page);
    assert.equal(calls.quote.length, q, 'no quote');
    assert.equal(calls.start.length, 1, 'no /start');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// B: the flow closes when the check loop ends; sent records are untouched
// ---------------------------------------------------------------------------
test('B the check loop expires: "Yeniden üret" starts a new flow (a new quote)', async () => {
  const { context, page, calls } = await setup({ clock: true, quote: seq(Q.none(SRC), () => GIP) });
  try {
    await page.click('#regenBtn');
    await page.waitForSelector('.quote-stop-btn');
    for (let i = 0; i < 40 && !(await text(page, '#chatMessages')).includes('Rapor hazırlanırken bir sorun olmuş olabilir'); i++) {
      await page.clock.fastForward(30_000); await nextFrame(page); await delay(20);
    }
    assert.ok((await text(page, '#chatMessages')).includes('Rapor hazırlanırken bir sorun olmuş olabilir'), 'the loop expired');
    const q = calls.quote.length;
    await page.click('#regenBtn');
    await until(() => calls.quote.length === q + 1, 'a new quote');
    assert.equal('force_regenerate' in calls.quote[q].body, false, 'a new flow starts at step (a)');
  } finally { await context.close(); }
});

test('B "Beklemeyi durdur" on the check loop: "Yeniden üret" starts a new flow (a new quote)', async () => {
  const { context, page, calls } = await setup({ quote: seq(Q.none(SRC), () => GIP) });
  try {
    await page.click('#regenBtn');
    await page.waitForSelector('.quote-stop-btn');
    await page.click('.quote-stop-btn');
    const q = calls.quote.length;
    await page.click('#regenBtn');
    await until(() => calls.quote.length === q + 1, 'a new quote');
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

test('B a paused forced record stays exactly as it is (id, bytes, paused) when a new flow runs; it is not resent', async () => {
  const body = { chart_id: 'chart-1', category: 'personality', language: 'tr', force_regenerate: true, request_id: 'rid-paused', expected_spend: 'subscription' };
  const [key, raw0] = seedRecord('u1', 'rid-paused', body, { paused: true });
  const raw = JSON.stringify({ ...JSON.parse(raw0), source_session_id: SRC });
  const { context, page, calls } = await setup({ seed: [[key, raw]], quote: seq(Q.none(SRC), Q.sub), start: () => startOk('NEW') });
  try {
    await page.click('#regenBtn');
    await page.waitForSelector('.regen-confirm-btn');
    await settle(page);
    assert.equal(calls.start.length, 0, 'no /start before the confirm');
    assert.equal(await page.evaluate(k => sessionStorage.getItem(k), key), raw, 'untouched while the flow is open');
    await page.click('.regen-confirm-btn');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni NEW');
    await settle(page);
    assert.equal(calls.start.length, 1);
    assert.notEqual(calls.start[0].body.request_id, 'rid-paused');
    assert.ok(calls.start.every(s => s.body.request_id !== 'rid-paused'), 'the paused record is not resent');
    assert.equal(await page.evaluate(k => sessionStorage.getItem(k), key), raw, 'same id, bytes and paused state');
  } finally { await context.close(); }
});

test('B a forced /start in flight: a new flow on the same source never sends a second /start with that id', async () => {
  const { context, page, calls } = await setup({ quote: seq(Q.none(SRC), Q.sub), start: (b, n) => (n === 1 ? never() : startOk('NEW2')) });
  try {
    await page.click('#regenBtn');
    await page.waitForSelector('.regen-confirm-btn');
    await page.click('.regen-confirm-btn');
    await until(() => calls.start.length === 1, 'the first /start');
    const first = calls.start[0].body.request_id;
    await openSource(page, SRC);
    await page.click('#regenBtn');
    await page.waitForSelector('.regen-confirm-btn');
    await page.click('.regen-confirm-btn');
    await until(() => calls.start.length === 2, 'the second /start');
    await settle(page);
    assert.equal(calls.start.length, 2);
    assert.equal(calls.start.filter(s => s.body.request_id === first).length, 1, 'the in-flight id is sent once');
    assert.equal(await pendingKeys(page).then(k => k.includes(keyFor('u1', first))), true, 'the in-flight record is kept');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// C: a final failure that arrives while the user is elsewhere -> a note
// ---------------------------------------------------------------------------
const FAIL = { request_failed: 'İstek tamamlanamadı, hakkın iade edildi.', generation_expired: 'Yanıt süre sınırını aştı, hakkın iade edildi.' };
const LEAVE_TO = {
  reports: async page => { await openReports(page); },
  'another report': async page => { await openSource(page, 'OTHER'); },
};
async function forcedStartHeld(err, extra = {}) {
  const hold = gate();
  const r = await setup({
    others: [sess('OTHER')], quote: seq(Q.none(SRC), Q.sub), ...extra,
    start: () => hold.wait().then(() => [409, { error: err, detail: 'x' }]),
  });
  await r.page.click('#regenBtn');
  await r.page.waitForSelector('.regen-confirm-btn');
  await r.page.click('.regen-confirm-btn');
  await until(() => r.calls.start.length === 1, '/start');
  return { ...r, hold };
}
for (const err of Object.keys(FAIL)) {
  for (const where of Object.keys(LEAVE_TO)) {
    test(`C forced /start ${err} arrives while on ${where}: a note in My reports with "Önceki raporu aç" (source), no "Sürdür", record deleted`, async () => {
      const { context, page, calls, hold } = await forcedStartHeld(err);
      try {
        await LEAVE_TO[where](page);
        const resp = page.waitForResponse(r => r.url().endsWith('/interpret/start'));
        hold.open();
        await resp;
        await page.waitForFunction(() => Object.keys(sessionStorage).every(k => !k.startsWith('stellafix_pending_interpret:')));
        await openReports(page);
        await page.waitForSelector('#pendingNotes .pending-note .pending-prev-report');
        assert.ok((await text(page, '#pendingNotes .pending-note')).includes(FAIL[err]));
        assert.equal(await count(page, '#pendingNotes .pending-resume'), 0, 'no "Sürdür" on a note');
        assert.equal(await count(page, '#pendingNotes .pending-item'), 0, 'not styled as an unfinished request');
        assert.equal(await page.$eval('#pendingItemsTitle', e => e.style.display), 'none', 'no "Yarım kalan istekler" title without unfinished requests');
        assert.ok((await text(page, '#pendingNotesBox')).includes('Sonuçlanan istekler'));
        const before = calls.detail.length;
        await page.click('#pendingNotes .pending-prev-report');
        await page.waitForSelector(`.chat-bubble.assistant >> text=Rapor metni ${SRC}`);
        assert.deepEqual(calls.detail.slice(before), [SRC]);
        assert.equal(calls.start.length, 1);
      } finally { await context.close(); }
    });
  }

  test(`C forced /start ${err}: the account changes before the response -> no note for the new account`, async () => {
    let tok = U2;
    const { context, page, hold } = await forcedStartHeld(err, { verify: () => tok });
    try {
      await logoutViaMenu(page);
      await loginAs(page, U2);
      const resp = page.waitForResponse(r => r.url().endsWith('/interpret/start'));
      hold.open();
      await resp;
      await settle(page);
      await openReports(page);
      await settle(page);
      assert.equal(await count(page, '.pending-note'), 0, 'no note on the new account');
      // Back to the first account: report what is shown.
      await logoutViaMenu(page);
      tok = U1;
      await loginAs(page, tok);
      await openReports(page);
      await settle(page);
      assert.equal(await count(page, '.pending-note'), 0, 'the old result is not carried over to a later login either');
      assert.deepEqual(await pendingKeys(page), [], 'no record');
    } finally { await context.close(); }
  });
}

test('C the same result handled twice (live path and a resume) gives one note', async () => {
  const { context, page } = await setup({ open: false });
  try {
    const n = await page.evaluate(() => {
      const rec = makePendingRecord('start', { chart_id: 'chart-1', category: 'personality', language: 'tr', force_regenerate: true }, 'subscription');
      rec.source_session_id = 'src-session-77';
      const out = { ok: false, status: 409, body: { error: 'request_failed' }, final: true, account: currentAccountKey() };
      applyGenResult(rec, out, { live: true, view: chatViewId - 1 }); // live, another view
      applyGenResult(rec, out, { live: false, view: chatViewId });     // resume on load
      return pendingNotes.length;
    });
    assert.equal(n, 1);
    await openReports(page);
    assert.equal(await count(page, '#pendingNotes .pending-note'), 1);
  } finally { await context.close(); }
});

test('C notes are cleared on an explicit logout', async () => {
  const { context, page, calls, hold } = await forcedStartHeld('request_failed', { verify: () => U1 });
  try {
    await openReports(page);
    const resp = page.waitForResponse(r => r.url().endsWith('/interpret/start'));
    hold.open();
    await resp;
    await page.waitForSelector('#pendingNotes .pending-note');
    await logoutViaMenu(page);
    await loginAs(page, U1);
    await openReports(page);
    await settle(page);
    assert.equal(await count(page, '.pending-note'), 0);
    assert.equal(calls.start.length, 1);
  } finally { await context.close(); }
});

test('C unforced /start request_failed while elsewhere: a note without "Önceki raporu aç"', async () => {
  const hold = gate();
  const { context, page } = await setup({
    others: [sess('OTHER')], quote: Q.sub, start: () => hold.wait().then(() => [409, { error: 'request_failed', detail: 'x' }]),
  });
  try {
    await page.click('#regenBtn');
    await page.waitForSelector('.regen-confirm-btn');
    await page.click('.regen-confirm-btn');
    await openSource(page, 'OTHER');
    const resp = page.waitForResponse(r => r.url().endsWith('/interpret/start'));
    hold.open();
    await resp;
    await openReports(page);
    await page.waitForSelector('#pendingNotes .pending-note');
    assert.equal(await count(page, '.pending-prev-report'), 0);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// Note labels: a finished request is not labelled as an unfinished one
// ---------------------------------------------------------------------------
for (const [locale, label, unfinished] of [['tr', 'Rapor isteği: ', 'Yarım kalan'], ['en', 'Report request: ', 'Unfinished']]) {
  test(`note label (${locale}): a forced request_failed note says "${label}…", never "${unfinished}"`, async () => {
    const { context, page, hold } = await forcedStartHeld('request_failed');
    try {
      await page.evaluate(l => setLocale(l), locale);
      await openSource(page, 'OTHER');
      const resp = page.waitForResponse(r => r.url().endsWith('/interpret/start'));
      hold.open();
      await resp;
      await openReports(page);
      await page.waitForSelector('#pendingNotes .pending-note');
      const shown = (await text(page, '#pendingNotes .pending-note .pending-item-label')).trim();
      assert.ok(shown.startsWith(label), shown);
      assert.ok(!(await text(page, '#pendingNotesBox')).includes(unfinished), 'no unfinished-request wording in the notes');
    } finally { await context.close(); }
  });
}

for (const [locale, label] of [['tr', 'Soru'], ['en', 'Question']]) {
  test(`note label (${locale}): a question note from the background (resume on load) says "${label}"`, async () => {
    const seed = [seedRecord('u1', 'rid-q', { session_id: 's1', question: 'Soru?', request_id: 'rid-q' }, { kind: 'continue' })];
    const { context, page, calls } = await setup({ open: false, seed, cont: () => [409, { error: 'request_failed', detail: 'x' }] });
    try {
      await until(() => calls.continue.length === 1, 'the resumed /continue');
      await page.waitForFunction(() => Object.keys(sessionStorage).every(k => !k.startsWith('stellafix_pending_interpret:')));
      await page.evaluate(l => setLocale(l), locale);
      await openReports(page);
      await page.waitForSelector('#pendingNotes .pending-note');
      assert.equal((await text(page, '#pendingNotes .pending-note .pending-item-label')).trim(), label);
    } finally { await context.close(); }
  });
}

// ---------------------------------------------------------------------------
// Category flow: /start 422 time zone -> the picker returns to the category
// ---------------------------------------------------------------------------
test('category /start 422 (a): record deleted, the picker re-runs the category quote with the new time zone, a NEW request_id, the old id never again', async () => {
  const { context, page, calls } = await openPage({ quote: Q.sub, start: (b, n) => (n === 1 ? invalidTz : startOk('W1')) });
  try {
    await routeTimezone(page);
    await clickCategory(page, 'weekly_review');
    await until(() => calls.start.length === 1, 'the first /start');
    const first = calls.start[0].body.request_id;
    await page.waitForSelector('#tzCountryInput');
    await page.waitForFunction(k => !sessionStorage.getItem(k), keyFor('u1', first));
    const q = calls.quote.length;
    await pickBerlin(page);
    await until(() => calls.quote.length === q + 1, 'the category quote after the picker');
    assert.equal(calls.quote[q].body.timezone, 'Europe/Berlin');
    assert.equal(calls.quote[q].body.category, 'weekly_review');
    await until(() => calls.start.length === 2, 'the /start after the picker');
    const b = calls.start[1].body;
    assert.notEqual(b.request_id, first, 'a new request_id');
    assert.equal(b.timezone, 'Europe/Berlin');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni W1');
    await settle(page);
    assert.equal(calls.start.filter(s => s.body.request_id === first).length, 1, 'the old id is never sent again');
  } finally { await context.close(); }
});

test('category /start 422 (b): another category is chosen while the picker is open; the city pick sends nothing', async () => {
  const lookup = gate();
  const { context, page, calls } = await openPage({
    quote: b => (b.category === 'personality' ? Q.none('P')() : Q.sub()), start: () => invalidTz,
  });
  try {
    await page.route(`${API}/api/v1/timezone**`, async r => { await lookup.wait(); return json(r, 200, { timezone: 'Europe/Berlin' }); });
    await clickCategory(page, 'weekly_review');
    await until(() => calls.start.length === 1, 'the first /start');
    await pickBerlin(page);
    await page.click('#chatBackBtn');
    await clickCategory(page, 'personality');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni P');
    const q = calls.quote.length, s = calls.start.length;
    lookup.open();
    await page.waitForResponse(r => r.url().includes('/api/v1/timezone'));
    await settle(page);
    assert.equal(calls.quote.length, q, 'no quote');
    assert.equal(calls.start.length, s, 'no /start');
  } finally { await context.close(); }
});
