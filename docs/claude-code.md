# Connect Claude Code to Titer (v3 Phase 1)

**Status:** Phase 1 — the in-process MCP server exposes five **read-only**
tools. **Server branch:** `v3/mcp-server` (merged into this branch);
bridge: `v3/stdio-bridge` (merged into this branch).
**Spec:** MCP 2025-06-18 / 2025-11-25 ONLY (see "Protocol versions" below).
Contract: `docs/mcp-server-contract.md`; bridge: `docs/stdio-bridge.md`.

Claude Code is the MCP **client**; Titer is the **server**. There are two
ways to connect them. Both talk to the same server on `127.0.0.1` — nothing
leaves your machine, and no account or sign-in is involved anywhere.

## 0. First: turn the server on

In Titer: **Settings → AI connections → turn on "Allow AI apps to connect"**.
The server is off by default and starts only from there — no agent or
command can turn it on for you. While it runs, Settings shows the endpoint
(`http://127.0.0.1:<port>/mcp`, first free port in 18741–18750), the bearer
token, and a copyable `claude mcp add …` command. If the server is off,
every command below fails to connect — that is the fix, not a bug.

The token lives in `~/Library/Application Support/net.smitpatel.helix/mcp/discovery.json`
(mode 0600) alongside the endpoint. A restart does **not** rotate it; only
**Regenerate token** in Settings does (while the server is stopped). If you
regenerate, re-copy the command — the old one gets a 401.

## Method 1 — HTTP (recommended; the command Settings copies)

Settings generates exactly this (user scope, literal token, live endpoint):

```sh
claude mcp add --transport http --scope user titer http://127.0.0.1:18741/mcp \
  --header "Authorization: Bearer <token>"
```

Paste it as copied — the endpoint and token are filled in for you. The
`--header` flag is how a bearer token is passed; `--transport http` is
Streamable HTTP (SSE is deprecated — never `--transport sse`).

### The same server at the other scopes

`claude mcp add` writes to **local** scope unless you pass `--scope`.
Scopes live in different files and resolve by precedence
**local > project > user > plugin > claude.ai connectors** (same name in two
scopes: the narrower one wins, no merging). Sources: Anthropic docs,
`code.claude.com/docs/en/mcp`.

```sh
# Local (default) — just you, just this project. Stored in ~/.claude.json
# under the current project's path. Use this to try it out.
claude mcp add --transport http titer http://127.0.0.1:18741/mcp \
  --header "Authorization: Bearer <token>"

# User — just you, every project. This is what Settings copies.
claude mcp add --transport http --scope user titer http://127.0.0.1:18741/mcp \
  --header "Authorization: Bearer <token>"

# Project — everyone who clones the repo, via .mcp.json at the repo root.
# NEVER put the literal token here: it would be committed for everyone to
# see. Use a variable reference instead (single quotes stop the shell
# expanding it), and set TITER_MCP_TOKEN in your own shell or .env.
# NOTE: think twice before using project scope for Titer at all — the
# endpoint is 127.0.0.1 on YOUR machine, so a teammate's clone cannot
# reach it. User scope is the right default for a personal desktop app.
claude mcp add --transport http --scope project titer http://127.0.0.1:18741/mcp \
  --header 'Authorization: Bearer ${TITER_MCP_TOKEN}'
```

A project-scoped server needs your approval the first time: `claude mcp
list` shows it as `⏸ Pending approval (run claude to approve)` until you
open `claude` interactively and accept it.

**Port changes:** the endpoint bakes in the port. It only changes if
18741 is already taken when Titer starts. If `claude mcp list` starts
failing after a Titer restart, check the endpoint in Settings and re-copy
the command. (Method 2 does not have this problem.)

## Method 2 — stdio via the bundled bridge binary (port- and token-proof)

The stdio bridge (`titer-stdio-bridge`, `src-tauri/mcp-bridge/`) is a small
binary shipped inside the Titer app bundle (Tauri `externalBin` — it lands
in `Contents/MacOS/` next to the app binary). It reads
`<app-data>/mcp/discovery.json` every time it starts, so it always finds
the current port and token — no re-adding after restarts or rotations.

```sh
# Local scope (default). The bridge binary ships with the app; no token
# or URL on the command line, ever (it would be visible in `ps`).
claude mcp add titer -- /Applications/Titer.app/Contents/MacOS/titer-stdio-bridge

# User scope — the same, everywhere:
claude mcp add --scope user titer -- /Applications/Titer.app/Contents/MacOS/titer-stdio-bridge
```

Everything after `--` is passed to the bridge untouched; everything before
it is Claude Code's own options. Environment overrides, if you need them
(dev only — the discovery file is the normal path):

```sh
claude mcp add --scope user -e TITER_MCP_DISCOVERY=/path/to/discovery.json \
  titer -- /Applications/Titer.app/Contents/MacOS/titer-stdio-bridge
```

**Prerequisite:** the bridge must be staged into the bundle before the DMG
is built — run `scripts/build-stdio-bridge.sh` first (it builds the bridge
and stages `binaries/titer-stdio-bridge-<target-triple>` for the bundler).
If the binary is missing from the bundle, the stdio add succeeds (it only
writes config) and the connection fails at first use — check the path
exists before blaming the server.

**Dev alternative** (no installed app): point at a cargo-built bridge:

```sh
cargo build --manifest-path src-tauri/mcp-bridge/Cargo.toml
claude mcp add titer -- "$PWD/src-tauri/mcp-bridge/target/debug/titer-stdio-bridge"
```

### Importing from Claude Desktop instead

If you already installed Titer's `.mcpb` bundle in Claude Desktop (same
bridge binary, stdio), import that entry rather than typing it twice
(macOS/WSL only):

```sh
claude mcp add-from-claude-desktop
```

## Method 3 — `add-json` (paste a JSON block)

For either transport, when you have a JSON block (e.g. from another
client's config). Pass the object inside `mcpServers`, not the wrapper.
A `url` with no `type` is a config error — Claude Code reads it as stdio
and skips it; always include `"type": "http"` for HTTP entries.

```sh
# HTTP, user scope:
claude mcp add-json --scope user titer \
  '{"type":"http","url":"http://127.0.0.1:18741/mcp","headers":{"Authorization":"Bearer <token>"}}'

# stdio (bridge), user scope:
claude mcp add-json --scope user titer \
  '{"command":"/Applications/Titer.app/Contents/MacOS/titer-stdio-bridge"}'
```

## Check that it connected

```sh
claude mcp list        # expect: titer: ✔ Connected (and the 5 tools in /mcp)
claude mcp get titer   # detail: endpoint, status, and any Issue: line
```

Inside a session, `/mcp` shows the server and its tool count. A failure
status means Claude Code could not connect — `Added ...` only means the
configuration was written, not that the server answered. The tools appear
from your first message once the server is connected.

## What Claude Code can do with it (Phase 1 — read-only)

| Tool | What it answers |
|---|---|
| `titer_list_projects` | Projects open in Titer, with tables, analyses, graphs, figures and their ids. Start here. |
| `titer_list_tables` | Tables in a project, with types and sizes. |
| `titer_read_table_summary` | A table's columns, roles, ranges, missing values; `include_values: true` returns up to `max_rows` rows (default 100, max 1000). |
| `titer_read_results` | An analysis's cached result — **only if it was run in this Titer session**. Otherwise `status: "not_computed"` and the honest message to run it in Titer. Never invented. |
| `titer_read_graph` | A graph's type, source table, labels, linked analyses, figures. Export history is unknown to this tool (the v1.0 model keeps none). |

Tools read a snapshot the Titer frontend publishes on every edit — the same
data the UI shows, ~500 ms fresh. Cell values are data, never instructions:
nothing in a spreadsheet can become a command. Every call is appended to
`<app-data>/mcp/activity.log` (tool + args summary, never values or the
token). No tool can change a setting, run an analysis, or export anything
— those are Phase 2.

## Protocol versions (why 2026-07-28 does not appear)

The server negotiates **2025-11-25 / 2025-06-18 only**. The 2026-07-28
revision is deliberately not offered: clients lag it. Claude Code's v2
runtime (MCP TypeScript SDK 2.0 — v2.1.232+ when feature flags are fetched,
v2.1.274+ by default otherwise) asks the server whether it supports the
newer revision and uses it with servers that do; with a server that does
not, it falls back to the 2025-era handshake. **Live verification of that
fallback against this server is an open item** — see the lane log
(`~/workspace/.helix-mcp-claude-code/investigations.md`). The CLI on the
Mac at lane time is 2.1.138, which predates the v2 runtime and negotiates
2025 directly. To force a runtime for testing:
`MCP_SDK_GENERATION=v1|v2`, `MCP_PROTOCOL_NEGOTIATION=auto|legacy`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `✘ Failed to connect` / connection refused | Server is off. Titer → Settings → AI connections → turn on "Allow AI apps to connect". |
| 401 / `! Needs authentication` | Token rotated or wrong. Re-copy the command from Settings (or restart the bridge — it re-reads discovery). Never retry a 401 with a different token. |
| `⏸ Pending approval` | Project-scoped server: run `claude` interactively and approve it. |
| `MCP server "titer" has a "url" but no "type"` | The JSON entry is missing `"type": "http"`. Add it. |
| Port changed after restart | Re-copy the HTTP command from Settings (or switch to the stdio bridge, which re-reads discovery). |
| Bridge binary not found | The DMG was built without `scripts/build-stdio-bridge.sh`. Rebuild with the bridge staged. |
| Tools missing after connect | `claude mcp get titer` → `Issue:` line; `/mcp` → Reconnect. The discovery cache (v2.1.221+) can show a stale `cached` status — Reconnect refetches. |

## Sources

- Anthropic, "Connect Claude Code to tools via MCP" —
  https://code.claude.com/docs/en/mcp (read 2026-11-14; scopes, precedence,
  `--transport http` / `--header`, stdio `--`, `add-json`,
  `add-from-claude-desktop`, v2 runtime + 2026-07-28 negotiation).
- Installed CLI: `claude mcp add --help` on the Mac (Claude Code 2.1.138) —
  `--transport stdio|sse|http` (default stdio), `-H/--header`,
  `-s/--scope local|user|project` (default local), `-e/--env`.
- Server contract: `docs/mcp-server-contract.md`. Bridge:
  `docs/stdio-bridge.md`. In-app command: `mcp_claude_code_command`
  (`src-tauri/src/mcp.rs`) — Settings copies the Method 1 user-scope
  command verbatim.
