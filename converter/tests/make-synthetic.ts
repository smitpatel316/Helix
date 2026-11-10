// Builds synthetic edge-case .prism files by mutating the public demo file
// (prism2R-demo_dataset.prism, prism2R test data). These are NOT real Prism
// files and were never written by Prism — each one is a single deliberate
// mutation of the demo, labelled `synthetic-`, and exists only to exercise
// converter edge cases. Run them through `npm run verify-corpus` with
// PRISM_TEST_CORPUS_PRISM10 pointing at the output directory.
//
//   npm run make-synthetic
//   PRISM_TEST_CORPUS_PRISM10=~/workspace/helix/test-corpus-synthetic npm run verify-corpus
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";

const HOME = process.env.HOME ?? "";
const DEMO =
  process.env.PRISM_DEMO_PRISM ?? join(HOME, "workspace/helix/test-corpus/prism2R-demo_dataset.prism");
const OUT =
  process.env.PRISM_SYNTHETIC_OUT ?? join(HOME, "workspace/helix/test-corpus-synthetic");

async function loadDemo(): Promise<JSZip> {
  return JSZip.loadAsync(await readFile(DEMO));
}

async function json<T>(zip: JSZip, path: string): Promise<T> {
  const text = await zip.file(path)?.async("string");
  if (text === undefined) throw new Error(`missing ${path} in demo file`);
  return JSON.parse(text) as T;
}

function setJson(zip: JSZip, path: string, value: unknown): void {
  zip.file(path, JSON.stringify(value, null, 2));
}

/** The demo's first data table and its pieces, for mutation. */
async function firstTable(zip: JSZip): Promise<{
  sheetUid: string;
  sheet: { title?: string; table?: { uid?: string; dataSets?: string[] } };
  tableUid: string;
  csv: string;
  content: { numberOfRows: number; numberOfColumns: number };
}> {
  const doc = await json<{ sheets?: { data?: string[] } }>(zip, "document.json");
  const sheetUid = doc.sheets?.data?.[0];
  if (!sheetUid) throw new Error("demo file has no data sheets");
  const sheet = await json<{ title?: string; table?: { uid?: string; dataSets?: string[] } }>(
    zip,
    `data/sheets/${sheetUid}/sheet.json`,
  );
  const tableUid = sheet.table?.uid;
  if (!tableUid) throw new Error("first demo sheet has no table");
  const csv = (await zip.file(`data/tables/${tableUid}/data.csv`)?.async("string")) ?? "";
  const content = await json<{ numberOfRows: number; numberOfColumns: number }>(
    zip,
    `data/tables/${tableUid}/content.json`,
  );
  return { sheetUid, sheet, tableUid, csv, content };
}

async function save(zip: JSZip, name: string): Promise<void> {
  const out = join(OUT, name);
  await writeFile(out, await zip.generateAsync({ type: "nodebuffer" }));
  console.log(`wrote ${out}`);
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  // 1. Empty table: the first table holds 0 rows. The converter must leave
  //    it out with a warning, not crash, and still convert the other 13.
  {
    const zip = await loadDemo();
    const t = await firstTable(zip);
    setJson(zip, `data/tables/${t.tableUid}/content.json`, { ...t.content, numberOfRows: 0 });
    zip.file(`data/tables/${t.tableUid}/data.csv`, "");
    await save(zip, "synthetic-empty-table.prism");
  }

  // 2. CRLF line endings + unicode titles. Values must come through
  //    byte-identical to the demo's; titles must survive the round-trip.
  {
    const zip = await loadDemo();
    const t = await firstTable(zip);
    const lines = t.csv.split("\n").filter((l) => l !== "");
    zip.file(`data/tables/${t.tableUid}/data.csv`, lines.join("\r\n") + "\r\n");
    const sheet = { ...t.sheet, title: "Café — αβγ ☃ dose–response" };
    setJson(zip, `data/sheets/${t.sheetUid}/sheet.json`, sheet);
    const doc = await json<{
      sheetAttributesMap?: Record<string, { title?: string }>;
    }>(zip, "document.json");
    if (doc.sheetAttributesMap?.[t.sheetUid]) {
      doc.sheetAttributesMap[t.sheetUid].title = "Café — αβγ ☃ dose–response";
      setJson(zip, "document.json", doc);
    }
    const firstSet = t.sheet.table?.dataSets?.[0];
    if (firstSet) {
      const set = await json<{ title?: string }>(zip, `data/sets/${firstSet}.json`);
      setJson(zip, `data/sets/${firstSet}.json`, { ...set, title: "Contrôle ☃" });
    }
    await save(zip, "synthetic-crlf-unicode.prism");
  }

  // 3. Missing dataset: one dataset JSON is gone. The converter must warn
  //    and convert the table without that dataset's columns.
  {
    const zip = await loadDemo();
    const t = await firstTable(zip);
    const missing = t.sheet.table?.dataSets?.[1];
    if (!missing) throw new Error("demo first table has no second dataset");
    zip.remove(`data/sets/${missing}.json`);
    await save(zip, "synthetic-missing-dataset.prism");
  }

  // 4. Graphs only: no data sheets at all. The converter must produce an
  //    empty project (0 tables) and report the graphs as not transferred,
  //    not throw.
  {
    const zip = await loadDemo();
    for (const path of Object.keys(zip.files)) {
      if (path.startsWith("data/")) zip.remove(path);
    }
    const doc = await json<{ sheets?: { data?: string[]; analyses?: string[] } }>(zip, "document.json");
    if (doc.sheets) {
      doc.sheets.data = [];
      doc.sheets.analyses = [];
    }
    setJson(zip, "document.json", doc);
    await save(zip, "synthetic-graphs-only.prism");
  }

  // 5. Unknown analysis class: a 4PL fit relabelled SOMETHING_NEW. The
  //    converter must name it as unsupported, never fake a result.
  {
    const zip = await loadDemo();
    const uid = "B54D8CD0-1E73-44AC-AA7B-7890C3A5BFC4";
    const sheet = await json<{ analysisClass?: string }>(zip, `analyses/${uid}/sheet.json`);
    setJson(zip, `analyses/${uid}/sheet.json`, { ...sheet, analysisClass: "SOMETHING_NEW" });
    const params = await json<{ analysisClass?: string }>(zip, `analyses/${uid}/parameters.json`);
    setJson(zip, `analyses/${uid}/parameters.json`, { ...params, analysisClass: "SOMETHING_NEW" });
    await save(zip, "synthetic-unknown-analysis.prism");
  }

  // 6. Comma decimals: every number in the first table written quoted with
  //    a comma decimal separator ("45,5" = 45.5). The converter must turn
  //    them into plain decimals in the .hlx, not keep the comma.
  {
    const zip = await loadDemo();
    const t = await firstTable(zip);
    const rows = t.csv
      .split("\n")
      .filter((l) => l !== "")
      .map((line) =>
        line
          .split(",")
          .map((cell) => (cell === "" ? cell : `"${cell},5"`))
          .join(","),
      );
    zip.file(`data/tables/${t.tableUid}/data.csv`, rows.join("\n") + "\n");
    await save(zip, "synthetic-comma-decimal.prism");
  }
}

await main();
