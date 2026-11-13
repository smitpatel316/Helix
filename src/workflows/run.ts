// The runner — replays a workflow on new data through a WorkflowHost.
//
// The host is the app: it creates the project nodes, runs the analyses
// (the same runAnalysis() the UI uses), and writes the exports. The engine
// owns the order, the binding, the branching and the reporting — and the
// one rule the roadmap states twice: a step that cannot bind FAILS CLEARLY
// with a visible flag. Nothing fails silently, and nothing blocks on a
// question the researcher could answer afterwards: a failed step's
// dependents are reported "not-run" (with the reason), the rest of the run
// goes on, and the report carries every failure as a flag.

import { checkTableShape, resolveParamBindings } from "./binding";
import { excludedKey } from "../lib/columns";
import { parseCell } from "../lib/numeric";
import type { AnalysisOutcome } from "../stats/types";
import type { AnalysisParams, AnalysisType } from "../stats/types";
import type { GraphOptions, GraphType, Resolution, TableData, TableType } from "../store/types";
import { validateWorkflow, type ValidateOptions } from "./validate";
import type {
  BranchCondition,
  BranchStep,
  CleanOp,
  ExportRequest,
  StepReport,
  StepStatus,
  TableRef,
  Workflow,
  WorkflowRunReport,
  WorkflowStep,
} from "./types";

/**
 * What the runner needs from the app. Every method creates (or changes)
 * real project nodes, exactly as the UI's actions do — the engine never
 * writes to the project itself, so a workflow run is undoable and visible
 * in the sidebar like any work done by hand.
 */
export interface WorkflowHost {
  /** Create a table node from run-input data. */
  createTable(tableType: TableType, data: TableData, name?: string): Promise<{ nodeId: string; name: string }>;
  /** Replace a table node's data (a clean step). */
  updateTable(nodeId: string, data: TableData): Promise<void>;
  /** Create an analysis node and run it (the outcome decides branches). */
  createAnalysis(
    tableNodeId: string,
    analysisType: AnalysisType,
    params: AnalysisParams,
    name?: string,
  ): Promise<{ nodeId: string; name: string; outcome: AnalysisOutcome }>;
  /** Create a graph node from a table. */
  createGraph(
    tableNodeId: string,
    graphType: GraphType,
    options: GraphOptions,
  ): Promise<{ nodeId: string; name: string }>;
  /** Create a figure node from graph nodes, in panel order. */
  createFigure(
    graphNodeIds: string[],
    opts: { title?: string; dpi?: Resolution },
  ): Promise<{ nodeId: string; name: string }>;
  /** Write an export file (the host owns the drawn view + the filesystem). */
  exportFile(req: ExportRequest): Promise<{ path: string }>;
}

export interface RunOptions extends ValidateOptions {
  /** The run's input tables, consumed by import steps in order. */
  inputs: TableData[];
}

/** A table the runner can hand to a step: its node, its data, its type. */
interface LiveTable {
  nodeId: string;
  name: string;
  data: TableData;
  tableType: TableType;
}

/** The P values a result carries, if any: `stats` rows flagged `p`, plus
 *  the comparisons table's P values (see stats/types.ts). */
export function extractPValues(outcome: AnalysisOutcome): number[] {
  if ("error" in outcome) return [];
  const fromStats = outcome.stats.filter((r) => r.p && r.value != null).map((r) => r.value as number);
  const fromComparisons = (outcome.comparisons ?? []).filter((c) => c.p != null).map((c) => c.p as number);
  return [...fromStats, ...fromComparisons];
}

/** A clean step's operations, as pure TableData transforms. Returns the
 *  same TableData when nothing changed, so the runner can skip the write. */
export function applyCleanOps(data: TableData, ops: CleanOp[]): TableData {
  let next = data;
  for (const op of ops) {
    if (op.op === "drop-empty-rows") {
      const kept = next.rows.filter((row) => row.slice(1).some((cell) => cell != null && String(cell).trim() !== ""));
      if (kept.length !== next.rows.length) next = { ...next, rows: kept };
    } else if (op.op === "exclude-non-numeric") {
      const excluded = new Set(next.excluded ?? []);
      let added = false;
      next.rows.forEach((row, r) => {
        row.slice(1).forEach((cell, i) => {
          if (cell != null && String(cell).trim() !== "" && parseCell(cell) == null) {
            const key = excludedKey(r, i + 1);
            if (!excluded.has(key)) {
              excluded.add(key);
              added = true;
            }
          }
        });
      });
      if (added) next = { ...next, excluded: [...excluded] };
    }
  }
  return next;
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Replay a workflow. Always returns a report — never throws for a bad
 *  workflow or a failed step. A host method throwing is reported as that
 *  step's failure, not as a crash. */
export async function runWorkflow(
  workflow: Workflow,
  host: WorkflowHost,
  opts: RunOptions,
): Promise<WorkflowRunReport> {
  const issues = validateWorkflow(workflow, opts);
  if (issues.length) {
    return {
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: "failed",
      steps: workflow.steps.map((s) => ({
        stepId: s.id,
        kind: s.kind,
        status: "not-run",
        message: "Not run — the workflow has a problem. See the run's flags.",
      })),
      exports: [],
      flags: issues.map((i) => `${i.path}: ${i.message}`),
    };
  }

  const reports: StepReport[] = [];
  const flags: string[] = [];
  const exports: ExportRequest[] = [];
  const statusById = new Map<string, StepStatus>();
  const nodeById = new Map<string, string>();
  const nameById = new Map<string, string>();
  const outcomeById = new Map<string, AnalysisOutcome>();
  const tableByImportStep = new Map<string, LiveTable>();
  const tableByInputIndex = new Map<number, LiveTable>();
  const skippedBy = new Map<string, string>();
  const notRunReason = new Map<string, string>();
  let nextInput = 0;

  const report = (step: WorkflowStep, status: StepStatus, message: string, nodeId?: string): void => {
    statusById.set(step.id, status);
    reports.push({ stepId: step.id, kind: step.kind, status, message, ...(nodeId ? { nodeId } : {}) });
    if (status === "failed") flags.push(`Step “${step.id}” (${step.kind}) failed: ${message}`);
  };

  /** The table a step reads, creating the node for a run-input ref on first use. */
  const resolveTable = async (
    ref: TableRef,
  ): Promise<{ ok: true; table: LiveTable } | { ok: false; error: string }> => {
    if (ref.source === "import-step") {
      const table = tableByImportStep.get(ref.stepId);
      if (!table)
        return {
          ok: false,
          error: `The table from import step “${ref.stepId}” is not available — that step did not produce a table.`,
        };
      return { ok: true, table };
    }
    const cached = tableByInputIndex.get(ref.index);
    if (cached) return { ok: true, table: cached };
    const input = opts.inputs[ref.index];
    if (!input)
      return {
        ok: false,
        error: `Run input ${ref.index + 1} does not exist — the run only supplied ${opts.inputs.length} input table${opts.inputs.length === 1 ? "" : "s"}.`,
      };
    const shape = checkTableShape(ref.tableType, input);
    if (shape) return { ok: false, error: shape };
    const created = await host.createTable(ref.tableType, input);
    const table: LiveTable = { nodeId: created.nodeId, name: created.name, data: input, tableType: ref.tableType };
    tableByInputIndex.set(ref.index, table);
    nameById.set(`input:${ref.index}`, created.name);
    return { ok: true, table };
  };

  /** The earlier steps this step needs to have succeeded. A branch step
   *  has none here: its condition is evaluated against whatever happened,
   *  including failures — routing around a failure is the point. */
  const dependenciesOf = (step: WorkflowStep): string[] => {
    switch (step.kind) {
      case "import":
      case "branch":
        return [];
      case "clean":
      case "analyze":
        return step.table.source === "import-step" ? [step.table.stepId] : [];
      case "graph":
        return [
          ...(step.table.source === "import-step" ? [step.table.stepId] : []),
          ...(step.links ? Object.values(step.links) : []),
        ];
      case "figure":
        return [...step.graphSteps];
      case "export":
        return [step.targetStep];
    }
  };

  const evaluateBranch = (step: BranchStep): { ok: true; holds: boolean } | { ok: false; error: string } => {
    const cond: BranchCondition = step.condition;
    switch (cond.kind) {
      case "step-succeeded":
        return { ok: true, holds: statusById.get(cond.step) === "succeeded" };
      case "step-failed": {
        // "Failed" here means "did not produce its result" — a step that
        // was itself not-run (its own dependency failed) counts, so a
        // branch can route around a failure further up the chain.
        const status = statusById.get(cond.step);
        return { ok: true, holds: status === "failed" || status === "not-run" };
      }
      case "analysis-p-below":
      case "analysis-p-above": {
        const outcome = outcomeById.get(cond.step);
        if (!outcome)
          return {
            ok: false,
            error: `Step “${cond.step}” produced no analysis result to branch on — it did not run, or it failed.`,
          };
        if ("error" in outcome)
          return {
            ok: false,
            error: `Step “${cond.step}” produced no analysis result to branch on — the analysis failed: ${outcome.error}`,
          };
        const pValues = extractPValues(outcome);
        if (!pValues.length)
          return {
            ok: false,
            error: `Step “${cond.step}” produced no P value to branch on — its result has no P value.`,
          };
        const holds =
          cond.kind === "analysis-p-below"
            ? pValues.some((p) => p < cond.threshold)
            : pValues.some((p) => p > cond.threshold);
        return { ok: true, holds };
      }
    }
  };

  for (const step of workflow.steps) {
    const blocked = notRunReason.get(step.id);
    if (blocked) {
      report(step, "not-run", blocked);
      continue;
    }
    const skipped = skippedBy.get(step.id);
    if (skipped) {
      report(step, "skipped", `Skipped by the branch at step “${skipped}” — its condition did not select this step.`);
      continue;
    }
    const failedDep = dependenciesOf(step).find((dep) => {
      const s = statusById.get(dep);
      return s === "failed" || s === "not-run" || s === "skipped";
    });
    if (failedDep) {
      const depStatus = statusById.get(failedDep);
      report(
        step,
        "not-run",
        `Not run — it needs step “${failedDep}”, which ${depStatus === "skipped" ? "was skipped by a branch" : "did not succeed"}.`,
      );
      continue;
    }

    try {
      switch (step.kind) {
        case "import": {
          const input = opts.inputs[nextInput++];
          if (!input) {
            report(
              step,
              "failed",
              `There is no more input data — this import step needs an input table, and the run only supplied ${opts.inputs.length} input table${opts.inputs.length === 1 ? "" : "s"}.`,
            );
            break;
          }
          const shape = checkTableShape(step.tableType, input);
          if (shape) {
            report(step, "failed", `The input table does not fit this step: ${shape}`);
            break;
          }
          const created = await host.createTable(step.tableType, input, step.sourceName);
          tableByImportStep.set(step.id, {
            nodeId: created.nodeId,
            name: created.name,
            data: input,
            tableType: step.tableType,
          });
          nodeById.set(step.id, created.nodeId);
          nameById.set(step.id, created.name);
          report(
            step,
            "succeeded",
            `Imported the input table as a ${step.tableType} table (“${created.name}”).`,
            created.nodeId,
          );
          break;
        }
        case "clean": {
          const resolved = await resolveTable(step.table);
          if (!resolved.ok) {
            report(step, "failed", resolved.error);
            break;
          }
          const cleaned = applyCleanOps(resolved.table.data, step.ops);
          const changed = cleaned !== resolved.table.data;
          if (changed) {
            await host.updateTable(resolved.table.nodeId, cleaned);
            resolved.table.data = cleaned;
          }
          report(
            step,
            "succeeded",
            changed
              ? `Cleaned the table (${step.ops.map((o) => o.op).join(", ")}).`
              : `Nothing to clean — the table already satisfied ${step.ops.map((o) => `“${o.op}”`).join(", ")}.`,
          );
          break;
        }
        case "analyze": {
          const resolved = await resolveTable(step.table);
          if (!resolved.ok) {
            report(step, "failed", resolved.error);
            break;
          }
          const bound = resolveParamBindings(step.params, step.bindings, resolved.table.data, resolved.table.tableType);
          if (!bound.ok) {
            report(step, "failed", bound.error);
            break;
          }
          const created = await host.createAnalysis(resolved.table.nodeId, step.analysisType, bound.value, step.name);
          nodeById.set(step.id, created.nodeId);
          nameById.set(step.id, created.name);
          if ("error" in created.outcome) {
            outcomeById.set(step.id, created.outcome);
            report(step, "failed", `The analysis could not run: ${created.outcome.error}`);
            break;
          }
          outcomeById.set(step.id, created.outcome);
          report(step, "succeeded", `Ran “${created.name}” on table “${resolved.table.name}”.`, created.nodeId);
          break;
        }
        case "graph": {
          const resolved = await resolveTable(step.table);
          if (!resolved.ok) {
            report(step, "failed", resolved.error);
            break;
          }
          const options: GraphOptions = { ...step.options };
          if (step.links) {
            for (const [field, linkStep] of Object.entries(step.links)) {
              const linkedNode = nodeById.get(linkStep as string);
              if (!linkedNode) {
                report(step, "failed", `The linked analysis from step “${linkStep}” produced no node.`);
                break;
              }
              (options as unknown as Record<string, string>)[field] = linkedNode;
            }
            if (statusById.get(step.id) === "failed") break;
          }
          const created = await host.createGraph(resolved.table.nodeId, step.graphType, options);
          nodeById.set(step.id, created.nodeId);
          nameById.set(step.id, created.name);
          report(step, "succeeded", `Built the “${created.name}” graph.`, created.nodeId);
          break;
        }
        case "figure": {
          const graphNodeIds = step.graphSteps.map((id) => nodeById.get(id) as string);
          const created = await host.createFigure(graphNodeIds, { title: step.title, dpi: step.dpi });
          nodeById.set(step.id, created.nodeId);
          nameById.set(step.id, created.name);
          report(
            step,
            "succeeded",
            `Built the figure “${created.name}” from ${graphNodeIds.length} graph${graphNodeIds.length === 1 ? "" : "s"}.`,
            created.nodeId,
          );
          break;
        }
        case "export": {
          const targetNode = nodeById.get(step.targetStep);
          if (!targetNode) {
            report(step, "failed", `Step “${step.targetStep}” produced no graph or figure to export.`);
            break;
          }
          const targetName = nameById.get(step.targetStep) ?? step.targetStep;
          const fileName =
            step.fileName ?? `${workflow.name} — ${targetName}.${step.format === "jpeg" ? "jpg" : step.format}`;
          const req: ExportRequest = {
            nodeId: targetNode,
            nodeName: targetName,
            format: step.format,
            dpi: step.dpi,
            fileName,
          };
          const written = await host.exportFile(req);
          req.path = written.path;
          exports.push(req);
          report(
            step,
            "succeeded",
            `Exported “${targetName}” as ${step.format.toUpperCase()} at ${step.dpi} DPI → ${written.path}.`,
          );
          break;
        }
        case "branch": {
          const evaluated = evaluateBranch(step);
          if (!evaluated.ok) {
            report(step, "failed", `The branch could not be decided: ${evaluated.error}`);
            // The gated steps cannot be chosen — report them not-run, never
            // run them by default or skip them silently.
            const gated = [...step.thenSteps, ...(step.elseSteps ?? [])];
            for (const gatedId of gated)
              notRunReason.set(
                gatedId,
                `Not run — the branch at step “${step.id}” could not be decided: ${evaluated.error}`,
              );
            break;
          }
          const running = evaluated.holds ? step.thenSteps : (step.elseSteps ?? []);
          const waiting = evaluated.holds ? (step.elseSteps ?? []) : step.thenSteps;
          for (const id of waiting) skippedBy.set(id, step.id);
          report(
            step,
            "succeeded",
            evaluated.holds
              ? `Condition held — running ${running.length} step${running.length === 1 ? "" : "s"} (${running.join(", ") || "none"}).`
              : `Condition did not hold — running ${running.length} step${running.length === 1 ? "" : "s"} (${running.join(", ") || "none"}).`,
          );
          break;
        }
      }
    } catch (err) {
      report(step, "failed", `The app could not run this step: ${reason(err)}`);
    }
  }

  const succeeded = reports.filter((r) => r.status === "succeeded").length;
  const failed = reports.filter((r) => r.status === "failed").length;
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: failed === 0 ? "succeeded" : succeeded > 0 ? "completed-with-failures" : "failed",
    steps: reports,
    exports,
    flags,
  };
}
