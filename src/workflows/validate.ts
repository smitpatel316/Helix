// Validation — structural checks on a workflow (or a workflow file) before
// it runs or is shared. A workflow with issues never runs: runWorkflow()
// validates first and reports the issues instead of starting.
//
// Two rejections are deliberate scope guards, not bugs:
//  - a `schedule` trigger: scheduled runs are Phase 5, not a v3 promise
//    (roadmap §4a — a desktop app has to be running);
//  - any adaptive-replay field (fuzzy matching, header synonyms, unit
//    conversion, learned mappings): explicitly out of scope (Smit's
//    correction, Nov 13 ~10:10 PT).

import { WORKFLOW_TABLE_TYPES } from "./types";
import type { WorkflowStep } from "./types";

// (Kept beside the issue type so validate.ts stays self-contained.)
export interface ValidationIssue {
  /** Where the problem is, e.g. `steps[2].bindings.y` or `triggers`. */
  path: string;
  message: string;
}

const issue = (path: string, message: string): ValidationIssue => ({ path, message });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const STEP_KINDS = new Set(["import", "clean", "analyze", "graph", "figure", "export", "branch"]);
const CLEAN_OPS = new Set(["drop-empty-rows", "exclude-non-numeric"]);
const EXPORT_FORMATS = new Set(["png", "jpeg", "svg"]);
const DPIS = new Set(["150", "300", "600"]);
const BINDING_ROLES = new Set(["x", "y", "set", "column", "group", "all-numeric"]);
const PARAM_BINDING_FIELDS = new Set([
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
]);

/** Adaptive-replay fields, rejected wherever they appear (see header). */
const ADAPTIVE_KEYS = ["fuzzy", "synonyms", "learnedMappings", "unitConversion", "guess", "headerSynonyms"];

function checkAdaptiveKeys(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((child, i) => checkAdaptiveKeys(child, `${path}[${i}]`, issues));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (ADAPTIVE_KEYS.includes(key))
      issues.push(
        issue(
          `${path}.${key}`,
          `“${key}” is adaptive replay (fuzzy matching / learned mappings) — explicitly out of scope for core Workflows (roadmap §4a). Remove it; the step must bind by exact structure and role.`,
        ),
      );
    checkAdaptiveKeys(child, `${path}.${key}`, issues);
  }
}

function checkBinding(binding: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(binding)) {
    issues.push(issue(path, "A binding must be an object with a role."));
    return;
  }
  if (typeof binding.role !== "string" || !BINDING_ROLES.has(binding.role)) {
    issues.push(
      issue(
        `${path}.role`,
        `Unknown binding role “${String(binding.role)}” — expected one of x, y, set, column, group, all-numeric.`,
      ),
    );
    return;
  }
  if (binding.role === "y" && (typeof binding.index !== "number" || binding.index < 0))
    issues.push(issue(`${path}.index`, "A “y” binding needs a non-negative series index."));
  if (
    (binding.role === "set" || binding.role === "column" || binding.role === "group") &&
    typeof binding.name !== "string"
  )
    issues.push(issue(`${path}.name`, `A “${binding.role}” binding needs a name.`));
}

function checkTableRef(ref: unknown, path: string, importSteps: Set<string>, issues: ValidationIssue[]): void {
  if (!isRecord(ref)) {
    issues.push(issue(path, "A table reference must name an import step or a run input."));
    return;
  }
  if (ref.source === "import-step") {
    if (typeof ref.stepId !== "string" || !importSteps.has(ref.stepId))
      issues.push(issue(`${path}.stepId`, `No earlier import step is named “${String(ref.stepId)}”.`));
  } else if (ref.source === "run-input") {
    if (typeof ref.index !== "number" || ref.index < 0)
      issues.push(issue(`${path}.index`, "A run-input reference needs a non-negative input index."));
    if (typeof ref.tableType !== "string" || !WORKFLOW_TABLE_TYPES.includes(ref.tableType as never))
      issues.push(issue(`${path}.tableType`, `A run-input reference needs a table type.`));
  } else {
    issues.push(
      issue(`${path}.source`, `Unknown table source “${String(ref.source)}” — expected “import-step” or “run-input”.`),
    );
  }
}

export interface ValidateOptions {
  /** Analysis types the app knows (stats/index.ts ANALYSES keys). When
   *  omitted, an unknown analysis type is not flagged here — the runner
   *  still fails clearly when it tries to run it. */
  knownAnalyses?: ReadonlySet<string>;
  /** Graph types the app knows (views/graphs/index.ts GRAPHS keys). */
  knownGraphs?: ReadonlySet<string>;
}

/** Structural issues in a workflow value (unknown shape counts as issues). */
export function validateWorkflow(value: unknown, opts: ValidateOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  checkAdaptiveKeys(value, "workflow", issues);
  if (!isRecord(value)) return [issue("workflow", "A workflow must be an object.")];
  if (typeof value.id !== "string" || !value.id.trim()) issues.push(issue("id", "A workflow needs an id."));
  if (typeof value.name !== "string" || !value.name.trim()) issues.push(issue("name", "A workflow needs a name."));
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    issues.push(issue("steps", "A workflow needs at least one step."));
    return issues;
  }
  const steps = value.steps as unknown[];
  const seen = new Set<string>();
  const importSteps = new Set<string>();
  const analyzeSteps = new Set<string>();
  const graphSteps = new Set<string>();
  const figureSteps = new Set<string>();
  const earlier = new Set<string>();

  // Triggers — and the Phase 5 schedule guard.
  if (value.triggers !== undefined) {
    if (!isRecord(value.triggers)) {
      issues.push(issue("triggers", "Triggers must be an object."));
    } else {
      if ("schedule" in value.triggers)
        issues.push(
          issue(
            "triggers.schedule",
            "Scheduled runs are Phase 5, not a v3 promise — a desktop app has to be running (roadmap §4a). Remove the schedule; use one-click Run or on-import.",
          ),
        );
      const onImport = value.triggers.onImport;
      if (onImport !== undefined) {
        if (!isRecord(onImport)) {
          issues.push(issue("triggers.onImport", "An on-import trigger must be an object."));
        } else {
          if (onImport.tableType !== undefined && !WORKFLOW_TABLE_TYPES.includes(onImport.tableType as never))
            issues.push(issue("triggers.onImport.tableType", `Unknown table type “${String(onImport.tableType)}”.`));
          for (const f of ["minColumns", "minRows"] as const)
            if (onImport[f] !== undefined && (typeof onImport[f] !== "number" || (onImport[f] as number) < 0))
              issues.push(issue(`triggers.onImport.${f}`, `“${f}” must be a non-negative number.`));
          if (onImport.requiresX !== undefined && typeof onImport.requiresX !== "boolean")
            issues.push(issue("triggers.onImport.requiresX", "“requiresX” must be true or false."));
        }
      }
    }
  }

  steps.forEach((raw, i) => {
    const path = `steps[${i}]`;
    if (!isRecord(raw)) {
      issues.push(issue(path, "A step must be an object."));
      return;
    }
    const step = raw as Record<string, unknown> & { kind?: unknown; id?: unknown };
    if (typeof step.id !== "string" || !step.id.trim()) {
      issues.push(issue(`${path}.id`, "Every step needs an id."));
      return;
    }
    if (seen.has(step.id)) issues.push(issue(`${path}.id`, `Duplicate step id “${step.id}”.`));
    seen.add(step.id);
    if (typeof step.kind !== "string" || !STEP_KINDS.has(step.kind)) {
      issues.push(issue(`${path}.kind`, `Unknown step kind “${String(step.kind)}”.`));
      return;
    }
    const kind = step.kind as WorkflowStep["kind"];
    switch (kind) {
      case "import": {
        if (typeof step.tableType !== "string" || !WORKFLOW_TABLE_TYPES.includes(step.tableType as never))
          issues.push(issue(`${path}.tableType`, `Unknown table type “${String(step.tableType)}”.`));
        if (step.expectedShape !== undefined) {
          if (
            !isRecord(step.expectedShape) ||
            typeof step.expectedShape.columns !== "number" ||
            step.expectedShape.columns < 1
          )
            issues.push(issue(`${path}.expectedShape`, "“expectedShape” needs a columns count of at least 1."));
        }
        importSteps.add(step.id);
        break;
      }
      case "clean": {
        checkTableRef(step.table, `${path}.table`, importSteps, issues);
        if (!Array.isArray(step.ops) || step.ops.length === 0) {
          issues.push(issue(`${path}.ops`, "A clean step needs at least one operation."));
        } else {
          (step.ops as unknown[]).forEach((op, j) => {
            if (!isRecord(op) || typeof op.op !== "string" || !CLEAN_OPS.has(op.op))
              issues.push(
                issue(`${path}.ops[${j}]`, `Unknown clean operation “${String(isRecord(op) ? op.op : op)}”.`),
              );
          });
        }
        break;
      }
      case "analyze": {
        checkTableRef(step.table, `${path}.table`, importSteps, issues);
        if (typeof step.analysisType !== "string" || !step.analysisType.trim()) {
          issues.push(issue(`${path}.analysisType`, "An analyze step needs an analysis type."));
        } else if (opts.knownAnalyses && !opts.knownAnalyses.has(step.analysisType)) {
          issues.push(issue(`${path}.analysisType`, `Unknown analysis type “${step.analysisType}”.`));
        }
        if (!isRecord(step.params))
          issues.push(issue(`${path}.params`, "An analyze step needs params (an object, possibly empty)."));
        if (step.bindings !== undefined) {
          if (!isRecord(step.bindings)) {
            issues.push(issue(`${path}.bindings`, "Bindings must be an object keyed by param field."));
          } else {
            for (const [field, binding] of Object.entries(step.bindings)) {
              if (!PARAM_BINDING_FIELDS.has(field)) {
                issues.push(issue(`${path}.bindings.${field}`, `“${field}” is not a data-naming param field.`));
                continue;
              }
              const list = Array.isArray(binding) ? binding : [binding];
              list.forEach((b, j) =>
                checkBinding(b, `${path}.bindings.${field}${Array.isArray(binding) ? `[${j}]` : ""}`, issues),
              );
            }
          }
        }
        analyzeSteps.add(step.id);
        break;
      }
      case "graph": {
        checkTableRef(step.table, `${path}.table`, importSteps, issues);
        if (typeof step.graphType !== "string" || !step.graphType.trim()) {
          issues.push(issue(`${path}.graphType`, "A graph step needs a graph type."));
        } else if (opts.knownGraphs && !opts.knownGraphs.has(step.graphType)) {
          issues.push(issue(`${path}.graphType`, `Unknown graph type “${step.graphType}”.`));
        }
        if (!isRecord(step.options)) issues.push(issue(`${path}.options`, "A graph step needs its graph options."));
        if (step.links !== undefined) {
          if (!isRecord(step.links)) {
            issues.push(issue(`${path}.links`, "Links must map a graph option to an analyze step id."));
          } else {
            for (const [field, target] of Object.entries(step.links)) {
              if (typeof target !== "string" || !analyzeSteps.has(target))
                issues.push(
                  issue(
                    `${path}.links.${field}`,
                    `“${field}” must name an earlier analyze step — “${String(target)}” is not one.`,
                  ),
                );
            }
          }
        }
        graphSteps.add(step.id);
        break;
      }
      case "figure": {
        if (!Array.isArray(step.graphSteps) || step.graphSteps.length === 0) {
          issues.push(issue(`${path}.graphSteps`, "A figure step needs at least one graph step."));
        } else {
          (step.graphSteps as unknown[]).forEach((g, j) => {
            if (typeof g !== "string" || !graphSteps.has(g))
              issues.push(issue(`${path}.graphSteps[${j}]`, `“${String(g)}” is not an earlier graph step.`));
          });
        }
        if (step.dpi !== undefined && !DPIS.has(String(step.dpi)))
          issues.push(issue(`${path}.dpi`, "A figure's DPI must be 150, 300 or 600."));
        figureSteps.add(step.id);
        break;
      }
      case "export": {
        if (
          typeof step.targetStep !== "string" ||
          (!graphSteps.has(step.targetStep) && !figureSteps.has(step.targetStep))
        )
          issues.push(
            issue(`${path}.targetStep`, `“${String(step.targetStep)}” is not an earlier graph or figure step.`),
          );
        if (typeof step.format !== "string" || !EXPORT_FORMATS.has(step.format))
          issues.push(issue(`${path}.format`, "An export's format must be png, jpeg or svg."));
        if (typeof step.dpi !== "string" || !DPIS.has(step.dpi))
          issues.push(issue(`${path}.dpi`, "An export's DPI must be 150, 300 or 600."));
        break;
      }
      case "branch": {
        const cond = step.condition;
        if (!isRecord(cond)) {
          issues.push(issue(`${path}.condition`, "A branch step needs a condition."));
          break;
        }
        if (cond.kind === "step-succeeded" || cond.kind === "step-failed") {
          if (typeof cond.step !== "string" || !earlier.has(cond.step))
            issues.push(issue(`${path}.condition.step`, `“${String(cond.step)}” is not an earlier step.`));
        } else if (cond.kind === "analysis-p-below" || cond.kind === "analysis-p-above") {
          if (typeof cond.step !== "string" || !analyzeSteps.has(cond.step))
            issues.push(issue(`${path}.condition.step`, `“${String(cond.step)}” is not an earlier analyze step.`));
          if (typeof cond.threshold !== "number" || cond.threshold <= 0 || cond.threshold >= 1)
            issues.push(issue(`${path}.condition.threshold`, "A P-value threshold must be between 0 and 1."));
        } else {
          issues.push(issue(`${path}.condition.kind`, `Unknown branch condition “${String(cond.kind)}”.`));
        }
        const later = new Set(steps.slice(i + 1).map((s) => (isRecord(s) ? (s.id as string) : "")));
        for (const field of ["thenSteps", "elseSteps"] as const) {
          const list = step[field];
          if (list === undefined && field === "elseSteps") continue;
          if (!Array.isArray(list) || (field === "thenSteps" && list.length === 0)) {
            issues.push(issue(`${path}.${field}`, `“${field}” must list at least one later step.`));
            continue;
          }
          (list as unknown[]).forEach((s, j) => {
            if (typeof s !== "string" || !later.has(s))
              issues.push(
                issue(
                  `${path}.${field}[${j}]`,
                  `“${String(s)}” is not a later step — a branch can only gate steps after it.`,
                ),
              );
          });
        }
        break;
      }
    }
    earlier.add(step.id);
  });
  return issues;
}
