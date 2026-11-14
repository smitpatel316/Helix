// titer-stdio-bridge — the pipe between an MCP client and Titer's in-app server.
//
// Claude Desktop (and any stdio MCP client) launches this binary as a
// subprocess and speaks newline-delimited JSON-RPC 2.0 over stdin/stdout.
// Titer's MCP server speaks Streamable HTTP on 127.0.0.1 (see
// docs/mcp-server-contract.md, owned by the v3/mcp-server lane). This bridge
// translates between the two transports and nothing else: it forwards each
// JSON-RPC message verbatim as one HTTP POST, and turns the HTTP reply back
// into one JSON-RPC message per line on stdout. It never interprets tool
// calls, results, or prompts, and it never touches the network beyond
// loopback.
//
// Token discovery (the decision — see docs/stdio-bridge.md §2 for the full
// reasoning): the app writes a discovery file, `<app_data_dir>/mcp/discovery.json`
// (`{"endpoint", "token", "protocol_versions", ...}` — see
// docs/mcp-server-contract.md §2, owned by the v3/mcp-server lane), atomically
// with mode 0600, when the user turns on AI connections in Settings; the
// bridge reads it at startup. No token is ever baked into the .mcpb bundle or
// into any AI client's config. `TITER_MCP_URL` / `TITER_MCP_TOKEN` /
// `TITER_MCP_DISCOVERY` env vars override individual fields, for dev and for
// Claude Code users who run the bridge by hand.
//
// The server REQUIRES an `MCP-Protocol-Version` header on every request
// (its auth middleware answers 400 without one — contract §3). The bridge
// sends it on every POST, taking the value from the client's `initialize`
// request when it names a 2025 revision the server speaks, else 2025-11-25.
//
// Failure behaviour (a requirement, not an accident):
//   * Discovery file missing/unreadable, or no token: print a clear message
//     to stderr and exit 2. Never hang, never panic, never emit a bare
//     "connection refused" — the user must be told to enable AI connections
//     in Titer Settings.
//   * Server down mid-session (app closed after the bridge started): each
//     affected request gets a JSON-RPC -32000 error carrying that same
//     message, and the bridge stays alive, so it works again as soon as the
//     user opens Titer — no restart of the AI client needed.
//   * stdin EOF, or stdout closed (client exited): exit 0, quietly.
//
// Deliberate Phase 1 limits (documented, not hidden):
//   * Sequential: one HTTP round-trip at a time, in stdin order. A slow tool
//     call blocks later messages (including `ping`). Acceptable for Phase 1:
//     the server itself dispatches on the app's main thread (roadmap §1), so
//     true concurrency buys nothing until the server does.
//   * No JSON-RPC batches: Streamable HTTP forbids them, so a batch line is
//     rejected with -32600 per member id.
//   * Protocol-version agnostic: the bridge forwards bytes, so it works with
//     any spec revision the server speaks (2025-06-18 / 2025-11-25 per the
//     roadmap; NOT 2026-07-28 until the clients adopt it).
//
// BUILD STATUS: built + verified in the v3/claude-desktop lane (cargo test,
// smoke test against a contract-faithful fake server, mcpb validate/pack).
// See docs/stdio-bridge.md §6 and
// ~/workspace/.helix-mcp-claude-desktop/investigations.md.

use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::Value;
use std::{
    env, fs,
    io::{self, BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::Duration,
};

/// Titer's Tauri bundle identifier — the app-data directory is derived from
/// it, exactly as the app's own `app.path().app_data_dir()` does.
const APP_IDENTIFIER: &str = "net.smitpatel.helix";

/// Name of the discovery-file directory inside the app-data directory, and
/// of the file itself. Written by the app (v3/mcp-server lane); read by this
/// bridge. Contract pinned in docs/mcp-server-contract.md §2 (the file is
/// `<app_data>/mcp/discovery.json`). The `mcp/` subdir also holds the token
/// file and the Activity log — all of them owner-only.
const DISCOVERY_DIR: &str = "mcp";
const DISCOVERY_FILE: &str = "discovery.json";

/// The protocol version sent in the `MCP-Protocol-Version` header when the
/// client has not (yet) named one in `initialize`. The server speaks
/// 2025-06-18 / 2025-11-25 only (contract §1); 2025-11-25 is its newest.
const DEFAULT_PROTOCOL_VERSION: &str = "2025-11-25";

/// One request may run a slow analysis; 5 minutes is generous without
/// letting a wedged server hang the client forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Protocol revisions the server negotiates. A client offering anything else
/// (e.g. 2026-07-28, which Claude Desktop does not speak yet) still gets a
/// 2025 header from the bridge — the server answers `initialize` with the
/// highest revision both sides support.
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 2] = ["2025-11-25", "2025-06-18"];

/// The message the user sees whenever the server is not reachable. Wording
/// is the contract's (§1) canonical message, so the bridge, the Settings
/// page and the docs all name the same fix in the same words.
const SERVER_OFF_MESSAGE: &str = "Titer's AI connections are off or Titer isn't running. \
    Turn on 'Allow AI apps to connect' in Titer → Settings → AI connections, \
    then try again.";

/// Surfaced when the server answers 401 after a discovery re-read (contract
/// §3): the token in the discovery file no longer matches the running server.
const TOKEN_CHANGED_MESSAGE: &str = "The token changed — restart the bridge \
    (or re-check Titer → Settings → AI connections).";

/// What the app writes to `<app_data_dir>/mcp/discovery.json` when AI
/// connections are enabled. `endpoint` is the contract field (§2); `url`
/// and the singular `protocol_version` are the pre-contract draft names,
/// still accepted so a bridge built against the draft keeps working.
/// `protocol_versions` is informational only — the bridge forwards bytes
/// and negotiates nothing itself, but it sends the first listed revision
/// as the `MCP-Protocol-Version` header until the client's `initialize`
/// names one.
#[derive(Debug, Deserialize)]
struct Discovery {
    endpoint: Option<String>,
    #[serde(default)]
    url: Option<String>,
    token: String,
    #[serde(default)]
    protocol_versions: Option<Vec<String>>,
    #[serde(default)]
    protocol_version: Option<String>,
}

/// Resolved runtime config: where to POST, and with which bearer token.
/// `explicit_discovery` is remembered so a 401 can re-read the file and
/// retry once with a rotated token instead of failing the session.
#[derive(Debug)]
struct BridgeConfig {
    url: String,
    token: String,
    protocol_version: Option<String>,
    explicit_discovery: Option<PathBuf>,
}

/// Where Tauri puts the app-data directory for this bundle id, per OS.
/// Must match `app.path().app_data_dir()` in the app; verified at
/// integration time (the bridge cannot call Tauri — it is a standalone
/// binary, and duplicating three short paths is safer than a new dep).
fn default_app_data_dir() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        // HOME is required here; on Windows it is usually unset, so the
        // Windows branch below must not depend on it.
        let home = env::var_os("HOME")?;
        Some(PathBuf::from(home).join("Library/Application Support").join(APP_IDENTIFIER))
    } else if cfg!(target_os = "windows") {
        // Tauri's app_data_dir on Windows is the roaming %APPDATA% dir.
        let appdata = env::var_os("APPDATA")?;
        Some(PathBuf::from(appdata).join(APP_IDENTIFIER))
    } else {
        // Linux: $XDG_DATA_HOME, else ~/.local/share.
        let home = env::var_os("HOME")?;
        match env::var_os("XDG_DATA_HOME") {
            Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir).join(APP_IDENTIFIER)),
            _ => Some(PathBuf::from(home).join(".local/share").join(APP_IDENTIFIER)),
        }
    }
}

/// Resolve the discovery file location: `--discovery <path>`, else
/// `TITER_MCP_DISCOVERY`, else `<app_data_dir>/mcp/discovery.json`.
fn discovery_path(explicit: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        return Some(p.to_path_buf());
    }
    if let Some(p) = env::var_os("TITER_MCP_DISCOVERY") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    default_app_data_dir().map(|d| d.join(DISCOVERY_DIR).join(DISCOVERY_FILE))
}

/// Load the config. Env vars override individual fields of the discovery
/// file, so a dev can point the bridge at a test server without touching
/// the file Titer owns. Returns a user-facing error string on failure — the
/// caller prints it to stderr and exits 2.
fn load_config(explicit_discovery: Option<&Path>) -> Result<BridgeConfig, String> {
    let mut url = env::var("TITER_MCP_URL").ok().filter(|v| !v.is_empty());
    let mut token = env::var("TITER_MCP_TOKEN").ok().filter(|v| !v.is_empty());
    let mut protocol_version = None;

    if url.is_none() || token.is_none() {
        let path = discovery_path(explicit_discovery).ok_or_else(|| {
            format!(
                "Could not locate Titer's app-data directory. {SERVER_OFF_MESSAGE} \
                 (TITER_MCP_DISCOVERY / TITER_MCP_URL + TITER_MCP_TOKEN can override this.)"
            )
        });
        let path = path?;
        let text = fs::read_to_string(&path).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => {
                format!("Titer's AI connection file was not found ({}). {SERVER_OFF_MESSAGE}", path.display())
            }
            _ => format!("Could not read Titer's AI connection file ({}): {e}. {SERVER_OFF_MESSAGE}", path.display()),
        })?;
        let disc: Discovery = serde_json::from_str(&text).map_err(|e| {
            format!(
                "Titer's AI connection file ({}) is not valid JSON: {e}. \
                 Turn AI connections off and on again in Titer Settings to regenerate it.",
                path.display()
            )
        })?;
        if url.is_none() {
            // Contract field first, pre-contract draft name as fallback.
            url = disc.endpoint.or(disc.url);
        }
        if token.is_none() {
            token = Some(disc.token);
        }
        protocol_version = disc.protocol_versions.and_then(|vs| vs.into_iter().next()).or(disc.protocol_version);
    }

    match (url, token) {
        (Some(url), Some(token)) if !url.is_empty() && !token.is_empty() => Ok(BridgeConfig {
            url,
            token,
            protocol_version,
            explicit_discovery: explicit_discovery.map(Path::to_path_buf),
        }),
        _ => Err(format!("Titer's AI connection has no server URL or token. {SERVER_OFF_MESSAGE}")),
    }
}

/// Shape one JSON-RPC error reply. `id` is cloned from the request so the
/// client can match it; `Value::Null` when the request had no usable id.
fn jsonrpc_error(id: &Value, code: i64, message: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
    .to_string()
}

/// Split a `text/event-stream` body into its `data:` payloads. One blank
/// line separates events; multiple `data:` lines in one event are joined
/// with "\n" per the SSE spec (one JSON-RPC message per event for MCP).
/// Comment (`:`) and `event:` / `id:` lines are ignored.
fn sse_messages(body: &str) -> Vec<String> {
    let mut messages = Vec::new();
    let mut data_lines: Vec<&str> = Vec::new();
    for line in body.lines() {
        if line.is_empty() {
            if !data_lines.is_empty() {
                messages.push(data_lines.join("\n"));
                data_lines.clear();
            }
        } else if let Some(rest) = line.strip_prefix("data: ") {
            data_lines.push(rest);
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest);
        }
        // Anything else (": comment", "event: ...", "id: ...") is ignored.
    }
    if !data_lines.is_empty() {
        messages.push(data_lines.join("\n"));
    }
    messages
}

fn content_type_is(headers: &reqwest::header::HeaderMap, needle: &str) -> bool {
    headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.to_ascii_lowercase().contains(needle))
}

/// Outcome of forwarding one client message.
enum ForwardOutcome {
    /// Messages to write to stdout, in order (usually exactly one).
    Messages(Vec<String>),
    /// Notification accepted (HTTP 202) — nothing to write back.
    NoResponse,
    /// The request failed; the string is a ready-to-send JSON-RPC error line.
    Failed(String),
}

/// One HTTP POST to the server. The `MCP-Protocol-Version` header is
/// REQUIRED by the server's auth middleware (contract §3): without it the
/// server answers 400 before rmcp ever sees the request. The value is the
/// revision the client's `initialize` named, else the server's advertised
/// revision, else 2025-11-25 (see `initialize_protocol_version`).
fn post_once(
    client: &Client,
    cfg: &BridgeConfig,
    session_id: &Option<String>,
    protocol_version: &str,
    line: &str,
) -> Result<reqwest::blocking::Response, reqwest::Error> {
    let mut req = client
        .post(cfg.url.as_str())
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", protocol_version)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .body(line.to_string());
    if let Some(sid) = session_id.as_deref() {
        req = req.header("Mcp-Session-Id", sid);
    }
    req.send()
}

/// The protocol version the client names in `initialize` (contract §4),
/// when it is one the server speaks. The bridge forwards bytes and does not
/// negotiate — but the `MCP-Protocol-Version` header it sends must name a
/// revision the server accepts, so an unrecognised offer (e.g. 2026-07-28,
/// which no Desktop client speaks yet) falls back to the default instead of
/// being echoed back at a server that would reject it.
fn initialize_protocol_version(value: &Value) -> Option<String> {
    if value.get("method").and_then(Value::as_str) != Some("initialize") {
        return None;
    }
    let offered = value.get("params")?.get("protocolVersion")?.as_str()?;
    if SUPPORTED_PROTOCOL_VERSIONS.contains(&offered) {
        Some(offered.to_string())
    } else {
        None
    }
}

/// Close the server session when the client goes away (contract §4.5):
/// DELETE the endpoint with the session id. Best-effort — the server also
/// expires idle sessions — so every failure mode here is silent.
fn close_session(client: &Client, cfg: &BridgeConfig, protocol_version: &str, session_id: &str) {
    let _ = client
        .delete(cfg.url.as_str())
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", protocol_version)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .header("Mcp-Session-Id", session_id)
        .send();
}

/// Forward one raw JSON-RPC line to the Streamable HTTP endpoint.
/// `session_id` is the `Mcp-Session-Id` the server returned at initialize
/// (if any); it is sent on every subsequent request and refreshed whenever
/// the server returns a new one.
fn forward(
    client: &Client,
    cfg: &mut BridgeConfig,
    session_id: &mut Option<String>,
    protocol_version: &str,
    line: &str,
    request_id: &Value,
    is_notification: bool,
) -> ForwardOutcome {
    let mut resp = match post_once(client, cfg, session_id, protocol_version, line) {
        Ok(r) => r,
        Err(e) => {
            // The server is down (or never started): the client gets the
            // clear message, not reqwest's "connection refused".
            let message = if e.is_connect() {
                SERVER_OFF_MESSAGE.to_string()
            } else if e.is_timeout() {
                "Titer took too long to answer (>5 min). The analysis may still be \
                 running in Titer — check the Activity log there."
                    .to_string()
            } else {
                format!("Could not reach Titer's MCP server: {e}. {SERVER_OFF_MESSAGE}")
            };
            if is_notification {
                eprintln!("titer-stdio-bridge: notification failed: {message}");
                return ForwardOutcome::NoResponse;
            }
            return ForwardOutcome::Failed(jsonrpc_error(request_id, -32000, &message));
        }
    };

    // 401: the token may have rotated since this bridge started (contract
    // §2). Re-read the discovery file once and retry once with the fresh
    // token; a second 401 gets the contract's token-changed message, not
    // the server's plain-text body.
    if resp.status().as_u16() == 401 {
        let mut retried = false;
        if let Ok(fresh) = load_config(cfg.explicit_discovery.as_deref()) {
            if fresh.token != cfg.token || fresh.url != cfg.url {
                *cfg = fresh;
                if let Ok(r) = post_once(client, cfg, session_id, protocol_version, line) {
                    resp = r;
                    retried = true;
                }
            }
        }
        if !retried || resp.status().as_u16() == 401 {
            if is_notification {
                eprintln!("titer-stdio-bridge: notification failed: {TOKEN_CHANGED_MESSAGE}");
                return ForwardOutcome::NoResponse;
            }
            return ForwardOutcome::Failed(jsonrpc_error(request_id, -32000, TOKEN_CHANGED_MESSAGE));
        }
    }

    if let Some(sid) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
        *session_id = Some(sid.to_string());
    }

    let status = resp.status();
    if status.as_u16() == 202 {
        // Accepted with no response body — the Streamable HTTP answer for
        // notifications (and responses to server requests). A *request*
        // answered 202 is a server bug: say so instead of hanging.
        if is_notification {
            return ForwardOutcome::NoResponse;
        }
        return ForwardOutcome::Failed(jsonrpc_error(
            request_id,
            -32000,
            "Titer's MCP server accepted the request but returned no response. \
             Try again; if it repeats, restart Titer.",
        ));
    }

    let is_json = content_type_is(resp.headers(), "application/json");
    let is_sse = content_type_is(resp.headers(), "text/event-stream");
    let body = match resp.text() {
        Ok(b) => b,
        Err(e) => {
            return ForwardOutcome::Failed(jsonrpc_error(
                request_id,
                -32000,
                &format!("Could not read Titer's MCP response: {e}"),
            ))
        }
    };

    if !status.is_success() {
        // If the server already shaped a JSON-RPC error, pass it through
        // verbatim; otherwise synthesise one with the HTTP status.
        if let Ok(v) = serde_json::from_str::<Value>(&body) {
            if v.get("error").is_some() {
                return ForwardOutcome::Messages(vec![body]);
            }
        }
        let snippet: String = body.chars().take(200).collect();
        return ForwardOutcome::Failed(jsonrpc_error(
            request_id,
            -32000,
            &format!("Titer's MCP server returned HTTP {}: {}", status.as_u16(), snippet.trim()),
        ));
    }

    if is_sse {
        let messages = sse_messages(&body);
        if messages.is_empty() {
            return ForwardOutcome::Failed(jsonrpc_error(
                request_id,
                -32000,
                "Titer's MCP server returned an empty event stream.",
            ));
        }
        ForwardOutcome::Messages(messages)
    } else if is_json || serde_json::from_str::<Value>(&body).is_ok() {
        // Single JSON message (application/json, or a JSON body even if the
        // server forgot the content type). One line out.
        ForwardOutcome::Messages(vec![body.trim().to_string()])
    } else {
        ForwardOutcome::Failed(jsonrpc_error(
            request_id,
            -32000,
            &format!(
                "Titer's MCP server returned an unreadable response \
                 (HTTP {}, {} bytes, content-type not JSON or SSE).",
                status.as_u16(),
                body.len()
            ),
        ))
    }
}

/// Write one line to stdout. Returns false when the client has gone away
/// (broken pipe) — the caller exits quietly.
fn write_line(out: &mut impl Write, line: &str) -> bool {
    match writeln!(out, "{line}") {
        Ok(()) => out.flush().is_ok(),
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => false,
        Err(e) => {
            eprintln!("titer-stdio-bridge: failed to write to stdout: {e}");
            false
        }
    }
}

/// The main loop: read stdin lines, forward each, write replies. On stdin
/// EOF the client's session is closed on the server (contract §4.5) before
/// exiting 0.
fn run_loop(client: &Client, cfg: &mut BridgeConfig) -> i32 {
    let stdin = io::stdin();
    let mut lines = BufReader::new(stdin.lock()).lines();
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let mut session_id: Option<String> = None;
    let mut negotiated_protocol: Option<String> = None;

    while let Some(next) = lines.next() {
        let line = match next {
            Ok(l) => l,
            Err(_) => break, // stdin closed or unreadable — exit quietly.
        };
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                let err = jsonrpc_error(&Value::Null, -32700, "Parse error: expected one JSON-RPC message per line.");
                if !write_line(&mut out, &err) {
                    return 0;
                }
                continue;
            }
        };

        // Batches are forbidden over Streamable HTTP: reject per member.
        if let Some(members) = value.as_array() {
            for member in members {
                let id = member.get("id").cloned().unwrap_or(Value::Null);
                let err = jsonrpc_error(
                    &id,
                    -32600,
                    "Invalid Request: JSON-RPC batches are not supported by the Titer bridge.",
                );
                if !write_line(&mut out, &err) {
                    return 0;
                }
            }
            continue;
        }
        if !value.is_object() {
            let err = jsonrpc_error(&Value::Null, -32600, "Invalid Request: expected a JSON-RPC object.");
            if !write_line(&mut out, &err) {
                return 0;
            }
            continue;
        }

        let request_id = value.get("id").cloned().unwrap_or(Value::Null);
        let is_notification = value.get("method").is_some() && value.get("id").is_none();
        // Remember the protocol revision the client offered at initialize —
        // it becomes the `MCP-Protocol-Version` header from here on.
        // Owned (not a borrow of cfg): forward() takes &mut cfg for the
        // 401 retry, so a borrowed header value would not compile (E0502).
        if let Some(v) = initialize_protocol_version(&value) {
            negotiated_protocol = Some(v);
        }
        let protocol_version: String = negotiated_protocol
            .clone()
            .or(cfg.protocol_version.clone())
            .unwrap_or_else(|| DEFAULT_PROTOCOL_VERSION.to_string());
        match forward(client, cfg, &mut session_id, &protocol_version, &line, &request_id, is_notification) {
            ForwardOutcome::Messages(messages) => {
                for m in messages {
                    if !write_line(&mut out, &m) {
                        return 0;
                    }
                }
            }
            ForwardOutcome::NoResponse => {}
            ForwardOutcome::Failed(err) => {
                if !write_line(&mut out, &err) {
                    return 0;
                }
            }
        }
    }
    if let Some(sid) = session_id.as_deref() {
        let protocol_version =
            negotiated_protocol.as_deref().or(cfg.protocol_version.as_deref()).unwrap_or(DEFAULT_PROTOCOL_VERSION);
        close_session(client, cfg, protocol_version, sid);
    }
    0
}

/// `--check`: verify the bridge can reach the server with a real
/// `initialize` handshake (protocolVersion 2025-11-25), then close the
/// session again. A bare `ping` is NOT a reliable probe: the server's
/// session manager rejects non-initialize requests without a session, so a
/// ping would report a healthy server as unreachable. Exit 0 = ok,
/// 1 = server unreachable or handshake refused, 2 = no discovery/token.
fn probe(client: &Client, cfg: &mut BridgeConfig) -> i32 {
    let init = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "titer-bridge-check",
        "method": "initialize",
        "params": {
            "protocolVersion": DEFAULT_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "titer-stdio-bridge", "version": VERSION },
        },
    });
    let line = init.to_string();
    let mut session_id = None;
    match forward(client, cfg, &mut session_id, DEFAULT_PROTOCOL_VERSION, &line, &Value::Null, false) {
        ForwardOutcome::Messages(messages) => {
            // A valid initialize result proves the pipe end to end; a
            // JSON-RPC error means the server answered but refused the
            // handshake — still a failure, but a different one.
            let ok = messages
                .iter()
                .any(|m| serde_json::from_str::<Value>(m).map(|v| v.get("result").is_some()).unwrap_or(false));
            if !ok {
                eprintln!("titer-stdio-bridge: server refused the initialize handshake.");
                return 1;
            }
            if let Some(sid) = session_id.as_deref() {
                close_session(client, cfg, DEFAULT_PROTOCOL_VERSION, sid);
            }
            println!(
                "ok: Titer MCP server reachable at {}{}",
                cfg.url,
                cfg.protocol_version.as_deref().map(|v| format!(" (protocol {v})")).unwrap_or_default()
            );
            0
        }
        ForwardOutcome::NoResponse => {
            eprintln!("titer-stdio-bridge: server accepted initialize but returned no response.");
            1
        }
        ForwardOutcome::Failed(err) => {
            let message = serde_json::from_str::<Value>(&err)
                .ok()
                .and_then(|v| v.get("error")?.get("message")?.as_str().map(str::to_string))
                .unwrap_or(err);
            eprintln!("titer-stdio-bridge: {message}");
            1
        }
    }
}

fn print_usage() {
    println!(
        "titer-stdio-bridge {VERSION}\n\
         \n\
         stdio-to-HTTP bridge for Titer's in-app MCP server. The AI client\n\
         launches this binary over stdio; it forwards each JSON-RPC message\n\
         to the server on 127.0.0.1 and writes replies back, one per line.\n\
         \n\
         USAGE\n\
         \x20 titer-stdio-bridge [--discovery <path>] [--check]\n\
         \n\
         OPTIONS\n\
         \x20 --discovery <path>  Read server URL + token from this file instead of\n\
         \x20                     <app-data>/mcp/discovery.json (TITER_MCP_DISCOVERY does the same).\n\
         \x20 --check             Initialize-handshake probe, then close the session\n\
         \x20                     and exit (0 = reachable).\n\
         \x20 --help              Show this help.\n\
         \x20 --version           Show the version.\n\
         \n\
         ENVIRONMENT\n\
         \x20 TITER_MCP_URL       Override the server URL from the discovery file.\n\
         \x20 TITER_MCP_TOKEN     Override the bearer token from the discovery file.\n\
         \x20 TITER_MCP_DISCOVERY Override the discovery file path.\n\
         \n\
         The server URL and token normally come from <app-data>/mcp/discovery.json, written\n\
         by Titer when AI connections are enabled in Settings. If that file is\n\
         missing, the bridge exits 2 with instructions instead of hanging."
    );
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut explicit_discovery: Option<PathBuf> = None;
    let mut check = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => {
                print_usage();
                return ExitCode::from(0);
            }
            "--version" | "-V" => {
                println!("titer-stdio-bridge {VERSION}");
                return ExitCode::from(0);
            }
            "--check" => check = true,
            "--discovery" => {
                i += 1;
                match args.get(i) {
                    Some(p) => explicit_discovery = Some(PathBuf::from(p)),
                    None => {
                        eprintln!("titer-stdio-bridge: --discovery needs a path.");
                        return ExitCode::from(2);
                    }
                }
            }
            other => {
                eprintln!("titer-stdio-bridge: unknown argument: {other}");
                eprintln!("Run with --help for usage.");
                return ExitCode::from(2);
            }
        }
        i += 1;
    }

    let mut cfg = match load_config(explicit_discovery.as_deref()) {
        Ok(c) => c,
        Err(message) => {
            eprintln!("titer-stdio-bridge: {message}");
            return ExitCode::from(2);
        }
    };
    let client = match Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("titer-stdio-bridge: could not create HTTP client: {e}");
            return ExitCode::from(1);
        }
    };

    if check {
        return ExitCode::from(probe(&client, &mut cfg) as u8);
    }
    ExitCode::from(run_loop(&client, &mut cfg) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_single_event_single_message() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n";
        assert_eq!(sse_messages(body), vec!["{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}"]);
    }

    #[test]
    fn sse_comments_and_multiple_events() {
        let body = ": ping\n\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"x\"}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":1}\n\n";
        assert_eq!(
            sse_messages(body),
            vec!["{\"jsonrpc\":\"2.0\",\"method\":\"x\"}", "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":1}"]
        );
    }

    #[test]
    fn sse_trailing_event_without_blank_line() {
        let body = "data: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":null}\n";
        assert_eq!(sse_messages(body), vec!["{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":null}"]);
    }

    #[test]
    fn sse_empty_body_has_no_messages() {
        assert!(sse_messages("").is_empty());
        assert!(sse_messages(": keep-alive\n\n").is_empty());
    }

    #[test]
    fn discovery_parses_contract_shape() {
        // The shape the server actually writes (docs/mcp-server-contract.md
        // §2): <app_data>/mcp/discovery.json with `endpoint` +
        // `protocol_versions`. The port below is arbitrary test data — the
        // real port always comes from the discovery file, never from a
        // constant in this crate.
        let full: Discovery = serde_json::from_str(
            r#"{"endpoint":"http://127.0.0.1:18741/mcp","token":"abc","protocol_versions":["2025-11-25","2025-06-18"],"server":"titer","version":"1.2.0"}"#,
        )
        .unwrap();
        assert_eq!(full.endpoint.as_deref(), Some("http://127.0.0.1:18741/mcp"));
        assert_eq!(full.token, "abc");
        assert_eq!(
            full.protocol_versions.as_deref(),
            Some(["2025-11-25".to_string(), "2025-06-18".to_string()].as_slice())
        );
    }

    #[test]
    fn discovery_parses_legacy_shape() {
        // Pre-contract draft names (`url`, singular `protocol_version`) are
        // still accepted so a bridge built against the draft keeps working.
        let full: Discovery = serde_json::from_str(
            r#"{"url":"http://127.0.0.1:47231/mcp","token":"abc","protocol_version":"2025-06-18"}"#,
        )
        .unwrap();
        assert_eq!(full.url.as_deref(), Some("http://127.0.0.1:47231/mcp"));
        assert_eq!(full.protocol_version.as_deref(), Some("2025-06-18"));
        let minimal: Discovery = serde_json::from_str(r#"{"url":"http://127.0.0.1:47231/mcp","token":"abc"}"#).unwrap();
        assert!(minimal.protocol_version.is_none());
        assert!(minimal.protocol_versions.is_none());
    }

    #[test]
    fn initialize_tracks_supported_version_only() {
        let init_2025 = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {} },
        });
        assert_eq!(initialize_protocol_version(&init_2025).as_deref(), Some("2025-06-18"));
        // A revision the server does not speak is NOT echoed back — the
        // bridge falls back to the default header instead.
        let init_2026 = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2026-07-28", "capabilities": {}, "clientInfo": {} },
        });
        assert_eq!(initialize_protocol_version(&init_2026), None);
        let other = serde_json::json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {},
        });
        assert_eq!(initialize_protocol_version(&other), None);
    }

    #[test]
    fn error_reply_keeps_request_id() {
        let err = jsonrpc_error(&serde_json::json!(42), -32000, "boom");
        let v: Value = serde_json::from_str(&err).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 42);
        assert_eq!(v["error"]["code"], -32000);
        assert_eq!(v["error"]["message"], "boom");
    }

    #[test]
    fn server_off_message_names_the_fix() {
        assert!(SERVER_OFF_MESSAGE.contains("Settings"));
        assert!(SERVER_OFF_MESSAGE.contains("AI connections"));
    }
}
