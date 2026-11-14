// Cloud storage — the shared layer (v2 backlog item 75, Box first).
// See docs/cloud-storage-box.md for the design, the Box PKCE verdict, and
// what is still pending (build verification, manual provider checks).
//
// Rules this module enforces:
// - All provider HTTP happens here, in Rust, never in the webview: the CSP
//   stays `default-src 'self'` and the frontend only ever sees auth *state*
//   (which account, which scopes), never raw tokens.
// - Tokens live in the OS keychain (one entry per provider account), never in
//   a file, a log, or the webview. Nothing in this module logs a token, a
//   code, or a verifier — `TokenSet` has a redacted `Debug` for that reason.
// - A save is conditional on the version seen at open/last-save. A version
//   mismatch is a `Conflict`, never a silent overwrite; autosave must never
//   take the overwrite path on its own (there is no autosave that does).
// - Offline never discards the in-memory document: a failed upload keeps the
//   document and its local cache copy, and the save can be retried or saved
//   as a local copy instead.

use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    sync::mpsc,
    time::Duration,
};

/// The provider ids the file layer knows. Only `box` is wired to a real
/// provider in this slice; `mock` is the in-memory fake the file layer,
/// conflict dialog and offline behaviour are tested against without network
/// or real accounts. Dropbox / OneDrive / Drive come later, one per slice.
pub const PROVIDER_BOX: &str = "box";
pub const PROVIDER_MOCK: &str = "mock";

/// Keychain service for every cloud entry (tokens and BYO credentials alike).
const KEYCHAIN_SERVICE: &str = "net.smitpatel.helix.cloud";

/// What a cloud failure is, in the frontend's terms. Serialized to the page
/// as `{ kind, ... }`; the page never sees a token, a status code, or a
/// provider's raw error body. `Conflict` carries the remote version so the
/// three-choice dialog can show both sides.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CloudError {
    /// No credentials are configured for this provider (Box: no BYO
    /// credentials and no broker — see cloud_box.rs). The connect UI shows
    /// the message and the choices; this is not a crash.
    NotConfigured { message: String },
    /// The refresh token is revoked/expired, or there is no token at all.
    /// Signed-out state: re-connect prompt, document intact.
    NotAuthenticated { message: String },
    /// The remote file changed since open/last-save. Never silently
    /// overwritten: the dialog offers Save as a copy / Reload / Overwrite.
    Conflict {
        remote_version: String,
        remote_modified_at: Option<String>,
        remote_sha1: Option<String>,
        message: String,
    },
    /// The network is gone (or the provider is unreachable). The document
    /// and its cache copy are intact; the save can be retried, or saved as
    /// a local copy. Never discard the document because the network is gone.
    Offline { message: String },
    /// The remote file/folder is no longer there (deleted/moved).
    NotFound { message: String },
    /// Over a provider's direct-upload cap (Box: 50 MB). `.hlx` / `.prism`
    /// files are kilobytes, so this never binds in practice.
    TooLarge { message: String },
    /// Anything else from the provider, without its body (bodies can carry
    /// tokens in error text; the message stays generic).
    Provider { message: String },
    /// The OS keychain refused (locked, unavailable, no Secret Service on
    /// Linux). Tokens are never fallen back to a file.
    Keychain { message: String },
    /// The user cancelled the connect flow (closed the browser, timed out).
    Cancelled { message: String },
}

impl CloudError {
    pub fn provider(message: impl Into<String>) -> Self {
        CloudError::Provider { message: message.into() }
    }
    pub fn offline(message: impl Into<String>) -> Self {
        CloudError::Offline { message: message.into() }
    }
    /// A reqwest failure, sorted into offline vs provider. A connect error
    /// or a timeout is the network being gone; anything else is the
    /// provider's fault. Never includes the error's text (it can echo URLs
    /// with query strings).
    pub fn from_http(err: reqwest::Error) -> Self {
        if err.is_connect() || err.is_timeout() {
            CloudError::offline("Couldn't reach the cloud provider. Check the network and try again.")
        } else {
            CloudError::provider("The cloud provider returned an error.")
        }
    }
    /// An HTTP status, sorted the same way. 401 is always "signed out";
    /// 404 is "no longer there"; 409/412 is a conflict (the caller refetches
    /// metadata for the remote version first); 429/5xx are provider errors.
    pub fn from_status(status: reqwest::StatusCode) -> Self {
        use reqwest::StatusCode;
        match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => CloudError::NotAuthenticated {
                message: "Signed out of the cloud account. Reconnect to keep working on remote files.".into(),
            },
            StatusCode::NOT_FOUND => CloudError::NotFound {
                message: "That file is no longer in the cloud account. It may have been moved or deleted.".into(),
            },
            StatusCode::CONFLICT | StatusCode::PRECONDITION_FAILED => CloudError::Conflict {
                remote_version: String::new(),
                remote_modified_at: None,
                remote_sha1: None,
                message: "The file changed in the cloud since it was opened.".into(),
            },
            _ => CloudError::provider("The cloud provider returned an error."),
        }
    }
}

/// One file or folder in a provider account, as the remote picker and the
/// file layer see it. `version` is the provider's change token (Box
/// `version_number`, Dropbox `rev`, Drive `revisionId`, OneDrive `eTag`);
/// a save is conditional on it matching what open/last-save saw.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub id: String,
    /// "file" or "folder".
    pub kind: String,
    pub name: String,
    /// Display path, provider-rooted ("/Research/Data.hlx"), for recents.
    pub path: String,
    pub size: Option<u64>,
    pub modified_at: Option<String>,
    /// The change token; `None` for folders (they are never saved).
    pub version: Option<String>,
    pub sha1: Option<String>,
    /// The parent folder's id — for "Save as a copy" next to the original.
    /// `None` when the provider didn't report it (list entries); metadata
    /// calls fill it in.
    pub parent_id: Option<String>,
}

impl RemoteEntry {
    pub fn file(id: impl Into<String>, name: impl Into<String>, path: impl Into<String>) -> Self {
        RemoteEntry {
            id: id.into(),
            kind: "file".into(),
            name: name.into(),
            path: path.into(),
            size: None,
            modified_at: None,
            version: None,
            sha1: None,
            parent_id: None,
        }
    }
    pub fn folder(id: impl Into<String>, name: impl Into<String>, path: impl Into<String>) -> Self {
        RemoteEntry { kind: "folder".into(), ..RemoteEntry::file(id, name, path) }
    }
}

/// One revision of a remote file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteVersion {
    pub version: String,
    pub sha1: Option<String>,
    pub modified_at: Option<String>,
}

/// A downloaded remote file: its bytes (base64 over the bridge, like
/// `read_prism_bytes`), and the version the next save is conditional on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDownload {
    pub base64: String,
    pub name: String,
    pub version: Option<String>,
    pub sha1: Option<String>,
    pub modified_at: Option<String>,
}

/// A connected account, as the frontend sees it: identity only, never tokens.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccount {
    pub provider: String,
    pub id: String,
    pub login: String,
    pub name: String,
}

/// One provider behind one interface. The frontend never sees provider
/// differences — it sees files. Every method takes `&self` and is
/// retry-safe: a 401 refreshes once (inside the provider) and retries.
#[async_trait]
pub trait CloudProvider: Send + Sync {
    fn provider_id(&self) -> &'static str;
    /// The account this client acts as (login + display name).
    fn account(&self) -> &CloudAccount;
    /// The entries of a folder (`"0"` is the Box root). `.hlx` / `.prism`
    /// filtering happens in the picker, not here.
    async fn list(&self, folder_id: &str) -> Result<Vec<RemoteEntry>, CloudError>;
    /// The file's bytes, and the version the next save is conditional on.
    async fn download(&self, file_id: &str) -> Result<RemoteDownload, CloudError>;
    /// A new file in `folder_id`. Direct upload; over the provider's cap
    /// (`TooLarge`) the caller must not silently split it — upload sessions
    /// are a later slice, and `.hlx` / `.prism` never approach the cap.
    async fn upload_new(&self, folder_id: &str, name: &str, bytes: &[u8]) -> Result<RemoteEntry, CloudError>;
    /// A new version of `file_id`, conditional on `expected_version` when
    /// given: `None` means "overwrite anyway" (the conflict dialog's
    /// explicit third choice only — never autosave, never the default path).
    /// A mismatch is `Conflict`, with the remote version filled in.
    async fn upload_version(
        &self,
        file_id: &str,
        bytes: &[u8],
        expected_version: Option<&str>,
    ) -> Result<RemoteVersion, CloudError>;
    async fn create_folder(&self, parent_id: &str, name: &str) -> Result<RemoteEntry, CloudError>;
    /// Moves a file or a folder into `new_parent_id`.
    async fn move_item(&self, file_id: &str, new_parent_id: &str, is_folder: bool) -> Result<RemoteEntry, CloudError>;
    async fn get_metadata(&self, file_id: &str) -> Result<RemoteEntry, CloudError>;
    async fn list_revisions(&self, file_id: &str) -> Result<Vec<RemoteVersion>, CloudError>;
    /// Revokes server-side AND deletes the keychain entry (disconnect).
    async fn revoke(&self) -> Result<(), CloudError>;
}

// ── Tokens in the OS keychain ─────────────────────────────────────────────
// One entry per provider account; the frontend never sees these values.

/// A token pair. No derived `Debug`: the derived one would print the tokens
/// into any log that formats the struct.
#[derive(Clone, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix seconds when the access token expires (0 = unknown/expired).
    pub expires_at_unix: i64,
    pub scope: String,
}

impl std::fmt::Debug for TokenSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenSet")
            .field("access_token", &"<redacted>")
            .field("refresh_token", &self.refresh_token.as_ref().map(|_| "<redacted>"))
            .field("expires_at_unix", &self.expires_at_unix)
            .field("scope", &self.scope)
            .finish()
    }
}

fn keychain_entry(account: &str) -> Result<keyring::Entry, CloudError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|e| CloudError::Keychain { message: format!("Couldn't open the OS keychain: {e}") })
}

fn keychain_error(e: keyring::Error) -> CloudError {
    match e {
        keyring::Error::NoEntry => {
            CloudError::NotAuthenticated { message: "No saved sign-in for this cloud account.".into() }
        }
        _ => CloudError::Keychain { message: format!("The OS keychain refused: {e}") },
    }
}

/// The keychain account name for a provider account's tokens.
pub fn token_account(provider: &str, account_id: &str) -> String {
    format!("{provider}:{account_id}")
}

/// The keychain account name for a provider's BYO OAuth credentials
/// (client id + secret the user pasted in Settings — Box's flow needs a
/// client secret, and it is never shipped in the app).
pub fn credentials_account(provider: &str) -> String {
    format!("{provider}:credentials")
}

pub fn save_tokens(provider: &str, account_id: &str, tokens: &TokenSet) -> Result<(), CloudError> {
    let json =
        serde_json::to_string(tokens).map_err(|e| CloudError::provider(format!("Couldn't store tokens: {e}")))?;
    keychain_entry(&token_account(provider, account_id))
        .and_then(|entry| entry.set_password(&json).map_err(keychain_error))
}

pub fn load_tokens(provider: &str, account_id: &str) -> Result<TokenSet, CloudError> {
    let json = keychain_entry(&token_account(provider, account_id))
        .and_then(|entry| entry.get_password().map_err(keychain_error))?;
    serde_json::from_str(&json).map_err(|_| CloudError::NotAuthenticated {
        message: "The saved sign-in is damaged. Reconnect the cloud account.".into(),
    })
}

pub fn delete_tokens(provider: &str, account_id: &str) -> Result<(), CloudError> {
    match keychain_entry(&token_account(provider, account_id))
        .and_then(|entry| entry.delete_credential().map_err(keychain_error))
    {
        Err(CloudError::NotAuthenticated { .. }) => Ok(()), // already gone
        other => other,
    }
}

/// BYO OAuth credentials, as stored in the keychain (JSON). The secret is
/// never logged, never put in a file, and never sent anywhere but the
/// provider's token endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ByoCredentials {
    pub client_id: String,
    pub client_secret: String,
}

pub fn save_byo_credentials(provider: &str, creds: &ByoCredentials) -> Result<(), CloudError> {
    let json =
        serde_json::to_string(creds).map_err(|e| CloudError::provider(format!("Couldn't store credentials: {e}")))?;
    keychain_entry(&credentials_account(provider)).and_then(|entry| entry.set_password(&json).map_err(keychain_error))
}

pub fn load_byo_credentials(provider: &str) -> Result<Option<ByoCredentials>, CloudError> {
    match keychain_entry(&credentials_account(provider)).and_then(|entry| entry.get_password().map_err(keychain_error))
    {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|_| CloudError::provider("The saved Box credentials are damaged. Re-enter them in Settings.")),
        Err(CloudError::NotAuthenticated { .. }) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn delete_byo_credentials(provider: &str) -> Result<(), CloudError> {
    match keychain_entry(&credentials_account(provider))
        .and_then(|entry| entry.delete_credential().map_err(keychain_error))
    {
        Err(CloudError::NotAuthenticated { .. }) => Ok(()),
        other => other,
    }
}

/// Opens a URL in the SYSTEM browser, never the webview. Only provider
/// authorize hosts are allowed — the page can never open an arbitrary URL
/// through this. The OAuth authorize URLs are built by the providers
/// themselves (account.box.com etc.); anything else is refused.
const BROWSER_ALLOWLIST: &[&str] = &[
    "account.box.com",           // Box authorize
    "www.dropbox.com",           // Dropbox authorize (next slice)
    "accounts.google.com",       // Google authorize (later slice)
    "login.microsoftonline.com", // OneDrive / Graph authorize (next slice)
    "login.live.com",            // Microsoft personal-account authorize
];

fn url_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    let host = host.split(':').next()?;
    Some(host.to_ascii_lowercase())
}

pub fn open_browser_url(url: &str) -> Result<(), CloudError> {
    let host = url_host(url).ok_or_else(|| CloudError::provider("That sign-in address isn't allowed."))?;
    if !BROWSER_ALLOWLIST.contains(&host.as_str()) {
        return Err(CloudError::provider("That sign-in address isn't allowed."));
    }
    open_browser_url_allowlisted(url)
}

/// The opener itself, per platform (same shape as `open_link` in main.rs).
#[cfg(target_os = "macos")]
fn open_browser_url_allowlisted(url: &str) -> Result<(), CloudError> {
    use objc2::runtime::AnyObject;
    let Ok(text) = std::ffi::CString::new(url) else {
        return Err(CloudError::provider("That sign-in address isn't allowed."));
    };
    unsafe {
        let url_obj: *mut AnyObject = objc2::msg_send![objc2::class!(NSString), stringWithUTF8String: text.as_ptr()];
        let url_obj: *mut AnyObject = objc2::msg_send![objc2::class!(NSURL), URLWithString: url_obj];
        let workspace: *mut AnyObject = objc2::msg_send![objc2::class!(NSWorkspace), sharedWorkspace];
        let _: bool = objc2::msg_send![workspace, openURL: url_obj];
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn open_browser_url_allowlisted(url: &str) -> Result<(), CloudError> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| CloudError::provider(format!("Couldn't open the system browser: {e}")))
}

// ── PKCE + loopback OAuth (RFC 8252) ──────────────────────────────────────
// Hand-rolled on std only: one ephemeral loopback port, one request, then it
// shuts down. `tauri-plugin-oauth` does the same step; hand-rolling keeps the
// dependency list (and the audit surface) smaller, and every provider in the
// plan uses the same loopback shape. The authorize URL itself is opened in
// the SYSTEM browser, never the webview — the webview must never see
// credentials (see `open_url` in main.rs, allowlisted hosts only).

/// A fresh PKCE pair: `verifier` stays in memory (and goes to the token
/// endpoint only); `challenge` (S256) goes on the authorize URL.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn new_pkce() -> Pkce {
    let verifier: String = rand::thread_rng().sample_iter(&Alphanumeric).take(64).map(char::from).collect();
    let digest = Sha256::digest(verifier.as_bytes());
    Pkce { verifier, challenge: URL_SAFE_NO_PAD.encode(digest) }
}

/// A fresh `state` (CSRF protection on the loopback redirect).
pub fn new_state() -> String {
    rand::thread_rng().gen::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect()
}

/// Percent-encode one authorize-URL value (RFC 3986 unreserved set kept).
pub fn url_encode(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// Waits for the provider's redirect to `http://127.0.0.1:<port>/callback`
/// with `?code=…&state=…`. Validates `state`, answers the browser with a
/// "you can close this tab" page, and returns the code. The code is
/// single-use and short-lived (Box: 30 seconds), so the caller exchanges it
/// immediately. Times out (`Cancelled`) if the user never completes sign-in.
pub fn wait_for_code(port: u16, expected_state: &str, timeout: Duration) -> Result<String, CloudError> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| CloudError::provider(format!("Couldn't start the sign-in listener: {e}")))?;
    let (tx, rx) = mpsc::channel::<Result<String, CloudError>>();
    // The spawned thread must own the expected state ('static bound).
    let expected_state = expected_state.to_owned();
    std::thread::spawn(move || {
        let result = (|| -> Result<String, CloudError> {
            let (mut stream, _) =
                listener.accept().map_err(|e| CloudError::provider(format!("Sign-in listener failed: {e}")))?;
            stream
                .set_read_timeout(Some(Duration::from_secs(30)))
                .map_err(|e| CloudError::provider(format!("Sign-in listener failed: {e}")))?;
            let mut reader = BufReader::new(stream.try_clone().map_err(|e| CloudError::provider(e.to_string()))?);
            let mut request_line = String::new();
            reader
                .read_line(&mut request_line)
                .map_err(|e| CloudError::provider(format!("Couldn't read the sign-in redirect: {e}")))?;
            // Drain the headers so the browser isn't left hanging.
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if line == "\r\n" {
                            break;
                        }
                    }
                }
            }
            // GET /callback?code=…&state=… HTTP/1.1 — anything else is not our redirect.
            let path = request_line.split_whitespace().nth(1).unwrap_or("");
            let query = path.splitn(2, '?').nth(1).unwrap_or("");
            let params: HashMap<String, String> = query
                .split('&')
                .filter_map(|pair| {
                    let (k, v) = pair.split_once('=')?;
                    let decode = |s: &str| {
                        percent_encoding::percent_decode_str(&s.replace('+', " "))
                            .decode_utf8()
                            .map(|c| c.into_owned())
                            .unwrap_or_else(|_| s.to_string())
                    };
                    Some((decode(k), decode(v)))
                })
                .collect();
            let body = "<html><body><h1>Signed in to Titer</h1><p>You can close this tab.</p></body></html>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
            if let Some(error) = params.get("error") {
                return Err(CloudError::Cancelled { message: format!("Sign-in was refused ({error}).") });
            }
            match (params.get("code"), params.get("state")) {
                (Some(code), Some(state)) if state.as_str() == expected_state => Ok(code.clone()),
                (Some(_), Some(_)) => {
                    Err(CloudError::Cancelled { message: "Sign-in state didn't match. Try connecting again.".into() })
                }
                _ => {
                    Err(CloudError::Cancelled { message: "Sign-in didn't return a code. Try connecting again.".into() })
                }
            }
        })();
        let _ = tx.send(result);
    });
    rx.recv_timeout(timeout)
        .map_err(|_| CloudError::Cancelled { message: "Sign-in timed out. Try connecting again.".into() })?
}

/// An ephemeral loopback port for one sign-in (bound, read, released: the
/// listener in `wait_for_code` binds it again immediately).
pub fn ephemeral_loopback_port() -> Result<u16, CloudError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| CloudError::provider(format!("Couldn't pick a sign-in port: {e}")))?;
    Ok(listener.local_addr().map_err(|e| CloudError::provider(e.to_string()))?.port())
}

// ── Local cache ──────────────────────────────────────────────────────────
// A remote file opens from a local cache copy in the app-data dir, keyed by
// provider + file id. The cache is what keeps an open document editable
// offline; a save uploads the cache's contents (the bytes the page holds).

/// `…/cloud-cache/<provider>/<file_id>.<ext>` (ext from the remote name).
pub fn cache_path(app: &tauri::AppHandle, provider: &str, file_id: &str, name: &str) -> Option<std::path::PathBuf> {
    let ext = std::path::Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let safe_id: String = file_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    app.path().app_data_dir().ok().map(|dir| dir.join("cloud-cache").join(provider).join(format!("{safe_id}.{ext}")))
}

pub fn write_cache(
    app: &tauri::AppHandle,
    provider: &str,
    file_id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<(), CloudError> {
    let path = cache_path(app, provider, file_id, name)
        .ok_or_else(|| CloudError::provider("Couldn't find the app-data folder for the cloud cache."))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CloudError::provider(format!("Couldn't make the cloud cache: {e}")))?;
    }
    // Atomic, like local saves: a temp file renamed over the cache copy.
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        CloudError::provider(format!("Couldn't write the cloud cache: {e}"))
    })
}

pub fn read_cache(app: &tauri::AppHandle, provider: &str, file_id: &str, name: &str) -> Option<Vec<u8>> {
    cache_path(app, provider, file_id, name).and_then(|path| std::fs::read(path).ok())
}

/// SHA-1 hex, for conflict tokens where the provider reports one (Box).
pub fn sha1_hex(bytes: &[u8]) -> String {
    use sha1::Digest as _;
    let digest = sha1::Sha1::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

// ── Mock provider ────────────────────────────────────────────────────────
// The in-memory fake behind the same trait: the file layer, the conflict
// dialog and the offline behaviour are testable without network or real
// accounts. `offline` flips every operation to `Offline`, the way a dropped
// network does. Versions are counting numbers, as strings.

#[derive(Debug, Clone)]
struct MockFile {
    name: String,
    parent: String,
    bytes: Vec<u8>,
    version: u64,
    modified_at: String,
    is_folder: bool,
}

#[derive(Debug)]
struct MockInner {
    files: HashMap<String, MockFile>,
    next_id: u64,
    offline: bool,
}

/// The mock keeps its state behind a `Mutex`: the trait takes `&self`, and
/// uploads mutate, so the mutation goes through interior mutability — the
/// same shape the process-wide mock has in main.rs. The state is in an
/// `Arc`, so cloning the provider shares the files (commands clone it to
/// dispatch through the trait).
#[derive(Debug, Clone)]
pub struct MockProvider {
    inner: std::sync::Arc<std::sync::Mutex<MockInner>>,
    account: CloudAccount,
}

impl MockProvider {
    pub fn new() -> Self {
        let mut files = HashMap::new();
        files.insert(
            "0".into(),
            MockFile {
                name: String::new(),
                parent: String::new(),
                bytes: vec![],
                version: 0,
                modified_at: String::new(),
                is_folder: true,
            },
        );
        MockProvider {
            inner: std::sync::Arc::new(std::sync::Mutex::new(MockInner { files, next_id: 1, offline: false })),
            account: CloudAccount {
                provider: PROVIDER_MOCK.into(),
                id: "mock-user".into(),
                login: "mock@example.com".into(),
                name: "Mock User".into(),
            },
        }
    }

    /// Test/QA only: makes every operation fail as if the network were gone.
    pub fn set_offline(&self, offline: bool) {
        self.inner.lock().expect("mock lock").offline = offline;
    }

    /// Test/QA only: empties the mock back to just the root folder.
    pub fn reset(&self) {
        let mut inner = self.inner.lock().expect("mock lock");
        inner.files.retain(|id, _| id == "0");
        inner.next_id = 1;
        inner.offline = false;
    }

    fn check_offline(inner: &MockInner) -> Result<(), CloudError> {
        if inner.offline {
            return Err(CloudError::offline("Offline (mock provider)."));
        }
        Ok(())
    }

    fn entry_of(inner: &MockInner, id: &str) -> Result<RemoteEntry, CloudError> {
        let file = inner
            .files
            .get(id)
            .ok_or_else(|| CloudError::NotFound { message: "That file is no longer in the cloud account.".into() })?;
        Ok(RemoteEntry {
            id: id.into(),
            kind: if file.is_folder { "folder".into() } else { "file".into() },
            name: file.name.clone(),
            path: format!("/{}", file.name),
            size: Some(file.bytes.len() as u64),
            modified_at: if file.modified_at.is_empty() { None } else { Some(file.modified_at.clone()) },
            version: if file.is_folder { None } else { Some(file.version.to_string()) },
            sha1: if file.is_folder { None } else { Some(sha1_hex(&file.bytes)) },
            parent_id: if file.parent.is_empty() { None } else { Some(file.parent.clone()) },
        })
    }

    fn stamp() -> String {
        // Monotonic enough for a fake: seconds since the epoch.
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        format!("{secs}")
    }
}

#[async_trait]
impl CloudProvider for MockProvider {
    fn provider_id(&self) -> &'static str {
        PROVIDER_MOCK
    }

    fn account(&self) -> &CloudAccount {
        &self.account
    }

    async fn list(&self, folder_id: &str) -> Result<Vec<RemoteEntry>, CloudError> {
        let inner = self.inner.lock().expect("mock lock");
        Self::check_offline(&inner)?;
        if !inner.files.contains_key(folder_id) {
            return Err(CloudError::NotFound { message: "That folder is no longer in the cloud account.".into() });
        }
        let mut entries: Vec<_> = inner
            .files
            .iter()
            .filter(|(_, f)| f.parent == folder_id && !f.name.is_empty())
            .map(|(id, _)| Self::entry_of(&inner, id))
            .collect::<Result<_, _>>()?;
        entries.sort_by(|a, b| (a.kind.clone(), a.name.clone()).cmp(&(b.kind.clone(), b.name.clone())));
        Ok(entries)
    }

    async fn download(&self, file_id: &str) -> Result<RemoteDownload, CloudError> {
        let inner = self.inner.lock().expect("mock lock");
        Self::check_offline(&inner)?;
        let file = inner
            .files
            .get(file_id)
            .ok_or_else(|| CloudError::NotFound { message: "That file is no longer in the cloud account.".into() })?;
        if file.is_folder {
            return Err(CloudError::provider("A folder can't be downloaded."));
        }
        Ok(RemoteDownload {
            base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &file.bytes),
            name: file.name.clone(),
            version: Some(file.version.to_string()),
            sha1: Some(sha1_hex(&file.bytes)),
            modified_at: Some(file.modified_at.clone()),
        })
    }

    async fn upload_new(&self, folder_id: &str, name: &str, bytes: &[u8]) -> Result<RemoteEntry, CloudError> {
        let mut inner = self.inner.lock().expect("mock lock");
        Self::check_offline(&inner)?;
        if !inner.files.contains_key(folder_id) {
            return Err(CloudError::NotFound { message: "That folder is no longer in the cloud account.".into() });
        }
        inner.next_id += 1;
        let id = format!("mock-{}", inner.next_id);
        inner.files.insert(
            id.clone(),
            MockFile {
                name: name.into(),
                parent: folder_id.into(),
                bytes: bytes.to_vec(),
                version: 1,
                modified_at: Self::stamp(),
                is_folder: false,
            },
        );
        Self::entry_of(&inner, &id)
    }

    async fn upload_version(
        &self,
        file_id: &str,
        bytes: &[u8],
        expected_version: Option<&str>,
    ) -> Result<RemoteVersion, CloudError> {
        self.mock_upload_version(file_id, bytes, expected_version)
    }

    async fn create_folder(&self, parent_id: &str, name: &str) -> Result<RemoteEntry, CloudError> {
        let mut inner = self.inner.lock().expect("mock lock");
        Self::check_offline(&inner)?;
        if !inner.files.contains_key(parent_id) {
            return Err(CloudError::NotFound { message: "That folder is no longer in the cloud account.".into() });
        }
        inner.next_id += 1;
        let id = format!("mock-{}", inner.next_id);
        inner.files.insert(
            id.clone(),
            MockFile {
                name: name.into(),
                parent: parent_id.into(),
                bytes: vec![],
                version: 0,
                modified_at: Self::stamp(),
                is_folder: true,
            },
        );
        Self::entry_of(&inner, &id)
    }

    async fn move_item(&self, file_id: &str, new_parent_id: &str, _is_folder: bool) -> Result<RemoteEntry, CloudError> {
        let mut inner = self.inner.lock().expect("mock lock");
        Self::check_offline(&inner)?;
        if !inner.files.contains_key(file_id) || !inner.files.contains_key(new_parent_id) {
            return Err(CloudError::NotFound {
                message: "That file or folder is no longer in the cloud account.".into(),
            });
        }
        inner.files.get_mut(file_id).expect("checked").parent = new_parent_id.into();
        Self::entry_of(&inner, file_id)
    }

    async fn get_metadata(&self, file_id: &str) -> Result<RemoteEntry, CloudError> {
        let inner = self.inner.lock().expect("mock lock");
        Self::check_offline(&inner)?;
        Self::entry_of(&inner, file_id)
    }

    async fn list_revisions(&self, file_id: &str) -> Result<Vec<RemoteVersion>, CloudError> {
        let inner = self.inner.lock().expect("mock lock");
        Self::check_offline(&inner)?;
        let file = inner
            .files
            .get(file_id)
            .ok_or_else(|| CloudError::NotFound { message: "That file is no longer in the cloud account.".into() })?;
        if file.is_folder {
            return Ok(vec![]);
        }
        Ok(vec![RemoteVersion {
            version: file.version.to_string(),
            sha1: Some(sha1_hex(&file.bytes)),
            modified_at: Some(file.modified_at.clone()),
        }])
    }

    async fn revoke(&self) -> Result<(), CloudError> {
        Ok(())
    }
}

// Conditional upload, as the trait calls it: a version mismatch is a
// `Conflict` carrying the remote version, exactly like the real providers.
impl MockProvider {
    pub fn mock_upload_version(
        &self,
        file_id: &str,
        bytes: &[u8],
        expected_version: Option<&str>,
    ) -> Result<RemoteVersion, CloudError> {
        let mut inner = self.inner.lock().expect("mock lock");
        Self::check_offline(&inner)?;
        let file = inner
            .files
            .get_mut(file_id)
            .ok_or_else(|| CloudError::NotFound { message: "That file is no longer in the cloud account.".into() })?;
        if file.is_folder {
            return Err(CloudError::provider("A folder can't be uploaded."));
        }
        if let Some(expected) = expected_version {
            if file.version.to_string() != expected {
                let remote = RemoteVersion {
                    version: file.version.to_string(),
                    sha1: Some(sha1_hex(&file.bytes)),
                    modified_at: Some(file.modified_at.clone()),
                };
                return Err(CloudError::Conflict {
                    remote_version: remote.version.clone(),
                    remote_modified_at: remote.modified_at.clone(),
                    remote_sha1: remote.sha1.clone(),
                    message: "The file changed in the cloud since it was opened.".into(),
                });
            }
        }
        file.bytes = bytes.to_vec();
        file.version += 1;
        file.modified_at = Self::stamp();
        Ok(RemoteVersion {
            version: file.version.to_string(),
            sha1: Some(sha1_hex(&file.bytes)),
            modified_at: Some(file.modified_at.clone()),
        })
    }

    /// A second writer, for conflict tests: bumps the version out from under
    /// the first holder, the way another machine editing the same file does.
    pub fn mock_remote_edit(&self, file_id: &str, bytes: &[u8]) -> Result<(), CloudError> {
        let mut inner = self.inner.lock().expect("mock lock");
        Self::check_offline(&inner)?;
        let file = inner
            .files
            .get_mut(file_id)
            .ok_or_else(|| CloudError::NotFound { message: "That file is no longer in the cloud account.".into() })?;
        file.bytes = bytes.to_vec();
        file.version += 1;
        file.modified_at = Self::stamp();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_upload_new_then_download_round_trips() {
        let mock = MockProvider::new();
        let entry = mock.upload_new("0", "Data.hlx", b"{\"titer\":1}").await.expect("upload");
        assert_eq!(entry.version.as_deref(), Some("1"));
        let got = mock.download(&entry.id).await.expect("download");
        assert_eq!(got.version.as_deref(), Some("1"));
        assert_eq!(got.name, "Data.hlx");
    }

    #[tokio::test]
    async fn mock_conditional_upload_accepts_the_seen_version() {
        let mock = MockProvider::new();
        let entry = mock.upload_new("0", "Data.hlx", b"v1").await.expect("upload");
        let saved = mock.mock_upload_version(&entry.id, b"v2", Some("1")).expect("conditional save");
        assert_eq!(saved.version, "2");
    }

    #[tokio::test]
    async fn mock_conditional_upload_conflicts_when_the_remote_moved() {
        let mock = MockProvider::new();
        let entry = mock.upload_new("0", "Data.hlx", b"v1").await.expect("upload");
        // Another machine edits the same file: the version moves to 2.
        mock.mock_remote_edit(&entry.id, b"v2-remote").expect("remote edit");
        let err = mock.mock_upload_version(&entry.id, b"v2-local", Some("1")).expect_err("must conflict");
        match err {
            CloudError::Conflict { remote_version, .. } => assert_eq!(remote_version, "2"),
            other => panic!("expected Conflict, got {other:?}"),
        }
        // The overwrite path (explicit choice only) still works.
        let saved = mock.mock_upload_version(&entry.id, b"v2-local", None).expect("overwrite");
        assert_eq!(saved.version, "3");
    }

    #[tokio::test]
    async fn mock_offline_fails_every_operation_and_recovers() {
        let mock = MockProvider::new();
        let entry = mock.upload_new("0", "Data.hlx", b"v1").await.expect("upload");
        mock.set_offline(true);
        assert!(matches!(mock.list("0").await, Err(CloudError::Offline { .. })));
        assert!(matches!(mock.download(&entry.id).await, Err(CloudError::Offline { .. })));
        assert!(matches!(mock.mock_upload_version(&entry.id, b"v2", Some("1")), Err(CloudError::Offline { .. })));
        mock.set_offline(false);
        assert!(mock.download(&entry.id).await.is_ok(), "back online: download works again");
    }

    #[tokio::test]
    async fn mock_move_and_revisions() {
        let mock = MockProvider::new();
        let folder = mock.create_folder("0", "Research").await.expect("mkdir");
        let entry = mock.upload_new("0", "Data.hlx", b"v1").await.expect("upload");
        let moved = mock.move_item(&entry.id, &folder.id, false).await.expect("move");
        assert_eq!(moved.path, "/Data.hlx");
        let versions = mock.list_revisions(&entry.id).await.expect("revisions");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].version, "1");
    }

    #[test]
    fn pkce_challenge_is_s256_url_safe() {
        let pkce = new_pkce();
        assert_eq!(pkce.verifier.len(), 64);
        assert!(!pkce.challenge.contains('+') && !pkce.challenge.contains('/') && !pkce.challenge.contains('='));
        assert_eq!(pkce.challenge.len(), 43, "32-byte SHA-256, base64url without padding");
    }

    #[test]
    fn token_set_debug_never_prints_tokens() {
        let tokens = TokenSet {
            access_token: "SECRET-ACCESS".into(),
            refresh_token: Some("SECRET-REFRESH".into()),
            expires_at_unix: 0,
            scope: "root_readwrite".into(),
        };
        let shown = format!("{tokens:?}");
        assert!(!shown.contains("SECRET-ACCESS") && !shown.contains("SECRET-REFRESH"), "{shown}");
    }
}
