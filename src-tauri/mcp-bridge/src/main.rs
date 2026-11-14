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
// reasoning): the app writes a discovery file,
// `<app_data_dir>/mcp/discovery.json`
// (`{"endpoint", "token", "protocol_versions"}`), atomically with mode 0600,
// when the user turns on AI connections in Settings; the bridge reads it at
// startup. No token is ever baked into the .mcpb bundle or into any AI
// client's config. `TITER_MCP_URL` / `TITER_MCP_TOKEN` / `TITER_MCP_DISCOVERY`
// env vars override individual fields, for dev and for Claude Code users who
// run the bridge by hand.
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
// BUILD STATUS: code only — no cargo build/check is allowed in this lane
// (v1 owns the box). `cargo fmt --check` only. Build + live verification
// against the real server is pending v1 clear; see docs/stdio-bridge.md §6.

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

/// Name of the discovery file inside the app-data directory. Written by the
/// app (v3/mcp-server lane); read by this bridge. Contract pinned in
/// docs/mcp-server-contract.md §2 — the server writes
/// `<app_data_dir>/mcp/discovery.json` with keys `endpoint`, `token`,
/// `protocol_versions`. (Reconciled in v3/codex: the bridge lane originally
/// assumed `<app_data_dir>/mcp.json` with `url` / `protocol_version`; the
/// server contract wins, and `url` / `protocol_version` are still accepted
/// as serde aliases so a stale file fails soft instead of hard.)
const DISCOVERY_DIR: &str = "mcp";
const DISCOVERY_FILE: &str = "discovery.json";

/// One request may run a slow analysis; 5 minutes is generous without
/// letting a wedged server hang the client forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The message the user sees whenever the server is not reachable. It must
/// name the exact fix (enable AI connections in Titer Settings) and the exact
/// place to do it. Keep in sync with the Settings label owned by the
/// v3/mcp-server lane.
const SERVER_OFF_MESSAGE: &str = "Titer's AI connections are off or Titer isn't running. \
    In Titer, open Settings -> AI connections and turn on 'Allow AI apps to connect', \
    then try again.";

/// What the app writes to `<app_data_dir>/mcp/discovery.json` when AI
/// connections are enabled (docs/mcp-server-contract.md §2).
/// `protocol_versions` is informational only — the bridge forwards bytes
/// and does not negotiate versions itself. The `url` / `protocol_version`
/// aliases accept the bridge lane's original draft shape.
#[derive(Debug, Deserialize)]
struct Discovery {
    #[serde(alias = "url")]
    endpoint: String,
    token: String,
    #[serde(default)]
    protocol_versions: Option<Vec<String>>,
    #[serde(default)]
    protocol_version: Option<String>,
}

/// Resolved runtime config: where to POST, and with which bearer token.
#[derive(Debug)]
struct BridgeConfig {
    url: String,
    token: String,
    protocol_version: Option<String>,
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
            url = Some(disc.endpoint);
        }
        if token.is_none() {
            token = Some(disc.token);
        }
        protocol_version = disc.protocol_version.or_else(|| disc.protocol_versions.and_then(|v| v.into_iter().next()));
    }

    match (url, token) {
        (Some(url), Some(token)) if !url.is_empty() && !token.is_empty() => {
            Ok(BridgeConfig { url, token, protocol_version })
        }
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

/// Forward one raw JSON-RPC line to the Streamable HTTP endpoint.
/// `session_id` is the `Mcp-Session-Id` the server returned at initialize
/// (if any); it is sent on every subsequent request and refreshed whenever
/// the server returns a new one.
fn forward(
    client: &Client,
    cfg: &BridgeConfig,
    session_id: &mut Option<String>,
    line: &str,
    request_id: &Value,
    is_notification: bool,
) -> ForwardOutcome {
    let mut req = client
        .post(cfg.url.as_str())
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("Authorization", format!("Bearer {}", cfg.token))
        .body(line.to_string());
    if let Some(sid) = session_id.as_deref() {
        req = req.header("Mcp-Session-Id", sid);
    }

    let resp = match req.send() {
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

/// The main loop: read stdin lines, forward each, write replies.
fn run_loop(client: &Client, cfg: &BridgeConfig) -> i32 {
    let stdin = io::stdin();
    let mut lines = BufReader::new(stdin.lock()).lines();
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let mut session_id: Option<String> = None;

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
        match forward(client, cfg, &mut session_id, &line, &request_id, is_notification) {
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
    0
}

/// `--check`: verify the bridge can reach the server, with a side-effect-free
/// MCP `ping`. Exit 0 = ok, 1 = server unreachable, 2 = no discovery/token.
fn probe(client: &Client, cfg: &BridgeConfig) -> i32 {
    let ping = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "titer-bridge-check",
        "method": "ping",
    });
    let line = ping.to_string();
    let mut session_id = None;
    match forward(client, cfg, &mut session_id, &line, &Value::Null, false) {
        ForwardOutcome::Messages(_) => {
            println!(
                "ok: Titer MCP server reachable at {}{}",
                cfg.url,
                cfg.protocol_version.as_deref().map(|v| format!(" (protocol {v})")).unwrap_or_default()
            );
            0
        }
        ForwardOutcome::NoResponse => {
            eprintln!("titer-stdio-bridge: server accepted ping but returned no response.");
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
         \x20 --check             Ping the server once and exit (0 = reachable).\n\
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

    let cfg = match load_config(explicit_discovery.as_deref()) {
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
        return ExitCode::from(probe(&client, &cfg) as u8);
    }
    ExitCode::from(run_loop(&client, &cfg) as u8)
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
    fn discovery_parses_with_and_without_protocol_version() {
        // The port below is arbitrary test data — the real port always comes
        // from the discovery file, never from a constant in this crate.
        // Contract shape (docs/mcp-server-contract.md §2): `endpoint` +
        // `protocol_versions` array.
        let full: Discovery = serde_json::from_str(
            r#"{"endpoint":"http://127.0.0.1:47231/mcp","token":"abc","protocol_versions":["2025-11-25","2025-06-18"]}"#,
        )
        .unwrap();
        assert_eq!(full.endpoint, "http://127.0.0.1:47231/mcp");
        assert_eq!(full.protocol_versions.as_deref(), Some(&["2025-11-25".to_string(), "2025-06-18".to_string()][..]));
        let minimal: Discovery =
            serde_json::from_str(r#"{"endpoint":"http://127.0.0.1:47231/mcp","token":"abc"}"#).unwrap();
        assert!(minimal.protocol_versions.is_none());
        assert!(minimal.protocol_version.is_none());
    }

    #[test]
    fn discovery_accepts_legacy_url_shape() {
        // The bridge lane's original draft shape still parses (serde
        // aliases), so a stale discovery file fails soft instead of hard.
        let legacy: Discovery = serde_json::from_str(
            r#"{"url":"http://127.0.0.1:47231/mcp","token":"abc","protocol_version":"2025-06-18"}"#,
        )
        .unwrap();
        assert_eq!(legacy.endpoint, "http://127.0.0.1:47231/mcp");
        assert_eq!(legacy.protocol_version.as_deref(), Some("2025-06-18"));
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
