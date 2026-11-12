#!/usr/bin/env bash
# Build Helix Mac DMGs on a Mac. Run from the repo root on macOS:
#   ./scripts/build-mac-dmg.sh            # both archs (aarch64 + x86_64)
#   ./scripts/build-mac-dmg.sh aarch64    # arm64 only
#   ./scripts/build-mac-dmg.sh x86_64     # Intel only
#
# Why this script exists (learned 2026-11-09, Smit's MacBook Air):
# plain `npm run build` compiles + signs both .app bundles fine, but Tauri's
# DMG step (`bundle_dmg.sh`, a create-dmg fork) is flaky when run from Tauri:
#   1. It sometimes fails because Tauri invokes it with a cwd that makes the
#      temp image land INSIDE the source folder (bundle/macos/rw.<pid>.Helix_*.dmg).
#      hdiutil then copies the growing image into itself -> "No space left on
#      device". Other times it succeeds and produces the DMG itself.
#   2. Over SSH (no GUI session) the Finder's AppleScript prettifying step
#      times out (-1712) and the script aborts before finalizing the DMG.
# This script builds the .app with Tauri (tolerating either DMG outcome),
# cleans any stray rw.*.dmg out of the source folder, then runs bundle_dmg.sh
# directly with absolute paths and --skip-jenkins (no Finder AppleScript)
# ONLY if Tauri did not already produce the DMG — running it over an existing
# DMG fails with "hdiutil: convert failed - File exists" (hit 2026-11-09).
# The resulting DMG has Helix.app + Applications link + background + volume
# icon, just without the Finder window-position/icon-layout dressing.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

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
  npx tauri build --target "$TARGET" || true
  BUNDLE="src-tauri/target/$TARGET/release/bundle"
  # Stray temp images from failed runs must not sit in the source folder.
  find "$BUNDLE" -name 'rw.*.dmg' -delete || true
  DMG_NAME="Helix_1.0.6_aarch64.dmg"
  [ "$TARGET" = "x86_64-apple-darwin" ] && DMG_NAME="Helix_1.0.6_x64.dmg"
  if [ -f "$BUNDLE/dmg/$DMG_NAME" ]; then
    # Tauri's own DMG step succeeded this run. The manual step would fail
    # with "hdiutil: convert failed - File exists", so skip it and verify.
    echo "=== $TARGET: Tauri already produced $DMG_NAME — verifying ==="
    hdiutil verify "$BUNDLE/dmg/$DMG_NAME"
  else
    echo "=== $TARGET: manual DMG bundle -> $BUNDLE/dmg/$DMG_NAME ==="
    (cd /tmp && bash "$ROOT/$BUNDLE/dmg/bundle_dmg.sh" --skip-jenkins \
      --volname Helix \
      --volicon "$ROOT/$BUNDLE/dmg/icon.icns" \
      --background "$ROOT/src-tauri/icons/dmg-background.png" \
      --window-pos 200 120 --window-size 660 400 --icon-size 100 \
      --icon Helix.app 180 185 --app-drop-link 480 185 \
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
  APP="$BUNDLE/macos/Helix.app"
  for LICENSE_FILE in LICENSE THIRD-PARTY-NOTICES.md; do
    [ -f "$APP/Contents/Resources/$LICENSE_FILE" ] || { echo "ERROR: $LICENSE_FILE missing from $APP/Contents/Resources" >&2; exit 1; }
  done
  ls -lh "$BUNDLE/dmg/$DMG_NAME"
  shasum -a 256 "$BUNDLE/dmg/$DMG_NAME"
done
