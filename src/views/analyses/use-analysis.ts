// The outcome of a test on a table, for a view: runs it (runAnalysis shares one
// result per table version, so the analysis view and a graph's overlays reuse the
// same run) and re-runs it when the table or the params change.
import * as React from "react";
import { runAnalysis } from "../../stats";
import type { AnalysisOutcome, AnalysisParams, AnalysisType } from "../../stats/types";
import type { TableData } from "../../store/types";

/** null while running, or when there is nothing to run. `retryKey` re-runs
 *  the test on demand (the Retry button after an error, a timeout or a
 *  cancel — a failed run is not cached, so it runs again for real). */
export function useAnalysis(
  type: AnalysisType | undefined,
  data: TableData | undefined,
  params?: AnalysisParams,
  opts?: { retryKey?: unknown },
): AnalysisOutcome | null {
  const key = `${type} ${JSON.stringify(params ?? null)}`;
  const retryKey = opts?.retryKey;
  const [done, setDone] = React.useState<{ key: string; data: TableData; outcome: AnalysisOutcome } | null>(null);

  React.useEffect(() => {
    if (!type || !data) return;
    let current = true;
    // A new run starts: drop the previous outcome (an error, after Retry)
    // so the view shows "Running…" instead of the stale error meanwhile.
    setDone(null);
    void runAnalysis(type, data, params).then((outcome) => current && setDone({ key, data, outcome }));
    return () => {
      current = false;
    };
  }, [type, data, key, retryKey]);

  return done && done.key === key && done.data === data ? done.outcome : null;
}
