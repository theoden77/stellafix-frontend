// Browser integration test for the assistant text formatting: only **bold**
// and line-start headings (# … ######) are shown as bold; everything else,
// raw HTML and entities included, stays plain text. The API is mocked with
// page.route; no real backend is called. Run: npm test
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness, TEST_TIMEOUT_MS, HOOK_TIMEOUT_MS, closeOpenContexts } = require('./helpers/harness.cjs');
const {
  useHarness, Q, startOk, bal, sess, openPage, clickCategory, openReports, seedRecord, startBody, nextFrame, until,
} = require('./helpers/interpret-page.cjs');

let h;
before(async () => { h = await startHarness(); useHarness(h); }, { timeout: HOOK_TIMEOUT_MS });
afterEach(async () => { await closeOpenContexts(h?.browser); }, { timeout: HOOK_TIMEOUT_MS });
after(async () => { await h?.close(); }, { timeout: HOOK_TIMEOUT_MS });

// Adds a bubble with the page's own function and returns its index among the bubbles.
const addBubble = (page, role, text) => page.evaluate(([r, t]) => {
  const div = appendChatBubble(r, t);
  return [...document.querySelectorAll('#chatMessages .chat-bubble')].indexOf(div);
}, [role, text]);
// What a bubble shows: its text, its <strong> texts, and whether a <strong> is nested.
const shownAt = (page, i) => page.evaluate(i => {
  const b = document.querySelectorAll('#chatMessages .chat-bubble')[i];
  const t = b.querySelector('.chat-bubble-text');
  return {
    text: t.textContent,
    strong: [...t.querySelectorAll('strong')].map(s => s.textContent),
    nested: !!t.querySelector('strong strong'),
    elements: [...t.querySelectorAll('*')].map(e => e.tagName.toLowerCase()),
  };
}, i);
const render = async (page, text, role = 'assistant') => shownAt(page, await addBubble(page, role, text));
const lastAssistant = page => page.evaluate(() => {
  const all = document.querySelectorAll('#chatMessages .chat-bubble.assistant');
  const t = all[all.length - 1].querySelector('.chat-bubble-text');
  return { text: t.textContent, strong: [...t.querySelectorAll('strong')].map(s => s.textContent) };
});
// An open chat view without any network call.
async function blankChat() {
  const r = await openPage({ chart: true });
  await r.page.evaluate(() => {
    document.getElementById('categoryPanel').style.display = 'none';
    document.getElementById('chatPanel').style.display = 'block';
    document.getElementById('chatMessages').innerHTML = '';
  });
  return r;
}

const MD = '# Genel Bakış\nGüneş **Balık** burcunda, Ay **Koç** burcunda.\n\n## Sonuç\nSon paragraf.';
const MD_SHOWN = 'Genel Bakış\nGüneş Balık burcunda, Ay Koç burcunda.\n\nSonuç\nSon paragraf.';
const MD_STRONG = ['Genel Bakış', 'Balık', 'Koç', 'Sonuç'];

// ---------------------------------------------------------------------------
// Supported formats
// ---------------------------------------------------------------------------
test('bold: **x** is one <strong>, the markers are not shown; several on one line', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await blankChat();
  try {
    let r = await render(page, 'Güneş **Balık** burcunda.');
    assert.equal(r.text, 'Güneş Balık burcunda.');
    assert.deepEqual(r.strong, ['Balık']);
    r = await render(page, '**A** ve **B**, sonra **C D**.');
    assert.equal(r.text, 'A ve B, sonra C D.');
    assert.deepEqual(r.strong, ['A', 'B', 'C D']);
    r = await render(page, '**baştan sona**');
    assert.equal(r.text, 'baştan sona');
    assert.deepEqual(r.strong, ['baştan sona']);
  } finally { await context.close(); }
});

test('headings: # to ###### lines are bold without the markers; up to 3 leading spaces', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await blankChat();
  try {
    for (const [input, shown, strong] of [
      ['# Bir', 'Bir', 'Bir'],
      ['## İki', 'İki', 'İki'],
      ['### Üç', 'Üç', 'Üç'],
      ['###### Altı', 'Altı', 'Altı'],
      ['#\tSekme', 'Sekme', 'Sekme'],
      ['#   Çok boşluk', 'Çok boşluk', 'Çok boşluk'],
      ['   ## Girintili', '   Girintili', 'Girintili'],
    ]) {
      const r = await render(page, input);
      assert.equal(r.text, shown, input);
      assert.deepEqual(r.strong, [strong], input);
      assert.deepEqual(r.elements, ['strong'], `${input}: only a <strong>, no heading element`);
    }
  } finally { await context.close(); }
});

test('bold inside a heading: one <strong>, no nested <strong>; an invalid pair stays visible inside the heading', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await blankChat();
  try {
    let r = await render(page, '## Güneş **Balık** burcunda');
    assert.equal(r.text, 'Güneş Balık burcunda');
    assert.deepEqual(r.strong, ['Güneş Balık burcunda']);
    assert.equal(r.nested, false);
    r = await render(page, '# Başlık **kapanmamış');
    assert.equal(r.text, 'Başlık **kapanmamış');
    assert.deepEqual(r.strong, ['Başlık **kapanmamış']);
  } finally { await context.close(); }
});

test('paragraphs and empty lines are kept; a heading line adds no extra line', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await blankChat();
  try {
    const r = await render(page, MD);
    assert.equal(r.text, MD_SHOWN);
    assert.deepEqual(r.strong, MD_STRONG);
    // The same text without the markers, as a plain assistant bubble: same height and the same rendered lines.
    const metrics = await page.evaluate(([a, b]) => {
      const box = t => {
        const div = appendChatBubble('assistant', t);
        return { h: div.getBoundingClientRect().height, lines: div.innerText.split('\n').length };
      };
      return [box(a), box(b)];
    }, [MD, MD_SHOWN]);
    assert.deepEqual(metrics[0], metrics[1]);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// Stays plain: the shown text is exactly the input
// ---------------------------------------------------------------------------
const PLAIN = [
  '**a **b** c**', '***x***', '****', '**kapanmamış', '** boşluklu**', '**boşluklu **', '**a*b**', '****x**',
  'satırı **aşan\nkalın** metin',
  '*italik*', '_italik_', '- liste', '1. liste', '`kod`', '[x](y)', '| tablo | x |', '> alıntı',
  '####### başlık', '#başlık', 'C# ve 3#', '    # dört boşluk', '#', '# ', 'metin # değil başlık',
];
test('stays plain: unsupported or invalid markers are shown exactly as written', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await blankChat();
  try {
    for (const input of PLAIN) {
      const r = await render(page, input);
      assert.equal(r.text, input, JSON.stringify(input));
      assert.deepEqual(r.strong, [], `${JSON.stringify(input)}: no <strong>`);
    }
  } finally { await context.close(); }
});

test('a line with one invalid pair stays plain even if other pairs on it are valid; other lines are still formatted', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await blankChat();
  try {
    const r = await render(page, '**iyi** ve ** kötü**\n**iyi**');
    assert.equal(r.text, '**iyi** ve ** kötü**\niyi');
    assert.deepEqual(r.strong, ['iyi']);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// XSS: checked only inside the assistant bubble
// ---------------------------------------------------------------------------
const XSS = [
  ['<script>window.__x=1</script>', '<script>window.__x=1</script>'],
  ['<img src=x onerror="window.__x=1">', '<img src=x onerror="window.__x=1">'],
  ['**<img src=x onerror="window.__x=1">**', '<img src=x onerror="window.__x=1">'],
  ['# <svg onload="window.__x=1">', '<svg onload="window.__x=1">'],
  ['[tıkla](javascript:window.__x=1)', '[tıkla](javascript:window.__x=1)'],
  ['<a href="javascript:window.__x=1">x</a>', '<a href="javascript:window.__x=1">x</a>'],
  ['&lt;script&gt;', '&lt;script&gt;'],
  ['**<b>kalın</b>**', '<b>kalın</b>'],
];
const bubbleSafety = (page, i) => page.evaluate(i => {
  const b = document.querySelectorAll('#chatMessages .chat-bubble')[i];
  const els = [...b.querySelectorAll('*')];
  return {
    tags: els.map(e => e.tagName.toLowerCase()).filter(t => ['script', 'img', 'svg', 'iframe', 'a'].includes(t)),
    attrs: els.flatMap(e => [...e.attributes].map(a => a.name)).filter(n => /^on/i.test(n) || n === 'href' || n === 'src'),
    flag: window.__x,
  };
}, i);
for (const [input, shown] of XSS) {
  test(`XSS: ${input} in an assistant text is shown as text; no element, attribute or script runs`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { context, page } = await blankChat();
    try {
      const i = await addBubble(page, 'assistant', input);
      await nextFrame(page);
      await page.evaluate(() => new Promise(r => setTimeout(r, 50))); // an image error or load handler would have run
      const s = await bubbleSafety(page, i);
      assert.deepEqual(s.tags, [], 'no script/img/svg/iframe/a in the bubble');
      assert.deepEqual(s.attrs, [], 'no on*/href/src in the bubble');
      assert.equal(s.flag, undefined, 'window.__x not set');
      assert.equal((await shownAt(page, i)).text, shown);
    } finally { await context.close(); }
  });
}

// ---------------------------------------------------------------------------
// Performance: linear parsing of long texts full of unmatched markers
// ---------------------------------------------------------------------------
// The parser (text -> parts, pure) must stay under PERF_LIMIT_MS for 200 000
// characters full of unmatched markers (best of 5 after a warm-up run). The
// time for 100 000 characters is logged next to it to show linear growth; it
// is not asserted because timings under load are too noisy for a ratio.
// Building the nodes and the browser's layout of the bubble depend on the
// machine and its load; they are logged and bounded loosely by PAGE_LIMIT_MS.
const PERF_LIMIT_MS = 250;
const PAGE_LIMIT_MS = 3000;
test(`performance: 200 000 characters of unmatched markers are parsed in under ${PERF_LIMIT_MS} ms (one line and many lines)`, { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await blankChat();
  try {
    const times = await page.evaluate(() => {
      const make = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
      const best = f => { f(); let m = Infinity; for (let i = 0; i < 5; i++) { const t0 = performance.now(); f(); m = Math.min(m, performance.now() - t0); } return m; };
      const out = {};
      for (const [k, unit] of [['one', '**a # '], ['many', '**a \n# **b\n']]) {
        const t = make(unit, 200000), half = make(unit, 100000);
        const parse = best(() => parseAssistantText(t));
        const parseHalf = best(() => parseAssistantText(half));
        let t0 = performance.now();
        const div = appendChatBubble('assistant', t);
        const bubble = performance.now() - t0;
        const shownLen = div.textContent.length;
        document.getElementById('chatMessages').innerHTML = '';
        t0 = performance.now();
        appendChatBubble('user', t);
        const plain = performance.now() - t0;
        document.getElementById('chatMessages').innerHTML = '';
        out[k] = { parse, parseHalf, bubble, plain, shownLen };
      }
      return out;
    });
    for (const k of ['one', 'many']) {
      const x = times[k];
      console.log(`# markdown ${k}: parse ${x.parse.toFixed(1)} ms (100 000 chars: ${x.parseHalf.toFixed(1)} ms), assistant bubble in the page ${x.bubble.toFixed(1)} ms, plain bubble ${x.plain.toFixed(1)} ms`);
      assert.ok(x.parse < PERF_LIMIT_MS, `${k}: parse ${x.parse} ms`);
      assert.ok(x.bubble < PAGE_LIMIT_MS, `${k}: bubble in the page ${x.bubble} ms`);
    }
    assert.equal(times.one.shownLen, 200000, 'one line: nothing removed (no valid marker)');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// Scope: only assistant texts are formatted
// ---------------------------------------------------------------------------
test('scope: user, notice and error bubbles keep **x** and # as written', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await blankChat();
  try {
    for (const role of ['user', 'notice', 'error']) {
      for (const input of ['**x** ve **y**', '# başlık']) {
        const r = await render(page, input, role);
        assert.equal(r.text, input, `${role}: ${input}`);
        assert.deepEqual(r.strong, [], `${role}: ${input}`);
      }
    }
    // A notice with several lines (array) stays plain too.
    const i = await page.evaluate(() => {
      const div = appendChatBubble('notice', ['**a**', '# b']);
      return [...document.querySelectorAll('#chatMessages .chat-bubble')].indexOf(div);
    });
    assert.equal(await page.evaluate(i => document.querySelectorAll('#chatMessages .chat-bubble')[i].querySelectorAll('strong').length, i), 0);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// Every path that shows an assistant text
// ---------------------------------------------------------------------------
test('path: a live /start result is formatted', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await openPage({ start: () => [200, { session_id: 'S1', message: MD, language: 'tr', reused: false }] });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.chat-bubble.assistant');
    const r = await lastAssistant(page);
    assert.equal(r.text, MD_SHOWN);
    assert.deepEqual(r.strong, MD_STRONG);
  } finally { await context.close(); }
});

test('path: a live /continue answer is formatted; the question stays plain', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({
    start: () => startOk('S1'), cont: () => [200, { message: 'Cevap: **Mars** güçlü.', ...bal(0) }],
  });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    await page.fill('#chatInput', '**Mars** ne durumda?');
    await page.click('#chatSendBtn');
    await until(() => calls.continue.length === 1, '/continue');
    await page.waitForSelector('.chat-bubble.assistant >> text=Cevap:');
    const r = await lastAssistant(page);
    assert.equal(r.text, 'Cevap: Mars güçlü.');
    assert.deepEqual(r.strong, ['Mars']);
    const q = await page.locator('.chat-bubble.user').last().textContent();
    assert.equal(q, '**Mars** ne durumda?');
    assert.equal(await page.locator('.chat-bubble.user strong').count(), 0);
  } finally { await context.close(); }
});

test('path: a saved report opened from My reports is formatted; its user messages stay plain', { timeout: TEST_TIMEOUT_MS }, async () => {
  const s = sess('saved');
  const { context, page } = await openPage({
    chart: false, history: (a, off) => (off ? [] : [s]),
    detail: () => ({ ...s, messages: [
      { role: 'assistant', content: MD, created_at: '2026-10-10T09:30:00+00:00' },
      { role: 'user', content: '**soru** # değil', created_at: '2026-10-10T09:31:00+00:00' },
      { role: 'assistant', content: '### Cevap\n**Evet**.', created_at: '2026-10-10T09:32:00+00:00' },
    ] }),
  });
  try {
    await openReports(page);
    await page.click('#reportsList .report-row[data-session-id="saved"]');
    await page.waitForSelector('.chat-bubble.assistant >> text=Genel Bakış');
    const texts = await page.$$eval('#chatMessages .chat-bubble', bs => bs.map(b => [b.className, b.textContent, b.querySelectorAll('strong').length]));
    assert.deepEqual(texts, [
      ['chat-bubble assistant', MD_SHOWN, 4],
      ['chat-bubble user', '**soru** # değil', 0],
      ['chat-bubble assistant', 'Cevap\nEvet.', 2],
    ]);
  } finally { await context.close(); }
});

test('path: a saved report opened by a category click (quote "none") is formatted', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await openPage({
    quote: Q.none('saved'), detail: () => ({ ...sess('saved'), messages: [{ role: 'assistant', content: MD, created_at: '2026-10-10T09:30:00+00:00' }] }),
  });
  try {
    await clickCategory(page, 'personality');
    await page.waitForSelector('.chat-bubble.assistant >> text=Genel Bakış');
    const r = await lastAssistant(page);
    assert.equal(r.text, MD_SHOWN);
    assert.deepEqual(r.strong, MD_STRONG);
  } finally { await context.close(); }
});

test('path: a result after the automatic wait (resend after request_in_progress) is formatted', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({
    clock: true,
    start: (b, n) => (n === 1 ? [409, { error: 'request_in_progress', detail: 'x' }] : [200, { session_id: 'S1', message: MD, language: 'tr', reused: false }]),
  });
  try {
    await clickCategory(page, 'personality');
    await until(() => calls.start.length === 1, 'the first /start');
    await page.waitForSelector('.pending-retry-btn');
    await page.clock.fastForward(11_000);
    await until(() => calls.start.length === 2, 'the automatic resend');
    await page.waitForSelector('.chat-bubble.assistant');
    const r = await lastAssistant(page);
    assert.equal(r.text, MD_SHOWN);
    assert.deepEqual(r.strong, MD_STRONG);
  } finally { await context.close(); }
});

test('path: a report resumed after a reload (pending record) opens formatted', { timeout: TEST_TIMEOUT_MS }, async () => {
  const seed = [seedRecord('u1', 'rid-1', startBody('rid-1'))];
  const { context, page, calls } = await openPage({
    seed, chart: false, start: () => [200, { session_id: 'R1', message: MD, language: 'tr', reused: false }],
    detail: () => ({ ...sess('R1'), messages: [{ role: 'assistant', content: MD, created_at: '2026-10-10T09:30:00+00:00' }] }),
  });
  try {
    await until(() => calls.start.length === 1, 'the resumed /start');
    await page.waitForSelector('.chat-bubble.assistant >> text=Genel Bakış');
    const r = await lastAssistant(page);
    assert.equal(r.text, MD_SHOWN);
    assert.deepEqual(r.strong, MD_STRONG);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// A missing or null message gives an empty assistant bubble (never "null" or
// "undefined"); the rest of the flow is unchanged.
// ---------------------------------------------------------------------------
const assistantTexts = page => page.$$eval('#chatMessages .chat-bubble.assistant', bs => bs.map(b => b.textContent));
const noNullText = async page => {
  const all = await page.textContent('#chatMessages');
  assert.ok(!all.includes('null') && !all.includes('undefined'), `no "null"/"undefined" in the chat: ${JSON.stringify(all)}`);
};
for (const [name, body] of [['message: null', { message: null }], ['no message field', {}]]) {
  test(`/start answer with ${name}: an empty assistant bubble; session and question box as usual`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { context, page, calls } = await openPage({ start: () => [200, { session_id: 'S1', language: 'tr', reused: false, ...body }] });
    try {
      assert.equal((await assistantTexts(page)).length, 0);
      await clickCategory(page, 'personality');
      await until(() => calls.start.length === 1, '/start');
      await page.waitForSelector('#chatMessages .chat-bubble.assistant');
      assert.deepEqual(await assistantTexts(page), [''], 'one assistant bubble, empty');
      await noNullText(page);
      assert.equal(await page.evaluate(() => interpretSessionId), 'S1', 'session_id taken');
      // The report balance (1 free + 2 credits) fills the counter and opens the question box.
      await page.waitForFunction(() => document.getElementById('chatRemaining').textContent === 'Kalan soru hakkın: 3');
      assert.equal(await page.locator('#chatInput').isDisabled(), false, 'question box open');
    } finally { await context.close(); }
  });
  test(`/continue answer with ${name}: an empty assistant bubble after the question; the counter updates`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { context, page, calls } = await openPage({ start: () => startOk('S1'), cont: () => [200, { ...bal(0, 4), ...body }] });
    try {
      await clickCategory(page, 'personality');
      await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
      await page.waitForFunction(() => document.getElementById('chatRemaining').textContent === 'Kalan soru hakkın: 3');
      await page.fill('#chatInput', 'Soru');
      await page.click('#chatSendBtn');
      await until(() => calls.continue.length === 1, '/continue');
      await page.waitForFunction(() => document.getElementById('chatRemaining').textContent === 'Kalan soru hakkın: 4');
      const bubbles = await page.$$eval('#chatMessages .chat-bubble', bs => bs.map(b => [b.className, b.textContent]));
      assert.deepEqual(bubbles.slice(-2), [['chat-bubble user', 'Soru'], ['chat-bubble assistant', '']], 'an empty assistant bubble right after the question');
      assert.deepEqual(await assistantTexts(page), ['Rapor metni S1', '']);
      await noNullText(page);
      assert.equal(await page.locator('#chatInput').isDisabled(), false, 'question box open');
    } finally { await context.close(); }
  });
}
