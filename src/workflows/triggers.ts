// Triggers — the two v3 trigger points (roadmap §4a):
//  - one-click Run: just runWorkflow() (run.ts) — no code needed here;
//  - on-import: a workflow attached to a data shape runs when a matching
//    file is imported.
//
// Scheduled runs are Phase 5, not a v3 promise — there is no schedule
// trigger in this module, and validate.ts rejects one.

import { hasXColumn, type TableData, type TableType } from "../store/types";
import { readTable } from "../lib/dataset";
import type { Workflow } from "./types";

/** Whether this imported table matches the workflow's on-import trigger. */
export function matchesOnImport(workflow: Workflow, tableType: TableType, data: TableData): boolean {
  const trigger = workflow.triggers?.onImport;
  if (!trigger) return false;
  if (trigger.tableType !== undefined && trigger.tableType !== tableType) return false;
  const dataColumns = data.columns.length - 1;
  if (trigger.minColumns !== undefined && dataColumns < trigger.minColumns) return false;
  if (trigger.minRows !== undefined && data.rows.length < trigger.minRows) return false;
  if (trigger.requiresX) {
    if (!hasXColumn(tableType)) return false;
    const [first] = readTable(data).columns;
    if (!first || !first.values.length) return false;
  }
  return true;
}

/** The saved workflows whose on-import trigger matches this import, in
 *  the order they were saved. The app offers them (or runs them, per the
 *  researcher's setting) — matching is the engine's job, auto-running is
 *  the app's choice, and it always asks before a workflow writes anything
 *  the researcher did not ask for. */
export function workflowsForImport(workflows: Workflow[], tableType: TableType, data: TableData): Workflow[] {
  return workflows.filter((w) => matchesOnImport(w, tableType, data));
}
