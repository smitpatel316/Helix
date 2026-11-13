// Hello Analysis — the example plugin fixture (v3 Phase 4 groundwork).
//
// Two analyses under plugin id `example.hello-analysis`:
//   - "hello-mean" (from plugin.json): R compute — the mean of the first
//     column, through the webR engine, registered via the folder/zip path
//     (`parsePluginPackage` → install → review → enable).
//   - "hello-scaled-mean" (registered in code below): pure-TypeScript
//     compute with parameters (a choice + a ranged number) and wizard
//     questions — the code-registration path, which never touches R.
//
// `verifyHelloPlugin` runs both on synthetic columns and checks the
// numbers. It is the runtime proof for this lane; the R half boots the
// webR engine, so it runs after v1 ships (build verification pending v1
// clear). `npm run check` (tsc) is the proof that runs now: the whole
// register → resolve → run path is exercised in code below.

import { mean, median } from "../../../lib/summary";
import type { Column } from "../../../lib/dataset";
import { getPluginAnalysis, registerPluginAnalysis, runPluginAnalysis } from "../../registry";
import { confirmEnable, installPlugin, parsePluginPackage, requestEnable, type PluginRecord } from "../../loader";
import type { PluginAnalysisSpec } from "../../analysis-spec";
import pluginJson from "./plugin.json";

export const HELLO_PLUGIN_ID = "example.hello-analysis";
export const HELLO_MEAN_ID = "plugin:example.hello-analysis:hello-mean";
export const HELLO_SCALED_MEAN_ID = "plugin:example.hello-analysis:hello-scaled-mean";

/** The app version the fixture enables against (plugin API 3 ↔ Titer 3). */
const FIXTURE_APP_VERSION = "3.0.0";

/** The enabled record from the first registration, kept so a second call
 *  can report the real install instead of rebuilding one. */
let helloRecord: PluginRecord | undefined;

/**
 * Register both hello analyses: the JSON one through the install/review/
 * enable path, the TypeScript one in code. Safe to call twice — an
 * already-registered analysis is left alone.
 */
export function registerHelloPlugin(): { record: PluginRecord; ids: string[] } | { errors: string[] } {
  if (!getPluginAnalysis(HELLO_MEAN_ID)) {
    const parsed = parsePluginPackage(new Map([["plugin.json", JSON.stringify(pluginJson)]]));
    if ("errors" in parsed) return { errors: parsed.errors };
    const installed = installPlugin(parsed.package, [], { kind: "folder", name: "hello-analysis" });
    if ("errors" in installed) return { errors: installed.errors };
    const reviewed = requestEnable(installed.record);
    const enabled = confirmEnable(reviewed, ["read-table"], FIXTURE_APP_VERSION);
    if (enabled.status !== "enabled") {
      return { errors: [enabled.incompatibility ?? `Hello plugin did not enable (status: ${enabled.status}).`] };
    }
    helloRecord = enabled;
  }

  if (!getPluginAnalysis(HELLO_SCALED_MEAN_ID)) {
    // Typed as a code spec so the compute function's params type-check.
    const scaledMeanSpec: PluginAnalysisSpec = {
      id: "hello-scaled-mean",
      label: "Hello scaled mean",
      tableTypes: ["column"],
      minColumns: 1,
      description: "The mean (or median) of the first column, times a multiplier.",
      parameters: [
        {
          kind: "choice",
          key: "statistic",
          label: "Statistic",
          options: [
            { value: "mean", label: "Mean" },
            { value: "median", label: "Median" },
          ],
          default: "mean",
        },
        { kind: "number", key: "multiplier", label: "Multiplier", default: 1, min: 0.1, max: 10 },
      ],
      questions: [
        {
          id: "statistic",
          ask: "Which statistic?",
          kind: "choice",
          options: [
            { value: "mean", label: "Mean" },
            { value: "median", label: "Median" },
          ],
        },
        {
          id: "multiplier",
          ask: "Multiply the result by how much?",
          kind: "number",
          label: "Multiplier",
          initial: 1,
          min: 0.1,
          max: 10,
        },
      ],
      compute: {
        kind: "typescript",
        run: ({ groups, params }) => {
          const values = groups[0]?.values ?? [];
          const statistic = params.statistic === "median" ? median(values) : mean(values);
          const multiplier = typeof params.multiplier === "number" ? params.multiplier : 1;
          return {
            stats: [
              {
                label: params.statistic === "median" ? "Scaled median" : "Scaled mean",
                value: statistic * multiplier,
              },
            ],
          };
        },
      },
      notes: "The mean (or median) of the first column, times the multiplier.",
    };
    const registered = registerPluginAnalysis(HELLO_PLUGIN_ID, scaledMeanSpec);
    if ("errors" in registered) return { errors: registered.errors };
  }

  if (!helloRecord) return { errors: ["Hello plugin enabled but its install record was lost."] };
  return { record: helloRecord, ids: [HELLO_MEAN_ID, HELLO_SCALED_MEAN_ID] };
}

/** One synthetic data column, in the shape every runner reads. */
export function helloColumn(name: string, values: number[]): Column {
  return {
    name,
    cells: values.map(String),
    byRow: [...values],
    values: [...values],
    rows: values.map((_, i) => i),
  };
}

const approx = (a: number | null | undefined, b: number): boolean => typeof a === "number" && Math.abs(a - b) < 1e-9;

/**
 * Run both hello analyses on synthetic columns and check the numbers.
 * Returns one line per check plus an overall verdict. The R half
 * (`hello-mean`) boots the webR engine — runtime verification pending v1
 * clear; the TypeScript half needs no engine.
 */
export async function verifyHelloPlugin(): Promise<{ ok: boolean; checks: string[] }> {
  const checks: string[] = [];
  const registered = registerHelloPlugin();
  if ("errors" in registered) {
    return { ok: false, checks: [`registration failed: ${registered.errors.join(" ")}`] };
  }
  checks.push(`registered: ${registered.ids.join(", ")}`);

  const columns = [helloColumn("Control", [2, 4, 9])];

  const meanOutcome = await runPluginAnalysis(HELLO_MEAN_ID, columns);
  if ("error" in meanOutcome) {
    checks.push(`hello-mean failed: ${meanOutcome.error}`);
  } else {
    const value = meanOutcome.stats.find((s) => s.label === "Mean value")?.value;
    checks.push(
      approx(value, 5) ? "hello-mean: mean of [2, 4, 9] is 5" : `hello-mean: expected mean 5, got ${String(value)}`,
    );
    checks.push(
      meanOutcome.pluginId === HELLO_PLUGIN_ID && meanOutcome.testType === HELLO_MEAN_ID
        ? "hello-mean: result carries its plugin provenance"
        : "hello-mean: result is missing its plugin provenance",
    );
  }

  const scaledMean = await runPluginAnalysis(HELLO_SCALED_MEAN_ID, columns, {
    statistic: "mean",
    multiplier: 2,
  });
  if ("error" in scaledMean) {
    checks.push(`hello-scaled-mean failed: ${scaledMean.error}`);
  } else {
    const value = scaledMean.stats.find((s) => s.label === "Scaled mean")?.value;
    checks.push(
      approx(value, 10)
        ? "hello-scaled-mean: mean 5 × 2 is 10"
        : `hello-scaled-mean: expected 10, got ${String(value)}`,
    );
  }

  const scaledMedian = await runPluginAnalysis(HELLO_SCALED_MEAN_ID, columns, {
    statistic: "median",
    multiplier: 2,
  });
  if ("error" in scaledMedian) {
    checks.push(`hello-scaled-median failed: ${scaledMedian.error}`);
  } else {
    const value = scaledMedian.stats.find((s) => s.label === "Scaled median")?.value;
    checks.push(
      approx(value, 8)
        ? "hello-scaled-mean (median): median 4 × 2 is 8"
        : `hello-scaled-mean (median): expected 8, got ${String(value)}`,
    );
  }

  const badParams = await runPluginAnalysis(HELLO_SCALED_MEAN_ID, columns, { multiplier: 99 });
  checks.push(
    "error" in badParams
      ? "hello-scaled-mean: multiplier 99 (above max 10) is refused before running"
      : "hello-scaled-mean: multiplier 99 was NOT refused — the runner must re-check ranges",
  );

  const ok = checks.every((c) => !/failed|expected|missing|NOT refused/i.test(c));
  return { ok, checks };
}
