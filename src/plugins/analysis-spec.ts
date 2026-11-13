// Plugin analysis spec — v3 Phase 4 groundwork (roadmap §4b Definition row).
//
// A plugin analysis declares: which table types it applies to, its
// parameters (see parameters.ts — the app's existing parameter kinds), and
// its wizard questions. It plugs into the same `AnalysisType` registry
// first-party analyses use — see registry.ts, which holds the plugin side
// of that registry and the unified `resolveAnalysis` seam.
//
// Two forms, one shape:
//   - JSON form (what a plugin.json carries): the computation is R code
//     only. A `typescript` compute in JSON is rejected — TypeScript compute
//     is registered in code (the fixture does this), because executing a
//     plugin's JS module needs the Phase 4 Isolation webview, which does
//     not exist yet.
//   - Code form (what `registerPluginAnalysis` takes): the computation may
//     also be a TypeScript function, and may supply a custom rows mapper.
//
// Computation contract (both forms): the R code runs through the existing
// webR engine (see registry.ts) with the data groups declared as `g0`,
// `g1`, … — the same contract as a first-party `ColumnTestSpec.rCode` —
// and must end in a `c(name=value, …)` named vector. Without a custom rows
// mapper, each named value becomes one statistics row (see registry.ts).
// Plugin R code never calls `library()` inline: packages come from the
// vendored repo via `ensurePackages`, exactly as first-party analyses do,
// and a load-time denylist scan (below) trips on the obvious escapes.
// That scan is a tripwire, not a sandbox proof — the containment is webR
// (R cannot touch the filesystem or the network except through the host
// bridge) plus the capability boundary (capabilities.ts).

import { PACKAGE_REGISTRY } from "../stats/webr";
import type { GroupDescriptives, StatRow } from "../stats/types";
import type { Group } from "../stats/column/base";
import type { Column } from "../lib/dataset";
import type { TableType } from "../store/types";
import type { Answers, Question } from "../views/analyses/wizards";
import {
  validatePluginParameters,
  type PluginParameter,
  type PluginParamValue,
  type PluginParamValues,
} from "./parameters";

/** Every table type a plugin analysis may apply to (store/types.ts). */
export const PLUGIN_TABLE_TYPES: readonly TableType[] = [
  "column",
  "xy",
  "grouped",
  "nested",
  "multiple",
  "contingency",
  "survival",
];

const isTableType = (v: unknown): v is TableType =>
  typeof v === "string" && (PLUGIN_TABLE_TYPES as readonly string[]).includes(v);

/** One wizard question, serialisable (no functions — a plugin.json can carry
 *  it). Mirrors the wizard's own `Question` shapes (views/analyses/wizards.ts):
 *  `choice` (options may be the literal `"columns"` — resolved to the
 *  table's data-column names at ask time), `number` (range-checked; the
 *  runner re-checks), `names` (pick several), `text` (free text).
 *  A question's `id` is the parameter key it answers (see validation). */
export type PluginQuestion =
  | {
      id: string;
      ask: string;
      kind: "choice";
      options: { value: string; label: string }[] | "columns";
      emptyMessage?: string;
    }
  | { id: string; ask: string; kind: "number"; label: string; initial: number; min?: number; max?: number; step?: number }
  | { id: string; ask: string; kind: "names"; options: string[] | "columns"; min?: number }
  | { id: string; ask: string; kind: "text"; label: string; initial: string; placeholder?: string };

/** What a TypeScript computation receives and returns. Groups are the
 *  data-holding columns (`dataGroups`); descriptives for them are computed
 *  by the runner from `../lib/summary` — a pure-TypeScript analysis never
 *  needs the R engine. */
export interface PluginTsComputeInput {
  groups: Group[];
  columns: Column[];
  params: PluginParamValues;
}
export interface PluginTsComputeOutput {
  stats: StatRow[];
  notes?: string;
}
export type PluginTsCompute = (
  input: PluginTsComputeInput,
) => Promise<PluginTsComputeOutput> | PluginTsComputeOutput;

/** How a plugin analysis computes: R code through webR, or a TypeScript
 *  function (code registration only). */
export type PluginCompute =
  | { kind: "r"; code: string }
  | { kind: "typescript"; run: PluginTsCompute };

/** The JSON form of the computation: R only. */
export type PluginComputeJson = { kind: "r"; code: string };

/** A plugin analysis spec, as a plugin.json carries it. */
export interface PluginAnalysisSpecJson {
  id: string;
  label: string;
  tableTypes: TableType[];
  minColumns: number;
  description?: string;
  parameters: PluginParameter[];
  questions: PluginQuestion[];
  compute: PluginComputeJson;
  notes?: string;
  requiredPackages?: string[];
}

/** A plugin analysis spec, as code registers it. `rows` maps the R named
 *  vector (plus descriptives) to display rows; without it the runner uses
 *  the default mapping (one row per named value). */
export interface PluginAnalysisSpec {
  id: string;
  label: string;
  tableTypes: TableType[];
  minColumns: number;
  description?: string;
  parameters: PluginParameter[];
  questions: PluginQuestion[];
  compute: PluginCompute;
  notes?: string;
  requiredPackages?: string[];
  rows?: (
    v: Record<string, number | null>,
    groups: GroupDescriptives[],
    params: PluginParamValues,
  ) => StatRow[];
}

// ── R static scan ──────────────────────────────────────────────────────────
// Load-time tripwire for the obvious escapes. The list is deliberately
// short and explicit: anything that reads files, runs processes, loads
// packages inline, or reaches the network. This is NOT the containment —
// webR + the capability boundary are — it only fails a plugin early with a
// clear message instead of letting it reach the engine.
const FORBIDDEN_R_PATTERNS: { pattern: RegExp; message: string }[] = [
  { pattern: /\b(system|shell)\s*\(/, message: "must not run shell commands (system()/shell())" },
  { pattern: /\b(library|require)\s*\(/, message: "must not load packages inline (library()/require()) — declare them in requiredPackages" },
  { pattern: /\bsource\s*\(/, message: "must not source files (source())" },
  { pattern: /\b(download\.file|url|socketConnection)\s*\(/, message: "must not reach the network (download.file()/url()/socketConnection())" },
  { pattern: /\b(readLines|read\.csv|read\.table|scan)\s*\(/, message: "must not read files (readLines()/read.csv()/read.table()/scan())" },
  { pattern: /\b(file|list\.files|dir)\s*\(/, message: "must not touch the filesystem (file()/list.files()/dir())" },
  { pattern: /\beval\s*\(/, message: "must not evaluate generated code (eval())" },
];

/** The forbidden-pattern problems in R code, if any (empty: clean). */
export function scanPluginRCode(code: string): string[] {
  return FORBIDDEN_R_PATTERNS.filter(({ pattern }) => pattern.test(code)).map(
    ({ message }) => `Plugin R code ${message}.`,
  );
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const ANALYSIS_ID = /^[a-z0-9][a-z0-9_-]*$/;

function validateQuestions(
  value: unknown,
  parameterKeys: Set<string>,
): { questions: PluginQuestion[] } | { errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(value)) return { errors: ["Plugin analysis questions must be a list (possibly empty)."] };
  const questions: PluginQuestion[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push("Each wizard question must be an object with an id, ask and kind.");
      continue;
    }
    const q = raw as Record<string, unknown>;
    if (!isNonEmptyString(q.id)) {
      errors.push("Each wizard question needs a non-empty id.");
      continue;
    }
    const id = q.id as string;
    if (!parameterKeys.has(id)) {
      errors.push(`Wizard question “${id}” does not answer any declared parameter — question ids must be parameter keys.`);
      continue;
    }
    if (!isNonEmptyString(q.ask)) {
      errors.push(`Wizard question “${id}” needs a non-empty ask.`);
      continue;
    }
    switch (q.kind) {
      case "choice": {
        if (q.options === "columns") {
          questions.push({
            id,
            ask: q.ask as string,
            kind: "choice",
            options: "columns",
            ...(typeof q.emptyMessage === "string" ? { emptyMessage: q.emptyMessage } : {}),
          });
        } else if (
          Array.isArray(q.options) &&
          q.options.length > 0 &&
          q.options.every(
            (o) =>
              typeof o === "object" &&
              o !== null &&
              typeof (o as { value?: unknown }).value === "string" &&
              typeof (o as { label?: unknown }).label === "string",
          )
        ) {
          questions.push({
            id,
            ask: q.ask as string,
            kind: "choice",
            options: q.options as { value: string; label: string }[],
            ...(typeof q.emptyMessage === "string" ? { emptyMessage: q.emptyMessage } : {}),
          });
        } else {
          errors.push(`Choice question “${id}” needs at least one option (or "columns").`);
        }
        break;
      }
      case "number": {
        if (typeof q.initial !== "number" || !Number.isFinite(q.initial)) {
          errors.push(`Number question “${id}” needs a finite initial value.`);
        } else if (
          (typeof q.min === "number" && q.initial < q.min) ||
          (typeof q.max === "number" && q.initial > q.max)
        ) {
          errors.push(`Number question “${id}” has an initial value outside its range.`);
        } else if (!isNonEmptyString(q.label)) {
          errors.push(`Number question “${id}” needs a non-empty label.`);
        } else {
          questions.push({
            id,
            ask: q.ask as string,
            kind: "number",
            label: q.label as string,
            initial: q.initial,
            ...(typeof q.min === "number" ? { min: q.min } : {}),
            ...(typeof q.max === "number" ? { max: q.max } : {}),
            ...(typeof q.step === "number" ? { step: q.step } : {}),
          });
        }
        break;
      }
      case "names": {
        if (q.options === "columns") {
          questions.push({
            id,
            ask: q.ask as string,
            kind: "names",
            options: "columns",
            ...(typeof q.min === "number" ? { min: q.min } : {}),
          });
        } else if (
          Array.isArray(q.options) &&
          q.options.length > 0 &&
          q.options.every((o) => typeof o === "string")
        ) {
          questions.push({
            id,
            ask: q.ask as string,
            kind: "names",
            options: q.options as string[],
            ...(typeof q.min === "number" ? { min: q.min } : {}),
          });
        } else {
          errors.push(`Names question “${id}” needs at least one option (or "columns").`);
        }
        break;
      }
      case "text": {
        if (typeof q.initial !== "string" || !isNonEmptyString(q.label)) {
          errors.push(`Text question “${id}” needs a string initial value and a non-empty label.`);
        } else {
          questions.push({
            id,
            ask: q.ask as string,
            kind: "text",
            label: q.label as string,
            initial: q.initial,
            ...(typeof q.placeholder === "string" ? { placeholder: q.placeholder } : {}),
          });
        }
        break;
      }
      default:
        errors.push(`Question “${id}” has an unknown kind “${String(q.kind)}” — use choice, number, names or text.`);
    }
  }
  return errors.length ? { errors } : { questions };
}

/**
 * Validate a plugin analysis spec — JSON form (`allowTypeScriptCompute:
 * false`, the plugin.json path) or code form (`true`, the registry path).
 * Returns the typed spec, or the plain-language problems that reject it.
 * A parameter with no question is allowed: it runs on its default (an
 * advanced option the wizard does not ask about).
 */
export function validatePluginAnalysisSpec(
  value: unknown,
  opts: { allowTypeScriptCompute: boolean },
): { spec: PluginAnalysisSpecJson | PluginAnalysisSpec } | { errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { errors: ["A plugin analysis must be an object with an id, label, tableTypes and compute."] };
  }
  const v = value as Record<string, unknown>;

  if (typeof v.id !== "string" || !ANALYSIS_ID.test(v.id)) {
    errors.push("Analysis id must be lowercase letters, digits, “_” or “-” (for example “hello-mean”).");
  }
  if (!isNonEmptyString(v.label)) errors.push("Analysis label must be a non-empty string.");
  if (!Array.isArray(v.tableTypes) || v.tableTypes.length === 0 || !v.tableTypes.every(isTableType)) {
    errors.push(
      `Analysis tableTypes must list at least one of: ${PLUGIN_TABLE_TYPES.join(", ")}.`,
    );
  }
  if (typeof v.minColumns !== "number" || !Number.isInteger(v.minColumns) || v.minColumns < 1) {
    errors.push("Analysis minColumns must be a whole number of at least 1.");
  }
  if (v.description !== undefined && typeof v.description !== "string")
    errors.push("Analysis description must be a string.");
  if (v.notes !== undefined && typeof v.notes !== "string") errors.push("Analysis notes must be a string.");

  const paramResult = validatePluginParameters(v.parameters ?? []);
  if ("errors" in paramResult) errors.push(...paramResult.errors);
  const parameters = "parameters" in paramResult ? paramResult.parameters : [];
  const parameterKeys = new Set(parameters.map((p) => p.key));

  const questionResult = validateQuestions(v.questions ?? [], parameterKeys);
  if ("errors" in questionResult) errors.push(...questionResult.errors);
  const questions = "questions" in questionResult ? questionResult.questions : [];

  const registryNames = new Set(PACKAGE_REGISTRY.map((p) => p.name));
  let requiredPackages: string[] | undefined;
  if (v.requiredPackages !== undefined) {
    if (
      !Array.isArray(v.requiredPackages) ||
      v.requiredPackages.some((n) => typeof n !== "string" || !registryNames.has(n))
    ) {
      errors.push(
        `Analysis requiredPackages must name packages from the vendored repo (${[...registryNames].join(", ")}).`,
      );
    } else {
      requiredPackages = [...(v.requiredPackages as string[])];
    }
  }

  let compute: PluginCompute | PluginComputeJson | undefined;
  const c = v.compute as Record<string, unknown> | undefined;
  if (typeof c !== "object" || c === null) {
    errors.push("Analysis compute must declare how it computes (kind \"r\" with code, or kind \"typescript\").");
  } else if (c.kind === "r") {
    if (!isNonEmptyString(c.code)) {
      errors.push("R compute needs non-empty code (an R expression ending in a c(name=value, …) named vector).");
    } else {
      errors.push(...scanPluginRCode(c.code as string));
      compute = { kind: "r", code: c.code as string };
    }
  } else if (c.kind === "typescript") {
    if (!opts.allowTypeScriptCompute) {
      errors.push(
        "TypeScript compute cannot be declared in plugin.json — it must be registered in code. " +
          "A plugin.json analysis computes in R only (the plugin JS module loads in the Phase 4 Isolation webview).",
      );
    } else if (typeof (c as { run?: unknown }).run !== "function") {
      errors.push("TypeScript compute needs a run function.");
    } else {
      compute = { kind: "typescript", run: (c as { run: PluginTsCompute }).run };
    }
  } else {
    errors.push(`Analysis compute kind “${String(c.kind)}” is unknown — use "r" or "typescript".`);
  }

  let rows: PluginAnalysisSpec["rows"];
  if (v.rows !== undefined) {
    if (!opts.allowTypeScriptCompute || typeof v.rows !== "function") {
      errors.push("A custom rows mapper can only be supplied when registering in code.");
    } else {
      rows = v.rows as PluginAnalysisSpec["rows"];
    }
  }

  if (errors.length || !compute) return { errors: errors.length ? errors : ["Analysis compute is missing."] };
  const base = {
    id: v.id as string,
    label: (v.label as string).trim(),
    tableTypes: [...(v.tableTypes as TableType[])],
    minColumns: v.minColumns as number,
    parameters,
    questions,
    ...(typeof v.description === "string" ? { description: v.description } : {}),
    ...(typeof v.notes === "string" ? { notes: v.notes } : {}),
    ...(requiredPackages ? { requiredPackages } : {}),
  };
  if (compute.kind === "r") {
    const jsonSpec: PluginAnalysisSpecJson = { ...base, compute };
    return { spec: jsonSpec };
  }
  const codeSpec: PluginAnalysisSpec = { ...base, compute, ...(rows ? { rows } : {}) };
  return { spec: codeSpec };
}

/** A validated JSON spec as a code spec (R compute carries over as-is). */
export function jsonSpecToCodeSpec(spec: PluginAnalysisSpecJson): PluginAnalysisSpec {
  return { ...spec, compute: { kind: "r", code: spec.compute.code } };
}

/**
 * The wizard questions for a spec, as the app's wizard asks them — the
 * adapter from the serialisable plugin shape to the wizard's `Question`.
 * `"columns"` options resolve to the table's data-column names; a number
 * question carries its range (no `validate` function — the runner re-checks,
 * as first-party number questions do).
 */
export function toWizardQuestions(spec: PluginAnalysisSpec | PluginAnalysisSpecJson, columnNames: string[]): Question[] {
  return spec.questions.map((q): Question => {
    switch (q.kind) {
      case "choice":
        return {
          id: q.id,
          ask: q.ask,
          kind: "choice",
          options:
            q.options === "columns"
              ? columnNames.map((name) => ({ value: name, label: name }))
              : q.options,
          ...(q.emptyMessage ? { emptyMessage: q.emptyMessage } : {}),
        };
      case "number":
        return {
          id: q.id,
          ask: q.ask,
          kind: "number",
          label: q.label,
          initial: q.initial,
          ...(q.min !== undefined ? { min: q.min } : {}),
          ...(q.max !== undefined ? { max: q.max } : {}),
          ...(q.step !== undefined ? { step: q.step } : {}),
        };
      case "names":
        return {
          id: q.id,
          ask: q.ask,
          kind: "names",
          options: q.options === "columns" ? columnNames : q.options,
          ...(q.min !== undefined ? { min: q.min } : {}),
        };
      case "text":
        return {
          id: q.id,
          ask: q.ask,
          kind: "text",
          label: q.label,
          initial: q.initial,
          ...(q.placeholder ? { placeholder: q.placeholder } : {}),
        };
    }
  });
}

/**
 * Wizard answers → parameter values: each answer is filed under its
 * question's id (= its parameter key); unanswered parameters keep their
 * defaults (see parameters.ts). The caller validates the result with
 * `validatePluginParamValues` / `resolvePluginParamValues` before running.
 */
export function answersToParams(
  spec: PluginAnalysisSpec | PluginAnalysisSpecJson,
  answers: Answers,
): PluginParamValues {
  const values: PluginParamValues = {};
  for (const p of spec.parameters) {
    const answer = answers[p.key] as PluginParamValue | undefined;
    if (answer !== undefined) values[p.key] = answer;
  }
  return values;
}
