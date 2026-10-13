# Plan: Kayıtlı raporlar, önizleme (quote) ve güvenli üretim

Durum: **YALNIZCA PLAN.** Bu PR'da kod yok; `index.html` değişmedi.

- Frontend tabanı: `theoden77/stellafix-frontend` main `09dd737`
- Backend referansı (salt okuma): `theoden77/stellafix-backend` main `7d6c675` (PR-2b dahil)
- Kapsam: arayüzdeki 8 kategori. Bunlar `weekly_review`, `monthly_review`, `yearly_review`,
  `personality`, `career`, `finance`, `health` ve `eclipse_nearest` (`index.html:3565-3574`).
  Evlilik, ilişki ve zamanlama arayüzde olmadığı için bu planın kapsamında değil.

Kaynak gösterme kuralı: Backend davranışına dair her iddianın yanında `dosya:satır` ya da şema
adı var. `BE:` öneki `stellafix-backend@7d6c675`, `FE:` öneki `stellafix-frontend@09dd737`
anlamına gelir. Kaynakla gösterilemeyen iddialar **[doğrulanmadı]** diye işaretlendi.

---

## 1. Mevcut durum

### 1.1 Kategori tıklaması: bugünkü sıra (`FE:index.html:4081-4154`, `selectCategory`)

1. Token yoksa giriş modalı açılır ve akış durur (`:4086`).
2. tz-picker yarış koruması devreye girer. Bu bir retry ise `isTzRetryStillValid` kontrol edilir,
   değilse `tzPickerFlowId++` yapılır (`:4087-4091`).
3. Sohbet paneli açılır. `interpretSessionId` ve `questionCreditInfo` sıfırlanır (`:4092-4100`).
4. **Kilit önce gelir:** `categoryBlockedByLock(catId)` true ise API'ye hiç gidilmez. Ekranda
   `errCategoryLocked` ve "Abone Ol" görünür (`:4109-4114`). Kilit,
   `SUBSCRIBER_ONLY_CATEGORIES` listesinden (`:3585`) ve `creditBalance.has_active_subscription`
   değerinden hesaplanır. Bakiye henüz yüklenmediyse kilit engellemez (`:3599-3601`).
5. Gövde `{chart_id, category, language}` olarak kurulur. `PERIOD_CATEGORIES` (`:3836`) için
   `timezone` eklenir. Saat dilimi yoksa picker açılır ve istek gönderilmez (`:4116-4123`).
6. Retry için geçerlilik bir kez daha kontrol edilir (`:4128`).
7. `POST /api/v1/interpret/start` gönderilir (`:4132`). Başarılı olursa `handleStartResponse` ve
   `fetchCreditBalance()` çalışır (`:4148-4149`). **Başarılı yanıt asla atılmaz:** başarı dalında
   tzRetry kontrolü kasıtlı olarak yok (`:4143-4147`). Bu kural
   `tests/timezone-flow.test.cjs:349` ile korunuyor.
8. Ağ hatasında genel `chatErrorMessage` gösterilir. **Yeniden deneme yoktur.**

`period_type` gönderilmiyor. Backend varsayılanı uyguluyor: haftalıkta `rolling_7d`, aylıkta
`rolling_30d`, yıllıkta `next_12_months` (`BE:app/schemas.py:379-387`,
`InterpretStartRequest._check_period_type`).

### 1.2 Soru (`FE:index.html:4156-4188`, `sendFollowUp`)

Gövde `{session_id, question}`. Gösterge yalnızca `/continue` yanıtından dolar
(`handleContinueResponse`, `:3818-3822`). `/start` yanıtında bakiye yok, bu yüzden gösterge ilk
sorunun cevabına kadar boş kalıyor (`:3815`). Ağ hatasında da yeniden deneme yok.

### 1.3 Çağrılan uçlar (bugün)

`/api/v1/credits/balance`, `/api/v1/interpret/start`, `/api/v1/interpret/continue`,
`/api/v1/timezone`, `/api/v1/auth/request-link`, `/api/v1/auth/verify`, `/natal`.

**Çağrılmayanlar:** `/interpret/history`, `/interpret/{session_id}`,
`/interpret/{session_id}/balance` ve `/interpret/quote`. Ayrıca `request_id`, `expected_spend`
ve `force_regenerate` hiçbir yerde gönderilmiyor.

### 1.4 Hata eşlemesi (`FE:index.html:1670-1721`)

| Durum | Bugün gösterilen |
|---|---|
| 401 | `errAuthRequired` ve `handleUnauthorized` (token temizlenir, giriş modalı açılır; `:1384-1392`) |
| 402 `insufficient_credits` | `credit_type`'a göre rapor ya da soru hakkı bitti mesajı ve "Abone Ol" |
| 403 `category_requires_subscription` | `errCategoryLocked` ve "Abone Ol" |
| **Diğer tüm 403'ler** | `errForbidden` ("erişimin yok"). **`category_disabled` de buraya düşüyor**, bu yanlış bir mesaj |
| 404 | `errNotFoundSession` |
| 409 (hepsi) | **Ayrı dal yok.** Genel `chatErrorMessage` gösteriliyor |
| 422 timezone | Picker açılıyor (`timezoneErrorType`, `:1697-1704`). Diğer 422'ler `errInvalidInput` |
| 429 / 502 | `errRateLimited` / `errUpstream` |

### 1.5 Test kapsamı

- `tests/timezone-flow.test.cjs` içinde 12 test var. Saat dilimi akışını, 422 dönüşümlerini,
  tz-picker yarışlarını ve "gönderilmiş /start yanıtı atılmaz" kuralını kapsıyorlar. Test
  sayısını dosyadaki `test(` çağrılarını sayarak buldum; testleri çalıştırmadım.
- `package.json` içindeki `"test"` komutu yalnızca bu dosyayı çalıştırıyor. Kilit dosyası yok.
  Mevcut tek workflow (`build-cities.yml`) yalnızca elle tetikleniyor (`workflow_dispatch`); test
  çalıştıran bir CI yok.
- Testler `localStorage.stellafix_token='test-token'` kullanıyor. Bu bir JWT değil, içinden
  `sub` okunamaz. Bunun §5'e etkisi var.

---

## 2. Kayıtlı rapora erişim: OKUMA ile YENİ CEVAP ayrıdır

### 2.1 Okuma (ücretsiz, kapısız)

- `GET /api/v1/interpret/history?limit&offset`. `limit` varsayılanı 20, aralığı 1–100;
  `offset` ≥ 0 (`BE:app/routers/interpret.py:886-907`). Liste yalnızca çağıranın `completed` ve
  `pending` oturumlarını içerir, `failed` oturumlar listelenmez. Sıralama
  `created_at desc, session_id desc`. Yanıt şeması `InterpretHistoryResponse`
  (`BE:app/schemas.py:552`); her satır bir `InterpretSessionSummary` (`BE:app/schemas.py:522-549`).
- `GET /api/v1/interpret/{session_id}` yalnızca sahibine açık, başkası için `403 forbidden`
  döner. Yalnızca `user_facing` mesajlar gelir (`BE:interpret.py:910-937`; şema
  `InterpretSessionDetail`, `BE:app/schemas.py:564`).
- **Kapı yok:** Bu iki okuma abonelik kademesine, sağlık kill-switch'ine ve kredi kontrolüne
  takılmaz. Kaynaklar: `BE:interpret.py:881-883` ("Reading a stored report is free and is not
  gated by the category tier or the health kill switch"), `BE:docs/REVIEW_CONTEXT.md` A11 ve B
  ("kayıtlı raporun okunması ... açık kalır"). Kodda bu uçlarda `_new_generation_gate` çağrısı
  yok (`:886-937`).
- Bakiye: Oturum açılırken `GET /api/v1/interpret/{session_id}/balance` da okunur
  (`BE:interpret.py:940-962`, şema `ReportBalanceOut` `BE:app/schemas.py:494-515`). Oturum
  detayında bakiye alanı yok (`InterpretSessionDetail`, bakiye içermez).
  `questionCreditInfo` bu yanıttan doldurulur ve `chatRemaining` göstergesi
  (`updateRemainingUI`, `FE:index.html:3782`) aynı fonksiyonla çizilir. Alanlar `/continue`
  yanıtıyla aynı; iki uç da `_report_balance_fields` kullanıyor (`BE:interpret.py:51-61`).
- Bütün bu okumalar ayrı ve daha geniş bir hız kovası kullanır
  (`rate_limit_by_user_for_balance`): dakikada 30 (`BE:app/config.py:370`). `/credits/balance`
  ve `/quote` da aynı kovadadır (`BE:app/routers/credits.py:15`, `BE:interpret.py:649`).

### 2.2 Yeni `/continue` cevabı (kapılı)

Kayıtlı bir raporu açmak, ona soru sormayı serbest bırakmaz. Yeni bir `/continue` cevabı şu
kurallara tabidir:

1. **Sağlık kill-switch'i.** Kategori `health` ve `HEALTH_CATEGORY_ENABLED=false` ise
   `403 category_disabled` döner (`BE:interpret.py:694-695`; ürün kararı
   `BE:docs/REVIEW_CONTEXT.md` C1).
2. **Oturum durumu.** Pending oturumda `409 report_not_ready`, failed oturumda
   `409 report_failed` döner (`BE:interpret.py:382-385`, `:704-705`, `:787-793`).
3. **Soru hakkının finansmanı** şu sırayla denenir: abonelik, raporun ücretsiz sorusu, havuzdaki
   soru kredisi. Hiçbiri yoksa `402 insufficient_credits` ve `credit_type="question"` döner
   (`BE:interpret.py:736-761`).
4. Aynı oturumda başka bir `/continue` sürüyorsa `409 generation_in_progress` döner
   (`BE:interpret.py:699-700`).
5. **Tamamlanmış bir `request_id`'nin tekrarı her zaman açıktır.** Replay, sağlık kontrolünden
   ÖNCE çalışır (`BE:interpret.py:686-689`). Sağlık kapalı olsa bile tamamlanmış bir sorunun
   cevabı geri alınabilir.
6. `/continue` için **kategori kademesi kontrolü yok.** `/continue` gövdesinde
   `CATEGORY_TIER` okunmuyor (`BE:interpret.py:667-841`). Aboneliği bitmiş bir kullanıcı eski bir
   haftalık rapora ücretsiz soru ya da soru kredisiyle soru sorabilir. Bu, mevcut backend
   davranışının bir gözlemidir; plan bunu değiştirmez.

Arayüzde de bu ayrım korunur: Kayıtlı rapor ekranında soru kutusu `/balance`'a göre
etkinleştirilir. Kutu etkin olsa bile gönderim `/continue`'nun yanıtına tabidir. 403 ve 409
yanıtları raporu kapatmaz; rapor okunur kalır.

### 2.3 `is_live` / `superseded` gösterimi

Kaynak: `BE:app/schemas.py:541-549` ve `BE:interpret.py:848-864` (`_report_key_flags`).

- `is_live=false` ve `superseded=false`: Bu oturumun bir `report_keys` satırı yok (R0 dönemi) ya
  da satırı `failed`. **"Eski" ya da "geçersiz" etiketi KONMAZ;** rozet de gösterilmez. Şema bunu
  açıkça yazıyor: "that does NOT mean old or invalid".
- `superseded=true`: Rozet "Yeniden üretildi" olur. Rapor listede kalır, açılabilir ve
  okunabilir.
- `is_live=true` için rozet yok. "Bugün ücretsiz açılır" vaadi de verilmez: Kayan dönemlerde rapor
  kimliği değişir (`BE:app/schemas.py:542-545`). Ücret bilgisi yalnızca quote'tan gelir.
- `status="pending"`: Rozet "Hazırlanıyor" olur ve rapor salt okunur açılır (§7).

### 2.4 Liste ve sayfalama ayrıntıları

- "Daha fazla göster" düğmesi `offset += sessions.length` ile çalışır. Dönen satır sayısı
  `limit`'ten azsa düğme gizlenir. Toplam sayı alanı yok (`InterpretHistoryResponse` yalnızca
  `sessions`, `limit` ve `offset` içeriyor).
- `offset` sayfalaması en yeniden eskiye doğru ilerler. Sayfalar arasında yeni bir rapor eklenirse
  aynı satır iki kez gelebilir. Bu yüzden satırlar `session_id` ile tekilleştirilir.
- Satırda şunlar gösterilir: kategori adı, `created_at` (yerel saat) ve dönem. Dönem için
  `period_start_utc` ve `period_end_utc` kullanılır; bitiş **hariç** olduğundan gösterilen son gün
  `end − 1 gün` olur ve oturumun kendi `timezone` değeriyle çevrilir (`BE:app/schemas.py:533-534`).
- Arayüzde olmayan bir kategoriye ait satır (ör. API'den doğrudan açılmış `marriage`) genel bir
  etiketle salt okunur gösterilir. Bu satır için yeniden üretim önerilmez.
- "Raporlarım" girişi hesap menüsüne eklenir. Bugün sohbet alanı yalnızca natal hesaplamadan sonra
  görünüyor (`showInterpretArea`, `FE:index.html:3693`). Geçmiş ekranının harita hesaplanmadan da
  açılabilmesi gerekir. Bu, §5.4'teki "sayfa yenilenince sürdürme" için de ön koşul.

---

## 3. Kişi bilgisi ve geçmişten yeniden üretim (birlikte karar)

### 3.1 Bugünkü durum

- `InterpretSessionSummary` ve `InterpretSessionDetail` içinde `chart_id` da kişi adı da yok
  (`BE:app/schemas.py:522-549`; `_session_summary`, `BE:interpret.py:867-878`).
- Oturum satırında `chart_id` saklanıyor (`ConversationSession.chart_id`,
  `BE:app/models.py:135`). Backend'de `NatalChart.name` (nullable, `BE:app/models.py:110`) ve
  `NatalChart.user_id` (nullable, `BE:app/models.py:125`) alanları var. **Yeni tablo gerekmez.**
- Ad, frontend'in `/natal` çağrısında gönderdiği `name` alanından yazılıyor
  (`BE:app/routers/natal.py:147`). Frontend kutu boşsa `"Natal Harita"` / `"Natal Chart"`
  gönderiyor (`FE:index.html:2702`). Sonuç olarak birçok kayıtta ad bir yer tutucu olacak.
- Kullanıcının haritalarını listeleyen bir uç yok; `natal.py` içindeki tek route
  `POST /natal` (`BE:app/routers/natal.py:79`). Geçmişten açılan bir rapor için `chart_id` başka
  bir yerden de elde edilemiyor.
- **Sahiplik notu:** `/start` ve `/quote` chart'ı sahiplik kontrolü yapmadan okuyor
  (`_resolve_identity`, `db.get(NatalChart, payload.chart_id)`, `BE:interpret.py:260-262`).
  Bir oturumun chart'ı başka bir kullanıcıya ait olabilir ya da anonim olabilir
  (`user_id` NULL). Ad dışarı verilecekse bu ayrıca kontrol edilmelidir.

### 3.2 Seçenekler

**(a) Küçük backend PR'ı.** `InterpretSessionSummary`'ye `chart_id` ve isteğe bağlı
`chart_name` eklenir.
- `chart_id` oturumun kendisinden gelir. Oturum zaten çağırana ait, sahiplik
  `/history` filtresiyle (`:896`) ve `/{session_id}` kontrolüyle (`:921`) korunuyor.
- `chart_name` **yalnızca** `NatalChart.user_id == current_user.id` ise doldurulur, aksi halde
  `null`. Böylece başkasının haritasındaki ad sızmaz.
- `/history` için ad tek bir ek sorguyla çekilir (`_report_key_flags` gibi toplu IN sorgusu).
- Etkiler: Liste kişiye göre gruplanabilir ya da filtrelenebilir. Geçmişten yeniden üretim
  mümkün olur (`chart_id` elde). Şema eklemeli olduğu için mevcut istemciler kırılmaz.
  Yer tutucu adlar ("Natal Harita") için frontend doğum tarihini gösteremez, çünkü özette doğum
  verisi yok; bu yüzden yer tutucu ad genel bir "Kişi" etiketine çevrilir.

**(b) Kişisiz liste.** Backend değişmez.
- Etkiler: Aynı kategoriden birden fazla kişiye ait raporlar ayırt edilemez; yalnızca tarih ve
  dönem görünür. **Geçmişten "yeniden üret" yapılamaz**, çünkü `chart_id` yok. Yeniden üretim
  yalnızca o an hesaplanmış haritadaki kategori akışından yapılabilir.

**Öneri: (a).** Değişiklik küçük ve eklemeli. Hem kişi ayrımını hem geçmişten yeniden üretimi
açıyor. Karar Theo'nun (Açık karar 1).

### 3.3 Yeniden üretimin hedef dönemi

- Mevcut API geçmiş bir dönemi açık tarihlerle üretemez. `InterpretStartRequest`'te dönem
  başlangıç ve bitiş alanı yok (`BE:app/schemas.py:346-413`). Dönem isteğin anından hesaplanıyor
  (`_request_period`: `now = periods.utc_now()`, `BE:app/interpretation.py:1277-1284`).
- `force_regenerate=true` yalnızca **aynı kimlikteki** canlı raporu supersede eder
  (`BE:interpret.py:464-468`; kimliğe dönem sınırları da dahil, `_report_identity` `:226-243`).
  Kayan dönemlerde bugünün dönemi farklı bir kimlik olur. Bu yüzden eski haftalık bir raporda
  "yeniden üret" aslında `force_regenerate` değil, **bugünkü dönem için yeni bir rapor** isteğidir.
  Bu istek normal quote akışından geçer ve bugünün raporu zaten varsa ücretsiz açılır.

Seçenekler:
- **(i) Bugünkü dönemi hedefle.** Backend değişikliği gerekmez. Düğme metni bunu açıkça söyler,
  ör. "Bugünden başlayan 7 günlük dönem için yeni rapor". Eski rapor okunur kalır. Quote yanıtında
  dönem sınırı yok (`QuoteResponse`, `BE:app/schemas.py:476-482`), bu yüzden metin varsayılan
  `period_type`'tan türetilir: `rolling_7d` ise "bugünden itibaren 7 gün", `rolling_30d` ise
  "30 gün", `next_12_months` ise "12 ay". Kesin tarihler, gerekiyorsa üretimden sonra oturumun
  `period_*` alanlarından gösterilir.
- **(ii) Eski dönemi hedefle.** Backend değişikliği gerekir: açık dönem alanları, bunların kimliğe
  ve doğrulamaya katılması, geçmiş tarihli transit verisi. **Kapsam dışı; ayrı bir backend
  planı ister.**

**Öneri: (i).** Dönemsiz kategorilerde (personality, career, finance, health, eclipse_nearest)
"yeniden üret", `force_regenerate=true` ile aynı kimliği hedefler. Bu her zaman ücretlidir ve her
durumda açık onay ister (§4.3). Karar Theo'nun (Açık karar 2).

Gövdede hangi değerlerin kullanılacağı:
- `language` için oturumun `language` değeri kullanılır, böylece aynı rapor hedeflenir.
- `timezone` için, kategori tıklamasındaki gibi bugünkü `requestTimezone()` kullanılır. Oturumdaki
  `timezone` kullanılmaz, çünkü dönem bugünün yerine göre hesaplanmalı.

---

## 4. Kategori tıklaması (yeni akış)

### 4.1 Sıra

1. Token yoksa giriş modalı açılır (bugünkü gibi).
2. tz-picker koruması ve `tzPickerFlowId++` aynen kalır. Aynı flow id **quote yanıtına da**
   uygulanır: Bayatlamış bir quote yanıtı (kategori değişmiş ya da ekrandan çıkılmışsa) sessizce
   atılır. Quote hiçbir şey harcamadığı için atmak güvenlidir. Bu, `/start` başarı yanıtının
   "atılmaz" kuralıyla çelişmez; o kural yalnızca `/start` için geçerli.
3. Gövde kurulur (§5.3). Dönemli kategoride saat dilimi yoksa picker açılır (bugünkü gibi).
4. **`categoryBlockedByLock`, API'den ÖNCE kesin engel olmaktan çıkar.** Kilit görseli
   (`isCategoryLocked`, `FE:index.html:3586`) kalır, ama tıklama her zaman
   `POST /api/v1/interpret/quote` çağırır. Neden: Abone olmayan bir kullanıcının aynı dönem için
   kayıtlı raporu, abonelik kontrolünden ÖNCE ücretsiz açılır (`BE:interpret.py:653-656`;
   ürün kararı A, `BE:CLAUDE.md` "Kayıtlı Rapor Anahtarı ve Yeniden Kullanım" →
   "/start sırası ve kayıtlı raporun açılması").
5. Quote yanıtı (`BE:interpret.py:646-664`, şema `QuoteResponse`):

| Yanıt | Eylem |
|---|---|
| 200, `would_spend="none"`, `existing` dolu | `GET /{existing.session_id}` ve `GET /{id}/balance` paralel çağrılır, kayıtlı rapor açılır. **Ücret yok, onay yok, `/start` yok.** |
| 200, `"subscription"` ya da `"report_credit"` | Açık onay ekranı (§4.2). Kullanıcı onaylarsa `/start` gönderilir (§5). Abone için onay adımı Açık karar 3'e bağlı. |
| 403 `category_requires_subscription` | Bugünkü kilit mesajı ve "Abone Ol" (`errCategoryLocked`) |
| 403 `category_disabled` | **Yeni** mesaj: "Bu kategori şu anda kullanılamıyor." (`errForbidden` DEĞİL) |
| 409 `generation_in_progress` | §7'deki sınırlı bekleme. Henüz onay verilmediği için kontrol yeniden quote ile yapılır. |
| 422 timezone (`timezone_missing` / `timezone_invalid`) | Mevcut picker akışı (`handleInterpretErrorResponse`). Quote da aynı `InterpretStartRequest` doğrulamasından geçer (`BE:interpret.py:648`, `BE:app/schemas.py:437-456`). Picker sonrası retry **quote'u yeniden yapar**, doğrudan `/start` göndermez. |
| 422 diğer, 404 (chart), 401, 429 | §6 tablosu |

Quote'un sırası şöyle: chart 404, dönem ve tutulma, timing 422'leri, kimlik; ardından
`force_regenerate=false` için canlı completed raporda `none`, canlı pending raporda 409; sonra
sağlık 403, kademe 403 ve 200 (`BE:CLAUDE.md` "Rapor Önizlemesi (quote)" → **Sıra**).

### 4.2 Onay ekranı

- Ne harcanacağı yazılır: "1 rapor hakkı kullanılacak" ya da "Aboneliğin kapsamında (ek ücret
  yok)".
- Kredi bakiyesi `creditBalance.report_credits` değerinden gösterilir. Quote kredi 0 iken de
  `report_credit` döner, 402 vermez (`BE:interpret.py:642-643`, `BE:CLAUDE.md` "402 istisnası").
  Bu yüzden onay ekranı bakiye 0 ise "Rapor hakkın yok" der ve onay yerine "Abone Ol" önerir.
  Bakiye bayatsa `/start` yine `402` dönebilir, bu da §6'da işlenir.
- Quote "rezervasyon ya da fiyat garantisi DEĞİLDİR" (`BE:CLAUDE.md` PR-2b → **İlke**). Onay
  ekranı da fiyatı garanti etmez. Güvence `expected_spend`'tedir (§5.3).
- Kullanıcı onay ekranındayken kategori değişirse ya da ekrandan çıkılırsa `/start` gönderilmez
  (flow id kontrolü).

### 4.3 Abone için onay adımı (Açık karar 3)

- **(A) Her yeni üretimde onay.** Tutarlıdır ve yanlışlıkla yapılan üretimi önler. Ama abone için
  her tıklama bir ek adım olur ve mevcut timezone testlerinin çoğuna bir onay tıklaması eklenmesi
  gerekir.
- **(B) `would_spend="subscription"` ise onay yok.** `/start` doğrudan
  `expected_spend="subscription"` ile gönderilir. Abonelik arada biterse gerçek harcama
  `report_credit` olur. Bu bir artış sayılır ve `409 spend_changed` döner (kredi varsa;
  `BE:interpret.py:534-546`). Kullanıcı o noktada açık onaya düşer, sessiz ücret olmaz.
- **(C)** (B) ile aynı, ama `force_regenerate=true` her durumda onay ister.

**Öneri: (C).** Abonenin normal kategori tıklaması bugünkü kadar akıcı kalır ve `expected_spend`
kapısı korur. Mevcut raporu supersede eden yeniden üretim ise her zaman bilinçli bir eylem olur.
Karar Theo'nun.

---

## 5. `/start` ve `/continue`: istek kimliği ve kalıcılık

### 5.1 `request_id`

- Kullanıcının **onayladığı** her üretim için ve gönderdiği her soru için **bir kez** üretilir:
  `crypto.randomUUID()`, yoksa `crypto.getRandomValues` tabanlı bir UUIDv4. Backend 1–200
  karakter kabul ediyor (`BE:app/schemas.py:395-398`, `:488-491`).
- Aynı onayın ya da sorunun tekrarları **aynı** id'yi kullanır. Yeni onay ya da yeni soru yeni id
  demektir.

### 5.2 sessionStorage kaydı

- Anahtar: `stellafix_pending_interpret:v1:<sub>`. `<sub>` değeri
  `decodeJwtPayload(authToken).sub` ile alınır (`FE:index.html:1109`; payload'ın `sub` içerdiği:
  `BE:app/auth.py:49-50`).
- Değer `{kind: "start"|"continue", request_id, body, approved_spend, created_at}`. Hesap başına,
  sekme başına türü başına **en fazla bir** kayıt tutulur; arayüz istekleri zaten sıralı.
- Kayıt **istek gönderilmeden ÖNCE** yazılır, `fetch`'ten önceki son adımdır. Gövde yazıldıktan
  sonra **değiştirilmez**. Tekrarlar kayıttaki gövdeyi kullanır, gövdeyi yeniden kurmaz. Bu
  önemli: Arada dil (`currentLocale`) ya da saat dilimi (`requestTimezone()`) değişebilir.
  Fingerprint `request_id` ve `expected_spend` dışındaki tüm alanları kapsar
  (`BE:CLAUDE.md` PR-2a → "request_id — sürümlü fingerprint"; `_FINGERPRINT_EXEMPT`). Farklı
  bir gövde `409 request_id_conflict` verir (`BE:interpret.py:145-146`, `:358-359`).
- **Hesaba bağlılık:**
  - Sayfa yüklenince ve her girişte (`confirmMagicLink`, `FE:index.html:1626`) önekle eşleşen
    tüm anahtarlar taranır. `sub`'ı mevcut hesaptan farklı olan kayıtlar **kullanılmaz ve
    silinir.**
  - `sub` okunamazsa (bozuk token; testlerdeki `'test-token'`) kayıt sessionStorage'a yazılmaz,
    yalnızca bellekte tutulur. Bu durumda koruma yalnızca sayfa açıkken geçerlidir.
  - Açık `logout()` (`FE:index.html:1474`) bu sekmedeki tüm kayıtları siler.
  - 401 sonrası `handleUnauthorized` (`:1384`) kayıtları **silmez**. Aynı hesapla yeniden girişte
    istek sürdürülür.
  - Giriş yapan hesap değişirse sohbet alanı da sıfırlanır (`resetInterpretArea`). Bugün
    `confirmMagicLink` bunu yapmıyor; önceki hesabın `interpretSessionId` değeri ekranda kalabilir.
- sessionStorage erişilemezse (try/catch) bellek içi yedeğe düşülür. Kayıt yazılamadı diye istek
  engellenmez, bu bilinen bir sınırlamadır.
- **Kapsam sınırı:** sessionStorage sekmeye özeldir. Yenileme ve aynı sekmede gezinme korunur; yeni
  bir sekmeden ya da tarayıcıyı kapatıp açtıktan sonra korunmaz.

### 5.3 Gövde

- `/start` ve onaylanan quote'ta aynı alanlar kullanılır: `chart_id`, `category`, `language`,
  dönemli kategoride `timezone` ve gönderiliyorsa `period_type` (bugün gönderilmiyor). Bunlara
  şunlar eklenir:
  - `request_id`;
  - `expected_spend`: Onaylanan quote'un `would_spend` değeri. Bu alan fingerprint'e girmez
    (`BE:app/schemas.py:406-413`), bu yüzden aynı id ile değişmesi çakışma yaratmaz. Ama kural
    olarak kayıttaki değer kullanılır.
  - `force_regenerate`: Yalnızca "yeniden üret" eyleminde `true`, diğer durumlarda gönderilmez
    (varsayılan `false`). Bu alan fingerprint'e girer: Aynı id ile farklı bir
    `force_regenerate` değeri `request_id_conflict` verir (`BE:app/schemas.py:399-405`).
- `/continue` gövdesi `{session_id, question, request_id}` (`InterpretContinueRequest`,
  `BE:app/schemas.py:485-491`).
- Quote gövdesinden farklı alan gönderilmez. Quote `request_id` ve `expected_spend` alanlarını
  kabul eder ama yok sayar (`BE:interpret.py:637-638`). Quote'a bu alanlar gönderilmez.

### 5.4 Ne zaman sürdürülür, ne zaman silinir

| Sonuç | Sunucuda kayıt | Kayıt | Eylem |
|---|---|---|---|
| 200 | completed | **sil** | Sonucu göster, `/balance` ve `/credits/balance` tazele |
| Ağ hatası, zaman aşımı, 5xx | belirsiz | **tut** | Aynı id ve aynı gövdeyle sürdür (§7). Sunucu ne durumda olursa olsun güvenli: completed ise replay, pending ise `request_in_progress`, refunded ise `request_failed`, yoksa ilk kez işlenir (`BE:interpret.py:105-117`, `:130-175`). |
| Sayfa yenileme | belirsiz | **tut** | Yüklemede aynı hesabın kaydı bulunursa "Yarım kalan isteğin sürdürülüyor" mesajı gösterilir ve aynı id ile gövde gönderilir. Sonuç geçmiş ekranındaki rapor görünümünde açılır, çünkü yenilemeden sonra harita yok (§2.4). |
| 409 `request_in_progress` | pending | tut | §7 bekleme |
| 409 `generation_in_progress` | yok (bizim id kaydedilmedi; başka bir istek üretiyor) | tut | §7 bekleme. Sonraki tekrar ücretsiz yeniden kullanıma dönebilir (`BE:interpret.py:336-340`). |
| 409 `request_failed` | refunded | **sil** | "Başarısız oldu, hakkın iade edildi." Yeni üretim yalnızca kullanıcının açık eylemiyle yapılır: yeni quote, yeni onay, yeni id. |
| 409 `generation_expired` | refunded (`settle_generation`, `BE:interpret.py:608-609`, `:838-839`) | **sil** | `request_failed` ile aynı |
| 409 `request_id_conflict` | başka bir istek | **sil** | Genel hata. Otomatik tekrar yok. |
| 409 `spend_changed` | yok (tx1 geri alındı, `:540-542`) | **sil** | §6 |
| 409 `report_changed` | yok | **sil** | §6 |
| 402, 403, 404, 422 | yok (tx1 öncesi ya da geri alındı) | **sil** | §6 |
| 401 | işlenmedi | **tut** | Giriş modalı; aynı hesapla girişte sürdür |
| 429 | işlenmedi (`RateLimitExceeded` dependency'de, `BE:app/rate_limit.py:209-226`) | tut | Gecikmeli tekrar (§7) |
| Kullanıcı açıkça vazgeçer | belirsiz | **sil** | "Vazgeç" düğmesi uyarır: "İstek sunucuda işlenmiş olabilir; rapor geçmişte görünebilir." |

### 5.5 Çift ücret koruması: doğru ifade

- `409 generation_in_progress` **yalnızca** aynı rapor anahtarlı bir üretim **hâlâ sürerken**
  korur (`_try_free_reuse`, `BE:interpret.py:336-337`).
- Aşağıdaki durumlarda kimliksiz yeni bir `/start` **yeniden ücretlendirilebilir**:
  - Üretim tamamlandıysa: Bu durumda ücretsiz yeniden kullanım olur. Ama `force_regenerate=true`
    ise reuse atlanır (`:431`) ve yeni üretim ücretlidir.
  - Dönem değiştiyse: Kayan dönemde kimlik farklı olur ve yeni üretim ücretlidir.
  - `force_regenerate=true` ise.
- **`/continue` için rapor anahtarı eşleşmesi yok.** Her yeni soru ayrı bir finansman kararıdır
  (`BE:interpret.py:736-761`). Tekrar koruması yalnızca `request_id` ile sağlanır
  (`_replay_continue`, `:344-379`).
- Bu yüzden ana koruma **sessionStorage kaydıdır.** Kaydı yazmayan ya da tekrarda yeni id üreten
  bir kod, kopan bağlantıdan sonra ikinci kez ücret aldırabilir.

---

## 6. Hata kodları tablosu

Gövde şekli `{"error", "detail", ...}` (`_error`, `BE:interpret.py:79-80`). Kullanıcıya
backend'in `detail` metni gösterilmez, eşleme `error` alanına göre yapılır (bugünkü ilke,
`FE:index.html:1660-1663`).

| Kod | Kaynak | Mesaj (TR, öz) | Eylem |
|---|---|---|---|
| 409 `spend_changed` `{quoted, actual, found_existing}` | `BE:interpret.py:178-183`, `:538-542` | "Bu raporun bedeli değişti: artık 1 rapor hakkı kullanılacak." | Kayıt silinir. **Yeni quote ve YENİ onay** istenir. Otomatik tekrar yok. Onaylanırsa yeni id ve yeni `expected_spend` kullanılır. |
| 409 `report_changed` | `:94-102`, `:466-468`, `:497-499` | "Bu rapor az önce yeniden üretildi." | Kayıt silinir. `force_regenerate=false` ile yeni quote; büyük olasılıkla `none` döner ve güncel rapor açılır. Ücret alınmadı. |
| 409 `generation_in_progress` | `:90-91`; quote `:656`, `:661-662`; start `:337`, `:468`, `:496`, `:500`; continue `:699-700`, `:756-757`, `:793` | "Bu rapor şu anda hazırlanıyor." | §7 bekleme |
| 409 `request_in_progress` | `:107-108` | "İsteğin hâlâ işleniyor." | Kayıt tutulur, §7 bekleme (aynı id ve gövde) |
| 409 `request_failed` | `:109-116` | "İstek tamamlanamadı, hakkın iade edildi." | Kayıt silinir. Yeni üretim yalnızca kullanıcı eylemiyle yapılır. |
| 409 `request_id_conflict` | `:120-121` | Genel hata ("Bir şeyler ters gitti, tekrar dene.") | Kayıt silinir. Otomatik tekrar yok. Bu durum kendi kodumuzda bir hata demektir (gövde değişmiş); geliştirme sırasında console'a yazılır. |
| 409 `generation_expired` | `:83-87` | "Yanıt süre sınırını aştı, hakkın iade edildi." | Kayıt silinir. "Tekrar dene" yeni quote ve onay ister. |
| 409 `report_not_ready` | `:383-384` (yalnızca `/continue`) | "Rapor hâlâ hazırlanıyor." | §7 bekleme. Kontrol için `GET /{session_id}` okunur. |
| 409 `report_failed` | `:385` (yalnızca `/continue`) | "Bu rapor oluşturulamadı; soru sorulamaz." | Kayıt silinir, soru kutusu kapatılır |
| 402 `insufficient_credits` `credit_type=report\|question` | `:543-546`, `:555-558`, `:758-761` | Bugünkü metinler | Kayıt silinir, "Abone Ol" önerilir |
| 403 `category_disabled` | `:274-275`, `:694-695` | **Yeni:** "Bu kategori şu anda kullanılamıyor." Kayıtlı rapordaysa "Rapor okunabilir, yeni soru şu an alınamıyor." eklenir. | Kayıt silinir. Rapor ekranı açık kalır. |
| 403 `category_requires_subscription` | `:276-277`, `:509-514` | Bugünkü `errCategoryLocked` | Kayıt silinir, "Abone Ol" |
| 403 `forbidden` | `:679-682`, `:921-922`, `:958-961` | Bugünkü `errForbidden` | Kayıt silinir, "Kategorilere dön" |
| 404 | chart: `:260-262`; session: `:677-678`, `:919-920`, `:956-957` | Bugünkü `errNotFoundSession`; chart için "Harita bulunamadı, yeniden hesapla." | Kayıt silinir |
| 401 | `BE:app/auth.py:89` (`HTTPException`, `error` alanı yok) | Bugünkü `errAuthRequired` | `handleUnauthorized`; kayıt **tutulur** (§5.2) |
| 429 `rate_limited` | `BE:app/main.py:58-60`; kovalar `BE:app/config.py:361` (dakikada 10, start/continue), `:370` (dakikada 30, okumalar) | Bugünkü `errRateLimited` | Kayıt tutulur. `Retry-After` başlığı yok (`main.py:60`), bu yüzden istemci kendi gecikmesini uygular: start/continue için en az 10 sn. |
| 422 timezone | `BE:app/schemas.py:437-456` | Picker | Bugünkü akış; picker sonrası quote yeniden yapılır |
| 422 diğer | şema ve timing doğrulamaları | Bugünkü `errInvalidInput` | Kayıt silinir |
| 5xx, ağ hatası | — | "Bağlantı sorunu, yeniden deneniyor…" | Kayıt tutulur, §7 |

Savunmacı not: `409 regenerate_unavailable` R0'a özgüydü ve PR-2a ile kalktı
(`BE:CLAUDE.md` "PR-2a, R0'ı SÜPERSEDE ediyor"). Bu kod bir rollback durumunda dönebilir; dönerse
genel 409 mesajı gösterilir ve kayıt silinir.

---

## 7. "Hazırlanıyor" durumları için sınırlı bekleme

**Kapsam:** `generation_in_progress`, `request_in_progress`, `report_not_ready`. Ayrıca
geçmişte `status="pending"` olarak görünen oturum.

### 7.1 Zaman bilgisi ve sınırları

- `GENERATION_ATTEMPT_BUDGET_SECONDS = 150`, `LEASE_SECONDS = 150 + 30 = 180`
  (`BE:app/config.py:318-319`). İkisi de "başlangıç değeri, ölçülmedi". Kira `now + LEASE_SECONDS`
  olarak yazılıyor (`BE:app/generation.py:289`, `:325`).
- Kira **kesin bir tamamlanma süresi değildir.** Bir üretim kiradan önce bitebilir. Kira dolunca
  sonuç kaydedilmez ve iade yapılır (`settle_generation`, `BE:CLAUDE.md` "Üretim Denemesi Yaşam
  Döngüsü" → **Akış** 4).
- Tarayıcının beklemeye başladığı an, sunucudaki kiranın başlangıcı değildir. Kira tarayıcıda
  **bilinemez**; yanıtlarda kira alanı yok. Başkasının (ör. başka bir sekmenin) üretimi kiranın
  herhangi bir noktasında olabilir. Kendi isteğimiz ağda gecikmiş de olabilir. Bu yüzden
  beklemenin üst sınırı kabaca **bütçe + kira ≈ 330 sn** olarak alınır.
- **Reaper yalnızca `/start` ve `/continue` başında çalışır** (`BE:interpret.py:409`, `:673`; uygulamada
  başka bir çağrı yeri yok). Quote ve GET okumaları reaper çalıştırmaz (`BE:interpret.py:634-643`;
  `BE:CLAUDE.md` PR-2b → "Bilinen sınırlama — reaper"). Sonuç: Kirası dolmuş bir pending kayıt,
  biri `/start` ya da `/continue` çağırana kadar **quote'ta 409, GET'te `pending`** görünmeye
  devam edebilir.

### 7.2 Kontrol yöntemi

- **Önceden onaylanmış bir isteğin tekrarıysa** (sessionStorage'da kayıt varsa), aynı
  `request_id` ve aynı gövdeyle `/start` ya da `/continue` yeniden gönderilir. Bu güvenlidir ve
  ilk iş reaper'ı çalıştırır. Kira dolmuşsa yanıt `request_failed` olur ve kayıt silinir.
  - Gecikmeler: 10, 15, 20, 30, 30, … sn. Start/continue kovası dakikada 10, en az 10 sn ara
    bu sınırın altında kalır.
- **Onaylanmış bir istek yoksa** şöyle kontrol edilir:
  - Kategori akışında yeni quote ile (`409` sürüyor mu, `none` mı döndü?).
  - Açık bir pending oturumda `GET /{session_id}` ile (status `completed` oldu mu?).
  - Geçmiş listesinde, yalnızca ekran açıkken, `GET /history` ile.
  - Gecikmeler: 3, 5, 8, 13, 20, 30, … sn (okuma kovası dakikada 30).
- 429 gelirse bir sonraki gecikme ikiye katlanır. Döngü sayfa görünür değilken
  (`document.hidden`) durur ve görünür olunca kaldığı yerden devam eder. Toplam süre duvar saatine
  göre ölçülür.

### 7.3 Süre dolunca

Sonsuz döngü kurulmaz. Kullanıcıya şu seçenekler sunulur:

- **Onaylanmış istek varsa:** "Tekrar dene" aynı id ve gövdeyi gönderir. `/start` önce reaper'ı
  çalıştırır (`:409`), bu yüzden kirası dolmuş bir pending burada çözülür: completed ise sonuç,
  refunded ise `request_failed`. **Quote reaper çalıştırmaz,** bu nedenle bu durumda kontrol quote
  ile yapılmaz.
- **Henüz onay verilmediyse:** "Tekrar kontrol et" yeni bir quote yapar. Quote 200 dönerse **AÇIK
  ONAY** ekranı gösterilir. `expected_spend` olmadan otomatik `/start` gönderilmez.
  - Bilinen sınırlama: Sahipsiz ya da kirası dolmuş bir pending kayıtta quote, başka bir `/start`
    veya `/continue` reaper'ı tetikleyene kadar 409 dönmeye devam edebilir. Bu durumda mesaj
    "Rapor hazırlanırken bir sorun olmuş olabilir; birkaç dakika sonra tekrar dene" olur. Backend
    tarafında olası çözümler (quote'un pending kaydın kirasını salt okuma olarak değerlendirmesi
    gibi) bu planın kapsamında değildir; Açık karar 5'e bakın.
- **İade edilmiş bir istekten sonra** (`request_failed` / `generation_expired`), yeni id ile
  üretim yalnızca bilinçli bir kullanıcı eylemiyle olur: yeni quote ve onay.
- Her durumda bir "Vazgeç" seçeneği de vardır (§5.4 son satır).

Bekleme süresinin değeri Açık karar 4'tür.

---

## 8. Korunacaklar

- **Magic link girişi.** `checkMagicLinkToken` ve `confirmMagicLink` (`FE:index.html:1607`,
  `:1626`) değişmez. Yalnızca hesap değişince kayıt temizliği ve sohbet sıfırlaması eklenir (§5.2).
- **401 akışı.** `handleUnauthorized` aynen kalır. Kayıtlar bu yolda silinmez.
- **Saat dilimi akışı ve yarış korumaları.** `pickTzCity`, `isTzRetryStillValid`,
  `tzPickerRequestId` ve `tzPickerFlowId` (`:3857-3861`, `:4035-4074`) korunur. Flow id quote
  yanıtına ve onay ekranına da uygulanır (§4.1).
- **Başarılı bir `/start` yanıtı asla atılmaz.** Kullanıcı ekrandan çıkmış, kategori değiştirmiş ya
  da geçmiş ekranına geçmiş olsa bile yanıt işlenir: oturum geçmişte görünür, kayıt silinir ve
  gösterge tazelenir. Ekranda başka bir şey açıksa "Raporun hazır" bildirimi gösterilir; o ekrana
  zorla geçilmez.
- **Kredi göstergesinin yenilenmesi.** `/start` başarılı olunca `fetchCreditBalance()` çağrılır.
  Buna ek olarak `/{id}/balance` da okunur, böylece soru göstergesi ilk sorudan önce dolu olur.
  `/continue` başarılı olunca gösterge yanıttan güncellenir (bugünkü gibi).

---

## 9. Testler (Playwright, `page.route` ile mock, gerçek backend yok)

### 9.1 Altyapı

- Yeni dosyalar: `tests/report-history.test.cjs`, `tests/report-quote.test.cjs`,
  `tests/report-wait.test.cjs`. Ortak sunucu ve mock yardımcısı `tests/helpers/` altına konur.
  Helper dosyaları `*.test.cjs` adını taşımaz ki glob onları test olarak çalıştırmasın.
- Hesaba bağlılık testleri için imzasız sahte JWT kullanılır:
  `h.<base64url({sub:'u1', email, subscription_tier, exp})>.s`. Mevcut `'test-token'` olduğu gibi
  kalır; `sub` okunamadığı için kalıcılık devreye girmez (§5.2).
- Bekleme testlerinde Playwright saat API'si kullanılır (`page.clock`; projedeki sürüm 1.56.1).
  Gerçek 330 sn beklenmez.

### 9.2 Senaryolar

1. **Quote dalları**
   - `none`: `/start` çağrılmaz, GET detay ve balance çağrılır.
   - `subscription`: Karar 3'e göre onay ekranı ya da doğrudan `/start`; gövdede
     `expected_spend:"subscription"`.
   - `report_credit`: Onay ekranı; onaylanmadan `/start` gitmez.
   - 403 `category_requires_subscription`: Kilit mesajı.
   - 403 `category_disabled`: `errForbidden` DEĞİL, yeni mesaj.
   - 409: Bekleme.
   - 422 timezone: Picker açılır, picker sonrası quote yeniden yapılır.
2. **Kayıtlı rapor abone olmayana açılır.** `creditBalance.has_active_subscription=false`, haftalık
   kategoriye tıklanır, quote `none` döner. Rapor görünür, `categoryBlockedByLock` tıklamayı
   engellemez. `chatRemaining` metni `/balance` mock değerlerinden gelir (ör.
   `questions_remaining_free:1`, `question_credits_remaining:2` → "Kalan soru hakkın: 3").
3. **Sağlık kapalı.** Geçmişten bir `health` oturumu açılır: GET 200, rapor görünür. Soru
   gönderilince `/continue` 403 `category_disabled` döner. Mesaj yeni metindir ve rapor ekranda
   kalır.
4. **`spend_changed`.** `/start` 409 `spend_changed` döner. İkinci bir `/start` **otomatik
   gönderilmez.** Yeni quote yapılır ve onay ekranı tekrar görünür. Onaylanınca giden ikinci
   `/start` **yeni** bir `request_id` ve `expected_spend:"report_credit"` taşır.
5. **Ağ hatası.** İlk `/start` `route.abort()` ile düşürülür. Tekrar **aynı** `request_id` ve
   **bayt bayt aynı** gövdeyle gider. Aradaki locale değişikliği gövdeyi etkilemez.
6. **Kaydın gönderimden önce yazılması.** Route işleyicisinde, istek ağa düştüğü anda
   `page.evaluate(() => sessionStorage...)` ile kaydın zaten var olduğu ve id'nin eşleştiği
   doğrulanır.
7. **Sayfa yenileme.** İlk `/start` yanıtı geciktirilir, bu sırada `page.reload()` yapılır.
   Yüklemede aynı id ve gövdeyle `/start` gider, sonuç rapor görünümünde açılır ve kayıt silinir.
8. **Hesap değişimi.** `u1` için kayıt varken sahte JWT `u2` ile açılır. `/start` gönderilmez ve
   kayıt silinir.
9. **Bekleme süresi dolar.**
   - Onaylı istekte: `request_in_progress` sürer ve süre dolar. "Tekrar dene" aynı id ile
     `/start` gönderir.
   - Onaysız istekte: quote 409 sürer ve süre dolar. "Tekrar kontrol et" yeni quote yapar, 200
     döner ve onay ekranı gelir. Onay verilmeden `/start` gitmez.
10. **`request_failed` ve `generation_expired`.** Kayıt silinir; yenilemeden sonra tekrar
    gönderilmez.
11. **History sayfalama.** `limit=20`; ikinci sayfada `offset=20` gönderilir. Kısa sayfada düğme
    gizlenir. Çift gelen `session_id` tek satır gösterilir.
12. **`is_live` / `superseded`.**
    - R0 satırında (`false/false`) "eski" ya da "geçersiz" metni ve rozet yoktur.
    - `superseded=true` satırında "Yeniden üretildi" rozeti vardır ve tıklanınca rapor açılır.
    - `status:"pending"` satırı "Hazırlanıyor" gösterir.
13. **Başarılı yanıt atılmaz.** `/start` yanıtı geciktirilir ve kullanıcı geçmiş ekranına geçer.
    Yanıt gelince oturum işlenir ve kayıt silinir.
14. **Mevcut timezone testleri.**
    - PR-0 ve PR-1'de 12 test **aynen** geçer, dosyaya dokunulmaz.
    - **PR-2'de dürüst not:** Quote, `/start`'tan önce geldiği için harness'e (`openPage`) bir
      `/quote` mock'u eklenmesi zorunludur. Varsayılanı `200 subscription` olur. Karar 3=(B/C)
      ise 9 testin gövdesi değişmez. 422 fixture'ı kullanan 3 test (`:172`, `:191`, `:203`)
      fixture'ı `/quote`'a taşır; `calls.start[0].timezone` ve `calls.start.length` iddiaları,
      aynı anlamı taşıyan `calls.quote` iddialarına döner. Yarış testlerindeki "tam bir `/start`"
      iddiaları (`:274-347`) ve "atılmaz" testi (`:349`) değişmeden geçmelidir.
    - Karar 3=(A) seçilirse bu testlere bir onay tıklaması eklenir.

### 9.3 Kritik kural: geri alınınca hangi test kırılır

| Kural (uygulama satırı) | Geri alınınca kırılan test |
|---|---|
| Quote `none` ise `/start` gönderilmez | 1 (`none`): `calls.start.length===0` |
| Kilit API'den önce engel değil | 2: Abone olmayana kayıtlı rapor açılmaz, `calls.quote.length===0` |
| `chatRemaining` `/balance`'tan dolar | 2: Metin boş kalır |
| `category_disabled` için ayrı mesaj | 1 (403 disabled) ve 3: Metin `errForbidden` olur |
| `expected_spend = would_spend` | 1 (`subscription`/`report_credit`): Gövde iddiası |
| `spend_changed`'de otomatik tekrar yok ve yeni onay gerekir | 4: `calls.start.length` 2 olur ya da id aynı kalır |
| Kayıt gönderimden önce yazılır | 6: Route anında kayıt yok |
| Tekrarda aynı id ve aynı gövde | 5 ve 7: id ya da gövde farkı |
| Hesap değişince kayıt kullanılmaz | 8: `u2` altında `/start` gider |
| `request_failed` / `generation_expired` kaydı siler | 10: Yenilemeden sonra `/start` gider |
| Bekleme sınırlı | 9: Süre dolduktan sonra istek sayısı artmaya devam eder |
| Onaysız durumda yeni quote ve onay | 9 (onaysız): Onaysız `/start` gider |
| Quote yanıtına flow id koruması | Yeni yarış testi: Kategori değişince eski quote'un onay ekranı açılır |
| `/start` başarısı atılmaz | 13 ve mevcut `:349` |
| R0 satırına "eski" etiketi yok | 12 |
| History'de `offset` ve tekilleştirme | 11 |
| tz yarış korumaları | Mevcut `:274-347` |

Her PR açıklamasında bu tablonun o PR'a düşen satırları için "geri al → kırıldı" kanıtı verilir:
satır geri alınır, test çalıştırılır, kırılma çıktısı eklenir, satır geri getirilir.

---

## 10. Önce CI (PR-0)

Özellik PR'larından önce **ilk PR** şu işleri yapar:

- `package-lock.json` oluşturulur (`npm install --package-lock-only`; `playwright` zaten
  `1.56.1`'e sabit).
- `.github/workflows/test.yml` eklenir:
  - Tetikleyiciler: `pull_request` ve `push: main`.
  - `permissions: contents: read`.
  - Adımlar: `actions/checkout`, `actions/setup-node` (sabit bir LTS, ör. 22, `cache: npm`),
    `npm ci`, `npx playwright install --with-deps chromium`, `npm test`.
- `package.json` içindeki `"test"` komutu `node --test tests/*.test.cjs` olur. Glob'u npm'in
  çalıştırdığı `sh` açar, bu yüzden Node sürümünden bağımsızdır. Helper dosyaları bu kalıba
  uymaz (§9.1).
- **Mevcut timezone testinin CI'da geçtiği gösterilir.** PR açıklamasına çalışan ve yeşil olan
  workflow run'ının bağlantısı ve 12 testin "pass" özeti eklenir.
- Mümkünse `main` için "test zorunlu" branch koruması önerilir. Bu ayarı repo sahibi yapar.

---

## 11. Parçalara bölme ve sıra

| # | PR | İçerik | Bağımlılık |
|---|---|---|---|
| 0 | CI | §10 | — |
| B | (backend, yalnızca Karar 1=a ise) | `InterpretSessionSummary`'ye `chart_id` ve sahiplik kontrollü `chart_name` eklenir; testler eklenir | Backend kendi sürecinde. **PR-1'den önce** merge ve deploy edilmeli, çünkü PR-1 listede kişiyi gösterir. Karar 1=b ise B yok. |
| 1 | Raporlarım | Hesap menüsünde giriş; `GET /history` ve sayfalama; `GET /{id}` ile `/{id}/balance`; `is_live`/`superseded`/`pending` gösterimi; okuma ekranından soru (mevcut `/continue`, henüz `request_id` yok); `category_disabled` mesajı; `/start` sonrası `/balance` okuması | 0 (ve Karar 1=a ise B) |
| 2 | Quote, onay ve kalıcılık | §4 (quote önce, kilit sonra); onay ekranı; `request_id`; `expected_spend`; sessionStorage kaydı ve hesap bağlılığı (§5); yenilemede sürdürme (sonuç PR-1'in rapor görünümünde açılır); `/continue`'ya `request_id`; §6'nın silme ve tutma kuralları; timezone test harness'ine `/quote` (§9.2-14). İn-progress 409'larda geçici olarak elle "tekrar dene" (aynı id). | 1 |
| 3 | Bekleme ve hata tablosu | §7'nin sınırlı otomatik beklemesi; §6'nın tüm mesajları ve eylemleri; `page.clock` testleri | 2 |
| 4 | Yeniden üret | Karar 2'ye göre düğme; dönemsizde `force_regenerate=true` ve her zaman onay; dönemlide bugünkü dönem metni; geçmişten başlatma (yalnızca Karar 1=a) | 3 (ve Karar 1=a ise B) |

**Canlıya çıkış sırası:** 0 → (B) → 1 → 2 → 3 → 4.

- Her frontend PR'ı tek başına güvenli olmalı. PR-1 yalnızca okuma ekler. PR-2'den sonra çift
  ücret koruması devrededir; PR-3 öncesindeki ara durumda bekleme elle yapılır.
- **Ön koşul [doğrulanmadı]:** Canlı backend'in (`api.stellafix.io`) `7d6c675`'i ya da PR-2b
  içeren bir sürümü çalıştırdığı bu planda doğrulanmadı. PR-1 öncesinde canlı bir
  `GET /history` yanıtında `is_live` alanının varlığı, PR-2 öncesinde de `POST /quote`'un 200
  döndüğü elle kontrol edilmeli.
- **[doğrulanmadı]** Statik sitenin main'e merge olunca otomatik yayınlandığı (CNAME var, GitHub
  Pages olduğu varsayılıyor) bu planda doğrulanmadı.

---

## 12. Açık kararlar

1. **Kişi bilgisi.**
   - (a) Backend summary'ye `chart_id` ve sahiplik kontrollü `chart_name` eklenir (PR-B).
   - (b) Kişisiz liste.
   - **Öneri: (a).** (b), geçmişten yeniden üretimi imkânsız kılar.
2. **Yeniden üretimin hedef dönemi.**
   - (i) Bugünkü dönem; metinle açıkça söylenir.
   - (ii) Eski dönem; backend değişikliği gerekir.
   - **Öneri: (i).**
3. **Abone için onay adımı.**
   - (A) Her yeni üretimde onay.
   - (B) Abonelikte onay yok.
   - (C) (B), ama `force_regenerate` her zaman onaylı.
   - **Öneri: (C).**
4. **Bekleme süresinin değeri.**
   - (i) 180 sn (= kira). Kendi yeni isteğimiz için çoğu zaman yeter, ama başkasının üretimi ya da
     ağ gecikmesi için kısa kalabilir.
   - (ii) 330 sn (bütçe + kira). Kabaca üst sınırdır.
   - (iii) 60 sn ve ardından "beklemeye devam et?" sorusu.
   - **Öneri: (ii)**, 60. saniyede "Bu biraz uzun sürebilir" bilgisi ve her an "Vazgeç" seçeneğiyle.
     Frontend'de `config.py:318-319`'a atıf yapan tek bir sabit tutulur. Backend değerleri
     "ölçülmedi"; ölçüm gelince birlikte güncellenir.
5. **Quote ve reaper sınırlaması (backend, isteğe bağlı).** Kirası dolmuş bir pending kayıtta
   quote 409 vermeye devam edebilir (§7.3).
   - (a) Belgelenmiş sınırlama olarak kabul edilir.
   - (b) Backend'de quote ya da GET, pending kaydın kira durumunu salt okuma olarak değerlendirir;
     ayrı bir backend PR'ı gerekir.
   - **Öneri: önce (a),** sonra canlı kullanımda sıklığı ölçülür.
6. **Çıkışta kayıtların silinmesi.** Açık `logout()` tüm kayıtları siler. 401 kayıtları silmez.
   - **Öneri: bu şekilde.** Alternatif: Çıkışta da tut ve girişte `sub` karşılaştırmasına bırak.
     Bu alternatif paylaşılan cihazda soru metnini sekme kapanana kadar tutar.

---

## Ek: Kaynak gösterilen backend satırları (`stellafix-backend@7d6c675`)

- `app/routers/interpret.py`:
  - 35 (prefix)
  - 51-61 (`_report_balance_fields`)
  - 79-80 (`_error`)
  - 83-121 (409 yardımcıları)
  - 130-175 (`_replay_start`)
  - 178-197 (`spend_changed`, `_SPEND_RANK`)
  - 226-243, 255-267 (kimlik; chart sahiplik kontrolü yok)
  - 270-278 (sağlık ve kademe kapısı)
  - 322-341 (`_try_free_reuse`)
  - 344-379 (`_replay_continue`)
  - 382-385 (`report_not_ready` / `report_failed`)
  - 401-610 (`/start`; reaper 409, replay 415-418, reuse 431-434, force 464-468, kademe 509-514,
    `expected_spend` 534-546, 402 555-558, `generation_expired` 608-609)
  - 634-664 (`/quote`; reaper yok)
  - 667-841 (`/continue`; reaper 673, 403 679-682, replay 686-689, sağlık 694-695, aktif deneme
    699-700, durum 704-705, finansman 736-761, `generation_expired` 838-839)
  - 848-878 (`is_live` / `superseded`, summary)
  - 881-883 (okumalar kapısız)
  - 886-907 (`/history`)
  - 910-937 (`/{session_id}`)
  - 940-962 (`/{session_id}/balance`)
- `app/schemas.py`:
  - 346-456 (`InterpretStartRequest`: `period_type` 379-387, `timezone` 388-394, `request_id`
    395-398, `force_regenerate` 399-405, `expected_spend` 406-413, doğrulayıcılar 419-456)
  - 458 (`InterpretStartResponse.reused`)
  - 468, 476-482 (`QuoteExistingOut`, `QuoteResponse`)
  - 485-491 (`InterpretContinueRequest`)
  - 494-519 (`ReportBalanceOut`, `InterpretContinueResponse`)
  - 522-549 (`InterpretSessionSummary`)
  - 552, 558, 564 (`InterpretHistoryResponse`, `InterpretMessageOut`, `InterpretSessionDetail`)
- `app/config.py`:
  - 318-319 (`GENERATION_ATTEMPT_BUDGET_SECONDS`, `LEASE_SECONDS`)
  - 340-352 (`CATEGORY_TIER`)
  - 361, 370 (hız kovaları)
  - 415 (`HEALTH_CATEGORY_ENABLED`)
- `app/models.py`:
  - 110 (`NatalChart.name`)
  - 125 (`NatalChart.user_id`)
  - 135 (`ConversationSession.chart_id`)
- `app/generation.py`:
  - 289, 325 (kira yazımı)
  - 507 (`reap_expired_attempts`)
  - 547-558 (`has_active_continue_attempt`)
  - 701-712 (`find_live_report_key`)
- `app/interpretation.py:1277-1295` (dönem istek anından hesaplanıyor)
- `app/routers/natal.py`:
  - 79 (tek route)
  - 147 (`name=payload.name`)
- `app/auth.py`:
  - 49-50 (JWT `sub`)
  - 89 (401)
- `app/rate_limit.py`:
  - 209-240 (kullanıcı kovaları)
- `app/main.py`:
  - 58-60 (429 gövdesi, `Retry-After` yok)
- `app/routers/credits.py`:
  - 15 (bakiye kovası)
- `CLAUDE.md` bölümleri:
  - "Üretim Denemesi Yaşam Döngüsü" (4590–)
  - "Kayıtlı Rapor Anahtarı ve Yeniden Kullanım" (5014–)
  - "Rapor Önizlemesi (quote) ve Canlılık Alanları" (5312–5364)
- `docs/REVIEW_CONTEXT.md`:
  - A6
  - A11
  - B (sağlık, karar A, quote)
  - C1
