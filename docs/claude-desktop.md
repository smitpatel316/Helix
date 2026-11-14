# Claude Desktop ↔ Titer

How to connect Claude Desktop to Titer's in-app MCP server (v3 Phase 1,
read-only tools). Your data never leaves your machine: Claude Desktop
launches a small local bridge over stdio, and the bridge talks to Titer on
`127.0.0.1` only.

## First: turn on AI connections in Titer

1. Open Titer.
2. Settings → **AI Connections** → turn on **"Allow AI apps to connect"**.
3. Leave Titer running while you use Claude. (If you quit Titer, Claude's
   Titer tools stop answering until you reopen it — no restart of Claude
   needed.)

No token, no account, no setup beyond that switch: the bridge reads the
server's address and token from Titer's local discovery file
(`<app-data>/mcp/discovery.json`), so there is nothing to paste anywhere.

## Path 1 (recommended): install the `.mcpb` extension

1. Download `titer.mcpb` (from the Titer release page).
2. Double-click it — or drag it into the Claude Desktop window — or in
   Claude Desktop go to **Settings → Extensions → Advanced settings →
   Install Extension…** and pick the file.
3. Review the install dialog and click Install.
4. If Claude Desktop was already running, fully quit and relaunch it —
   it reads MCP servers at startup.

Titer's tools then appear in chat. (The bundle is unsigned for now — Claude
Desktop shows unsigned extensions as such; signing is a release decision,
not a blocker.)

## Path 2 (developer): `claude_desktop_config.json`

For a server you are actively building, declare the bridge in Claude
Desktop's config file instead of installing the bundle. The file lives at:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Open it from the Claude menu → **Settings… → Developer → Edit Config**.
Add a `titer` entry under `mcpServers` (keep any servers already there).
The bridge ships inside the Titer app bundle (Tauri `externalBin`), so the
command is the sidecar binary next to the app:

```json
{
  "mcpServers": {
    "titer": {
      "command": "/Applications/Titer.app/Contents/MacOS/titer-stdio-bridge",
      "args": [],
      "env": {}
    }
  }
}
```

On Windows the same entry points at the installed sidecar, e.g.
`"command": "C:\\Program Files\\Titer\\titer-stdio-bridge.exe"` — adjust
to wherever Titer is installed. No `env` is needed: the bridge finds the
server through Titer's discovery file on its own.

After every edit, **fully quit and relaunch Claude Desktop** — closing the
window is not quitting; the config is read at startup.

## What Claude can do (Phase 1 — read-only)

Five tools, all read-only: `titer_list_projects`, `titer_list_tables`,
`titer_read_table_summary`, `titer_read_results`, `titer_read_graph`.
Claude can list what's open, read tables and results, and describe graphs.
It cannot run analyses, build graphs, or export — those are Phase 2. Every
tool call is written to Titer's Activity log (Settings → AI Connections →
Activity).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Claude reports the server failed to start | AI connections are off in Titer. Turn on Settings → AI Connections → "Allow AI apps to connect", then restart Claude Desktop. |
| Tools appear but every call errors | Titer was quit after Claude started. Reopen Titer — the bridge reconnects on the next call, no Claude restart needed. |
| "The token changed" | The token was regenerated in Settings while the server was stopped. Restart Claude Desktop (the bridge reads the fresh token at launch). |
| Nothing shows up after editing the JSON | Claude Desktop was not fully quit. Quit it completely (not just close the window) and relaunch. Also check the JSON is valid — a syntax error drops the whole `mcpServers` block. |

From a terminal, `titer-stdio-bridge --check` reports whether the pipe is
up (exit 0 = reachable; the bridge is at
`/Applications/Titer.app/Contents/MacOS/titer-stdio-bridge` on macOS).

## Why not the other connection methods

Claude Desktop connects to MCP servers three ways; only the two above fit
a local app:

- **Desktop extensions (.mcpb)** — Path 1. The end-user route.
- **`claude_desktop_config.json`** — Path 2. The developer route. Stdio
  only: the file never holds a URL, and pasting one in breaks the entry.
- **Custom connectors** — remote servers over Streamable HTTP + OAuth,
  added in Settings → Connectors. Anthropic's servers make the connection,
  so `localhost` does not work. Titer's server is local-only by design, so
  this path does not apply (and Enterprise features are out of scope).

## Sources

- Anthropic, "Build a desktop extension with MCPB" (updated 2026-11-12):
  https://claude.com/docs/connectors/building/mcpb — .mcpb format, install
  flows, directory listings deprecated (distribute the file directly).
- Anthropic, "Desktop Extensions: One-click MCP installs" (updated
  2026-10-13): https://www.anthropic.com/research/desktop-extensions
- MCPB manifest spec v0.3:
  https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
- MCPB CLI reference:
  https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md
- Local stdio support for MCP spec 2026-07-28 in Claude Desktop is
  unconfirmed (Oct 2026); Titer's server speaks 2025-06-18 / 2025-11-25
  only, which is the right target.
- The pipe itself: `docs/stdio-bridge.md` (bridge design + reconciliation
  with the server contract) and `docs/mcp-server-contract.md` (endpoint,
  auth, tools).
