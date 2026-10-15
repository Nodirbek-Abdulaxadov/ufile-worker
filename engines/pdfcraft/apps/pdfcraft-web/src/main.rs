//! PdfCraft in the browser. Build: `cd apps/pdfcraft-web && trunk build --release`
//! (trunk generates the JS loader; no handwritten JS — plan/execution-plan.md §1).
//!
//! URL flags: `?file=<url>` opens a PDF from a URL; `?mode=view` opens documents for viewing
//! only, in Read mode (every edit is refused); `?host=parent` (inside an `<iframe>`) talks to a
//! same-origin parent page (`host`), and `&author=` signs comments with the host's user name.

#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

#[cfg(target_arch = "wasm32")]
fn main() {
    use eframe::wasm_bindgen::JsCast;
    use pdfcraft_ui_egui::PdfCraftApp;

    let options = eframe::WebOptions { renderer: eframe::Renderer::Glow, ..Default::default() };
    wasm_bindgen_futures::spawn_local(async move {
        let Some(canvas) = web_sys::window()
            .and_then(|w| w.document())
            .and_then(|d| d.get_element_by_id("pdfcraft"))
            .and_then(|e| e.dyn_into::<web_sys::HtmlCanvasElement>().ok())
        else {
            return;
        };
        let started = eframe::WebRunner::new()
            .start(
                canvas,
                options,
                Box::new(|cc| {
                    let mut app = PdfCraftApp::new();
                    // "printcraft": settings saved under the app's former name, PrintCraft.
                    if let Some(json) = cc.storage.and_then(|s| s.get_string("pdfcraft").or_else(|| s.get_string("printcraft"))) {
                        app.restore(&json);
                    }
                    // `?mode=view`: documents open for viewing only, in Read mode; every edit is
                    // refused. A viewer keeps the editor's saved settings as they were.
                    let view_only = query_param("mode").as_deref() == Some("view");
                    if view_only {
                        set_view_only(&mut app, true);
                    }
                    let mut shell_bridge = None;
                    // `?file=<url>` opens a PDF from a URL (same-origin or CORS-enabled).
                    if let Some(url) = query_param("file") {
                        let inbox = app.startup_inbox.clone();
                        let failed = app.failed_inbox.clone();
                        let ctx = cc.egui_ctx.clone();
                        wasm_bindgen_futures::spawn_local(async move {
                            let name = url.rsplit('/').next().unwrap_or("document.pdf").split('?').next().unwrap_or("document.pdf").to_string();
                            match fetch_bytes(&url).await {
                                Ok(bytes) => {
                                    if let Ok(mut q) = inbox.lock() {
                                        q.push((name, bytes));
                                    }
                                }
                                Err(e) => {
                                    eframe::web_sys::console::error_1(&format!("PdfCraft: could not fetch {url}: {e}").into());
                                    // Shown in the app too, not only in the console (#173).
                                    if let Ok(mut q) = failed.lock() {
                                        q.push((name, e));
                                    }
                                }
                            }
                            ctx.request_repaint();
                        });
                    }
                    // eframe never raises a close request on a browser reload or tab close, so `guard_quit` never
                    // prompts; ask the browser to confirm instead while a document has unsaved work (#812).
                    warn_before_unload(app.unsaved_flag.clone());
                    // `?host=parent`: a same-origin page embedding PdfCraft in an iframe (such
                    // as the Nextcloud app) passes files in and takes saves back (`host` below).
                    if query_param("host").as_deref() == Some("parent")
                        && let Some(bridge) = host::Bridge::new()
                    {
                        // `?author=`: the host's name for the user signs their comments,
                        // unless they chose a name in PdfCraft (the web default is "Guest").
                        if let Some(author) = query_param("author").map(|a| a.trim().to_string()).filter(|a| !a.is_empty())
                            && app.comment_prefs.author == "Guest"
                        {
                            app.comment_prefs.author = author.chars().take(200).collect();
                        }
                        app.account = account_param();
                        bridge.listen(app.startup_inbox.clone(), cc.egui_ctx.clone());
                        app.host_save = Some(bridge.save_fn());
                        app.host_dirty = Some(bridge.dirty_fn());
                        bridge.post_ready();
                        shell_bridge = Some(bridge);
                    }
                    Ok(Box::new(Shell { app, bridge: shell_bridge, view_only }))
                }),
            )
            .await;
        if let Err(e) = started {
            eframe::web_sys::console::error_1(&e);
            if query_param("host").as_deref() == Some("parent")
                && let Some(bridge) = host::Bridge::new()
            {
                bridge.post_failed(&e.as_string().unwrap_or_else(|| format!("{e:?}")));
            }
        }
    });
}

/// The app, plus what the page around it needs: telling a host page when the documents it sent
/// have opened, and keeping a viewer's settings out of the editor's.
#[cfg(target_arch = "wasm32")]
struct Shell {
    app: pdfcraft_ui_egui::PdfCraftApp,
    bridge: Option<host::Bridge>,
    view_only: bool,
}

#[cfg(target_arch = "wasm32")]
impl eframe::App for Shell {
    fn raw_input_hook(&mut self, ctx: &egui::Context, raw: &mut egui::RawInput) {
        self.app.raw_input_hook(ctx, raw);
    }

    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        if !self.view_only {
            self.app.save(storage);
        }
    }

    fn logic(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        // Sign out, picked in the account menu, is the host page's to do.
        if let (Some(bridge), Some(account)) = (&self.bridge, self.app.account.as_mut())
            && std::mem::take(&mut account.sign_out_requested)
        {
            bridge.post_sign_out();
        }
        if let Some(view) = self.bridge.as_ref().and_then(host::Bridge::take_mode) {
            set_view_only(&mut self.app, view);
            self.view_only = view;
        }
        // Files waiting to open (the app opens them in order, or keeps them for a later frame
        // while a prompt is up).
        let queued: Vec<String> = self.app.startup_inbox.lock().map(|q| q.iter().map(|(name, _)| name.clone()).collect()).unwrap_or_default();
        let before = self.app.session.docs().len();
        self.app.logic(ctx, frame);
        if let Some(bridge) = &self.bridge
            && !queued.is_empty()
            && self.app.startup_inbox.lock().is_ok_and(|q| q.is_empty())
        {
            // Each one that opened added a document; the rest failed, and the app said why.
            let added = self.app.session.docs().len().saturating_sub(before);
            for (i, name) in queued.iter().enumerate() {
                bridge.post_opened(name, i < added);
            }
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        self.app.ui(ui, frame);
    }
}

/// Switch between viewing (Read mode, every edit refused) and editing (All tools).
#[cfg(target_arch = "wasm32")]
fn set_view_only(app: &mut pdfcraft_ui_egui::PdfCraftApp, view: bool) {
    app.session.set_view_only(view.then(|| "it is open for viewing only".to_string()));
    // An explicit mode, which documents opened later keep too.
    if let Err(e) = app.set_option("mode", if view { "read" } else { "all" }) {
        eframe::web_sys::console::warn_1(&format!("PdfCraft: {e}").into());
    }
}

#[cfg(target_arch = "wasm32")]
fn warn_before_unload(unsaved: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    use eframe::wasm_bindgen::{JsCast, closure::Closure};
    let Some(window) = web_sys::window() else { return };
    let handler = Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
        if unsaved.load(std::sync::atomic::Ordering::Relaxed) {
            event.prevent_default();
        }
    });
    if window.add_event_listener_with_callback("beforeunload", handler.as_ref().unchecked_ref()).is_ok() {
        handler.forget();
    }
}

#[cfg(target_arch = "wasm32")]
fn query_param(key: &str) -> Option<String> {
    let search = web_sys::window()?.location().search().ok()?;
    web_sys::UrlSearchParams::new_with_str(&search).ok()?.get(key)
}

/// `?account=` (who signed in to the host page) and `?signout=` (its Sign out item, in the host's
/// words): the title bar's account button. Only in host mode.
#[cfg(target_arch = "wasm32")]
fn account_param() -> Option<pdfcraft_ui_egui::account::Account> {
    let clean = |s: String, max: usize| s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string();
    let name = clean(query_param("account")?, 200);
    if name.is_empty() {
        return None;
    }
    let sign_out = query_param("signout").map(|s| clean(s, 60)).unwrap_or_default();
    Some(pdfcraft_ui_egui::account::Account { name, sign_out, sign_out_requested: false })
}

#[cfg(target_arch = "wasm32")]
async fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    use eframe::wasm_bindgen::JsCast;
    let window = web_sys::window().ok_or("no window")?;
    let resp = wasm_bindgen_futures::JsFuture::from(window.fetch_with_str(url)).await.map_err(|e| format!("{e:?}"))?;
    let resp: web_sys::Response = resp.dyn_into().map_err(|_| "not a response")?;
    if !resp.ok() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let buf = wasm_bindgen_futures::JsFuture::from(resp.array_buffer().map_err(|e| format!("{e:?}"))?).await.map_err(|e| format!("{e:?}"))?;
    Ok(js_sys::Uint8Array::new(&buf).to_vec())
}

/// The `postMessage` bridge to a same-origin parent page. Messages are plain objects with a
/// `type`:
///
/// - `pdfcraft:ready` (to the parent): the app is listening; send files now.
/// - `pdfcraft:open` (from the parent): `{ name, bytes }`, where `bytes` is an `ArrayBuffer` or
///   `Uint8Array` holding a PDF. It opens in a tab, like a `?file=` URL.
/// - `pdfcraft:opened` (to the parent): `{ name, ok }` once that PDF has been read; `ok` is false
///   when it couldn't be opened (the app says why).
/// - `pdfcraft:mode` (from the parent): `{ mode }`, `"view"` (Read mode, every edit refused, as
///   with `?mode=view`) or `"edit"`. `pdfcraft:ready` says it understands this with `modes`.
/// - `pdfcraft:save` (to the parent): `{ name, saveAs, bytes }` when the user saves; `bytes` is
///   a transferred `ArrayBuffer`. The parent stores the file (and reports its own errors).
/// - `pdfcraft:dirty` (to the parent): `{ dirty }` whenever unsaved work appears or goes away.
/// - `pdfcraft:failed` (to the parent): `{ error }` when the app couldn't start.
/// - `pdfcraft:signout` (to the parent): Sign out was picked in the account menu, which
///   `?account=<name>&signout=<label>` puts in the title bar.
///
/// Only the parent window on the app's own origin is heard or answered.
#[cfg(target_arch = "wasm32")]
mod host {
    use eframe::wasm_bindgen::{JsCast, JsValue, closure::Closure};

    #[derive(Clone)]
    pub struct Bridge {
        window: web_sys::Window,
        parent: web_sys::Window,
        origin: String,
        /// A switch the parent asked for (`pdfcraft:mode`): to viewing only (`true`) or editing.
        mode: std::rc::Rc<std::cell::Cell<Option<bool>>>,
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
            Some(Self { window, parent, origin, mode: Default::default() })
        }

        fn post(&self, message: &js_sys::Object, transfer: Option<&JsValue>) -> Result<(), String> {
            let sent = match transfer {
                Some(t) => self.parent.post_message_with_transfer(message, &self.origin, &js_sys::Array::of1(t)),
                None => self.parent.post_message(message, &self.origin),
            };
            sent.map_err(|e| e.as_string().unwrap_or_else(|| format!("{e:?}")))
        }

        pub fn post_ready(&self) {
            if let Some(m) = message(&[("type", "pdfcraft:ready".into()), ("version", env!("CARGO_PKG_VERSION").into()), ("modes", true.into())]) {
                let _ = self.post(&m, None);
            }
        }

        /// The switch to viewing only (`true`) or editing the parent asked for since the last frame.
        pub fn take_mode(&self) -> Option<bool> {
            self.mode.take()
        }

        /// A PDF the parent sent has been read (`ok`), or couldn't be opened.
        pub fn post_opened(&self, name: &str, ok: bool) {
            if let Some(m) = message(&[("type", "pdfcraft:opened".into()), ("name", name.into()), ("ok", ok.into())]) {
                let _ = self.post(&m, None);
            }
        }

        /// The app couldn't start (no WebGL, for example): let the parent say so.
        pub fn post_failed(&self, error: &str) {
            if let Some(m) = message(&[("type", "pdfcraft:failed".into()), ("error", error.into())]) {
                let _ = self.post(&m, None);
            }
        }

        /// Sign out was picked in the account menu: the parent signs the person out.
        pub fn post_sign_out(&self) {
            if let Some(m) = message(&[("type", "pdfcraft:signout".into())]) {
                let _ = self.post(&m, None);
            }
        }

        /// Hear `pdfcraft:open` from the parent and queue the file like a `?file=` download.
        pub fn listen(&self, inbox: pdfcraft_ui_egui::Inbox, ctx: egui::Context) {
            let parent = self.parent.clone();
            let origin = self.origin.clone();
            let mode = self.mode.clone();
            let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
                if event.origin() != origin || !event.source().is_some_and(|s| js_sys::Object::is(&s, &parent)) {
                    return;
                }
                let data = event.data();
                if string(&data, "type").as_deref() == Some("pdfcraft:mode") {
                    match string(&data, "mode").as_deref() {
                        Some("view") => mode.set(Some(true)),
                        Some("edit") => mode.set(Some(false)),
                        _ => return,
                    }
                    ctx.request_repaint();
                    return;
                }
                if string(&data, "type").as_deref() != Some("pdfcraft:open") {
                    return;
                }
                let name = string(&data, "name").filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "document.pdf".to_string());
                let Ok(bytes) = js_sys::Reflect::get(&data, &JsValue::from_str("bytes")) else { return };
                let bytes = if let Some(array) = bytes.dyn_ref::<js_sys::Uint8Array>() {
                    array.to_vec()
                } else if bytes.is_instance_of::<js_sys::ArrayBuffer>() {
                    js_sys::Uint8Array::new(&bytes).to_vec()
                } else {
                    return;
                };
                if let Ok(mut q) = inbox.lock() {
                    q.push((name, bytes));
                }
                ctx.request_repaint();
            });
            if self.window.add_event_listener_with_callback("message", on_message.as_ref().unchecked_ref()).is_ok() {
                // The listener lives as long as the page.
                on_message.forget();
            }
        }

        pub fn save_fn(&self) -> pdfcraft_ui_egui::HostSaveFn {
            let bridge = self.clone();
            Box::new(move |name: &str, bytes: &[u8], save_as: bool| {
                let buffer = js_sys::Uint8Array::from(bytes).buffer();
                let m =
                    message(&[("type", "pdfcraft:save".into()), ("name", name.into()), ("saveAs", save_as.into()), ("bytes", buffer.clone().into())])
                        .ok_or_else(|| "couldn't build the message".to_string())?;
                bridge.post(&m, Some(&buffer))
            })
        }

        pub fn dirty_fn(&self) -> pdfcraft_ui_egui::HostDirtyFn {
            let bridge = self.clone();
            let mut last = false;
            Box::new(move |dirty: bool| {
                if dirty != last {
                    last = dirty;
                    if let Some(m) = message(&[("type", "pdfcraft:dirty".into()), ("dirty", dirty.into())]) {
                        let _ = bridge.post(&m, None);
                    }
                }
            })
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
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("pdfcraft-web targets wasm32: run `trunk serve` or `trunk build --release` in apps/pdfcraft-web");
}
