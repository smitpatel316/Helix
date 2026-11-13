// Sharing — a workflow as a file, for export/import. One workflow per
// file, JSON, `.titer-workflow`. A file from a newer Titer (higher version)
// is refused rather than half-read; a file with structural issues is
// reported, not silently repaired.

import {
  WORKFLOW_FILE_EXTENSION,
  WORKFLOW_FILE_KIND,
  WORKFLOW_FILE_VERSION,
  type Workflow,
  type WorkflowFile,
} from "./types";
import { validateWorkflow, type ValidationIssue } from "./validate";

export { WORKFLOW_FILE_EXTENSION };

/** A workflow as shareable file text. */
export function serializeWorkflow(workflow: Workflow): string {
  const file: WorkflowFile = { kind: WORKFLOW_FILE_KIND, version: WORKFLOW_FILE_VERSION, workflow };
  return JSON.stringify(file, null, 2) + "\n";
}

export type ParseWorkflowResult =
  { ok: true; workflow: Workflow; issues: ValidationIssue[] } | { ok: false; error: string };

/**
 * Read a workflow file. `ok: true` with issues means the file parsed but
 * has structural problems — the caller must not run it until they are fixed.
 */
export function parseWorkflowFile(text: string): ParseWorkflowResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    return {
      ok: false,
      error: `Not a workflow file — it is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, error: "Not a workflow file — the top level must be an object." };
  const file = parsed as Record<string, unknown>;
  if (file.kind !== WORKFLOW_FILE_KIND)
    return { ok: false, error: `Not a workflow file — expected kind “${WORKFLOW_FILE_KIND}”.` };
  if (typeof file.version !== "number") return { ok: false, error: "Not a workflow file — it has no version." };
  if (file.version > WORKFLOW_FILE_VERSION)
    return {
      ok: false,
      error: `This workflow was saved by a newer Titer (version ${file.version}; this one reads up to ${WORKFLOW_FILE_VERSION}). Update Titer to open it.`,
    };
  if (file.version < WORKFLOW_FILE_VERSION)
    return {
      ok: false,
      error: `This workflow is version ${file.version} — this Titer only reads version ${WORKFLOW_FILE_VERSION}.`,
    };
  const issues = validateWorkflow(file.workflow);
  return { ok: true, workflow: file.workflow as Workflow, issues };
}
