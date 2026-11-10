#!/usr/bin/env bash
# Build the vendored webR package repo (plan 00, option (b)).
#
# What it does: downloads the pre-built WASM binaries for the pinned package
# set (scripts/webr-repo-manifest.json) + their full hard-dependency closure
# from the webR binary repo, verifies every file's MD5 against the repo's
# PACKAGES index, and writes a trimmed repo into webr-repo/:
#   webr-repo/bin/emscripten/contrib/4.6/<pkg>_<version>.tgz
#   webr-repo/bin/emscripten/contrib/4.6/PACKAGES (+ .gz, trimmed index)
#   webr-repo/bin/emscripten/contrib/4.6/PACKAGES.rds (trimmed index, see below)
#   webr-repo/MANIFEST.json         what was vendored, from where, and when
#
# The contrib/4.6 layout mirrors repo.r-wasm.org exactly: webR's installer
# appends bin/emscripten/contrib/<R-version>/ to whatever repo URL it is
# given, so the bundled repo URL is the directory's own root ("/webr-repo"
# in the app, a localhost URL in tests) — never the contrib dir itself.
#
# Why vendored binaries instead of compiling with rwasm (the plan's literal
# option (b)): Hatch has no Docker, so the rwasm-in-Docker build cannot run
# here — and the files on repo.r-wasm.org ARE the rwasm-built binaries for
# this webR/R release (same bytes, same MD5s). Vendoring them is the same
# shipped artifact without the compile step. The script fails loudly if a
# pinned version is no longer in the index, so versions can never drift
# silently; a webR upgrade means a new manifest + a rebuild (see plan 00
# rule 10). Re-run anytime to refresh; downloads are skipped when the file
# on disk already matches its MD5.
#
# Usage: ./scripts/build-webr-repo.sh
# Needs: curl, python3, gzip, md5sum (Linux) or md5 (macOS).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
MANIFEST_JSON="$ROOT/scripts/webr-repo-manifest.json"
OUT="$ROOT/webr-repo"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

R_VERSION="$(python3 -c "import json;print(json.load(open('$MANIFEST_JSON'))['r'])")"
# The repo layout uses major.minor (4.6), not the full R version (4.6.0).
R_MAJOR_MINOR="${R_VERSION%.*}"
REPO_URL="$(python3 -c "import json;print(json.load(open('$MANIFEST_JSON'))['repo'])")"
echo "repo: $REPO_URL (R $R_VERSION)"

mkdir -p "$OUT"
CONTRIB="$OUT/bin/emscripten/contrib/$R_MAJOR_MINOR"
mkdir -p "$CONTRIB"
curl -fsSL "$REPO_URL/PACKAGES" -o "$TMP/PACKAGES.full"
echo "index: $(wc -c < "$TMP/PACKAGES.full") bytes"

# Resolve the closure, download + verify each file, write the trimmed index
# and MANIFEST.json. The Python step is the whole index operation: DCF
# parsing, closure over Depends/Imports/LinkingTo (base R packages excluded
# — they ship inside R.wasm), MD5 verification, trimmed PACKAGES.
python3 - "$MANIFEST_JSON" "$TMP/PACKAGES.full" "$REPO_URL" "$CONTRIB" "$OUT" <<'PYEOF'
import gzip, hashlib, json, os, re, subprocess, sys, urllib.request

manifest_path, index_path, repo_url, out_dir, repo_root = sys.argv[1:6]
manifest = json.load(open(manifest_path))
pinned = {p["name"]: p["version"] for p in manifest["packages"]}

# --- Parse the DCF index (continuation lines start with a space). ---
pkgs, order = {}, []
cur = key = None
for line in open(index_path, encoding="utf-8", errors="replace"):
    line = line.rstrip("\n")
    if line == "":
        cur = key = None
        continue
    if line.startswith(" ") and cur and key:
        pkgs[cur][key] += " " + line.strip()
        continue
    m = re.match(r"^([A-Za-z0-9]+):\s*(.*)$", line)
    if m:
        key, val = m.group(1), m.group(2)
        if key == "Package":
            cur = val
            pkgs[cur] = {}
            order.append(cur)
        elif cur:
            pkgs[cur][key] = val

BASE = {"base", "compiler", "datasets", "graphics", "grDevices", "grid",
        "methods", "parallel", "splines", "stats", "stats4", "tcltk",
        "tools", "utils"}  # ship inside R.wasm — verified against
        # rownames(installed.packages(priority="base")) in webR 0.6.0.
        # NOTE: codetools is NOT in webR's base library (verified 2026-11-10)
        # even though base R ships it — it is a *recommended* package that
        # webR leaves out, so it must be vendored like any CRAN package
        # (multcomp Imports it; without it multcomp cannot load).

def deps(field):
    out = []
    for part in (field or "").split(","):
        m = re.match(r"^([A-Za-z0-9.]+)", part.strip())
        if m and m.group(1) != "R":
            out.append(m.group(1))
    return out

# --- Pinned versions must exist in the index, exactly. ---
for name, version in pinned.items():
    entry = pkgs.get(name)
    if entry is None:
        sys.exit(f"FAIL: pinned package {name} is not in the {manifest['r']} index")
    if entry["Version"] != version:
        sys.exit(f"FAIL: pinned {name} {version} but index has {entry['Version']} — update the manifest, do not drift")

# --- Full hard-dependency closure. ---
closure = set(pinned)
work = list(pinned)
while work:
    name = work.pop()
    for d in deps(pkgs[name].get("Depends")) + deps(pkgs[name].get("Imports")) + deps(pkgs[name].get("LinkingTo")):
        if d in BASE or d in closure:
            continue
        if d not in pkgs:
            sys.exit(f"FAIL: dependency {d} of {name} is not in the index")
        closure.add(d)
        work.append(d)

def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

# --- Download (skip when the file on disk already matches) + verify. ---
total = 0
entries = []
for name in sorted(closure):
    entry = pkgs[name]
    filename = entry["File"]
    dest = os.path.join(out_dir, filename)
    want = entry["MD5sum"]
    if os.path.exists(dest) and md5_of(dest) == want:
        print(f"  cached {filename}")
    else:
        print(f"  fetch  {filename}")
        urllib.request.urlretrieve(f"{repo_url}/{filename}", dest)
        got = md5_of(dest)
        if got != want:
            os.remove(dest)
            sys.exit(f"FAIL: MD5 mismatch for {filename}: got {got}, index says {want}")
    total += os.path.getsize(dest)
    entries.append({"name": name, "version": entry["Version"], "file": filename,
                    "md5": want, "license": entry.get("License", ""),
                    "size": os.path.getsize(dest)})

# --- Trimmed PACKAGES: the raw index blocks for the closure packages only. ---
raw = open(index_path, encoding="utf-8", errors="replace").read()
blocks = []
for name in sorted(closure):
    m = re.search(rf"^Package: {re.escape(name)}\n(?:.*\n)*?\n", raw, re.M)
    if not m:
        sys.exit(f"FAIL: could not extract index block for {name}")
    blocks.append(m.group(0))
trimmed = "".join(blocks)
with open(os.path.join(out_dir, "PACKAGES"), "w", encoding="utf-8") as f:
    f.write(trimmed)
with gzip.open(os.path.join(out_dir, "PACKAGES.gz"), "wt", encoding="utf-8") as f:
    f.write(trimmed)

with open(os.path.join(repo_root, "MANIFEST.json"), "w", encoding="utf-8") as f:
    import datetime
    json.dump({"webr": manifest["webr"], "r": manifest["r"], "repo": repo_url,
               "built": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "pinned": sorted(pinned), "packages": entries,
               "totalBytes": total}, f, indent=1)
    f.write("\n")
print(f"closure: {len(closure)} packages, {total / 1048576:.1f} MB")
PYEOF

echo "repo written to $OUT"
ls "$OUT" | head -5
echo "... ($(ls "$OUT" | wc -l) files)"

# PACKAGES.rds: R's available.packages() (used by webr::install) tries
# PACKAGES.rds first and only falls back to PACKAGES.gz when the fetch
# fails, so a repo without it wastes a failed fetch — plus a warning — on
# the first install of every session. The upstream repo ships a PACKAGES.rds
# but it indexes the whole repo (~20k packages); ours must index exactly the
# vendored closure, so scripts/build-webr-repo-rds.mjs generates it from the
# .tgz files with tools::write_PACKAGES (run in webR — Hatch has no desktop
# R) and verifies it round-trips. Needs node + the repo's node_modules.
node "$ROOT/scripts/build-webr-repo-rds.mjs" "$CONTRIB"
