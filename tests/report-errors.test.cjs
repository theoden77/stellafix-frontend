// Browser integration test for the error messages: chart not found, a
// disabled category on an open report, and an unknown 409. The API is mocked
// with page.route; no real backend is called. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness, TEST_TIMEOUT_MS, HOOK_TIMEOUT_MS } = require('./helpers/harness.cjs');
const {
  useHarness, Q, sess, openPage, clickCategory, pendingKeys, text, count, openReports, nextFrame,
} = require('./helpers/interpret-page.cjs');

let h;
before(async () => { h = await startHarness(); useHarness(h); }, { timeout: HOOK_TIMEOUT_MS });
after(async () => { await h?.close(); }, { timeout: HOOK_TIMEOUT_MS });

const lastError = page => page.locator('.chat-bubble.error').last().textContent();

for (const [locale, main, extra] of [
  ['tr', 'Bu kategori şu anda kullanılamıyor.', 'Rapor okunabilir, yeni soru şu an alınamıyor.'],
  ['en', 'This category is currently unavailable.', "You can read the report, but new questions can't be taken right now."],
]) {
  test(`403 category_disabled on an open saved report (${locale}): both lines, the report stays, the record is deleted`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const hs = sess('hs', { category: 'health' });
    const { context, page, calls } = await openPage({
      chart: false, history: () => [hs], detail: () => ({ ...hs, messages: [{ role: 'assistant', content: 'Rapor metni hs' }] }),
      cont: () => [403, { error: 'category_disabled', detail: 'raw backend text' }],
    });
    try {
      await page.evaluate(l => setLocale(l), locale);
      await openReports(page);
      await page.click('#reportsList .report-row[data-session-id="hs"]');
      await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni hs');
      await page.fill('#chatInput', 'Soru');
      await page.click('#chatSendBtn');
      await page.waitForSelector('.chat-bubble.error');
      const shown = await lastError(page);
      assert.ok(shown.includes(main), shown);
      assert.ok(shown.includes(extra), shown);
      assert.ok(!shown.includes('raw backend text'), 'the backend detail is not shown');
      assert.ok(await count(page, '.chat-bubble.assistant >> text=Rapor metni hs'));
      assert.deepEqual(await pendingKeys(page), []);
      assert.equal(calls.continue.length, 1);
    } finally { await context.close(); }
  });
}

test('403 category_disabled on a category click (no open report): only the first line', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await openPage({ quote: () => [403, { error: 'category_disabled', detail: 'raw' }] });
  try {
    await clickCategory(page, 'health');
    await page.waitForSelector('.chat-bubble.error');
    const shown = await lastError(page);
    assert.ok(shown.includes('Bu kategori şu anda kullanılamıyor.'), shown);
    assert.ok(!shown.includes('Rapor okunabilir'), shown);
  } finally { await context.close(); }
});

for (const [locale, msg] of [['tr', 'Harita bulunamadı, yeniden hesapla.'], ['en', "The chart couldn't be found; please calculate it again."]]) {
  test(`404 on the quote (${locale}): "${msg}"`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { context, page, calls } = await openPage({ quote: () => [404, { detail: 'raw backend text' }] });
    try {
      await page.evaluate(l => setLocale(l), locale);
      await clickCategory(page, 'personality');
      await page.waitForSelector('.chat-bubble.error');
      assert.equal((await lastError(page)).trim(), msg);
      assert.equal(calls.start.length, 0);
    } finally { await context.close(); }
  });

  test(`404 on /start (${locale}): "${msg}", record deleted`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { context, page, calls } = await openPage({ quote: Q.sub, start: () => [404, { detail: 'raw backend text' }] });
    try {
      await page.evaluate(l => setLocale(l), locale);
      await clickCategory(page, 'personality');
      await page.waitForSelector('.chat-bubble.error');
      assert.ok((await lastError(page)).includes(msg), await lastError(page));
      assert.equal(calls.start.length, 1);
      assert.deepEqual(await pendingKeys(page), []);
    } finally { await context.close(); }
  });
}

test('an unknown 409 on /start (regenerate_unavailable): the general message, record deleted, no automatic retry', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({
    clock: true, quote: Q.sub, start: () => [409, { error: 'regenerate_unavailable', detail: 'raw backend text' }],
  });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.chat-bubble.error');
    assert.ok((await lastError(page)).includes('Bir şeyler ters gitti, tekrar dene.'), await lastError(page));
    assert.deepEqual(await pendingKeys(page), []);
    assert.equal(await count(page, '.pending-retry-btn'), 0);
    for (let i = 0; i < 8; i++) await page.clock.fastForward(60_000);
    await nextFrame(page);
    assert.equal(calls.start.length, 1, 'no automatic retry');
    assert.equal(calls.quote.length, 1);
  } finally { await context.close(); }
});

test('an unknown 409 on the quote: the general message and no automatic check', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ clock: true, quote: () => [409, { error: 'regenerate_unavailable', detail: 'raw' }] });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.chat-bubble.error');
    assert.equal((await lastError(page)).trim(), 'Bir şeyler ters gitti, tekrar dene.');
    for (let i = 0; i < 8; i++) await page.clock.fastForward(60_000);
    await nextFrame(page);
    assert.equal(calls.quote.length, 1);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});
