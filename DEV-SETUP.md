# Titer dev setup — Hatch Linux VM (build + test)

Linux is a **first-class dev/test platform** for Titer (Smit's call,
2026-11-08: "get it working on Linux so you can build, test independently
without my need"). The **Mac DMG stays the release target for Mansi** —
signing/notarization and the Mac-only UI polish still need a Mac. Mac GUI
proofs run on Smit's MacBook via the device route (Smit's call, 2026-11-09:
agents may install and test everything needed): background control only,
never steal focus, stop GUI work immediately if Smit starts using the Mac,
and never kill/restart the device gateway from SSH. DMGs are built on the
Mac itself (`scripts/build-mac-dmg.sh`).

Last verified: 2026-11-13, branch `feat/prism-import-survival` (suite green
on the launch tip; this doc's version table below is the Nov 8 snapshot —
re-run `scripts/setup-linux.sh` after every container replacement, which
reinstalls the system `-dev` packages the table lists).
Linux release build verified 2026-11-08 23:05, then **re-verified 23:37
after the ~23:20 container replacement** (apt reinstall via
`scripts/setup-linux.sh` + full rebuild).

## What is installed (exact versions)

| Tool | Version | Source |
|---|---|---|
| Node.js | v24.22.1 | preinstalled on the box (meets README's Node 24+ requirement) |
| npm | 10.9.4 | with Node |
| rustup | 1.29.3 | already at `~/.cargo/bin/rustup` (installed 2026-11-04, not by this task) |
| rustc / cargo | 1.99.1 | rustup stable toolchain `stable-x86_64-unknown-linux-gnu` |
| Rust targets | `aarch64-apple-darwin`, `x86_64-apple-darwin` | `rustup target add …` (see below) |
| clang | 18.1.3 (Ubuntu) | preinstalled (`/usr/bin/clang`) — needed for the Apple-target check |
| Python | 3.12.3 | preinstalled (not needed by Titer) |
| OS | Ubuntu 24.04.5 LTS, x86_64 | — |

## PATH — the one gotcha

`~/.cargo/bin` is on PATH in a **login** shell (`bash -lc` shows it), but
**not** in the non-login shells the exec tool uses. Every command below that
uses `cargo`/`rustc` needs this first:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

## Install / redo from scratch (after a container replacement)

### 1. Rust (survives replacement — lives under `/home/hatch`)

If `~/.cargo` is ever missing, reinstall rustup (do not use `apt` Rust):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
export PATH="$HOME/.cargo/bin:$PATH"
```

Then add the Mac targets (one-time; ~30 s each, downloads the Apple `std`):

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### 2. System packages (do NOT survive replacement — redo every time)

Tauri on Linux needs GTK/WebKit dev packages. One command redoes them:

```bash
bash ~/workspace/helix/scripts/setup-linux.sh
```

That installs: `build-essential pkg-config libwebkit2gtk-4.1-dev
libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev
libxdo-dev zenity xvfb ffmpeg xdg-utils xdotool x11-utils openbox dbus-x11
xdg-desktop-portal xdg-desktop-portal-gtk` (WebKit 2.52.6 era, Nov 2026).
It also downgrades `libzstd1` from the Hatch-pinned `+hatch1` build to the
archive build if needed (`libzstd-dev` refuses the pinned one).

Two container-replacement gotchas, both observed 2026-11-08:

- **No package lists on a fresh container.** A bare `apt-get install`
  fails with "Unable to locate package" for `dbus-x11`,
  `xdg-desktop-portal(-gtk)`, `openbox`, `x11-utils`. Run with
  `APT_UPDATE=1` the first time after a replacement (slow — several
  minutes on the Azure/Cogent mirrors — but required):
  `APT_UPDATE=1 bash scripts/setup-linux.sh`.
- **The Hatch os-intent replay holds the dpkg lock.** Right after a
  replacement the runtime replays recorded apt intent and holds
  `/var/lib/dpkg/lock-frontend` for many minutes; `apt-get` fails with
  "Could not get lock". Wait until no `apt-get`/`dpkg` process is running
  (`pgrep -x apt-get; pgrep -x dpkg` both empty), then run the script.
  `scripts/setup-linux.sh` does not wait for the lock itself.

### 3. JS deps and verification

```bash
cd ~/workspace/helix
npm ci            # clean install from package-lock.json; exits 0, 0 vulnerabilities
npm run check     # tsc --noEmit; must be clean
npm test          # node tsx tests/checks.ts + tests/reference.ts; must print "All 87 results match."
```

## Linux code changes (this branch)

`src-tauri/src/main.rs` keeps every Mac path intact and adds Linux
equivalents behind `#[cfg]`:

- `objc2` import and `OnceLock` gated `#[cfg(target_os = "macos")]`.
- `set_document`'s `NSWindow` close-button dot gated macOS; Linux ignores
  `edited` (`let _ = edited`).
- `set_recent_documents` / `accent_color` / `open_link` gated macOS, with
  non-macOS twins: recent-documents is a no-op, accent color returns
  `None` (the page falls back to its default), links open via `xdg-open`.
- `ask_before_quitting` / `show_menu_pictures` delegate to
  `*_macos` helpers on macOS, no-op elsewhere.
- `save_session` has `#[cfg_attr(not(target_os = "macos"), allow(dead_code))]`
  (only the macOS quit hook calls it).
- `RunEvent::Opened` / `RunEvent::Reopen` arms gated macOS (those variants
  don't exist on Linux).
- `src-tauri/Cargo.toml`: base `tauri = { version = "2" }` with no
  `macos-private-api`; that feature + `objc2 = "0.6"` moved to
  `[target.'cfg(target_os = "macos")'.dependencies]`.
- `package.json`: `"build:linux": "tauri build --no-bundle"` (`--bundles app`
  is invalid on Linux; valid values are deb/rpm/appimage).
- Rust unit tests (`#[cfg(test)] mod tests` at the end of `main.rs`):
  `read_prism_text` reads a `.pzfx` fixture, rejects `.txt`/`.hlx`/
  `.pzfx.bak`/extensionless paths, accepts uppercase `.PZFX`, and reports
  a missing `.pzfx` file as an I/O error.

The file picker itself needed **no** code change: `choose_prism_file`
uses `tauri-plugin-dialog` 2.7.3 → `rfd` 0.16, whose default backend is
the XDG Desktop Portal with a `zenity` fallback. It works on Linux once
the portal + a D-Bus session + a window manager are actually running
(see "Running the app" below).

## Checks

```bash
cd ~/workspace/helix/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo check                              # Linux host — needs the apt deps above
cargo test                               # 4 read_prism_text tests (Linux-first)
CC_aarch64_apple_darwin="clang --target=aarch64-apple-darwin" \
  cargo check --target aarch64-apple-darwin
CC_x86_64_apple_darwin="clang --target=x86_64-apple-darwin" \
  cargo check --target x86_64-apple-darwin
```

The Apple-target checks need the `CC_<target>` override: without it the
`objc2-exception-helper` build script runs Linux `cc` (gcc) on an
Objective-C file with `-arch arm64 -mmacosx-version-min=11.0`, which gcc
rejects. Clang targeting `aarch64-apple-darwin` accepts those flags, and
that file deliberately includes no headers, so no macOS SDK is needed for
the **check**. All four checks exit 0 (verified 2026-11-08; the Apple
targets even pass with no GTK libs installed).

## Building the Linux app

```bash
cd ~/workspace/helix
npm run build:linux    # vite build + tauri build --no-bundle
```

Verified 2026-11-08 23:05 (pre-replacement) and **re-verified 23:37
(post-replacement rebuild)**: exit 0, vite ~10 s, release compile
2 m 11 s, binary `src-tauri/target/release/helix`, 43,798,608 bytes,
executable. (Plain `cargo check` on the host initially failed in
`tauri-build` with "features do not match the allowlist defined under
`tauri.conf.json`" because `macOSPrivateApi: true` is set there; running
via the `tauri build` CLI bypasses that check.)

Optional installer artifact (not yet tried): `tauri build --bundles deb`
or `--bundles appimage`.

## Running the app (headless, under Xvfb)

`/tmp` is a 512 MB tmpfs and gets wiped mid-session — keep logs and
screenshots under `~/workspace/helix/logs/` and `~/workspace/helix/screenshots/`,
never `/tmp`. (`/tmp` also filled once during this work: a test crate's
`target/` dir hit 501 MB and broke the linker; use
`CARGO_TARGET_DIR` under `~/workspace` for scratch crates.)

```bash
# 1. Display + window manager + D-Bus session (all three matter: the file
#    picker needs a session bus, and GTK dialogs need a WM to paint).
Xvfb :98 -listen tcp -screen 0 1280x800x24 > logs/xvfb.log 2>&1 &
echo $! > logs/xvfb.pid
DISPLAY=127.0.0.1:98 openbox > logs/openbox.log 2>&1 &
echo $! > logs/openbox.pid
# 2. App, inside a D-Bus session so the XDG portal can activate:
dbus-run-session -- env DISPLAY=127.0.0.1:98 \
  ./src-tauri/target/release/titer > logs/linux-run.log 2>&1 &
# 3. Screenshot:
ffmpeg -y -f x11grab -i 127.0.0.1:98 -frames:v 1 screenshots/linux-launch.png
```

Verified 2026-11-08: the app launches (~198 MB RSS, only DRI3
software-rendering warnings), renders the menu bar
(Titer/File/Edit/Table/Analysis/Graph/View/Window/Help) and the Table 1
Column grid — see `screenshots/linux-launch.png`.

**File picker — KNOWN LIMITATION on Linux (verified 2026-11-08, see below):
the in-app File ▸ Import Prism File… does NOT complete under Xvfb.**
The menu item activates (the portal service activates on click), but no
chooser dialog appears, and the app's UI then stops responding to clicks
and keys (menus won't reopen, grid typing does nothing, Escape doesn't
recover; the process stays alive at ~0.6% CPU). Each click also strands a
blocked `blocking_pick_file` call. **Use the headless smoke test
(`tests/linux-smoke.ts`) for import verification on Linux instead** — it
drives the same parser. The picker is native on macOS and unaffected
there; this is a Linux dev/test gap only.

What was established while isolating it (isolation crate
`~/workspace/.rfdtest2`, target dir `~/workspace/.rfdtest2-target`,
kept outside the repo):

- The portal stack itself works: the XDG portal + GTK chooser render
  (`screenshots/linux-rfdtest.png`, `linux-rfdtest2.png`) and an isolated
  `rfd::FileDialog::pick_file()` (sync, pollster `block_on`) completed a
  full round-trip once — dialog → type path → Enter → `result:
  Some("…/tests/testdata/survival.pzfx")`, process exited cleanly.
- The same call is flaky in repeat runs: the dialog appears, then
  vanishes within ~15 s without resolving (seen twice with
  `AsyncFileDialog` driven by a tokio runtime, and once with the sync
  call when the driving keystrokes raced focus). A portal-gtk dialog
  window lingering unmapped can also make `xdotool search` report a
  false positive — always confirm with `--onlyvisible` AND a screenshot.
- Inside the Tauri app the failure is worse (no dialog at all + frozen
  UI). Prime suspect: `tauri-plugin-dialog` 2.7.3's `blocking_pick_file`
  (`blocking_fn!` → `pick_file` → `run_on_main_thread` +
  `tauri::async_runtime::block_on` on a spawned thread) interacting with
  the Tao/WebKit main loop. Not proven; the plugin source is at
  `~/.cargo/registry/src/*/tauri-plugin-dialog-2.7.3/src/` (`commands.rs`
  sets the parent only on Windows/macOS, so no parent is passed on
  Linux; `desktop.rs` has the `run_on_main_thread` + `block_on` wiring).
- Leading fix idea (NOT yet tried): on Linux only, bypass the plugin in
  `choose_prism_file` and call `rfd::FileDialog::pick_file()` directly on
  the command thread (the pattern proven working once in isolation).
  Gate it `#[cfg(not(target_os = "macos"))]` so the Mac path is
  untouched, and validate it end-to-end under Xvfb before keeping it.

**GUI import test — NOT passed on Linux:** launch under Xvfb as above,
File ▸ Import Prism File…, drive the chooser by keyboard (Ctrl+L, type
the fixture path, Enter), screenshot the imported table. Fixture:
`tests/testdata/survival.pzfx`. Blocked by the limitation above; the
parser-direct smoke test is the standing substitute.

## Headless import smoke test (no GUI)

When the picker can't be automated, drive the same parser the GUI import
path uses directly:

```bash
node --import tsx tests/linux-smoke.ts
```

Parses all 6 fixtures in `tests/testdata/` (`column`, `column_sdn`,
`contingency`, `survival`, `x_y_rep`, `x_y_with_strike`) and runs the
log-rank test on the imported survival table. Verified 2026-11-08:
all 6 parse (survival → XY, 27 rows, 3 groups); log-rank χ² = 4.844,
df = 2, p = 0.0888. Say which method was used (GUI vs parser-direct)
when reporting import results.

## What works on this box (verified 2026-11-08)

| Command | Result |
|---|---|
| `npm ci` | ✅ exit 0 |
| `npm run check` | ✅ clean |
| `npm test` | ✅ "All 87 results match." |
| `npx vite build` | ✅ exit 0, `dist/index.html` produced |
| `cargo check --target aarch64-apple-darwin` / `--target x86_64-apple-darwin` (with clang `CC_` override) | ✅ exit 0 — Prism commands compile for Mac |
| `npm run build:linux` | ✅ exit 0, `src-tauri/target/release/helix` (43.8 MB) — built 23:05, rebuilt 23:37 after container replacement |
| `cargo check` (Linux host) | ✅ exit 0 (after apt reinstall) |
| `cargo test` (4 `read_prism_text` tests) | ✅ 4 passed, 0 failed |
| Linux app under Xvfb | ✅ launches, menu bar + Table 1 grid render (fresh binary, `screenshots/linux-gui-launch.png`) |
| File ▸ menu | ✅ opens, "Import Prism File…" visible (`screenshots/linux-gui-filemenu.png`) |
| XDG portal file chooser (isolated `rfd` test crate) | ✅ renders with "GraphPad Prism File" filter; sync `pick_file` completed one full round-trip (dialog → path → result) |
| `node --import tsx tests/linux-smoke.ts` | ✅ all 6 fixtures parse, log-rank runs |
| GUI File ▸ Import Prism File… end-to-end in the app | ❌ **does not complete on Linux** — see "File picker" limitation above; use `tests/linux-smoke.ts` instead |
| `tauri build --bundles deb` / `appimage` | not tried (nice-to-have) |

## What still needs a Mac

| Task | Why |
|---|---|
| `npm run build` — both DMGs (`aarch64` + `x86_64-apple-darwin`) | Linking a Mac binary needs `xcrun` / macOS SDK + `ld64`/Xcode linker; `rustc` for Apple targets invokes `xcrun --sdk macosx --show-sdk-path`, which does not exist on Linux. `cargo check` is the validation ceiling on Linux. |
| Signing / notarization | Bundle uses ad-hoc signing (`signingIdentity: "-"`); real signing needs a Mac. `npm run install-app` if installing locally. |
| Running the Mac app / `npm run dev` on macOS | The Linux binary is dev/test only. Exercise File ▸ Import Prism File… with a real `.pzfx` file plus the log-rank test on the Mac too. |
| Mac-only UI polish | Accent color, Dock recent-documents, NSWindow edited-dot, Dock-icon reopen — all no-ops or fallbacks on Linux by design. |

## Still owed on a Mac

1. `npm run build` — builds both DMGs; requires Xcode Command Line Tools and the Rust Apple targets.
2. `cargo check` on the Mac as a sanity re-check (should already be green per the Linux Apple-target check).
3. Run the app / `npm run dev` on the Mac and exercise File ▸ Import Prism File… with a real `.pzfx` file, plus the log-rank test.
4. Signing / notarization and `npm run install-app` if installing locally.

## Mac DMG build — DONE 2026-11-09 (Smit's MacBook Air, M2, macOS 26.6)

- Prereqs found missing on the Mac and installed: Node/npm via Homebrew
  (`/opt/homebrew/bin`, node v25.1.0); Rust was absent — installed rustup
  (stable, cargo/rustc 1.99.1) + `rustup target add x86_64-apple-darwin`.
  Xcode CLT was already present. `npm ci`, `npm run check`, `npm test`
  87/87 all green on the Mac. HEAD built: `59f5260`.
- **Both DMGs built and verified** (mount + contents check):
  `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Helix_1.0.6_aarch64.dmg`
  (40 MB, sha256 `67dfb96e…5aa005f`) and
  `src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/Helix_1.0.6_x64.dmg`
  (41 MB, sha256 `88e4c363…6a2050`). arm64 DMG installed to
  `/Applications/Helix.app` (ditto from mounted DMG, quarantine cleared,
  `codesign --verify` clean); app launches, window "Untitled" appears.
- **Two Tauri DMG-step failures, both worked around — use
  `scripts/build-mac-dmg.sh` instead of plain `npm run build`:**
  1. Tauri invokes `bundle_dmg.sh` with a cwd that drops its temp image
     (`rw.<pid>.Titer_*.dmg`) INSIDE the source folder
     (`bundle/macos/`); hdiutil then copies the growing image into itself
     → `hdiutil: create failed - No space left on device` (real disk had
     24 GiB free). Fix: delete any `rw.*.dmg` under `bundle/` before
     bundling, and run `bundle_dmg.sh` with absolute paths from a neutral
     cwd (`/tmp`). (Watch out: in zsh, `rm -f …/rw.*.dmg` with no match
     aborts the whole command — use `find … -name 'rw.*.dmg' -delete`.)
  2. Over SSH the Finder's AppleScript prettifying step times out
     (`Finder got an error: AppleEvent timed out. (-1712)`, same as the
     Cricket 07 osascript note) and the script aborts before finalizing.
     Fix: pass `--skip-jenkins` (skips the Finder AppleScript). The DMG
     still gets Titer.app + Applications link + background + volume icon,
     just without the Finder window/icon layout dressing.
- **In-app testing on the Mac, PARTIAL (2026-11-09 ~17:20 PT):** app
  launched fine, File menu lists "Import Prism File…", but after clicking
  it via System Events the app stopped answering window/menu queries
  (empty window list, menu bar -1719; process alive, frontmost, ~idle).
  Escape did not recover it. This looks like the same
  `blocking_pick_file` freeze seen on Linux — NOT yet proven on Mac.
  Further testing was blocked because outbound SSH from the Hatch VM
  started being refused by the egress proxy mid-session ("Outbound SSH
  is turned off for this assistant" — Muse settings → Permissions →
  Direct network protocols → ssh). Smit to confirm by hand tonight
  whether the picker opens; `screencapture` from SSH is blocked by the
  Screen Recording permission, so visual proof needs his session.

## Environment gotchas (learned 2026-11-08)

- `pkill -f "<pattern>"` matches your own exec command line and SIGTERMs
  your own shell — kill by PID file, never by pattern (see root AGENTS.md).
- `apt-get update` is extremely slow on the Hatch mirrors; existing lists
  are usually usable except right after a container replacement.
- The app's D-Bus socket lives under `/tmp/dbus-*` — vulnerable to `/tmp`
  wipes; restart the session if the bus dies.
- Memory is tight (~1–3 GB free); the release build peaks during linking.
  Don't run the build and the app side by side if the box is loaded.
