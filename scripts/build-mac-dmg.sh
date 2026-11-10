#!/usr/bin/env bash
# Build Helix Mac DMGs on a Mac. Run from the repo root on macOS:
#   ./scripts/build-mac-dmg.sh            # both archs (aarch64 + x86_64)
#   ./scripts/build-mac-dmg.sh aarch64    # arm64 only
#   ./scripts/build-mac-dmg.sh x86_64     # Intel only
#
# Why this script exists (learned 2026-11-09, Smit's MacBook Air):
# plain `npm run build` compiles + signs both .app bundles fine, but Tauri's
# DMG step (`bundle_dmg.sh`, a create-dmg fork) fails when run from Tauri:
#   1. Tauri invokes it with a cwd that makes the temp image land INSIDE the
#      source folder (bundle/macos/rw.<pid>.Helix_*.dmg). hdiutil then copies
#      the growing image into itself -> "No space left on device".
#   2. Over SSH (no GUI session) the Finder's AppleScript prettifying step
#      times out (-1712) and the script aborts before finalizing the DMG.
# This script builds the .app with Tauri (skipping its DMG step via
# --bundles app is not possible per-target, so it tolerates the DMG failure),
# cleans any stray rw.*.dmg out of the source folder, then runs bundle_dmg.sh
# directly with absolute paths and --skip-jenkins (no Finder AppleScript).
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

for TARGET in $TARGETS; do
  echo "=== $TARGET: tauri build (DMG step expected to fail, tolerated) ==="
  npx tauri build --target "$TARGET" || true
  BUNDLE="src-tauri/target/$TARGET/release/bundle"
  # Stray temp images from failed runs must not sit in the source folder.
  find "$BUNDLE" -name 'rw.*.dmg' -delete || true
  DMG_NAME="Helix_1.0.6_aarch64.dmg"
  [ "$TARGET" = "x86_64-apple-darwin" ] && DMG_NAME="Helix_1.0.6_x64.dmg"
  echo "=== $TARGET: manual DMG bundle -> $BUNDLE/dmg/$DMG_NAME ==="
  (cd /tmp && bash "$ROOT/$BUNDLE/dmg/bundle_dmg.sh" --skip-jenkins \
    --volname Helix \
    --volicon "$ROOT/$BUNDLE/dmg/icon.icns" \
    --background "$ROOT/src-tauri/icons/dmg-background.png" \
    --window-pos 200 120 --window-size 660 400 --icon-size 100 \
    --icon Helix.app 180 185 --app-drop-link 480 185 \
    "$ROOT/$BUNDLE/dmg/$DMG_NAME" \
    "$ROOT/$BUNDLE/macos")
  ls -lh "$BUNDLE/dmg/$DMG_NAME"
  shasum -a 256 "$BUNDLE/dmg/$DMG_NAME"
done
