# stdio bridge + .mcpb — design (v3 Phase 1, "The pipe")

**Branch:** `v3/stdio-bridge` (off `cec336d`), merged into
`v3/claude-desktop` Nov 14 with `v3/mcp-server`. **Status:** bridge built +
unit-tested + smoke-tested against a contract-faithful fake server in the
`v3/claude-desktop` lane (see §6–§7); the contract assumptions in §2 are
reconciled with the real server code. **Companion lane:** `v3/mcp-server`
owns the in-app MCP server and `docs/mcp-server-contract.md` — it has
landed, and §2 lists the reconciliation (A1–A7). Nothing here is a merge
to main: branch only, no merges anywhere.

## 1. What this lane ships

| Piece | Location | Notes |
|---|---|---|
| Bridge binary (Rust) | `src-tauri/mcp-bridge/` | Standalone crate, `titer-stdio-bridge`. Reads stdin lines, POSTs each to the app server, writes replies to stdout. |
| Tauri packaging | `src-tauri/tauri.conf.json` (`bundle.externalBin`) | `binaries/titer-stdio-bridge` — staged per target triple by `scripts/build-stdio-bridge.sh`. |
| .mcpb bundle source | `mcpb/manifest.json` | MCPB spec 0.3, `server.type: binary`, darwin + win32. Packed by `scripts/pack-mcpb.sh`. |
| Build/pack scripts | `scripts/build-stdio-bridge.sh`, `scripts/pack-mcpb.sh` | Build + stage binaries; validate + pack the bundle. |
| This doc | `docs/stdio-bridge.md` | Decisions, contract, verification status. |

## 2. Token discovery — the decision

**Decision: a token file in the app-data dir.** When the user turns on AI
connections in Titer Settings, the app writes
`<app_data_dir>/mcp/discovery.json` atomically (temp file + rename), mode
`0600` — the shape the server lane actually writes (contract §2, reconciled
in the `v3/claude-desktop` lane; the pre-contract draft name was
`<app_data_dir>/mcp.json` with `url` / `protocol_version`, which the bridge
still accepts as a fallback):

```json
{"endpoint": "http://127.0.0.1:<port>/mcp", "token": "<opaque bearer>", "protocol_versions": ["2025-11-25", "2025-06-18"], "server": "titer", "version": "<app version>"}
```

The bridge reads it at startup. The app removes the file when AI
connections are turned off, and generates a fresh token on each enable
(rotation = re-enable). Env vars `TITER_MCP_URL` / `TITER_MCP_TOKEN` /
`TITER_MCP_DISCOVERY` override individual fields, for dev and for Claude
Code users who run the bridge by hand. The `.mcpb` manifest sets **no**
token and declares **no** `user_config` at all.

**Why not the alternatives:**

- *Env var set by the `.mcpb` manifest (`user_config` + `${user_config.…}`):*
  rejected. It would make the user paste the token into Claude Desktop's
  settings UI by hand (terrible UX for the non-coder test), leave a second
  copy of the secret in Claude's config outside Titer's control, and go
  stale on every rotation — with no way for Titer to update it.
- *No token at all (trust loopback):* rejected. The roadmap's server binds
  `127.0.0.1` and requires a bearer token, and the token is what keeps a
  drive-by web page (or any other local app) from calling the server. The
  bridge must present it.

**Security reasoning (honest version).** The token's job is to keep
*other origins* out — browsers and other apps that can reach `127.0.0.1`
but cannot read the user's files. A `0600` file in the user's own app-data
dir preserves exactly that boundary: only processes running as the user can
read it, and a same-uid process is already fully trusted on a desktop (it
can read the user's files directly, token or no token). So the file adds no
new exposure beyond what the loopback server already implies. What the file
must NOT do: live anywhere world-readable, be logged, or be copied into
any AI client's config — the bridge never prints the token, and `--check`
prints only the URL.

**App-data dir (must match Tauri's `app.path().app_data_dir()` for bundle
id `net.smitpatel.helix`):** macOS `~/Library/Application Support/net.smitpatel.helix`,
Windows `%APPDATA%\net.smitpatel.helix`, Linux
`${XDG_DATA_HOME:-~/.local/share}/net.smitpatel.helix`. The app already
uses `app_data_dir()` (`src-tauri/src/main.rs`, e.g. `open-projects`,
palettes) — the bridge duplicates the three paths rather than depending on
Tauri, and the match is verified at integration time.

### Interface assumptions for merge-time reconciliation (server lane owns these)

| # | Assumption in this lane | Owner / reconcile with |
|---|---|---|
| A1 | Server is Streamable HTTP on `127.0.0.1`, endpoint path `/mcp`, bearer token required. | Roadmap §1 + `docs/mcp-server-contract.md` — CONFIRMED against `src-tauri/src/mcp.rs`. |
| A2 | Discovery file `<app_data_dir>/mcp/discovery.json` with `endpoint`, `token`, `protocol_versions` (contract §2); atomic write, mode 0600; removed on disable; fresh token per enable. Bridge accepts the pre-contract `mcp.json` / `url` / `protocol_version` shape as a fallback. | `v3/mcp-server` lane (server writes it) — RECONCILED Nov 14 in `v3/claude-desktop`: the draft path/fields were wrong; the bridge now reads the contract shape. |
| A3 | Port is the server lane's choice, published in the file — the bridge is port-agnostic. No fixed port is assumed anywhere in this lane. Server tries 18741–18750. | `v3/mcp-server` lane — CONFIRMED (`PORTS` in `mcp.rs`). |
| A4 | Spec revisions 2025-06-18 / 2025-11-25; NOT 2026-07-28 until clients adopt it. Bridge is transport-only and version-agnostic — EXCEPT it must send an `MCP-Protocol-Version` header on every request (the server's auth middleware answers 400 without one, contract §3). The bridge sends the revision the client's `initialize` named when it is a supported 2025 revision, else 2025-11-25. | Roadmap §1 + contract §3 — RECONCILED Nov 14 in `v3/claude-desktop`: the missing header was a second breaking gap; the bridge now sends it. |
| A5 | Settings label the error message names: "AI connections" / "Allow AI apps to connect". The bridge's `SERVER_OFF_MESSAGE` uses the contract §1 canonical wording. | `v3/mcp-server` lane (Settings UI) — CONFIRMED (`ai-connections-dialog.tsx`). |
| A6 | Tool names are the server lane's; the `.mcpb` declares no static `tools` list (`tools_generated: true`). | `docs/mcp-server-contract.md` — CONFIRMED (five tools, §5). |
| A7 | On client disconnect the bridge closes the server session with DELETE + `Mcp-Session-Id` (contract §4.5). On 401 it re-reads the discovery file once and retries once, then surfaces the contract's token-changed message. | Contract §2–§4 — ADDED Nov 14 in `v3/claude-desktop`. |

## 3. Protocol translation (stdio ↔ Streamable HTTP)

One stdin line = one JSON-RPC 2.0 message. The bridge forwards the line
verbatim as a single HTTP POST and translates the reply back:

| Client → bridge (stdin) | Bridge → server (POST) | Server reply | Bridge → client (stdout) |
|---|---|---|---|
| Request (has `id`) | POST `url`, `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `MCP-Protocol-Version: <2025 revision>` (REQUIRED — server answers 400 without it, contract §3), `Authorization: Bearer <token>`, `Mcp-Session-Id: <sid>` if known | `200 application/json` | The JSON body, one line |
| Request | same | `200 text/event-stream` | Each `data:` payload, one line each |
| Request | same | `202` | JSON-RPC `-32000` error ("accepted but no response" — a server bug for a request) |
| Notification (no `id`) | same | `202` | Nothing (correct — notifications get no reply) |
| Response to a server request | same | `200` | Translated as above |
| JSON-RPC batch (array) | — | — | `-32600` per member id (Streamable HTTP forbids batches) |
| Unparseable line | — | — | `-32700` parse error, `id: null` |

- **Session id:** captured from the `Mcp-Session-Id` response header
  (initialize) and sent on every later request; refreshed whenever the
  server returns a new one. On stdin EOF the bridge closes the session
  with DELETE + the session id (contract §4.5).
- **Protocol version:** the `MCP-Protocol-Version` header carries the
  revision the client's `initialize` named (when it is a supported 2025
  revision), else the server's advertised revision, else 2025-11-25.
- **401:** the token may have rotated — the bridge re-reads the discovery
  file once and retries once, then surfaces the contract's token-changed
  message ("The token changed — restart the bridge…").
- **Timeout:** 300 s per request (analyses can be slow). A timeout returns
  `-32000` telling the user to check Titer's Activity log — the analysis
  may still be running.
- **Sequential (deliberate Phase 1 limit):** one round-trip at a time, in
  stdin order. A slow tool call blocks later messages including `ping`.
  Acceptable because the server dispatches on the app's main thread
  (roadmap §1) — concurrency buys nothing until the server does.
- **Logging:** stderr only, errors/warnings only. The token is never
  logged. Claude Desktop captures stderr, so the server-off message is
  visible there as well as in `--check`.

## 4. Error handling — server-not-running case

The requirement is a **clear error, not a hang or a crash**:

- **At startup** (discovery file missing/unreadable/invalid, or no token):
  print to stderr and exit **2**. Example:
  `titer-stdio-bridge: Titer's AI connection file was not found
  (…/net.smitpatel.helix/mcp/discovery.json). Titer's AI connections are off
  or Titer isn't running. Turn on 'Allow AI apps to connect' in Titer →
  Settings → AI connections, then try again.`
- **Mid-session** (app closed after the bridge started): each affected
  request gets a JSON-RPC `-32000` error with that same message; the bridge
  **stays alive** and works again when the user opens Titer — no AI-client
  restart needed. Notifications that fail are logged to stderr only.
- **Client gone** (stdin EOF / stdout broken pipe): exit **0**, quietly
  (stdin EOF also closes the server session with DELETE first).
- **`--check`:** a real `initialize` handshake (protocolVersion 2025-11-25),
  then the session is closed again; exit 0 = reachable, 1 = server
  unreachable or handshake refused, 2 = no discovery/token. A bare `ping`
  is NOT a reliable probe — the server's session manager rejects
  non-initialize requests without a session. For the Settings panel's
  future "Test connection" button and for support.

Exit codes: 0 normal, 1 server unreachable / HTTP setup failed,
2 config or argument error.

## 5. Packaging

**Tauri `externalBin` (verified against the official docs,
https://v2.tauri.app/develop/sidecar/):** `tauri.conf.json` declares
`"externalBin": ["binaries/titer-stdio-bridge"]`. At bundle time Tauri
looks for `src-tauri/binaries/titer-stdio-bridge-<target-triple>` (e.g.
`…-aarch64-apple-darwin`, `…-x86_64-pc-windows-msvc.exe`), strips the
suffix, and places the binary next to the app binary (`Contents/MacOS/` on
macOS, code-signed with the app identity). `scripts/build-stdio-bridge.sh`
builds the standalone crate and stages the files; `--all` builds macOS
arm64+x64 + Windows, `--mcpb` also stages the `.mcpb` copies. The bridge
crate is deliberately **not** a workspace member, so the app's
`Cargo.toml`/`Cargo.lock` are untouched. Staged binaries are gitignored
build artefacts.

**`.mcpb` bundle:** `mcpb/manifest.json` + `server/titer-stdio-bridge`
(macOS universal via `lipo`) + `server/titer-stdio-bridge.exe` (Windows)
+ `icon.png` (copied from `src-tauri/icons/icon.png`, 512×512).
`scripts/pack-mcpb.sh` stages the binaries, validates the manifest
(Python check always; `mcpb validate` when the official CLI is installed),
and packs with `mcpb pack . <output>` or a plain-zip fallback (which says
so loudly). The bundle is **unsigned** in this lane — `mcpb sign` needs a
code-signing certificate that does not exist yet; unsigned bundles install
fine, signing is a release-step decision.

## 6. .mcpb verification status (roadmap open item 3 — now closed, with limits)

**Verified 2026-11-13 from authoritative sources:**

- Format + install flow: Anthropic docs,
  https://claude.com/docs/connectors/building/mcpb (updated 2026-11-12) —
  `.mcpb` is a zip of server + `manifest.json`; install by double-click,
  drag into Claude Desktop, or Settings → Extensions → Advanced settings →
  Install Extension…; directory listings are deprecated (hand users the
  file). Claude Desktop runs on macOS (`darwin`) and Windows (`win32`).
- Manifest schema v0.3 (last updated 2025-12-02):
  https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md —
  required fields `manifest_version`, `name`, `version`, `description`,
  `author`, `server`; `server.type: binary` with `entry_point` and
  `mcp_config` (`command`, `args`, `env`, `platform_overrides`,
  `${__dirname}`/`${user_config.…}` substitution, `.exe` auto-appended on
  Windows); `user_config` schema; `tools_generated` flag; `compatibility`
  (`platforms`, `claude_desktop` semver); resources are intentionally not
  in the manifest.
- CLI: https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md —
  `mcpb pack <directory> [output]`, `mcpb validate`, `mcpb sign/verify/info`;
  binary-bundle layout `server/my-server` + `server/my-server.exe` +
  `icon.png`; `.mcpbignore` support.
- Repo moved `anthropics/mcpb` → `modelcontextprotocol/mcpb`; `.dxt` →
  `.mcpb` rename (Sep 11, 2025); old `.dxt` still works.

**Assumed, not verified** (nothing in this lane depends on assuming them —
each is flagged where it is used):

- That Claude Desktop accepts a `binary`-type server whose `mcp_config`
  command uses `${__dirname}` (the spec's binary example uses a bare
  relative `command`; `${__dirname}` substitution is specified for
  `mcp_config` generally — the combination is untested until a live pack).
- That the `win32` `platform_overrides` entry is honoured over the
  auto-`.exe` rule (both mechanisms are specified; the override is the
  belt-and-braces path).

**Verified 2026-11-14 in the `v3/claude-desktop` lane** (this branch):

- `cargo fmt --check`, `cargo test --release` (9 unit tests, all pass —
  incl. new tests for the contract discovery shape, legacy shape, and
  protocol-version tracking), `cargo build --release` — bridge binary
  `src-tauri/mcp-bridge/target/release/titer-stdio-bridge` (1.7 MB).
  One compile fix was needed on resume: `run_loop` borrowed `cfg` while
  passing `&mut cfg` to `forward` (E0502); the header value is now owned.
- `scripts/smoke-test-bridge.py` — 24/24 checks pass against a
  contract-faithful fake server: `--check` initialize handshake + DELETE,
  full session (initialize → tools/list → tools/call incl. SSE +
  `not_computed`), version header + bearer <redacted> on every POST, session-id
  echo, DELETE on stdin EOF, server-down `-32000` + exit 0, missing
  discovery exit 2, 401 → token-changed message, 401 → re-read + retry
  succeeds after rotation. One test fix: `httpd.shutdown()` alone leaves
  the listening socket open (connect succeeds, then hangs in the backlog),
  so the test now also calls `server_close()`.
- `mcpb validate` (official `@anthropic-ai/mcpb` CLI 2.1.2 via npx):
  schema passes; icon passes (512×512, only the generic size note).
  `mcpb pack` run against a scratch staged bundle (manifest + icon +
  Linux bridge binary as stand-in): packs fine, 809 KB, unsigned warning
  as expected. The real bundle still needs the macOS universal + Windows
  binaries from `scripts/build-stdio-bridge.sh --mcpb` (release-time, on
  the Mac / with cross targets installed) — that pack is untested.
- `npm run check` (tsc) clean after the merges.

**Still pending** (needs the built app + Claude Desktop — see §8):

- A live install of a packed `.mcpb` in Claude Desktop and an end-to-end
  `initialize → tools/list` against the real in-app server. Claude
  Desktop is NOT installed on the Mac and using it requires sign-in, so
  this stays unverified (no account creation / sign-ins in this lane).
- macOS universal (`lipo`) + Windows cross builds via
  `scripts/build-stdio-bridge.sh`; a real `mcpb pack` of those binaries.

## 7. Tests written and run (in the `v3/claude-desktop` lane, Nov 14)

Unit tests in `src-tauri/mcp-bridge/src/main.rs` — 9/9 pass (`cargo test
--release`): SSE parsing (single / multi-event / trailing event / empty),
discovery-file parsing (contract shape + legacy shape), protocol-version
tracking (supported 2025 revisions only), error-reply id preservation,
and the server-off message naming the fix. Plus
`scripts/smoke-test-bridge.py` — 24/24 pass (see §6). Manual checks for
the integration pass: `--check` against the real server; Claude Desktop
install of the packed `.mcpb`; kill Titer mid-session and confirm the
`-32000` message, then re-open Titer and confirm the next request
succeeds without restarting Claude.

## 8. Open items (merge-time, not blockers for this lane)

1. ~~Reconcile §2 assumptions A1–A6 with `docs/mcp-server-contract.md`
   when it lands~~ — DONE Nov 14 in `v3/claude-desktop` (assumptions A1–A7
   in §2 above): the draft discovery path/fields and the missing
   `MCP-Protocol-Version` header were both wrong against the real server
   code and are fixed in the bridge; see
   `~/workspace/.helix-mcp-claude-desktop/investigations.md`.
2. Build verification — DONE Nov 14 in `v3/claude-desktop` except the
   live install (see §6–§7 and the lane log): `cargo build --release`,
   `cargo test` (9/9), `cargo fmt`, `mcpb validate`, `mcpb pack`
   (scratch bundle; real Mac/Windows-binary pack is release-time).
   Live Claude Desktop install + end-to-end against the real server
   still unverified: Claude Desktop is not on the Mac and using it
   needs sign-in (no sign-ins in this lane).
3. Decide bundle signing (`mcpb sign`) at release time — needs a cert.
4. `.mcpb` distribution: the file is handed to users directly (directory
   listings are deprecated); the Settings panel's "Claude Desktop" button
   (Phase 2, roadmap §1 flow) downloads/opens it.
5. Sequential-processing limit (§3) — revisit if the server gains real
   concurrency; a threaded bridge is a small, contained change.
