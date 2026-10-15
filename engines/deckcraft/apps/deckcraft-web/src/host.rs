//! The `postMessage` bridge to a same-origin parent page (`?host=parent`), for pages that embed
//! DeckCraft in an `<iframe>`. Messages are plain objects with a `type`:
//!
//! - `deckcraft:ready` (to the parent): `{ version, modes }`, the app is listening; send a
//!   presentation now. `modes` says it switches between viewing and editing in place
//!   (`deckcraft:mode`).
//! - `deckcraft:open` (from the parent): `{ name, bytes }`, bytes an `ArrayBuffer` or
//!   `Uint8Array` holding a `.pptx` (or `.potx`, `.ppsx`, `.deckcraft`). It opens like a file
//!   picked with File › Open.
//! - `deckcraft:opened` (to the parent): `{ name, ok, error? }` once that presentation has been
//!   read; `ok` is false, with the reason, when it couldn't be opened.
//! - `deckcraft:mode` (from the parent): `{ mode }`, `"view"` (edits refused, as with
//!   `?mode=view`) or `"edit"`.
//! - `deckcraft:save` (to the parent): `{ name, bytes }` (a transferred `ArrayBuffer`) for every
//!   file DeckCraft would otherwise download. Saving the presentation the parent opened hands it
//!   back under that name and in that format (a `.pptx` stays a `.pptx`); exports (PDF, pictures,
//!   outlines) keep their own names. The parent stores the file and reports failures itself.
//! - `deckcraft:dirty` (to the parent): `{ dirty }` whenever unsaved changes appear or go away.
//! - `deckcraft:failed` (to the parent): `{ error }` when the app couldn't start.
//! - `deckcraft:signout` (to the parent): Sign out was picked in the account menu, which
//!   `?account=<name>&signout=<label>` puts in the title bar.
//!
//! Only the parent window on the page's own origin is heard or answered. In host mode the page
//! starts without a presentation instead of the sample deck, and the parent guards leaving the
//! page.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use deckcraft_ui_egui::SlideApp;
use serde_json::json;
use wasm_bindgen::JsCast as _;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;

/// Formats a presentation from the parent is handed back in. Anything else (an outline opened as
/// slides) comes back as a `.pptx`.
const KEPT_FORMATS: &[&str] = &["pptx", "potx", "ppsx", "deckcraft"];

/// The longest user name taken from `?author=`.
const MAX_AUTHOR_CHARS: usize = 200;

/// The presentation the parent opened.
#[derive(Clone)]
struct Hosted {
    /// Its document in the session ([`deckcraft_engine::DocState::uid`]).
    uid: u64,
    /// The name the parent gave it, which saves come back under.
    name: String,
}

#[derive(Clone)]
pub struct Bridge {
    window: web_sys::Window,
    parent: web_sys::Window,
    origin: String,
    /// Presentations the parent sent, opened on the next frame ([`Bridge::open_arrived`]).
    arrived: Rc<RefCell<Vec<(String, Vec<u8>)>>>,
    hosted: Rc<RefCell<Option<Hosted>>>,
    /// The parent's presentation was handed back since the last frame: it now counts as saved.
    saved: Rc<Cell<bool>>,
    /// The unsaved-changes state last reported to the parent.
    reported: Rc<Cell<Option<bool>>>,
    /// A switch the parent asked for (`deckcraft:mode`): to viewing only (`true`) or editing.
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
        Some(Self {
            window,
            parent,
            origin,
            arrived: Rc::default(),
            hosted: Rc::default(),
            saved: Rc::default(),
            reported: Rc::default(),
            mode: Rc::default(),
        })
    }

    pub fn post_ready(&self) {
        self.send(&[("type", "deckcraft:ready".into()), ("version", env!("CARGO_PKG_VERSION").into()), ("modes", true.into())]);
    }

    pub fn post_failed(&self, error: &str) {
        self.send(&[("type", "deckcraft:failed".into()), ("error", error.into())]);
    }

    /// Sign out was picked in the account menu: the parent signs the person out.
    pub fn post_sign_out(&self) {
        self.send(&[("type", "deckcraft:signout".into())]);
    }

    /// `?author=`: the host's name for the user signs new comments.
    pub fn set_author(app: &mut SlideApp, author: &str) {
        let author: String = author.trim().chars().filter(|c| !c.is_control()).take(MAX_AUTHOR_CHARS).collect();
        if !author.is_empty() {
            app.session.prefs.author = author;
        }
    }

    /// Hear `deckcraft:open` from the parent. The presentation opens on the next frame.
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
                Some("deckcraft:open") => {
                    let name = string(&data, "name").filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "Presentation.pptx".to_string());
                    let Some(bytes) = bytes(&data) else { return };
                    arrived.borrow_mut().push((name, bytes));
                }
                Some("deckcraft:mode") => match string(&data, "mode").as_deref() {
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

    /// The switch to viewing only (`true`) or editing the parent asked for since the last frame.
    pub fn take_mode(&self) -> Option<bool> {
        self.mode.take()
    }

    /// Open what the parent sent since the last frame, and tell it how that went.
    pub fn open_arrived(&self, app: &mut SlideApp) {
        let arrived = std::mem::take(&mut *self.arrived.borrow_mut());
        for (name, bytes) in arrived {
            let data = deckcraft_engine::cmd::base64_encode(&bytes);
            let opened = app.session.execute("file.openBytes", &json!({"name": name, "data": data}));
            let mut fields = vec![("type", "deckcraft:opened".into()), ("name", JsValue::from_str(&name)), ("ok", opened.is_ok().into())];
            match &opened {
                Ok(_) => {
                    if let Some(uid) = app.session.active().map(|d| d.uid) {
                        *self.hosted.borrow_mut() = Some(Hosted { uid, name: name.clone() });
                    }
                    app.backstage = None;
                }
                Err(e) => {
                    let e = e.to_string();
                    log::error!("couldn't open {name}: {e}");
                    app.set_status(format!("{name}: {e}"));
                    fields.push(("error", JsValue::from_str(&e)));
                }
            }
            self.send(&fields);
        }
    }

    /// The `download` service in host mode: hand the file to the parent. A save of the parent's
    /// presentation (DeckCraft's web Save writes its own `.deckcraft` format) comes back in the
    /// format it was opened in, under its name.
    pub fn post_download(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
        let hosted = self.hosted.borrow().clone();
        let (name, bytes, is_save) = match hosted.as_ref().and_then(|h| save_of(&h.name, &name)) {
            Some(Save::AsIs) => (hosted.map(|h| h.name).unwrap_or(name), bytes.to_vec(), true),
            Some(Save::Convert(format)) => {
                let doc = deckcraft_engine::cmd::file::open_presentation(&name, bytes).map_err(|e| e.to_string())?;
                let converted = deckcraft_engine::cmd::file::save_bytes(&doc, &format).map_err(|e| e.to_string())?;
                (hosted.map(|h| h.name).unwrap_or(name), converted, true)
            }
            None => (name, bytes.to_vec(), false),
        };
        let buffer = js_sys::Uint8Array::from(bytes.as_slice()).buffer();
        let message = message(&[("type", "deckcraft:save".into()), ("name", name.as_str().into()), ("bytes", buffer.clone().into())])
            .ok_or_else(|| "couldn't build the message".to_string())?;
        self.parent
            .post_message_with_transfer(&message, &self.origin, &js_sys::Array::of1(&buffer))
            .map_err(|e| e.as_string().unwrap_or_else(|| format!("{e:?}")))?;
        if is_save {
            self.saved.set(true);
        }
        Ok(())
    }

    /// After each frame: the parent's presentation, once handed back, counts as saved, and the
    /// parent hears when unsaved changes appear or go away.
    pub fn sync(&self, app: &mut SlideApp) {
        let uid = self.hosted.borrow().as_ref().map(|h| h.uid);
        if self.saved.replace(false)
            && let Some(d) = app.session.active_mut()
            && Some(d.uid) == uid
        {
            d.saved_doc = d.doc.clone();
        }
        let dirty = app.session.documents().iter().any(|d| d.is_dirty());
        if self.reported.get() != Some(dirty) && self.send(&[("type", "deckcraft:dirty".into()), ("dirty", dirty.into())]) {
            self.reported.set(Some(dirty));
        }
    }

    /// Post a message to the parent; false if it couldn't be sent.
    fn send(&self, fields: &[(&str, JsValue)]) -> bool {
        message(fields).is_some_and(|m| self.parent.post_message(&m, &self.origin).is_ok())
    }
}

/// How a download of `name` saves the parent's presentation `hosted`.
#[derive(Debug, PartialEq)]
enum Save {
    /// It already is in the presentation's format.
    AsIs,
    /// DeckCraft's own format: convert it to this one first.
    Convert(String),
}

/// `None` when `name` isn't the parent's presentation but an export (a PDF, a picture, an
/// outline) or another file.
fn save_of(hosted: &str, name: &str) -> Option<Save> {
    let (hosted_stem, hosted_ext) = split(hosted);
    let (stem, ext) = split(name);
    if stem != hosted_stem {
        return None;
    }
    let kept = if KEPT_FORMATS.contains(&hosted_ext.as_str()) { hosted_ext } else { "pptx".to_string() };
    if ext == kept {
        Some(Save::AsIs)
    } else if ext == "deckcraft" {
        Some(Save::Convert(kept))
    } else {
        None
    }
}

/// A file name's stem and lower-case extension.
fn split(name: &str) -> (String, String) {
    let path = std::path::Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    (stem, ext)
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
