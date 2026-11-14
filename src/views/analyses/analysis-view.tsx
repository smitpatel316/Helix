// Host for an analysis node: runs the chosen test on the parent table and
// renders the result.
import * as React from "react";
import type { ProjectNode } from "../../store/types";
import { useProjectStore } from "../../store/use-project-store";
import { Button } from "../../ui/controls";
import { Toolbar } from "../../ui/layout";
import { ANALYSES } from "../../stats";
import { cancelActiveEvals } from "../../stats/webr";
import { titleCase } from "../../lib/format";
import { AnalysisResultsView } from "./analysis-results-view";
import { useAnalysis, useRQueue } from "./use-analysis";
import { rQueueStatusText } from "../../stats/r-queue";

/** "1:23" for the elapsed running time. */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function AnalysisView({ node }: { node: ProjectNode }) {
  const { nodes } = useProjectStore();
  const data = node.parentId ? nodes[node.parentId]?.data : undefined;
  // Bumps to re-run the test after an error, a timeout or a cancel.
  const [retryNonce, setRetryNonce] = React.useState(0);
  const outcome = useAnalysis(node.analysisType, data, node.analysisParams, { retryKey: retryNonce });
  const queue = useRQueue();
  const running = Boolean(data && !outcome);
  const errored = Boolean(data && outcome && "error" in outcome);
  const [elapsedMs, setElapsedMs] = React.useState(0);
  React.useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => clearInterval(timer);
  }, [running]);

  return (
    <>
      <Toolbar title={node.name} tag={titleCase(ANALYSES[node.analysisType!].label)} />
      <div className="flex-1 overflow-auto">
        {outcome && !("error" in outcome) ? (
          <AnalysisResultsView result={outcome} />
        ) : (
          <div className="flex flex-col items-start gap-3 px-8 py-6">
            <p className="text-regular text-secondary">
              {!data
                ? "This analysis has no source table."
                : (outcome?.error ?? `Running… ${formatElapsed(elapsedMs)}${rQueueStatusText(queue)}`)}
            </p>
            {running && <Button onClick={() => cancelActiveEvals()}>Cancel</Button>}
            {errored && (
              <Button variant="accent" onClick={() => setRetryNonce((n) => n + 1)}>
                Retry
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
