// Workflows (v3, Phase 3) — the saved, reusable pipeline: import → clean →
// analyze → graph → export, replayed on matching data in one click.
//
// A workflow is a RECIPE, not a macro of clicks and not a carrier of data:
// each step is one of the app's own operations (the runners in stats/, the
// graph builders in views/graphs/, the project store), parameterized and
// saved. A step binds to data BY STRUCTURE AND ROLE ("the dose column",
// "the response column", "the Control group") — never by cell address —
// so the same recipe replays on a new file with the same shape.
//
// What this module is NOT (roadmap §4a, Smit's correction Nov 13 ~10:10 PT):
// adaptive replay is explicitly OUT of scope. There is no fuzzy matching,
// no header synonyms, no unit conversion, no learned mappings, no
// guess-vs-ask. A binding that does not match EXACTLY fails the step
// clearly (see run.ts) — nothing fails silently. Scheduled runs are Phase 5,
// not a v3 promise (a desktop app has to be running); this schema has no
// schedule field, and validate.ts rejects one.
//
// The engine is host-agnostic: runWorkflow() drives a WorkflowHost (run.ts),
// which the app's project store implements. The MCP layer will call
// run_workflow / draft_workflow against this engine later (Phase 3 agent
// tools) — this lane builds the engine only, no MCP tools.

import type { AnalysisParams, AnalysisType } from "../stats/types";
import type { GraphOptions, GraphType, Resolution, TableData, TableType } from "../store/types";

/** The workflow file format: JSON, one workflow per file. */
export const WORKFLOW_FILE_KIND = "titer-workflow" as const;
export const WORKFLOW_FILE_VERSION = 1;
export const WORKFLOW_FILE_EXTENSION = ".titer-workflow";

export interface WorkflowFile {
  kind: typeof WORKFLOW_FILE_KIND;
  version: number;
  workflow: Workflow;
}

/**
 * How a step names the data it runs on — by structure and role, not by cell
 * address. Names are matched EXACTLY against the replay table: a column or
 * group that is named differently does not match, and the step fails clearly
 * instead of guessing. (Header synonyms and unit conversion belong to the
 * future adaptive-replay idea, §4a — not this engine.)
 */
export type ColumnBinding =
  /** The table's X column (XY / Survival: its first data column). */
  | { role: "x" }
  /** The nth Y series of an XY table (0-based, in table order). */
  | { role: "y"; index: number }
  /** A data set with this exact name (a column, or a grouped table's group). */
  | { role: "set"; name: string }
  /** A column with this exact name. */
  | { role: "column"; name: string }
  /** A grouped table's group with this exact name. */
  | { role: "group"; name: string }
  /** Every column holding numbers (only where a list of names is expected). */
  | { role: "all-numeric" };

/**
 * An analysis step's data bindings, keyed by the param field they fill —
 * the same fields runAnalysis() checks for named columns (stats/index.ts).
 * A field with no binding keeps its recorded literal value (thresholds and
 * model choices are parameters, not data bindings, and replay verbatim).
 */
export interface ParamBindings {
  sets?: ColumnBinding[];
  y?: ColumnBinding | ColumnBinding[];
  ys?: ColumnBinding[];
  y2?: ColumnBinding;
  dependent?: ColumnBinding;
  reference?: ColumnBinding;
  control?: ColumnBinding;
  compareWith?: ColumnBinding;
  predictors?: ColumnBinding[];
  datasets?: ColumnBinding[];
  time?: ColumnBinding;
  status?: ColumnBinding;
  covariates?: ColumnBinding[];
  stratifyBy?: ColumnBinding;
}

/**
 * Which table a step reads. A table in a workflow always comes from an
 * import step (which created it from a run input) or is a run input used
 * directly; a clean step updates its table in place, so the reference stays
 * stable across the run.
 */
export type TableRef =
  | { source: "import-step"; stepId: string }
  /** A run input used directly, without an import step. The runner creates
   *  the table node from it on first use, with this table type. */
  | { source: "run-input"; index: number; tableType: TableType };

/** A workflow step's id — unique within its workflow. */
export type StepId = string;

export interface ImportStep {
  kind: "import";
  id: StepId;
  /** The table the run input becomes. */
  tableType: TableType;
  /** Where the input came from when it was recorded (provenance only —
   *  replay always uses the run's input data, never this file). */
  sourceName?: string;
  /** The shape the input had when recorded (column count, for a clear
   *  mismatch message at replay — not a binding). */
  expectedShape?: { columns: number; rows?: number };
  note?: string;
}

/** One cleaning operation on a table (pure TableData transforms, run.ts). */
export type CleanOp =
  /** Drop rows whose data cells are all blank. */
  | { op: "drop-empty-rows" }
  /** Mark non-numeric data cells excluded, so analyses and graphs skip them
   *  (the values stay in the table, as the store's excluded cells do). */
  | { op: "exclude-non-numeric" };

export interface CleanStep {
  kind: "clean";
  id: StepId;
  table: TableRef;
  ops: CleanOp[];
  note?: string;
}

export interface AnalyzeStep {
  kind: "analyze";
  id: StepId;
  table: TableRef;
  analysisType: AnalysisType;
  /** The params as recorded; `bindings` (when present) re-resolve the
   *  data-naming fields against the replay table. */
  params: AnalysisParams;
  bindings?: ParamBindings;
  /** What the created analysis node is called (defaults to the test's name). */
  name?: string;
  note?: string;
}

/** A graph option that points at a sibling analysis node — the fields the
 *  graph modules read to draw overlays (see store/types.ts GraphOptions). */
export type GraphLinkField =
  | "regAnalysisId"
  | "demingAnalysisId"
  | "coxAnalysisId"
  | "poissonAnalysisId"
  | "pcaAnalysisId"
  | "kmeansAnalysisId"
  | "smoothAnalysisId"
  | "monteCarloAnalysisId"
  | "sigAnalysisId";

export const GRAPH_LINK_FIELDS: GraphLinkField[] = [
  "regAnalysisId",
  "demingAnalysisId",
  "coxAnalysisId",
  "poissonAnalysisId",
  "pcaAnalysisId",
  "kmeansAnalysisId",
  "smoothAnalysisId",
  "monteCarloAnalysisId",
  "sigAnalysisId",
];

export interface GraphStep {
  kind: "graph";
  id: StepId;
  table: TableRef;
  graphType: GraphType;
  /** The graph's display options as recorded. Any `*AnalysisId` field named
   *  in `links` is overwritten at replay with the created node's id. */
  options: GraphOptions;
  /** Which analyze step each linked analysis option comes from. */
  links?: Partial<Record<GraphLinkField, StepId>>;
  note?: string;
}

export interface FigureStep {
  kind: "figure";
  id: StepId;
  /** The graph steps composed into the figure, in panel order. */
  graphSteps: StepId[];
  title?: string;
  dpi?: Resolution;
  note?: string;
}

export type ExportFormat = "png" | "jpeg" | "svg";

export interface ExportStep {
  kind: "export";
  id: StepId;
  /** The graph or figure step whose node is exported. */
  targetStep: StepId;
  format: ExportFormat;
  dpi: Resolution;
  fileName?: string;
  note?: string;
}

/**
 * A branch condition, evaluated against steps that already ran. `thenSteps`
 * run when it holds, `elseSteps` when it does not; steps named by neither
 * run unconditionally. A condition that cannot be evaluated (its step
 * failed, or the result holds no P value) fails the branch step clearly —
 * the gated steps are reported not-run, never silently skipped or run.
 */
export type BranchCondition =
  | { kind: "step-succeeded"; step: StepId }
  | { kind: "step-failed"; step: StepId }
  | { kind: "analysis-p-below"; step: StepId; threshold: number }
  | { kind: "analysis-p-above"; step: StepId; threshold: number };

export interface BranchStep {
  kind: "branch";
  id: StepId;
  condition: BranchCondition;
  /** Steps (later in the workflow) that run when the condition holds. */
  thenSteps: StepId[];
  /** Steps (later in the workflow) that run when it does not. */
  elseSteps?: StepId[];
  note?: string;
}

export type WorkflowStep = ImportStep | CleanStep | AnalyzeStep | GraphStep | FigureStep | ExportStep | BranchStep;

/** When a saved workflow runs by itself, without a click. */
export interface WorkflowTrigger {
  /** Run when a file of this shape is imported. No other trigger exists in
   *  v3: scheduled runs are Phase 5 (roadmap §4a). */
  onImport?: {
    tableType?: TableType;
    minColumns?: number;
    minRows?: number;
    /** The first data column must hold numbers (an XY / Survival X). */
    requiresX?: boolean;
  };
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  /**
   * True when the workflow is an ILLUSTRATIVE example from the roadmap, not
   * a routine verified against a real lab (roadmap §4a, open verification
   * item 6). Never set on a workflow a researcher recorded from real work.
   */
  illustrative?: boolean;
  triggers?: WorkflowTrigger;
  steps: WorkflowStep[];
}

/** One step's outcome in a run report. */
export type StepStatus = "succeeded" | "failed" | "skipped" | "not-run";

export interface StepReport {
  stepId: string;
  kind: WorkflowStep["kind"];
  status: StepStatus;
  /** The project node the step created, when it created one. */
  nodeId?: string;
  /** What happened, in the researcher's words — a failure names the step,
   *  the binding or the operation, and what was missing. */
  message: string;
}

/** An export the run asked the host to write (the host performs the file
 *  write — rasterizing a graph needs the drawn view, which lives outside
 *  this engine — and reports the path back). */
export interface ExportRequest {
  nodeId: string;
  nodeName: string;
  format: ExportFormat;
  dpi: Resolution;
  fileName: string;
  /** Where the host wrote it, when it did. */
  path?: string;
}

export type RunStatus = "succeeded" | "failed" | "completed-with-failures";

export interface WorkflowRunReport {
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  steps: StepReport[];
  exports: ExportRequest[];
  /** Visible flags on the finished run — failed bindings, unevaluated
   *  branches, skipped steps — so nothing about a run is silent. */
  flags: string[];
}

/** The seven table types a workflow step may import (store/types.ts). */
export const WORKFLOW_TABLE_TYPES: TableType[] = [
  "column",
  "xy",
  "grouped",
  "nested",
  "multiple",
  "contingency",
  "survival",
];

/** A run input: a table's data. Its table type comes from the import step
 *  that consumes it — the data itself carries none (see store/types.ts). */
export type WorkflowInput = TableData;
