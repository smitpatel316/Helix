// linux-smoke.ts — headless import smoke test (no GUI, no file picker).
//
// Drives the same parser the GUI import path uses (src/lib/pzfx.ts) over all
// 6 pypzfx fixtures in tests/testdata/, then runs the log-rank survival test
// on the imported survival fixture. This is the fallback when the native
// file-picker dialog cannot be automated headlessly; the GUI path itself is
// verified separately under Xvfb (see DEV-SETUP.md).
//
// Run: node --import tsx tests/linux-smoke.ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parsePzfx } from "../src/lib/pzfx";
import { runAnalysis } from "../src/stats";
import { setPackageRepo, startR } from "../src/stats/webr";

const fixtures = [
  "column",
  "column_sdn",
  "contingency",
  "survival",
  "x_y_rep",
  "x_y_with_strike",
];

// BUG-REPORT #27: runAnalysis needs a booted engine. In Node the eval
// path's startR() defaults to the app's "/webr/", which does not exist
// here, so the survival leg crashed with
// `Cannot find module '/webr/webr-worker.js'`. Boot from the installed
// webR and serve the bundled repo on localhost, exactly as
// tests/checks.ts does. (The listening server needs no close: the
// process.exit() at the end terminates the process.)
const REPO_DIR = fileURLToPath(new URL("../webr-repo/", import.meta.url));
if (existsSync(`${REPO_DIR}MANIFEST.json`)) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url!.split("?")[0]).replace(/^\/+/, "");
    const file = `${REPO_DIR}${path}`;
    if (!path || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  setPackageRepo(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {
    allowCdnFallback: false,
  });
} else {
  console.log("⚠ webr-repo/ is not built — the survival analysis will use the CDN. Run scripts/build-webr-repo.sh first.");
}
await startR(fileURLToPath(new URL("../node_modules/webr/dist/", import.meta.url)));

let failures = 0;
for (const name of fixtures) {
  const text = readFileSync(new URL(`./testdata/${name}.pzfx`, import.meta.url), "utf8");
  const imported = parsePzfx(text);
  const node = imported.project.nodes[imported.project.rootOrder[0]];
  const table = node && node.type === "table" ? node : null;
  const errors = imported.issues.filter((i) => i.severity === "error");
  const status = imported.tables.length === 1 && table && errors.length === 0 ? "OK " : "FAIL";
  if (status === "FAIL") failures++;
  console.log(
    `${status} ${name}.pzfx: tables=${imported.tables.length} type=${table?.tableType ?? "?"} ` +
      `name=${table?.name ?? "?"} cols=[${table?.data?.columns.join(", ") ?? "?"}] ` +
      `rows=${table?.data?.rows.length ?? "?"} issues=${imported.issues.length} errors=${errors.length}`,
  );
  if (name === "survival" && table?.data) {
    const out = await runAnalysis("survival", table.data, { curveTest: "logrank", correction: "holm" });
    console.log(`     survival analysis on imported survival table: ${JSON.stringify(out)}`);
    if ("error" in (out as object)) failures++;
  }
}

console.log(failures === 0 ? "SMOKE: all 6 fixtures parsed, survival analysis ran" : `SMOKE: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
