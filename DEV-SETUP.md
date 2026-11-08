# Helix dev setup — Hatch Linux VM (validation only)

Product stays **Mac-native only**. This box (Ubuntu 24.04, x86_64) is for
validation: type-check, tests, and frontend build. It cannot link a Mac
binary or run the Mac app. The Mac DMG build, signing, and running the app
still happen on a Mac.

Last verified: 2026-11-08, branch `feat/prism-import-survival`, commit `33f1178`.

## What is installed (exact versions)

| Tool | Version | Source |
|---|---|---|
| Node.js | v24.22.1 | preinstalled on the box (meets README's Node 24+ requirement) |
| npm | 10.9.4 | with Node |
| rustup | 1.29.3 | already at `~/.cargo/bin/rustup` (installed 2026-11-04, not by this task) |
| rustc / cargo | 1.99.1 | rustup stable toolchain `stable-x86_64-unknown-linux-gnu` |
| Rust targets | `aarch64-apple-darwin`, `x86_64-apple-darwin` | installed by this task, see below |
| clang | 18.1.3 (Ubuntu) | preinstalled (`/usr/bin/clang`) — needed for the Apple-target check, see below |
| Python | 3.12.3 | preinstalled (not needed by Helix) |
| OS | Ubuntu 24.04.5 LTS, x86_64 | — |

Nothing was installed with `apt`. System packages do **not** survive a Hatch
container replacement, so `apt install` of Tauri's Linux GUI deps was
deliberately skipped (see "What does not work" below).

## PATH — the one gotcha

`~/.cargo/bin` is on PATH in a **login** shell (`bash -lc` shows it), but
**not** in the non-login shells the exec tool uses. Every command below that
uses `cargo`/`rustc` needs this first:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

## Install / redo from scratch (after a container replacement)

Rust lives in `~/.cargo` + `~/.rustup` (both under `/home/hatch`, which
persists). If they are ever missing, reinstall rustup (do not use `apt` Rust):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
export PATH="$HOME/.cargo/bin:$PATH"
```

Then add the Mac targets (one-time; ~30 s each, downloads the Apple `std`):

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

Then install JS deps and verify:

```bash
cd ~/workspace/helix
npm ci            # clean install from package-lock.json; exits 0, 0 vulnerabilities
npm run check     # tsc --noEmit; must be clean
npm test          # node tsx tests/checks.ts + tests/reference.ts; must print "All 87 results match."
```

## The Rust check that matters: Apple targets, not the Linux host

`cargo check` for the **host** target does not work on this box and is not
the goal — it fails in the `gdk-sys` build script (`gdk-3.0.pc` not found)
because Tauri on Linux needs GTK/WebKit dev packages that are not installed
and would not survive a container replacement anyway.

The check that validates the real product code is the **Apple-target**
check. It type-checks `src-tauri/src/main.rs` — including the new
`choose_prism_file` / `read_prism_text` commands — for macOS, without
linking and without any Linux GUI library:

```bash
cd ~/workspace/helix/src-tauri
CC_aarch64_apple_darwin="clang --target=aarch64-apple-darwin" \
  cargo check --target aarch64-apple-darwin
CC_x86_64_apple_darwin="clang --target=x86_64-apple-darwin" \
  cargo check --target x86_64-apple-darwin
```

Both exit 0 (verified 2026-11-08; `Checking helix v1.0.6` in the output,
`Finished dev profile`). The `CC_<target>` override is required: without it
the `objc2-exception-helper` build script runs Linux `cc` (gcc) on an
Objective-C file with `-arch arm64 -mmacosx-version-min=11.0`, which gcc
rejects. Clang targeting `aarch64-apple-darwin` accepts those flags, and
that file deliberately includes no headers, so no macOS SDK is needed for
the **check**.

There are no Rust unit tests in the crate (`grep #[test] src-tauri/src`
finds none), so there is no `cargo test` to run here. The test coverage is
the TypeScript suite (`npm test`, 87 R reference results).

## What works on this box (verified 2026-11-08)

| Command | Result |
|---|---|
| `npm ci` | ✅ exit 0 |
| `npm run check` | ✅ clean |
| `npm test` | ✅ "All 87 results match." |
| `npx vite build` | ✅ exit 0, `dist/index.html` produced |
| `cargo check --target aarch64-apple-darwin` (with clang `CC_` override) | ✅ exit 0 — **new Prism commands compile for Mac** |
| `cargo check --target x86_64-apple-darwin` (with clang `CC_` override) | ✅ exit 0 |

## What does not work on this box (expected — Mac-only product)

| Command | Failure | Why |
|---|---|---|
| `cargo check` (host `x86_64-unknown-linux-gnu`) | `gdk-sys` build script: `gdk-3.0.pc` not found, exit 101 | Tauri on Linux needs GTK/WebKit dev packages. On a persistent Linux box: `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`. **Do not install these here** — they vanish on container replacement, and the host build is not the product. |
| `npm run dev` (`tauri dev`) | Same `gdk-sys` failure, exit 101 | It builds the Linux app, which needs the same missing GUI libs plus a display. |
| `npm run build` / `cargo build --target aarch64-apple-darwin` | Cannot link | `rustc` for Apple targets invokes `xcrun --sdk macosx --show-sdk-path` to find MacOSX.sdk — `xcrun` does not exist on Linux. A minimal link probe fails the same way. Linking a Mac binary needs the macOS SDK + `ld64`/Xcode linker. `cargo check` (above) is the validation ceiling on Linux. |
| Running the app | Not possible | macOS-only binary; no Mac here. Do not test on Smit's MacBook — Smit does all Mac testing himself. |

## Still owed on a Mac

1. `npm run build` — builds both DMGs (`aarch64-apple-darwin` + `x86_64-apple-darwin`); requires Xcode Command Line Tools and the Rust Apple targets (`rustup target add aarch64-apple-darwin x86_64-apple-darwin`).
2. `cargo check` on the Mac as a sanity re-check (should already be green per the Linux Apple-target check).
3. Run the app / `npm run dev` on the Mac and exercise File ▸ Import Prism File… with a real `.pzfx` file, plus the log-rank test — the new Tauri commands (`choose_prism_file` / `read_prism_text`) have never been compiled or run, only `cargo check`ed.
4. Signing / notarization (the bundle uses ad-hoc signing, `signingIdentity: "-"`) and `npm run install-app` if installing locally.
