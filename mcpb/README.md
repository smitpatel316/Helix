# Titer .mcpb bundle (Claude Desktop one-click install)

A `.mcpb` (MCP Bundle) is a zip of a local MCP server + `manifest.json` that
Claude Desktop installs in one click (double-click, drag into the Claude
window, or Settings → Extensions → Advanced settings → Install Extension…).
This bundle ships the `titer-stdio-bridge` binary, which forwards Claude's
stdio JSON-RPC to Titer's in-app MCP server on `127.0.0.1`.

## What ships in the bundle

```
titer.mcpb
├── manifest.json                  # MCPB spec 0.3 (this dir, committed)
├── icon.png                       # copied at pack time from src-tauri/icons/icon.png (512×512)
└── server/
    ├── titer-stdio-bridge         # macOS universal binary (lipo arm64+x64)
    └── titer-stdio-bridge.exe     # Windows x64
```

The `server/` binaries and `icon.png` are build artefacts (gitignored) —
only `manifest.json` is source. `tools_generated: true` is set because the
tool list is discovered from the running server at runtime; no static tool
list is declared (tool names are owned by `docs/mcp-server-contract.md`).

## Deliberate: no `user_config`, no token in the bundle

The manifest declares **no** user configuration. In particular it does NOT
ask the user for the bearer token: the bridge reads it from Titer's local
discovery file (`<app-data>/mcp/discovery.json`, mode 0600) at startup, so the token
never enters Claude Desktop's config and never goes stale on rotation. See
`docs/stdio-bridge.md` §2 for the decision and security reasoning.

## Build + pack

```sh
./scripts/build-stdio-bridge.sh --mcpb   # builds macOS arm64+x64 + Windows, stages binaries
./scripts/pack-mcpb.sh [output.mcpb]     # default ./titer.mcpb
```

Packing prefers the official CLI (`npm install -g @anthropic-ai/mcpb`):
`mcpb validate` then `mcpb pack`. Without it, the script falls back to a
plain zip after a Python manifest check, and says so — an unvalidated
bundle is not a proof.

Signing (`mcpb sign`) is NOT done in this lane: no code-signing certificate
exists for Titer yet. Unsigned bundles install fine (Claude Desktop shows
them as unsigned); signing is a distribution decision for the release step.

## Install (user-facing)

1. In Titer: Settings → AI connections → turn on "Allow AI apps to connect".
2. Double-click `titer.mcpb` (or drag it into Claude Desktop).
3. Review the install dialog and click Install.
4. Restart Claude Desktop if it was already running — it reads MCP servers
   at startup. Titer's tools then appear in chat.

If Claude reports the server failed to start, the cause is almost always
step 1: the bridge exits with a clear stderr message naming it. Run
`titer-stdio-bridge --check` from a terminal for the same diagnosis.

## Format verification

Verified 2026-11-13 against authoritative sources (roadmap open
verification item 3 — now closed for this lane):

- Anthropic docs: https://claude.com/docs/connectors/building/mcpb
  (updated 2026-11-12)
- MCPB manifest spec v0.3 (2025-12-02):
  https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
- MCPB CLI reference: https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md
  (`mcpb pack <directory> [output]`, `mcpb validate`, binary-bundle layout)

Still unverified (needs the built binary + the app server — pending v1
clear / Phase 1 integration): a live install of a packed `.mcpb` in Claude
Desktop, and `mcpb validate` / `mcpb pack` run against this manifest.
