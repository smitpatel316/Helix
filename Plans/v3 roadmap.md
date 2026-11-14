# v3 roadmap — DRAFT for Smit's review

**Status: DRAFT, planning only. No code until v2 ships.**
**Date:** Nov 13, 2026. **Author:** Atlas (research + draft).

## The idea in one paragraph

v1.0 gets Titer to Prism parity. v2 finishes the parity backlog (1.0.9 rebase, then the backlog in order). **v3 is where Titer stops catching up and starts leading.** It has four pillars that hang together as one system:

1. **Agentic** — Titer connects to whatever AI harness the researcher already uses (Antigravity, Claude Desktop, Claude Code, ChatGPT Codex, or any desktop AI app), so they drive analysis by talking to their AI, and the AI drives Titer.
2. **Workflows** — the things researchers do over and over become saved, reusable pipelines that replay on matching data in one click. (Adapting when the new data isn't identical is a future nice-to-have, not core — see §4a.)
3. **Plugin / Extension Marketplace** — Titer becomes the framework and the base. First-party analyses ship with the app; third parties build their own analysis types and offer them on a marketplace. The app grows through its ecosystem, not just through what we build.
4. **Enterprise** — the monetization path: a unified paid solution for universities, research labs, and corporations with large budgets (on-prem deployment, heavy compute, teamwork, admin/IT) — while the app stays free for individual researchers, forever.

The user is a researcher, not a coder. Every pillar is judged by one test: **can Mansi do it without writing code and without reading a manual?** (Mansi: UCSF research tech, daily work is graphing + stats + multi-panel figures, currently paying $50/month for Prism.)

---

## 1. Connection standard — MCP first

### What MCP is

The Model Context Protocol (MCP) is an open standard for connecting AI apps to external data, tools, and workflows. It is JSON-RPC 2.0. A **server** (Titer) exposes three kinds of primitives: **tools** (things the AI can call, e.g. "run a t-test"), **resources** (data the AI can read, e.g. a table), and **prompts** (reusable instruction templates). A **client** (Claude, Codex, Antigravity) discovers them and calls them. As of December 2025 MCP is a Linux Foundation project under the Agentic AI Foundation, stewarded by Anthropic, AWS, Block, Bloomberg, Cloudflare, Google, Microsoft, and OpenAI — it is the standard, not a vendor API.

### Transports — only two, and the choice is made for us

| Transport | How it works | Use |
|---|---|---|
| **stdio** | The client launches the server as a subprocess; newline-delimited JSON-RPC over stdin/stdout | Local servers — **this is Titer** |
| **Streamable HTTP** | One HTTP endpoint; a POST per message, replies as JSON or a per-request SSE stream | Remote/networked servers |

The older HTTP+SSE transport (separate POST + SSE endpoints) is **deprecated since the 2025-03-26 spec**; Streamable HTTP replaced it. Auth: Streamable HTTP uses an OAuth 2.1 flow. **stdio needs no auth** — the server runs as the user's own process, with the user's own permissions, and can only be reached by the client that launched it. That is the right default for a local-only desktop app holding unpublished research data.

**Spec-version note (verify at build time):** the spec is versioned by date. The widely-deployed revisions are 2025-06-18 / 2025-11-25. A 2026-07-28 revision exists and makes the protocol stateless (removes the `initialize` handshake and protocol-level sessions, adds a `server/discover` method). Clients lag the spec — build against the stable revisions the four named apps actually speak, and track 2026-07-28; do not build on it until the clients do.

### Which of the named apps speak MCP, and how a user connects

| App | MCP? | How a local server connects | What the user does |
|---|---|---|---|
| **Claude Desktop** | Yes | `claude_desktop_config.json` (`mcpServers` — a command + args, stdio), or a **`.mcpb` desktop extension** (one-click install, Settings → Extensions) | Edit one JSON file + restart, or double-click a `.mcpb` file. Local servers work only in Desktop, not on the web or mobile. Remote servers go through Connectors (URL + OAuth). |
| **Claude Code** | Yes | `claude mcp add --transport stdio <name> -- <command>`; scopes are `local` (this project), `project` (`.mcp.json` in the repo, shared, with a one-time approval prompt), `user` (all projects). `claude mcp add-json` for a pasted definition; `/mcp` to check the connection. | One terminal command. |
| **ChatGPT Codex** (Codex CLI, IDE extension, ChatGPT desktop app) | Yes | All three share one config: `~/.codex/config.toml` (`[mcp_servers.<name>]`), or `codex mcp add <name> -- <command>`. stdio + Streamable HTTP. Codex also reads the MCP `instructions` field as server-wide guidance. | One command or one settings screen; the server then shows up in all three surfaces. ChatGPT on the **web** needs remote plugins (developer mode) — local stdio does not reach it. |
| **Google Antigravity** (App, CLI, IDE) | Yes | `mcp_config.json` (global: `~/.gemini/config/mcp_config.json` for the CLI); in the App, the **MCP Servers** section of the Customizations page. Remote servers get OAuth PKCE / client-metadata handling automatically. Antigravity also has a **plugins marketplace** (launched Oct 29, 2026) where a plugin can bundle MCP servers + skills + rules + agents + hooks for one-click install — **but that marketplace detail is unverified** (see open verification items). | Config file, or one-click plugin install. |

**Bottom line: all four named apps speak MCP, and all four can launch a local stdio server.** That is why MCP is the standard — one server, four clients, no per-app integration work.

### How a desktop Tauri app ships an MCP server

Titer is a Tauri 2 app (Rust core + React frontend). There are three proven shapes, all seen in shipping Tauri apps:

1. **In-process HTTP server (recommended for Titer).** The Rust core runs an MCP server on `127.0.0.1` (Streamable HTTP) using `rmcp`, the Rust MCP SDK. The server is **off by default** and starts only when the user opts in. It exposes the app's own commands as MCP tools, dispatched on the app's main thread — so a tool call runs the same code path as clicking the button in the UI. A ready-made crate exists for exactly this (`tauri-plugin-mcp-commands`: binds `127.0.0.1` only, requires a bearer token, rejects browsers, supports the 2026-07-28 spec and back to 2024-11-05) — evaluate it at build time; it is a young third-party crate, not an official Tauri plugin, so it is an option, not a commitment.
2. **Bundled sidecar binary (the stdio bridge).** Claude Desktop speaks **only stdio** to local servers, so it cannot talk to the HTTP server directly. The fix is a tiny bridge binary shipped with the app (Tauri `externalBin`, installed next to the app binary) that the client launches over stdio and that forwards to the app's HTTP endpoint. The same crate ships a `mcp-stdio-bridge` plus a `.mcpb` bundle template for it. This is the same shape other Tauri apps use (e.g. NotePlan ships a `bun --compile` sidecar binary next to the app).
3. **Separate MCP server process.** A standalone binary the user runs independently. More moving parts, worse UX, no advantage over (1)+(2) for a local app. Not recommended.

**What Titer ships, concretely:** the MCP server inside the app (off by default) + the stdio bridge sidecar + a `.mcpb` bundle so Claude Desktop installs it in one click. No separate download, no account, no cloud.

### The one-click connect flow (the non-coder test)

1. The researcher opens Titer → Settings → **AI connections** → turns on "Allow AI apps to connect" (server starts on `127.0.0.1`, token generated locally).
2. The panel shows one button per app: **Claude Desktop** (downloads/opens the `.mcpb` — double-click installs), **Claude Code** (copies the `claude mcp add …` command, or runs it), **Codex** (copies the `codex mcp add …` command), **Antigravity** (writes the `mcp_config.json` entry, or a plugin listing).
3. The researcher restarts the AI app (Claude Desktop reads its config only at startup). The tools appear in the chat. No JSON editing by hand, no terminal unless they want it.

---

## 2. Capability surface — what the agent can do

Grouped by what a researcher actually asks for, not by internal module. Every tool maps to something Titer already does (v1.0) or that v2 adds — nothing here is an invented feature. "New work" means Titer needs new code to expose it, not that the analysis doesn't exist.

### "Look at my data"

| Capability | Kind | What it does | Status |
|---|---|---|---|
| List projects / tables | Read-only | What is open, what tables exist, what type each is (Column, XY, Grouped, Multiple variables, Contingency, Survival, Nested) | Expose what exists |
| Read a table (summary) | Read-only | Columns, roles, row counts, value ranges, units where recorded — not a full data dump unless asked | Expose what exists |
| Read results | Read-only | Results of a named analysis: statistics, p-values, CIs, notes | Expose what exists |
| Read a graph / figure | Read-only | What a graph shows, its data source, its export state | Expose what exists |

### "Run the analysis"

| Capability | Kind | What it does | Status |
|---|---|---|---|
| Run an analysis | Runs compute | Runs any of the 56 Prism 10 analyses (t-tests, ANOVA incl. three-way / repeated-measures / mixed-effects, nonlinear regression + dose-response, survival + Cox, ROC, Bland–Altman, PCA, K-means, Monte Carlo, …) on a named table with named parameters; returns the result the same way the UI does | Expose what exists (the runners already exist; the tool is a thin wrapper) |
| Compare / choose a model | Runs compute | Model comparison, global (shared-parameter) fits, interpolation from a standard curve | Expose what exists |
| Import a file | Writes a file (into the project) | Import `.prism`, `.pzfx`, `.hlx` into the open project | Expose what exists (converter + importers exist) |
| Convert a file | Writes a file | `.prism` → `.hlx` and back, via the converter | Expose what exists |

### "Make the figure"

| Capability | Kind | What it does | Status |
|---|---|---|---|
| Build a graph | Runs compute + writes | Builds a graph node from an analysis (dose-response curve, forest plot, survival curve, ROC, Bland–Altman, heatmap, box/violin, volcano, scatter, …) | Expose what exists |
| Build a multi-panel figure | Runs compute + writes | Assembles existing graphs into a labelled A/B/C panel figure | Expose what exists |
| Export | Writes a file | PNG/JPG at a chosen DPI (up to 600), SVG, `.prism` out | Expose what exists |

### "Which test should I run?"

| Capability | Kind | What it does | Status |
|---|---|---|---|
| Recommend an analysis | Read-only + reasoning | Inspects the table (type, column roles, distribution, pairing) and returns a ranked list of suitable analyses with reasons, grounded in the Prism analysis checklists | **New work** — a "choose analysis" tool. The knowledge exists (the Prism 10 analysis catalogue in the vault); the tool that turns a table's shape into a recommendation does not. Phase 3. |
| Explain a result | Read-only | Plain-language reading of a result ("your EC50 is X, which means…", "this p-value does not mean…") | New work, small — the result text exists; the explanation layer is new. Phase 3. |

### What the agent can NEVER do through this connection

Delete a project or a table. Overwrite a file without the user saying yes. Send any data anywhere — there is no network path in the server at all (see §3).

---

## 3. Safety model — local-only by default

The researcher stays in control. The model has four tiers, and the default is the cautious one.

| Tier | What it covers | Asks the user? |
|---|---|---|
| **1 — Read** | List, read tables/results/graphs, recommend an analysis | No. Reading changes nothing. |
| **2 — Compute in the open project** | Run an analysis, build a graph/figure | No — but **every action is logged** in an Activity log the researcher can review, and every created node is visible in the sidebar exactly as if they had clicked it themselves. |
| **3 — Write a file** | Export a figure, save a converted file, save the project | Asks **once per session** ("let the agent save files this session?"), or per action if the researcher prefers. The researcher picks the default in Settings. |
| **4 — Destructive** | Delete anything, replace data, overwrite an existing file | **Always asks, every time.** No "always allow" option for this tier. |

**Plus, hard rules that no tier overrides:**

- **Local-only.** The MCP server binds `127.0.0.1` only, requires a local token, and has **no outbound network access**. Unpublished UCSF data never leaves the machine through this connection. (The AI app itself may be cloud-based — that is the researcher's own choice of harness, and the data they paste or expose there is theirs to decide. Titer never sends anything on its own.)
- **Every agent action is logged.** The Activity log records what the agent did, on which table, with which parameters, and what came back. The researcher can review it, and can undo what can be undone (created nodes delete cleanly; a run analysis leaves a node that can be deleted like any other).
- **Data is data, not instructions.** Cell values, file names, and imported text are treated as data. They cannot steer the agent or the app — a value in a spreadsheet can never become a command. (This matters because imported files come from collaborators.)
- **The agent cannot change the safety settings.** Turning the server on/off, changing a tier default, or granting a permission is a human action in Titer's own Settings, never something an agent tool can do.

---

## 4. Beyond parity — where Titer goes past Prism

v1.0 + v2 get Titer to Prism parity. Parity is the floor, not the ceiling. These three pillars are original features — they are the reason to pick Titer even after Prism catches up. Together with the agentic layer, they are what the four pillars have in common: **the app becomes a system the researcher drives, instead of a tool they operate.**

### 4a. Workflows — automate what people do often

**What a workflow is.** A saved, reusable multi-step pipeline: import → clean → analyze → graph → export, replayed on new data in one click. It is **not** a macro of clicks. Each step is one of the app's own operations (the same runners and graph builders the UI uses), parameterized and saved as a recipe. Crucially, a step binds to data **by structure and role, not by cell address**: "the dose column" and "the response column", not "column B".

**Core scope, stated plainly.** Core Workflows = record once, replay on **matching** data (one click / on import / on schedule), branching, sharing. Adaptive replay — noticing the next experiment differs and working around it — is **explicitly out of core scope**: a future nice-to-have, the extreme advanced end, not something core Workflows or the Marketplace is blocked on (see the subsection at the end of §4a).

**How it differs from Prism's replay tools (the v2 parity items).** Prism already has Wand (apply one table's analyses to a new table), Templates (save a project without data, refill it), Duplicate a family (copy a table with its analyses/graphs, replace the data), Clone a graph, and Magic (one-click consistent formatting). Those all replay **one table's setup, on the same layout, in the same file**. A workflow chains **many steps across tables**, can **branch on results**, and is **shared and reused across projects**. Prism has nothing like it — no multi-step pipeline, no branching, no triggers. (Remapping when the new data differs is the future adaptive-replay idea at the end of §4a, not a core v3 claim.)

**Trigger points.**
- **One click** — "Run" on a saved workflow, picking the new file.
- **On import** — a workflow attached to a data shape runs automatically when a matching file is imported.
- **On schedule** — a weekly QC figure regenerated from the week's data. Honest scope note: Titer is a desktop app, so true unattended scheduling needs the app running; v3 ships "on import" + "on open" triggers, and scheduled runs are a later item, not a v3 promise.

**How it relates to the agentic layer.** The agent can **run** a workflow ("run my ELISA workflow on this file") and can **build** one from a spoken request ("every time I get ELISA data, do the standard curve, the stats, and the figure the way I like it") — the agent drafts the workflow from the conversation, the researcher confirms it, and it saves like any other workflow. Workflow steps are also MCP tools (`run_workflow`, `draft_workflow`), so the agent and the workflow system are the same surface, not two features.

**Example workflows (from real lab routines).** These are **illustrative**, not verified against a real routine — they are drawn from the Prism "repeating an analysis" use case and from Mansi's known work (dose-response, stats, multi-panel figures). Pinning three real routines is a v3 research item (interview 2–3 researchers, including Mansi).
- *ELISA day:* import the plate reader file → standard curve (4PL) → interpolate unknowns → t-test/ANOVA on groups → dose-response graph + bar graph → multi-panel figure → export 600 DPI PNG. Today that is ~20 minutes of clicks; as a workflow it is one click.
- *Repeated assay batches:* each new batch file gets the same analysis set applied and the same figure rebuilt, so batch 12 looks exactly like batch 1.
- *Weekly QC plots:* the same QC figure regenerated from the week's data, flagged if a value drifts outside its usual range.

**How other tools do this (and where Titer would be first).**

| Tool | What it offers | Gap Titer fills |
|---|---|---|
| **Prism** | Templates, duplicate family, clone graph, Wand, Magic — single-family replay, same layout, no branching, no triggers | Multi-step, branching, cross-project pipelines |
| **JASP / jamovi** | Point-and-click stats; an analysis updates when its data changes, inside one file | No reusable pipeline at all |
| **R `targets` / `drake`** | Code pipelines (Make-like): declare steps, rebuild what changed, skip what's fresh. Powerful and genuinely reproducible | **Code-only.** A non-coder cannot build or edit one. Titer's version is the same idea, built by clicking and talking |
| **KNIME / Orange** | Visual drag-and-drop node pipelines, no-code, repeatable — the closest in spirit | A general data platform, not a stats/graphing app: its nodes are generic data ops, not Prism analyses with publication figures. And its pipelines are built by wiring nodes, not by recording your own work |
| **Bioinformatics (Nextflow, Snakemake)** | Code pipelines for compute clusters | Code-only, and built for pipelines that run on servers, not for a researcher at a bench |

**Claim, stated plainly:** as far as this research found, **no stats/graphing tool offers reusable, branching pipelines for non-coders**. KNIME is the nearest neighbour in a different category. Titer would be first in its own space.

#### Future nice-to-have ONLY (explicitly NOT core scope): adaptive replay + learning from corrections

This is the extreme, advanced end — a hypothetical for the future, not a v3 core requirement. **Core Workflows and the Marketplace are not blocked on it.** The idea, kept here so it isn't lost: a workflow is built from one experiment, but the next similar experiment is never perfectly identical — different column names, different replicate counts, a missing control, different units, an extra group. A rigid replay breaks on those differences. An adaptive workflow would be smart enough to work around them. A rigid replay is a demo; an adaptive one is a tool — but the adaptive one is a later problem, not this release's.

- **Matching by meaning, not by exact layout.** When a workflow replays on new data, each step binds to the new data by what the columns and values **mean** — not by position or exact name. The matching uses several signals together: **header synonyms** ("Conc", "Concentration", "[Drug] nM" all mean the dose column), **units** (parsed from headers like `[nM]` or `ng/mL`, with conversion where the units are convertible), **data shape** (the X column is monotonic; the Y columns are replicates of the same condition), and **roles** (which column is the dose, which is the response, which group is the control). Each candidate binding gets a score; the best binding above a threshold wins.
- **What happens on a mismatch: pause-and-ask vs best-effort-with-a-flag.** The rule is: the workflow **asks the user only where it genuinely cannot decide** — an ambiguous match (two columns score equally), or a missing piece it cannot invent (no control group present). Everywhere else it proceeds **best-effort with a visible flag**: the uncertain step carries a "check this" badge on the finished result, so the researcher reviews it after the run instead of being interrupted during it. Nothing fails silently, and nothing blocks on a question the researcher could answer in two seconds afterwards.
- **Learning from corrections.** When the user fixes a step — re-maps a column, picks the right control, corrects a unit — the workflow **remembers that mapping for the next run**. Learned corrections are stored **per workflow**, alongside it: a small table of "when I see a header like X, it means Y". They are **editable** (a "Learned mappings" panel lists them) and **resettable** (clear them and the workflow goes back to fresh matching). And they **never silently override an explicit user choice**: if the researcher says something different in the current run, the explicit choice wins and the learned mapping is not applied to that step.
- **Why this stays future, not core.** In a real lab, no two experiments are identical, so this is the idea that would make workflows survive contact with real data. But it is the hardest part of the pillar — fuzzy matching, confidence thresholds, learned-mapping storage — and core Workflows (record once, replay on matching data, branching, sharing) are useful without it. Build core first; revisit this when core is in researchers' hands.

### 4b. Plugin / Extension Marketplace — the app grows through its ecosystem

**The idea.** Titer becomes the framework and the base. First-party analyses ship with the app. Third parties build their own analysis types and plug them in, offered on a marketplace where people download more and more of them. The app grows through its ecosystem, not just through what we build.

**The plugin API / SDK — what a plugin author implements, what Titer provides.**

| | Plugin author implements | Titer provides |
|---|---|---|
| **Definition** | A manifest (id, name, version, API version, author, license, permissions) + an analysis spec: which table types it applies to, its parameters (type, range, default — reusing the app's existing parameter kinds), and its wizard questions | The registry the analysis plugs into (the same `AnalysisType` registry first-party analyses use), the wizard UI, the results view |
| **Computation** | The computation itself: R code run through the same webR engine (with the vendored R packages), or pure-TypeScript compute for analyses that don't need R | The stats engine (webR + R 4.6.0 + the 45-package vendored repo), the runner plumbing, progress/cancel, error surfacing |
| **Results** | How its results are shaped: statistics rows, notes, and which graph (an existing graph module, or a declared custom renderer) | Graphing, the results view, the project file (`.hlx` round-trip of the plugin's parameters), export |

A plugin is a folder/zip: manifest + code + README + screenshots. No Rust, no native code, no sidecars from third parties in v3 — JS/TS + R only, so the containment story in §4b below actually holds.

**The marketplace itself.** In-app browse and search, one-click install, update, and uninstall. A listing is a manifest + README + screenshots + version history + safety scorecard (below). Install means download → verify (hash/signature) → enable. Updates show a changelog and install after a short delay (borrowed from VS Code: don't auto-install a new version the hour it ships — a bad release should not reach everyone at once). Uninstall removes the plugin cleanly; a workflow that used it degrades gracefully ("this step needs plugin X — install it?") instead of breaking.

**Trust and safety — third-party code runs on the user's research data.** The honest line first: **there is no true JS sandbox in a desktop webview.** The model is a **capability boundary, not a sandbox** — and the roadmap says so plainly instead of pretending otherwise.

- **How the boundary works (concrete, for a Tauri app).** Plugin JS runs in a **separate webview/iframe** behind Tauri's **Isolation pattern** (a sandboxed iframe that inspects IPC messages before they reach Rust), with a **strict capability allowlist**: the plugin may call only the `titer.*` IPC commands its manifest declares, and anything undeclared **fails closed** — it isn't callable at all. Manifest permissions are shown to the user in plain language at install time ("this plugin can: read the open table, write new analyses, save files" — never a raw permission string). Unknown permission names are rejected at install time, so a capability cannot be smuggled in.
- **Computation is naturally contained.** R code runs inside the webR WASM sandbox — R cannot touch the filesystem or the network except through the host bridge, so a plugin's computation can only do what Titer lets it do.
- **What a plugin can and cannot touch.** Data: only the tables/columns the user (or the analysis) passes it — no whole-project read by default. Filesystem: no direct access; only through Titer's save/export commands. Network: **denied by default**; a plugin must declare it and the user approves it, and the default answer is no.
- **Review and listing.** Automated gates on every submission: manifest validation, static scan for dangerous patterns, a test run of the plugin's own checks (the CRAN-style "it must pass its own suite" rule), license check. Human review for featured and flagged listings; a **safety scorecard** on every listing page (borrowed from Obsidian). Plugins install **disabled by default** with a review step before first enable (borrowed from Obsidian starter packs). **Publisher verification** for known authors (borrowed from VS Code).
- **The supply-chain lesson.** In October 2026, a tampered build of a popular extension was served on a mirror marketplace for ~11 hours. The mitigations are the boring ones: pin versions, sign releases, verify hashes on install, delay auto-updates, and let users pin a known-good version.

**Versioning and compatibility — how plugins survive app updates without breaking.**

- The manifest declares an `apiVersion` (semver). Titer guarantees the plugin API **within a major version**.
- Deprecation policy: a change is announced one release ahead, and old entry points keep working for one major version.
- A plugin declares which app versions it supports; on an app update, an incompatible plugin **disables with a clear message** ("needs Titer 3.x") instead of crashing the app.
- For first-party API changes, run the affected plugins' checks before release (the small-scale version of CRAN's reverse-dependency testing).

**How the pillars hang together — one system, not separate features.**

The agent drives workflows; workflows can call plugin analyses; plugins extend what the agent and workflows can do. Concretely: a researcher tells their AI "run my ELISA workflow on this file" → the agent calls the workflow tool → the workflow's steps include a plugin analysis (say, a niche assay the first-party app doesn't ship) → the workflow declares that dependency, and if the plugin is missing Titer offers to install it from the marketplace → the figure comes back, flagged steps and all. Each pillar makes the others more useful: without the agent, workflows are built by clicking; without workflows, the agent does one thing at a time; without plugins, both can only do what we shipped. And Enterprise is the team edition of all three — shared workflows, centrally managed plugins, and agent access under admin control.

### What to borrow — and what NOT to borrow

| Source | Borrow | Do NOT borrow |
|---|---|---|
| **VS Code extensions** | Marketplace scale; verified-publisher badge; install-time trust prompt; delayed auto-updates; `extensions.allowed`-style allowlisting | The no-sandbox default: extensions run in the extension host with the **same OS permissions as VS Code itself** (read/write files, network, run processes). Silent auto-updates of a new version. |
| **ImageJ / Fiji** | Update sites: anyone can run a repo (a lab can host its own); the updater manages dependencies; bundling with the base distribution is earned through maintainer review + CI | No review and no sandbox at all — Java plugins run with full JVM access. The "rely on a maintainer to upload for you" bottleneck. |
| **Obsidian plugins** | Restricted Mode default (no third-party code until the user opts in); safety scorecard on every listing; install-disabled-by-default; manual review for popular/flagged plugins | No sandbox: a plugin inherits Obsidian's full access (files, network, shell). Review that cannot cover every update. |
| **R packages / CRAN** | Automated check gates (a package must pass its own suite clean); a named maintainer with a working email; version discipline (bump on every release); reverse-dependency testing before breaking changes | The volunteer-reviewer bottleneck — CRAN's own policy calls reviewer time its most precious resource, and submissions are capped at one per 1–2 months. Titer needs automated gates + tiered review, not a human queue. |

---

### 4c. Enterprise — the monetization path

**The hard rule (Smit's words, Nov 13 ~10:12 PT): the app stays FREE for individual researchers, forever.** That does not change. The money comes from a unified enterprise solution for universities, research labs, and corporations with large budgets. Enterprise is a separate offering built on the free core — it never takes anything away from the individual app.

**What makes enterprise different from the individual app.**

1. **On-prem deployment.** It runs on the customer's own premises/servers, not on one person's laptop. The institution hosts Titer (and its compute) inside its own network, under its own IT policies — which is also how unpublished research data stays inside the institution.
2. **Heavy compute and memory.** Jobs too big for a laptop — large datasets, batch analyses across many files, heavy simulations — run on shared infrastructure instead of one machine. The same analyses, the same results, on hardware sized for the job.
3. **Unified teamwork.** Shared projects, roles and permissions, comments and review, audit trails, central data — work that cannot sit on one person's computer. A lab's analyses, figures, and workflows live in one place the whole team can see, with a record of who did what.
4. **Admin and IT needs.** SSO, user management, deployment and updates, support and SLA. IT can provision and deprovision users, push updates centrally, and get a support line with a response-time commitment — the things a university IT department requires before it will bless a tool.

**How it connects to the other pillars.** Enterprise is where the other three pillars scale to teams: the agent layer becomes team-aware (shared workflows the agent can run, with permissions deciding what it may touch); Workflows become shared, versioned team assets instead of one researcher's saved pipeline; the Marketplace becomes centrally managed (IT approves which plugins are available lab-wide). One system: the individual app is the single-user edition of the same product.

**⚠️ GATE — no monetization moves without the immigration-lawyer consult first.** This is Smit's standing gate (L-1B visa; side paid work needs the consult before anything biddable or billable), and it applies to enterprise too: **any enterprise pricing, selling, or contracting step waits for the consult** — not just building the features. Building the technical pieces is planning/engineering; charging anyone for anything is gated.

---

## 5. Phases — one build order across all four pillars

Rough scope is t-shirt size + dependencies, not dates. No phase starts before v2 ships.

| Phase | What lands | Size | Depends on |
|---|---|---|---|
| **1 — The pipe** | MCP server inside the app (off by default) + stdio bridge + read-only tools (list, read tables/results) + Claude Code via one command. Proves the connection end-to-end. | M | v2 shipped |
| **2 — Doing things** | Run analyses, build graphs/figures, export; the four-tier approval model + Activity log; one-click `.mcpb` for Claude Desktop; Codex + Antigravity configs. | L | Phase 1 |
| **3 — Guidance + Workflows core** | "Which test should I run?" + result explanations; **Workflows**: record, replay on matching data, branching, triggers (one-click + on-import). Agent can run and draft workflows. | XL | Phase 2 |
| **4 — Connect everywhere + Plugins core** | One-click connect per app (deep links / `.mcpb` / Antigravity plugin listing); **Marketplace core**: plugin SDK + manifest + in-app install/update/uninstall + automated gates + capability boundary. Plugin analyses usable in Workflows and callable by the agent. | XL | Phase 3 (SDK needs the stable analysis registry + runner plumbing from Phases 1–2) |
| **5 — Polish + scale** | Scheduled workflow runs (needs the app running — see §4a note); safety scorecards + publisher verification; delayed auto-updates; the plugin review queue and featured listings; the v3 research item (pin three real lab routines with researcher interviews). Adaptive replay stays a future item, not a phase deliverable (see §4a). | L | Phase 4 |
| **6 — Enterprise** | On-prem deployment, heavy-compute backend, shared projects + roles/permissions + audit trails, SSO + user management, support/SLA packaging. The enterprise offering built on the free core. | XL | Phases 1–4 (enterprise is the team edition of the agent layer, Workflows, and plugin framework — it needs them stable first, not a separate product). **Release timing (v3 vs later) is Smit's call — see §6 Q12 — and the lawyer gate in §4c applies to any pricing/selling step.** |

**Sequencing note:** Workflows (Phase 3) come before the Marketplace (Phase 4) deliberately — the plugin contract is easier to design once workflows have forced the "a step is a parameterized call" shape, and plugin authors then get workflows for free. Enterprise (Phase 6) comes last deliberately — it is the team edition of the other pillars, so it needs them stable first; and its release timing is Smit's call, not this roadmap's.

---

## 6. Open questions for Smit — decisions only he can make

**⚠️ GATE (applies to Q10–Q12 and to any enterprise step): no monetization moves — pricing, selling, contracting — without the immigration-lawyer consult first. See §4c.**

1. **Which apps first?** Recommendation: Claude Code + Claude Desktop first (both speak local stdio, no server needed, one command / one file). Codex second, Antigravity third (via its plugin listing). Is that the right order, or does Mansi (or his own use) point somewhere else?
2. **How much autonomy does the agent get?** The four tiers in §3 are a proposal. Where should the defaults sit — is "compute without asking" right, or should running an analysis ask the first time? Is "ask once per session" for file writes acceptable, or per action?
3. **MCP server in the main app, or a separate download?** Recommendation: bundled in the app, off by default. A separate download would be one more thing to install and version.
4. **Remote / cloud AI harnesses later?** v3 is local-only (stdio + `127.0.0.1`). Should a hosted Titer MCP server (for ChatGPT web, or a lab server) ever exist, or does local-only stay the rule?
5. **Workflows: how much may the workflow guess before it must ask?** — a question for the FUTURE adaptive-replay idea (§4a), not for core v3. Core workflows replay on matching data and fail clearly on a mismatch; the guess-vs-ask line only matters if adaptive replay is ever built. Is a best-effort binding with a flag acceptable on a result that goes into a paper, or should uncertain steps always pause?
6. **Workflows: recordable vs hand-built?** How much of a workflow should be recordable from doing the work once (record mode) vs built by hand in an editor? Record-first is the proposal; the editor is Phase 3 either way.
7. **Paid third-party plugins — allowed? (Do NOT decide here; needs Smit + a lawyer.)** Titer is free and open source under GPL-3.0, and the standing line is "no charging ever" for Titer itself. The open questions are: (a) must a listed plugin be GPL-compatible, or may it be proprietary? — the answer turns on the boundary: a plugin that **links** Titer's code is generally a work based on the program (GPL applies), while a plugin that talks to Titer **over a process/IPC boundary** is generally treated as a separate program — but that line is genuinely arguable (the FSF's position is that intimate IPC can still make one program), so this needs a real legal read, not a roadmap guess; (b) if paid plugins are allowed, does the marketplace take a cut, and what does that mean for "free, open source, no charging ever"? (c) who reviews listings, and is first-party review a bottleneck — or does the automated-gate + scorecard model carry it?
8. **Who reviews the marketplace, and what happens when review is the bottleneck?** Options: first-party review for everything (slow, trusted), automated gates + community flagging (fast, thinner), or a tiered model (automated for all, human for featured/flagged). Related: does Titer host the marketplace, or start lighter — a GitHub index the app browses (the Fiji update-site shape), with no server to run?
9. **"Reinforce learning" — closed.** (Nov 13 ~10:08 PT: this was about Workflows — adaptive replay + learning from corrections, §4a. **Not** a reinforcement-learning analysis pillar. No RL-analyses item is added. Nov 13 ~10:10 PT correction: adaptive replay + learning from corrections is a future nice-to-have ONLY, not a core requirement — §4a.)
10. **Enterprise: pricing model?** (Do NOT decide here.) Per-seat, per-lab, per-institution, or usage-based? What does a university pay for vs a corporation? Needs Smit's call — and the lawyer gate before any pricing or selling step.
11. **Enterprise: open-core or paid hosting/support?** Is enterprise a separate proprietary offering alongside the free GPL core (open-core), or paid hosting/support around the same open code? The answer shapes the license story — see Q7 for the plugin side of the same question.
12. **Enterprise: which release?** It is a pillar in this v3 roadmap draft, but the release timing is Smit's call — v3, or later? The dependency is real either way: enterprise needs the agent layer, Workflows, and plugin framework stable first (Phase 6), so it cannot land before them.

---

## Sources

- MCP transports + spec revisions: <https://docs.stacklok.com/toolhive/concepts/mcp-primer>, <https://ai-tldr.dev/learn/ai-agents/model-context-protocol/mcp-transports-stdio-http/>, <https://www.himanshur.dev/blogs/mcp-transports>, <https://www.getmaxim.ai/articles/the-mcp-protocol-transports-primitives-and-the-message-lifecycle/>
- Claude Desktop local servers + `.mcpb`: <https://klyvoo.com/blog/claude-mcp-servers/>, <https://www.casdoor.com/blog/add-mcp-server-to-claude>
- Claude Code MCP: <https://www.vincosha.com/mcp/setup/claude-code>, <https://overclaud.dev/learn/claude-code-mcp-servers/>
- Codex MCP: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>, <https://corsair.dev/blog/codex-mcp>
- Antigravity MCP: <https://antigravity.google/docs/mcp?authuser=9>
- Tauri MCP shipping: <https://crates.io/crates/tauri-plugin-mcp-commands-macros>, <https://github.com/turboladen/noteplan-organizer/blob/HEAD/CLAUDE.md>, <https://github.com/fabio-rovai/open-ontologies/blob/HEAD/studio/README.md>
- Tauri capabilities / Isolation pattern / capability-boundary-not-a-sandbox: <https://kern.aaenz.no/docs/plugin-security>, <https://github.com/cristiannorga/rsc-harness-opencode/blob/HEAD/skills/tauri/SKILL.md>
- Prism repeating an analysis (Wand, templates, duplicate family, clone graph): <https://www.graphpad.com/guides/prism/10/user-guide/repeating_an_analysis.htm>, <https://cdn.graphpad.com/faq/1757/file/P4-Repeated%20analyses.pdf>
- Workflow tools (KNIME, R targets): <https://www.displayr.com/best-spss-alternatives/>, <https://cran.stat.auckland.ac.nz/web/views/ReproducibleResearch.html>
- Extension marketplaces: VS Code — <https://www.codegenes.net/blog/how-safe-are-extensions-in-visual-studio-code/>, <https://safeguard.sh/resources/blog/what-can-a-vs-code-extension-access-on-your-machine>, <https://base.bangwu.me/env/editor-extension-security>; Fiji — <https://imagej.github.io/imagej-wiki-static/Distribution>, <http://imagej.github.io/list-of-update-sites>; Obsidian — <https://obsidian.md/help/Extending%20Obsidian/Plugin%20security>; CRAN — <https://www.irurueta.com/programming-languages/r/publishing-to-cran.html>
- Titer ground truth (vault): `Research/Prism 10 analysis catalogue.md` (56 analyses), `Plans/Implementation/TRACKING.md` (plans 00–36 + multi-panel), `Plans/Implementation/multi-panel-figure-builder.md`, `Plans/v2 rolling backlog.md` (Wand, Templates, Clone a graph, Duplicate a family — items 1–4)

## Open verification items (things this draft could NOT verify — check before building)

1. **Antigravity plugins marketplace** (Oct 29, 2026 launch, 60+ plugins, one-click install, plugin = MCP servers + skills + rules + agents + hooks): sourced from a social-media summary, not Google's own docs. Verify against Antigravity's official docs before promising one-click install there.
2. **2026-07-28 MCP spec adoption** by Claude Desktop / Claude Code / Codex / Antigravity: the revision exists and is current, but which clients have adopted its stateless model is unverified. Build against 2025-06-18 / 2025-11-25 until verified.
3. **`.mcpb` one-click install UX in current Claude Desktop**: from third-party guides, not Anthropic's own docs. Verify the exact flow at build time.
4. **`tauri-plugin-mcp-commands`**: a young third-party crate, not an official Tauri plugin. Evaluate (code review + test app) before committing to it; the rmcp + own-server alternative stays open.
5. **"No stats/graphing tool offers reusable branching pipelines for non-coders"**: true as far as this research found (Prism, JASP/jamovi, KNIME, R targets, Nextflow/Snakemake checked). It is a research claim, not a proven negative — re-check before putting it in any public copy.
6. **Example workflows** in §4a are illustrative, drawn from the Prism "repeating an analysis" use case and Mansi's known work. No workflow was verified against a real lab routine. Pin three real routines (researcher interviews, including Mansi) as a Phase 5 research item.
7. **Paid plugins under GPL-3.0** (§6 Q7): flagged, not answered. Needs Smit's call + a lawyer, not a roadmap guess.
