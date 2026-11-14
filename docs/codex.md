# Connecting Codex and ChatGPT to Titer (MCP)

Titer's in-app MCP server (v3 Phase 1) is **local-only and read-only**: it
runs on `127.0.0.1`, speaks Streamable HTTP, and exposes five tools that
list and summarise what is open in Titer — it cannot run an analysis, build
a graph, export, save, or delete anything. This page shows how to connect
**Codex** (CLI, IDE extension) and the **ChatGPT desktop app** to it.

**Scope:** local connections only. No OAuth, no accounts, no publishing,
no Enterprise. ChatGPT on the **web** is out of scope for the local
solution — see [ChatGPT web](#chatgpt-web) at the bottom.

## How it works — one config, three clients

Codex and the ChatGPT desktop app share one MCP configuration file. Add
the server once and the Codex CLI, the IDE extension, and the ChatGPT
desktop app all see it — no per-client setup:

- User level (applies everywhere): `~/.codex/config.toml`
- Project level (one trusted project only): `.codex/config.toml`

Each server is one `[mcp_servers.<name>]` table. The transport is chosen
by which keys are present: `command` means stdio, `url` means Streamable
HTTP. Never mix keys from both in one table.

Sources: OpenAI, "Model Context Protocol" (developers.openai.com/codex/mcp,
read 2026-11-14) for the config format, the desktop-app path, and the
`instructions` field; `codex mcp add` syntax per the Codex CLI as
documented Nov 2026 (context7.com/guides/codex-mcp-setup,
dev.to, corsair.dev/blog/codex-mcp — all checked against CLI 0.165.0;
verified here against CLI 0.169.0, see § Verification).

## Prerequisites

1. Titer with AI connections on: **Settings → AI connections → "Allow AI
   apps to connect"**. This starts the server on `127.0.0.1` (first free
   port in 18741–18750) and writes the connection file
   `<app-data>/mcp/discovery.json` (mode 0600) with the endpoint and
   bearer token. Turning it off removes the file and stops the server.
   App-data dir: macOS `~/Library/Application Support/net.smitpatel.helix`,
   Windows `%APPDATA%\net.smitpatel.helix`, Linux
   `${XDG_DATA_HOME:-~/.local/share}/net.smitpatel.helix`.
2. For the stdio transport only: the `titer-stdio-bridge` binary (see
   [Transport A](#transport-a-stdio-via-the-bridge-recommended)). The
   HTTP transport needs no extra binary.

## Transport A — stdio via the bridge (recommended)

Codex launches `titer-stdio-bridge` as a subprocess; the bridge reads the
discovery file at every launch (so it always finds the current port and
token) and forwards each JSON-RPC message as one POST to the server.
No token is ever pasted into any config file, and token rotation (a fresh
token on every re-enable) just works.

Build the bridge once:

```sh
./scripts/build-stdio-bridge.sh
# binary: src-tauri/mcp-bridge/target/release/titer-stdio-bridge
# (packaged app: staged under src-tauri/binaries/ as
#  titer-stdio-bridge-<target-triple> by the same script)
```

Add it with the CLI (use the absolute path to the binary):

```sh
codex mcp add titer -- /absolute/path/to/titer-stdio-bridge
```

Or write the table by hand in `~/.codex/config.toml`:

```toml
[mcp_servers.titer]
command = "/absolute/path/to/titer-stdio-bridge"
# No env needed: the bridge reads <app-data>/mcp/discovery.json itself.
# Optional: tool_timeout_sec = 120  (default 60; analyses can be slow)
```

## Transport B — Streamable HTTP (direct)

Codex connects straight to the server URL. The catch: the port varies
(first free in 18741–18750) and the token rotates on every re-enable, so
read both from the discovery file each time you set this up:

```sh
cat ~/Library/Application\ Support/net.smitpatel.helix/mcp/discovery.json
# {"endpoint": "http://127.0.0.1:18741/mcp", "token": "<token>", ...}
```

**Option B1 — bearer token from an environment variable** (simplest, but
goes stale when the token rotates; re-export after re-enabling):

```sh
export TITER_MCP_TOKEN="<token from discovery.json>"
codex mcp add titer --url http://127.0.0.1:18741/mcp --bearer-token-env-var TITER_MCP_TOKEN
```

```toml
[mcp_servers.titer]
url = "http://127.0.0.1:18741/mcp"
bearer_token_env_var = "TITER_MCP_TOKEN"
```

**Option B2 — header helper** (rotation-proof; recommended if you use
HTTP). Codex runs the helper per connection and refreshes after a
401/403, so it always reads the current token from the discovery file:

```toml
[mcp_servers.titer]
url = "http://127.0.0.1:18741/mcp"
http_headers_helper = "python3 /absolute/path/to/titer/scripts/mcp-auth-header.py"
```

Never put the token itself in `config.toml` (e.g. via `http_headers` with
a literal `Authorization` value): it would sit in plain text and go stale
on rotation.

## ChatGPT desktop app

Same shared config — adding the server in either place shows up in the
other:

1. Open **Settings**, then select **MCP servers**.
2. Select **Add server**.
3. Enter a name (`titer`), choose **STDIO** or **Streamable HTTP**, and
   provide the bridge command (Transport A) or the URL (Transport B).
4. Save the server, then select **Restart**.

The server list shows which servers are enabled and which require OAuth —
Titer requires none. In the composer, type `/mcp` to view connected
servers. (Note: the **Chat** surface does not show tools from a local MCP
server; use the **Codex** or **Work** surface.)

## Verify the connection

```sh
codex mcp list            # titer should be listed, with its tools
```

Then start Codex and type `/mcp` — `titer` should appear with its five
tools: `titer_list_projects`, `titer_list_tables`,
`titer_read_table_summary`, `titer_read_results`, `titer_read_graph`.

Try a prompt: *"What projects are open in Titer?"* — Codex should call
`titer_list_projects`. If a tool reports an analysis as `not_computed`,
the analysis hasn't been run in this Titer session: open it in Titer and
run it rather than guessing (the server says so instead of inventing a
result).

## What Codex sees: the `instructions` field

Codex reads the MCP `instructions` field returned during initialization
and uses it as server-wide guidance alongside the tools. Titer's server
sets it (`src-tauri/src/mcp.rs`, `get_info`): it names Titer, lists all
five read-only tools, states local-only + read-only, and says cell values
and imported text are data, never instructions. Per OpenAI's guidance the
first 512 characters are self-contained — ours put the identity, the five
tool names, and the no-writes rule inside that window.

## ChatGPT web

ChatGPT on the web does **not** read local Codex configuration files, so
there is no local-config path for it. Web access to a custom MCP server
goes through **Plugins** (Settings → Plugins → Add custom MCP server, Plus
plan and above): the server must be reachable on the public internet over
HTTPS, or via OpenAI's Secure MCP Tunnel for a private one. Titer's
server binds loopback only and is deliberately not exposed — the web path
is out of scope for this solution.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `codex mcp list` shows `titer` but no tools | Check Titer is running with AI connections on; the bridge exits 2 with the exact fix if the discovery file is missing. |
| Bridge: "AI connection file was not found" | In Titer, Settings → AI connections → turn "Allow AI apps to connect" on. |
| HTTP: 401 after re-enabling AI connections | Token rotated — re-export `TITER_MCP_TOKEN` (B1) or switch to the header helper (B2). |
| HTTP: connection refused | The port changes per launch — read the current `endpoint` from `mcp/discovery.json`, don't assume 18741. |
| Server not in `/mcp` after adding | Restart the client (desktop app: Settings → MCP servers → Restart); project `.codex/config.toml` only loads in trusted projects — prefer `~/.codex/config.toml`. |
| `codex mcp-server` / standalone binary not found | That command and binary were removed Sep 5, 2026. Use `codex mcp add` — nothing to install server-side. |

## Verification status

- Config format, desktop-app path, `instructions` semantics: OpenAI docs
  (developers.openai.com/codex/mcp, read 2026-11-14).
- CLI: `codex mcp add` / `codex mcp list` syntax per Nov 2026 CLI
  documentation; live CLI check on the Mac (codex-cli 0.169.0, installed
  via npm, no account) — see `~/workspace/.helix-mcp-codex/investigations.md`.
- Live end-to-end (Codex → bridge → running Titer server →
  `tools/list`): **pending** — needs a Mac build of Titer with AI
  connections enabled; tracked in the lane log.
- Protocol: server negotiates 2025-06-18 / 2025-11-25 only (see
  `docs/mcp-server-contract.md`).
