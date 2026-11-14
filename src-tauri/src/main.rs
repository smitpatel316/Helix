// Titer's native shell: the project windows showing the web app (src/), a hidden
// window running R (src/engine.ts), and the few things a web page can't do on its
// own. See src/native.ts for the other side.
//
// macOS-only Objective-C calls live behind #[cfg(target_os = "macos")]; the
// Linux build (dev/test only — the Mac DMG stays the release) gets no-op or
// xdg-open equivalents so the same commands keep their signatures.
mod cloud;
mod cloud_box;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
#[cfg(target_os = "macos")]
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
// OnceLock is only used by the macOS quit hook (ask_before_quitting_macos).
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use tauri::{
    async_runtime::{channel, Sender},
    ipc::{InvokeBody, Request},
    utils::config::WindowConfig,
    webview::NewWindowResponse,
    AppHandle, Emitter, LogicalPosition, Manager, RunEvent, State, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

// In-app auto-update (v2, item 77): the download / verify / apply /
// relaunch half. The check half lives in the frontend (src/updates.ts).
mod updater;

// ── Project windows ──────────────────────────────────────────────────────

/// A project file for a window to open once its page is ready. `untitled`: shown as a
/// new document, like the sample, so saving asks where.
#[derive(Serialize)]
struct Opening {
    path: String,
    untitled: bool,
}

/// What a project window holds, as its page last said.
struct Document {
    path: Option<String>,
    /// A fresh project nobody has touched: the next project opens in its place.
    blank: bool,
}

/// The project windows ("project-1", "project-2"…), one project each. Opening a
/// project brings its window forward if it is open already, fills the front
/// window if that one is blank, or opens a new window. Titer stays open without
/// any, as Pages does: only quitting closes them all and then ends (`quitting`).
#[derive(Default)]
struct Projects(Mutex<ProjectWindows>);

#[derive(Default)]
struct ProjectWindows {
    count: u32,
    documents: HashMap<String, Document>,
    openings: HashMap<String, Opening>,
    quitting: bool,
}

impl Opening {
    /// The project file, unless it opens as a new document.
    fn file(&self) -> Option<&String> {
        (!self.untitled).then_some(&self.path)
    }
}

impl ProjectWindows {
    /// Gives `opening` to the window `label`, taken from now on: a second project never
    /// lands in the same window, and the same file is found open at once.
    fn hold(&mut self, label: &str, opening: Opening) {
        let path = opening.file().cloned();
        self.documents.insert(label.into(), Document { path, blank: false });
        self.openings.insert(label.into(), opening);
    }

    /// A new window's label, and its project held at once: with the lock still held,
    /// no other opening (the Finder's, the last session's) can take the same file.
    fn reserve(&mut self, opening: Option<Opening>) -> String {
        self.count += 1;
        let label = format!("project-{}", self.count);
        if let Some(opening) = opening {
            self.hold(&label, opening);
        }
        label
    }
}

/// New windows cascade down and right from the front one, as in the Finder.
const CASCADE: f64 = 22.0;

fn is_project(label: &str) -> bool {
    label.starts_with("project-")
}

/// The project window in front, if any.
fn front_window(app: &AppHandle) -> Option<WebviewWindow> {
    let windows: Vec<_> = app.webview_windows().into_values().filter(|w| is_project(w.label())).collect();
    windows.iter().find(|w| w.is_focused().unwrap_or(false)).or(windows.first()).cloned()
}

/// Opens a project window; blank unless it has something to open.
fn new_window(app: &AppHandle, opening: Option<Opening>) -> tauri::Result<()> {
    let label = app.state::<Projects>().0.lock().unwrap().reserve(opening);
    build_window(app, label)
}

/// Builds the window `label` from the "project" template in tauri.conf.json.
fn build_window(app: &AppHandle, label: String) -> tauri::Result<()> {
    let template = app.config().app.windows.iter().find(|w| w.label == "project").expect("window template");
    let front = front_window(app);
    // The first window appears where the last one was; the others appear once cascaded.
    let config = WindowConfig { label, visible: front.is_none(), ..template.clone() };
    // A project window only ever shows Titer: a link in a text a file brought (a graph's
    // title…) neither takes the window elsewhere nor opens another.
    let window = WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(|url| url.scheme() == "tauri" || (cfg!(debug_assertions) && url.host_str() == Some("localhost")))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()?;
    if let Some(front) = front {
        // A front window still being made (Titer launched by opening a file) can't say
        // where it is yet: the new one then keeps the remembered frame.
        if let (Ok(at), Ok(scale), Ok(size)) = (front.outer_position(), front.scale_factor(), front.inner_size()) {
            let at = at.to_logical::<f64>(scale);
            window.set_size(size)?;
            window.set_position(LogicalPosition::new(at.x + CASCADE, at.y + CASCADE))?;
        }
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

/// Opens `opening` in the window `into` if that one is blank, else as described on `Projects`.
fn open(app: &AppHandle, into: Option<String>, opening: Opening) -> tauri::Result<()> {
    let state = app.state::<Projects>();
    let mut projects = state.0.lock().unwrap();
    let path = opening.file();
    if let Some((label, _)) = projects.documents.iter().find(|(_, d)| path.is_some() && d.path.as_ref() == path) {
        // Open already: its window comes forward, or, still being made, shows itself.
        return app.get_webview_window(label).map_or(Ok(()), |window| window.set_focus());
    }
    let blank = |label: &String| is_project(label) && projects.documents.get(label).is_none_or(|d| d.blank);
    let Some(label) = into.filter(blank) else {
        let label = projects.reserve(Some(opening));
        drop(projects);
        return build_window(app, label);
    };
    projects.hold(&label, opening);
    drop(projects);
    app.emit_to(label, "opening", ())
}

#[tauri::command]
fn take_opening(window: WebviewWindow, projects: State<Projects>) -> Option<Opening> {
    projects.0.lock().unwrap().openings.remove(window.label())
}

/// The window's project file, its unsaved-changes dot (in the close button), and
/// whether it is blank.
#[tauri::command]
fn set_document(window: WebviewWindow, projects: State<Projects>, path: Option<String>, edited: bool, blank: bool) {
    // macOS only: the unsaved-changes dot in the close button. On Linux there is
    // no NSWindow, so this is just the state update below.
    #[cfg(target_os = "macos")]
    if let Ok(ns_window) = window.ns_window() {
        let ns_window = ns_window.cast::<AnyObject>();
        unsafe {
            let _: () = objc2::msg_send![ns_window, setDocumentEdited: edited];
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = edited; // no close-button dot on Linux; kept for the Mac signature
    let mut projects = projects.0.lock().unwrap();
    if !projects.openings.contains_key(window.label()) {
        projects.documents.insert(window.label().into(), Document { path, blank });
    }
}

#[tauri::command]
async fn open_projects(app: AppHandle, window: WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    if let Some(gone) = paths.iter().find(|path| !Path::new(path).is_file()) {
        return Err(gone.clone());
    }
    for path in paths {
        open(&app, Some(window.label().into()), Opening { path, untitled: false }).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The sample project, which ships inside the app, opened as a new document.
#[tauri::command]
async fn open_sample(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let path = app.path().resource_dir().map_err(|e| e.to_string())?.join("Titer Sample.hlx");
    let opening = Opening { path: path.to_string_lossy().into_owned(), untitled: true };
    open(&app, Some(window.label().into()), opening).map_err(|e| e.to_string())
}

#[tauri::command]
async fn new_project(app: AppHandle) -> Result<(), String> {
    new_window(&app, None).map_err(|e| e.to_string())
}

/// File ▸ Open…: the Open panel, then the project opens as `open` decides.
#[tauri::command]
fn choose_project(app: AppHandle, window: WebviewWindow) {
    let into = window.label().to_string();
    app.dialog().file().set_title("Open Project").add_filter("Titer Project", &["hlx"]).pick_file(move |file| {
        if let Some(path) = file.and_then(|file| file.into_path().ok()) {
            let _ = open(&app, Some(into), Opening { path: path.to_string_lossy().into_owned(), untitled: false });
        }
    });
}

/// File ▸ Import Prism File…: the Open panel for a Prism file (`.pzfx` or
/// `.prism`).
/// Non-blocking, like choose_project: blocking_pick_file parks the main
/// thread on a semaphore while the NSOpenPanel needs that same thread to
/// process clicks — deadlock, Titer (not responding), 0% CPU (confirmed
/// Nov 9 on macOS; the same bug froze the picker on Linux). pick_file's
/// callback fires when the user picks or cancels, and the page then reads
/// the file (read_prism_text) and imports it. The event carries the path,
/// or null on Cancel, so the page can unsubscribe either way.
#[tauri::command]
fn choose_prism_file(app: AppHandle, window: WebviewWindow) {
    let label = window.label().to_string();
    app.dialog().file().set_title("Import Prism File").add_filter("GraphPad Prism File", &["pzfx", "prism"]).pick_file(
        move |file| {
            let picked = file.and_then(|file| file.into_path().ok()).map(|path| path.to_string_lossy().into_owned());
            let _ = app.emit_to(label.as_str(), "prism-file-picked", picked);
        },
    );
}

/// A window refused to close (its user chose Cancel): Titer doesn't quit after all.
#[tauri::command]
fn cancel_quit(projects: State<Projects>) {
    projects.0.lock().unwrap().quitting = false;
}

/// Quits through the normal flow, as the macOS quit hook does: mark the
/// quit, close the project windows (each asks about its unsaved changes),
/// and the run loop ends Titer once the last one is gone. Used by the
/// updater after staging a relaunch. A window whose user cancels the quit
/// calls `cancel_quit`, which clears the flag, so Titer stays.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.state::<Projects>().0.lock().unwrap().quitting = true;
    for window in app.webview_windows().into_values().filter(|w| is_project(w.label())) {
        let _ = window.close();
    }
    if !app.webview_windows().keys().any(|l| is_project(l)) {
        app.exit(0);
    }
}

// ── Session ──────────────────────────────────────────────────────────────
// The project files still open when Titer quits, reopened at the next launch, each
// in its window (as Pages does). A project closed before quitting doesn't come back.

/// One path per line, in Titer's data folder.
fn session_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("open-projects"))
}

// Only called by the macOS quit hook; on Linux there is no quit hook, so allow
// the dead-code warning there rather than deleting shared session code.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn save_session(app: &AppHandle) {
    let state = app.state::<Projects>();
    let projects = state.0.lock().unwrap();
    let mut open: Vec<_> = projects.documents.iter().filter_map(|(label, d)| Some((label, d.path.as_ref()?))).collect();
    // In the order they were opened: "project-2" before "project-10".
    open.sort_by_key(|(label, _)| label.trim_start_matches("project-").parse::<u32>().unwrap_or(0));
    let text = open.iter().map(|(_, path)| path.as_str()).collect::<Vec<_>>().join("\n");
    if let Some(file) = session_file(app) {
        let _ = file.parent().map(fs::create_dir_all);
        let _ = fs::write(file, text);
    }
}

/// Reopens the last session's projects that are still there, else a blank project. Like the
/// Finder's, each goes through `open`: a file already opened (Titer launched by opening it)
/// isn't opened twice. A project that can't be reopened never stops Titer.
fn restore_session(app: &AppHandle) {
    let text = session_file(app).and_then(|file| fs::read_to_string(file).ok()).unwrap_or_default();
    for path in text.lines().filter(|path| Path::new(path).is_file()) {
        let _ = open(app, None, Opening { path: path.into(), untitled: false });
    }
    let opened = !app.state::<Projects>().0.lock().unwrap().documents.is_empty();
    if !opened && front_window(app).is_none() {
        let _ = new_window(app, None);
    }
}

// ── Files ────────────────────────────────────────────────────────────────

/// Only the file types Titer actually reads or writes, so even a compromised
/// page can't touch anything else on disk.
fn check_extension(path: &str, allowed: &[&str]) -> Result<(), String> {
    let ext = Path::new(path).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    match ext {
        Some(ext) if allowed.contains(&ext.as_str()) => Ok(()),
        _ => Err(format!("Titer can't access {path}")),
    }
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    check_extension(&path, &["hlx"])?;
    fs::read_to_string(path).map_err(|e| e.to_string())
}

/// A Prism `.pzfx` file's text, for import. Only `.pzfx`, as read_text is only `.hlx`.
#[tauri::command]
fn read_prism_text(path: String) -> Result<String, String> {
    check_extension(&path, &["pzfx"])?;
    fs::read_to_string(path).map_err(|e| e.to_string())
}

/// A Prism `.prism` file's bytes, for import — a `.prism` file is a ZIP, so
/// text won't do. Base64, not a JSON number array: a 40 MB file would be a
/// 40 M-number array the webview would have to parse one number at a time.
#[tauri::command]
fn read_prism_bytes(path: String) -> Result<String, String> {
    check_extension(&path, &["prism"])?;
    fs::read(path).map(|bytes| BASE64.encode(bytes)).map_err(|e| e.to_string())
}

/// Writes the raw request body to the (URL-encoded) `path` header, atomically.
#[tauri::command]
fn write_file(request: Request) -> Result<(), String> {
    let header = request.headers().get("path").and_then(|v| v.to_str().ok()).ok_or("missing path")?;
    let path = percent_encoding::percent_decode_str(header).decode_utf8().map_err(|e| e.to_string())?;
    check_extension(&path, &["hlx", "prism", "png", "jpg", "jpeg", "svg"])?;
    let InvokeBody::Raw(data) = request.body() else { return Err("expected raw bytes".into()) };
    write_atomically(Path::new(path.as_ref()), data)
}

/// A temp file renamed over `path`, so a save is never left half-written.
fn write_atomically(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp"); // beside it: "Data.hlx.tmp"
    fs::write(&tmp, data).and_then(|()| fs::rename(&tmp, path)).map_err(|e| {
        let _ = fs::remove_file(&tmp); // a failed save leaves nothing behind
        e.to_string()
    })
}

// ── My Palettes ──────────────────────────────────────────────────────────
// The palettes made on this Mac, for every project and window: JSON in Titer's data
// folder, read and checked by the page (src/store/my-palettes.ts).

const PALETTES_FILE: &str = "palettes.json";

/// The file's text, empty before the first palette.
#[tauri::command]
fn read_my_palettes(app: AppHandle) -> String {
    app.path().app_data_dir().ok().and_then(|dir| fs::read_to_string(dir.join(PALETTES_FILE)).ok()).unwrap_or_default()
}

#[tauri::command]
fn write_my_palettes(app: AppHandle, text: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_atomically(&dir.join(PALETTES_FILE), text.as_bytes())
}

// ── Cloud storage (v2 item 75, Box first) ─────────────────────────────────
// The commands behind src/lib/cloud.ts. All provider HTTP and all tokens live
// in Rust (cloud.rs / cloud_box.rs); the page only ever sees account identity,
// folder listings, and file bytes — never a token. See
// docs/cloud-storage-box.md for the design and the Box PKCE verdict.

/// The connected accounts, as the page sees them: identity only, never
/// tokens. Kept in Titer's data folder (`cloud-accounts.json`); the tokens
/// themselves live in the OS keychain, keyed by provider + account id.
fn cloud_registry_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("cloud-accounts.json"))
}

fn load_cloud_registry(app: &AppHandle) -> Vec<cloud::CloudAccount> {
    cloud_registry_file(app)
        .and_then(|file| fs::read_to_string(file).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_cloud_registry(app: &AppHandle, accounts: &[cloud::CloudAccount]) -> Result<(), cloud::CloudError> {
    let Some(file) = cloud_registry_file(app) else {
        return Err(cloud::CloudError::provider("Couldn't find the app-data folder."));
    };
    let text = serde_json::to_string(accounts)
        .map_err(|e| cloud::CloudError::provider(format!("Couldn't record the cloud account: {e}")))?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| cloud::CloudError::provider(e.to_string()))?;
    }
    write_atomically(&file, text.as_bytes()).map_err(|e| cloud::CloudError::provider(e))
}

fn decode_base64(base64: &str) -> Result<Vec<u8>, cloud::CloudError> {
    BASE64.decode(base64).map_err(|_| cloud::CloudError::provider("That file's bytes couldn't be read."))
}

/// The provider client for one account: the real Box client, or the
/// in-memory mock (dev/QA only — the file layer, conflict dialog and offline
/// behaviour without network or real accounts).
fn cloud_provider(
    app: &AppHandle,
    mock: &cloud::MockProvider,
    provider: &str,
    account_id: &str,
) -> Result<Box<dyn cloud::CloudProvider>, cloud::CloudError> {
    match provider {
        cloud::PROVIDER_MOCK => Ok(Box::new(mock.clone())),
        cloud::PROVIDER_BOX => {
            let accounts = load_cloud_registry(app);
            let account =
                accounts.iter().find(|a| a.provider == cloud::PROVIDER_BOX && a.id == account_id).ok_or_else(|| {
                    cloud::CloudError::NotAuthenticated { message: "That Box account isn't connected.".into() }
                })?;
            Ok(Box::new(cloud_box::BoxClient::from_account(&account.id, &account.login, &account.name)?))
        }
        _ => Err(cloud::CloudError::provider("Unknown cloud provider.")),
    }
}

/// What the Settings → Connected Storage page shows: the accounts, and
/// whether Box has credentials saved (BYO) or a broker to use. Booleans
/// only — no secrets cross the bridge, ever.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudStatus {
    accounts: Vec<cloud::CloudAccount>,
    box_has_credentials: bool,
    box_has_broker: bool,
}

#[tauri::command]
fn cloud_status(app: AppHandle) -> CloudStatus {
    CloudStatus {
        accounts: load_cloud_registry(&app),
        box_has_credentials: matches!(cloud::load_byo_credentials("box"), Ok(Some(_))),
        box_has_broker: cloud_box::BOX_BROKER_URL.is_some(),
    }
}

/// Saves the user's own Box app credentials (client id + secret) to the OS
/// keychain. They are validated at connect time, not here — Box is the one
/// that can say whether they work.
#[tauri::command]
fn cloud_save_box_credentials(client_id: String, client_secret: String) -> Result<(), cloud::CloudError> {
    let client_id = client_id.trim().to_string();
    let client_secret = client_secret.trim().to_string();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err(cloud::CloudError::provider("A client ID and a client secret are both needed."));
    }
    if client_id == cloud_box::BOX_CLIENT_ID_PLACEHOLDER {
        return Err(cloud::CloudError::provider("That is the placeholder, not a real client ID."));
    }
    cloud::save_byo_credentials("box", &cloud::ByoCredentials { client_id, client_secret })
}

/// The Box connect flow (loopback + system browser + immediate exchange).
/// Records the account in the registry on success.
#[tauri::command]
async fn cloud_connect_box(app: AppHandle) -> Result<cloud::CloudAccount, cloud::CloudError> {
    let account = cloud_box::connect_box().await?;
    let mut accounts = load_cloud_registry(&app);
    accounts.retain(|a| !(a.provider == account.provider && a.id == account.id));
    accounts.push(account.clone());
    save_cloud_registry(&app, &accounts)?;
    Ok(account)
}

/// Disconnect: revokes server-side AND deletes the keychain entry, then
/// drops the account from the registry. The open document and its cache
/// stay; the next save fails with a clear error and the local-copy escape
/// hatch.
#[tauri::command]
async fn cloud_disconnect(
    app: AppHandle,
    mock: tauri::State<'_, cloud::MockProvider>,
    provider: String,
    account_id: String,
) -> Result<(), cloud::CloudError> {
    let client = cloud_provider(&app, &mock, &provider, &account_id)?;
    client.revoke().await?;
    let mut accounts = load_cloud_registry(&app);
    accounts.retain(|a| !(a.provider == provider && a.id == account_id));
    save_cloud_registry(&app, &accounts)?;
    Ok(())
}

#[tauri::command]
async fn cloud_list(
    app: AppHandle,
    mock: tauri::State<'_, cloud::MockProvider>,
    provider: String,
    account_id: String,
    folder_id: String,
) -> Result<Vec<cloud::RemoteEntry>, cloud::CloudError> {
    cloud_provider(&app, &mock, &provider, &account_id)?.list(&folder_id).await
}

/// Downloads a remote file AND writes the local cache copy (the app-data
/// dir, keyed by provider + file id) the open document edits from.
#[tauri::command]
async fn cloud_download(
    app: AppHandle,
    mock: tauri::State<'_, cloud::MockProvider>,
    provider: String,
    account_id: String,
    file_id: String,
) -> Result<cloud::RemoteDownload, cloud::CloudError> {
    let downloaded = cloud_provider(&app, &mock, &provider, &account_id)?.download(&file_id).await?;
    let bytes = decode_base64(&downloaded.base64)?;
    cloud::write_cache(&app, &provider, &file_id, &downloaded.name, &bytes)?;
    Ok(downloaded)
}

/// The cache copy of a remote file, for opening while offline. The version
/// is unknown from the cache alone — the in-memory handle keeps the version
/// from the original download, and saving while offline is refused anyway.
#[tauri::command]
fn cloud_read_cache(
    app: AppHandle,
    provider: String,
    file_id: String,
    name: String,
) -> Result<cloud::RemoteDownload, cloud::CloudError> {
    let bytes = cloud::read_cache(&app, &provider, &file_id, &name).ok_or_else(|| cloud::CloudError::NotFound {
        message: "No saved copy of that file is on this computer.".into(),
    })?;
    Ok(cloud::RemoteDownload { base64: BASE64.encode(&bytes), name, version: None, sha1: None, modified_at: None })
}

#[tauri::command]
async fn cloud_upload(
    app: AppHandle,
    mock: tauri::State<'_, cloud::MockProvider>,
    provider: String,
    account_id: String,
    file_id: String,
    name: String,
    base64: String,
    expected_version: Option<String>,
) -> Result<cloud::RemoteVersion, cloud::CloudError> {
    let bytes = decode_base64(&base64)?;
    let saved = cloud_provider(&app, &mock, &provider, &account_id)?
        .upload_version(&file_id, &bytes, expected_version.as_deref())
        .await?;
    // The cache now holds what was just saved.
    cloud::write_cache(&app, &provider, &file_id, &name, &bytes)?;
    Ok(saved)
}

#[tauri::command]
async fn cloud_upload_new(
    mock: tauri::State<'_, cloud::MockProvider>,
    app: AppHandle,
    provider: String,
    account_id: String,
    folder_id: String,
    name: String,
    base64: String,
) -> Result<cloud::RemoteEntry, cloud::CloudError> {
    let bytes = decode_base64(&base64)?;
    cloud_provider(&app, &mock, &provider, &account_id)?.upload_new(&folder_id, &name, &bytes).await
}

#[tauri::command]
async fn cloud_create_folder(
    app: AppHandle,
    mock: tauri::State<'_, cloud::MockProvider>,
    provider: String,
    account_id: String,
    parent_id: String,
    name: String,
) -> Result<cloud::RemoteEntry, cloud::CloudError> {
    cloud_provider(&app, &mock, &provider, &account_id)?.create_folder(&parent_id, &name).await
}

#[tauri::command]
async fn cloud_move(
    app: AppHandle,
    mock: tauri::State<'_, cloud::MockProvider>,
    provider: String,
    account_id: String,
    file_id: String,
    new_parent_id: String,
    is_folder: bool,
) -> Result<cloud::RemoteEntry, cloud::CloudError> {
    cloud_provider(&app, &mock, &provider, &account_id)?.move_item(&file_id, &new_parent_id, is_folder).await
}

#[tauri::command]
async fn cloud_metadata(
    app: AppHandle,
    mock: tauri::State<'_, cloud::MockProvider>,
    provider: String,
    account_id: String,
    file_id: String,
) -> Result<cloud::RemoteEntry, cloud::CloudError> {
    cloud_provider(&app, &mock, &provider, &account_id)?.get_metadata(&file_id).await
}

#[tauri::command]
async fn cloud_revisions(
    app: AppHandle,
    mock: tauri::State<'_, cloud::MockProvider>,
    provider: String,
    account_id: String,
    file_id: String,
) -> Result<Vec<cloud::RemoteVersion>, cloud::CloudError> {
    cloud_provider(&app, &mock, &provider, &account_id)?.list_revisions(&file_id).await
}

/// Dev/QA only: flips the mock provider offline (every operation fails as
/// if the network were gone) and back.
#[tauri::command]
fn cloud_mock_set_offline(mock: tauri::State<'_, cloud::MockProvider>, offline: bool) {
    mock.set_offline(offline);
}

/// Dev/QA only: empties the mock provider back to just the root folder.
#[tauri::command]
fn cloud_mock_reset(mock: tauri::State<'_, cloud::MockProvider>) {
    mock.reset();
}

/// Opens a URL in the system browser. Only provider authorize hosts are
/// allowed (see cloud.rs) — the page can never open an arbitrary URL.
#[tauri::command]
fn open_url(url: String) -> Result<(), cloud::CloudError> {
    cloud::open_browser_url(&url)
}

// ── macOS ────────────────────────────────────────────────────────────────
// The functions in this section are macOS-only (Objective-C via objc2). Each
// command keeps a non-macOS twin below it with the same signature so the page
// (src/native.ts) can call it on Linux too.

/// Hands Titer's recent projects (newest first) to macOS, which lists them in the
/// Dock icon's Open Recent menu. The system list is rebuilt to match File ▸ Open Recent.
#[cfg(target_os = "macos")]
#[tauri::command]
fn set_recent_documents(app: AppHandle, paths: Vec<String>) {
    let _ = app.run_on_main_thread(move || unsafe {
        let controller: *mut AnyObject =
            objc2::msg_send![objc2::class!(NSDocumentController), sharedDocumentController];
        let _: () = objc2::msg_send![controller, clearRecentDocuments: std::ptr::null_mut::<AnyObject>()];
        for path in paths.iter().rev() {
            let Ok(path) = std::ffi::CString::new(path.as_str()) else { continue };
            let text: *mut AnyObject = objc2::msg_send![objc2::class!(NSString), stringWithUTF8String: path.as_ptr()];
            let url: *mut AnyObject = objc2::msg_send![objc2::class!(NSURL), fileURLWithPath: text];
            let _: () = objc2::msg_send![controller, noteNewRecentDocumentURL: url];
        }
    });
}

/// The accent color chosen in System Settings ▸ Appearance, as `#RRGGBB`: what Titer
/// highlights with (selections, focus, buttons), as every Mac app does.
#[cfg(target_os = "macos")]
#[tauri::command]
fn accent_color() -> Option<String> {
    unsafe {
        let color: *mut AnyObject = objc2::msg_send![objc2::class!(NSColor), controlAccentColor];
        let space: *mut AnyObject = objc2::msg_send![objc2::class!(NSColorSpace), sRGBColorSpace];
        let rgb: *mut AnyObject = objc2::msg_send![color.as_ref()?, colorUsingColorSpace: space];
        let rgb = rgb.as_ref()?;
        let channel = |c: f64| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
        let (r, g, b): (f64, f64, f64) = (
            objc2::msg_send![rgb, redComponent],
            objc2::msg_send![rgb, greenComponent],
            objc2::msg_send![rgb, blueComponent],
        );
        Some(format!("#{:02X}{:02X}{:02X}", channel(r), channel(g), channel(b)))
    }
}

/// macOS's own spinning wheel over a project window while an analysis runs, centered
/// `at` (x, y in points from the window's top left); `None` takes it away.
/// (Upstream 1.0.9; macOS-only — the Linux twin below is a no-op, like accent_color.)
#[cfg(target_os = "macos")]
#[tauri::command]
fn set_spinner(window: WebviewWindow, at: Option<(f64, f64)>) {
    let _ = window.clone().run_on_main_thread(move || unsafe {
        let Ok(ns_window) = window.ns_window() else { return };
        let content: *mut AnyObject = objc2::msg_send![ns_window.cast::<AnyObject>(), contentView];
        if content.is_null() {
            return;
        }
        let views: *mut AnyObject = objc2::msg_send![content, subviews];
        let count: usize = objc2::msg_send![views, count];
        for i in 0..count {
            let view: *mut AnyObject = objc2::msg_send![views, objectAtIndex: i];
            let spinning: bool = objc2::msg_send![view, isKindOfClass: objc2::class!(NSProgressIndicator)];
            if spinning {
                let _: () = objc2::msg_send![view, removeFromSuperview];
            }
        }
        let Some((x, y)) = at else { return };
        let spinner: *mut AnyObject = objc2::msg_send![objc2::class!(NSProgressIndicator), new];
        let _: () = objc2::msg_send![spinner, setStyle: 1usize]; // NSProgressIndicatorStyleSpinning
        let _: () = objc2::msg_send![spinner, setTranslatesAutoresizingMaskIntoConstraints: false];
        let _: () = objc2::msg_send![content, addSubview: spinner];
        let _: () = objc2::msg_send![spinner, release]; // the window keeps it
        for (center, edge, offset) in [
            (objc2::sel!(centerXAnchor), objc2::sel!(leftAnchor), x),
            (objc2::sel!(centerYAnchor), objc2::sel!(topAnchor), y),
        ] {
            let center: *mut AnyObject = objc2::msg_send![spinner, performSelector: center];
            let edge: *mut AnyObject = objc2::msg_send![content, performSelector: edge];
            let placed: *mut AnyObject = objc2::msg_send![center, constraintEqualToAnchor: edge, constant: offset];
            let _: () = objc2::msg_send![placed, setActive: true];
        }
        let _: () = objc2::msg_send![spinner, startAnimation: std::ptr::null::<AnyObject>()];
    });
}

/// Titer's GitHub page, its releases, or Buy Me a Coffee, in the default
/// browser: fixed addresses, so the page can't open anything else.
#[cfg(target_os = "macos")]
#[tauri::command]
fn open_link(link: String) {
    let url = match link.as_str() {
        "github" => c"https://github.com/smitpatel316/Titer",
        "releases" => c"https://github.com/smitpatel316/Titer/releases/latest",
        "coffee" => c"https://www.buymeacoffee.com/smitpatel316",
        _ => return,
    };
    unsafe {
        let text: *mut AnyObject = objc2::msg_send![objc2::class!(NSString), stringWithUTF8String: url.as_ptr()];
        let url: *mut AnyObject = objc2::msg_send![objc2::class!(NSURL), URLWithString: text];
        let workspace: *mut AnyObject = objc2::msg_send![objc2::class!(NSWorkspace), sharedWorkspace];
        let _: bool = objc2::msg_send![workspace, openURL: url];
    }
}

/// Quitting (Titer ▸ Quit, the Dock, the app switcher, logout) asks the app delegate
/// `applicationShouldTerminate:`, which tao doesn't answer, so Titer would quit
/// without asking to save. This answers "not now" and closes the project windows
/// instead: each asks about its unsaved changes, and once the last one is closed
/// Titer ends (see `main`).
fn ask_before_quitting(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    ask_before_quitting_macos(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Quitting (Titer ▸ Quit, the Dock, the app switcher, logout) asks the app delegate
/// `applicationShouldTerminate:`, which tao doesn't answer, so Titer would quit
/// without asking to save. This answers "not now" and closes the project windows
/// instead: each asks about its unsaved changes, and once the last one is closed
/// Titer ends (see `main`).
#[cfg(target_os = "macos")]
fn ask_before_quitting_macos(app: &AppHandle) {
    static APP: OnceLock<AppHandle> = OnceLock::new();
    extern "C-unwind" fn should_terminate(_: &AnyObject, _: Sel, _: &AnyObject) -> usize {
        let Some(app) = APP.get() else { return 1 };
        save_session(app);
        let windows: Vec<_> = app.webview_windows().into_values().filter(|w| is_project(w.label())).collect();
        if windows.is_empty() {
            return 1; // NSTerminateNow
        }
        app.state::<Projects>().0.lock().unwrap().quitting = true;
        for window in windows {
            let _ = window.close();
        }
        0 // NSTerminateCancel
    }
    let _ = APP.set(app.clone());
    unsafe {
        let ns_app: *mut AnyObject = objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = objc2::msg_send![ns_app, delegate];
        let Some(delegate) = delegate.as_ref() else { return };
        let imp: Imp = std::mem::transmute(should_terminate as extern "C-unwind" fn(_, _, _) -> _);
        let class = delegate.class() as *const AnyClass as *mut AnyClass;
        objc2::ffi::class_addMethod(class, objc2::sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr());
    }
}

/// macOS 27 hides menu items' pictures unless told to show them. Titer's own (a
/// palette's band, a color's swatch) are what their item says, so they stay; the
/// system's symbols (template images) keep macOS's choice. A menu of pictures alone
/// (swatches, shapes) drops the column kept for check marks, so it is no wider than
/// they are. Set as each item is added, before any menu shows.
fn show_menu_pictures() {
    #[cfg(target_os = "macos")]
    show_menu_pictures_macos();
}

/// macOS 27 hides menu items' pictures unless told to show them. Titer's own (a
/// palette's band, a color's swatch) are what their item says, so they stay; the
/// system's symbols (template images) keep macOS's choice. A menu of pictures alone
/// (swatches, shapes) drops the column kept for check marks, so it is no wider than
/// they are. Set as each item is added, before any menu shows.
#[cfg(target_os = "macos")]
fn show_menu_pictures_macos() {
    extern "C-unwind" fn item_added(_: &AnyObject, _: Sel, note: &AnyObject) {
        unsafe {
            let menu: *mut AnyObject = objc2::msg_send![note, object];
            let Some(menu) = menu.as_ref() else { return };
            let count: isize = objc2::msg_send![menu, numberOfItems];
            let mut pictures_only = true;
            for i in 0..count {
                let item: *mut AnyObject = objc2::msg_send![menu, itemAtIndex: i];
                let separator: bool = objc2::msg_send![item, isSeparatorItem];
                if separator {
                    continue;
                }
                let title: *mut AnyObject = objc2::msg_send![item, title];
                let title_length: usize = objc2::msg_send![title, length];
                let image: *mut AnyObject = objc2::msg_send![item, image];
                pictures_only &= title_length == 0 && !image.is_null();
                let Some(image) = image.as_ref() else { continue };
                let template: bool = objc2::msg_send![image, isTemplate];
                let can: bool = objc2::msg_send![item, respondsToSelector: objc2::sel!(setPreferredImageVisibility:)];
                if !template && can {
                    // NSMenuItemImageVisibility.visible
                    let _: () = objc2::msg_send![item, setPreferredImageVisibility: 1isize];
                }
            }
            if pictures_only {
                let _: () = objc2::msg_send![menu, setShowsStateColumn: false];
            }
        }
    }
    unsafe {
        let ns_app: *mut AnyObject = objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = objc2::msg_send![ns_app, delegate];
        let Some(delegate) = delegate.as_ref() else { return };
        let imp: Imp = std::mem::transmute(item_added as extern "C-unwind" fn(_, _, _));
        let class = delegate.class() as *const AnyClass as *mut AnyClass;
        objc2::ffi::class_addMethod(class, objc2::sel!(titerMenuItemAdded:), imp, c"v@:@".as_ptr());
        let name: *mut AnyObject =
            objc2::msg_send![objc2::class!(NSString), stringWithUTF8String: c"NSMenuDidAddItemNotification".as_ptr()];
        let center: *mut AnyObject = objc2::msg_send![objc2::class!(NSNotificationCenter), defaultCenter];
        let _: () = objc2::msg_send![center, addObserver: delegate, selector: objc2::sel!(titerMenuItemAdded:), name: name, object: std::ptr::null_mut::<AnyObject>()];
    }
}

// ── Non-macOS (Linux dev/test) ───────────────────────────────────────────
// Same command signatures as the macOS versions above, with Linux behaviour:
// no Dock recent-documents, no system accent color (the page falls back to its
// own default when accent_color is null), links via xdg-open. The Mac code is
// untouched — these only exist where target_os != macos.

/// Linux: no recent-documents menu to update.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn set_recent_documents(_app: AppHandle, _paths: Vec<String>) {}

/// Linux: no system accent color; the page uses its default.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn accent_color() -> Option<String> {
    None
}

/// Linux: the same fixed addresses as on macOS, opened with xdg-open.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn open_link(link: String) {
    let url = match link.as_str() {
        "github" => "https://github.com/smitpatel316/Titer",
        "releases" => "https://github.com/smitpatel316/Titer/releases/latest",
        "coffee" => "https://www.buymeacoffee.com/smitpatel316",
        _ => return,
    };
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

/// Linux: no spinning wheel; the page never shows one here.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn set_spinner(_window: WebviewWindow, _at: Option<(f64, f64)>) {}

// ── R engine ─────────────────────────────────────────────────────────────

/// An R result: a named numeric vector (non-finite values as null), or R's error.
type RResult = Result<HashMap<String, Option<f64>>, String>;

/// The app's one R engine runs in the hidden "engine" window (src/engine.ts).
/// Project windows send it R code (`eval_r`); each request waits here, by id, for
/// the engine's `r_result`. A request made before the engine listens, or lost when
/// its page reloads (Tauri reloads a page whose process macOS ended), is sent
/// again when the engine says it is ready.
#[derive(Default)]
struct REngine(Mutex<Requests>);

#[derive(Default)]
struct Requests {
    ready: bool,
    next_id: u64,
    /// Waiting requests, by id: the R code, the label of the window that
    /// asked for it, and the sender its `eval_r` waits on. The owner is
    /// what lets a cancel drop only the cancelling window's requests
    /// (FL-F14) instead of every window's.
    waiting: HashMap<u64, (String, String, Sender<RResult>)>,
}

#[tauri::command]
async fn eval_r(app: AppHandle, window: WebviewWindow, engine: State<'_, REngine>, code: String) -> RResult {
    let (sender, mut receiver) = channel(1);
    {
        let mut requests = engine.0.lock().unwrap();
        requests.next_id += 1;
        let id = requests.next_id;
        if requests.ready {
            let _ = app.emit_to("engine", "r-eval", (id, &code));
        }
        requests.waiting.insert(id, (code, window.label().to_string(), sender));
    }
    receiver.recv().await.unwrap_or_else(|| Err("R stopped unexpectedly.".into()))
}

#[tauri::command]
fn r_result(engine: State<REngine>, id: u64, values: Option<HashMap<String, Option<f64>>>, error: Option<String>) {
    if let Some((_, _, sender)) = engine.0.lock().unwrap().waiting.remove(&id) {
        let _ = sender.try_send(values.ok_or_else(|| error.unwrap_or_default()));
    }
}

/// Stop this window's own R work in the engine, from a project window (its
/// watchdog fired, or the user hit Cancel). Only the calling window's
/// waiting requests are dropped (FL-F14): clearing every window's used to
/// kill another window's in-flight install with "R stopped unexpectedly."
/// The engine is told which requests were dropped, so it can dequeue them
/// without touching R — and interrupts R only if the evaluation now running
/// is one of the dropped ones. From the engine window itself (its
/// stuck-engine recovery) the old behaviour stands: every waiting request
/// is dropped and the engine is told to interrupt, before the reload.
#[tauri::command]
fn cancel_r(app: AppHandle, window: WebviewWindow, engine: State<'_, REngine>) {
    let caller = window.label().to_string();
    if caller == "engine" {
        let mut requests = engine.0.lock().unwrap();
        requests.waiting.clear();
        // The engine is about to reload, so it is not ready for direct
        // sends any more (R3-03): a request arriving during the reload
        // must only be queued, and re-sent once by `r_ready` — with the
        // stale `true` it was emitted straight away and then re-sent,
        // reaching the engine twice.
        requests.ready = false;
        let _ = app.emit_to("engine", "r-interrupt", ());
        return;
    }
    let dropped: Vec<u64> = {
        let mut requests = engine.0.lock().unwrap();
        let mut dropped = Vec::new();
        requests.waiting.retain(|id, (_, owner, _)| {
            if *owner == caller {
                dropped.push(*id);
                false
            } else {
                true
            }
        });
        dropped
    };
    if !dropped.is_empty() {
        let _ = app.emit_to("engine", "r-cancel", dropped);
    }
}

/// The engine window (re)started and is about to listen for requests: it is
/// not ready for direct sends until it says so (`r_ready`). Clears the flag
/// `cancel_r` already clears on the reload it triggers — this one covers a
/// reload the shell never saw coming (Tauri reloading a page whose process
/// macOS ended), so a request arriving between the new page's listeners
/// attaching and `r_ready` is queued once and re-sent once, never twice
/// (R3-03).
#[tauri::command]
fn r_starting(engine: State<REngine>) {
    engine.0.lock().unwrap().ready = false;
}

#[tauri::command]
fn r_ready(app: AppHandle, engine: State<REngine>) {
    let mut requests = engine.0.lock().unwrap();
    requests.ready = true;
    // The engine window (re)started, so its R is fresh with an empty VFS:
    // every project window's installed-package state is void with it
    // (R3-02). Broadcast before re-sending the waiting requests, so no
    // window re-runs an analysis against the stale "ready" state and fails
    // with `there is no package called '…'`. Harmless on the first boot,
    // when no window has installed anything yet.
    let _ = app.emit("r-reset", ());
    for (id, (code, _, _)) in &requests.waiting {
        let _ = app.emit_to("engine", "r-eval", (id, code));
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            // All project windows share one remembered frame, which the first one opens in.
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["engine"])
                .map_label(|label| if is_project(label) { "project" } else { label })
                .build(),
        )
        .manage(Projects::default())
        .manage(REngine::default())
        .manage(cloud::MockProvider::new())
        .setup(|app| {
            ask_before_quitting(app.handle());
            show_menu_pictures();
            restore_session(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_opening,
            set_document,
            open_projects,
            open_sample,
            new_project,
            choose_project,
            choose_prism_file,
            cancel_quit,
            quit_app,
            updater::download_update,
            updater::apply_update,
            read_text,
            read_prism_text,
            read_prism_bytes,
            write_file,
            read_my_palettes,
            write_my_palettes,
            set_recent_documents,
            accent_color,
            open_link,
            set_spinner,
            open_url,
            cloud_status,
            cloud_save_box_credentials,
            cloud_connect_box,
            cloud_disconnect,
            cloud_list,
            cloud_download,
            cloud_read_cache,
            cloud_upload,
            cloud_upload_new,
            cloud_create_folder,
            cloud_move,
            cloud_metadata,
            cloud_revisions,
            cloud_mock_set_offline,
            cloud_mock_reset,
            eval_r,
            r_result,
            r_ready,
            r_starting,
            cancel_r
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Titer")
        .run(|app, event| match event {
            // Files opened from the Finder: a double-click, Open With, a drop on the Dock icon.
            // macOS only: these RunEvent variants don't exist on Linux.
            #[cfg(target_os = "macos")]
            RunEvent::Opened { urls } => {
                let app = app.clone();
                let paths: Vec<_> = urls.iter().filter_map(|url| url.to_file_path().ok()).collect();
                tauri::async_runtime::spawn(async move {
                    for path in paths {
                        let into = front_window(&app).map(|w| w.label().to_string());
                        let path = path.to_string_lossy().into_owned();
                        let _ = open(&app, into, Opening { path, untitled: false });
                    }
                });
            }
            RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. } if is_project(&label) => {
                let state = app.state::<Projects>();
                let mut projects = state.0.lock().unwrap();
                projects.documents.remove(&label);
                projects.openings.remove(&label);
                let quitting = projects.quitting;
                drop(projects);
                if !app.webview_windows().keys().any(|l| is_project(l) && *l != label) {
                    if quitting {
                        app.exit(0);
                    } else {
                        // Titer stays open: the engine window sets the menu bar for no window.
                        let _ = app.emit_to("engine", "no-windows", ());
                    }
                }
            }
            // A click on the Dock icon while no window is open: a new project.
            // macOS only: this RunEvent variant doesn't exist on Linux.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows: false, .. } => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = new_window(&app, None);
                });
            }
            _ => {}
        });
}

// ── Tests ────────────────────────────────────────────────────────────────
// Linux-first: these run under `cargo test` on the Hatch Linux VM (no Mac
// needed). They cover the Prism import gate the GUI picker feeds.
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("testdata").join(name)
    }

    #[test]
    fn read_prism_text_reads_a_pzfx_fixture() {
        let path = fixture("column.pzfx");
        let text = read_prism_text(path.to_string_lossy().into_owned()).expect("column.pzfx should read");
        assert!(text.contains("GraphPadPrismFile"), "fixture should be a Prism file");
        assert!(text.contains("Data 1"), "fixture should contain the Data 1 table");
    }

    #[test]
    fn read_prism_text_rejects_other_extensions() {
        for bad in ["column.txt", "column.hlx", "column.pzfx.bak", "column"] {
            let err = read_prism_text(fixture(bad).to_string_lossy().into_owned())
                .expect_err(&format!("{bad} should be rejected"));
            assert!(err.contains("can't access"), "error should name the refusal: {err}");
        }
    }

    #[test]
    fn read_prism_text_accepts_uppercase_pzfx() {
        // check_extension lowercases, so .PZFX is a Prism file too.
        assert!(check_extension("/tmp/x.PZFX", &["pzfx"]).is_ok());
    }

    #[test]
    fn read_prism_text_reports_a_missing_file() {
        let err = read_prism_text(fixture("no-such-file.pzfx").to_string_lossy().into_owned())
            .expect_err("missing file should error");
        assert!(!err.contains("can't access"), "missing file is an I/O error, not a refusal: {err}");
    }
}
