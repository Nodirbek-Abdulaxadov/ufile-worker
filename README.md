# UFile — Universal File Worker (reader / editor)

PDF, Word, Excel va PowerPoint fayllarini brauzerda **ko'rish** va **tahrirlash** uchun web-ilova.
Alohida sahifa sifatida ham, boshqa sayt ichida `<iframe>` sifatida ham ishlaydi.

Fayllar foydalanuvchining brauzerida (WebAssembly) ochiladi va tahrirlanadi. Siz `saveUrl`
bermaguningizcha hech narsa serverga yuborilmaydi.

| Tur | Kengaytmalar | Dvigatel (`engines/`) | Yuklanish hajmi (brotli) |
|---|---|---|---|
| PDF | `.pdf` | PdfCraft | ~9 MB |
| Word | `.docx` `.docm` `.dotx` `.doc` `.odt` `.rtf` `.txt` `.md` `.html` | WordCraft | ~8,8 MB |
| Excel | `.xlsx` `.xlsm` `.xls` `.xlsb` `.ods` `.csv` `.tsv` | GridCraft | ~4,6 MB |
| PowerPoint | `.pptx` `.potx` `.ppsx` | DeckCraft | ~5,7 MB |

Dvigatel birinchi ochilganda yuklab olinadi. Keyin brauzer keshidan bir zumda ochiladi.

## Qanday ishlaydi

```
 Sizning saytingiz                 UFile (index.html, worker.js)           Dvigatel (engines/<tur>/)
 ┌──────────────────┐  ufile:*     ┌───────────────────────────┐ <prefix>:* ┌──────────────────────┐
 │ UFile.mount()    │◀────────────▶│ fayl turini aniqlaydi,    │◀──────────▶│ PdfCraft / WordCraft │
 │ yoki <iframe>    │ postMessage  │ dvigatelni yuklaydi,      │ postMessage│ GridCraft / DeckCraft│
 └──────────────────┘              │ saqlashni boshqaradi      │(bir origin)│ (Rust → WASM, egui)  │
                                   └───────────────────────────┘            └──────────────────────┘
```

- **UFile sahifasi** (`public/index.html`) fayl turini nomi yoki ichidagi baytlari bo'yicha aniqlaydi.
  Keyin kerakli dvigatelni o'z ichidagi iframe'da (`engines/<tur>/`) ochadi va faylni unga beradi.
  Dvigatel saqlagan faylni oladi va `saveUrl`'ga, saytingizga yoki foydalanuvchining kompyuteriga
  yo'naltiradi.
- **Dvigatellar** — to'rtta ochiq loyihaning Rust manba kodi, `engines/` papkasida (pastda: *Manbalar*).
  Brauzer uchun yig'ilgan versiyalari `public/engines/` ga joylanadi. Ularga iframe ko'prigi va
  "faqat o'qish" rejimi qo'shilgan (`engines/README.md`).

## Tez boshlash

```sh
# 1) Dvigatellarni yig'ish (bir marta; Rust 1.95+ kerak, ~10 daqiqa)
rustup target add wasm32-unknown-unknown
cargo install trunk --locked
scripts/build-engines.sh                 # yoki faqat kerakligini: scripts/build-engines.sh word excel

# 2) Serverni ishga tushirish (Node 18+, qo'shimcha paketsiz)
node server/server.mjs                   # http://127.0.0.1:8080/
```

- `http://127.0.0.1:8080/` — alohida sahifa: faylni tashlang yoki tanlang, havola orqali oching,
  yangi hujjat, jadval yoki taqdimot yarating.
- `http://127.0.0.1:8080/demo.html` — boshqa saytga joylash namunasi (SDK, server fayllari, hodisalar jurnali).

## Rejimlar: ko'rish va tahrirlash

| Rejim | Nima bo'ladi |
|---|---|
| `view` — **Ko'rish** | Faqat o'qish. Hujjatni o'zgartiradigan har bir buyruq **dvigatelning o'zida** rad etiladi: yozish, formatlash, o'chirish, undo/redo, sichqoncha bilan sudrash. Bu shunchaki yashirilgan tugmalar emas. Word oddiy sahifalar ko'rinishida ochiladi, chizg'ichlar yashiriladi. PDF *Read* rejimida ochiladi. Word, Excel va PowerPoint lentasi (ribbon) yig'iladi, faqat tablar qoladi. Varaqlash, belgilash, nusxalash, qidirish va zoom ishlaydi. |
| `edit` — **Tahrirlash** | To'liq muharrir: lenta, formatlash, jadvallar, formulalar, slaydlar, PDF izohlari… |

Rejimlar orasida almashish bir zumda bo'ladi: dvigatel qayta yuklanmaydi va saqlanmagan o'zgarishlar
yo'qolmaydi.

**Zoom:** Ctrl + / Ctrl − (Mac'da ⌘), yoki Ctrl + sichqoncha g'ildiragi. Excel'da Ctrl −
kataklarni o'chirish oynasini ochmaydi, zoom qiladi. Kataklarni qo'shish va o'chirish lentada va
o'ng tugma menyusida qoladi.

> "Ko'rish" rejimi — interfeys cheklovi, DRM emas. Fayl baribir foydalanuvchining brauzeriga
> keladi. Foydalanuvchi faylni umuman olmasligi kerak bo'lsa, uni bu ilovaga bermang.

## Saytga joylash

### 1. Oddiy iframe (URL parametrlari bilan)

```html
<iframe
  src="https://docs.example.com/?url=https%3A%2F%2Ffiles.example.com%2Fhisobot.pdf&mode=view"
  style="width: 100%; height: 80vh; border: 0"
  allow="clipboard-read; clipboard-write; fullscreen"
  allowfullscreen></iframe>
```

| Parametr | Ma'nosi |
|---|---|
| `url` | Ochiladigan fayl havolasi. Boshqa domendagi fayl CORS'ga ruxsat berishi kerak (cookie yuborilmaydi, imzolangan havola bering). |
| `name` | Fayl nomi, agar havoladan bilinmasa (`download?id=5` kabi). |
| `type` | Dvigatelni majburlash: `pdf`, `word`, `excel`, `slides`. |
| `mode` | `view` yoki `edit` (standart: `config.json` → `defaultMode`). |
| `allowEdit=0` | Faqat ko'rish: tahrirlashga o'tib bo'lmaydi. |
| `saveUrl`, `saveMethod` | Saqlangan fayl shu manzilga `PUT` (yoki `POST`) qilinadi. Faqat `allowedSaveOrigins` ruxsat bergan manzillarga. |
| `new` | Yangi hujjat: `word`, `excel`, `slides`. |
| `lang` | `uz`, `ru`, `en`. |
| `author` | Izohlar va o'zgarishlar muallifi. |
| `toolbar=0` | UFile'ning yuqori panelini yashirish (saytingizda o'zingizning tugmalaringiz bo'lsa). |
| `webgl` | Dvigatellarni WebGL2 bilan chizishga majburlash (`gpu=webgpu` — teskarisi). |

### 2. JavaScript SDK

```html
<script src="https://docs.example.com/sdk/ufile.js"></script>
<div id="doc" style="height: 80vh"></div>
<script>
  const editor = UFile.mount('#doc', {
    url: 'https://files.example.com/hisobot.docx',   // yoki file: File | Blob | ArrayBuffer
    mode: 'edit',
    lang: 'uz',
    author: 'Aziz Karimov',
    // Fayl baytlari bilan ochilganda saqlangan fayl shu yerga keladi:
    onSave: async (file) => {
      await fetch('/api/documents/42', { method: 'PUT', body: file.blob });
    },
    onDirty: (dirty) => console.log('saqlanmagan:', dirty),
  });
</script>
```

**Parametrlar:** `server` (UFile manzili; standart — `ufile.js` turgan joy), `file`, `url`, `name`,
`engine`, `new`, `mode`, `allowEdit`, `lang`, `author`, `toolbar`, `saveUrl`, `saveMethod`,
`saveHeaders` (masalan `{ Authorization: 'Bearer …' }`), `height`, `title`, `className`,
`guardUnload` (standart `true`: saqlanmagan o'zgarish bo'lsa sahifadan chiqishda so'raydi).

**Metodlar:** `editor.open({...})` — boshqa fayl ochish, `setMode('view' | 'edit')`, `save()`,
`download()`, `close()`, `destroy()`, `on(nom, fn)`.

**Hodisalar** (`onNom` parametri yoki `editor.on('nom', fn)`):

| Hodisa | Ma'lumot |
|---|---|
| `ready` | `{ version }` — UFile tayyor |
| `opened` | `{ name, engine, mode, ok, error? }` — hujjat ochildi |
| `dirty` | `true` / `false` — saqlanmagan o'zgarishlar bor/yo'q |
| `save` *(onSave)* | `{ name, mime, size, bytes, blob }`. Promise qaytarsangiz, UFile u tugashini kutadi; xato bersangiz, foydalanuvchiga "saqlab bo'lmadi" deb ko'rsatadi. |
| `saved` | `{ name, size, to }` — `to`: `url` (saveUrl), `host` (onSave) yoki `download` |
| `export` | `{ name, size }` — eksport (PDF, rasm…) foydalanuvchiga yuklab berildi |
| `modeChange` | `'view'` / `'edit'` |
| `error` | `{ code, message, detail? }` |
| `close` | hujjat yopildi |

### 3. postMessage API (SDK'siz)

Iframe `src`'iga `embed=1` qo'shing: UFile fayl kelishini kutadi. U tayyor bo'lganda `ufile:ready`
yuboradi.

Saytdan UFile'ga:

| Xabar | Maydonlar |
|---|---|
| `ufile:open` | `name`, `bytes` (ArrayBuffer / Uint8Array / Blob) **yoki** `url` **yoki** `new`, va ixtiyoriy `mode`, `allowEdit`, `engine`, `lang`, `author`, `saveUrl`, `saveMethod`, `saveHeaders`, `ackSaves` |
| `ufile:setMode` | `mode` |
| `ufile:save` | — (Saqlash tugmasini bosgandek) |
| `ufile:download` | — |
| `ufile:close` | — |
| `ufile:saveResult` | `saveId`, `ok`, `error?` — `ackSaves: true` bo'lsa, `ufile:save`'ga javob |

UFile'dan saytga: `ufile:ready`, `ufile:loading`, `ufile:opened`, `ufile:dirty`,
`ufile:save` (`saveId`, `name`, `mime`, `size`, `bytes`), `ufile:saved`, `ufile:export`,
`ufile:modeChanged`, `ufile:error`, `ufile:closed`.

## Saqlash qayerga ketadi

Foydalanuvchi **Saqlash**ni (yoki hujjat ichida Ctrl+S'ni) bosganda dvigatel faylni UFile'ga beradi.
UFile uni shu tartibda yo'naltiradi:

1. `saveUrl` berilgan bo'lsa — o'sha manzilga `PUT`/`POST`. So'rovda `Content-Type` va
   `X-UFile-Name` sarlavhalari bo'ladi.
2. Aks holda, fayl sahifadan baytlar bilan kelgan bo'lsa (`file` / `bytes`) — sahifaga qaytadi
   (`ufile:save`, SDK'da `onSave`).
3. Aks holda — foydalanuvchining kompyuteriga yuklab beriladi.

Hujjatni **saqlash** bilan **eksport** farqlanadi:
- Nomi bir xil bo'lib, kengaytmasi o'zi yoki dvigatelning asosiy formati bo'lsa — bu saqlash.
  Masalan `.csv` → `.xlsx` va `.doc` → `.docx` ham saqlash hisoblanadi.
- Boshqa har qanday fayl (masalan jadvalning PDF'i yoki slayd rasmi) — eksport. U doim
  foydalanuvchiga yuklab beriladi.

Excel hujjatlari doim `.xlsx` sifatida saqlanadi. PowerPoint fayllari qaysi formatda ochilgan
bo'lsa (`.pptx`), o'sha formatda qaytadi.

## Server

`server/server.mjs` — qo'shimcha paketsiz Node server. U `public/`'ni to'g'ri sarlavhalar bilan
beradi va ixtiyoriy fayl omborini (`/api/files`) taqdim etadi:
- `.wasm` uchun `application/wasm`;
- tayyor `.br`/`.gz` nusxalar;
- hash'li fayllar uchun `immutable` kesh;
- `frame-ancestors` CSP.

| Parametr | Muhit o'zgaruvchisi | Standart |
|---|---|---|
| `--host` | `UFILE_HOST` | `127.0.0.1` |
| `--port` | `UFILE_PORT` | `8080` |
| `--root` | `UFILE_ROOT` | `public/` |
| `--storage DIR` / `--no-storage` | `UFILE_STORAGE` (`off`) | `storage/` |
| `--max-upload-mb` | `UFILE_MAX_UPLOAD_MB` | `300` |
| `--frame-ancestors "https://a.uz https://b.uz"` | `UFILE_FRAME_ANCESTORS` | `*` |
| `--cors "https://a.uz"` | `UFILE_CORS` | — (faqat o'z sahifalari) |

Fayl ombori API'si: `GET /api/files`, `GET|PUT|POST|DELETE /api/files/<nom>`, `GET /healthz`.
Bu namunaviy ombor: autentifikatsiyasi yo'q. Haqiqiy tizimda `saveUrl`'ni o'z backend'ingizga
yo'naltiring yoki `--no-storage` bilan o'chiring.

## Xavfsizlik sozlamalari (`public/config.json`)

```json
{
  "allowedParentOrigins": ["*"],
  "allowedFileOrigins": ["*"],
  "allowedSaveOrigins": ["self"],
  "defaultMode": "edit",
  "defaultLanguage": "uz",
  "allowEdit": true,
  "author": "",
  "maxFileMB": 300
}
```

`author` — sayt `author` bermaganda izohlar va o'zgarishlar shu nom bilan imzolanadi. Bo'sh bo'lsa,
interfeys tilida "Foydalanuvchi" / "Пользователь" / "User" ishlatiladi.

Qiymatlar: `"*"` (hamma), `"self"` (UFile'ning o'z domeni), `"https://intranet.example.uz"`
yoki `"https://*.example.uz"`.

- **`allowedParentOrigins`** — qaysi saytlar UFile'ni joylashtirib, uni `ufile:*` xabarlari bilan
  boshqara oladi.
- **`allowedFileOrigins`** — `url` orqali qaysi manzillardan fayl ochish mumkin.
- **`allowedSaveOrigins`** — havola parametri (`?saveUrl=`) yoki `"*"` orqali ruxsat olgan sayt
  saqlashni qaysi manzillarga yo'naltira oladi. Ro'yxatda **aniq nomi bilan** turgan sayt
  saqlashni istalgan joyga yo'naltira oladi.

Himoya qoidalari:
- Fayl baytlari faqat ikki holda sahifaga qaytadi: faylni o'sha sahifa o'zi bergan bo'lsa, yoki
  sahifa `allowedParentOrigins`'da aniq nomi bilan ko'rsatilgan bo'lsa (`"*"` bilan emas).
  Shunday qilib begona sayt UFile'ni o'z sahifasiga qo'yib, sizning serveringizdagi faylni
  o'g'irlay olmaydi.
- `url` bilan boshqa domendan fayl olinganda cookie yuborilmaydi.

**Production uchun:**
- `allowedParentOrigins`'ga faqat o'z saytlaringizni yozing.
- Serverni `--frame-ancestors` bilan ishga tushiring.
- HTTPS ishlating: WebGPU va clipboard faqat xavfsiz kontekstda ishlaydi.

## Joylashtirish

**Docker** (dvigatellar oldindan yig'ilgan bo'lishi kerak):

```sh
scripts/build-engines.sh
docker build -t ufile-worker .
docker run -p 8080:8080 -v ufile-files:/data \
  -e UFILE_FRAME_ANCESTORS="https://intranet.example.uz" ufile-worker
```

**nginx** (statik, Node'siz): namunasi `deploy/nginx.conf`'da. `public/` papkasini istalgan statik
hostingga qo'yish mumkin. Faqat `.wasm` uchun `application/wasm` MIME turini va `frame-ancestors`
sarlavhasini sozlang.

## Dvigatellar manbasi (`engines/`)

To'rtta dvigatelning to'liq manba kodi shu loyihaning ichida, `engines/<nom>/` papkalarida:
`pdfcraft`, `wordcraft`, `gridcraft`, `deckcraft`, hamda ular ishlatadigan `craft-libs`.
Tashqi papkaga ham, GitHub'ga ham bog'liqlik yo'q: build uchun tarmoqdan faqat crates.io paketlari
yuklanadi. `scripts/build-engines.sh` dvigatellarni shu yerdan yig'adi.

Dvigatellar faqat UFile'ga keraklicha qoldirilgan:
- desktop ilovalar, CLI, CI va paketlash olib tashlangan;
- asl loyihaning brendi, Discord tugmalari va havolalari ham olib tashlangan.

Kodni to'g'ridan-to'g'ri `engines/` ichida o'zgartirasiz, keyin qayta yig'asiz:
`scripts/build-engines.sh word`. Qaysi asl commit'dan olingani, UFile uchun nima o'zgargani va
asl loyihaning yangi versiyasiga qanday o'tish — `engines/README.md`'da.

| Loyiha | O'zgarish |
|---|---|
| hammasi (`crates/engine`) | **Faqat o'qish** sessiyasi: `Session::read_only` (PdfCraft'da `Session::set_view_only`). Hujjatni o'zgartiradigan har bir buyruq va undo/redo rad etiladi. DeckCraft'da sichqoncha bilan sudrash ham bloklanadi. Har biri testlar bilan, va testlar himoyasiz holatda yiqilishi tekshirilgan. |
| hammasi (`apps/*-web`) | `?mode=view` parametri va iframe ko'prigi xabarlari: `<prefix>:mode` — rejimni joyida almashtirish, `<prefix>:opened` — hujjat ochildi, `ready` ichida `modes`. |
| GridCraft (`crates/ui-egui`) | Ko'rish rejimida katak muharriri ochilmaydi (`begin_edit`), shu bilan rad etiladigan tahrir xato oynasini ham chiqarmaydi. Test: `tests/view_only.rs`. Ctrl + / Ctrl − zoom qiladi (`keymap.rs`), ko'rish rejimida ham. Test: `tests/keyboard_shortcuts.rs`. |
| WordCraft, DeckCraft (`apps/*-web/src/host.rs`) | Yangi iframe ko'prigi (`?host=parent`): `ready`, `open`, `opened`, `save`, `dirty`, `failed`, `mode`. PdfCraft va GridCraft'da bu ko'prik avvaldan bor edi. DeckCraft o'z formatida saqlaganini UFile `.pptx`'ga qaytarib aylantiradi. |

Testlar: `npm run test:engines` (Rust kerak).

## Cheklovlar

- Dvigatellar **alfa** bosqichida (har birining README'siga qarang). Murakkab hujjatlarda Office'dan
  farqlar bo'lishi mumkin.
- Eski ikkilik `.ppt` qo'llab-quvvatlanmaydi. `.doc` va `.xls` faqat ochiladi va `.docx` / `.xlsx`
  sifatida saqlanadi.
- Dvigatellar — kompyuter uchun to'liq muharrirlar. Telefonda ishlaydi, lekin og'ir; sensorli
  boshqaruv cheklangan.
- Brauzer WebGPU yoki WebGL2'ni qo'llashi kerak: Chrome / Edge, Firefox, Safari 17+.
  Videokartasiz muhitda (virtual mashina, RDP) UFile o'zi WebGL2'ni tanlaydi.
- Hujjat ichidagi shriftlar brauzerda yo'q bo'lsa, o'xshash shrift bilan ko'rsatiladi.

## Fayllar

```
ufile-worker/
├── public/                 sayt (statik)
│   ├── index.html          UFile sahifasi (alohida sahifa / iframe)
│   ├── demo.html           integratsiya namunasi
│   ├── config.json         xavfsizlik va standart sozlamalar
│   ├── assets/             worker.js, engines.js, i18n.js, worker.css, icon.svg, templates/
│   ├── sdk/ufile.js        saytlar uchun SDK
│   └── engines/            yig'ilgan dvigatellar (scripts/build-engines.sh)
├── engines/                dvigatellar manbasi (Rust): pdfcraft, wordcraft, gridcraft, deckcraft, craft-libs
├── server/server.mjs       Node server + /api/files
├── scripts/                build-engines.sh, precompress.mjs
├── deploy/nginx.conf       nginx namunasi
└── Dockerfile
```

## Manbalar

Dvigatellar [ArtCraft](https://getartcraft.com) jamoasining ochiq loyihalariga asoslangan:

- PDF — [PdfCraft](https://github.com/storytold/pdfcraft)
- Word — [WordCraft](https://github.com/storytold/wordcraft)
- Excel — [GridCraft](https://github.com/storytold/gridcraft)
- PowerPoint — [DeckCraft](https://github.com/storytold/deckcraft)
- umumiy kutubxonalar — [craft-libs](https://github.com/storytold/craft-libs)

Qaysi commit'dan olingani va UFile uchun nima o'zgargani — `engines/README.md`'da.

## Litsenziya

UFile — [MIT](LICENSE).

Dvigatellar (`engines/`) MIT / Apache-2.0 litsenziyasi ostida. Har birining `LICENSE-MIT`, `LICENSE-APACHE`,
`NOTICE` va `ATTRIBUTION.md` fayllari `engines/<nom>/` ichida saqlangan. `scripts/build-engines.sh`
ularni yig'ilgan dvigatel yoniga ham ko'chiradi (`public/engines/<id>/`).
