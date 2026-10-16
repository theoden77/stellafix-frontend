// Browser integration test for the bounded automatic wait: approved requests
// resent with the same request_id and body, the quote check loop that never
// starts a generation, report_not_ready polling, pending report and list
// polling, 429 back-off, hidden tabs, the 60 s notice, "Beklemeyi durdur",
// the shared send queue and the 330 s window. The API is mocked with
// page.route; no real backend is called. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./helpers/harness.cjs');
const {
  useHarness, U1, U2, delay, gate, never, until, Q, startOk, bal, sess, detailOf, openPage, clickCategory, sendTimes,
  passGap, pendingKeys, pendingRecord, keyFor, text, count, openReports, logoutViaMenu, loginAs, nextFrame, seedRecord, startBody,
} = require('./helpers/interpret-page.cjs');

let h;
before(async () => { h = await startHarness(); useHarness(h); });
after(async () => { await h?.close(); });

const RIP = [409, { error: 'request_in_progress', detail: 'x' }];
const GIP = [409, { error: 'generation_in_progress', detail: 'x' }];
const pageNow = page => page.evaluate(() => Date.now());
async function untilSends(page, n, what = `${n} sends`) {
  const end = Date.now() + 5000;
  while ((await page.evaluate(() => window.__genSends.length)) < n) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}
async function untilAsync(cond, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}
// Expects the next automatic send `delayMs` after the previous result: the
// page asks for a timer of exactly `delayMs` after that result, nothing leaves
// the page before the timer fires, and the send leaves right after it. Under
// load the fake page clock can step back a few hundred ms, so the clock
// boundaries are checked with a 1000 ms margin; the requested delay is exact.
async function expectAutoSend(page, delayMs) {
  await untilAsync(async () => (await sendTimes(page)).slice(-1)[0].respAt !== null, 'the previous response');
  const log = await sendTimes(page);
  const prev = log[log.length - 1];
  // A timer asked for after the previous send (by order, not by clock reading).
  const findTimer = () => page.evaluate(([d, from]) => window.__timers.findLastIndex((x, i) => i >= from && x.ms === d), [delayMs, prev.timers]);
  await untilAsync(async () => (await findTimer()) !== -1, `a ${delayMs} ms timer after the previous result`);
  const index = await findTimer();
  const timerOf = () => page.evaluate(i => window.__timers[i], index);
  const timer = await timerOf();
  const early = timer.at + delayMs - 1000 - await pageNow(page);
  if (early > 0) await page.clock.fastForward(early);
  await nextFrame(page);
  assert.equal((await sendTimes(page)).length, log.length, `nothing sent before ${delayMs} ms`);
  await page.clock.fastForward(Math.max(1, timer.at + delayMs + 100 - await pageNow(page)));
  await untilSends(page, log.length + 1, `the send after ${delayMs} ms`);
  const next = (await sendTimes(page))[log.length];
  const fired = (await timerOf()).firedAt;
  assert.ok(fired !== null && next.at >= fired, 'sent only after the timer fired');
  const gap = next.at - timer.at;
  assert.ok(gap >= delayMs - 1000 && gap < delayMs + 1500, `send ${gap} ms after the timer was set for an expected ${delayMs} ms delay`);
  return next;
}
// Advances the page clock in steps until cond() holds (or fails after maxSteps).
async function driveUntil(page, cond, { step = 30_000, maxSteps = 40, what = 'condition' } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    if (await cond()) return;
    await page.clock.fastForward(step);
    await nextFrame(page);
    try { await untilAsync(cond, what, 150); return; } catch (e) { /* next step */ }
  }
  throw new Error(`${what} not reached`);
}
async function setHidden(page, hidden) {
  await page.evaluate(hd => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hd });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hd ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
// Page-side log of quote and read requests: [{path, at}] with the page clock at fetch time.
function logReads() {
  window.__reads = [];
  const orig = window.fetch;
  window.fetch = function (input) {
    const url = String(input && input.url ? input.url : input);
    const m = url.match(/\/api\/v1\/(interpret\/[^?]*)/);
    const p = orig.apply(this, arguments);
    if (m && !/\/(start|continue)$/.test(m[1])) {
      const entry = { path: m[1], at: Date.now(), respAt: null };
      window.__reads.push(entry);
      p.then(() => { entry.respAt = Date.now(); }, () => { entry.respAt = Date.now(); });
    }
    return p;
  };
}
const reads = (page, path) => page.evaluate(p => window.__reads.filter(r => r.path === p), path);
const stopped = (page, key) => page.waitForFunction(k => { const r = sessionStorage.getItem(k); return r && JSON.parse(r).paused === true; }, key);

// ---------------------------------------------------------------------------
// Test 9, approved request
// ---------------------------------------------------------------------------
test('9 approved: request_in_progress is resent with the same id and bytes after 10/15/20/30… s, stops at 330 s (paused), "Tekrar dene" resends', async () => {
  const { context, page, calls } = await openPage({ clock: true, start: (b, n) => (n <= 13 ? RIP : startOk('S1')) });
  try {
    await clickCategory(page, 'personality');
    await untilSends(page, 1);
    await page.waitForSelector('.pending-retry-btn');
    assert.match(await text(page, '#chatMessages'), /İsteğin hâlâ işleniyor\./);
    for (const d of [10_000, 15_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000]) {
      await expectAutoSend(page, d);
    }
    const log = await sendTimes(page);
    assert.equal(log.length, 13);
    await until(() => calls.start.length === 13, 'the mock saw 13 sends');
    assert.ok(calls.start.every(c => c.raw === calls.start[0].raw), 'same id and the same raw body on every resend');
    const key = keyFor('u1', calls.start[0].body.request_id);
    // The next delay would end at ~345 s; the window ends at 330 s.
    await page.clock.fastForward(log[0].at + 329_000 - await pageNow(page));
    await nextFrame(page);
    assert.equal((await pendingRecord(page, key)).paused, false);
    await page.clock.fastForward(2_000);
    await stopped(page, key);
    await page.clock.fastForward(600_000);
    await nextFrame(page);
    assert.equal((await sendTimes(page)).length, 13, 'no automatic request after the window');
    assert.deepEqual(await pendingKeys(page), [key], 'kept');
    await page.locator('.pending-retry-btn').last().click();
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(calls.start.length, 14);
    assert.equal(calls.start[13].raw, calls.start[0].raw);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// Test 9, not yet approved: a quote check never starts a generation
// ---------------------------------------------------------------------------
for (const [label, result, credits, button, spend] of [
  ['(d) subscription', Q.sub, 3, 'Aboneliğin kapsamında üret', 'subscription'],
  ['(e) report_credit', Q.credit, 3, '1 rapor hakkı kullanarak üret', 'report_credit'],
]) {
  test(`9 ${label} inside the loop: the loop stops on a priced "Üret" button; /start only when pressed`, async () => {
    const { context, page, calls } = await openPage({
      clock: true, afterClock: logReads, credits: () => ({ report_credits: credits }),
      quote: (b, n) => (n <= 2 ? GIP : result()),
    });
    try {
      await page.waitForFunction(c => creditBalance && creditBalance.report_credits === c, credits);
      await clickCategory(page, 'personality');
      await page.waitForSelector('.quote-check-btn');
      await driveUntil(page, async () => (await count(page, '.quote-generate-btn')) > 0, { step: 3_000, what: 'the Üret button' });
      const q = await reads(page, 'interpret/quote');
      assert.equal(q.length, 3);
      assert.ok(q[1].at - q[0].respAt >= 3_000 && q[2].at - q[1].respAt >= 5_000, 'quote checks 3 s and 5 s after the previous result');
      assert.equal(await text(page, '.quote-generate-btn'), button);
      assert.equal(await count(page, '.quote-confirm-btn'), 0, 'no second confirmation screen');
      await page.clock.fastForward(120_000);
      await nextFrame(page);
      assert.equal(calls.quote.length, 3, 'the loop stopped');
      assert.equal(calls.start.length, 0);
      await page.click('.quote-generate-btn');
      await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
      assert.equal(calls.start.length, 1);
      assert.equal(calls.start[0].raw, JSON.stringify(startBody(calls.start[0].body.request_id, 'personality', spend)));
    } finally { await context.close(); }
  });
}

for (const [label, result, expect] of [
  ['(a) subscription', Q.sub, { button: 'Aboneliğin kapsamında üret', spend: 'subscription' }],
  ['(b) report_credit', Q.credit, { button: '1 rapor hakkı kullanarak üret', spend: 'report_credit' }],
  ['(c) none', Q.none('saved9'), null],
]) {
  test(`9 ${label} after the window: "Tekrar kontrol et" makes one quote and never sends /start by itself`, async () => {
    let afterExpiry = false;
    const { context, page, calls } = await openPage({
      clock: true, credits: () => ({ report_credits: 3 }), quote: () => (afterExpiry ? result() : GIP),
    });
    try {
      await page.waitForFunction(() => creditBalance && creditBalance.report_credits === 3);
      await clickCategory(page, 'personality');
      await page.waitForSelector('.quote-check-btn');
      const expired = '.chat-bubble.error >> text=Rapor hazırlanırken bir sorun olmuş olabilir; birkaç dakika sonra tekrar dene.';
      await driveUntil(page, async () => (await count(page, expired)) > 0, { what: 'the expired message' });
      const polls = calls.quote.length;
      await page.clock.fastForward(600_000);
      await nextFrame(page);
      assert.equal(calls.quote.length, polls, 'no polling after the window');
      afterExpiry = true;
      await page.locator('.chat-bubble.error .quote-check-btn').last().click();
      if (!expect) {
        await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni saved9');
        assert.equal(calls.start.length, 0);
        return;
      }
      await page.waitForSelector('.quote-generate-btn');
      assert.equal(await text(page, '.quote-generate-btn'), expect.button);
      assert.equal(await count(page, '.quote-confirm-btn'), 0);
      await page.clock.fastForward(60_000);
      await nextFrame(page);
      assert.equal(calls.start.length, 0, 'nothing until the button is pressed');
      await page.click('.quote-generate-btn');
      await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
      assert.equal(calls.start.length, 1);
      assert.equal(calls.start[0].raw, JSON.stringify(startBody(calls.start[0].body.request_id, 'personality', expect.spend)));
    } finally { await context.close(); }
  });
}

// ---------------------------------------------------------------------------
// Test 19 (loop part) and test 21 (automatic part)
// ---------------------------------------------------------------------------
test('19 loop: "Beklemeyi durdur" during an automatic resend aborts it, keeps the record paused, nothing is sent later; "Sürdür" resends the same id', async () => {
  const { context, page, calls, net } = await openPage({
    clock: true, start: (b, n) => (n === 1 ? RIP : n === 2 ? never() : startOk('S1')),
  });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.pending-stop-btn');
    await expectAutoSend(page, 10_000);
    await page.click('.pending-stop-btn');
    await until(() => net.failedStart === 1, 'the aborted automatic resend');
    const key = keyFor('u1', calls.start[0].body.request_id);
    await stopped(page, key);
    for (let i = 0; i < 8; i++) await page.clock.fastForward(50_000);
    await nextFrame(page);
    assert.equal((await sendTimes(page)).length, 2, 'no new request while the clock runs');
    await openReports(page);
    await page.click(`#pendingList .pending-item[data-request-id="${calls.start[0].body.request_id}"] .pending-resume`);
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(calls.start.length, 3);
    assert.equal(calls.start[2].raw, calls.start[0].raw);
  } finally { await context.close(); }
});

test('19 loop, between resends: "Beklemeyi durdur" while the next resend is only scheduled keeps the record paused and nothing is sent later', async () => {
  const { context, page, calls } = await openPage({ clock: true, start: (b, n) => (n === 1 ? RIP : startOk('S1')) });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.pending-stop-btn');
    await page.click('.pending-stop-btn');
    await until(() => calls.start.length === 1, 'the mock saw the send');
    const key = keyFor('u1', calls.start[0].body.request_id);
    await stopped(page, key);
    for (let i = 0; i < 8; i++) await page.clock.fastForward(50_000);
    await nextFrame(page);
    assert.equal((await sendTimes(page)).length, 1, 'the scheduled resend does not go');
    assert.deepEqual(await pendingKeys(page), [key], 'kept');
    await openReports(page);
    await page.click(`#pendingList .pending-item[data-request-id="${calls.start[0].body.request_id}"] .pending-resume`);
    await until(() => calls.start.length === 2, 'Sürdür');
    assert.equal(calls.start[1].raw, calls.start[0].raw);
  } finally { await context.close(); }
});

test('quote check loop: "Beklemeyi durdur" stops the checks; no quote and no /start later', async () => {
  const { context, page, calls } = await openPage({ clock: true, quote: (b, n) => (n === 1 ? GIP : Q.sub()) });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.quote-stop-btn');
    await page.click('.quote-stop-btn');
    for (let i = 0; i < 8; i++) await page.clock.fastForward(50_000);
    await nextFrame(page);
    assert.equal(calls.quote.length, 1, 'no automatic check after stopping');
    assert.equal(calls.start.length, 0);
    assert.equal(await count(page, '.quote-generate-btn'), 0);
  } finally { await context.close(); }
});

test('21 automatic: a hung /start is aborted at 180 s, resent automatically with the same id, aborted at 330 s, then nothing more', async () => {
  const { context, page, calls, net } = await openPage({ clock: true, start: () => never() });
  try {
    await clickCategory(page, 'personality');
    await untilSends(page, 1);
    const t0 = (await sendTimes(page))[0].at;
    await page.clock.fastForward(t0 + 180_000 - await pageNow(page));
    await until(() => net.failedStart === 1, 'abort at 180 s');
    await page.waitForSelector('.pending-retry-btn');
    assert.match(await text(page, '#chatMessages'), /Bağlantı sorunu, yeniden deneniyor…/);
    // The resend delay counts from the abort (the page-side failure), not from the first send.
    await expectAutoSend(page, 10_000);
    await until(() => calls.start.length === 2, 'the mock saw the resend');
    assert.equal(calls.start[1].raw, calls.start[0].raw);
    await page.clock.fastForward(t0 + 329_000 - await pageNow(page));
    await nextFrame(page);
    assert.equal(net.failedStart, 1, 'still on the network inside the window');
    await page.clock.fastForward(2_000);
    await until(() => net.failedStart === 2, 'abort at 330 s');
    await stopped(page, keyFor('u1', calls.start[0].body.request_id));
    for (let i = 0; i < 12; i++) await page.clock.fastForward(50_000);
    await nextFrame(page);
    assert.equal(calls.start.length, 2, 'no automatic request after the window');
    assert.match(await text(page, '#chatMessages'), /Bağlantı sorunu oluştu\. Aynı isteği tekrar gönderebilirsin\./, 'the final message after the window');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// 60 s notice, 429 back-off, hidden tab
// ---------------------------------------------------------------------------
test('the "Bu biraz uzun sürebilir." notice appears once, at 60 s', async () => {
  const { context, page } = await openPage({ clock: true, start: () => RIP });
  try {
    await clickCategory(page, 'personality');
    await untilSends(page, 1);
    const t0 = (await sendTimes(page))[0].at;
    const shown = () => page.locator('.wait-info:visible').count();
    await page.clock.fastForward(t0 + 59_000 - await pageNow(page));
    await nextFrame(page);
    assert.equal(await shown(), 0);
    await page.clock.fastForward(2_000);
    await untilAsync(async () => (await shown()) === 1, 'the 60 s notice');
    assert.equal(await page.locator('.wait-info:visible').textContent(), 'Bu biraz uzun sürebilir.');
    for (let i = 0; i < 4; i++) await page.clock.fastForward(30_000);
    await nextFrame(page);
    assert.equal(await shown(), 1, 'shown once');
    assert.equal(await page.locator('.wait-info').count(), 1);
  } finally { await context.close(); }
});

test('429 doubles the next delay: an approved resend 20 s instead of 10 s, a quote check 10 s instead of 5 s', async () => {
  const r1 = await openPage({ clock: true, start: (b, n) => (n === 1 ? [429, { error: 'rate_limited', detail: 'x' }] : startOk('S1')) });
  try {
    await clickCategory(r1.page, 'personality');
    await untilSends(r1.page, 1);
    await expectAutoSend(r1.page, 20_000);
    await r1.page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(r1.calls.start[1].raw, r1.calls.start[0].raw);
  } finally { await r1.context.close(); }

  const r2 = await openPage({
    clock: true, afterClock: logReads,
    quote: (b, n) => (n === 1 ? GIP : n === 2 ? [429, { error: 'rate_limited', detail: 'x' }] : Q.sub()),
  });
  try {
    await clickCategory(r2.page, 'personality');
    await r2.page.waitForSelector('.quote-check-btn');
    await r2.page.clock.fastForward(3_100);
    await until(() => r2.calls.quote.length === 2, 'the first check');
    await untilAsync(async () => (await reads(r2.page, 'interpret/quote'))[1]?.respAt != null, 'the 429 response');
    const second = (await reads(r2.page, 'interpret/quote'))[1].respAt;
    await r2.page.clock.fastForward(second + 9_700 - await pageNow(r2.page));
    await nextFrame(r2.page);
    assert.equal(r2.calls.quote.length, 2, 'not after the normal 5 s');
    await r2.page.clock.fastForward(Math.max(1, second + 10_300 - await pageNow(r2.page)));
    await until(() => r2.calls.quote.length === 3, 'the check after 10 s');
    await r2.page.waitForSelector('.quote-generate-btn');
    assert.equal(r2.calls.start.length, 0);
  } finally { await r2.context.close(); }
});

test('hidden tab: nothing is sent while hidden; visible again inside the window continues, after it the wait has expired', async () => {
  const r1 = await openPage({ clock: true, start: (b, n) => (n === 1 ? RIP : startOk('S1')) });
  try {
    await clickCategory(r1.page, 'personality');
    await untilSends(r1.page, 1);
    await r1.page.waitForSelector('.pending-retry-btn'); // the first result is in: the wait has started
    const t0 = (await sendTimes(r1.page))[0].at;
    await setHidden(r1.page, true);
    await r1.page.clock.fastForward(t0 + 40_000 - await pageNow(r1.page));
    await nextFrame(r1.page);
    assert.equal((await sendTimes(r1.page)).length, 1, 'nothing sent while hidden');
    await setHidden(r1.page, false);
    await untilSends(r1.page, 2, 'the send after becoming visible');
    assert.ok((await sendTimes(r1.page))[1].at - t0 >= 40_000);
    await r1.page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
  } finally { await r1.context.close(); }

  const r2 = await openPage({ clock: true, start: () => RIP });
  try {
    await clickCategory(r2.page, 'personality');
    await untilSends(r2.page, 1);
    await until(() => r2.calls.start.length === 1, 'the mock saw the send');
    await r2.page.waitForSelector('.pending-retry-btn');
    const key = keyFor('u1', r2.calls.start[0].body.request_id);
    await setHidden(r2.page, true);
    for (let i = 0; i < 7; i++) await r2.page.clock.fastForward(50_000);
    await nextFrame(r2.page);
    assert.equal((await sendTimes(r2.page)).length, 1);
    await setHidden(r2.page, false);
    await stopped(r2.page, key);
    await r2.page.clock.fastForward(60_000);
    await nextFrame(r2.page);
    assert.equal((await sendTimes(r2.page)).length, 1, 'expired: nothing sent after becoming visible');
  } finally { await r2.context.close(); }
});

// ---------------------------------------------------------------------------
// report_not_ready, pending report, pending list
// ---------------------------------------------------------------------------
test('/continue report_not_ready: GET /{id} is polled; when completed the same continue id is sent once', async () => {
  let polls = 0;
  const A = sess('A');
  const { context, page, calls } = await openPage({
    clock: true, chart: false, history: () => [A],
    detail: () => { polls += 1; return polls === 1 || polls >= 4 ? detailOf('A') : { ...detailOf('A'), status: 'pending' }; },
    cont: (b, n) => (n === 1 ? [409, { error: 'report_not_ready', detail: 'x' }] : [200, { message: 'Cevap 2', ...bal(0) }]),
  });
  try {
    await openReports(page);
    await page.click('#reportsList .report-row[data-session-id="A"]');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni A');
    await page.fill('#chatInput', 'Soru');
    await page.click('#chatSendBtn');
    await page.waitForSelector('.chat-bubble.error >> text=Rapor hâlâ hazırlanıyor.');
    assert.equal(calls.continue.length, 1);
    await driveUntil(page, () => calls.continue.length === 2, { step: 3_000, what: 'the resent /continue' });
    await page.waitForSelector('.chat-bubble.assistant >> text=Cevap 2');
    assert.equal(calls.continue[1].raw, calls.continue[0].raw, 'same continue id and body');
    const log = calls.log;
    const between = log.slice(log.indexOf('continue') + 1, log.lastIndexOf('continue'));
    assert.ok(between.filter(x => x === 'detail:A').length >= 3, `polled GET /A in between: ${between}`);
    await page.clock.fastForward(120_000);
    await nextFrame(page);
    assert.equal(calls.continue.length, 2, 'sent once');
  } finally { await context.close(); }
});

test('a pending report opened from My reports is polled; when completed the text shows and the question box opens; closing it stops the poll', async () => {
  let polls = 0;
  const P = sess('P', { status: 'pending' });
  const pendingDetail = { ...P, messages: [] };
  const r1 = await openPage({
    clock: true, chart: false, history: () => [P], balance: () => bal(1, 2),
    detail: () => { polls += 1; return polls <= 2 ? pendingDetail : detailOf('P'); },
  });
  try {
    await openReports(r1.page);
    await r1.page.click('#reportsList .report-row[data-session-id="P"]');
    await r1.page.waitForSelector('.chat-bubble.notice >> text=Rapor hâlâ hazırlanıyor');
    assert.equal(await r1.page.isDisabled('#chatInput'), true);
    await driveUntil(r1.page, async () => (await count(r1.page, '.chat-bubble.assistant >> text=Rapor metni P')) > 0, { step: 3_000, what: 'the completed report' });
    await r1.page.waitForFunction(() => document.getElementById('chatRemaining').textContent === 'Kalan soru hakkın: 3');
    assert.equal(await r1.page.isDisabled('#chatInput'), false);
    assert.equal(await r1.page.isDisabled('#chatSendBtn'), false);
  } finally { await r1.context.close(); }

  const r2 = await openPage({ clock: true, chart: false, history: () => [P], detail: () => pendingDetail });
  try {
    await openReports(r2.page);
    await r2.page.click('#reportsList .report-row[data-session-id="P"]');
    await r2.page.waitForSelector('.chat-bubble.notice >> text=Rapor hâlâ hazırlanıyor');
    await driveUntil(r2.page, () => r2.calls.detail.length >= 2, { step: 3_000, what: 'the first poll' });
    await r2.page.click('#chatBackBtn');
    await r2.page.waitForSelector('#reportsPanel', { state: 'visible' });
    const n = r2.calls.detail.length;
    for (let i = 0; i < 6; i++) await r2.page.clock.fastForward(30_000);
    await nextFrame(r2.page);
    assert.equal(r2.calls.detail.length, n, 'no more polling after closing the report');
  } finally { await r2.context.close(); }
});

test('My reports with a pending row: the first page is re-read and the row updated in place; loaded pages stay; closing stops the poll', async () => {
  let reread = 0;
  const page1 = Array.from({ length: 20 }, (_, i) => sess(`p${i}`, i === 0 ? { status: 'pending' } : {}));
  const page2 = Array.from({ length: 5 }, (_, i) => sess(`q${i}`));
  const { context, page, calls } = await openPage({
    clock: true, chart: false,
    history: (auth, offset) => {
      if (offset === 20) return page2;
      reread += 1;
      return reread <= 2 ? page1 : page1.map((s, i) => (i === 0 ? { ...s, status: 'completed' } : s));
    },
  });
  try {
    await openReports(page);
    await page.waitForFunction(() => document.querySelectorAll('#reportsList .report-row').length === 20);
    await page.click('#reportsMoreBtn');
    await page.waitForFunction(() => document.querySelectorAll('#reportsList .report-row').length === 25);
    assert.equal(await count(page, '#reportsList .report-row[data-session-id="p0"] .report-row-badge'), 1);
    await driveUntil(page, async () => (await count(page, '#reportsList .report-row[data-session-id="p0"] .report-row-badge')) === 0,
      { step: 3_000, what: 'the updated row' });
    assert.equal(await count(page, '#reportsList .report-row'), 25, 'the second page is still there');
    assert.deepEqual(calls.historyOffsets.slice(2), calls.historyOffsets.slice(2).map(() => 0), 'only the first page is re-read');
    const n = calls.history.length;
    for (let i = 0; i < 6; i++) await page.clock.fastForward(30_000);
    await nextFrame(page);
    assert.equal(calls.history.length, n, 'no pending row left: polling stopped');
  } finally { await context.close(); }

  const r2 = await openPage({ clock: true, chart: false, history: () => [sess('x', { status: 'pending' })] });
  try {
    await openReports(r2.page);
    await r2.page.waitForSelector('#reportsList .report-row[data-session-id="x"]');
    await driveUntil(r2.page, () => r2.calls.history.length >= 2, { step: 3_000, what: 'the first list poll' });
    await r2.page.click('#reportsCloseBtn');
    const n = r2.calls.history.length;
    for (let i = 0; i < 6; i++) await r2.page.clock.fastForward(30_000);
    await nextFrame(r2.page);
    assert.equal(r2.calls.history.length, n, 'closing the list stops the poll');
  } finally { await r2.context.close(); }
});

// ---------------------------------------------------------------------------
// Resume on load: 429 is retried; one queue; account change
// ---------------------------------------------------------------------------
test('resume on load: a 429 keeps the record and retries it with a doubled delay inside its window; one request at a time, >= 10 s apart', async () => {
  const seed = [1, 2].map(i => seedRecord('u1', `rid-${i}`, startBody(`rid-${i}`), { created_at: i }));
  let first = 0;
  const { context, page, calls, net } = await openPage({
    clock: true, chart: false, seed,
    start: b => { if (b.request_id === 'rid-1' && ++first === 1) return [429, { error: 'rate_limited', detail: 'x' }]; return startOk(`S-${b.request_id}`); },
  });
  try {
    await untilSends(page, 1);
    assert.deepEqual(await pendingKeys(page), [keyFor('u1', 'rid-1'), keyFor('u1', 'rid-2')], 'kept after the 429');
    await passGap(page);
    await untilSends(page, 2, 'the second record');
    await driveUntil(page, async () => (await sendTimes(page)).length === 3, { step: 2_000, what: 'the retried record' });
    const log = await sendTimes(page);
    assert.deepEqual(log.map(e => e.request_id), ['rid-1', 'rid-2', 'rid-1']);
    assert.ok(log[2].at - log[0].respAt >= 20_000, 'the doubled delay: 20 s after the 429');
    for (let i = 1; i < 3; i++) assert.ok(log[i].at - log[i - 1].at >= 10_000, `>= 10 s apart (${log[i].at - log[i - 1].at} ms)`);
    await until(() => calls.start.length === 3, 'the mock saw the retried record');
    assert.equal(calls.start[2].raw, calls.start[0].raw);
    assert.equal(net.max, 1);
    await page.waitForFunction(() => Object.keys(sessionStorage).every(k => !k.startsWith('stellafix_pending_interpret:')));
  } finally { await context.close(); }
});

test('two waiting records share one queue: every automatic send is >= 10 s after the previous one and only one is on the network', async () => {
  const seed = [1, 2].map(i => seedRecord('u1', `rid-${i}`, startBody(`rid-${i}`), { created_at: i }));
  const { context, page, calls, net } = await openPage({
    clock: true, chart: false, seed, start: (b, n) => (n <= 6 ? RIP : startOk(`S-${b.request_id}`)),
  });
  try {
    await untilSends(page, 1);
    await driveUntil(page, async () => (await sendTimes(page)).length >= 7, { step: 1_000, maxSteps: 200, what: '7 sends' });
    const log = await sendTimes(page);
    assert.deepEqual([...new Set(log.map(e => e.request_id))].sort(), ['rid-1', 'rid-2'], 'both records are resent');
    for (let i = 1; i < log.length; i++) assert.ok(log[i].at - log[i - 1].at >= 10_000, `send ${i} is ${log[i].at - log[i - 1].at} ms after the previous one`);
    assert.equal(net.max, 1);
    for (const id of ['rid-1', 'rid-2']) {
      const raws = calls.start.filter(c => c.body.request_id === id).map(c => c.raw);
      assert.ok(raws.every(r => r === JSON.stringify(startBody(id))), `${id}: the same bytes on every send`);
    }
  } finally { await context.close(); }
});

test('an automatic resend waits while a manual "Sürdür" request is on the network', async () => {
  const seed = [seedRecord('u1', 'rid-b', startBody('rid-b'), { created_at: 1, paused: true })];
  const { context, page, calls, net } = await openPage({
    clock: true, seed,
    start: (b, n) => (b.request_id === 'rid-b' ? never() : (n === 1 ? RIP : startOk('S1'))),
  });
  try {
    await clickCategory(page, 'personality'); // A: request_in_progress, resend scheduled after 10 s
    await page.waitForSelector('.pending-retry-btn');
    await until(() => calls.start.length === 1, 'A');
    const idA = calls.start[0].body.request_id;
    await openReports(page);
    await page.click('#pendingList .pending-item[data-request-id="rid-b"] .pending-resume'); // B: hangs
    await untilSends(page, 2);
    const tB = (await sendTimes(page))[1].at;
    for (let i = 0; i < 6; i++) await page.clock.fastForward(25_000);
    await nextFrame(page);
    assert.equal((await sendTimes(page)).length, 2, "A's resend waits while B is on the network");
    await page.clock.fastForward(tB + 181_000 - await pageNow(page));
    await until(() => net.failedStart === 1, 'B aborted at 180 s');
    await driveUntil(page, async () => (await sendTimes(page)).length >= 3, { step: 2_000, what: "A's resend" });
    const log = await sendTimes(page);
    assert.equal(log[2].request_id, idA);
    assert.ok(log[2].at - tB >= 180_000, 'only after B left the network');
    // Counted in the page: an aborted request's failure event can reach the test after the next request's start.
    assert.equal(await page.evaluate(() => window.__genMax), 1);
    await until(() => calls.start.length === 3, 'the mock saw the resend');
    assert.equal(calls.start[2].raw, calls.start[0].raw);
  } finally { await context.close(); }
});

test('an account change during a wait shows nothing on the new account and sends nothing for the old one', async () => {
  let current = U2;
  const { context, page, calls } = await openPage({
    clock: true, verify: () => current, quote: (b, n) => (b.category === 'career' ? GIP : Q.sub()), start: () => RIP,
  });
  try {
    await clickCategory(page, 'personality');      // approved request: waiting
    await page.waitForSelector('.pending-stop-btn');
    await page.click('#chatBackBtn');
    await clickCategory(page, 'career');            // quote loop: waiting
    await page.waitForSelector('.quote-check-btn');
    const starts = calls.start.length, quotes = calls.quote.length;
    await logoutViaMenu(page);
    await loginAs(page, U2);
    for (let i = 0; i < 12; i++) await page.clock.fastForward(30_000);
    await nextFrame(page);
    assert.equal(calls.start.length, starts, 'no resend for u1');
    assert.equal(calls.quote.length, quotes, 'no quote check for u1');
    assert.equal(await count(page, '#chatMessages .chat-bubble'), 0, 'nothing on u2\'s screen');
    assert.equal(await page.$eval('#reportReadyToast', el => el.style.display), 'none');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// Early timer wake-up: the 10 s gap is still kept
// ---------------------------------------------------------------------------
// Runs after the fake clock: every timer of 1 s or more fires 100 ms early.
function earlyTimers() {
  const orig = window.setTimeout;
  window.setTimeout = function (fn, ms, ...args) { return orig.call(this, fn, ms >= 1000 ? ms - 100 : ms, ...args); };
}
test('timers firing 100 ms early: two automatic sends are still >= 10 000 ms apart', async () => {
  const seed = [1, 2].map(i => seedRecord('u1', `rid-${i}`, startBody(`rid-${i}`), { created_at: i }));
  const { context, page } = await openPage({ clock: true, chart: false, seed, afterClock: earlyTimers, start: b => startOk(`S-${b.request_id}`) });
  try {
    const woke = await page.evaluate(() => new Promise(r => { const t0 = Date.now(); setTimeout(() => r(Date.now() - t0), 1000); }));
    assert.ok(woke < 1000, `sanity: a 1000 ms timer fired after ${woke} ms`);
    await untilSends(page, 1);
    await untilAsync(async () => (await sendTimes(page))[0].respAt !== null, 'the first response');
    // runFor fires each timer at its own (early) due time, unlike fastForward,
    // which would wake it at the end of the jump.
    await page.clock.runFor(11_000);
    await untilSends(page, 2);
    const [a, b] = await sendTimes(page);
    assert.ok(b.at - a.at >= 10_000, `gap ${b.at - a.at} ms`);
  } finally { await context.close(); }
});
