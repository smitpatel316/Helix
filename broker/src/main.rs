//! Binary entry point: load config from the environment, refuse to start
//! without credentials, bind loopback, serve.
//!
//! Environment:
//! - `BOX_CLIENT_ID` (required): the Box OAuth app's client id (public).
//! - `BOX_CLIENT_SECRET` (required unless the file form is used): the Box
//!   OAuth app's client secret. NEVER commit it, NEVER log it.
//! - `BOX_CLIENT_SECRET_FILE` (alternative): path to a file containing only
//!   the secret. The file MUST be mode 0600 (owner read/write, nothing for
//!   group/other) or startup is refused.
//! - `BOX_BROKER_BIND` (default `127.0.0.1`): bind address. Loopback only in
//!   production — the broker is reached through the Cloudflare tunnel.
//! - `BOX_BROKER_PORT` (default `18099`): listen port.
//! - `BOX_TOKEN_URL` (default `https://api.box.com/oauth2/token`): upstream
//!   Box token endpoint. Override ONLY for tests against a mock endpoint.
//!
//! The broker is stateless: no database, no token storage, no pending map.

use std::{net::SocketAddr, os::unix::fs::PermissionsExt, path::Path};
use titer_box_broker::{build_router, AppState, ClientSecret, DEFAULT_TOKEN_URL};

fn fail(msg: &str) -> ! {
    eprintln!("titer-box-broker: refusing to start: {msg}");
    std::process::exit(1);
}

/// Read the secret from a file. The file must be mode 0600; anything more
/// permissive (group/other read/write/execute bits set) refuses startup.
fn read_secret_file(path: &Path) -> String {
    let meta = std::fs::metadata(path).unwrap_or_else(|e| fail(&format!(
        "cannot stat BOX_CLIENT_SECRET_FILE {}: {e}",
        path.display()
    )));
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        fail(&format!(
            "BOX_CLIENT_SECRET_FILE {} has mode {:o}; must be 0600",
            path.display(),
            mode
        ));
    }
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| fail(&format!(
        "cannot read BOX_CLIENT_SECRET_FILE {}: {e}",
        path.display()
    )));
    let secret = raw.trim().to_string();
    if secret.is_empty() {
        fail("BOX_CLIENT_SECRET_FILE is empty");
    }
    secret
}

fn load_secret() -> ClientSecret {
    if let Ok(secret) = std::env::var("BOX_CLIENT_SECRET") {
        if !secret.trim().is_empty() {
            return ClientSecret::new(secret.trim().to_string());
        }
    }
    if let Ok(path) = std::env::var("BOX_CLIENT_SECRET_FILE") {
        return ClientSecret::new(read_secret_file(Path::new(&path)));
    }
    fail("set BOX_CLIENT_SECRET or BOX_CLIENT_SECRET_FILE");
}

#[tokio::main]
async fn main() {
    let client_id = std::env::var("BOX_CLIENT_ID")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fail("set BOX_CLIENT_ID"));
    let client_secret = load_secret();
    let token_url = std::env::var("BOX_TOKEN_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_TOKEN_URL.to_string());
    let bind = std::env::var("BOX_BROKER_BIND").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port: u16 = std::env::var("BOX_BROKER_PORT")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(18099);

    let state = match AppState::new(client_id, client_secret, token_url) {
        Ok(s) => s,
        Err(e) => fail(&format!("cannot build HTTP client: {e}")),
    };
    let addr: SocketAddr = format!("{bind}:{port}")
        .parse()
        .unwrap_or_else(|_| fail(&format!("invalid bind address {bind}:{port}")));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| fail(&format!("cannot bind {addr}: {e}")));
    eprintln!("titer-box-broker: listening on {addr}");
    let app = build_router(state);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .unwrap_or_else(|e| fail(&format!("server error: {e}")));
}
