// The ELISA-day example workflow (roadmap §4a).
//
// ILLUSTRATIVE — not verified against a real lab routine (roadmap §4a,
// open verification item 6: pin three real routines with researcher
// interviews, including Mansi, as a Phase 5 research item). The pipeline
// shape is the roadmap's: import the plate reader file → standard curve
// (4PL) → interpolate unknowns → t-test on groups → dose-response graph +
// bar graph → multi-panel figure → export 600 DPI PNG. Today that is
// ~20 minutes of clicks; as a workflow it is one click.
//
// The data below is a small representative plate-reader table, used only
// so the recorder can derive the workflow's role bindings (the dose
// column, the standard's response column, the unknown groups). The
// workflow file itself carries NO data — replay uses the run's input.

import { DEFAULT_GRAPH_OPTIONS, type TableData } from "../../store/types";
import type { AnalysisParams } from "../../stats/types";
import { WorkflowRecorder } from "../record";
import type { Workflow } from "../types";

/** A representative ELISA plate-reader table (standards + unknowns). */
export const ELISA_EXAMPLE_TABLE: TableData = {
  columns: ["Title", "Concentration", "Std", "Unknown A", "Unknown B"],
  rows: [
    ["Std 1", "0.01", "0.08", null, null],
    ["Std 2", "0.1", "0.22", null, null],
    ["Std 3", "1", "0.61", null, null],
    ["Std 4", "10", "1.42", null, null],
    ["Std 5", "100", "2.31", null, null],
    ["Std 6", "1000", "2.78", null, null],
    ["Unknown 1", null, null, "1.15", "0.94"],
    ["Unknown 2", null, null, "1.31", "1.02"],
    ["Unknown 3", null, null, "1.08", "0.87"],
    ["", null, null, null, null],
  ],
};

function buildElisaDay(): Workflow {
  const recorder = new WorkflowRecorder();
  const table = recorder.recordImport("xy", ELISA_EXAMPLE_TABLE, "plate-reader.csv");
  recorder.recordClean(table, [{ op: "drop-empty-rows" }]);

  // Standard curve: four-parameter logistic on the standards, interpolating
  // the unknowns (rows holding a Y but no X get the X the curve gives them).
  const standardCurve = recorder.recordAnalysis(
    table,
    "nonlinear-regression",
    {
      y: "Std",
      model: "sigmoidal-4pl-logx",
      interpolate: true,
    } satisfies AnalysisParams,
    ELISA_EXAMPLE_TABLE,
    "xy",
    "Interpolated standard curve",
  );

  // The two unknown groups, compared.
  const groups = recorder.recordAnalysis(
    table,
    "compare-two-groups",
    {
      sets: ["Unknown A", "Unknown B"],
      paired: false,
      gaussian: true,
      equalVariance: false,
      ratio: false,
      tails: "two-sided",
    } satisfies AnalysisParams,
    ELISA_EXAMPLE_TABLE,
    "xy",
  );

  // Dose-response curve, drawn from the standard-curve fit.
  const doseResponse = recorder.recordGraph(table, "logistic-curve", DEFAULT_GRAPH_OPTIONS, {
    regAnalysisId: standardCurve,
  });

  // The group bar graph only runs when the comparison is significant —
  // branching on the result, not on a guess. The branch comes before the
  // graph it gates, so its id is reserved first.
  const barsId = recorder.reserveId();
  recorder.recordBranch({ kind: "analysis-p-below", step: groups, threshold: 0.05 }, [barsId]);
  recorder.recordGraph(table, "xy-bar", DEFAULT_GRAPH_OPTIONS, undefined, barsId);

  const figure = recorder.recordFigure([doseResponse], { title: "ELISA day", dpi: "600" });
  recorder.recordExport(figure, "png", "600", "elisa-day.png");

  const recorded = recorder.finish(
    "ELISA day",
    "ILLUSTRATIVE — not verified against a real lab routine (roadmap §4a). Import the plate reader file → 4PL standard curve → interpolate unknowns → t-test on groups → dose-response graph (+ bar graph when significant) → figure → 600 DPI PNG.",
    {
      illustrative: true,
      triggers: { onImport: { tableType: "xy", minColumns: 2, requiresX: true } },
    },
  );
  return { ...recorded, id: "elisa-day" };
}

/** The ELISA-day pipeline as a saved example workflow. */
export const ELISA_DAY_WORKFLOW: Workflow = buildElisaDay();
