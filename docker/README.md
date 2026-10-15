# UFile — view and edit office documents in the browser

UFile opens **PDF, Word, Excel and PowerPoint** files right in the browser, for **viewing** or
**editing**, as a page of its own or **embedded in your site's `<iframe>`**. The documents are opened
and edited on the user's machine (WebAssembly engines); nothing is sent to the server unless you
give it a `saveUrl`.

| Type | Opens |
|---|---|
| PDF | `.pdf` |
| Word | `.docx` `.docm` `.dotx` `.doc` `.odt` `.rtf` `.txt` `.md` `.html` |
| Excel | `.xlsx` `.xlsm` `.xls` `.xlsb` `.ods` `.csv` `.tsv` |
| PowerPoint | `.pptx` `.potx` `.ppsx` |

- **Two modes:**
  - **View** is read-only, enforced by the engines themselves, not just hidden buttons.
  - **Edit** is a full editor: ribbon, styles, tables, formulas, slides, PDF comments and forms.
  - Switching between them is instant.
- **Embeddable:** a plain `<iframe>` with URL parameters, a small JavaScript SDK, or a
  `postMessage` API.
- **Saves go where you want:** to your backend (`saveUrl`, PUT/POST), back to your page as bytes,
  or to the user's computer.
- **UFile's own interface:** Uzbek, Russian and English, with light and dark themes. The editors
  inside follow the browser's language.

## Quick start

```sh
docker run -d --name ufile -p 8080:8080 -v ufile-files:/data nbkabdulaxadov/ufile-worker
```

Open http://localhost:8080/ to drop a file in, or http://localhost:8080/demo.html for the embedding
demo.

## Embedding

```html
<!-- An iframe -->
<iframe src="https://docs.example.com/?url=https%3A%2F%2Ffiles.example.com%2Freport.pdf&mode=view"
        style="width:100%;height:80vh;border:0" allow="clipboard-read; clipboard-write; fullscreen"></iframe>

<!-- Or the SDK -->
<script src="https://docs.example.com/sdk/ufile.js"></script>
<div id="doc" style="height:80vh"></div>
<script>
  UFile.mount('#doc', {
    url: 'https://files.example.com/report.docx',
    mode: 'edit',                         // 'view' | 'edit'
    lang: 'uz',                           // 'uz' | 'ru' | 'en'
    author: 'Aziz Karimov',
    onSave: async (file) => { await fetch('/api/documents/42', { method: 'PUT', body: file.blob }); },
  });
</script>
```

URL parameters: `url`, `name`, `mode`, `allowEdit=0`, `saveUrl`, `saveMethod`, `lang`, `author`,
`toolbar=0`, `new=word|excel|slides`. All parameters, SDK methods and events are listed in the
[README](https://github.com/Nodirbek-Abdulaxadov/ufile-worker#readme).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `UFILE_PORT` | `8080` | Port inside the container |
| `UFILE_STORAGE` | `/data` | Built-in file store (`/api/files`); `off` turns it off |
| `UFILE_MAX_UPLOAD_MB` | `300` | Largest file the store accepts |
| `UFILE_FRAME_ANCESTORS` | `*` | Pages allowed to embed UFile (CSP `frame-ancestors`), space separated |
| `UFILE_CORS` | — | Other origins allowed to call `/api/files`, comma separated |
| `UFILE_EMBED_ONLY` | — | `1` serves UFile only inside an `<iframe>` (the SDK): no landing page, no demo, no page opened in a tab |
| `UFILE_QUIET` | `1` | `0` logs every request |

Which sites may drive UFile, where files may be opened from and where saves may go are set in
`config.json`. To change them, mount your own copy:

```sh
docker run -d -p 8080:8080 -v ufile-files:/data \
  -v ./config.json:/app/public/config.json:ro \
  -e UFILE_FRAME_ANCESTORS="https://intranet.example.com" \
  nbkabdulaxadov/ufile-worker
```

```json
{
  "allowedParentOrigins": ["https://intranet.example.com"],
  "allowedFileOrigins": ["self", "https://files.example.com"],
  "allowedSaveOrigins": ["self"],
  "defaultMode": "edit",
  "defaultLanguage": "uz",
  "allowEdit": true,
  "author": "",
  "maxFileMB": 300
}
```

## Built-in file store

A simple store for trying UFile out, without authentication. In production, point `saveUrl` at
your own backend, or start the container with `-e UFILE_STORAGE=off`.

| Request | Does |
|---|---|
| `GET /api/files` | List the files |
| `GET /api/files/<name>` | Download one |
| `PUT /api/files/<name>` | Save (the body is the file) |
| `DELETE /api/files/<name>` | Delete |
| `GET /healthz` | Health check (used by the image's `HEALTHCHECK`) |

## Details

- **Port** `8080`, **volume** `/data`; the server runs as the unprivileged `node` user.
- **Tags:** `latest` and versions (`1.2.0`); platform `linux/amd64`.
- **HTTPS:** serve it over HTTPS in production. WebGPU and the clipboard need a secure context;
  without them the engines fall back to WebGL2.
- **Downloads:** browsers fetch each engine once (4.6–9 MB compressed) and then load it from cache.
- **Fonts:** a browser page can't use the fonts installed on the computer, so UFile serves open fonts
  with the same metrics under the Office names: Arial, Times New Roman and Courier New (Liberation),
  Calibri (Carlito) and Cambria (Caladea). Each family is fetched the first time a document uses it.

## Source and licence

- Source: https://github.com/Nodirbek-Abdulaxadov/ufile-worker. UFile is MIT licensed.
- The fonts in `/app/public/fonts` are under the SIL Open Font License 1.1 (licence files next to
  them).
- The document engines are based on the open-source projects of the
  [ArtCraft](https://getartcraft.com) team: PdfCraft, WordCraft, GridCraft and DeckCraft
  (MIT OR Apache-2.0).
