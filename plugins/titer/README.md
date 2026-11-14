# Titer plugin for Google Antigravity

Connect Antigravity to **Titer** — the free, open-source (GPL-3.0),
Prism-compatible statistics and graphing app — running on your own machine.
Antigravity can then read what's open in Titer: projects, tables, analysis
results, and graphs. Your data never leaves your computer: the connection
is loopback-only (`127.0.0.1`), and the server is **read-only** — the agent
can read, never change, run, build, or export anything in Titer.

## Before you install

1. Install Titer for macOS from the
   [releases](https://github.com/smitpatel316/Titer/releases) page and open
   a project. (The plugin's remote transport works wherever Titer runs;
   macOS is the shipped platform today.)
2. In Titer, open **Settings → AI connections** and turn on **“Allow AI
   apps to connect”**. The Settings page shows the server status
   (“On — listening on http://127.0.0.1:18741/mcp”, or the next free port
   in 18741–18750) and your local token.
3. Copy two values from that page — you will paste them when the plugin
   asks:
   - **Endpoint**: the URL shown in the status line.
   - **Token**: click **Show**, then **Copy**, next to “Local token”.

The token stays valid until you regenerate it in Settings. If you
regenerate it, re-enter the new token in the plugin's setup (Customizations
→ Installed → Titer → setup). Never share the token or commit it anywhere.

## Install

**From the CLI** (needs the `agy` CLI installed):

```sh
agy plugin install ./titer          # from a local copy of this folder
agy plugin list                     # verify it is installed and enabled
```

**From the App:** open **Customizations → Marketplace**, or place this
folder in `~/.gemini/config/plugins/` (all workspaces) or
`<workspace>/.agents/plugins/` (one workspace only), then enable it under
**Customizations → Installed**.

Installing leaves the plugin **disabled until configured**: the first time
you enable it, Antigravity opens a setup dialog asking for the **Titer MCP
endpoint** and **Titer local token** from the step above. Fill in both and
the bundled MCP server connects.

## What you get

One bundled MCP server (`titer_local` once installed — the plugin name
`titer` namespaces the server key `local`), with five read-only tools:

| Tool | What it does |
|---|---|
| `titer_list_projects` | Lists open projects with tables, analyses, graphs, figures — and the ids the other tools take. Always call this first. |
| `titer_list_tables` | Lists a project's tables (type, rows, data columns). |
| `titer_read_table_summary` | A table's columns, roles, ranges, and missing values; cell values only with `include_values: true`. |
| `titer_read_results` | An analysis outcome as Titer computed it — or `not_computed` if it hasn't been run in this session. |
| `titer_read_graph` | A graph's setup, source table, linked analyses, and figures. |

The `/titer` skill teaches the agent how to use these tools (start with
`list_projects`, never invent a result for `not_computed`, data is data).
Only `titer_list_projects` is eager-loaded; the rest load lazily on demand.
Tools run in **Ask** mode by default — Antigravity asks before running one
— until you allow them (`mcp(titer_local/*)` in your policy).

## Prefer the stdio transport?

The plugin uses the remote (`serverUrl`) transport: it is the shape
Google's plugin docs prefer for cross-platform plugins, and it works the
same on macOS, Linux, and Windows. If you would rather not paste the token
into Antigravity's config, use the stdio transport instead: Titer ships a
small bridge binary (`titer-stdio-bridge`) next to the app binary, and it
reads the endpoint + token straight from Titer's own connection file, so
rotation needs no config edit. That path is config-file only — see
[docs/antigravity.md](https://github.com/smitpatel316/Titer/blob/main/docs/antigravity.md)
for the `mcp_config.json` snippets (global and workspace, both transports).

## Troubleshooting

- **Server not found / connection refused:** the Titer server is off. In
  Titer, open Settings → AI connections and turn on “Allow AI apps to
  connect”, then restart the server entry (Customizations → Installed →
  MCP Servers → ⋮ → Restart).
- **Unauthorized (401):** the token changed. Re-copy it from Titer →
  Settings → AI connections and re-enter it in the plugin setup.
- **Wrong port:** the server takes the first free port in 18741–18750.
  If anything else is on 18741, the endpoint in Settings shows the real
  port — copy that exact URL.
- **“not_computed”:** the analysis hasn't been run in this Titer session.
  Open it in Titer and run it; the agent must not invent a result.

## Details

- **Version:** 0.1.0 (Phase 1: read-only tools only).
- **License:** GPL-3.0 (same as Titer).
- **Source:** https://github.com/smitpatel316/Titer — the plugin lives in
  `plugins/titer/`; the server contract is `docs/mcp-server-contract.md`.
- **Marketplace submission:** not yet submitted — the plugin is validated
  locally (`agy plugin validate --strict`) and installable from this
  folder or a GitHub URL. Marketplace listing goes through Google's
  partner intake form when Titer is ready.
