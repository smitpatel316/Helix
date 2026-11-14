// Publishes this window's project to the Rust MCP server, so its read-only
// tools serve what is open — the same data the UI shows (see
// src-tauri/src/mcp.rs). The Rust side cannot read the TS store directly,
// so the frontend pushes a snapshot on every content change (debounced:
// typing a cell fires many revisions) and drops it when the window closes.
// A no-op where there is no native shell (web preview, tests).
import * as React from "react";
import { isNative, mcpPublishResult, mcpPublishSnapshot } from "../native";
import { useProjectStore } from "./use-project-store";

export function useMcpSnapshotPublisher() {
  const store = useProjectStore();
  // The store value is memoised on the state, so it changes identity on
  // every content change (edits, reorders, loads) and on nothing else that
  // matters — the snapshot is read fresh through get() at publish time.
  React.useEffect(() => {
    if (!isNative) return;
    const timer = setTimeout(() => {
      const s = store.get();
      void mcpPublishSnapshot({
        filePath: s.filePath,
        revision: s.revision,
        nodes: s.nodes,
        rootOrder: s.rootOrder,
        childOrder: s.childOrder,
        activeNodeId: s.activeNodeId,
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [store]);
  // A closed window's project leaves the server's list (its results go too).
  React.useEffect(
    () => () => {
      if (!isNative) return;
      void mcpPublishSnapshot({ closed: true }).catch(() => {});
    },
    [],
  );
}

/** An analysis outcome, for `titer_read_results` — called by the analysis
 *  view when its run lands (success or error). Only results computed in
 *  this session are ever served; nothing is invented for an unrun analysis. */
export function publishAnalysisResult(analysisId: string, outcome: unknown) {
  if (!isNative) return;
  void mcpPublishResult(analysisId, outcome).catch(() => {});
}
