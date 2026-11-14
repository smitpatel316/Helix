# Connect Google Antigravity to Titer

Titer exposes a local, read-only MCP server (Phase 1: five tools — list
projects/tables, read table summaries, read results, read graphs). Google
Antigravity can connect to it two ways: **install the Titer plugin**
(one-click, recommended) or **paste a server entry into `mcp_config.json`**
by hand (config-file path, both transports). Either way, Antigravity talks
to Titer on your own machine over loopback only — your data never leaves
your computer.

Sources: Google's official docs, fetched 2026-11-14 —
[MCP](https://antigravity.google/docs/mcp/),
[Plugins](https://antigravity.google/docs/plugins),
[Build plugins](https://antigravity.google/docs/build-plugins),
[Plugin Marketplace launch](https://antigravity.google/blog/plugin-marketplace-in-antigravity)
(Oct 29, 2026). The server contract is `docs/mcp-server-contract.md`;
the stdio bridge is `docs/stdio-bridge.md`.

## Prerequisites (both paths)

1. Titer installed and running, with a project open.
2. In Titer, open **Settings → AI connections** and turn on **“Allow AI
   apps to connect”**. The page shows the server status — e.g. “On —
   listening on http://127.0.0.1:18741/mcp” — and your local token
   (click **Show**, then **Copy**).
   - **Endpoint:** the server takes the first free port in 18741–18750
     (usually 18741). Copy the exact URL from Settings — do not guess
     the port. Advanced: the same values live in Titer's connection
     file, `~/Library/Application Support/net.smitpatel.helix/mcp/discovery.json`
     on macOS (`~/.local/share/net.smitpatel.helix/mcp/discovery.json` on
     Linux), as `endpoint` + `token`.
   - **Token:** generated once on first enable and stored locally; it
     stays valid across restarts until you regenerate it in Settings.
     Keep it private — never share it, never commit it, never put it in
     a URL query string.
3. The tools are read-only and the server is off by default. If a tool
   call fails to connect, the fix is always in Titer Settings first.

## Path A — the Titer plugin (recommended)

The plugin is `plugins/titer/` in this repo: a `plugin.json` manifest, a
bundled `mcp_config.json` (one remote server, `titer_local`), a
`titer` skill, and the app logo. It uses the **remote transport**
(`serverUrl` + bearer token): Google's plugin docs prefer remote HTTPS
endpoints or cross-platform Node.js scripts for bundled servers, and the
remote transport works the same on macOS, Linux, and Windows. (Our server
is a local binary, not a remote service — the honest implication is in
[Limitations](#limitations) below.)

**Install from the CLI** (needs the `agy` CLI):

```sh
agy plugin install ./plugins/titer   # from a checkout of this repo
agy plugin install https://github.com/smitpatel316/Titer   # from GitHub
agy plugin list                      # verify it is installed and enabled
```

**Install from the App:** open **Customizations → Marketplace** and find
Titer (once listed), or place the `plugins/titer/` folder in
`~/.gemini/config/plugins/` (all workspaces) or
`<workspace>/.agents/plugins/` (one workspace), then enable it under
**Customizations → Installed**.

**Configure:** installing leaves the plugin disabled until configured.
Enable it and Antigravity opens a setup dialog asking for the **Titer MCP
endpoint** and **Titer local token** — paste the two values from Settings
(see Prerequisites). The bundled server is then `titer_local`, with the
five tools allowlisted and `titer_list_projects` eager-loaded (the rest
load lazily on demand). If you regenerate the token in Titer Settings,
re-enter the new one in the plugin setup.

**Validate (maintainers):** from a checkout,

```sh
agy plugin validate --strict ./plugins/titer
```

## Path B — `mcp_config.json` by hand (both transports)

Antigravity reads MCP servers from `mcp_config.json` — globally at
`~/.gemini/config/mcp_config.json`, or per workspace at
`<workspace>/.agents/mcp_config.json` (in the App: Customizations →
Installed → MCP Servers → **Copy Config File Path** shows the file; in
the CLI, `/mcp` opens the server manager). Add one entry under
`mcpServers`. The two transports are alternatives — pick one, not both
(two entries would register the same five tools twice under different
names).

Both snippets below allowlist exactly the five Phase 1 tools. That is
deliberate: when Phase 2 adds write tools, they stay hidden in Antigravity
until you opt in. `timeoutSeconds: 300` matches the bridge's per-request
timeout — analyses can be slow; the default is 180 s per call.
`tools.titer_list_projects.eager: true` registers the discovery tool
upfront; the rest stay lazy-loaded.

### Remote transport (`serverUrl`) — same shape the plugin uses

```json
{
  "mcpServers": {
    "titer": {
      "serverUrl": "http://127.0.0.1:18741/mcp",
      "headers": {
        "Authorization": "Bearer <paste the token from Titer → Settings → AI connections>"
      },
      "enabledTools": [
        "titer_list_projects",
        "titer_list_tables",
        "titer_read_table_summary",
        "titer_read_results",
        "titer_read_graph"
      ],
      "tools": {
        "titer_list_projects": { "eager": true }
      },
      "timeoutSeconds": 300
    }
  }
}
```

Replace the port if Settings shows a different one, and re-paste the token
if you ever regenerate it. (`serverUrl` is the documented field; `url` is
accepted as an alias — the plugin's bundled config uses `url` because
Google's plugin docs list `url` as the field `${VARIABLE}` expansion
applies to.)

### stdio transport (bridge binary) — no token in your config

Titer ships a small bridge binary, `titer-stdio-bridge`, next to the app
binary (Tauri `externalBin`). It reads the endpoint + token straight from
Titer's connection file, so token rotation needs no config edit — that is
the stdio path's advantage over the remote path. It speaks stdio to
Antigravity and Streamable HTTP to Titer, nothing else.

```json
{
  "mcpServers": {
    "titer": {
      "command": "/Applications/Titer.app/Contents/MacOS/titer-stdio-bridge",
      "enabledTools": [
        "titer_list_projects",
        "titer_list_tables",
        "titer_read_table_summary",
        "titer_read_results",
        "titer_read_graph"
      ],
      "tools": {
        "titer_list_projects": { "eager": true }
      },
      "timeoutSeconds": 300
    }
  }
}
```

The `command` above is the macOS path (verified: product name `Titer` +
`externalBin` staging). On Windows use the `titer-stdio-bridge.exe`
sitting next to the installed `Titer.exe`; on Linux the
`titer-stdio-bridge` next to the installed Titer executable — adjust the
path to your install location. Verify the bridge before pointing
Antigravity at it:

```sh
/Applications/Titer.app/Contents/MacOS/titer-stdio-bridge --check
# exit 0 = the Titer server is reachable; 1 = unreachable; 2 = no connection file/token
```

(If Titer is not installed from a release build yet, the binary does not
exist — build it with `scripts/build-stdio-bridge.sh`.)

## Verify the connection

1. In the App: **Customizations → Installed → MCP Servers** — the server
   shows with a green status dot and “5 tools enabled”. (⋮ → **Restart**,
   **Disable**, **Delete** manage it.) In the CLI: `/mcp`.
2. Ask the agent: “List my open Titer projects and their tables.” It
   should call `titer_list_projects` and report what Titer has open.
3. Cross-check in Titer: **Settings → AI connections → Activity log**
   records every tool call (tool name + args summary, never values or the
   token).

## Permissions

MCP tools run in **Ask** mode by default — Antigravity asks before
running one. To allow them, use the policy entries `mcp(titer/*)` (config
path) or `mcp(titer_local/*)` (plugin path), or `mcp(*)` for all MCP
tools. The server itself is read-only, so allowing a tool can never change
anything in Titer — but Ask mode is still the safer default.

## Troubleshooting

- **Connection refused / server not found:** the Titer server is off. In
  Titer, Settings → AI connections → turn on “Allow AI apps to connect”,
  then restart the server entry in Antigravity.
- **401 Unauthorized:** the token changed. Re-copy it from Titer Settings
  (remote path: re-paste into `mcp_config.json` or the plugin setup;
  stdio path: restart the bridge — it re-reads the connection file).
- **400 “This is an MCP endpoint”:** the client didn't send the MCP
  headers. Antigravity's own client sends them; if you see this with
  Antigravity, report it — it means the client and server disagree about
  the Streamable HTTP handshake.
- **Wrong port:** the server takes the first free port in 18741–18750.
  Copy the exact endpoint from Settings (or the discovery file).
- **A tool returns `not_computed`:** the analysis hasn't been run in this
  Titer session. Open it in Titer and run it — the agent must not invent
  a result.

## Limitations (honest)

- **Local binary, not a remote service.** Google's plugin docs prefer
  remote HTTPS endpoints or cross-platform Node.js scripts for bundled MCP
  servers. Titer's server is a loopback-only binary by design (local app,
  no cloud), so the plugin uses the remote *transport* to a loopback URL
  and the stdio path is config-file only: Antigravity's `mcp_config.json`
  has no platform-conditional `command`, and the bridge binary lives at
  an install-dependent path, so one bundled stdio entry cannot serve
  macOS, Linux, and Windows. `agy plugin validate` may warn about this;
  it is a known shape, not a bug.
- **The token is pasted by hand on the remote path.** Antigravity cannot
  read Titer's connection file; the plugin's setup dialog is the sanctioned
  place for that paste (the docs' `variables` mechanism). The token is
  stable until regenerated, so this is a one-time paste, not a per-session
  one.
- **No OAuth.** By design: the contract (§3) is a local bearer token, not
  OAuth 2.1 (which the docs reserve for remote servers). Antigravity's
  OAuth machinery is not involved.
- **Live end-to-end against Antigravity is not yet run.** The plugin
  passes `agy plugin validate --strict` (see verification below), but no
  live `initialize → tools/list → tools/call` against the real Titer
  server from Antigravity has happened yet — that needs a signed-in
  Antigravity session and a running Titer on the Mac, which this lane
  deliberately did not do (no sign-ins). In particular, that live run is
  what will confirm Antigravity sends the `MCP-Protocol-Version` header
  the server requires (standard MCP clients do; untested for Antigravity
  specifically).
- **Marketplace listing is not submitted.** The plugin installs from a
  local folder or a GitHub URL today. Listing it in the Antigravity
  Marketplace goes through Google's partner intake form and is a
  separate, Smit-approved step — not this lane.

## Verification status (this lane, 2026-11-14)

- `agy plugin validate --strict ./plugins/titer`: **see
  `~/.helix-mcp-antigravity/investigations.md`** for the verbatim output
  (run on the Mac, where the `agy` CLI lives).
- `npm run check` (`tsc --noEmit`): clean after merging `v3/mcp-server` +
  `v3/stdio-bridge` (one conflict, `mod updater` vs `mod mcp`, both kept).
- Bridge crate: discovery reconciled with the landed server contract
  (`mcp/discovery.json`, `endpoint`); unit tests updated for the contract
  shape + the legacy draft shape — run under the lane memory gate, see the
  investigations log.
- Live Antigravity UI path (Customizations → MCP Servers / Plugins) and
  live tool calls: **unverified** — the App demands sign-in; this lane
  does not sign in anywhere.
