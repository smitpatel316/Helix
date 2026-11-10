// Generate a trimmed PACKAGES.rds for the vendored webR repo.
//
// Why: R's available.packages() (used by webr::install) tries PACKAGES.rds
// first and only falls back to PACKAGES.gz / PACKAGES when the fetch fails —
// so a repo without PACKAGES.rds wastes a failed fetch (and a warning) on
// every first install in a session. The upstream repo ships a PACKAGES.rds,
// but it indexes the whole repo (~20k packages); ours must index exactly the
// vendored closure, so it is generated here from the .tgz files themselves
// with tools::write_PACKAGES — the same tool R's own repos use — which makes
// it self-consistent with the tarballs by construction (MD5sum, File, Built,
// Depends/Imports/LinkingTo all read from each tarball's DESCRIPTION).
//
// This needs webR (node_modules/webr): Hatch has no desktop R, so R itself
// runs in WASM. The .tgz files are copied into webR's in-memory filesystem,
// tools::write_PACKAGES runs there, and only PACKAGES.rds is copied back
// out — the trimmed PACKAGES / PACKAGES.gz stay the build script's, written
// from the upstream index (scripts/build-webr-repo.sh).
//
// Usage: node scripts/build-webr-repo-rds.mjs [contrib-dir]
//   contrib-dir defaults to webr-repo/bin/emscripten/contrib/4.6.
// Exits non-zero (loudly) if webR is not installed, no .tgz files are found,
// write_PACKAGES produces no PACKAGES.rds, or the .rds does not round-trip
// through readRDS with the same packages as the trimmed PACKAGES.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const contribDir = path.resolve(process.argv[2] ?? "webr-repo/bin/emscripten/contrib/4.6");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webrDist = path.join(repoRoot, "node_modules", "webr", "dist") + path.sep;

const tgzs = readdirSync(contribDir)
  .filter((f) => f.endsWith(".tgz"))
  .sort();
if (!tgzs.length) {
  console.error(`FAIL: no .tgz files in ${contribDir} — run scripts/build-webr-repo.sh first`);
  process.exit(1);
}
let webrPkg;
try {
  webrPkg = await import("webr");
} catch {
  console.error("FAIL: the webr npm package is not installed — run npm install first");
  process.exit(1);
}

console.log(`generating PACKAGES.rds for ${tgzs.length} packages in ${contribDir}`);
const webR = new webrPkg.WebR({ baseUrl: webrDist });
await webR.init();
const FS = webR.FS;
FS.mkdir("/repo");
for (const f of tgzs) {
  await FS.writeFile(`/repo/${f}`, new Uint8Array(readFileSync(path.join(contribDir, f))));
}

const shelter = await new webR.Shelter();
try {
  // webR's environment sets TAR=/usr/bin/tar, so untar() shells out to a
  // binary that does not exist under Emscripten — and system() is
  // unsupported in webR, so write_PACKAGES dies reading the first
  // DESCRIPTION. TAR="internal" selects R's pure-R tar reader instead
  // (install.packages already works this way: it passes tar="internal").
  // type="mac.binary" is the .tgz flavour: it is what makes write_PACKAGES
  // look at *.tgz files (type="source" would look for *.tar.gz and find none).
  await shelter.evalR(
    `local({ Sys.setenv(TAR = "internal"); tools::write_PACKAGES("/repo", type = "mac.binary") })`,
  );
  const listed = await shelter.evalR(`list.files("/repo")`);
  const files = (await listed.toJs()).values;
  if (!files.includes("PACKAGES.rds")) {
    console.error(`FAIL: tools::write_PACKAGES wrote ${files.join(", ")} — no PACKAGES.rds`);
    process.exit(1);
  }
  // Round-trip check in R: the .rds must read back as a character matrix
  // (that is the format write_PACKAGES writes — not a data frame) listing
  // exactly the vendored packages, with the same versions, MD5sums and
  // files as the trimmed PACKAGES index on disk.
  const check = await shelter.evalR(`
    local({
      d <- readRDS("/repo/PACKAGES.rds")
      p <- read.dcf("/repo/PACKAGES")
      stopifnot(is.matrix(d), nrow(d) == ${tgzs.length})
      stopifnot(setequal(d[, "Package"], p[, "Package"]))
      stopifnot(setequal(paste(d[, "Package"], d[, "Version"]), paste(p[, "Package"], p[, "Version"])))
      stopifnot(setequal(paste(d[, "Package"], d[, "MD5sum"]), paste(p[, "Package"], p[, "MD5sum"])))
      stopifnot(setequal(paste(d[, "Package"], d[, "File"]), paste(p[, "Package"], p[, "File"])))
      c(n = nrow(d), cols = ncol(d))
    })`);
  const { values } = (await check.toJs());
  console.log(`PACKAGES.rds round-trips: ${values[0]} rows, ${values[1]} columns`);
  const rds = Buffer.from(await FS.readFile("/repo/PACKAGES.rds"));
  writeFileSync(path.join(contribDir, "PACKAGES.rds"), rds);
  console.log(`wrote ${path.join(contribDir, "PACKAGES.rds")} (${(rds.length / 1024).toFixed(1)} KB)`);
  // Report how the generated PACKAGES compares with the trimmed index the
  // build script wrote from the upstream repo — informational only, the
  // trimmed index stays the source of truth and is not overwritten.
  const generated = new TextDecoder().decode(await FS.readFile("/repo/PACKAGES"));
  const trimmed = readFileSync(path.join(contribDir, "PACKAGES"), "utf8");
  console.log(
    generated === trimmed
      ? "generated PACKAGES is byte-identical to the trimmed PACKAGES"
      : `note: generated PACKAGES differs from the trimmed PACKAGES (${generated.length} vs ${trimmed.length} bytes) — trimmed index kept as-is`,
  );
} finally {
  await shelter.purge();
  await webR.close();
}
