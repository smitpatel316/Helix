// "Simulate data" (plan 22, sub-task a): draw a new table of simulated
// values from a chosen distribution, reproducibly (same seed + same spec =
// the identical table). All six distributions are base R `stats` — no
// package needed. One R call returns every value as a flat vector, in
// dataset order (the first n values are dataset 1, the next n dataset 2…),
// so a simulation is one webR round-trip whatever its size.
import type { SimulationDistribution, SimulationSpec } from "../types";
import type { TableData } from "../../store/types";
import { evalNumericVector } from "../webr";
import { newGroupedTable } from "../../views/tables/table-data";

/** A simulated value as the table stores it: 10 significant digits — full
 *  double precision would print 17-digit grid cells, and 10 digits is far
 *  past what any analysis of the table can resolve (the reference file
 *  rounds to 10 digits too). Integers (binomial/Poisson) print as integers. */
export function formatSimulatedValue(value: number): string {
  return String(Number(value.toPrecision(10)));
}

/** The R code for one simulated dataset set: `set.seed()` first, so the
 *  stream is reproducible whatever the engine ran before, then one draw of
 *  n × datasets values. Pure — unit-tested without R. */
export function simulationRCode(spec: SimulationSpec): string {
  const total = spec.n * spec.datasets;
  const draw =
    spec.distribution === "gaussian"
      ? `rnorm(${total},${spec.mean ?? 0},${spec.sd ?? 1})`
      : spec.distribution === "lognormal"
        ? `rlnorm(${total},${spec.meanlog ?? 0},${spec.sdlog ?? 1})`
        : spec.distribution === "uniform"
          ? `runif(${total},${spec.min ?? 0},${spec.max ?? 1})`
          : spec.distribution === "binomial"
            ? `rbinom(${total},${spec.size ?? 1},${spec.prob ?? 0.5})`
            : spec.distribution === "poisson"
              ? `rpois(${total},${spec.lambda ?? 1})`
              : `rexp(${total},${spec.rate ?? 1})`;
  return `set.seed(${spec.seed});${draw}`;
}

/** The most values one simulation may draw: a table past this is unwieldy
 *  in the grid (100,000 cells), and the draw itself is instant — the cap is
 *  about the table, not R. */
export const SIMULATION_MAX_VALUES = 100_000;

/** The first problem with `spec`, as a user-facing message — or undefined
 *  when it is valid. The dialog refuses before running R; the runner below
 *  re-checks, so a bad spec passed straight to it still fails clearly. */
export function validateSimulationSpec(spec: SimulationSpec): string | undefined {
  if (!Number.isInteger(spec.n) || spec.n < 2) return "Values per dataset must be a whole number of at least 2.";
  if (!Number.isInteger(spec.datasets) || spec.datasets < 1)
    return "Datasets must be a whole number of at least 1.";
  if (!Number.isInteger(spec.seed)) return "The seed must be a whole number.";
  if (spec.n * spec.datasets > SIMULATION_MAX_VALUES)
    return `That is ${spec.n * spec.datasets} values — at most ${SIMULATION_MAX_VALUES} per simulation. Use fewer values or datasets.`;
  const finite = (v: number | undefined) => v !== undefined && Number.isFinite(v);
  switch (spec.distribution) {
    case "gaussian":
      if (!finite(spec.mean) || !finite(spec.sd)) return "Enter a mean and a standard deviation.";
      if (spec.sd! <= 0) return "The standard deviation must be greater than 0.";
      return undefined;
    case "lognormal":
      if (!finite(spec.meanlog) || !finite(spec.sdlog)) return "Enter a meanlog and an sdlog.";
      if (spec.sdlog! <= 0) return "The sdlog must be greater than 0.";
      return undefined;
    case "uniform":
      if (!finite(spec.min) || !finite(spec.max)) return "Enter a minimum and a maximum.";
      if (spec.min! >= spec.max!) return "The minimum must be less than the maximum.";
      return undefined;
    case "binomial":
      if (!Number.isInteger(spec.size) || spec.size! < 1) return "The number of trials must be a whole number of at least 1.";
      if (!finite(spec.prob) || spec.prob! < 0 || spec.prob! > 1)
        return "The probability must be between 0 and 1.";
      return undefined;
    case "poisson":
      if (!finite(spec.lambda) || spec.lambda! <= 0) return "Lambda (the mean) must be greater than 0.";
      return undefined;
    case "exponential":
      if (!finite(spec.rate) || spec.rate! <= 0) return "The rate must be greater than 0 (the mean is 1 / rate).";
      return undefined;
    default:
      return "Choose a distribution.";
  }
}

/** The plain-language hint the dialog shows under a distribution's fields —
 *  lognormal especially: its parameters are on the log scale, and entering
 *  the arithmetic mean/SD is the common mistake. */
export function distributionHint(distribution: SimulationDistribution): string {
  switch (distribution) {
    case "gaussian":
      return "Values cluster around the mean, with the given standard deviation.";
    case "lognormal":
      return "Meanlog and sdlog are the mean and SD of the LOGGED values — not the arithmetic mean/SD of the values themselves. The values are always positive and right-skewed.";
    case "uniform":
      return "Every value between the minimum and maximum is equally likely.";
    case "binomial":
      return "Counts of successes in the given number of trials, each with the given probability — whole numbers from 0 to the number of trials.";
    case "poisson":
      return "Counts of events with the given mean (lambda) — whole numbers, 0 and up.";
    case "exponential":
      return "Waiting times with the given rate — the mean is 1 / rate, and most values are small with a long tail.";
  }
}

/** One line naming the simulation, for the created table's name and notes. */
export function simulationSummary(spec: SimulationSpec): string {
  const params =
    spec.distribution === "gaussian"
      ? `mean ${spec.mean ?? 0}, SD ${spec.sd ?? 1}`
      : spec.distribution === "lognormal"
        ? `meanlog ${spec.meanlog ?? 0}, sdlog ${spec.sdlog ?? 1}`
        : spec.distribution === "uniform"
          ? `${spec.min ?? 0} to ${spec.max ?? 1}`
          : spec.distribution === "binomial"
            ? `${spec.size ?? 1} trials, p = ${spec.prob ?? 0.5}`
            : spec.distribution === "poisson"
              ? `lambda ${spec.lambda ?? 1}`
              : `rate ${spec.rate ?? 1} (mean ${1 / (spec.rate ?? 1)})`;
  const shape =
    spec.tableType === "column"
      ? `${spec.datasets} dataset${spec.datasets === 1 ? "" : "s"}`
      : spec.tableType === "grouped"
        ? `${spec.datasets} group${spec.datasets === 1 ? "" : "s"}`
        : `${spec.datasets} Y series`;
  return `${spec.distribution === "gaussian" ? "Gaussian" : spec.distribution === "lognormal" ? "Lognormal" : spec.distribution === "uniform" ? "Uniform" : spec.distribution === "binomial" ? "Binomial" : spec.distribution === "poisson" ? "Poisson" : "Exponential"} (${params}), n = ${spec.n} × ${shape}, seed ${spec.seed}`;
}

/** The table's provenance note: what was simulated, and that the seed
 *  reproduces it exactly. Stored on the table so the .hlx file carries it. */
export function simulationNotes(spec: SimulationSpec): string {
  return `Simulated data: ${simulationSummary(spec)}. Same seed + same settings reproduce this table exactly.`;
}

/** Draw the values for `spec` and build the new table. Column: one column
 *  per dataset ("Simulated 1"…). Grouped: one group per dataset, one
 *  replicate each ("A:Y1"…). XY: X evenly spaced 1..n, one Y series per
 *  dataset ("Y1"…). Model-based XY simulation — Y around a fitted curve —
 *  is a follow-on: v1 simulates Y from the distribution only. */
export async function simulateTableData(spec: SimulationSpec): Promise<TableData> {
  const problem = validateSimulationSpec(spec);
  if (problem) throw new Error(problem);
  const values = await evalNumericVector(simulationRCode(spec));
  if (values.length !== spec.n * spec.datasets || values.some((v) => !Number.isFinite(v))) {
    throw new Error("The simulation did not return the expected values — try again.");
  }
  const at = (dataset: number, row: number) => formatSimulatedValue(values[dataset * spec.n + row]);
  const notes = simulationNotes(spec);
  if (spec.tableType === "grouped") {
    const base = newGroupedTable(spec.datasets, 1);
    return {
      ...base,
      rows: Array.from({ length: spec.n }, (_, r) => [
        null,
        ...Array.from({ length: spec.datasets }, (_, d) => at(d, r)),
      ]),
      notes,
    };
  }
  if (spec.tableType === "xy") {
    const columns = ["Title", "X", ...Array.from({ length: spec.datasets }, (_, d) => `Y${d + 1}`)];
    return {
      columns,
      rows: Array.from({ length: spec.n }, (_, r) => [
        null,
        String(r + 1),
        ...Array.from({ length: spec.datasets }, (_, d) => at(d, r)),
      ]),
      notes,
    };
  }
  const columns = ["Title", ...Array.from({ length: spec.datasets }, (_, d) => `Simulated ${d + 1}`)];
  return {
    columns,
    rows: Array.from({ length: spec.n }, (_, r) => [
      null,
      ...Array.from({ length: spec.datasets }, (_, d) => at(d, r)),
    ]),
    notes,
  };
}
