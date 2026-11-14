# Cloud storage — Box first (v2 backlog item 75)

**Branch:** `v2/cloud-box` · **Plane:** "Cloud storage connections (Box first)" (`d3164329-…`)
**Status:** Box slice built (shared layer + Box provider + mock provider).
Build verification (Rust) and manual provider checks are **pending v1 clear** —
this lane runs code + `npm run check` only, by the v1-owns-the-box rule.

## Box PKCE verdict — verified at build time, 2026-11-13

**PKCE S256 challenges are accepted, but a secret-less public-client flow
cannot complete for Box.** Box's own authorization-server metadata
(`https://account.box.com/.well-known/oauth-authorization-server`, fetched
live 2026-11-13) says both:

- `"code_challenge_methods_supported": ["S256"]` — PKCE challenges accepted
- `"token_endpoint_auth_methods_supported": ["client_secret_basic",
  "client_secret_post"]` — **no `"none"` method**

Every token call (`authorization_code` and `refresh_token`) mandates a
client secret. Corroboration:

- Alter's Box OAuth reference lists **PKCE: Not supported** (i.e. the
  PKCE-only public-client flow is not supported).
- `arctic-oauth`'s provider matrix: Box, PKCE "Not supported".
- Box Pulse feature request "Add PKCE Support for OAuth2 Applications" is
  still open: "Currently, Box requires developers to use a client secret
  for OAuth 2.0 apps…"
- Box's own auth guide: OAuth 2.0 "proves identity with: client secret
  plus user consent".

**Consequence:** no PKCE-only Box auth is built here. The research doc's
"public client, no client secret in the binary" design (§2/§3) does not
hold for Box. The Box provider implements Box's documented
confidential-client authorization-code flow — loopback redirect + `state` +
PKCE S256 challenge (kept as defence-in-depth; Box advertises it) +
`client_secret` at the token exchange — with the secret sourced only from
the two options below. No secret ships in the app; `BOX_CLIENT_ID` is a
clearly-marked placeholder, never a real id; no Box developer app was
created for this work (who owns the OAuth apps is Smit's open call,
research §7 Q2).

## Alternative designs (the credential-ownership call)

1. **Bring-your-own credentials (built).** The user pastes their own Box
   app's client ID + secret in Settings → Connected Storage; they go
   straight to the OS keychain (one entry, `box:credentials`) and are sent
   only to Box's token endpoint. This is the fallback when the broker is
   unreachable, and the refresh path for tokens it issued.
   Friction: the user must create a Custom App → User Authentication
   (OAuth 2.0) in the Box Developer Console and enable `root_readwrite`.
   (Matches research §7 Q3.)
2. **Tiny first-party broker (built, live).** A small server holds the
   client secret and exchanges codes for tokens; the desktop app never sees
   the secret. `BOX_BROKER_URL` in `src-tauri/src/cloud_box.rs` points at
   `https://box-broker.smitpatel.net` (Pi + tunnel); the client takes the
   client id from `GET /config` per session (in memory only) and exchanges
   codes via `POST /exchange`, refreshes via `POST /refresh`, revokes via
   `POST /revoke` (refresh token when there is one, else the access
   token). Broker is the default path; BYO stays as the fallback when the
   broker is unreachable, and refreshes always go back through the source
   that issued the tokens (`TokenSet.issued_via_broker`). A broker-issued
   disconnect revokes at Box first; if the broker can't be reached or
   refuses, the local tokens are still deleted, but the user is told the
   Box-side token may still be valid until it expires (revoke it at
   box.com) — never "revoked and removed". Settings has an "Always use my
   own Box app" toggle: with it on, connects skip the broker entirely, for
   a tenant that hasn't enabled the shared Titer app (sign-in with it
   fails at Box before Titer can fall back).
3. **Shared secret shipped in the binary (rejected).** Anyone can extract
   it from the app; it would let a third party mint tokens for any user
   who authorized the app. Not done, not a fallback.

Whichever wins, the file layer doesn't change: the provider takes a
`TokenSet` and the auth module takes credentials; only the credential
source moves.

## Other Box facts baked into the code

- Access tokens live 60 min; refresh tokens 60 days and are **single-use**
  — the new refresh token is stored (keychain + memory) on every refresh.
- Authorization codes expire after **30 seconds** — the loopback exchange
  runs immediately after capture.
- Direct uploads cap at **50 MB** (client-side guard; `.hlx` / `.prism`
  are kilobytes). Upload sessions are a later slice.
- Download is a redirect to `dl.boxcloud.com`; reqwest follows it and
  drops the `Authorization` header on the cross-host hop, as it should.
- Conditional upload: the conflict token is the file's `version_number` (+
  `sha1`); the provider translates it to the current `etag` with a metadata
  read at save time and uploads with `If-Match`, so the upload itself stays
  conditional (no lost update between check and write). `412` → conflict.
- Enterprise tenants may require a Box Admin to enable an unpublished OAuth
  app (UCSF check: settled by submitting the app, or one email from Mansi
  to UCSF IT). Code must not depend on the answer.
- Scopes: `root_readwrite` (read-only `root_readonly` exists as a
  constant for a future read-only mode).

## What was built

**Rust (`src-tauri/src/`)**

- `cloud.rs` — shared layer: `CloudProvider` trait (`list`, `download`,
  `upload_new`, `upload_version`, `create_folder`, `move_item`,
  `get_metadata`, `list_revisions`, `revoke`); `CloudError` (serialized
  to the page as `{ kind, … }` — never a token or a provider body);
  OS-keychain token storage (`keyring`, one entry per provider account)
  + BYO credentials storage; hand-rolled loopback OAuth (std
  `TcpListener`, one request, `state` validation, 5-min timeout) + PKCE
  S256; parameterized system-browser open with an allowlisted host list
  (never the webview); local cache copies in the app-data dir
  (`cloud-cache/<provider>/<file_id>.<ext>`, atomic write); the
  in-memory **mock provider** behind the same trait (conditional-upload
  conflicts, offline simulation, second-writer edits) with `#[tokio::test]`
  tests in the same file.
- `cloud_box.rs` — Box provider: Custom App → User Authentication,
  endpoints, token exchange/refresh/revoke, file operations, `If-Match`
  conditional uploads, 50 MB guard, `connect_box()` loopback flow.
- `main.rs` — `cloud_*` Tauri commands (status, save credentials,
  connect, disconnect, list, download, read-cache, upload, upload-new,
  create-folder, move, metadata, revisions, mock offline/reset),
  `open_url`, the `cloud-accounts.json` registry (identity only, never
  tokens), and the process-wide mock provider state.
- `Cargo.toml` — `reqwest` (rustls, no OpenSSL), `keyring` 3, `sha2`,
  `sha1`, `rand` 0.8, `async-trait`; `tokio` (rt + macros) as a
  dev-dependency for the mock tests only.

**Frontend (`src/`)**

- `lib/cloud.ts` — `FileHandle` (`{ kind: "local", path } | { kind:
  "remote", provider, accountId, fileId, path, version, sha1,
  modifiedAt }`), `readFile` / `writeFile` on the abstraction (local
  behaviour unchanged, atomic write included), error predicates
  (`isConflictError`, `isOfflineError`, …), `copyName`, base64 helpers.
- `native.ts` — `openUrl` + the `cloud*` invoke wrappers. No CSP change:
  all provider HTTP is in Rust; `default-src 'self'` stands.
- `store/recents.ts` — entries are `{ kind: "local", path } | { kind:
  "remote", provider, accountId, fileId, path }`, with migration from
  legacy plain-path lists. The macOS Dock menu still gets local paths
  only; the windowless menu lists local recents only (a remote file needs
  a project window to load into).
- `store/use-document.ts` — remote open/save through the abstraction:
  `.hlx` and `.prism` round-trip to the cloud (a remote `.prism` imports
  then saves back as `.prism`, like a local file after Save as Prism);
  Save As on a remote file saves a local copy; conflicts open the
  three-choice dialog; offline saves/open show the offline notice and
  never discard the document.
- `components/conflict-dialog.tsx` — Save as a copy / Reload the remote
  version / Overwrite anyway. `components/remote-picker.tsx` — in-app
  folder browsing (the native OS dialog can't browse cloud locations).
  `components/cloud-settings.tsx` — Settings → Connected Storage: Box
  connect/disconnect, BYO credentials, the not-configured explanation.
- `menus.ts` / `app-menu.ts` / `engine.ts` — File ▸ Open from Cloud…,
  Connected Storage…, remote entries in Open Recent.
- `tests/cloud.ts` — pure checks for the file layer, the recents
  migration, and the error sorting (wired into `npm test`).

## Offline behaviour (v1: live-only, no sync engine)

- Open downloads to a local cache copy and opens that; save uploads the
  cache. Offline, an open file keeps editing from the cache; a save shows
  "offline — will upload when reconnected" (Try Again / Save a Local
  Copy / Keep Editing). Disconnect mid-edit keeps the document + cache;
  the next save fails with a clear error and the local-copy escape hatch.
- No background sync engine, no delta feed, no auto-merge — a separate,
  larger project, as the research doc says.

## Pending (needs v1 clear / a built app)

- **Rust build verification:** `cargo check` / `cargo test` (mock tests)
  and a Mac DMG build. Nothing here has been compiled — read + `cargo
  fmt --check` only, per lane rules.
- **Manual provider checks:** connect with a **throwaway** Box account
  (never Mansi's UCSF account), open/edit/save a `.hlx`, force a conflict
  from a second client, go offline mid-edit, disconnect/reconnect. The
  mock provider covers the same paths without network until then.
- **Smit's calls:** who owns the Box OAuth app (shared vs BYO) and
  whether to build the broker; the UCSF admin-enablement check (submit
  the app, or one email from Mansi).
- **Follow-ups (not this slice):** Dropbox provider (proves the shared
  layer end-to-end with PKCE), OneDrive, Drive; remote "Save As" into
  another cloud folder; upload sessions (>50 MB); per-provider quota
  display; offline upload queue ("upload when reconnected"); session
  restore of remote files (today the shell only restores local paths).
