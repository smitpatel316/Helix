// Record mode — record once from doing the work. The app calls the
// recorder as the researcher works (an import, an analysis, a graph, a
// figure, an export); the recorder turns each action into a workflow step
// whose data bindings are derived from the table it ran on, so the recipe
// replays on matching data instead of on the recorded cells.
//
// Record-first is the roadmap's proposal; how much of a workflow should be
// recordable vs hand-built is Smit's open question Q6 — this module logs
// that, it does not decide it. Hand-building is the editor (editor.ts);
// either path produces the same Workflow value.

import { groupsOf, readTable, splitXY, type Dataset } from "../lib/dataset";
import type { AnalysisParams, AnalysisType } from "../stats/types";
import {
  hasXColumn,
  type GraphOptions,
  type GraphType,
  type Resolution,
  type TableData,
  type TableType,
} from "../store/types";
import {
  GRAPH_LINK_FIELDS,
  type ColumnBinding,
  type GraphLinkField,
  type ParamBindings,
  type TableRef,
  type Workflow,
  type WorkflowStep,
  type WorkflowTrigger,
  type CleanOp,
  type BranchCondition,
} from "./types";

/** The param fields that name data (stats/index.ts checks the same list). */
const NAMED_FIELDS = [
  "sets",
  "y",
  "ys",
  "y2",
  "dependent",
  "reference",
  "control",
  "compareWith",
  "predictors",
  "datasets",
  "time",
  "status",
  "covariates",
  "stratifyBy",
] as const;

/**
 * Turn recorded concrete params into role bindings against the table they
 * ran on. A name that is the table's X becomes the "x" role; a Y series
 * becomes "y" by position; a data-set name stays a "set" binding (group
 * names are structure); anything else stays a "column" binding by exact
 * name. Values that are not data names (thresholds, model choices) are
 * never bindings — they replay verbatim.
 */
export function deriveBindings(params: AnalysisParams, data: TableData, tableType: TableType): ParamBindings {
  const dataset: Dataset = readTable(data);
  const { ys } = splitXY(dataset.columns);
  // Only XY / Survival tables have an X column — on other tables the first
  // column is a data series, not X, so it must not become an "x" binding.
  const xName = hasXColumn(tableType) ? dataset.columns[0]?.name : undefined;
  const bindings: ParamBindings = {};
  const record = params as unknown as Record<string, unknown>;

  const toBinding = (name: string): ColumnBinding => {
    if (name === xName) return { role: "x" };
    const yIndex = ys.findIndex((c) => c.name === name);
    if (yIndex !== -1) return { role: "y", index: yIndex };
    if (dataset.sets.some((s) => s.name === name)) return { role: "set", name };
    if (groupsOf(dataset.columns).some((g) => g.name === name)) return { role: "group", name };
    return { role: "column", name };
  };

  for (const field of NAMED_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const list = (value as unknown[]).filter((v): v is string => typeof v === "string");
      if (list.length) (bindings as Record<string, ColumnBinding[]>)[field] = list.map(toBinding);
    } else if (typeof value === "string") {
      (bindings as Record<string, ColumnBinding>)[field] = toBinding(value);
    }
  }
  return bindings;
}

/**
 * Records a workflow as the researcher does the work. Each record method
 * returns the new step's id, so later calls can point at it (a graph's
 * table, a figure's graphs, an export's target, a branch's gated steps).
 * Nothing here touches the UI or the store — the app calls these methods
 * from its own actions, and the workflow is data until it is run.
 */
export class WorkflowRecorder {
  private steps: WorkflowStep[] = [];
  private nextStep = 0;

  private stepId(): string {
    return `step-${++this.nextStep}`;
  }

  /**
   * Reserve the next step id without recording a step yet — for a branch
   * that gates a step recorded after it (a branch can only gate later
   * steps, so its then/else ids must exist before the gated steps do).
   * Pass the reserved id to the record call that creates the step.
   */
  reserveId(): string {
    return this.stepId();
  }

  /** The table this workflow starts from. Returns the import step's id. */
  recordImport(tableType: TableType, data: TableData, sourceName?: string): string {
    const id = this.stepId();
    this.steps.push({
      kind: "import",
      id,
      tableType,
      sourceName,
      expectedShape: { columns: data.columns.length - 1, rows: data.rows.length },
    });
    return id;
  }

  /** A cleaning pass on a table from an earlier import step. */
  recordClean(importStepId: string, ops: CleanOp[]): string {
    const id = this.stepId();
    const table: TableRef = { source: "import-step", stepId: importStepId };
    this.steps.push({ kind: "clean", id, table, ops });
    return id;
  }

  /** An analysis on a table from an earlier import step. */
  recordAnalysis(
    importStepId: string,
    analysisType: AnalysisType,
    params: AnalysisParams,
    data: TableData,
    tableType: TableType,
    name?: string,
  ): string {
    const id = this.stepId();
    const table: TableRef = { source: "import-step", stepId: importStepId };
    const bindings = deriveBindings(params, data, tableType);
    this.steps.push({
      kind: "analyze",
      id,
      table,
      analysisType,
      params,
      ...(Object.keys(bindings).length ? { bindings } : {}),
      ...(name ? { name } : {}),
    });
    return id;
  }

  /**
   * A graph on a table from an earlier import step. `links` names the
   * analyze step each overlay option comes from; the recorded option values
   * for those fields are dropped (they held the old node's id, which does
   * not exist on replay — the runner fills in the new node's id).
   */
  recordGraph(
    importStepId: string,
    graphType: GraphType,
    options: GraphOptions,
    links?: Partial<Record<GraphLinkField, string>>,
    id: string = this.stepId(),
  ): string {
    const table: TableRef = { source: "import-step", stepId: importStepId };
    const stored = { ...options };
    if (links) for (const field of GRAPH_LINK_FIELDS) if (links[field]) delete stored[field];
    this.steps.push({
      kind: "graph",
      id,
      table,
      graphType,
      options: stored,
      ...(links ? { links } : {}),
    });
    return id;
  }

  /** A multi-panel figure from earlier graph steps. */
  recordFigure(graphStepIds: string[], opts?: { title?: string; dpi?: Resolution }): string {
    const id = this.stepId();
    this.steps.push({ kind: "figure", id, graphSteps: graphStepIds, ...opts });
    return id;
  }

  /** An export of an earlier graph or figure step. */
  recordExport(
    targetStepId: string,
    format: "png" | "jpeg" | "svg",
    dpi: "150" | "300" | "600",
    fileName?: string,
  ): string {
    const id = this.stepId();
    this.steps.push({ kind: "export", id, targetStep: targetStepId, format, dpi, ...(fileName ? { fileName } : {}) });
    return id;
  }

  /** A branch gating later steps on an earlier step's result. */
  recordBranch(condition: BranchCondition, thenSteps: string[], elseSteps?: string[]): string {
    const id = this.stepId();
    this.steps.push({ kind: "branch", id, condition, thenSteps, ...(elseSteps ? { elseSteps } : {}) });
    return id;
  }

  /** The recorded steps, in order. */
  get recordedSteps(): WorkflowStep[] {
    return [...this.steps];
  }

  /** Finish the workflow. Record-first is the proposal; the recordable vs
   *  hand-built balance is Smit's open question Q6 (roadmap §6) — logged
   *  here, not decided by this module. */
  finish(name: string, description?: string, opts?: { illustrative?: boolean; triggers?: WorkflowTrigger }): Workflow {
    return {
      id: `workflow-${Date.now().toString(36)}`,
      name,
      ...(description ? { description } : {}),
      ...(opts?.illustrative ? { illustrative: true } : {}),
      ...(opts?.triggers ? { triggers: opts.triggers } : {}),
      steps: [...this.steps],
    };
  }
}
