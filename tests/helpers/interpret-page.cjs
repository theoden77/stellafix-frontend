// Shared page setup for the interpret browser tests (quote, records, waits):
// openPage with page.route mocks, a page-side send-time log, and helpers.
// Not a test file itself (the npm test glob only runs tests/*.test.cjs).
const assert = require('node:assert/strict');
const { API, json, CLOSE_LIMIT_MS, settlesWithin } = require('./harness.cjs');

let current = null;
const useHarness = h => { current = h; };
const harness = () => current;

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

// Real-time limit for one page step that depends on the fake page clock
// (a clock call, a frame, a page-side timer). Taken with Node's own timer:
// page-side setTimeout/requestAnimationFrame are fake while the clock is
// installed. A normal step takes well under a second.
const PAGE_STEP_LIMIT_MS = 10_000;
// Races `work` against the real-time limit. On a timeout the page's browser
// context is closed (itself bounded), which also ends the pending page call,
// and the step fails with its name. The context is closed here, not left to
// the test's finally, so no browser context outlives a hung step.
async function pageStep(page, what, work, ms = PAGE_STEP_LIMIT_MS) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`page step "${what}" did not finish within ${ms} ms (real time)`)), ms);
  });
  try {
    return await Promise.race([work, limit]);
  } catch (e) {
    if (!/did not finish within/.test(e.message)) throw e;
    work.catch(() => {}); // rejected by the close below
    await settlesWithin(page.context().close(), CLOSE_LIMIT_MS);
    throw e;
  } finally { clearTimeout(timer); }
}
// Pages opened with the paused fake clock -> their unwrapped clock.runFor.
const pausedPages = new WeakMap();
// Fake page time at the first load of a clock page. The clock is installed
// earlier and paused here, so page time only moves with fastForward/runFor
// and never with real time.
const CLOCK_START = new Date('2026-10-15T10:00:00Z');
// One frame of the fake clock (requestAnimationFrame fires every 16 ms).
const FRAME_MS = 16;

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
  subscribed = false, verify = null, seed = [], clock = false, chart = true, timezoneId = 'Europe/Istanbul', afterClock = null } = {}) {
  const context = await harness().browser.newContext({ timezoneId });
  const page = await context.newPage();
  const calls = { quote: [], start: [], continue: [], detail: [], balance: [], history: [], historyOffsets: [], credits: 0, log: [] };
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
  // Send times for /start and /continue, taken with the page clock at the
  // moment fetch is called (synchronously, before the request leaves), so a
  // test never reads a time that has not been written yet.
  await page.addInitScript(() => {
    window.__genSends = [];
    window.__genActive = 0; window.__genMax = 0; // /start and /continue on the network, as the page sees it
    const orig = window.fetch;
    window.fetch = function (input, init) {
      const url = String(input && input.url ? input.url : input);
      const m = url.match(/\/api\/v1\/interpret\/(start|continue)$/);
      if (m) {
        let id = null;
        try { id = JSON.parse(init && init.body).request_id; } catch (e) { /* not JSON */ }
        // timers: how many timers the page had asked for before this send (see __timers below).
        const entry = { kind: m[1], request_id: id, at: Date.now(), respAt: null, timers: window.__timers ? window.__timers.length : 0 };
        window.__genSends.push(entry);
        const p = orig.apply(this, arguments);
        // Page clock when the response (or the network error) arrived.
        window.__genActive += 1; window.__genMax = Math.max(window.__genMax, window.__genActive);
        p.then(() => { entry.respAt = Date.now(); window.__genActive -= 1; }, () => { entry.respAt = Date.now(); window.__genActive -= 1; });
        return p;
      }
      return orig.apply(this, arguments);
    };
  });
  if (clock) {
    // Installed 60 s early so the pause target is never in the past for the
    // blank page that is already open; the loaded page starts at CLOCK_START.
    await page.clock.install({ time: new Date(CLOCK_START.getTime() - 60_000) });
    await page.clock.pauseAt(CLOCK_START);
    pausedPages.set(page, page.clock.runFor.bind(page.clock));
    for (const name of ['fastForward', 'runFor']) {
      const orig = page.clock[name].bind(page.clock);
      page.clock[name] = ticks => pageStep(page, `clock.${name}(${ticks})`, orig(ticks));
    }
  }
  if (afterClock) await page.addInitScript(afterClock); // runs after the fake clock is installed
  // Timers of 1 s or more as the page requests them: [{ms, at, firedAt}], page clock.
  await page.addInitScript(() => {
    window.__timers = [];
    const orig = window.setTimeout;
    window.setTimeout = function (fn, ms, ...args) {
      if (typeof fn !== 'function' || !(ms >= 1000)) return orig.call(this, fn, ms, ...args);
      const entry = { ms, at: Date.now(), firedAt: null };
      window.__timers.push(entry);
      return orig.call(this, function () { entry.firedAt = Date.now(); return fn.apply(this, arguments); }, ms, ...args);
    };
  });
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
      const offset = Number(url.searchParams.get('offset') || 0);
      calls.history.push(auth);
      calls.historyOffsets.push(offset);
      return json(route, 200, { sessions: await history(auth, offset), limit: 20, offset });
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
      const entry = { raw, body: JSON.parse(raw), auth };
      calls[kind].push(entry);
      calls.log.push(kind);
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
  await page.goto(harness().baseUrl);
  await load();
  if (chart && token) await page.evaluate(() => showInterpretArea('chart-1'));
  return { context, page, calls, net, reload: async () => { await page.reload(); await load(); } };
}

const clickCategory = (page, id) => page.click(`button.category-card[onclick="selectCategory('${id}')"]`);
// Page-side send log of this page load: [{kind, request_id, at}], in send order.
async function sendTimes(page) {
  const log = await page.evaluate(() => window.__genSends.slice());
  for (const e of log) assert.equal(typeof e.at, 'number', `send time recorded for ${e.kind} ${e.request_id}`);
  return log;
}
// Advances the page clock to 9 s after the previous automatic send and checks
// nothing else left the page, then to 10 s after it. Targets are computed from
// the recorded send time.
async function passGap(page) {
  const sinceLast = () => page.evaluate(() => Date.now() - window.__genSends[window.__genSends.length - 1].at);
  const before = await page.evaluate(() => window.__genSends.length);
  const toNine = 9_000 - await sinceLast();
  assert.ok(toNine > 0, `still inside the first 9 s (${toNine} ms left)`);
  await page.clock.fastForward(toNine);
  await nextFrame(page);
  assert.equal(await page.evaluate(() => window.__genSends.length), before, 'nothing sent within 9 s of the previous automatic send');
  await page.clock.fastForward(Math.max(1, 10_000 - await sinceLast()));
}
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
// One page turn so a response that already arrived has been handled. With
// the paused clock the frame is fired by running the clock for one frame
// (16 ms of page time; page timers due in those 16 ms fire too).
async function nextFrame(page) {
  const frame = page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));
  if (!pausedPages.has(page)) return pageStep(page, 'nextFrame', frame);
  frame.catch(() => {});
  return pageStep(page, 'nextFrame', (async () => { await pausedPages.get(page)(FRAME_MS); await frame; })());
}
// Runs a page function that waits on page timers, while the paused clock runs
// for `ms` of page time, and returns its result.
async function withPageTime(page, fn, ms) {
  const result = page.evaluate(fn);
  result.catch(() => {});
  return pageStep(page, `page timers over ${ms} ms`, (async () => { await pausedPages.get(page)(ms); return result; })());
}
function seedRecord(sub, id, body, { kind = 'start', created_at = 1, paused = false, spend = 'subscription' } = {}) {
  const raw = JSON.stringify(body);
  return [keyFor(sub, id), JSON.stringify({ v: 1, sub, kind, request_id: id, body: raw,
    approved_spend: kind === 'start' ? spend : null, created_at, paused })];
}
const startBody = (id, category = 'personality', spend = 'subscription') =>
  ({ chart_id: 'chart-1', category, language: 'tr', request_id: id, expected_spend: spend });


module.exports = { useHarness, b64url, fakeJwt, U1, U2, PREFIX, UUID, delay, gate, never, until, Q, startOk, bal, sess, detailOf, reply, openPage, clickCategory, sendTimes, passGap, pendingKeys, pendingRecord, keyFor, text, count, openReports, logoutViaMenu, loginAs, nextFrame, seedRecord, startBody, pageStep, withPageTime, PAGE_STEP_LIMIT_MS, FRAME_MS };
