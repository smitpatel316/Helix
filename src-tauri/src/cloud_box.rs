// Box provider (v2 backlog item 75, Box first). Custom App → User
// Authentication (OAuth 2.0). See docs/cloud-storage-box.md for the full
// design, the PKCE verdict, and the open decisions.
//
// ── Box PKCE verdict (verified 2026-11-13, Box's own sources) ──────────
// Box's authorization-server metadata
// (https://account.box.com/.well-known/oauth-authorization-server, fetched
// live) says BOTH:
//   "code_challenge_methods_supported": ["S256"]   — PKCE challenges accepted
//   "token_endpoint_auth_methods_supported":
//       ["client_secret_basic", "client_secret_post"]  — NO "none"
// So a PKCE challenge is accepted, but a secret-less public-client flow can
// NEVER complete: every token call (authorization_code AND refresh_token)
// mandates a client secret. The research doc's "public client, no client
// secret in the binary" design does not hold for Box, and no PKCE-only auth
// is built here. Instead this module implements Box's documented
// confidential-client authorization-code flow, with the PKCE S256 challenge
// kept as defence-in-depth (it protects the code on the loopback redirect,
// and Box advertises it), and the client secret sourced ONLY from:
//   (a) the Titer broker (`BOX_BROKER_URL`) — the default: the broker holds
//       the shared app's secret and exchanges codes / refreshes tokens, so
//       no secret ships in the app. The broker's client id comes from
//       `GET /config` per session, in memory only, never stored — a client
//       id is public, not a secret.
//   (b) BYO credentials — the user pastes their own Box app's client id +
//       secret in Settings → Connected Storage, stored in the OS keychain.
//       Used when the broker is unreachable, and for refreshes of tokens
//       the BYO credentials issued (Box refresh tokens are bound to the
//       issuing client id + secret — see `TokenSet::issued_via_broker`).
// No client secret is shipped in the app, and no Box developer app was
// created for this work. `BOX_CLIENT_ID` below is a clearly-marked
// placeholder, never a real id.
// ── Other Box facts used here ───────────────────────────────────────────
// - Access tokens live 60 min; refresh tokens 60 days and are SINGLE-USE:
//   the new refresh token is stored on every refresh, without exception.
// - Authorization codes expire after 30 seconds: the loopback exchange runs
//   immediately after capture.
// - Direct uploads cap at 50 MB (never binds for .hlx/.prism, kilobytes).
// - Download is a redirect to dl.boxcloud.com; reqwest follows it and drops
//   the Authorization header on the cross-host hop, as it should.
// - Conditional upload: Box honours `If-Match: <etag>` on a new-version
//   upload (412 on mismatch). The conflict token the file layer carries is
//   the file's `version_number` (+ sha1); this module translates it to the
//   current etag with a metadata read at save time, so the upload itself
//   stays conditional — no lost update between the check and the write.
// - Enterprise tenants may require a Box Admin to enable an unpublished
//   OAuth app (UCSF check: settled by submitting the app, or one email
//   from Mansi to UCSF IT). Code must not depend on the answer.

use crate::cloud::{
    ephemeral_loopback_port, load_byo_credentials, load_tokens, new_pkce, new_state, save_tokens, url_encode,
    wait_for_code, ByoCredentials, CloudAccount, CloudError, CloudProvider, RemoteDownload, RemoteEntry, RemoteVersion,
    TokenSet,
};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;

const BOX_AUTHORIZE_URL: &str = "https://account.box.com/api/oauth2/authorize";
const BOX_TOKEN_URL: &str = "https://api.box.com/oauth2/token";
const BOX_REVOKE_URL: &str = "https://api.box.com/oauth2/revoke";
const BOX_API: &str = "https://api.box.com/2.0";
const BOX_UPLOAD_API: &str = "https://upload.box.com/api/2.0";

/// Scopes requested at connect. `root_readwrite` is the feature as
/// described (open/edit/save anywhere the user can); `root_readonly` is the
/// read-only shape, used only if a read-only mode is ever offered.
pub const BOX_SCOPE_READWRITE: &str = "root_readwrite";
pub const BOX_SCOPE_READONLY: &str = "root_readonly";

/// Direct-upload cap, bytes (Box: 50 MB). Upload sessions are a later slice.
pub const BOX_DIRECT_UPLOAD_MAX: u64 = 50 * 1024 * 1024;

/// Placeholder, NEVER a real client id. The real id comes from the Box app
/// Smit's call creates (research §7 Q2), via BYO credentials or the broker.
pub const BOX_CLIENT_ID_PLACEHOLDER: &str = "YOUR_BOX_CLIENT_ID";

/// The Titer token broker: a tiny server holding the shared Box app's
/// client secret and exchanging codes for tokens, so no secret ships in the
/// app. Live at box-broker.smitpatel.net (broker lane, deployed on the Pi).
/// The client id comes from `GET /config` per session, in memory only.
/// `TITER_BOX_BROKER_URL` (when set, non-empty) overrides this — dev/test
/// only, so tests can point at a local mock broker.
pub const BOX_BROKER_URL: Option<&str> = Some("https://box-broker.smitpatel.net");

/// How long a broker probe may take before connect falls back to BYO (or
/// reports the outage). The broker is a fast local-ish hop; 5 s bounds the
/// wait so a dead broker never hangs the Settings dialog.
const BROKER_PROBE_TIMEOUT_SECS: u64 = 5;

/// The broker base URL in effect: the env override first, then the
/// compiled-in URL. Tests set the env var to a mock broker.
fn broker_base_url() -> Option<String> {
    match std::env::var("TITER_BOX_BROKER_URL") {
        Ok(url) if !url.trim().is_empty() => Some(url.trim().to_string()),
        _ => BOX_BROKER_URL.map(str::to_string),
    }
}

/// Whether a broker is configured at all (URL set). Reachability is a
/// separate, live question — see `broker_available`.
pub fn broker_configured() -> bool {
    broker_base_url().is_some()
}

/// Live probe: does the broker answer `GET /config` right now? Used by the
/// Settings status line. A failure here is "unreachable", never a crash.
pub async fn broker_available() -> bool {
    let Some(base) = broker_base_url() else { return false };
    let Ok(http) = http_client() else { return false };
    broker_config(&http, &base).await.is_ok()
}

/// Where the client secret comes from for this connect.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SecretSource {
    /// The user's own Box app credentials, from the OS keychain.
    Byo,
    /// The Titer broker (client id from /config, secret never leaves it).
    Broker,
}

/// What a connect uses: either the user's own credentials, or the broker's
/// client id (in memory only — never stored, never in the keychain).
#[derive(Debug, Clone, PartialEq, Eq)]
enum ResolvedCredentials {
    Byo(ByoCredentials),
    Broker { client_id: String },
}

impl ResolvedCredentials {
    fn client_id(&self) -> &str {
        match self {
            ResolvedCredentials::Byo(creds) => &creds.client_id,
            ResolvedCredentials::Broker { client_id } => client_id,
        }
    }

    fn source(&self) -> SecretSource {
        match self {
            ResolvedCredentials::Byo(_) => SecretSource::Byo,
            ResolvedCredentials::Broker { .. } => SecretSource::Broker,
        }
    }
}

/// The broker's `GET /config` answer: the shared app's client id (public).
#[derive(Debug, Deserialize)]
struct BrokerConfig {
    client_id: String,
}

/// One broker probe: `GET {base}/config` with a short timeout. A connect
/// error or timeout is the broker being unreachable (`Offline`); a non-200
/// or unreadable body is a broker problem (`Provider`).
async fn broker_config(http: &reqwest::Client, base_url: &str) -> Result<BrokerConfig, CloudError> {
    let url = format!("{base_url}/config");
    let response = http
        .get(&url)
        .timeout(std::time::Duration::from_secs(BROKER_PROBE_TIMEOUT_SECS))
        .send()
        .await
        .map_err(CloudError::from_http)?;
    let status = response.status();
    if !status.is_success() {
        return Err(CloudError::provider("The Titer Box broker returned an error."));
    }
    response.json::<BrokerConfig>().await.map_err(|_| {
        CloudError::provider("The Titer Box broker returned a configuration Titer couldn't read.")
    })
}

/// Resolves the credentials for a connect, against `broker_url` (`None` =
/// no broker configured). Precedence: broker first — probe `/config` with
/// a short timeout; if it answers, the shared app is the path. If the
/// broker is unreachable, fall back to BYO when the user has credentials
/// saved; if neither is available, the error names the broker outage AND
/// the BYO alternative, so the user knows both halves.
async fn resolve_credentials_with(
    broker_url: Option<String>,
    http: &reqwest::Client,
) -> Result<ResolvedCredentials, CloudError> {
    if let Some(base) = broker_url {
        match broker_config(http, &base).await {
            Ok(config) => return Ok(ResolvedCredentials::Broker { client_id: config.client_id }),
            Err(broker_err) => {
                if let Some(creds) = load_byo_credentials("box")? {
                    return Ok(ResolvedCredentials::Byo(creds));
                }
                let broker_note = match broker_err {
                    CloudError::Offline { .. } => {
                        "the Titer Box broker couldn't be reached (check the network, or the broker may be down)"
                    }
                    _ => "the Titer Box broker returned an error",
                };
                return Err(CloudError::NotConfigured {
                    message: format!(
                        "Box isn't configured yet: {broker_note}, and no Box app credentials are saved. Add your own Box app's client ID and secret in Settings → Connected Storage (they stay in the OS keychain) to connect anyway, or try again once the broker is back."
                    ),
                });
            }
        }
    }
    if let Some(creds) = load_byo_credentials("box")? {
        return Ok(ResolvedCredentials::Byo(creds));
    }
    Err(CloudError::NotConfigured {
        message: "Box isn't configured yet: no Box app credentials are saved. Add your own Box app's client ID and secret in Settings → Connected Storage (they stay in the OS keychain).".into(),
    })
}

async fn resolve_credentials(http: &reqwest::Client) -> Result<ResolvedCredentials, CloudError> {
    resolve_credentials_with(broker_base_url(), http).await
}

/// The token endpoint's answer.
#[derive(Debug, Deserialize)]
struct BoxTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    #[allow(dead_code)]
    token_type: Option<String>,
}

/// A Box file or folder, as the API returns it (snake_case, as Box sends).
#[derive(Debug, Clone, Deserialize)]
struct BoxItem {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    name: String,
    size: Option<u64>,
    modified_at: Option<String>,
    sha1: Option<String>,
    etag: Option<String>,
    version_number: Option<String>,
    path_collection: Option<BoxPathCollection>,
    parent: Option<BoxParent>,
}

#[derive(Debug, Clone, Deserialize)]
struct BoxParent {
    id: String,
    #[allow(dead_code)]
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct BoxPathCollection {
    entries: Vec<BoxPathEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct BoxPathEntry {
    #[allow(dead_code)]
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct BoxListResponse {
    entries: Vec<BoxItem>,
}

#[derive(Debug, Deserialize)]
struct BoxUser {
    id: String,
    login: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct BoxVersionEntry {
    id: String,
    sha1: Option<String>,
    modified_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BoxVersionsResponse {
    entries: Vec<BoxVersionEntry>,
}

impl BoxItem {
    /// Display path from the parent chain ("/Research/Data.hlx"). Root items
    /// have an empty parent chain — Box names the root "All Files" (id "0"),
    /// which is not part of a path.
    fn display_path(&self) -> String {
        let mut parts: Vec<&str> = self
            .path_collection
            .as_ref()
            .map(|c| c.entries.iter().filter(|e| e.id != "0").map(|e| e.name.as_str()).collect())
            .unwrap_or_default();
        parts.push(&self.name);
        format!("/{}", parts.join("/"))
    }

    fn to_entry(&self) -> RemoteEntry {
        RemoteEntry {
            id: self.id.clone(),
            kind: self.kind.clone(),
            name: self.name.clone(),
            path: self.display_path(),
            size: self.size,
            modified_at: self.modified_at.clone(),
            version: if self.kind == "file" { self.version_number.clone() } else { None },
            sha1: self.sha1.clone(),
            parent_id: self.parent.as_ref().map(|p| p.id.clone()),
        }
    }
}

/// The Box client for one account: HTTP + tokens from the keychain.
/// Tokens live behind a short-held `Mutex` (never across an await): a
/// refresh replaces the pair in memory AND in the keychain at once — Box
/// refresh tokens are single-use, so the new one must be stored on every
/// refresh, or the next refresh fails and the user is signed out.
pub struct BoxClient {
    http: reqwest::Client,
    account: CloudAccount,
    tokens: std::sync::Mutex<TokenSet>,
}

fn http_client() -> Result<reqwest::Client, CloudError> {
    reqwest::Client::builder()
        .user_agent("Titer/1.0.7")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| CloudError::provider(format!("Couldn't build the Box client: {e}")))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// One token exchange (code or refresh) against Box directly, with the
/// user's own credentials. The client secret goes ONLY to Box's token
/// endpoint, over HTTPS, from Rust — never to the webview, never to a log.
/// `code_verifier` is sent when this is a code exchange (PKCE S256, which
/// Box advertises); refresh exchanges carry no verifier.
async fn exchange_token_byo(
    http: &reqwest::Client,
    creds: &ByoCredentials,
    params: &[(&str, &str)],
    code_verifier: Option<&str>,
) -> Result<BoxTokenResponse, CloudError> {
    let mut form: Vec<(&str, &str)> =
        vec![("client_id", creds.client_id.as_str()), ("client_secret", creds.client_secret.as_str())];
    form.extend_from_slice(params);
    if let Some(verifier) = code_verifier {
        form.push(("code_verifier", verifier));
    }
    let response = http.post(BOX_TOKEN_URL).form(&form).send().await.map_err(CloudError::from_http)?;
    token_response(response).await
}

/// One token exchange through the broker: `POST {base}/exchange` (code) or
/// `POST {base}/refresh` (refresh token), JSON in, Box token JSON out. The
/// secret never leaves the broker; the request carries no credentials at
/// all. Contract (broker v1): invalid_grant → 400, Box unreachable → 502,
/// rate-limited → 429.
async fn exchange_token_broker(
    http: &reqwest::Client,
    base_url: &str,
    endpoint: &str,
    body: serde_json::Value,
) -> Result<BoxTokenResponse, CloudError> {
    let url = format!("{base_url}/{endpoint}");
    let response = http.post(&url).json(&body).send().await.map_err(CloudError::from_http)?;
    token_response(response).await
}

/// Reads a token endpoint's answer — Box's directly, or the broker's
/// pass-through of it. A 400 carrying `invalid_grant` is "signed out"
/// (revoked/expired refresh token, or a used/expired code): the stored
/// tokens are dead, so the caller deletes them, never retries. A 502 from
/// the broker means Box was unreachable — that is `Offline` (retryable),
/// not signed-out. Anything else non-2xx is a provider error.
async fn token_response(response: reqwest::Response) -> Result<BoxTokenResponse, CloudError> {
    let status = response.status();
    if status.is_success() {
        return response
            .json::<BoxTokenResponse>()
            .await
            .map_err(|_| CloudError::provider("Box returned a token response Titer couldn't read."));
    }
    if status.as_u16() == 502 {
        return Err(CloudError::offline(
            "Box couldn't be reached through the Titer broker. Check the network and try again.",
        ));
    }
    if status.as_u16() == 400 {
        if let Ok(body) = response.text().await {
            if body.contains("invalid_grant") {
                return Err(CloudError::NotAuthenticated {
                    message:
                        "The Box sign-in expired or was revoked. Reconnect Box to keep working on remote files."
                            .into(),
                });
            }
        }
        return Err(CloudError::provider("Box refused the sign-in. Try connecting again."));
    }
    Err(CloudError::from_status(status))
}

/// Starts the Box connect flow: loopback listener, system-browser authorize,
/// immediate code exchange, then `/users/me` for the account. Blocks until
/// the user completes sign-in (5-minute timeout) or cancels. The caller
/// (the `cloud_connect_box` command) records the account in the registry.
///
/// The credential source is resolved first: broker when it answers
/// `/config` (its client id goes on the authorize URL, in memory only, and
/// the code is exchanged through `POST /exchange`), BYO when the broker is
/// unreachable and the user has credentials saved. The issued tokens are
/// recorded with their source, so refreshes go back through the same one.
pub async fn connect_box() -> Result<CloudAccount, CloudError> {
    let http = http_client()?;
    let resolved = resolve_credentials(&http).await?;
    let client_id = resolved.client_id().to_string();
    let source = resolved.source();
    let pkce = new_pkce();
    let state = new_state();
    let port = ephemeral_loopback_port()?;
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let authorize = format!(
        "{BOX_AUTHORIZE_URL}?response_type=code&client_id={}&redirect_uri={}&state={}&scope={}&code_challenge={}&code_challenge_method=S256",
        url_encode(&client_id),
        url_encode(&redirect_uri),
        url_encode(&state),
        url_encode(BOX_SCOPE_READWRITE),
        url_encode(&pkce.challenge),
    );
    crate::cloud::open_browser_url(&authorize)?;
    // Box codes expire after 30 seconds: exchange the moment it arrives.
    let code = wait_for_code(port, &state, std::time::Duration::from_secs(300))?;
    let tokens = match &resolved {
        ResolvedCredentials::Broker { .. } => {
            let base = broker_base_url().ok_or_else(|| CloudError::provider("The Titer Box broker went away."))?;
            exchange_token_broker(
                &http,
                &base,
                "exchange",
                serde_json::json!({
                    "code": code,
                    "code_verifier": pkce.verifier,
                    "redirect_uri": redirect_uri,
                }),
            )
            .await?
        }
        ResolvedCredentials::Byo(creds) => {
            exchange_token_byo(
                &http,
                creds,
                &[("grant_type", "authorization_code"), ("code", code.as_str()), ("redirect_uri", redirect_uri.as_str())],
                Some(pkce.verifier.as_str()),
            )
            .await?
        }
    };
    let access = tokens.access_token.clone();
    let user: BoxUser = http
        .get(format!("{BOX_API}/users/me"))
        .bearer_auth(&access)
        .send()
        .await
        .map_err(CloudError::from_http)?
        .error_for_status()
        .map_err(|e| CloudError::from_status(e.status().unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR)))?
        .json()
        .await
        .map_err(|_| CloudError::provider("Box returned a user response Titer couldn't read."))?;
    let account = CloudAccount {
        provider: "box".into(),
        id: user.id.clone(),
        login: user.login.clone(),
        name: user.name.clone(),
    };
    save_tokens(
        "box",
        &user.id,
        &TokenSet {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at_unix: now_unix() + tokens.expires_in.unwrap_or(3600) as i64,
            scope: BOX_SCOPE_READWRITE.into(),
            issued_via_broker: source == SecretSource::Broker,
        },
    )?;
    Ok(account)
}

impl BoxClient {
    /// Loads the saved tokens for `account_id` (signed-out if there are none).
    pub fn from_account(account_id: &str, login: &str, name: &str) -> Result<Self, CloudError> {
        let tokens = load_tokens("box", account_id)?;
        Ok(BoxClient {
            http: http_client()?,
            account: CloudAccount {
                provider: "box".into(),
                id: account_id.into(),
                login: login.into(),
                name: name.into(),
            },
            tokens: std::sync::Mutex::new(tokens),
        })
    }

    /// A live access token, refreshing proactively when under 2 minutes are
    /// left. The refreshed pair is stored (keychain + memory) before it is
    /// returned — Box refresh tokens are single-use.
    ///
    /// The refresh goes through the source that ISSUED the tokens
    /// (`issued_via_broker` on the stored pair): Box binds a refresh token
    /// to its issuing client id + secret, so the other source answers
    /// invalid_grant. A broker refresh needs no `/config` — `POST /refresh`
    /// takes only the refresh token. A broker outage at refresh time is
    /// `Offline` (retryable): the stored tokens are untouched, never
    /// deleted, never treated as signed-out.
    async fn access_token(&self) -> Result<String, CloudError> {
        let (access, expires_at, refresh, issued_via_broker) = {
            let tokens = self.tokens.lock().expect("box token lock");
            (
                tokens.access_token.clone(),
                tokens.expires_at_unix,
                tokens.refresh_token.clone(),
                tokens.issued_via_broker,
            )
        };
        if expires_at - now_unix() > 120 {
            return Ok(access);
        }
        let refresh_token = refresh.ok_or_else(|| CloudError::NotAuthenticated {
            message: "The Box sign-in expired. Reconnect Box to keep working on remote files.".into(),
        })?;
        let tokens = self.refresh_tokens(&refresh_token, issued_via_broker).await.map_err(|e| {
            // A dead refresh token must not be retried forever.
            if matches!(e, CloudError::NotAuthenticated { .. }) {
                let _ = crate::cloud::delete_tokens("box", &self.account.id);
            }
            e
        })?;
        let stored = TokenSet {
            access_token: tokens.access_token.clone(),
            refresh_token: tokens.refresh_token,
            expires_at_unix: now_unix() + tokens.expires_in.unwrap_or(3600) as i64,
            scope: BOX_SCOPE_READWRITE.into(),
            issued_via_broker,
        };
        save_tokens("box", &self.account.id, &stored)?;
        *self.tokens.lock().expect("box token lock") = stored.clone();
        Ok(stored.access_token)
    }

    /// Refreshes one pair through the source that issued it. Broker-side:
    /// `POST /refresh` with only the refresh token (no `/config` needed).
    /// BYO-side: Box's token endpoint with the saved credentials. A missing
    /// BYO credential set (user deleted it after connecting) is
    /// NotConfigured, as before — the broker is NOT substituted, because a
    /// BYO-issued refresh token cannot be refreshed through the broker.
    async fn refresh_tokens(
        &self,
        refresh_token: &str,
        issued_via_broker: bool,
    ) -> Result<BoxTokenResponse, CloudError> {
        if issued_via_broker {
            let base = broker_base_url()
                .ok_or_else(|| CloudError::provider("The Titer Box broker isn't configured."))?;
            return exchange_token_broker(
                &self.http,
                &base,
                "refresh",
                serde_json::json!({ "refresh_token": refresh_token }),
            )
            .await;
        }
        let creds = load_byo_credentials("box")?.ok_or_else(|| CloudError::NotConfigured {
            message: "Box isn't configured yet: the saved Box app credentials are gone. Re-enter them in Settings → Connected Storage.".into(),
        })?;
        exchange_token_byo(
            &self.http,
            &creds,
            &[("grant_type", "refresh_token"), ("refresh_token", refresh_token)],
            None,
        )
        .await
    }

    /// Sends `build` with a live token; on 401, refreshes once (forcing it
    /// by expiring the stored token) and retries once. `build` is a closure
    /// so the request is rebuilt fresh for the retry (no stale body).
    async fn send_authed<F>(&self, build: F) -> Result<reqwest::Response, CloudError>
    where
        F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
    {
        let token = self.access_token().await?;
        let response = build(&self.http, &token).send().await.map_err(CloudError::from_http)?;
        if response.status() != reqwest::StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        // One retry after a forced refresh: the token may have been revoked
        // between the proactive check and the call.
        {
            let mut tokens = self.tokens.lock().expect("box token lock");
            tokens.expires_at_unix = 0;
        }
        let token = self.access_token().await?;
        build(&self.http, &token).send().await.map_err(CloudError::from_http)
    }

    /// A JSON response, or the sorted error for its status. Bodies are never
    /// surfaced (they can echo request details).
    async fn json_or_error<T: for<'de> Deserialize<'de>>(&self, response: reqwest::Response) -> Result<T, CloudError> {
        let status = response.status();
        if !status.is_success() {
            return Err(CloudError::from_status(status));
        }
        response.json::<T>().await.map_err(|_| CloudError::provider("Box returned a response Titer couldn't read."))
    }

    async fn get_item(&self, id: &str) -> Result<BoxItem, CloudError> {
        let fields = "id,type,name,size,modified_at,sha1,etag,version_number,path_collection,parent";
        let response = self
            .send_authed(|http, token| {
                http.get(format!("{BOX_API}/files/{id}")).query(&[("fields", fields)]).bearer_auth(token)
            })
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            // Maybe a folder: the trait's metadata call doesn't say which.
            let response = self
                .send_authed(|http, token| {
                    http.get(format!("{BOX_API}/folders/{id}")).query(&[("fields", fields)]).bearer_auth(token)
                })
                .await?;
            return self.json_or_error(response).await;
        }
        self.json_or_error(response).await
    }

    /// The remote version for a `Conflict` error, from fresh metadata.
    async fn conflict_for(&self, file_id: &str) -> CloudError {
        match self.get_item(file_id).await {
            Ok(item) => CloudError::Conflict {
                remote_version: item.version_number.unwrap_or_default(),
                remote_modified_at: item.modified_at,
                remote_sha1: item.sha1,
                message: "The file changed in Box since it was opened.".into(),
            },
            Err(_) => CloudError::Conflict {
                remote_version: String::new(),
                remote_modified_at: None,
                remote_sha1: None,
                message: "The file changed in Box since it was opened.".into(),
            },
        }
    }
}

#[async_trait]
impl CloudProvider for BoxClient {
    fn provider_id(&self) -> &'static str {
        "box"
    }

    fn account(&self) -> &CloudAccount {
        &self.account
    }

    async fn list(&self, folder_id: &str) -> Result<Vec<RemoteEntry>, CloudError> {
        let fields = "id,type,name,size,modified_at,sha1,etag,version_number,path_collection";
        let response = self
            .send_authed(|http, token| {
                http.get(format!("{BOX_API}/folders/{folder_id}/items"))
                    .query(&[("fields", fields), ("limit", "1000")])
                    .bearer_auth(token)
            })
            .await?;
        let list: BoxListResponse = self.json_or_error(response).await?;
        Ok(list.entries.iter().map(BoxItem::to_entry).collect())
    }

    async fn download(&self, file_id: &str) -> Result<RemoteDownload, CloudError> {
        let meta = self.get_item(file_id).await?;
        if meta.kind == "folder" {
            return Err(CloudError::provider("A folder can't be downloaded."));
        }
        let response = self
            .send_authed(|http, token| http.get(format!("{BOX_API}/files/{file_id}/content")).bearer_auth(token))
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(CloudError::from_status(status));
        }
        let bytes = response.bytes().await.map_err(CloudError::from_http)?;
        Ok(RemoteDownload {
            base64: BASE64.encode(&bytes),
            name: meta.name,
            version: meta.version_number,
            sha1: meta.sha1,
            modified_at: meta.modified_at,
        })
    }

    async fn upload_new(&self, folder_id: &str, name: &str, bytes: &[u8]) -> Result<RemoteEntry, CloudError> {
        if bytes.len() as u64 > BOX_DIRECT_UPLOAD_MAX {
            return Err(CloudError::TooLarge {
                message: "That file is over Box's 50 MB direct-upload limit. Upload sessions aren't built yet.".into(),
            });
        }
        let attributes = serde_json::json!({ "name": name, "parent": { "id": folder_id } }).to_string();
        let owned_bytes = bytes.to_vec();
        let owned_name = name.to_string();
        let response = self
            .send_authed(|http, token| {
                // Rebuilt fresh on a retry: a multipart form can't be re-sent.
                let form = reqwest::multipart::Form::new()
                    .text("attributes", attributes.clone())
                    .part("file", reqwest::multipart::Part::bytes(owned_bytes.clone()).file_name(owned_name.clone()));
                http.post(format!("{BOX_UPLOAD_API}/files/content")).multipart(form).bearer_auth(token)
            })
            .await?;
        let list: BoxListResponse = self.json_or_error(response).await?;
        list.entries
            .into_iter()
            .next()
            .map(|item| item.to_entry())
            .ok_or_else(|| CloudError::provider("Box accepted the upload but didn't return the file."))
    }

    async fn upload_version(
        &self,
        file_id: &str,
        bytes: &[u8],
        expected_version: Option<&str>,
    ) -> Result<RemoteVersion, CloudError> {
        if bytes.len() as u64 > BOX_DIRECT_UPLOAD_MAX {
            return Err(CloudError::TooLarge {
                message: "That file is over Box's 50 MB direct-upload limit. Upload sessions aren't built yet.".into(),
            });
        }
        // Conditional on the version seen at open/last-save: read the current
        // metadata, refuse on mismatch, and upload with If-Match on the
        // current etag so the upload itself is conditional too.
        let meta = self.get_item(file_id).await?;
        if let Some(expected) = expected_version {
            if meta.version_number.as_deref() != Some(expected) {
                return Err(self.conflict_for(file_id).await);
            }
        }
        let attributes = serde_json::json!({ "name": meta.name.clone() }).to_string();
        let owned_bytes = bytes.to_vec();
        let owned_name = meta.name.clone();
        let etag = meta.etag.clone();
        let response = self
            .send_authed(|http, token| {
                // Rebuilt fresh on a retry: a multipart form can't be re-sent.
                let form = reqwest::multipart::Form::new()
                    .text("attributes", attributes.clone())
                    .part("file", reqwest::multipart::Part::bytes(owned_bytes.clone()).file_name(owned_name.clone()));
                let mut req =
                    http.post(format!("{BOX_UPLOAD_API}/files/{file_id}/content")).multipart(form).bearer_auth(token);
                if let Some(etag) = etag.as_deref() {
                    req = req.header("If-Match", etag);
                }
                req
            })
            .await?;
        if response.status() == reqwest::StatusCode::PRECONDITION_FAILED {
            return Err(self.conflict_for(file_id).await);
        }
        let list: BoxListResponse = self.json_or_error(response).await?;
        let item = list
            .entries
            .into_iter()
            .next()
            .ok_or_else(|| CloudError::provider("Box accepted the upload but didn't return the file."))?;
        Ok(RemoteVersion {
            version: item.version_number.unwrap_or_default(),
            sha1: item.sha1,
            modified_at: item.modified_at,
        })
    }

    async fn create_folder(&self, parent_id: &str, name: &str) -> Result<RemoteEntry, CloudError> {
        let body = serde_json::json!({ "name": name, "parent": { "id": parent_id } });
        let response = self
            .send_authed(|http, token| http.post(format!("{BOX_API}/folders")).json(&body).bearer_auth(token))
            .await?;
        let item: BoxItem = self.json_or_error(response).await?;
        Ok(item.to_entry())
    }

    async fn move_item(&self, file_id: &str, new_parent_id: &str, is_folder: bool) -> Result<RemoteEntry, CloudError> {
        let body = serde_json::json!({ "parent": { "id": new_parent_id } });
        let kind = if is_folder { "folders" } else { "files" };
        let response = self
            .send_authed(|http, token| http.put(format!("{BOX_API}/{kind}/{file_id}")).json(&body).bearer_auth(token))
            .await?;
        let item: BoxItem = self.json_or_error(response).await?;
        Ok(item.to_entry())
    }

    async fn get_metadata(&self, file_id: &str) -> Result<RemoteEntry, CloudError> {
        Ok(self.get_item(file_id).await?.to_entry())
    }

    async fn list_revisions(&self, file_id: &str) -> Result<Vec<RemoteVersion>, CloudError> {
        let response = self
            .send_authed(|http, token| {
                http.get(format!("{BOX_API}/files/{file_id}/versions"))
                    .query(&[("fields", "id,sha1,modified_at")])
                    .bearer_auth(token)
            })
            .await?;
        let versions: BoxVersionsResponse = self.json_or_error(response).await?;
        Ok(versions
            .entries
            .into_iter()
            .map(|v| RemoteVersion { version: v.id, sha1: v.sha1, modified_at: v.modified_at })
            .collect())
    }

    async fn revoke(&self) -> Result<(), CloudError> {
        let (access, refresh, issued_via_broker) = {
            let tokens = self.tokens.lock().expect("box token lock");
            (tokens.access_token.clone(), tokens.refresh_token.clone(), tokens.issued_via_broker)
        };
        // Broker-issued tokens: the broker contract has no /revoke, and the
        // client holds no secret to revoke with directly — so revocation is
        // local-only: the keychain entry is deleted and the server-side
        // token simply expires on its own (60 days at most). This is a
        // known contract gap for the integration lane, not a silent no-op:
        // the user is told the server side was not revoked.
        // BYO-issued tokens keep the old path: revoke at Box with the saved
        // credentials, then delete locally whatever happens.
        // If the BYO credentials are gone (user deleted them first), there
        // is nothing to revoke with: the local entry is still deleted, and
        // the server-side token simply expires on its own.
        let revoke_result = if issued_via_broker {
            Ok(())
        } else {
            match load_byo_credentials("box")? {
                Some(creds) => {
                    let token = refresh.as_deref().unwrap_or(&access);
                    match self
                        .http
                        .post(BOX_REVOKE_URL)
                        .form(&[
                            ("client_id", creds.client_id.as_str()),
                            ("client_secret", creds.client_secret.as_str()),
                            ("token", token),
                        ])
                        .send()
                        .await
                    {
                        Ok(r) if r.status().is_success() => Ok(()),
                        Ok(r) => Err(CloudError::from_status(r.status())),
                        Err(e) => Err(CloudError::from_http(e)),
                    }
                }
                None => Ok(()),
            }
        };
        let _ = crate::cloud::delete_tokens("box", &self.account.id);
        revoke_result
    }
}

#[cfg(test)]
mod broker_tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// What the mock broker answers. Defaults are the happy path.
    #[derive(Clone)]
    struct MockBrokerBehavior {
        config_status: u16,
        exchange_status: u16,
        exchange_invalid_grant: bool,
        refresh_status: u16,
        refresh_invalid_grant: bool,
        refresh_unreachable_box: bool,
    }

    impl Default for MockBrokerBehavior {
        fn default() -> Self {
            MockBrokerBehavior {
                config_status: 200,
                exchange_status: 200,
                exchange_invalid_grant: false,
                refresh_status: 200,
                refresh_invalid_grant: false,
                refresh_unreachable_box: false,
            }
        }
    }

    /// Starts a mock broker on an ephemeral loopback port, in a detached
    /// thread, and returns its base URL plus the requests it saw
    /// (`(method path, body)`). This mocks the BROKER, never Box: no real
    /// account, no real secret, no network beyond loopback.
    fn start_mock_broker(behavior: MockBrokerBehavior) -> (String, Arc<Mutex<Vec<(String, String)>>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("mock broker bind");
        let port = listener.local_addr().expect("mock broker addr").port();
        let seen: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_for_thread = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().expect("mock broker clone"));
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if line == "\r\n" {
                                break;
                            }
                            if let Some((k, v)) = line.split_once(':') {
                                if k.trim().eq_ignore_ascii_case("content-length") {
                                    content_length = v.trim().parse().unwrap_or(0);
                                }
                            }
                        }
                    }
                }
                let mut body = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                let body_text = String::from_utf8_lossy(&body).into_owned();
                let parts: Vec<&str> = request_line.split_whitespace().collect();
                let (method, path) = (parts.first().copied().unwrap_or(""), parts.get(1).copied().unwrap_or(""));
                seen_for_thread
                    .lock()
                    .expect("mock broker seen lock")
                    .push((format!("{method} {path}"), body_text));
                let (status, payload) = match (method, path) {
                    ("GET", "/config") => (
                        behavior.config_status,
                        if behavior.config_status == 200 {
                            r#"{"client_id":"mock-client-id"}"#.to_string()
                        } else {
                            "{}".to_string()
                        },
                    ),
                    ("POST", "/exchange") => {
                        if behavior.exchange_invalid_grant {
                            (400, r#"{"error":"invalid_grant","error_description":"x"}"#.to_string())
                        } else {
                            (
                                behavior.exchange_status,
                                r#"{"access_token":"broker-access","refresh_token":"broker-refresh","expires_in":3600,"token_type":"bearer"}"#.to_string(),
                            )
                        }
                    }
                    ("POST", "/refresh") => {
                        if behavior.refresh_invalid_grant {
                            (400, r#"{"error":"invalid_grant","error_description":"x"}"#.to_string())
                        } else if behavior.refresh_unreachable_box {
                            (502, "{}".to_string())
                        } else {
                            (
                                behavior.refresh_status,
                                r#"{"access_token":"broker-access-2","refresh_token":"broker-refresh-2","expires_in":3600,"token_type":"bearer"}"#.to_string(),
                            )
                        }
                    }
                    _ => (404, "{}".to_string()),
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    payload.len(),
                    payload
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (format!("http://127.0.0.1:{port}"), seen)
    }

    #[tokio::test]
    async fn broker_config_returns_the_client_id() {
        let (base, _) = start_mock_broker(MockBrokerBehavior::default());
        let http = http_client().expect("http client");
        let config = broker_config(&http, &base).await.expect("config");
        assert_eq!(config.client_id, "mock-client-id");
    }

    #[tokio::test]
    async fn broker_exchange_sends_code_verifier_and_redirect_uri() {
        let (base, seen) = start_mock_broker(MockBrokerBehavior::default());
        let http = http_client().expect("http client");
        let tokens = exchange_token_broker(
            &http,
            &base,
            "exchange",
            serde_json::json!({
                "code": "CODE-1",
                "code_verifier": "VERIFIER-1",
                "redirect_uri": "http://127.0.0.1:9/callback",
            }),
        )
        .await
        .expect("exchange");
        assert_eq!(tokens.access_token, "broker-access");
        assert_eq!(tokens.refresh_token.as_deref(), Some("broker-refresh"));
        assert_eq!(tokens.expires_in, Some(3600));
        let seen = seen.lock().expect("seen lock");
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "POST /exchange");
        let body: serde_json::Value = serde_json::from_str(&seen[0].1).expect("exchange body json");
        assert_eq!(body["code"], "CODE-1");
        assert_eq!(body["code_verifier"], "VERIFIER-1");
        assert_eq!(body["redirect_uri"], "http://127.0.0.1:9/callback");
    }

    #[tokio::test]
    async fn broker_refresh_sends_only_the_refresh_token() {
        let (base, seen) = start_mock_broker(MockBrokerBehavior::default());
        let http = http_client().expect("http client");
        let tokens = exchange_token_broker(&http, &base, "refresh", serde_json::json!({ "refresh_token": "OLD" }))
            .await
            .expect("refresh");
        assert_eq!(tokens.access_token, "broker-access-2");
        assert_eq!(tokens.refresh_token.as_deref(), Some("broker-refresh-2"));
        let seen = seen.lock().expect("seen lock");
        assert_eq!(seen[0].0, "POST /refresh");
        let body: serde_json::Value = serde_json::from_str(&seen[0].1).expect("refresh body json");
        assert_eq!(body, serde_json::json!({ "refresh_token": "OLD" }));
    }

    #[tokio::test]
    async fn broker_exchange_invalid_grant_is_not_authenticated() {
        let (base, _) = start_mock_broker(MockBrokerBehavior {
            exchange_invalid_grant: true,
            ..Default::default()
        });
        let http = http_client().expect("http client");
        let err = exchange_token_broker(
            &http,
            &base,
            "exchange",
            serde_json::json!({"code": "BAD", "code_verifier": "V", "redirect_uri": "http://127.0.0.1:9/callback"}),
        )
        .await
        .expect_err("bad code must fail");
        assert!(matches!(err, CloudError::NotAuthenticated { .. }), "{err:?}");
    }

    #[tokio::test]
    async fn broker_refresh_invalid_grant_is_not_authenticated() {
        let (base, _) = start_mock_broker(MockBrokerBehavior {
            refresh_invalid_grant: true,
            ..Default::default()
        });
        let http = http_client().expect("http client");
        let err = exchange_token_broker(&http, &base, "refresh", serde_json::json!({ "refresh_token": "DEAD" }))
            .await
            .expect_err("dead refresh must fail");
        assert!(matches!(err, CloudError::NotAuthenticated { .. }), "{err:?}");
    }

    #[tokio::test]
    async fn broker_refresh_502_is_offline_not_signed_out() {
        let (base, _) = start_mock_broker(MockBrokerBehavior {
            refresh_unreachable_box: true,
            ..Default::default()
        });
        let http = http_client().expect("http client");
        let err = exchange_token_broker(&http, &base, "refresh", serde_json::json!({ "refresh_token": "OLD" }))
            .await
            .expect_err("502 must fail");
        assert!(matches!(err, CloudError::Offline { .. }), "{err:?}");
    }

    #[tokio::test]
    async fn broker_unreachable_is_offline() {
        // A port nothing listens on: connect refused, not a 400.
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("probe bind");
        let port = listener.local_addr().expect("probe addr").port();
        drop(listener);
        let http = http_client().expect("http client");
        let err = broker_config(&http, &format!("http://127.0.0.1:{port}")).await.expect_err("must fail");
        assert!(matches!(err, CloudError::Offline { .. }), "{err:?}");
        let err = exchange_token_broker(
            &http,
            &format!("http://127.0.0.1:{port}"),
            "refresh",
            serde_json::json!({ "refresh_token": "OLD" }),
        )
        .await
        .expect_err("must fail");
        assert!(matches!(err, CloudError::Offline { .. }), "{err:?}");
    }

    #[tokio::test]
    async fn resolve_prefers_the_broker_when_it_answers() {
        let (base, _) = start_mock_broker(MockBrokerBehavior::default());
        let http = http_client().expect("http client");
        let resolved = resolve_credentials_with(Some(base), &http).await.expect("resolve");
        assert_eq!(resolved, ResolvedCredentials::Broker { client_id: "mock-client-id".into() });
        assert_eq!(resolved.source(), SecretSource::Broker);
    }
}
