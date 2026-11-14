#!/usr/bin/env bash
# Pack the Titer .mcpb (MCP Bundle) for Claude Desktop: a zip of manifest.json
# + the titer-stdio-bridge binaries + icon.png.
#
# Usage:
#   ./scripts/pack-mcpb.sh [output.mcpb]     # default: ./titer.mcpb
#
# Prerequisites (built by ./scripts/build-stdio-bridge.sh --mcpb):
#   src-tauri/binaries/titer-stdio-bridge-aarch64-apple-darwin
#   src-tauri/binaries/titer-stdio-bridge-x86_64-apple-darwin   (lipo'd to universal)
#   src-tauri/binaries/titer-stdio-bridge-x86_64-pc-windows-msvc.exe
# The script stages those into mcpb/server/ and copies the app icon.
#
# Packing prefers the official CLI (@anthropic-ai/mcpb: `mcpb pack`), which
# validates the manifest. If it is not installed, the script falls back to a
# plain zip after validating the manifest with Python — and says so loudly,
# because an unvalidated bundle is a guess, not a proof.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/titer.mcpb}"
SERVER_DIR="$ROOT/mcpb/server"
BIN_DIR="$ROOT/src-tauri/binaries"

need() {
  if [ ! -f "$1" ]; then
    echo "!! missing: $1" >&2
    echo "   run ./scripts/build-stdio-bridge.sh --mcpb first" >&2
    exit 1
  fi
}

need "$BIN_DIR/titer-stdio-bridge-aarch64-apple-darwin"
need "$BIN_DIR/titer-stdio-bridge-x86_64-apple-darwin"
need "$BIN_DIR/titer-stdio-bridge-x86_64-pc-windows-msvc.exe"

mkdir -p "$SERVER_DIR"
if command -v lipo >/dev/null 2>&1; then
  lipo -create -output "$SERVER_DIR/titer-stdio-bridge" \
    "$BIN_DIR/titer-stdio-bridge-aarch64-apple-darwin" \
    "$BIN_DIR/titer-stdio-bridge-x86_64-apple-darwin"
  echo "macOS bridge: universal binary (lipo)"
else
  cp "$BIN_DIR/titer-stdio-bridge-aarch64-apple-darwin" "$SERVER_DIR/titer-stdio-bridge"
  echo "!! lipo not found — bundled macOS bridge is arm64-only" >&2
fi
cp "$BIN_DIR/titer-stdio-bridge-x86_64-pc-windows-msvc.exe" "$SERVER_DIR/titer-stdio-bridge.exe"
cp "$ROOT/src-tauri/icons/icon.png" "$ROOT/mcpb/icon.png"
chmod +x "$SERVER_DIR/titer-stdio-bridge" "$SERVER_DIR/titer-stdio-bridge.exe"

# Validate the manifest before packing (required fields per MCPB spec 0.3).
python3 - "$ROOT/mcpb/manifest.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    m = json.load(f)
for field in ("manifest_version", "name", "version", "description", "author", "server"):
    assert field in m, f"manifest.json missing required field: {field}"
assert m["server"]["type"] == "binary", "Titer ships a compiled bridge binary"
assert "entry_point" in m["server"], "manifest.json server.entry_point missing"
print(f"manifest ok: {m['name']} {m['version']} (manifest_version {m['manifest_version']})")
PY

cd "$ROOT/mcpb"
if command -v mcpb >/dev/null 2>&1; then
  echo "validating manifest with official @anthropic-ai/mcpb CLI..."
  mcpb validate manifest.json
  echo "packing with official @anthropic-ai/mcpb CLI..."
  mcpb pack . "$OUT"
  echo "bundle info:"
  mcpb info "$OUT" || true
else
  echo "!! 'mcpb' CLI not found (npm install -g @anthropic-ai/mcpb) — falling back to plain zip." >&2
  echo "   Manifest JSON was validated above, but the bundle was NOT validated by the official packer." >&2
  python3 - "$OUT" <<'PY'
import sys, zipfile
from pathlib import Path
out = Path(sys.argv[1])
root = Path(".")
ignore = set()
if (root / ".mcpbignore").exists():
    ignore = {l.strip() for l in (root / ".mcpbignore").read_text().splitlines() if l.strip() and not l.startswith("#")}
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for p in sorted(root.rglob("*")):
        if p.is_dir() or p.name in ignore or p == out:
            continue
        z.write(p, p.relative_to(root))
print(f"packed (zip fallback): {out}")
PY
fi

echo "output: $OUT"
ls -la "$OUT"
