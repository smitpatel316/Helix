// Plugin registry — v3 Phase 4 groundwork (roadmap §4b Definition row).
//
// Plugin analyses plug into the same registry first-party analyses use.
// First-party analyses live in `ANALYSES` (src/stats/index.ts), keyed by
// the closed `AnalysisType` union; plugin analyses live here, keyed by a
// namespaced id — `plugin:<plugin-id>:<analysis-id>` — so a plugin can
// never collide with, shadow, or rename a first-party analysis. The seam
// for the rest of the app is `resolveAnalysis` (either source, one shape)
// and `runPluginAnalysis` (the plugin side of `runAnalysis`).
//
// Wiring NOT done in this groundwork (Phase 4): the New Analysis picker
// offering plugin analyses, the wizard calling `toWizardQuestions` +
// `answersToParams`, and the results view accepting a
// `PluginAnalysisResult` (its `testType` is the namespaced id string, not
// an `AnalysisType`). Those call sites need the plugin's lifecycle too —
// a disabled plugin's analyses are unregistered here, so they vanish from
// `resolveAnalysis` the moment the plugin is disabled (see loader.ts).
//
// Computation containment: plugin R code runs through the existing webR
// engine — `evalNamedVector`, the single primitive every first-party
// analysis builds on — with the data groups declared as `g0`, `g1`, … and
// packages installed first via `ensurePackages` from the vendored repo.
// A pure-TypeScript analysis never touches R: its descriptives come from
// `../lib/summary`. Runs are not cached here (first-party `runAnalysis`
// caches per table version; a plugin cache keyed the same way is Phase 4).

import { ANALYSES } from "../stats/index";
import { ensurePackages, evalNamedVector, packageErrorMessage } from "../stats/webr";
import { dataGroups, declareGroups, describe } from "../stats/column/base";
import { mean, median, sd, sem } from "../lib/summary";
import type { AnalysisResult, AnalysisType, GroupDescriptives, StatRow } from "../stats/types";
import type { Column } from "../lib/dataset";
import type { TableType } from "../store/types";
import { isValidPluginId } from "./manifest";
import {
  jsonSpecToCodeSpec,
  validatePluginAnalysisSpec,
  type PluginAnalysisSpec,
  type PluginAnalysisSpecJson,
} from "./analysis-spec";
import { resolvePluginParamValues, type PluginParamValues } from "./parameters";

/** A plugin analysis's namespaced id: `plugin:<plugin-id>:<analysis-id>`. */
export function pluginAnalysisId(pluginId: string, analysisId: string): string {
  return `plugin:${pluginId}:${analysisId}`;
}

/** Split a namespaced id back into its plugin and analysis ids; null when
 *  the id is not a plugin analysis id at all. */
export function parsePluginAnalysisId(id: string): { pluginId: string; analysisId: string } | null {
  const m = /^plugin:([^:]+):([^:]+)$/.exec(id);
  return m ? { pluginId: m[1], analysisId: m[2] } : null;
}

/** One registered plugin analysis: its spec, under its namespaced id. */
export interface PluginAnalysisEntry {
  id: string;
  pluginId: string;
  spec: PluginAnalysisSpec;
}

/** A plugin analysis's result: the unified result shape, with the
 *  namespaced id as `testType` (a plugin id is not an `AnalysisType`) and
 *  its provenance attached. */
export type PluginAnalysisResult = Omit<AnalysisResult, "testType"> & {
  testType: string;
  pluginId: string;
  analysisId: string;
};

/** A plugin run returns a result or a user-facing error, as `runAnalysis` does. */
export type PluginAnalysisOutcome = PluginAnalysisResult | { error: string };

const entries = new Map<string, PluginAnalysisEntry>();

/**
 * Register a plugin analysis (code form — JSON specs go through
 * `registerPluginAnalysesFromManifest` below). Rejects a duplicate
 * namespaced id and any spec problem. The plugin id must be a valid
 * manifest id (see manifest.ts).
 */
export function registerPluginAnalysis(pluginId: string, specValue: unknown): { id: string } | { errors: string[] } {
  if (!isValidPluginId(pluginId)) return { errors: [`Plugin id “${pluginId}” is not a valid plugin id.`] };
  const validated = validatePluginAnalysisSpec(specValue, { allowTypeScriptCompute: true });
  if ("errors" in validated) return { errors: validated.errors };
  // JSON specs (R compute) convert to the code form so the registry holds
  // one shape; TypeScript specs are already in code form.
  const spec =
    validated.spec.compute.kind === "r"
      ? jsonSpecToCodeSpec(validated.spec as PluginAnalysisSpecJson)
      : (validated.spec as PluginAnalysisSpec);
  const id = pluginAnalysisId(pluginId, spec.id);
  if (entries.has(id)) return { errors: [`Plugin analysis “${id}” is already registered.`] };
  entries.set(id, { id, pluginId, spec });
  return { id };
}

/** Register every analysis a validated manifest carries (JSON form: R only). */
export function registerPluginAnalysesFromManifest(
  pluginId: string,
  specs: PluginAnalysisSpecJson[],
): { ids: string[] } | { errors: string[] } {
  const ids: string[] = [];
  const errors: string[] = [];
  for (const spec of specs) {
    const result = registerPluginAnalysis(pluginId, jsonSpecToCodeSpec(spec));
    if ("errors" in result) errors.push(...result.errors);
    else ids.push(result.id);
  }
  if (errors.length) {
    for (const id of ids) entries.delete(id);
    return { errors };
  }
  return { ids };
}

export function getPluginAnalysis(id: string): PluginAnalysisEntry | undefined {
  return entries.get(id);
}

export function listPluginAnalyses(): PluginAnalysisEntry[] {
  return [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function pluginAnalysesForTable(tableType: TableType): PluginAnalysisEntry[] {
  return listPluginAnalyses().filter((e) => e.spec.tableTypes.includes(tableType));
}

/** Remove one analysis from the registry (plugin disabled / uninstalled). */
export function unregisterPluginAnalysis(id: string): boolean {
  return entries.delete(id);
}

/** Remove every analysis of one plugin; returns the removed ids. */
export function unregisterPlugin(pluginId: string): string[] {
  const removed: string[] = [];
  for (const [id, entry] of entries) {
    if (entry.pluginId === pluginId) {
      entries.delete(id);
      removed.push(id);
    }
  }
  return removed;
}

/** Empty the plugin registry (development / test reset only). */
export function clearPluginRegistry(): void {
  entries.clear();
}

/** Either side of the one registry: a first-party analysis, or a plugin one. */
export type ResolvedAnalysis =
  | { source: "first-party"; type: AnalysisType; label: string; minColumns: number }
  | {
      source: "plugin";
      id: string;
      pluginId: string;
      label: string;
      minColumns: number;
      tableTypes: TableType[];
    };

/** Look an analysis up by id — first-party `AnalysisType` or namespaced
 *  plugin id — in one call. `undefined` when neither registry knows it
 *  (including when its plugin is disabled: disabled plugins unregister). */
export function resolveAnalysis(id: string): ResolvedAnalysis | undefined {
  if (Object.hasOwn(ANALYSES, id)) {
    const analysis = ANALYSES[id as AnalysisType];
    return { source: "first-party", type: id as AnalysisType, label: analysis.label, minColumns: analysis.minColumns };
  }
  const entry = entries.get(id);
  if (!entry) return undefined;
  return {
    source: "plugin",
    id: entry.id,
    pluginId: entry.pluginId,
    label: entry.spec.label,
    minColumns: entry.spec.minColumns,
    tableTypes: entry.spec.tableTypes,
  };
}

// ── Running a plugin analysis ─────────────────────────────────────────────

/** A named-vector key that holds a P value: `p`, `p_value`, or `*_p`
 *  (rendered with significance colour + stars, as first-party P rows are). */
function isPValueKey(key: string): boolean {
  return key === "p" || key === "p_value" || key.endsWith("_p");
}

/** `mean_value` → "Mean value", `p` → "P value". */
function prettifyStatKey(key: string): string {
  if (key === "p") return "P value";
  const words = key.replace(/_p$/, " (P value)").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The default rows mapping: one statistics row per named R value. */
function defaultRows(v: Record<string, number | null>): StatRow[] {
  return Object.entries(v).map(([key, value]) => ({
    label: prettifyStatKey(key),
    value,
    ...(isPValueKey(key) ? { p: true } : {}),
  }));
}

/** Group descriptives in TypeScript (pure-TS analyses — no R engine). */
function describeInTs(groups: { name: string; values: number[] }[]): GroupDescriptives[] {
  return groups.map((g) => ({
    name: g.name,
    mean: g.values.length ? mean(g.values) : null,
    sd: g.values.length ? sd(g.values) : null,
    sem: g.values.length ? sem(g.values) : null,
    median: g.values.length ? median(g.values) : null,
    n: g.values.length,
  }));
}

/**
 * Run a registered plugin analysis on these columns — the plugin side of
 * `runAnalysis`. Params resolve over their defaults and are re-checked
 * before anything runs; required R packages install first from the
 * vendored repo; an R failure, a bad fit, or a bad value is a user-facing
 * error outcome, never a throw and never a crash.
 *
 * NOTE (build verification pending v1 clear): the R path boots the webR
 * engine, so it is verified by reading + `tsc` only in this lane — the
 * runtime check (the hello-analysis fixture's `verifyHelloPlugin`) runs
 * after v1 ships.
 */
export async function runPluginAnalysis(
  id: string,
  columns: Column[],
  params?: PluginParamValues,
): Promise<PluginAnalysisOutcome> {
  const entry = entries.get(id);
  if (!entry) return { error: `Unknown plugin analysis: ${id}` };
  const { spec } = entry;

  const resolved = resolvePluginParamValues(spec.parameters, params);
  if ("errors" in resolved) return { error: resolved.errors.join(" ") };
  const values = resolved.values;

  const groups = dataGroups(columns);
  if (groups.length < spec.minColumns) {
    return {
      error:
        `This test needs at least ${spec.minColumns} column${spec.minColumns > 1 ? "s" : ""} ` +
        `containing numeric data.`,
    };
  }

  const attribution = `Run by plugin “${entry.pluginId}”.`;
  const notes = spec.notes ? `${spec.notes} ${attribution}` : attribution;

  try {
    if (spec.compute.kind === "typescript") {
      const described = describeInTs(groups);
      const out = await spec.compute.run({ groups, columns, params: values });
      return {
        testType: id,
        pluginId: entry.pluginId,
        analysisId: spec.id,
        stats: out.stats,
        groups: described,
        notes: out.notes ? `${out.notes} ${attribution}` : notes,
      };
    }

    if (spec.requiredPackages?.length) {
      try {
        await ensurePackages(spec.requiredPackages);
      } catch (err) {
        return { error: packageErrorMessage(err) };
      }
    }
    // Groups are declared as g0, g1, … (the ColumnTestSpec contract); the
    // plugin code ends in a c(name=value, …) named vector.
    const v = await evalNamedVector(`${declareGroups(groups)};${spec.compute.code}`);
    const { groups: described } = await describe(groups);
    const stats = spec.rows ? spec.rows(v, described, values) : defaultRows(v);
    return {
      testType: id,
      pluginId: entry.pluginId,
      analysisId: spec.id,
      stats,
      groups: described,
      notes,
    };
  } catch (err: unknown) {
    return { error: `Could not run the test: ${err instanceof Error ? err.message : String(err)}` };
  }
}
