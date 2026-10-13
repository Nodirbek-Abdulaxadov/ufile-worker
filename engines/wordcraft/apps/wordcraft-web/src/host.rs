//! The `postMessage` bridge to a same-origin parent page (`?host=parent`), for pages that embed
//! WordCraft in an `<iframe>`. Messages are plain objects with a `type`:
//!
//! - `wordcraft:ready` (to the parent): `{ version, modes }`, the app is listening; send a document
//!   now. `modes` says it switches between viewing and editing in place (`wordcraft:mode`).
//! - `wordcraft:open` (from the parent): `{ name, bytes }`, bytes an `ArrayBuffer` or
//!   `Uint8Array`. It opens like a document picked with File › Open.
//! - `wordcraft:opened` (to the parent): `{ name, ok, error? }` once that document has been read;
//!   `ok` is false, with the reason, when it couldn't be opened.
//! - `wordcraft:mode` (from the parent): `{ mode }`, `"view"` (edits refused, the ribbon folded
//!   to its tabs, as with `?mode=view`) or `"edit"`.
//! - `wordcraft:save` (to the parent): `{ name, bytes }` (a transferred `ArrayBuffer`) for every
//!   file WordCraft would otherwise download: Save and Save As, and the exports (PDF, …). The
//!   parent stores it and reports failures itself.
//! - `wordcraft:dirty` (to the parent): `{ dirty }` whenever unsaved changes appear or go away.
//! - `wordcraft:failed` (to the parent): `{ error }` when the app couldn't start.
//!
//! Only the parent window on the page's own origin is heard or answered. In host mode the page
//! starts with an empty document instead of the start screen, and the parent guards leaving the
//! page.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use serde_json::json;
use wasm_bindgen::JsCast as _;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;
use wordcraft_ui_egui::WordApp;

/// The longest user name taken from `?author=`.
const MAX_AUTHOR_CHARS: usize = 200;

#[derive(Clone)]
pub struct Bridge {
    window: web_sys::Window,
    parent: web_sys::Window,
    origin: String,
    /// Documents the parent sent, opened on the next frame ([`Bridge::open_arrived`]).
    arrived: Rc<RefCell<Vec<(String, Vec<u8>)>>>,
    /// The unsaved-changes state last reported to the parent.
    reported: Rc<Cell<Option<bool>>>,
    /// A switch the parent asked for (`wordcraft:mode`): to viewing only (`true`) or editing.
    mode: Rc<Cell<Option<bool>>>,
}

impl Bridge {
    /// `None` when the page isn't framed (there is no parent to talk to).
    pub fn new() -> Option<Self> {
        let window = web_sys::window()?;
        let parent = window.parent().ok().flatten()?;
        if js_sys::Object::is(&parent, &window) {
            return None;
        }
        let origin = window.location().origin().ok()?;
        Some(Self { window, parent, origin, arrived: Rc::default(), reported: Rc::default(), mode: Rc::default() })
    }

    pub fn post_ready(&self) {
        self.send(&[("type", "wordcraft:ready".into()), ("version", env!("CARGO_PKG_VERSION").into()), ("modes", true.into())]);
    }

    pub fn post_failed(&self, error: &str) {
        self.send(&[("type", "wordcraft:failed".into()), ("error", error.into())]);
    }

    /// `?author=`: the host's name for the user signs new comments and tracked changes.
    pub fn set_author(app: &mut WordApp, author: &str) {
        let author: String = author.trim().chars().take(MAX_AUTHOR_CHARS).collect();
        if !author.is_empty()
            && let Err(e) = app.session.run("file.setAuthor", &json!({"name": author}))
        {
            log::warn!("couldn't take the user name from the page: {e}");
        }
    }

    /// Hear `wordcraft:open` and `wordcraft:mode` from the parent; they apply on the next frame.
    pub fn listen(&self, ctx: egui::Context) {
        let parent = self.parent.clone();
        let origin = self.origin.clone();
        let arrived = self.arrived.clone();
        let mode = self.mode.clone();
        let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
            if event.origin() != origin || !event.source().is_some_and(|s| js_sys::Object::is(&s, &parent)) {
                return;
            }
            let data = event.data();
            match string(&data, "type").as_deref() {
                Some("wordcraft:open") => {
                    let name = string(&data, "name").filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "Document.docx".to_string());
                    let Some(bytes) = bytes(&data) else { return };
                    arrived.borrow_mut().push((name, bytes));
                }
                Some("wordcraft:mode") => match string(&data, "mode").as_deref() {
                    Some("view") => mode.set(Some(true)),
                    Some("edit") => mode.set(Some(false)),
                    _ => return,
                },
                _ => return,
            }
            ctx.request_repaint();
        });
        if self.window.add_event_listener_with_callback("message", on_message.as_ref().unchecked_ref()).is_ok() {
            // The listener lives as long as the page.
            on_message.forget();
        }
    }

    /// Switch between viewing (edits refused, the ribbon folded to its tabs) and editing when
    /// the parent asked to since the last frame. Either way the pages stay as they are shown, so
    /// the place being read stays put.
    pub fn apply_mode(&self, app: &mut WordApp) {
        let Some(view) = self.mode.take() else { return };
        app.session.read_only = view;
        app.ui.ribbon_collapsed = view;
        // Rulers are for setting margins and tabs; viewing has none to set.
        app.session.view.ruler = !view;
    }

    /// Open what the parent sent since the last frame, and tell it how that went.
    pub fn open_arrived(&self, app: &mut WordApp) {
        let arrived = std::mem::take(&mut *self.arrived.borrow_mut());
        for (name, bytes) in arrived {
            let data = wordcraft_engine::cmd::insert::base64_encode(&bytes);
            let opened = app.run("file.open", json!({"path": name, "data": data}));
            if opened.is_ok() {
                app.ui.backstage = false;
            }
            let mut fields = vec![("type", "wordcraft:opened".into()), ("name", JsValue::from_str(&name)), ("ok", opened.is_ok().into())];
            if let Err(e) = &opened {
                log::error!("couldn't open {name}: {e}");
                fields.push(("error", JsValue::from_str(e)));
            }
            self.send(&fields);
        }
    }

    /// Hand a saved or exported file to the parent instead of downloading it.
    pub fn post_save(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
        let buffer = js_sys::Uint8Array::from(bytes).buffer();
        let message = message(&[("type", "wordcraft:save".into()), ("name", name.as_str().into()), ("bytes", buffer.clone().into())])
            .ok_or_else(|| "couldn't build the message".to_string())?;
        self.parent
            .post_message_with_transfer(&message, &self.origin, &js_sys::Array::of1(&buffer))
            .map_err(|e| e.as_string().unwrap_or_else(|| format!("{e:?}")))
    }

    /// Tell the parent when unsaved changes appear or go away.
    pub fn report_dirty(&self, dirty: bool) {
        if self.reported.get() != Some(dirty) && self.send(&[("type", "wordcraft:dirty".into()), ("dirty", dirty.into())]) {
            self.reported.set(Some(dirty));
        }
    }

    /// Post a message to the parent; false if it couldn't be sent.
    fn send(&self, fields: &[(&str, JsValue)]) -> bool {
        message(fields).is_some_and(|m| self.parent.post_message(&m, &self.origin).is_ok())
    }
}

fn message(fields: &[(&str, JsValue)]) -> Option<js_sys::Object> {
    let m = js_sys::Object::new();
    for (key, value) in fields {
        js_sys::Reflect::set(&m, &JsValue::from_str(key), value).ok()?;
    }
    Some(m)
}

fn string(data: &JsValue, key: &str) -> Option<String> {
    js_sys::Reflect::get(data, &JsValue::from_str(key)).ok()?.as_string()
}

/// `bytes` as an `ArrayBuffer` or `Uint8Array`.
fn bytes(data: &JsValue) -> Option<Vec<u8>> {
    let bytes = js_sys::Reflect::get(data, &JsValue::from_str("bytes")).ok()?;
    if let Some(array) = bytes.dyn_ref::<js_sys::Uint8Array>() {
        Some(array.to_vec())
    } else if bytes.is_instance_of::<js_sys::ArrayBuffer>() {
        Some(js_sys::Uint8Array::new(&bytes).to_vec())
    } else {
        None
    }
}
