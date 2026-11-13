// `.prism` writer tests — plan prism-format-work, regression test C-06
// (round-trip .prism → .hlx → .prism) plus the writer's identity rules.
//
//   C-06  tables cell-identical, analyses present with identical parameters
//   W3    the written file is honestly Titer's: fresh UUIDs, createdBy Titer,
//         no graphs/layouts, no results.json
//   W4    a minimal one-table project writes exactly the required entries
//   W5    a Nested table refuses the whole write, naming the table
//
// `npm test` runs this after tests/prism.ts. The demo file lives in
// tests/testdata/prism/ (a copy of the public prism2R demo — Mansi's files
// are never test material).
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { convertPrism } from "../src/lib/prism";
import { writePrism } from "../src/lib/prism-write";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEMO = join(HERE, "testdata", "prism", "prism2R-demo_dataset.prism");

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail: string) {
  checks++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
}

const input = await readFile(DEMO);
const zip = await JSZip.loadAsync(input);
const { project } = await convertPrism(new Uint8Array(input), "prism2R-demo_dataset.prism");
const tables = project.rootOrder.map((id) => project.nodes[id]);
const analyses = Object.values(project.nodes).filter((n) => n.type === "analysis");

// W1+W2 (C-06): round-trip .prism → .hlx → .prism on the demo file — tables
// cell-identical, analyses present with identical parameters.
{
  const written = await writePrism(project, "1.0.7");
  const back = await convertPrism(written.bytes, "round-trip.prism");
  const backTables = back.project.rootOrder.map((id) => back.project.nodes[id]);
  const tablesIdentical =
    backTables.length === tables.length &&
    backTables.every((t, i) => JSON.stringify(t.data) === JSON.stringify(tables[i].data));
  check("W1 round-trip tables", tablesIdentical, `${backTables.length} tables, cell-identical in order`);
  const backAnalyses = Object.values(back.project.nodes).filter((n) => n.type === "analysis");
  const paramsMatch = (a: (typeof analyses)[number]) => {
    const b = backAnalyses.find((x) => x.name === a.name);
    if (!b || b.analysisType !== a.analysisType) return false;
    return JSON.stringify(b.analysisParams ?? null) === JSON.stringify(a.analysisParams ?? null);
  };
  check(
    "W2 round-trip analyses",
    backAnalyses.length === analyses.length && analyses.every(paramsMatch),
    `${backAnalyses.length} nodes: ${backAnalyses.map((a) => `${a.name} (${a.analysisType})`).join("; ")}`,
  );
  // W3: the written file is honestly Titer's — fresh UUIDs, createdBy Titer,
  // no graphs/layouts, no results.json (Titer stores params, never results).
  const writtenZip = await JSZip.loadAsync(written.bytes);
  const writtenDoc = JSON.parse((await writtenZip.file("document.json")!.async("string")) as string) as {
    createdBy?: { name?: string; version?: string };
    formatVersion?: string;
  };
  const writtenPaths = Object.keys(writtenZip.files);
  const sourceUuids = new Set(
    Object.keys(zip.files)
      .map((p) => /^data\/sheets\/([^/]+)\//.exec(p)?.[1] ?? /^analyses\/([^/]+)\//.exec(p)?.[1])
      .filter((u): u is string => !!u),
  );
  const writtenUuids = new Set(
    writtenPaths
      .map((p) => /^data\/sheets\/([^/]+)\//.exec(p)?.[1] ?? /^analyses\/([^/]+)\//.exec(p)?.[1])
      .filter((u): u is string => !!u),
  );
  const uuidsFresh = [...writtenUuids].every((u) => !sourceUuids.has(u));
  check(
    "W3 written file identity",
    writtenDoc.createdBy?.name === "Titer" &&
      writtenDoc.createdBy?.version === "1.0.7" &&
      writtenDoc.formatVersion === "1-4-1" &&
      uuidsFresh &&
      !writtenPaths.some((p) => p.startsWith("graphs/") || p.startsWith("layouts/")) &&
      !writtenPaths.some((p) => p.endsWith("results.json")),
    `createdBy ${writtenDoc.createdBy?.name} ${writtenDoc.createdBy?.version}, format ${writtenDoc.formatVersion}, ${writtenUuids.size} fresh UUIDs, ${writtenPaths.length} entries`,
  );
  // W4: a minimal one-table project writes exactly the required entries.
  const minimal = await writePrism(
    {
      nodes: {
        table_1: {
          id: "table_1",
          type: "table",
          name: "Minimal",
          parentId: null,
          tableType: "column",
          data: {
            columns: ["Title", "A"],
            rows: [
              [null, "1"],
              [null, "2"],
            ],
          },
        },
      },
      rootOrder: ["table_1"],
      childOrder: { table_1: [] },
      activeNodeId: "table_1",
    },
    "1.0.7",
  );
  const minimalPaths = Object.values((await JSZip.loadAsync(minimal.bytes)).files)
    .filter((f) => !f.dir)
    .map((f) => f.name)
    .sort();
  const minimalOk =
    minimalPaths.filter((p) => p === "document.json").length === 1 &&
    minimalPaths.filter((p) => p.startsWith("data/sheets/")).length === 1 &&
    minimalPaths.filter((p) => p.startsWith("data/tables/")).length === 2 &&
    minimalPaths.filter((p) => p.startsWith("data/sets/")).length === 1 &&
    minimalPaths.length === 5;
  check("W4 minimal file", minimalOk, minimalPaths.join(", "));
  // W5: a Nested table refuses the whole write, naming the table.
  try {
    await writePrism(
      {
        nodes: {
          table_1: {
            id: "table_1",
            type: "table",
            name: "Nested data",
            parentId: null,
            tableType: "nested",
            data: { columns: ["Title", "A"], rows: [[null, "1"]] },
          },
        },
        rootOrder: ["table_1"],
        childOrder: { table_1: [] },
        activeNodeId: "table_1",
      },
      "1.0.7",
    );
    check("W5 nested refusal", false, "wrote without error");
  } catch (err) {
    check(
      "W5 nested refusal",
      err instanceof Error && err.message.includes("Nested data") && err.message.includes("Prism has no matching"),
      err instanceof Error ? err.message.slice(0, 120) : String(err),
    );
  }
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures ? 1 : 0);
