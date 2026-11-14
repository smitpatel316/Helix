#!/usr/bin/env bash
# Build titer-stdio-bridge and stage it where Tauri's externalBin expects it:
#   src-tauri/binaries/titer-stdio-bridge-<target-triple>[.exe]
# The bundler strips the triple suffix; the binary lands next to the app
# binary (Contents/MacOS/ on macOS). See docs/stdio-bridge.md §5.
#
# Usage:
#   ./scripts/build-stdio-bridge.sh                  # host triple only
#   ./scripts/build-stdio-bridge.sh --target TRIPLE  # one extra triple
#   ./scripts/build-stdio-bridge.sh --all            # macOS arm64+x64 (lipo universal)
#                                                     # + Windows x64 (if target installed)
#   ./scripts/build-stdio-bridge.sh --mcpb           # as --all, plus stage the
#                                                     # .mcpb bundle copies (mcpb/server/)
#
# NOTE: cross-target builds need the rust target installed
# (rustup target add <triple>); macOS universal needs `lipo` (Xcode tools).
# This script only runs at release/pack time — never during v1 verification.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/src-tauri/mcp-bridge"
DEST="$ROOT/src-tauri/binaries"
MCPB_SERVER="$ROOT/mcpb/server"

ALL=0
MCPB=0
TARGETS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=1 ;;
    --mcpb) MCPB=1; ALL=1 ;;
    --target) TARGETS+=("$2"); shift ;;
    -h|--help)
      echo "Usage: $0 [--target TRIPLE] [--all] [--mcpb]"
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$ALL" = 1 ]; then
  TARGETS=(aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc)
fi
if [ "${#TARGETS[@]}" -eq 0 ]; then
  TARGETS=("$(rustc --print host-tuple)")
fi

mkdir -p "$DEST"
[ "$MCPB" = 1 ] && mkdir -p "$MCPB_SERVER"

# build_one <triple> -> prints the built binary path
build_one() {
  local triple="$1"
  echo "==> cargo build --release --target $triple"
  cargo build --release --manifest-path "$CRATE/Cargo.toml" --target "$triple"
  local bin="$CRATE/target/$triple/release/titer-stdio-bridge"
  [ "$triple" = "x86_64-pc-windows-msvc" ] && bin="$bin.exe"
  echo "$bin"
}

MAC_BINS=()
for triple in "${TARGETS[@]}"; do
  if ! rustup target list --installed 2>/dev/null | grep -qx "$triple"; then
    echo "!! rust target $triple is not installed (rustup target add $triple) — skipping" >&2
    continue
  fi
  bin="$(build_one "$triple")"
  case "$triple" in
    x86_64-pc-windows-msvc)
      cp "$bin" "$DEST/titer-stdio-bridge-$triple.exe"
      echo "staged: src-tauri/binaries/titer-stdio-bridge-$triple.exe"
      [ "$MCPB" = 1 ] && cp "$bin" "$MCPB_SERVER/titer-stdio-bridge.exe"
      ;;
    aarch64-apple-darwin|x86_64-apple-darwin)
      MAC_BINS+=("$bin")
      cp "$bin" "$DEST/titer-stdio-bridge-$triple"
      echo "staged: src-tauri/binaries/titer-stdio-bridge-$triple"
      ;;
    *)
      cp "$bin" "$DEST/titer-stdio-bridge-$triple"
      echo "staged: src-tauri/binaries/titer-stdio-bridge-$triple"
      ;;
  esac
done

# macOS: one universal binary serves both triples — in the .mcpb (which has a
# single server/ slot per platform) and as a convenience for the app bundle.
if [ "$MCPB" = 1 ] && [ "${#MAC_BINS[@]}" -gt 0 ]; then
  if [ "${#MAC_BINS[@]}" -eq 2 ] && command -v lipo >/dev/null 2>&1; then
    lipo -create -output "$MCPB_SERVER/titer-stdio-bridge" "${MAC_BINS[@]}"
    echo "staged: mcpb/server/titer-stdio-bridge (universal, lipo)"
  else
    cp "${MAC_BINS[0]}" "$MCPB_SERVER/titer-stdio-bridge"
    echo "staged: mcpb/server/titer-stdio-bridge (single-arch ${MAC_BINS[0]##*/}; install both mac targets + lipo for a universal bundle)"
  fi
fi

echo "done."
