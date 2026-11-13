// "Simulate data…" (plan 22, sub-task a): a dialog that draws a new table of
// simulated values from a chosen distribution — Prism's Analyze → Simulate,
// landing as a NEW TABLE (raw and simulated data stay separate, auditable
// and re-analysable). The seed is stored on the table (see simulate.ts), so
// the same seed + settings reproduce it exactly. Model-based XY simulation
// (Y around a fitted curve) is a follow-on: v1 simulates Y from the
// distribution, with X evenly spaced 1..n.
import * as React from "react";
import { Button, Field, NumberInput, RadioList } from "../ui/controls";
import { Dialog } from "../ui/dialog";
import { useProjectStore } from "../store/use-project-store";
import {
  SIMULATION_DISTRIBUTIONS,
  SIMULATION_DISTRIBUTION_LABELS,
  type SimulationDistribution,
  type SimulationSpec,
} from "../stats/types";
import {
  distributionHint,
  simulateTableData,
  simulationSummary,
  validateSimulationSpec,
} from "../stats/simulation/simulate";

/** One numeric field of the dialog, by distribution. */
const PARAM_FIELDS: {
  distribution: SimulationDistribution;
  fields: { key: string; label: string; initial: number }[];
}[] = [
  {
    distribution: "gaussian",
    fields: [
      { key: "mean", label: "Mean", initial: 0 },
      { key: "sd", label: "Standard deviation", initial: 1 },
    ],
  },
  {
    distribution: "lognormal",
    fields: [
      { key: "meanlog", label: "Meanlog (mean of the logged values)", initial: 0 },
      { key: "sdlog", label: "Sdlog (SD of the logged values)", initial: 1 },
    ],
  },
  {
    distribution: "uniform",
    fields: [
      { key: "min", label: "Minimum", initial: 0 },
      { key: "max", label: "Maximum", initial: 1 },
    ],
  },
  {
    distribution: "binomial",
    fields: [
      { key: "size", label: "Number of trials", initial: 10 },
      { key: "prob", label: "Probability of success (0–1)", initial: 0.5 },
    ],
  },
  { distribution: "poisson", fields: [{ key: "lambda", label: "Lambda (mean)", initial: 1 }] },
  { distribution: "exponential", fields: [{ key: "rate", label: "Rate (mean = 1 / rate)", initial: 1 }] },
];

type ParamValues = Record<string, number | null>;

const DEFAULTS: Record<SimulationDistribution, ParamValues> = Object.fromEntries(
  PARAM_FIELDS.map(({ distribution, fields }) => [
    distribution,
    Object.fromEntries(fields.map((f) => [f.key, f.initial])),
  ]),
) as Record<SimulationDistribution, ParamValues>;

export function SimulateDataDialog() {
  const { selector, closeSelector, createSimulatedTable } = useProjectStore();
  const [distribution, setDistribution] = React.useState<SimulationDistribution>("gaussian");
  const [params, setParams] = React.useState<ParamValues>(DEFAULTS.gaussian);
  const [n, setN] = React.useState<number | null>(20);
  const [datasets, setDatasets] = React.useState<number | null>(1);
  const [seed, setSeed] = React.useState<number | null>(42);
  const [tableType, setTableType] = React.useState<"column" | "grouped" | "xy">("column");
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (selector?.kind !== "simulate-data") return null;

  const spec: SimulationSpec = {
    distribution,
    mean: params.mean ?? undefined,
    sd: params.sd ?? undefined,
    meanlog: params.meanlog ?? undefined,
    sdlog: params.sdlog ?? undefined,
    min: params.min ?? undefined,
    max: params.max ?? undefined,
    size: params.size ?? undefined,
    prob: params.prob ?? undefined,
    lambda: params.lambda ?? undefined,
    rate: params.rate ?? undefined,
    n: n ?? NaN,
    datasets: datasets ?? NaN,
    seed: seed ?? NaN,
    tableType,
  };
  const problem = validateSimulationSpec(spec);
  const fields = PARAM_FIELDS.find((p) => p.distribution === distribution)!.fields;

  const run = async () => {
    if (problem || running) return;
    setRunning(true);
    setError(null);
    try {
      const data = await simulateTableData(spec);
      createSimulatedTable(tableType, data);
      closeSelector();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog
      open
      onClose={running ? undefined : closeSelector}
      onReturn={!problem && !running ? () => void run() : undefined}
      title="Simulate data"
      description={error ?? problem ?? distributionHint(distribution)}
      footer={
        <Button variant="accent" disabled={!!problem || running} onClick={() => void run()}>
          {running ? "Simulating…" : "Simulate"}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <RadioList
          value={distribution}
          onChange={(d) => {
            setDistribution(d);
            setParams(DEFAULTS[d]);
            setError(null);
          }}
          options={SIMULATION_DISTRIBUTIONS.map((d) => ({ value: d, label: SIMULATION_DISTRIBUTION_LABELS[d] }))}
        />
        <div className="grid grid-cols-2 gap-2">
          {fields.map((f) => (
            <Field key={f.key} label={f.label}>
              <NumberInput
                value={params[f.key] ?? null}
                onChange={(v) => setParams((p) => ({ ...p, [f.key]: v }))}
              />
            </Field>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Values per dataset">
            <NumberInput value={n} onChange={setN} />
          </Field>
          <Field label={tableType === "xy" ? "Y series" : tableType === "grouped" ? "Groups" : "Datasets"}>
            <NumberInput value={datasets} onChange={setDatasets} />
          </Field>
          <Field label="Seed">
            <NumberInput value={seed} onChange={setSeed} />
          </Field>
        </div>
        <RadioList
          value={tableType}
          onChange={setTableType}
          options={[
            { value: "column" as const, label: "Column table (one column per dataset)" },
            { value: "grouped" as const, label: "Grouped table (one group per dataset)" },
            { value: "xy" as const, label: "XY table (X 1..n, one Y series per dataset)" },
          ]}
        />
        {!problem && <p className="text-small text-secondary">{simulationSummary(spec)}.</p>}
      </div>
    </Dialog>
  );
}
