// "Not sure? Check with Shapiro-Wilk", offered on every Gaussian? wizard step.
// Runs the real test on the data sets chosen and reports a plain-language
// verdict. Resolves to the answer the wizard should proceed with, or null if
// the test couldn't run.
import { alert } from "../../native";
import { runAnalysis } from "../../stats";
import type { AnalysisOutcome } from "../../stats/types";
import { cancelActiveEvals } from "../../stats/webr";
import { pText } from "../../lib/format";
import type { TableData } from "../../store/types";

/**
 * `sets`: the data sets the test will run on (all by default).
 * `signal`: aborting it cancels the check — the in-flight R evaluation is
 * stopped (F14: the wizard's Cancel/Escape while the check runs) and the
 * check resolves null with NO alert, so a cancelled check is never reported
 * as a failed one and never shows a verdict the user did not wait for. The
 * abort listener lives only around the run itself: once the run has settled,
 * aborting no longer stops anything.
 */
export async function checkNormality(
  data: TableData,
  sets?: string[],
  opts?: { signal?: AbortSignal },
): Promise<boolean | null> {
  const signal = opts?.signal;
  // Already cancelled before the run started: never start R for it.
  if (signal?.aborted) return null;
  // The same stop the analysis view's Cancel button uses: without it the
  // await below would wait out the 5-minute eval watchdog even though the
  // user already left.
  const stop = () => cancelActiveEvals();
  signal?.addEventListener("abort", stop, { once: true });
  let outcome: AnalysisOutcome;
  try {
    outcome = await runAnalysis("shapiro-wilk", data, sets && { sets });
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  // Cancelled mid-run: the run settled with a cancel error (or finished just
  // as the user left) — either way, say nothing and return to the question.
  if (signal?.aborted) return null;
  if ("error" in outcome) {
    await alert("Couldn't Run the Shapiro-Wilk Test", outcome.error, "error");
    return null;
  }
  const rows = outcome.normality ?? [];
  // A data set the test can't take (too few values, or all identical) is said, not judged.
  const tested = rows.flatMap((r) => (r.p == null ? [] : [r.p]));
  const summary = rows
    .map((r) => `${r.group}: ${r.p == null ? "not tested (too few or identical values)" : pText(r.p)}`)
    .join("\n");
  if (!tested.length) {
    await alert("Couldn't Run the Shapiro-Wilk Test", summary, "error");
    return null;
  }
  const gaussian = tested.every((p) => p > 0.05);
  await alert(
    gaussian ? "Consistent with a Normal Distribution" : "Not Consistent with a Normal Distribution",
    `Shapiro-Wilk test\n${summary}`,
    "info",
  );
  return gaussian;
}
