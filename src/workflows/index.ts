// Workflows (v3, Phase 3) — the engine core.
//
// A workflow is a saved, reusable recipe of parameterized steps (import →
// clean → analyze → graph → export), each step one of the app's own
// operations, bound to data by structure and role. Record once from doing
// the work (record.ts) or hand-build it (editor.ts); replay it on matching
// data in one click or on import (run.ts, triggers.ts); share it as a file
// (serialize.ts). Steps that cannot bind fail clearly — nothing silent.
//
// Out of scope, by design (roadmap §4a, Smit Nov 13 ~10:10 PT): adaptive
// replay (fuzzy matching, header synonyms, unit conversion, learned
// mappings) and scheduled runs (Phase 5). The MCP tools run_workflow /
// draft_workflow call this engine later — this lane builds the engine only.

export * from "./types";
export { resolveColumnBinding, resolveParamBindings, checkTableShape } from "./binding";
export type { BindingResult } from "./binding";
export { validateWorkflow } from "./validate";
export type { ValidationIssue, ValidateOptions } from "./validate";
export { serializeWorkflow, parseWorkflowFile, WORKFLOW_FILE_EXTENSION } from "./serialize";
export type { ParseWorkflowResult } from "./serialize";
export { WorkflowRecorder, deriveBindings } from "./record";
export { runWorkflow, extractPValues, applyCleanOps } from "./run";
export type { WorkflowHost, RunOptions } from "./run";
export { matchesOnImport, workflowsForImport } from "./triggers";
export { addStep, removeStep, moveStep, updateStep, renameWorkflow, setTriggers } from "./editor";
export type { EditResult } from "./editor";
export { ELISA_DAY_WORKFLOW, ELISA_EXAMPLE_TABLE } from "./examples/elisa-day";
