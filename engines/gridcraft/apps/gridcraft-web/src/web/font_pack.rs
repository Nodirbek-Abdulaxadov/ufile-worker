//! The host's font pack (`fonts/fonts.json` beside the engines, so `../../fonts/` from this page):
//! open stand-ins for the Office fonts under the Office names (Liberation Sans as Arial, Carlito
//! as Calibri…). Its families are offered at start-up and each is downloaded the first time a
//! workbook uses it (or a font it stands in for). Without a pack (another host, a failed request)
//! nothing changes.

use std::cell::RefCell;
use std::collections::HashMap;

use wasm_bindgen::JsCast as _;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;

/// The pack's manifest, relative to this page.
const MANIFEST: &str = "../../fonts/fonts.json";

thread_local! {
    /// Each offered family's file URLs, and the context to repaint when a file arrives.
    static PACK: RefCell<(HashMap<String, Vec<String>>, Option<egui::Context>)> = RefCell::default();
}

fn js(e: JsValue) -> String {
    format!("{e:?}")
}

async fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let window = web_sys::window().ok_or("no window")?;
    let resp: web_sys::Response = JsFuture::from(window.fetch_with_str(url)).await.map_err(js)?.dyn_into().map_err(js)?;
    if !resp.ok() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let buf = JsFuture::from(resp.array_buffer().map_err(js)?).await.map_err(js)?;
    Ok(js_sys::Uint8Array::new(&buf).to_vec())
}

/// Read the manifest and offer its families; a page without a pack logs that and goes on.
pub fn start(ctx: egui::Context) {
    wasm_bindgen_futures::spawn_local(async move {
        let manifest = match fetch_bytes(MANIFEST).await {
            Ok(bytes) => bytes,
            Err(e) => {
                log::info!("no font pack ({MANIFEST}): {e}");
                return;
            }
        };
        let Ok(json) = serde_json::from_slice::<serde_json::Value>(&manifest) else {
            log::warn!("the font pack manifest {MANIFEST} isn't JSON");
            return;
        };
        let dir = MANIFEST.rsplit_once('/').map_or(".", |(d, _)| d);
        let mut families: HashMap<String, Vec<String>> = HashMap::new();
        for f in json.get("families").and_then(|v| v.as_array()).into_iter().flatten() {
            let Some(name) = f.get("family").and_then(|v| v.as_str()) else { continue };
            let files = f.get("files").and_then(|v| v.as_array()).into_iter().flatten().filter_map(|v| v.as_str());
            families.insert(name.to_string(), files.map(|file| format!("{dir}/{file}")).collect());
        }
        let names: Vec<String> = families.keys().cloned().collect();
        PACK.with(|p| *p.borrow_mut() = (families, Some(ctx.clone())));
        gridcraft_ui_egui::fonts::offer_families(names, fetch);
        ctx.request_repaint();
    });
}

/// Download one offered family's files and add them (asked once per family).
fn fetch(family: &str) {
    let (files, ctx) = PACK.with(|p| {
        let p = p.borrow();
        (p.0.get(family).cloned().unwrap_or_default(), p.1.clone())
    });
    for url in files {
        let (family, ctx) = (family.to_string(), ctx.clone());
        wasm_bindgen_futures::spawn_local(async move {
            match fetch_bytes(&url).await {
                Ok(bytes) => {
                    if let Err(e) = gridcraft_ui_egui::fonts::add_pack_font(&family, bytes) {
                        log::warn!("font {url}: {e}");
                    }
                }
                Err(e) => log::warn!("font {url}: {e}"),
            }
            if let Some(ctx) = ctx {
                ctx.request_repaint();
            }
        });
    }
}
