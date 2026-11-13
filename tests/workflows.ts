// Workflows engine checks — standalone, NOT wired into `npm test`.
// Run after v1 clears: `node --import tsx tests/workflows.ts`
// (kept out of the suite on purpose: this lane runs `npm run check` only
// while v1 owns the box).
//
// Exercises the engine with an in-memory host (no WebR, no UI): binding,
// validation, recording, branching, failure flags, triggers, sharing
// round-trip, and the ELISA-day example.

import {
  ELISA_DAY_WORKFLOW,
  ELISA_EXAMPLE_TABLE,
  applyCleanOps,
  deriveBindings,
  extractPValues,
  matchesOnImport,
  parseWorkflowFile,
  runWorkflow,
  serializeWorkflow,
  validateWorkflow,
  type ExportRequest,
  type Workflow,
  type WorkflowHost,
} from "../src/workflows";
import { DEFAULT_GRAPH_OPTIONS } from "../src/store/types";
import type { AnalysisOutcome } from "../src/stats/types";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** An in-memory host: nodes are plain records, analyses return canned outcomes. */
function memoryHost(outcomes: Record<string, AnalysisOutcome>): WorkflowHost & { created: string[] } {
  let n = 0;
  const created: string[] = [];
  const node = (prefix: string) => {
    const nodeId = `${prefix}_${++n}`;
    created.push(nodeId);
    return nodeId;
  };
  return {
    created,
    createTable: async (tableType, _data, name) => ({
      nodeId: node(`${tableType}`),
      name: name ?? `${tableType} table`,
    }),
    updateTable: async () => {},
    createAnalysis: async (_tableNodeId, analysisType, _params, name) => ({
      nodeId: node("analysis"),
      name: name ?? analysisType,
      outcome: outcomes[analysisType] ?? { error: `no canned outcome for ${analysisType}` },
    }),
    createGraph: async (_tableNodeId, graphType) => ({ nodeId: node("graph"), name: graphType }),
    createFigure: async (graphNodeIds, opts) => ({
      nodeId: node("figure"),
      name: opts.title ?? `Figure (${graphNodeIds.length} panels)`,
    }),
    exportFile: async (req: ExportRequest) => ({ path: `/tmp/${req.fileName}` }),
  };
}

const pValueOutcome = (p: number): AnalysisOutcome => ({
  testType: "compare-two-groups",
  stats: [{ label: "P value", value: p, p: true }],
  groups: [],
  notes: "",
});

const workflow: Workflow = {
  id: "test-elisa",
  name: "Test ELISA",
  steps: [
    { kind: "import", id: "s1", tableType: "xy", sourceName: "plate.csv" },
    { kind: "clean", id: "s2", table: { source: "import-step", stepId: "s1" }, ops: [{ op: "drop-empty-rows" }] },
    {
      kind: "analyze",
      id: "s3",
      table: { source: "import-step", stepId: "s1" },
      analysisType: "nonlinear-regression",
      params: { y: "Std", model: "sigmoidal-4pl-logx", interpolate: true },
      bindings: { y: { role: "y", index: 0 } },
    },
    {
      kind: "analyze",
      id: "s4",
      table: { source: "import-step", stepId: "s1" },
      analysisType: "compare-two-groups",
      params: {
        sets: ["Unknown A", "Unknown B"],
        paired: false,
        gaussian: true,
        equalVariance: false,
        ratio: false,
        tails: "two-sided",
      },
      bindings: {
        sets: [
          { role: "set", name: "Unknown A" },
          { role: "set", name: "Unknown B" },
        ],
      },
    },
    {
      kind: "graph",
      id: "s5",
      table: { source: "import-step", stepId: "s1" },
      graphType: "logistic-curve",
      options: DEFAULT_GRAPH_OPTIONS,
      links: { regAnalysisId: "s3" },
    },
    {
      kind: "branch",
      id: "s6",
      condition: { kind: "analysis-p-below", step: "s4", threshold: 0.05 },
      thenSteps: ["s7"],
    },
    {
      kind: "graph",
      id: "s7",
      table: { source: "import-step", stepId: "s1" },
      graphType: "xy-bar",
      options: DEFAULT_GRAPH_OPTIONS,
    },
    { kind: "figure", id: "s8", graphSteps: ["s5"], title: "ELISA day", dpi: "600" },
    { kind: "export", id: "s9", targetStep: "s8", format: "png", dpi: "600", fileName: "elisa-day.png" },
  ],
};

async function main(): Promise<void> {
  // Validation: the hand-built workflow is clean; the guards fire.
  check("workflow validates", validateWorkflow(workflow).length === 0);
  check(
    "schedule trigger rejected",
    validateWorkflow({ ...workflow, triggers: { schedule: "weekly" } }).some((i) => i.path.includes("schedule")),
  );
  check(
    "adaptive field rejected",
    validateWorkflow({
      ...workflow,
      steps: [{ ...workflow.steps[2], bindings: { y: { role: "y", index: 0 }, synonyms: {} } }],
    }).some((i) => i.message.includes("adaptive replay")),
  );
  check(
    "dangling graph link rejected",
    validateWorkflow({
      ...workflow,
      steps: workflow.steps.map((s) => (s.id === "s5" ? { ...s, links: { regAnalysisId: "nope" } } : s)),
    }).length > 0,
  );

  // Bindings: derive from the recorded params, resolve on the example table.
  const bindings = deriveBindings(
    { y: "Std", model: "sigmoidal-4pl-logx", interpolate: true },
    ELISA_EXAMPLE_TABLE,
    "xy",
  );
  check(
    "deriveBindings finds the first Y series",
    JSON.stringify(bindings.y) === JSON.stringify({ role: "y", index: 0 }),
  );

  // Clean ops are pure.
  const cleaned = applyCleanOps(ELISA_EXAMPLE_TABLE, [{ op: "drop-empty-rows" }]);
  check("drop-empty-rows drops the blank row", cleaned.rows.length === ELISA_EXAMPLE_TABLE.rows.length - 1);
  check("clean is a no-op when nothing matches", applyCleanOps(cleaned, [{ op: "drop-empty-rows" }]) === cleaned);

  // P-value extraction for branching.
  check("extractPValues reads flagged stat rows", JSON.stringify(extractPValues(pValueOutcome(0.01))) === "[0.01]");

  // Run, significant: the gated bar graph runs, the figure exports.
  const host = memoryHost({
    "nonlinear-regression": { testType: "nonlinear-regression", stats: [], groups: [], notes: "" },
    "compare-two-groups": pValueOutcome(0.01),
  });
  const report = await runWorkflow(workflow, host, { inputs: [ELISA_EXAMPLE_TABLE] });
  check("significant run succeeds", report.status === "succeeded", JSON.stringify(report.flags));
  check("gated graph ran when p < 0.05", report.steps.find((s) => s.stepId === "s7")?.status === "succeeded");
  check("export recorded with path", report.exports.length === 1 && report.exports[0].path === "/tmp/elisa-day.png");

  // Run, not significant: the gated graph is skipped, the rest still succeeds.
  const host2 = memoryHost({
    "nonlinear-regression": { testType: "nonlinear-regression", stats: [], groups: [], notes: "" },
    "compare-two-groups": pValueOutcome(0.4),
  });
  const report2 = await runWorkflow(workflow, host2, { inputs: [ELISA_EXAMPLE_TABLE] });
  check("non-significant run still succeeds", report2.status === "succeeded", JSON.stringify(report2.flags));
  check("gated graph skipped when p >= 0.05", report2.steps.find((s) => s.stepId === "s7")?.status === "skipped");
  check(
    "figure still built without the gated graph",
    report2.steps.find((s) => s.stepId === "s8")?.status === "succeeded",
  );

  // Run, unbindable data: the analyze step fails clearly, dependents are
  // not-run, and nothing is silent.
  const wrongTable = {
    columns: ["Title", "Dose"],
    rows: [["r1", "1"]],
  };
  const report3 = await runWorkflow(workflow, memoryHost({}), { inputs: [wrongTable] });
  check("wrong-shape input fails the import", report3.steps.find((s) => s.stepId === "s1")?.status === "failed");
  check(
    "dependents are not-run, not silently skipped",
    report3.steps.find((s) => s.stepId === "s3")?.status === "not-run",
  );
  check("failure is flagged", report3.flags.length > 0);
  check("run with failures reports them", report3.status === "failed" || report3.status === "completed-with-failures");

  // Sharing round-trip + the ELISA example.
  const file = serializeWorkflow(ELISA_DAY_WORKFLOW);
  const parsed = parseWorkflowFile(file);
  check("example serializes and parses", parsed.ok === true);
  if (parsed.ok) {
    check(
      "example validates",
      validateWorkflow(parsed.workflow).length === 0,
      JSON.stringify(validateWorkflow(parsed.workflow)),
    );
    check("example is marked illustrative", parsed.workflow.illustrative === true);
  }
  check("on-import trigger matches the example table", matchesOnImport(ELISA_DAY_WORKFLOW, "xy", ELISA_EXAMPLE_TABLE));
  check(
    "on-import trigger rejects a column table",
    !matchesOnImport(ELISA_DAY_WORKFLOW, "column", ELISA_EXAMPLE_TABLE),
  );
  check("newer version refused", parseWorkflowFile(file.replace('"version": 1', '"version": 99')).ok === false);

  console.log(failures === 0 ? "\nworkflows: all checks passed" : `\nworkflows: ${failures} check(s) FAILED`);
  if (failures) process.exitCode = 1;
}

await main();
