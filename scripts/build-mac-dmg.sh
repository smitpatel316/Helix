#!/usr/bin/env bash
# Build Titer Mac DMGs on a Mac. Run from the repo root on macOS:
#   ./scripts/build-mac-dmg.sh            # both archs (aarch64 + x86_64)
#   ./scripts/build-mac-dmg.sh aarch64    # arm64 only
#   ./scripts/build-mac-dmg.sh x86_64     # Intel only
#
# Why this script exists (learned 2026-11-09, Smit's MacBook Air):
# plain `npm run build` compiles + signs both .app bundles fine, but Tauri's
# DMG step (`bundle_dmg.sh`, a create-dmg fork) is flaky when run from Tauri:
#   1. It sometimes fails because Tauri invokes it with a cwd that makes the
#      temp image land INSIDE the source folder (bundle/macos/rw.<pid>.Titer_*.dmg).
#      hdiutil then copies the growing image into itself -> "No space left on
#      device". Other times it succeeds and produces the DMG itself.
#   2. Over SSH (no GUI session) the Finder's AppleScript prettifying step
#      times out (-1712) and the script aborts before finalizing the DMG.
# This script builds the .app with Tauri (tolerating either DMG outcome),
# cleans any stray rw.*.dmg out of the source folder, then runs bundle_dmg.sh
# directly with absolute paths and --skip-jenkins (no Finder AppleScript)
# ONLY if Tauri did not already produce the DMG — running it over an existing
# DMG fails with "hdiutil: convert failed - File exists" (hit 2026-11-09).
# The resulting DMG has Titer.app + Applications link + background + volume
# icon, just without the Finder window-position/icon-layout dressing.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

VERSION="$(node -p "require('./package.json').version")"

ARCHS="${1:-both}"
case "$ARCHS" in
  both)   TARGETS="aarch64-apple-darwin x86_64-apple-darwin" ;;
  aarch64) TARGETS="aarch64-apple-darwin" ;;
  x86_64) TARGETS="x86_64-apple-darwin" ;;
  *) echo "usage: $0 [both|aarch64|x86_64]" >&2; exit 2 ;;
esac

# The vendored R package repo (plan 00) ships inside the app bundle; build
# it first so the DMG is offline-capable. Skips downloads already on disk.
./scripts/build-webr-repo.sh

for TARGET in $TARGETS; do
  echo "=== $TARGET: tauri build (DMG step may succeed or fail) ==="
  # Fail-hard guard (2026-11-14, cloud-box lane): a failed `tauri build`
  # used to fall through to the stale-DMG check below and "verify" a DMG
  # left in bundle/dmg/ by a previous lane — which was then installed by
  # mistake. Record the build start and only trust a DMG (or .app) newer
  # than it; anything older is stale and must never pass as this run's build.
  STAMP="$(mktemp /tmp/titer-build-start.XXXXXX)"
  TAURI_EXIT=0
  npx tauri build --target "$TARGET" || TAURI_EXIT=$?
  BUNDLE="src-tauri/target/$TARGET/release/bundle"
  # Stray temp images from failed runs must not sit in the source folder.
  find "$BUNDLE" -name 'rw.*.dmg' -delete || true
  DMG_NAME="Titer_${VERSION}_aarch64.dmg"
  [ "$TARGET" = "x86_64-apple-darwin" ] && DMG_NAME="Titer_${VERSION}_x64.dmg"
  if [ -f "$BUNDLE/dmg/$DMG_NAME" ] && [ "$BUNDLE/dmg/$DMG_NAME" -nt "$STAMP" ]; then
    # Tauri's own DMG step succeeded this run. The manual step would fail
    # with "hdiutil: convert failed - File exists", so skip it and verify.
    echo "=== $TARGET: Tauri already produced $DMG_NAME — verifying ==="
    hdiutil verify "$BUNDLE/dmg/$DMG_NAME"
  else
    # A DMG older than the build start is stale (a previous lane's) — it
    # must never pass as this run's build. Remove it and take the manual path.
    rm -f "$BUNDLE/dmg/$DMG_NAME"
    # If Tauri failed AND the .app is not fresh either, the build itself
    # failed (e.g. a cargo error) — fail hard instead of bundling stale output.
    # (A DMG-step-only failure still leaves a fresh .app, so the manual
    # bundle below keeps working for that case.)
    APP_BIN="$BUNDLE/macos/Titer.app/Contents/MacOS/titer"
    if [ "$TAURI_EXIT" -ne 0 ] && { [ ! -f "$APP_BIN" ] || [ ! "$APP_BIN" -nt "$STAMP" ]; }; then
      echo "ERROR: tauri build failed for $TARGET (exit $TAURI_EXIT) and no fresh .app was produced — refusing to bundle a stale build" >&2
      rm -f "$STAMP"
      exit 1
    fi
    echo "=== $TARGET: manual DMG bundle -> $BUNDLE/dmg/$DMG_NAME ==="
    (cd /tmp && bash "$ROOT/$BUNDLE/dmg/bundle_dmg.sh" --skip-jenkins \
      --volname Titer \
      --volicon "$ROOT/$BUNDLE/dmg/icon.icns" \
      --background "$ROOT/src-tauri/icons/dmg-background.png" \
      --window-pos 200 120 --window-size 660 400 --icon-size 100 \
      --icon Titer.app 180 185 --app-drop-link 480 185 \
      "$ROOT/$BUNDLE/dmg/$DMG_NAME" \
      "$ROOT/$BUNDLE/macos") || true
    # A failed manual run leaves its rw.*.dmg temp image behind; clean it
    # so the next run (and the source folder) stays tidy.
    find "$BUNDLE" -name 'rw.*.dmg' -delete || true
    [ -f "$BUNDLE/dmg/$DMG_NAME" ] || { echo "ERROR: no DMG produced for $TARGET" >&2; exit 1; }
  fi
  # License audit (2026-11-10): every distributed copy must carry the GPL
  # text. Tauri's bundle.resources copies LICENSE + THIRD-PARTY-NOTICES.md
  # into the .app; bundle_dmg.sh packages the .app as-is, so a LICENSE in
  # the .app is a LICENSE in the DMG whichever DMG path ran. Fail loudly
  # if it is missing — check bundle.resources in src-tauri/tauri.conf.json.
  APP="$BUNDLE/macos/Titer.app"
  for LICENSE_FILE in LICENSE THIRD-PARTY-NOTICES.md; do
    [ -f "$APP/Contents/Resources/$LICENSE_FILE" ] || { echo "ERROR: $LICENSE_FILE missing from $APP/Contents/Resources" >&2; exit 1; }
  done
  ls -lh "$BUNDLE/dmg/$DMG_NAME"
  shasum -a 256 "$BUNDLE/dmg/$DMG_NAME"
  rm -f "$STAMP"
done
