# Dvigatellar

UFile ishlatadigan to'rtta hujjat dvigatelining Rust manba kodi. `scripts/build-engines.sh` ularni
brauzer uchun (WASM) yig'adi va `public/engines/<id>/` ga joylaydi.

| Papka | Tur | Asl loyiha | Olingan commit |
|---|---|---|---|
| `pdfcraft/` | PDF (`pdf`) | [PdfCraft](https://github.com/storytold/pdfcraft) | `7437bde` (2026-10-13) |
| `wordcraft/` | Word (`word`) | [WordCraft](https://github.com/storytold/wordcraft) | `159b84f` (2026-10-12) |
| `gridcraft/` | Excel (`excel`) | [GridCraft](https://github.com/storytold/gridcraft) | `84acf62` (2026-10-13) |
| `deckcraft/` | PowerPoint (`slides`) | [DeckCraft](https://github.com/storytold/deckcraft) | `d5e3055` (2026-10-13) |
| `craft-libs/<rev>/` | umumiy UI va chop etish kutubxonalari | [craft-libs](https://github.com/storytold/craft-libs) | `5c874d5`, `d27646a`, `d991bf6` |

Hammasi ArtCraft jamoasining ochiq loyihalari (MIT yoki Apache-2.0). Har bir papkada `LICENSE-MIT`,
`LICENSE-APACHE` va `NOTICE` bor. Ular kod bilan birga qolishi kerak, `build-engines.sh` ularni
yig'ilgan dvigatel yoniga ham ko'chiradi.

## UFile uchun nima o'zgargan

**Olib tashlangan** (UFile'ga kerak emas):
- ArtCraft brendi va jamoa havolalari:
  - logotiplar (`docs/brand`);
  - Discord tugmalari va "ArtCraft community" kartochkasi;
  - getartcraft.com va GitHub havolalari: Help menyusi, About oynalari, File menyusi, lentalar;
  - "Check for updates";
  - About oynalaridagi Contributors va Models tablari;
  - bularning tarjimalari.
- Desktop ilovalar va CLI (`apps/<nom>`, `apps/<nom>-cli`), `xtask`, `packaging/`, `.github/`, `docs/`,
  `contributors/`, README / ROADMAP / AGENTS / CLAUDE fayllari. Har bir papkada faqat `crates/`,
  `apps/<nom>-web`, `assets/` va litsenziya fayllari qoldi.
- GitHub'ga bog'liqlik: `craft-libs` endi `craft-libs/` papkasidan yo'l orqali ulanadi. Build uchun
  tarmoqdan faqat crates.io paketlari yuklanadi.

**Qo'shilgan:**
- **Faqat o'qish sessiyasi.**
  - `crates/engine`: `Session::read_only`; PdfCraft'da `Session::set_view_only`.
  - Hujjatni o'zgartiradigan har bir buyruq va undo/redo rad etiladi.
  - DeckCraft'da sichqoncha bilan sudrash ham ishlamaydi. GridCraft'da katak muharriri ochilmaydi.
  - Zoom esa ishlaydi.
  - Har biri test bilan.
- **Iframe ko'prigi** (`apps/*-web`), `?host=parent` bilan yoqiladi.
  - Xabarlar: `<prefix>:ready` (`modes`), `open`, `opened`, `save`, `dirty`, `failed`, `mode`.
  - `?mode=view` — ko'rish rejimi. WordCraft'da bu oddiy sahifalar ko'rinishi: lenta yig'ilgan,
    chizg'ichlar yo'q.
- **GridCraft'da Ctrl + / Ctrl − zoom qiladi.** Kataklarni qo'shish/o'chirish lenta va o'ng tugma
  menyusida qoladi.
- **Shriftlar to'plami** (WordCraft, GridCraft, DeckCraft). Brauzer kompyuterdagi shriftlarni
  ko'rmaydi, shuning uchun UFile `public/fonts/fonts.json` dagi oilalarni beradi (Arial, Times New
  Roman, Courier New, Calibri, Cambria — `scripts/fetch-fonts.sh`).
  - `apps/*-web/src/web/font_pack.rs`: ro'yxatni `../../fonts/fonts.json` dan o'qiydi va oilani
    birinchi so'ralganda yuklaydi.
  - WordCraft, DeckCraft — `crates/fonts/src/fontdb/pack.rs`: `offer_families`, `want`,
    `add_pack_font`. Shriftlar ro'yxatda turadi, shrift Office nomi bilan qo'shiladi (Carlito →
    Calibri), keyin `generation` o'zgaradi va hujjat qayta chiziladi. Yo'q shrift o'rniga
    qo'yiladigan shriftlar ro'yxatida ham Office nomlari bor.
  - GridCraft — `crates/ui-egui/src/fonts.rs`: xuddi shunday, qo'shimcha `stand_in` (yo'q shrift
    o'rniga, masalan Aptos Narrow → Calibri) va `pack_fallback` (interfeys shriftida yo'q
    belgilar uchun, masalan o'zbekcha `ʻ`).
  - DeckCraft: tema shriftlari bir xil bo'lsa ham menyuda ikkalasi turadi ("(Body)" belgisi
    boshqa shriftga tushib qolmaydi).

## Testlar

```sh
cd engines/pdfcraft  && cargo test -p pdfcraft-engine -p pdfcraft-ui-egui
cd engines/wordcraft && cargo test -p wordcraft-engine -p wordcraft-ui-egui
cd engines/gridcraft && cargo test -p gridcraft-engine -p gridcraft-ui-egui
cd engines/deckcraft && cargo test -p deckcraft-engine -p deckcraft-ui-egui
```

## Asl loyihaning yangi versiyasiga o'tish

1. Asl repozitoriyni yangi commit'da yuklab oling.
2. Yuqoridagi o'zgarishlarni unga ko'chiring. Farqni shu papka bilan `diff -ru` yordamida ko'ring.
3. Olib tashlangan papka va havolalarni yana olib tashlang.
4. Papkani almashtiring va jadvaldagi commit'ni yangilang.
5. `scripts/build-engines.sh` bilan qayta yig'ing.
