//! Titer Box broker — first-party OAuth token broker for Box.
//!
//! The broker holds the Box OAuth client secret and performs the two token
//! exchanges the desktop app cannot do itself (Box requires a client secret
//! at the token endpoint; a secret must never ship in the app binary).
//!
//! Broker rules (research: "Cloud storage industry standard" §C):
//! - Exchange-only. The broker NEVER stores tokens: no database, no pending
//!   map, no token cache. Tokens exist only inside a single request.
//! - NEVER logs bodies, codes, verifiers, tokens, or the secret. Logs carry
//!   only method / path / status / duration, plus rate-limit events.
//! - Rate-limits per client IP (token bucket, 20 burst / 10 per minute).
//! - The client secret is the only credential it holds.
//!
//! API contract (v1) — the desktop client builds to this exact shape:
//! - `GET /health`  -> `{"status":"ok"}` (no auth)
//! - `GET /config`  -> `{"client_id":"..."}` (public; a client id is not secret)
//! - `POST /exchange` JSON `{"code","code_verifier","redirect_uri"}` ->
//!   Box token JSON `{"access_token","refresh_token","expires_in","token_type"}`
//! - `POST /refresh` JSON `{"refresh_token"}` -> new token JSON
//! - `POST /revoke` JSON `{"token"}` -> `{"revoked":true}`. Revokes the
//!   token at Box (`POST https://api.box.com/oauth2/revoke` with the
//!   broker-held client id + secret). The client sends the refresh token
//!   when it has one (it lives 60 days; the access token only 60 min).
//!
//! Upstream: `POST https://api.box.com/oauth2/token` (form-encoded), 30 s
//! timeout. Error mapping: Box `invalid_grant` -> 400, other Box 4xx -> 400,
//! Box 5xx or unreachable/timeout -> 502. `/revoke` maps the same way:
//! Box 4xx -> 400 (code passed through), Box 5xx / unreachable -> 502.

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use url::Url;

pub const DEFAULT_TOKEN_URL: &str = "https://api.box.com/oauth2/token";
pub const DEFAULT_REVOKE_URL: &str = "https://api.box.com/oauth2/revoke";
/// Upstream Box call timeout (task contract).
pub const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(30);
/// Rate limit: refill rate, requests per minute.
pub const RATE_REFILL_PER_MIN: f64 = 10.0;
/// Rate limit: bucket capacity (burst).
pub const RATE_BURST: f64 = 20.0;

/// A client secret that can never be printed by accident: Debug is redacted,
/// and there is no Display impl. The only place the inner value is used is
/// the form body sent to Box over TLS.
#[derive(Clone)]
pub struct ClientSecret(String);

impl ClientSecret {
    pub fn new(value: String) -> Self {
        Self(value)
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ClientSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ClientSecret([redacted])")
    }
}

/// One captured log line. The logger only ever receives lines built by
/// [`log_line`]-style call sites below; no request/response body, code,
/// verifier, token, or secret is ever passed to it.
pub type LogSink = Arc<dyn Fn(String) + Send + Sync>;

fn stderr_sink() -> LogSink {
    Arc::new(|line: String| eprintln!("{line}"))
}

/// Shared application state. Stateless by design: no token storage of any
/// kind — only config, an HTTP client, the rate limiter, and the log sink.
#[derive(Clone)]
pub struct AppState {
    pub client_id: String,
    pub client_secret: ClientSecret,
    pub token_url: String,
    pub revoke_url: String,
    pub http: reqwest::Client,
    pub limiter: Arc<RateLimiter>,
    pub log: LogSink,
}

impl AppState {
    pub fn new(
        client_id: String,
        client_secret: ClientSecret,
        token_url: String,
        revoke_url: String,
    ) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder()
            .timeout(UPSTREAM_TIMEOUT)
            .build()?;
        Ok(Self {
            client_id,
            client_secret,
            token_url,
            revoke_url,
            http,
            limiter: Arc::new(RateLimiter::new()),
            log: stderr_sink(),
        })
    }

    /// Test hook: swap the log sink for a capturing one.
    pub fn with_log_sink(mut self, sink: LogSink) -> Self {
        self.log = sink;
        self
    }

    fn log(&self, line: String) {
        (self.log)(line);
    }
}

// ── Rate limiter ──────────────────────────────────────────────────────────

/// Per-IP token bucket. Capacity [`RATE_BURST`], refilled at
/// [`RATE_REFILL_PER_MIN`] per minute. `check` returns `Ok(())` when a token
/// was consumed, or `Err(retry_after_secs)` when the bucket is empty.
pub struct RateLimiter {
    buckets: Mutex<HashMap<IpAddr, Bucket>>,
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn check(&self, ip: IpAddr) -> Result<(), u64> {
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let bucket = buckets.entry(ip).or_insert(Bucket {
            tokens: RATE_BURST,
            last: now,
        });
        let elapsed_min = now.duration_since(bucket.last).as_secs_f64() / 60.0;
        bucket.tokens = (bucket.tokens + elapsed_min * RATE_REFILL_PER_MIN).min(RATE_BURST);
        bucket.last = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            // Seconds until the next whole token refills.
            let wait = ((1.0 - bucket.tokens) / RATE_REFILL_PER_MIN * 60.0).ceil() as u64;
            Err(wait.max(1))
        }
    }
}

/// The client IP for rate limiting. The broker sits behind a Cloudflare
/// tunnel, so the socket peer is always the tunnel on localhost; in that
/// case — and only that case — the `CF-Connecting-IP` header carries the
/// real client IP. A remote caller cannot spoof its way around the limiter
/// with that header, because a non-loopback peer never gets the header
/// trusted.
pub fn client_ip(headers: &HeaderMap, peer: SocketAddr) -> IpAddr {
    if peer.ip().is_loopback() {
        if let Some(v) = headers.get("cf-connecting-ip") {
            if let Ok(s) = v.to_str() {
                if let Ok(ip) = s.trim().parse::<IpAddr>() {
                    return ip;
                }
            }
        }
    }
    peer.ip()
}

// ── Request / response shapes ─────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ExchangeRequest {
    pub code: String,
    pub code_verifier: String,
    pub redirect_uri: String,
}

#[derive(Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

/// The token to revoke: the client sends the refresh token when it has
/// one (60-day life), else the access token. Box revokes either.
#[derive(Deserialize)]
pub struct RevokeRequest {
    pub token: String,
}

/// Box token JSON, passed through verbatim. `refresh_token` is optional in
/// the parse only so a provider reply missing it is still a well-formed
/// error rather than a crash; Box returns it on both endpoints.
#[derive(Debug, Serialize, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_type: Option<String>,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

#[derive(Deserialize)]
struct BoxErrorBody {
    #[serde(default)]
    error: Option<String>,
}

fn bad_request(code: &str) -> (StatusCode, Json<ErrorBody>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorBody {
            error: code.to_string(),
        }),
    )
}

fn bad_gateway() -> (StatusCode, Json<ErrorBody>) {
    (
        StatusCode::BAD_GATEWAY,
        Json(ErrorBody {
            error: "upstream_error".to_string(),
        }),
    )
}

/// Defence-in-depth on top of Box's own exact-URI check: the redirect URI
/// must be a loopback `http` URI. Anything else is rejected before any
/// upstream call is made.
pub fn validate_redirect_uri(raw: &str) -> Result<(), &'static str> {
    let url = Url::parse(raw).map_err(|_| "invalid_redirect_uri")?;
    if url.scheme() != "http" {
        return Err("invalid_redirect_uri");
    }
    match url.host_str() {
        Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("::1") => Ok(()),
        _ => Err("invalid_redirect_uri"),
    }
}

fn non_empty(value: &str) -> bool {
    !value.trim().is_empty()
}

// ── Handlers ──────────────────────────────────────────────────────────────

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn config(State(state): State<AppState>) -> Json<serde_json::Value> {
    // client_id is public by design; the secret is never returned.
    Json(serde_json::json!({ "client_id": state.client_id }))
}

/// Shared upstream exchange. `form` holds the grant-specific fields; the
/// broker adds client_id + client_secret server-side. The upstream response
/// body is never logged; only its error *code* (e.g. `invalid_grant`) is
/// reflected to the caller, never its description.
async fn exchange_with_box(
    state: &AppState,
    form: &[(&str, &str)],
) -> Result<TokenResponse, (StatusCode, Json<ErrorBody>)> {
    let mut params: Vec<(&str, &str)> = form.to_vec();
    params.push(("client_id", &state.client_id));
    params.push(("client_secret", state.client_secret.expose()));
    let resp = state
        .http
        .post(&state.token_url)
        .form(&params)
        .send()
        .await
        .map_err(|_| bad_gateway())?;
    let status = resp.status();
    if status.is_success() {
        resp.json::<TokenResponse>().await.map_err(|_| bad_gateway())
    } else {
        // Map Box's error code only; drop the description (it can echo
        // request details) and never forward the raw body.
        let code = resp
            .json::<BoxErrorBody>()
            .await
            .ok()
            .and_then(|b| b.error)
            .unwrap_or_else(|| "invalid_request".to_string());
        if status.is_client_error() {
            // invalid_grant is the expected client failure (expired/used
            // code); every other Box 4xx is a bad request too.
            Err(bad_request(&code))
        } else {
            Err(bad_gateway())
        }
    }
}

/// Revokes one token at Box (`POST {revoke_url}`, form-encoded with the
/// broker-held client id + secret). Box answers 200 with an empty body on
/// success; a 4xx carries an error code (passed through, never the
/// description); 5xx / unreachable is a gateway failure. The token itself
/// is never logged.
async fn revoke_with_box(state: &AppState, token: &str) -> Result<(), (StatusCode, Json<ErrorBody>)> {
    let form = [
        ("client_id", state.client_id.as_str()),
        ("client_secret", state.client_secret.expose()),
        ("token", token),
    ];
    let resp = state.http.post(&state.revoke_url).form(&form).send().await.map_err(|_| bad_gateway())?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else if status.is_client_error() {
        // Box's revoke error body may be empty; default the code rather
        // than failing the parse.
        let code = resp
            .json::<BoxErrorBody>()
            .await
            .ok()
            .and_then(|b| b.error)
            .unwrap_or_else(|| "invalid_request".to_string());
        Err(bad_request(&code))
    } else {
        Err(bad_gateway())
    }
}

async fn exchange(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<ExchangeRequest>,
) -> Response {
    let ip = client_ip(&headers, peer);
    if let Err(retry_after) = state.limiter.check(ip) {
        state.log(format!(
            "rate_limited method=POST path=/exchange ip={ip} retry_after={retry_after}"
        ));
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(axum::http::header::RETRY_AFTER, retry_after.to_string())],
            Json(ErrorBody {
                error: "rate_limited".to_string(),
            }),
        )
            .into_response();
    }
    if !non_empty(&req.code) || !non_empty(&req.code_verifier) || !non_empty(&req.redirect_uri) {
        return bad_request("invalid_request").into_response();
    }
    if let Err(code) = validate_redirect_uri(&req.redirect_uri) {
        return bad_request(code).into_response();
    }
    let form = [
        ("grant_type", "authorization_code"),
        ("code", req.code.as_str()),
        ("code_verifier", req.code_verifier.as_str()),
        ("redirect_uri", req.redirect_uri.as_str()),
    ];
    match exchange_with_box(&state, &form).await {
        Ok(tokens) => (StatusCode::OK, Json(tokens)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn refresh(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RefreshRequest>,
) -> Response {
    let ip = client_ip(&headers, peer);
    if let Err(retry_after) = state.limiter.check(ip) {
        state.log(format!(
            "rate_limited method=POST path=/refresh ip={ip} retry_after={retry_after}"
        ));
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(axum::http::header::RETRY_AFTER, retry_after.to_string())],
            Json(ErrorBody {
                error: "rate_limited".to_string(),
            }),
        )
            .into_response();
    }
    if !non_empty(&req.refresh_token) {
        return bad_request("invalid_request").into_response();
    }
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", req.refresh_token.as_str()),
    ];
    match exchange_with_box(&state, &form).await {
        Ok(tokens) => (StatusCode::OK, Json(tokens)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn revoke(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RevokeRequest>,
) -> Response {
    let ip = client_ip(&headers, peer);
    if let Err(retry_after) = state.limiter.check(ip) {
        state.log(format!(
            "rate_limited method=POST path=/revoke ip={ip} retry_after={retry_after}"
        ));
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(axum::http::header::RETRY_AFTER, retry_after.to_string())],
            Json(ErrorBody {
                error: "rate_limited".to_string(),
            }),
        )
            .into_response();
    }
    if !non_empty(&req.token) {
        return bad_request("invalid_request").into_response();
    }
    match revoke_with_box(&state, &req.token).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "revoked": true }))).into_response(),
        Err(e) => e.into_response(),
    }
}

/// Access log middleware. Logs method, path, status, and duration only —
/// never headers, bodies, codes, verifiers, or tokens.
async fn access_log(
    State(state): State<AppState>,
    req: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let start = Instant::now();
    let resp = next.run(req).await;
    let elapsed_ms = start.elapsed().as_millis();
    state.log(format!(
        "method={method} path={path} status={} duration_ms={elapsed_ms}",
        resp.status().as_u16()
    ));
    resp
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/config", get(config))
        .route("/exchange", post(exchange))
        .route("/refresh", post(refresh))
        .route("/revoke", post(revoke))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            access_log,
        ))
        .with_state(state)
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;
    use tower::ServiceExt;

    /// Captured log lines for the never-logs-tokens test.
    #[derive(Default)]
    struct CapturedLogs(Mutex<Vec<String>>);

    fn capturing_sink(logs: Arc<CapturedLogs>) -> LogSink {
        Arc::new(move |line: String| {
            logs.0.lock().unwrap().push(line);
        })
    }

    /// A mock Box token endpoint. Behaviour is driven by the `code` /
    /// `refresh_token` value so each test gets the upstream reply it needs:
    /// - "bad-code" / "bad-refresh" -> 400 `{"error":"invalid_grant"}`
    /// - "server-error"            -> 500 `{"error":"server_error"}`
    /// - anything else             -> 200 with sentinel tokens
    /// The mock also serves the revoke endpoint (`POST /oauth2/revoke`,
    /// same secret check): "bad-token" -> 400 `{"error":"invalid_request"}`,
    /// "server-error" -> 500, anything else -> 200 with an empty body,
    /// exactly like Box. Returns the mock's base URL; the token URL is
    /// `{base}/oauth2/token`, the revoke URL `{base}/oauth2/revoke`.
    async fn mock_box_server() -> (String, tokio::task::JoinHandle<()>) {
        async fn token(
            axum::Form(form): axum::Form<HashMap<String, String>>,
        ) -> (StatusCode, Json<serde_json::Value>) {
            // The mock asserts the broker actually sends the secret (a
            // test-only check: the real secret is never asserted on here).
            assert_eq!(
                form.get("client_id").map(String::as_str),
                Some("TEST_CLIENT_ID")
            );
            assert_eq!(
                form.get("client_secret").map(String::as_str),
                Some("TEST_CLIENT_SECRET")
            );
            let grant = form.get("grant_type").cloned().unwrap_or_default();
            let key = if grant == "refresh_token" {
                form.get("refresh_token").cloned().unwrap_or_default()
            } else {
                form.get("code").cloned().unwrap_or_default()
            };
            match key.as_str() {
                "bad-code" | "bad-refresh" => (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "invalid_grant", "error_description": "x"})),
                ),
                "server-error" => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "server_error"})),
                ),
                _ => (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "access_token": "ACCESS-TOKEN-SENTINEL-7f3a",
                        "refresh_token": "REFRESH-TOKEN-SENTINEL-9c1e",
                        "expires_in": 3600,
                        "token_type": "bearer",
                    })),
                ),
            }
        }
        async fn revoke(axum::Form(form): axum::Form<HashMap<String, String>>) -> (StatusCode, String) {
            assert_eq!(
                form.get("client_id").map(String::as_str),
                Some("TEST_CLIENT_ID")
            );
            assert_eq!(
                form.get("client_secret").map(String::as_str),
                Some("TEST_CLIENT_SECRET")
            );
            match form.get("token").map(String::as_str).unwrap_or("") {
                "bad-token" => (
                    StatusCode::BAD_REQUEST,
                    r#"{"error":"invalid_request"}"#.to_string(),
                ),
                "server-error" => (StatusCode::INTERNAL_SERVER_ERROR, r#"{"error":"server_error"}"#.to_string()),
                _ => (StatusCode::OK, String::new()),
            }
        }
        let app = Router::new()
            .route("/oauth2/token", post(token))
            .route("/oauth2/revoke", post(revoke));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), handle)
    }

    fn test_state(base_url: String) -> (AppState, Arc<CapturedLogs>) {
        let logs = Arc::new(CapturedLogs::default());
        let state = AppState::new(
            "TEST_CLIENT_ID".to_string(),
            ClientSecret::new("TEST_CLIENT_SECRET".to_string()),
            format!("{base_url}/oauth2/token"),
            format!("{base_url}/oauth2/revoke"),
        )
        .unwrap()
        .with_log_sink(capturing_sink(logs.clone()));
        (state, logs)
    }

    /// Serve the app on an ephemeral loopback port with ConnectInfo, like
    /// production, so rate limiting sees a real peer IP.
    async fn serve_app(state: AppState) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let app = build_router(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        (addr, handle)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::new()
    }

    #[tokio::test]
    async fn health_and_config() {
        let (token_url, mock) = mock_box_server().await;
        let (state, _) = test_state(token_url);
        let (addr, server) = serve_app(state).await;
        let c = client();
        let h: serde_json::Value = c
            .get(format!("http://{addr}/health"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(h["status"], "ok");
        let cfg: serde_json::Value = c
            .get(format!("http://{addr}/config"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(cfg["client_id"], "TEST_CLIENT_ID");
        assert!(cfg.get("client_secret").is_none());
        server.abort();
        mock.abort();
    }

    #[tokio::test]
    async fn exchange_happy_path() {
        let (token_url, mock) = mock_box_server().await;
        let (state, _) = test_state(token_url);
        let (addr, server) = serve_app(state).await;
        let c = client();
        let resp = c
            .post(format!("http://{addr}/exchange"))
            .json(&serde_json::json!({
                "code": "AUTH-CODE-SENTINEL-1111",
                "code_verifier": "VERIFIER-SENTINEL-2222",
                "redirect_uri": "http://127.0.0.1:54321/oauth",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body: TokenResponse = resp.json().await.unwrap();
        assert_eq!(body.access_token, "ACCESS-TOKEN-SENTINEL-7f3a");
        assert_eq!(
            body.refresh_token.as_deref(),
            Some("REFRESH-TOKEN-SENTINEL-9c1e")
        );
        assert_eq!(body.expires_in, Some(3600));
        assert_eq!(body.token_type.as_deref(), Some("bearer"));
        server.abort();
        mock.abort();
    }

    #[tokio::test]
    async fn refresh_happy_path() {
        let (token_url, mock) = mock_box_server().await;
        let (state, _) = test_state(token_url);
        let (addr, server) = serve_app(state).await;
        let c = client();
        let resp = c
            .post(format!("http://{addr}/refresh"))
            .json(&serde_json::json!({"refresh_token": "OLD-REFRESH-SENTINEL-3333"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body: TokenResponse = resp.json().await.unwrap();
        assert_eq!(body.access_token, "ACCESS-TOKEN-SENTINEL-7f3a");
        server.abort();
        mock.abort();
    }

    #[tokio::test]
    async fn revoke_happy_path() {
        let (base, mock) = mock_box_server().await;
        let (state, _) = test_state(base);
        let (addr, server) = serve_app(state).await;
        let c = client();
        let resp = c
            .post(format!("http://{addr}/revoke"))
            .json(&serde_json::json!({"token": "REFRESH-TOKEN-SENTINEL-9c1e"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body["revoked"], true);
        server.abort();
        mock.abort();
    }

    #[tokio::test]
    async fn revoke_bad_token_maps_to_400() {
        let (base, mock) = mock_box_server().await;
        let (state, _) = test_state(base);
        let (addr, server) = serve_app(state).await;
        let c = client();
        let resp = c
            .post(format!("http://{addr}/revoke"))
            .json(&serde_json::json!({"token": "bad-token"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body["error"], "invalid_request");
        server.abort();
        mock.abort();
    }

    #[tokio::test]
    async fn revoke_box_5xx_maps_to_502() {
        let (base, mock) = mock_box_server().await;
        let (state, _) = test_state(base);
        let (addr, server) = serve_app(state).await;
        let c = client();
        let resp = c
            .post(format!("http://{addr}/revoke"))
            .json(&serde_json::json!({"token": "server-error"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
        server.abort();
        mock.abort();
    }

    #[tokio::test]
    async fn revoke_empty_token_is_400_without_upstream() {
        let (base, mock) = mock_box_server().await;
        let (state, _) = test_state(base);
        let (addr, server) = serve_app(state).await;
        let c = client();
        let resp = c
            .post(format!("http://{addr}/revoke"))
            .json(&serde_json::json!({"token": "   "}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body["error"], "invalid_request");
        server.abort();
        mock.abort();
    }

    #[tokio::test]
    async fn invalid_grant_maps_to_400() {
        let (token_url, mock) = mock_box_server().await;
        let (state, _) = test_state(token_url);
        let (addr, server) = serve_app(state).await;
        let c = client();
        for (path, payload) in [
            (
                "/exchange",
                serde_json::json!({
                    "code": "bad-code",
                    "code_verifier": "v",
                    "redirect_uri": "http://127.0.0.1:1/oauth",
                }),
            ),
            (
                "/refresh",
                serde_json::json!({"refresh_token": "bad-refresh"}),
            ),
        ] {
            let resp = c
                .post(format!("http://{addr}{path}"))
                .json(&payload)
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{path}");
            let body: serde_json::Value = resp.json().await.unwrap();
            assert_eq!(body["error"], "invalid_grant", "{path}");
        }
        server.abort();
        mock.abort();
    }

    #[tokio::test]
    async fn box_5xx_maps_to_502() {
        let (token_url, mock) = mock_box_server().await;
        let (state, _) = test_state(token_url);
        let (addr, server) = serve_app(state).await;
        let c = client();
        let resp = c
            .post(format!("http://{addr}/exchange"))
            .json(&serde_json::json!({
                "code": "server-error",
                "code_verifier": "v",
                "redirect_uri": "http://127.0.0.1:1/oauth",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
        server.abort();
        mock.abort();
    }

    #[tokio::test]
    async fn box_unreachable_maps_to_502() {
        // Point at a closed loopback port: nothing listens there.
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead = probe.local_addr().unwrap();
        drop(probe);
        let (state, _) = test_state(format!("http://{dead}"));
        let (addr, server) = serve_app(state).await;
        let c = client();
        let resp = c
            .post(format!("http://{addr}/exchange"))
            .json(&serde_json::json!({
                "code": "any-code",
                "code_verifier": "v",
                "redirect_uri": "http://127.0.0.1:1/oauth",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
        server.abort();
    }

    #[test]
    fn redirect_uri_validation() {
        assert!(validate_redirect_uri("http://127.0.0.1:54321/oauth").is_ok());
        assert!(validate_redirect_uri("http://localhost:8080/cb").is_ok());
        assert!(validate_redirect_uri("http://[::1]:8080/cb").is_ok());
        assert!(validate_redirect_uri("https://127.0.0.1:54321/oauth").is_err());
        assert!(validate_redirect_uri("http://evil.example.com/oauth").is_err());
        assert!(validate_redirect_uri("http://127.0.0.1.evil.com/oauth").is_err());
        assert!(validate_redirect_uri("http://192.168.1.5/oauth").is_err());
        assert!(validate_redirect_uri("not-a-url").is_err());
        assert!(validate_redirect_uri("").is_err());
    }

    #[tokio::test]
    async fn redirect_uri_rejected_before_upstream() {
        // The mock counts token calls; a rejected redirect must never reach Box.
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        async fn token(
            axum::Form(_form): axum::Form<HashMap<String, String>>,
        ) -> (StatusCode, Json<serde_json::Value>) {
            CALLS.fetch_add(1, Ordering::SeqCst);
            (
                StatusCode::OK,
                Json(serde_json::json!({"access_token": "x"})),
            )
        }
        let app = Router::new().route("/oauth2/token", post(token));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mock_addr = listener.local_addr().unwrap();
        let mock = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (state, _) = test_state(format!("http://{mock_addr}"));
        let (addr, server) = serve_app(state).await;
        let c = client();
        let resp = c
            .post(format!("http://{addr}/exchange"))
            .json(&serde_json::json!({
                "code": "any-code",
                "code_verifier": "v",
                "redirect_uri": "https://attacker.example.com/cb",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body["error"], "invalid_redirect_uri");
        assert_eq!(CALLS.load(Ordering::SeqCst), 0, "upstream must not be called");
        server.abort();
        mock.abort();
    }

    #[tokio::test]
    async fn rate_limit_429_with_retry_after() {
        let (token_url, mock) = mock_box_server().await;
        let (state, _) = test_state(token_url);
        let (addr, server) = serve_app(state).await;
        let c = client();
        // Burst is 20: the first 20 exchange calls succeed, the 21st is 429.
        // Use one CF-Connecting-IP so all calls share one bucket (the test
        // peer is loopback, exactly like the tunnel in production).
        let mut last_status = StatusCode::OK;
        let mut saw_429 = false;
        for i in 0..25 {
            let resp = c
                .post(format!("http://{addr}/exchange"))
                .header("cf-connecting-ip", "203.0.113.7")
                .json(&serde_json::json!({
                    "code": format!("code-{i}"),
                    "code_verifier": "v",
                    "redirect_uri": "http://127.0.0.1:1/oauth",
                }))
                .send()
                .await
                .unwrap();
            last_status = resp.status();
            if last_status == StatusCode::TOO_MANY_REQUESTS {
                saw_429 = true;
                assert!(
                    resp.headers().contains_key(axum::http::header::RETRY_AFTER),
                    "429 must carry Retry-After"
                );
                let body: serde_json::Value = resp.json().await.unwrap();
                assert_eq!(body["error"], "rate_limited");
                break;
            }
        }
        assert!(saw_429, "expected a 429 within 25 calls, last={last_status}");
        // A different client IP still has its own full bucket.
        let resp = c
            .post(format!("http://{addr}/exchange"))
            .header("cf-connecting-ip", "198.51.100.9")
            .json(&serde_json::json!({
                "code": "other-ip-code",
                "code_verifier": "v",
                "redirect_uri": "http://127.0.0.1:1/oauth",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        server.abort();
        mock.abort();
    }

    #[tokio::test]
    async fn never_logs_tokens_codes_verifiers_or_secret() {
        let (token_url, mock) = mock_box_server().await;
        let (state, logs) = test_state(token_url);
        let (addr, server) = serve_app(state).await;
        let c = client();
        // Sentinel values: if any of these ever appears in a log line, the test fails.
        let sentinels = [
            "AUTH-CODE-SENTINEL-1111",
            "VERIFIER-SENTINEL-2222",
            "OLD-REFRESH-SENTINEL-3333",
            "ACCESS-TOKEN-SENTINEL-7f3a",
            "REFRESH-TOKEN-SENTINEL-9c1e",
            "TEST_CLIENT_SECRET",
            "REVOKE-TOKEN-SENTINEL-4444",
        ];
        let _ = c
            .post(format!("http://{addr}/exchange"))
            .json(&serde_json::json!({
                "code": sentinels[0],
                "code_verifier": sentinels[1],
                "redirect_uri": "http://127.0.0.1:54321/oauth",
            }))
            .send()
            .await
            .unwrap();
        let _ = c
            .post(format!("http://{addr}/refresh"))
            .json(&serde_json::json!({"refresh_token": sentinels[2]}))
            .send()
            .await
            .unwrap();
        let _ = c
            .post(format!("http://{addr}/revoke"))
            .json(&serde_json::json!({"token": sentinels[6]}))
            .send()
            .await
            .unwrap();
        // Force a rate-limit log line too: 25 rapid calls from one IP.
        for i in 0..25 {
            let _ = c
                .post(format!("http://{addr}/exchange"))
                .header("cf-connecting-ip", "203.0.113.7")
                .json(&serde_json::json!({
                    "code": format!("code-{i}"),
                    "code_verifier": "v",
                    "redirect_uri": "http://127.0.0.1:1/oauth",
                }))
                .send()
                .await
                .unwrap();
        }
        let captured = logs.0.lock().unwrap().join("\n");
        assert!(
            !captured.is_empty(),
            "expected access-log lines to have been captured"
        );
        for s in sentinels {
            assert!(
                !captured.contains(s),
                "log leaked secret material: {s}\n--- logs ---\n{captured}"
            );
        }
        // And the log shape is only method/path/status/duration (+ rate-limit events).
        for line in logs.0.lock().unwrap().iter() {
            assert!(
                line.starts_with("method=") || line.starts_with("rate_limited "),
                "unexpected log shape: {line}"
            );
        }
        server.abort();
        mock.abort();
    }

    #[test]
    fn secret_debug_is_redacted() {
        let s = ClientSecret::new("super-secret-value".to_string());
        assert!(!format!("{s:?}").contains("super-secret-value"));
    }

    /// In-process smoke check of the router without a socket (used by the
    /// targeted pre-fix/post-fix loop for handler wiring).
    #[tokio::test]
    async fn router_health_oneshot() {
        let (token_url, mock) = mock_box_server().await;
        let (state, _) = test_state(token_url);
        let app = build_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        mock.abort();
    }
}
