// Browser integration test for the "İlişkiler" (relationships) group: three
// cards on one API category with a sub-type, the sub-type in quote, /start,
// the saved request, My reports, "Yeniden üret", records with a missing or
// unknown sub-type, fast switching between cards and a language change.
// The API is mocked with page.route; no real backend is called.
// Run: npm test
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness, TEST_TIMEOUT_MS, HOOK_TIMEOUT_MS, closeOpenContexts } = require('./helpers/harness.cjs');
const {
  useHarness, UUID, delay, gate, until, Q, startOk, bal, sess, openPage, clickCategory, text, count, openReports, nextFrame,
  seedRecord, pendingKeys, keyFor,
} = require('./helpers/interpret-page.cjs');

let h;
before(async () => { h = await startHarness(); useHarness(h); }, { timeout: HOOK_TIMEOUT_MS });
afterEach(async () => { await closeOpenContexts(h?.browser); }, { timeout: HOOK_TIMEOUT_MS });
after(async () => { await h?.close(); }, { timeout: HOOK_TIMEOUT_MS });

const TYPES = ['parent', 'romantic', 'friendship'];
const CARD = t => `relationship_${t}`;
const TEXTS = {
  tr: {
    group: 'İlişkiler', generic: 'İlişki',
    parent: ['Anne-Baba İlişkileri', 'Anne-babanla ilişkilerindeki eğilimlerin'],
    romantic: ['Romantik İlişkiler', 'Romantik ilişkilerde bağ kurma biçimin'],
    friendship: ['Arkadaşlık', 'Arkadaşlıklarında ve topluluklarla ilişkilerindeki eğilimlerin'],
  },
  en: {
    group: 'Relationships', generic: 'Relationship',
    parent: ['Relationships with Parents', 'Your tendencies in your relationships with your parents'],
    romantic: ['Romantic Relationships', 'How you form bonds in romantic relationships'],
    friendship: ['Friendship', 'Your tendencies in friendships and communities'],
  },
};
const SAME = 'Bu rapor yeniden üretilecek; mevcut rapor okunabilir kalır.';
const FRESH = 'Bu bilgilerle yeni bir rapor oluşturulacak; mevcut rapor okunabilir kalır.';
const rel = (id, type, more = {}) => sess(id, { category: 'relationship', relationship_type: type, ...more });
const msgsOf = id => [{ role: 'assistant', content: `Rapor metni ${id}`, created_at: '2026-10-10T09:30:00+00:00' }];
const detailFrom = list => id => {
  const s = list.find(x => x.session_id === id);
  return s ? { ...s, messages: msgsOf(id) } : [404, { detail: 'x' }];
};
const bodyFor = type => ({ chart_id: 'chart-1', category: 'relationship', language: 'tr', relationship_type: type });
const rowSel = id => `#reportsList .report-row[data-session-id="${id}"]`;
async function settle(page) { await nextFrame(page); await delay(150); await nextFrame(page); }
async function openRow(page, id) {
  await openReports(page);
  await page.click(rowSel(id));
  await page.waitForSelector(`.chat-bubble.assistant >> text=Rapor metni ${id}`);
}
const backToCategories = async page => {
  await page.click('#chatBackBtn');
  await page.waitForSelector('#categoryPanel', { state: 'visible' });
};
// No request body ever carries a card id.
function noCardIds(calls) {
  for (const kind of ['quote', 'start', 'continue']) {
    for (const c of calls[kind]) assert.ok(!/relationship_(parent|romantic|friendship)/.test(c.raw), `${kind}: no card id in ${c.raw}`);
  }
}

// ---------------------------------------------------------------------------
// a. Group and cards
// ---------------------------------------------------------------------------
test('a group: after "Kişilik & Yaşam", before "Özel"; three cards with the TR/EN texts in order; not locked for a non-subscriber', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page } = await openPage({ subscribed: false });
  try {
    for (const locale of ['tr', 'en']) {
      await page.evaluate(l => setLocale(l), locale);
      const groups = await page.$$eval('#categoryGroups .category-group-label', els => els.map(e => e.textContent));
      const T = TEXTS[locale];
      const i = groups.indexOf(T.group);
      assert.ok(i > 0, `${locale}: group shown: ${groups}`);
      assert.equal(groups[i - 1], locale === 'tr' ? 'Kişilik & Yaşam' : 'Personality & Life');
      assert.equal(groups[i + 1], locale === 'tr' ? 'Özel' : 'Special');
      const cards = await page.$$eval('#categoryGroups .category-group', (gs, label) => {
        const g = gs.find(x => x.querySelector('.category-group-label').textContent === label);
        return [...g.querySelectorAll('.category-card')].map(c => ({
          onclick: c.getAttribute('onclick'), title: c.querySelector('.category-card-title').textContent,
          desc: c.querySelector('.category-card-desc').textContent, locked: c.classList.contains('locked') || !!c.querySelector('.category-lock-icon'),
        }));
      }, T.group);
      assert.deepEqual(cards, TYPES.map(t => ({ onclick: `selectCategory('${CARD(t)}')`, title: T[t][0], desc: T[t][1], locked: false })));
    }
  } finally { await context.close(); }
});

test('a logged out: the cards are not locked; a click opens the sign-in screen, no /quote, no /start', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ token: null, chart: false });
  try {
    await page.evaluate(() => { showInterpretArea('chart-1'); renderCategoryGrid(); });
    for (const t of TYPES) {
      const card = page.locator(`button.category-card[onclick="selectCategory('${CARD(t)}')"]`);
      assert.equal(await card.evaluate(el => el.classList.contains('locked') || !!el.querySelector('.category-lock-icon')), false, `${t}: not locked`);
    }
    await clickCategory(page, CARD('romantic'));
    await page.waitForSelector('#authModalBackdrop', { state: 'visible' });
    await settle(page);
    assert.equal(calls.quote.length, 0);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// b. Bodies per card
// ---------------------------------------------------------------------------
test('b each card: quote and /start bodies carry category "relationship" and its own relationship_type; no time zone, no card id', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ quote: Q.sub, start: b => startOk(`S-${b.relationship_type}`) });
  try {
    for (const t of TYPES) {
      const q = calls.quote.length, s = calls.start.length;
      await clickCategory(page, CARD(t));
      await page.waitForSelector(`.chat-bubble.assistant >> text=Rapor metni S-${t}`);
      assert.equal(await text(page, '#chatCategoryTitle'), TEXTS.tr[t][0]);
      assert.equal(calls.quote.length, q + 1);
      assert.equal(calls.start.length, s + 1);
      assert.deepEqual(calls.quote[q].body, bodyFor(t), `${t}: quote body`);
      const { request_id, expected_spend, ...rest } = calls.start[s].body;
      assert.deepEqual(rest, bodyFor(t), `${t}: /start body`);
      assert.match(request_id, UUID);
      assert.equal(expected_spend, 'subscription');
      await backToCategories(page);
    }
    noCardIds(calls);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// c. Quote branches (romantic)
// ---------------------------------------------------------------------------
test('c quote "none": the saved romantic report opens with its title, no /start', { timeout: TEST_TIMEOUT_MS }, async () => {
  const det = { ...rel('saved-r', 'romantic'), messages: msgsOf('saved-r') };
  const { context, page, calls } = await openPage({ quote: Q.none('saved-r'), detail: () => det });
  try {
    await clickCategory(page, CARD('romantic'));
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni saved-r');
    assert.equal(await text(page, '#chatCategoryTitle'), 'Romantik İlişkiler');
    await settle(page);
    assert.equal(calls.start.length, 0);
    assert.deepEqual(calls.detail, ['saved-r']);
  } finally { await context.close(); }
});

test('c quote "subscription": /start without a confirm', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ quote: Q.sub, start: () => startOk('S1') });
  try {
    await clickCategory(page, CARD('romantic'));
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(await count(page, '.quote-confirm-btn'), 0);
    assert.equal(calls.start.length, 1);
    assert.equal(calls.start[0].body.expected_spend, 'subscription');
    assert.equal(calls.start[0].body.relationship_type, 'romantic');
  } finally { await context.close(); }
});

test('c quote "report_credit": the confirm screen; /start only after the confirm', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ quote: Q.credit, credits: () => ({ report_credits: 2 }), start: () => startOk('S1') });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.report_credits === 2);
    await clickCategory(page, CARD('romantic'));
    await page.waitForSelector('.quote-confirm-btn');
    assert.match(await text(page, '.chat-bubble.notice'), /1 rapor hakkı kullanılacak\./);
    await settle(page);
    assert.equal(calls.start.length, 0, 'no /start before the confirm');
    await page.click('.quote-confirm-btn');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(calls.start.length, 1);
    assert.equal(calls.start[0].body.expected_spend, 'report_credit');
    assert.equal(calls.start[0].body.relationship_type, 'romantic');
  } finally { await context.close(); }
});

test('c quote "report_credit" with no credits: "Rapor hakkın yok", no confirm, no /start', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ quote: Q.credit, credits: () => ({ report_credits: 0 }) });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.report_credits === 0);
    await clickCategory(page, CARD('romantic'));
    await page.waitForSelector('.chat-bubble.notice >> text=Rapor hakkın yok.');
    assert.equal(await count(page, '.quote-confirm-btn'), 0);
    await settle(page);
    assert.equal(calls.start.length, 0);
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// d. Saved request
// ---------------------------------------------------------------------------
test('d uncertain result (network error): "Tekrar dene" resends the same request_id and the byte-identical body with relationship_type', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ start: (b, n) => (n === 1 ? 'abort' : startOk('S1')) });
  try {
    await clickCategory(page, CARD('friendship'));
    await page.waitForSelector('.pending-retry-btn');
    const first = calls.start[0];
    assert.equal(first.body.relationship_type, 'friendship');
    assert.deepEqual(await pendingKeys(page), [keyFor('u1', first.body.request_id)], 'kept');
    await page.click('.pending-retry-btn');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S1');
    assert.equal(calls.start.length, 2);
    assert.equal(calls.start[1].raw, first.raw, 'byte-identical body');
    assert.deepEqual(await pendingKeys(page), []);
  } finally { await context.close(); }
});

test('d definitive error (request_failed): a new click makes a new request with a NEW request_id and the same relationship_type', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ start: (b, n) => (n === 1 ? [409, { error: 'request_failed', detail: 'x' }] : startOk('S2')) });
  try {
    await clickCategory(page, CARD('friendship'));
    await page.waitForSelector('.chat-bubble.error >> text=İstek tamamlanamadı, hakkın iade edildi.');
    assert.equal(await count(page, '.pending-retry-btn'), 0);
    assert.deepEqual(await pendingKeys(page), []);
    await backToCategories(page);
    await clickCategory(page, CARD('friendship'));
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S2');
    assert.equal(calls.start.length, 2);
    const [a, b] = calls.start.map(s => s.body);
    assert.notEqual(b.request_id, a.request_id, 'a new request_id');
    assert.equal(b.relationship_type, 'friendship');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// e. My reports
// ---------------------------------------------------------------------------
test('e My reports: three sub-type rows with their own titles; an opened report takes a question by /continue', { timeout: TEST_TIMEOUT_MS }, async () => {
  const list = TYPES.map(t => rel(`r-${t}`, t));
  const { context, page, calls } = await openPage({
    chart: false, history: (a, off) => (off ? [] : list), detail: detailFrom(list), balance: () => bal(1, 2),
    cont: () => [200, { message: 'İlişki cevabı', ...bal(0, 2) }],
  });
  try {
    await openReports(page);
    for (const t of TYPES) {
      await page.waitForSelector(rowSel(`r-${t}`));
      assert.equal(await text(page, `${rowSel(`r-${t}`)} .report-row-title`), TEXTS.tr[t][0]);
    }
    await page.click(rowSel('r-parent'));
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni r-parent');
    assert.equal(await text(page, '#chatCategoryTitle'), 'Anne-Baba İlişkileri');
    await page.waitForFunction(() => !document.getElementById('chatInput').disabled);
    await page.fill('#chatInput', 'Bir sorum var');
    await page.click('#chatSendBtn');
    await page.waitForSelector('.chat-bubble.assistant >> text=İlişki cevabı');
    const { request_id, ...rest } = calls.continue[0].body;
    assert.deepEqual(rest, { session_id: 'r-parent', question: 'Bir sorum var' });
    assert.match(request_id, UUID);
  } finally { await context.close(); }
});

test('e "Yarım kalan istekler" labels show the sub-type titles', { timeout: TEST_TIMEOUT_MS }, async () => {
  const seed = TYPES.map((t, i) => seedRecord('u1', `rid-${t}`, { ...bodyFor(t), request_id: `rid-${t}`, expected_spend: 'subscription' },
    { created_at: i + 1, paused: true }));
  const { context, page, calls } = await openPage({ chart: false, seed, history: () => [] });
  try {
    await openReports(page);
    await page.waitForSelector('#pendingItems .pending-item');
    const labels = await page.$$eval('#pendingItems .pending-item-label', els => els.map(e => e.textContent.trim()).sort());
    assert.deepEqual(labels, TYPES.map(t => `Yarım kalan istek: ${TEXTS.tr[t][0]}`).sort());
    await settle(page);
    assert.equal(calls.start.length, 0, 'paused records are not sent');
  } finally { await context.close(); }
});

test('e "Sonuçlanan istekler": a /start that ends with a definitive error while on another screen gets a note with the sub-type title', { timeout: TEST_TIMEOUT_MS }, async () => {
  const g = gate();
  const { context, page, calls } = await openPage({
    history: () => [], start: async () => { await g.wait(); return [409, { error: 'request_failed', detail: 'x' }]; },
  });
  try {
    await clickCategory(page, CARD('romantic'));
    await until(() => calls.start.length === 1, '/start');
    await openReports(page);
    const resp = page.waitForResponse(r => r.url().endsWith('/interpret/start'));
    g.open();
    await resp;
    await page.waitForSelector('#pendingNotes .pending-note');
    assert.equal((await text(page, '#pendingNotes .pending-note .pending-item-label')).trim(), 'Rapor isteği: Romantik İlişkiler');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// f. Missing or unknown sub-type
// ---------------------------------------------------------------------------
for (const [name, type] of [['null', null], ['"xyz"', 'xyz']]) {
  test(`f relationship_type ${name}: "İlişki", readable, question box closed, no "Yeniden üret"; forced triggers send nothing`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const s = rel('bad', type);
    const { context, page, calls } = await openPage({
      chart: false, history: (a, off) => (off ? [] : [s]), detail: detailFrom([s]), balance: () => bal(1, 2),
      quote: Q.sub, start: () => startOk('NO'),
    });
    try {
      await openReports(page);
      await page.waitForSelector(rowSel('bad'));
      assert.equal(await text(page, `${rowSel('bad')} .report-row-title`), 'İlişki');
      await page.click(rowSel('bad'));
      await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni bad');
      assert.equal(await text(page, '#chatCategoryTitle'), 'İlişki');
      await page.waitForSelector('.chat-bubble.notice >> text=Bu rapor türüne buradan soru sorulamıyor');
      await settle(page);
      assert.equal(await page.isDisabled('#chatInput'), true, 'question box closed');
      assert.equal(await page.isDisabled('#chatSendBtn'), true);
      assert.equal(await page.$eval('#regenBtn', b => b.style.display), 'none', 'no "Yeniden üret"');
      // The open report and the list (the category grid and badges always name the three cards).
      const shown = (await text(page, '#chatPanel')) + (await text(page, '#reportsPanel'));
      for (const t of TYPES) assert.ok(!shown.includes(TEXTS.tr[t][0]), `no default sub-type title: ${t}`);
      await page.evaluate(() => setLocale('en'));
      assert.equal(await text(page, '#chatCategoryTitle'), 'Relationship');
      await page.evaluate(() => setLocale('tr'));
      // Forced triggers: the regenerate entry, a hand-made regenerate source,
      // a hand-made quote/start flow with this body, and the question box.
      await page.evaluate(rt => {
        startRegenerate();
        setRegenSource({ sessionId: 'bad', chartId: 'chart-1', category: 'relationship', relationshipType: rt, language: 'tr' });
        startRegenerate();
        const flow = { catId: 'x', quoteBody: { chart_id: 'chart-1', category: 'relationship', language: 'tr', relationship_type: rt },
          flowId: tzPickerFlowId, view: chatViewId, account: currentAccountKey(), tzRetry: null };
        runQuote(flow, 'click');
        sendStart(flow, 'subscription');
        const i = document.getElementById('chatInput'); i.disabled = false; i.value = 'Soru'; sendFollowUp();
      }, type);
      await settle(page);
      assert.equal(await page.$eval('#regenBtn', b => b.style.display), 'none');
      assert.equal(calls.quote.length, 0, 'no /quote');
      assert.equal(calls.start.length, 0, 'no /start');
      assert.equal(calls.continue.length, 0, 'no /continue');
    } finally { await context.close(); }
  });
}

// ---------------------------------------------------------------------------
// g. Yeniden üret
// ---------------------------------------------------------------------------
// Each test first generates a romantic report by a card click (request R0,
// session M0). Branch (i) regenerates M0; branch (ii) opens an older PARENT
// report (SRC) from My reports, so the sub-type must come from its detail.
const SRC = 'old-parent';
async function regenSetup(quote, { others = [] } = {}) {
  const list = [rel(SRC, 'parent'), ...others];
  const r = await openPage({ quote, history: (a, off) => (off ? [] : list), detail: detailFrom(list), start: (b, n) => startOk(n === 1 ? 'M0' : 'NEW') });
  await clickCategory(r.page, CARD('romantic'));
  await r.page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni M0');
  return { ...r, r0: r.calls.start[0].body.request_id };
}
const confirmBubble = page => page.locator('.chat-bubble:has(.regen-confirm-btn)').last().textContent();
async function confirmAndCheck({ page, calls, r0 }, spend, forced, type) {
  await page.waitForSelector('.regen-confirm-btn');
  const shown = await confirmBubble(page);
  assert.ok(shown.includes(forced ? SAME : FRESH), shown);
  assert.ok(!shown.includes(forced ? FRESH : SAME), shown);
  await settle(page);
  assert.equal(calls.start.length, 1, 'no /start before the confirm');
  await page.click('.regen-confirm-btn');
  await until(() => calls.start.length === 2, 'the regen /start');
  const b = calls.start[1].body;
  assert.match(b.request_id, UUID);
  assert.notEqual(b.request_id, r0, 'a new request_id');
  assert.equal(b.expected_spend, spend);
  assert.equal(b.category, 'relationship');
  assert.equal(b.relationship_type, type);
  assert.equal(b.force_regenerate === true, forced);
  assert.equal('timezone' in b, false);
  await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni NEW');
  assert.equal(await text(page, '#chatCategoryTitle'), TEXTS.tr[type][0]);
  noCardIds(calls);
}

for (const [spend, priced] of [['subscription', Q.sub], ['report_credit', Q.credit]]) {
  test(`g (i) today's live romantic report, ${spend}: forced quote keeps relationship_type; forced text; /start with force and the same sub-type`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const r = await regenSetup((b, n) => (n === 1 ? Q.sub() : n === 2 ? Q.none('M0')() : priced()));
    try {
      await r.page.click('#regenBtn');
      await r.page.waitForSelector('.regen-confirm-btn');
      assert.equal(r.calls.quote.length, 3);
      assert.deepEqual(r.calls.quote[1].body, bodyFor('romantic'), 'step (a)');
      assert.deepEqual(r.calls.quote[2].body, { ...bodyFor('romantic'), force_regenerate: true }, 'forced quote');
      await confirmAndCheck(r, spend, true, 'romantic');
    } finally { await r.context.close(); }
  });

  test(`g (ii) an older parent report from My reports, ${spend}: unforced; the sub-type comes from the report detail`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const r = await regenSetup((b, n) => (n === 1 ? Q.sub() : priced()));
    try {
      await r.page.click('#chatBackBtn');
      await openRow(r.page, SRC);
      await r.page.click('#regenBtn');
      await r.page.waitForSelector('.regen-confirm-btn');
      assert.equal(r.calls.quote.length, 2, 'no forced quote');
      assert.deepEqual(r.calls.quote[1].body, bodyFor('parent'));
      await confirmAndCheck(r, spend, false, 'parent');
    } finally { await r.context.close(); }
  });
}

test('g (ii) an older parent report, quote "none" for another session: "Raporu aç", no production', { timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await regenSetup((b, n) => (n === 1 ? Q.sub() : Q.none('OTHER')()), { others: [rel('OTHER', 'parent')] });
  try {
    await r.page.click('#chatBackBtn');
    await openRow(r.page, SRC);
    await r.page.click('#regenBtn');
    await r.page.waitForSelector('.regen-open-btn');
    await settle(r.page);
    assert.equal(r.calls.quote.length, 2, 'no forced quote');
    assert.equal(r.calls.quote[1].body.relationship_type, 'parent');
    assert.equal(await count(r.page, '.regen-confirm-btn'), 0);
    await r.page.click('.regen-open-btn');
    await r.page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni OTHER');
    assert.equal(r.calls.start.length, 1, 'no production');
  } finally { await r.context.close(); }
});

// ---------------------------------------------------------------------------
// h. Fast switching
// ---------------------------------------------------------------------------
test('h fast switch: a late romantic quote answer sends nothing; the only /start is for parent', { timeout: TEST_TIMEOUT_MS }, async () => {
  const g = gate();
  const { context, page, calls } = await openPage({
    quote: async b => { if (b.relationship_type === 'romantic') await g.wait(); return Q.sub(); },
    start: b => startOk(`S-${b.relationship_type}`),
  });
  try {
    await clickCategory(page, CARD('romantic'));
    await until(() => calls.quote.length === 1, 'the romantic quote');
    await backToCategories(page);
    await clickCategory(page, CARD('parent'));
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S-parent');
    const late = page.waitForResponse(r => r.url().endsWith('/interpret/quote') && r.request().postData().includes('romantic'));
    g.open();
    await late;
    await settle(page);
    assert.equal(calls.start.length, 1, 'one /start');
    assert.equal(calls.start[0].body.relationship_type, 'parent');
    assert.equal(await text(page, '#chatCategoryTitle'), 'Anne-Baba İlişkileri');
  } finally { await context.close(); }
});

test('h fast switch: the romantic confirm button pressed after switching to parent sends no /start', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { context, page, calls } = await openPage({ quote: Q.credit, credits: () => ({ report_credits: 2 }), start: b => startOk(`S-${b.relationship_type}`) });
  try {
    await page.waitForFunction(() => creditBalance && creditBalance.report_credits === 2);
    await clickCategory(page, CARD('romantic'));
    await page.waitForSelector('.quote-confirm-btn');
    await page.evaluate(() => { window.__oldConfirm = document.querySelector('.quote-confirm-btn'); });
    await backToCategories(page);
    await clickCategory(page, CARD('parent'));
    await page.waitForSelector('.quote-confirm-btn');
    await page.evaluate(() => window.__oldConfirm.click());
    await settle(page);
    assert.equal(calls.start.length, 0, 'the old confirm sends nothing');
    await page.click('.quote-confirm-btn');
    await page.waitForSelector('.chat-bubble.assistant >> text=Rapor metni S-parent');
    assert.equal(calls.start.length, 1);
    assert.equal(calls.start[0].body.relationship_type, 'parent');
  } finally { await context.close(); }
});

// ---------------------------------------------------------------------------
// i. Language change
// ---------------------------------------------------------------------------
test('i language: with a friendship report open from My reports, TR -> EN turns the title into the EN sub-type title', { timeout: TEST_TIMEOUT_MS }, async () => {
  const list = [rel('fr', 'friendship')];
  const { context, page } = await openPage({ chart: false, history: (a, off) => (off ? [] : list), detail: detailFrom(list) });
  try {
    await openRow(page, 'fr');
    assert.equal(await text(page, '#chatCategoryTitle'), 'Arkadaşlık');
    await page.evaluate(() => setLocale('en'));
    assert.equal(await text(page, '#chatCategoryTitle'), 'Friendship');
    await page.evaluate(() => setLocale('tr'));
    assert.equal(await text(page, '#chatCategoryTitle'), 'Arkadaşlık');
  } finally { await context.close(); }
});
