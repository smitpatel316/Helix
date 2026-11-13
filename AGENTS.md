# AGENTS.md — Titer repo

Read this first. One page to orient any agent; details live in the docs it
points at. Do not guess paths or commands — they are listed here.

## What this is

**Titer** — free, open-source (GPL-3.0), local-only alternative to GraphPad
Prism for macOS. Tauri 2 desktop app: React frontend, R 4.6 via webR
(WebAssembly) for statistics, Plotly for graphs. Fork of mickaphd/Helix.
Product name `Titer`, bundle ID `net.smitpatel.helix`, version `1.0.7`
(`package.json`). Working branch: `feat/prism-import-survival`. `main` is
the releasable line; the working branch merges into it at release.

## Layout

| Path | What lives there |
|---|---|
| `src/` | Frontend: `stats/` (R runners + TS checks), `lib/` (`.pzfx`/`.prism` import, `.prism` writer, converter), `views/` (analyses, graphs), `store/`, `menus.ts`, `app-menu.ts` |
| `src-tauri/` | Rust shell (`src/main.rs`, `tauri.conf.json`, `Cargo.toml`). Menu + file commands live here |
| `tests/` | Suite: `checks.ts`, `reference.ts` (+ `reference.json`), `prism.ts`, `prism-write.ts`, `parity.ts`, `packages.ts`; fixtures in `tests/testdata/` |
| `scripts/` | `setup-linux.sh` (Linux deps), `build-webr-repo.sh` (bundled R packages), `build-mac-dmg.sh` (Mac DMG — run ON the Mac) |
| `docs/` | `open-format-nudge.md` (save-prompt friction audit + no-dark-patterns rule) |
| `qa/` | QA evidence (proof notes, retest reports, side-by-side runbook). **Gitignored** — exists only in the main checkout (`~/workspace/helix/qa/`), not in fresh worktrees or clones |
| `samples/`, `screenshots/` | Sample projects, README screenshot |

## Build / test / verify loop

1. **After every container replacement** (or on a fresh box): run
   `scripts/setup-linux.sh` first (reinstalls system `-dev` packages).
   Non-login shells need `~/.cargo/bin` on `PATH` (cargo lives at
   `/home/hatch/.cargo/bin`, not `/root/.cargo/bin`).
2. `npm run check` — `tsc --noEmit`. Must be clean.
3. `npm test` — six legs: `checks.ts`, `prism.ts`, `prism-write.ts`,
   `reference.ts`, `parity.ts`, `packages.ts`. All must be green; the
   checks count grows as fixes land.
4. `cargo check` — Rust side. Slow (minutes); run it before claiming a
   release build works.
5. **GUI-proof builds MUST use `npm run build:linux`**
   (`build-webr-repo.sh` + `tauri build --no-bundle`). Bare
   `cargo build --release` does NOT embed the frontend (black webview).
   Verify binary path/size/sha before any GUI proof; never run a stale
   binary. Headless runs go under Xvfb (`DISPLAY=127.0.0.1:98`).
6. **Worktrees:** a fresh worktree needs `node_modules` AND top-level
   `webr-repo/` symlinked from `~/workspace/helix` (the test harness
   serves the package repo from the worktree's top-level `webr-repo/`;
   without it, survival checks fail). Use lane-specific `TMPDIR` under
   `~/workspace` — never `/tmp` (fills, gets wiped) and never a shared
   one (lanes race each other).
7. **Rust builds are memory-gated** (box is 1.5 CPU / ~6 GB; concurrent
   rustc builds OOM-kill each other): build only when ≤2 rustc processes
   are running AND >3 GB memory is free, with `CARGO_BUILD_JOBS=1`.
   Count rustc with `pgrep -c 'rustc --crate-nam[e]' 2>/dev/null || true`
   — the `|| echo 99` fallback yields a two-line value at count 0 and
   the window can never fire. Never `pgrep -f 'rustc --crate-name'`
   from an inline exec (it counts your own shell).
8. **Mac DMG is built ON the Mac** (`scripts/build-mac-dmg.sh`), never
   here. Never plain `git pull` on the Mac clone (fetch + `reset --hard`
   to the branch tip). Mac GUI proofs go through the device route, never
   `open -a` from SSH.

## Authoritative docs (in priority order)

- **Status truth:** `~/workspace/helix-vault/Plans/Implementation/TRACKING.md`
  — one row per plan/fix, updated on every landing. If it and a claim
  disagree, the file wins.
- **Scope:** `~/workspace/helix-vault/Plans/v1.0 scope.md` (frozen).
  Next release: `Plans/v2 rolling backlog.md`. Future: `Plans/v3 roadmap.md`.
- **Bug decisions:** `~/workspace/helix-vault/Quality/` — triage docs
  (`BUG-REPORT triage`, `Minors triage`) and the fix queue.
- **Front door:** `README.md`. **Methods:** `METHODS.md`.
  **File format:** `FILE-FORMAT.md`. **Parity proof:** `VALIDATION.md`.
- **Vault home:** `~/workspace/helix-vault/Home.md` (Obsidian vault;
  `Lanes.md` = the three lanes).

## Hard rules

- **Clean-room only.** Never decompile Prism, never use cracked/pirated
  source. Format work is files Prism wrote, never Prism's program.
  Boundary: `~/workspace/helix-vault/Legal/Clean-room boundary.md`.
- **Mansi's files are NEVER test material.** Public corpus only
  (`tests/testdata/`, `~/workspace/helix/test-corpus/`).
- **Never force-push. Never `git add -A`** (`git add -u` + explicit
  files). `git stash` is SHARED across worktrees — never blind
  `git stash pop` while other lanes are alive.
- **Verify "pushed / merged / done" claims** with `git ls-remote` +
  the diff before repeating them. Subagent claims have been wrong.
- **Fixes, not waivers.** If a fix fails verification, fix it; never
  waive a failing check to go green.
- **Keep it clean.** No lingering markdown, no orphaned status dumps.
  Status lives in `TRACKING.md`; evidence lives in `qa/`.
