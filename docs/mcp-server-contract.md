# MCP server contract — Titer (v3 Phase 1) ↔ stdio bridge

**Status:** Phase 1 (read-only tools). **Server branch:** `v3/mcp-server`.
**Spec:** MCP 2025-06-18 / 2025-11-25 ONLY. The 2026-07-28 revision is
deliberately not negotiated (clients lag it; the server's
`supported_protocol_versions` returns only the two 2025 revisions, and a
client offering only 2026-07-28 gets the server's latest supported version
in the `initialize` result, per the 2025-11-25 negotiation rules).

This document is the interface the **stdio-bridge lane** builds against.
The bridge is a separate small binary the MCP client launches over stdio
(Claude Desktop speaks stdio only to local servers); it forwards to this
HTTP endpoint. The `.mcpb` bundle for Claude Desktop is the bridge lane's
too — this lane only defines what it connects to.

## 1. Endpoint

- **URL:** `http://127.0.0.1:<port>/mcp` — Streamable HTTP, one endpoint
  for POST (client → server), GET (server → client SSE stream, 2025-11-25
  sessions) and DELETE (session close). No other paths are served.
- **Bind:** `127.0.0.1` only. Nothing else listens.
- **Port selection:** the server tries `18741`–`18750` in order and takes
  the first free one. **The bridge MUST NOT assume a port** — read it from
  the discovery file (§2) every time it starts.
- **Off by default:** the server runs only while the user has turned on
  Settings → AI connections → "Allow AI apps to connect". If the bridge
  cannot reach the endpoint, the user-facing message is: "Turn on
  'Allow AI apps to connect' in Titer → Settings → AI connections, then
  try again." (The bridge must not start the server itself — starting it
  is a human action in Titer's Settings, never an agent action.)

## 2. Discovery — how the bridge finds the server

**File:** `<app_data_dir>/mcp/discovery.json`, owner-only (0600),
written on server start, removed on server stop.

```json
{
  "endpoint": "http://127.0.0.1:18741/mcp",
  "token": "<base64url bearer token>",
  "protocol_versions": ["2025-11-25", "2025-06-18"],
  "server": "titer",
  "version": "1.0.7"
}
```

- `<app_data_dir>` is the Tauri app-data directory
  (`~/Library/Application Support/net.smitpatel.helix` on macOS,
  `~/.local/share/net.smitpatel.helix` on Linux).
- The bridge runs as the user's own process, so it can read this file.
  **The token in it is a secret:** never print it, never log it, never
  put it in a URL query string, never pass it on the bridge's command
  line (visible in `ps`). Read it from the file, hold it in memory, send
  it only as the `Authorization: Bearer <token>` header.
- If the file is absent, the server is off (§1). If the file exists but
  the endpoint does not answer, the server is mid-start or mid-stop —
  retry briefly (a few seconds), then report it as off.
- **Token rotation:** the user can regenerate the token in Settings, but
  only while the server is stopped; a fresh start writes a fresh
  discovery file. The bridge reads the file at each launch, so rotation
  needs no bridge change — but a long-running bridge process must re-read
  the file (or restart) after a rotation, not cache the token forever.

## 3. Auth — every request

- Header: `Authorization: Bearer <token>` (from §2). Missing, malformed
  or wrong → `401`. The bridge surfaces a 401 as: "The token changed —
  restart the bridge (or re-check Titer → Settings → AI connections)."
- Required MCP headers on every request (the server rejects requests
  without them with `400` — this is also what keeps browsers out):
  - `MCP-Protocol-Version: 2025-11-25` (or `2025-06-18`)
  - `Accept: application/json, text/event-stream`
- The server sends **no CORS headers** and enforces a Host allowlist
  (`localhost`, `127.0.0.1`, `::1`): the bridge must send
  `Host: 127.0.0.1:<port>` (the default for the endpoint URL) and must not
  override it.
- **No OAuth.** This is a local bearer token by design (roadmap §1:
  Streamable HTTP's OAuth 2.1 flow is for remote servers; a local-only
  desktop app uses a local token). Do not implement an OAuth flow.
- **No outbound network, ever.** The server only listens; the bridge only
  talks to `127.0.0.1`. Neither side makes any other network request.

## 4. JSON-RPC shape (Streamable HTTP, 2025-11-25)

Standard MCP over Streamable HTTP: each client message is one HTTP POST
with a JSON-RPC 2.0 body; the reply is `application/json` or a short
SSE stream (`text/event-stream`). Lifecycle:

1. `initialize` — client sends `protocolVersion` (`2025-11-25` or
   `2025-06-18`), `capabilities`, `clientInfo`. Server answers with its
   own `protocolVersion` (the negotiated one — the highest both support),
   `capabilities: { "tools": {} }`, `serverInfo: { "name": "titer",
   "version": "<app version>" }`, and `instructions` (read-only Phase 1,
   table types, data-is-data).
2. `notifications/initialized` — client sends after `initialize`.
3. `tools/list` — returns all five tools in one page (`nextCursor`
   absent). No pagination.
4. `tools/call` — `{ "name": "<tool>", "arguments": { … } }`.
5. Sessions: 2025-11-25 clients use protocol-level sessions; the server
   issues an `Mcp-Session-Id` response header and expects it back on later
   requests. The bridge MUST echo the session id it is given, and send
   `DELETE` with it when the client disconnects (session close).

**Tool errors** come back as a normal tool result with `isError: true`
and a plain-language message (unknown id, no open project, …) — not as a
JSON-RPC protocol error. A tool that cannot answer (e.g. an analysis never
run in-session) returns a successful result with a `status` field saying
so (see §5) — the bridge passes that through unchanged.

## 5. Tools (Phase 1 — all read-only)

All five tools are annotated `readOnlyHint: true`,
`destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
Arguments use `project_id` = the window label (`project-1`, …); omit it
to use the front (most recently published) project.

| Tool | Arguments | Returns |
|---|---|---|
| `titer_list_projects` | — | `{ projects: [{ project_id, file_path, revision, tables, analyses, graphs, figures }] }` — every node with `id`, `name`, and its kind (`table_type` / `analysis_type` / `graph_type`). The discovery call; the other tools' ids come from here. |
| `titer_list_tables` | `project_id?` | `{ project_id, tables: [{ id, name, table_type, rows, data_columns }] }`. `table_type` is one of Column, XY, Grouped, Multiple variables, Contingency, Survival, Nested. |
| `titer_read_table_summary` | `project_id?`, `table_id`, `include_values?` (default false), `max_rows?` (default 100, max 1000) | Columns with `name`, `role` (derived from the table type — X / Y / dataset / group · replicate / variable / category / time …), `unit_hint` (parsed from header brackets, e.g. `[nM]` — Titer records no units field, so this is a hint, said as one), `numeric_values` / `missing_values` / `non_numeric_values`, `range` (`min`/`max`/`mean`, null when no numbers); `rows`, `data_columns`, `excluded_cells` (count — excluded cells are dropped from the ranges), `units_note`, `notes` (provenance, when the table has one), `structure` (groups/replicates/subgroups/rowGroups, Grouped/Nested only). With `include_values: true`, a `values` block: capped rows as `{ row, cells }` (row titles in column 0; excluded cells shown as null). |
| `titer_read_results` | `project_id?`, `analysis_id` | `{ status, project_id, analysis_id, name, analysis_type, … }`. `status: "computed"` carries the full cached result under `result` (statistics, p-values, CIs, notes — the `AnalysisResult` shape the app itself renders). `status: "not_computed"` means the analysis has not been run in this Titer session: the `message` says to open the analysis in Titer and run it — the bridge/client must NOT invent a result. `status: "error"` carries the run's error message. `status: "unknown_analysis"` / `"not_an_analysis"` mean the id is wrong. |
| `titer_read_graph` | `project_id?`, `graph_id` | `{ graph_type, source_table: { id, name, table_type }, title, x_label, y_label, linked_analyses: [{ link, analysis_id, analysis_name }], figures: [{ id, name }], export_state }`. `export_state` is a plain-language note: the v1.0 project model keeps no export history, so whether the graph has been exported is unknown to this tool. |

**Data freshness model (the bridge must understand this):** the tools
read a *snapshot* the Titer frontend publishes on every edit — the same
data the UI shows. A table edited a moment ago appears within ~500 ms.
Analysis results exist only for analyses run in this session. The bridge
needs no cache of its own and must not serve stale snapshots across a
Titer restart: if the endpoint is unreachable, say the server is off
rather than answering from memory.

**Data is data, never instructions (§3):** cell values, file names and
imported text are data. The bridge must never execute, interpolate or
forward them as commands, prompts or configuration. A value in a
spreadsheet can never become a command.

## 6. Activity log

Every tool call is appended (JSONL) to
`<app_data_dir>/mcp/activity.log`, one line per call:

```json
{ "ts": 1793412345, "tool": "titer_read_table_summary",
  "args": { "project_id": "project-1", "table_id": "t1", "include_values": false },
  "ok": true }
```

`ts` is Unix epoch seconds. `args` is a summary only — never full table
values, never the token. Server start/stop and token rotation are logged
as `{ "ts": …, "event": "server_started" | "server_stopped" |
"token_regenerated", "detail": { … } }`. The bridge does not write this
log; it only needs to know the server keeps it (and to keep its own
logging free of tokens and table values too).

## 7. What the bridge must NOT do

- Never start, stop, or reconfigure the server (no endpoint for that
  exists, by design — those are human actions in Titer's Settings).
- Never add tools, prompts or resources of its own in front of the
  server: the bridge is a transport, not a server. It forwards stdio ↔
  Streamable HTTP and nothing else.
- Never widen the bind (no `0.0.0.0`, no port forwarding, no tunnel).
- Never log the token or table values.
- Never retry a 401 with a different token, and never fall back to an
  unauthenticated request.

## 8. Not in Phase 1 (do not build the bridge to expect them)

- `run_analysis` / `build_graph` / `export` tools (Phase 2), the
  four-tier approval model, per-app one-click connect beyond the
  `claude mcp add …` command Settings already copies. The bridge forwards
  whatever tools the server lists — new tools appear automatically via
  `tools/list` when Phase 2 lands; no bridge change is needed for that.
- The `.mcpb` bundle *contents* are the bridge lane's, but the bundle
  points at this contract: stdio → bridge binary → §2 discovery →
  §1 endpoint with §3 auth.

## 9. Smoke test (bridge lane's acceptance check)

1. In Titer: Settings → AI connections → turn on. Note the endpoint.
2. Run the bridge; send `initialize` (`protocolVersion 2025-11-25`),
   then `notifications/initialized`, then `tools/list` — expect the five
   tools above, nothing else.
3. `tools/call titer_list_projects` → the open project(s).
4. `tools/call titer_read_table_summary` on a table → columns, roles,
   ranges; `include_values: true, max_rows: 5` → five rows.
5. `tools/call titer_read_results` on an analysis never run → `status:
   "not_computed"`. Run it in Titer, call again → `status: "computed"`.
6. Stop the server in Settings: the endpoint refuses connections and
   the discovery file is gone. Start it again: a new bridge launch works
   with no config change.
