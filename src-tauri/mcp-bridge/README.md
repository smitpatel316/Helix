# titer-stdio-bridge

The stdio bridge between an MCP client (Claude Desktop, Claude Code, …) and
Titer's in-app MCP server. The client launches this binary over stdio
(newline-delimited JSON-RPC); the bridge forwards each message as one POST to
the server's Streamable HTTP endpoint on `127.0.0.1` and writes replies back,
one JSON message per line.

Full design, token-discovery decision, and verification status:
`docs/stdio-bridge.md` (repo root).

## Build

Standalone crate — deliberately not a workspace member, so it never touches
the app's `Cargo.toml` / `Cargo.lock`:

```sh
cargo build --release --manifest-path src-tauri/mcp-bridge/Cargo.toml
# binary: src-tauri/mcp-bridge/target/release/titer-stdio-bridge
```

Stage it for the app bundle (copies it to `src-tauri/binaries/` with the
target-triple suffix Tauri's `externalBin` requires):

```sh
./scripts/build-stdio-bridge.sh            # host triple
./scripts/build-stdio-bridge.sh --all      # macOS arm64 + x64 (+ lipo universal) and Windows
```

## Run

```sh
# Normal use — the client launches it; nothing to type.
titer-stdio-bridge

# Check the pipe end to end (side-effect-free MCP ping). Exit 0 = reachable.
titer-stdio-bridge --check

# Dev: point at a test server without touching Titer's discovery file.
TITER_MCP_URL=http://127.0.0.1:PORT/mcp TITER_MCP_TOKEN=test-token titer-stdio-bridge --check
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Normal exit (stdin EOF / client closed / `--check` ok) |
| 1 | Server unreachable mid-session, or HTTP client setup failed |
| 2 | No discovery file / token, or bad arguments (message on stderr names the fix) |

## Config sources (first match wins per field)

1. `TITER_MCP_URL` / `TITER_MCP_TOKEN` env vars (dev override).
2. Discovery file: `--discovery <path>`, else `TITER_MCP_DISCOVERY`, else
   `<app-data>/mcp/discovery.json` — `{"endpoint", "token",
   "protocol_versions", "server", "version"}` (the draft `{"url", "token",
   "protocol_version"}` shape is still accepted).
   App-data dir: macOS `~/Library/Application Support/net.smitpatel.helix`,
   Windows `%APPDATA%\net.smitpatel.helix`,
   Linux `${XDG_DATA_HOME:-~/.local/share}/net.smitpatel.helix`.
