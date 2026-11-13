// The workflow editor — hand-building a workflow, step by step. Pure
// operations on a Workflow value: each returns a new workflow (or an
// error), and each re-validates, so the editor can never save a workflow
// whose steps point at steps that are not there.
//
// The recordable vs hand-built balance is Smit's open question Q6
// (roadmap §6) — this module is the hand-built half, and it does not
// decide how much of a workflow should come from each side.

import { validateWorkflow, type ValidationIssue } from "./validate";
import type { Workflow, WorkflowStep, WorkflowTrigger } from "./types";

export type EditResult = { ok: true; workflow: Workflow; issues: ValidationIssue[] } | { ok: false; error: string };

const stepIds = (workflow: Workflow): Set<string> => new Set(workflow.steps.map((s) => s.id));

/** A step is referenced when another step reads its table, links its
 *  analysis, composes its graph, exports its node, or gates on it. */
function referencedBy(workflow: Workflow, stepId: string): string[] {
  const refs: string[] = [];
  for (const step of workflow.steps) {
    if (step.id === stepId) continue;
    switch (step.kind) {
      case "clean":
      case "analyze":
      case "graph":
        if (step.table.source === "import-step" && step.table.stepId === stepId) refs.push(step.id);
        if (step.kind === "graph" && step.links && Object.values(step.links).includes(stepId)) refs.push(step.id);
        break;
      case "figure":
        if (step.graphSteps.includes(stepId)) refs.push(step.id);
        break;
      case "export":
        if (step.targetStep === stepId) refs.push(step.id);
        break;
      case "branch": {
        const condStep = step.condition.step;
        if (condStep === stepId) refs.push(step.id);
        if (step.thenSteps.includes(stepId) || step.elseSteps?.includes(stepId)) refs.push(step.id);
        break;
      }
    }
  }
  return [...new Set(refs)];
}

const done = (workflow: Workflow): EditResult => ({
  ok: true,
  workflow,
  issues: validateWorkflow(workflow),
});

/** Append a step (or insert it after `afterId`). Step ids must be unique. */
export function addStep(workflow: Workflow, step: WorkflowStep, afterId?: string): EditResult {
  if (stepIds(workflow).has(step.id))
    return { ok: false, error: `Step id “${step.id}” is already used in this workflow.` };
  const steps = [...workflow.steps];
  if (afterId === undefined) {
    steps.push(step);
  } else {
    const at = steps.findIndex((s) => s.id === afterId);
    if (at === -1) return { ok: false, error: `No step is named “${afterId}”.` };
    steps.splice(at + 1, 0, step);
  }
  return done({ ...workflow, steps });
}

/** Remove a step. Refused while another step references it — remove the
 *  dependents first, so a workflow is never left pointing at thin air. */
export function removeStep(workflow: Workflow, stepId: string): EditResult {
  if (!stepIds(workflow).has(stepId)) return { ok: false, error: `No step is named “${stepId}”.` };
  const refs = referencedBy(workflow, stepId);
  if (refs.length)
    return {
      ok: false,
      error: `Step “${stepId}” is still used by ${refs.map((r) => `“${r}”`).join(", ")} — remove those steps first.`,
    };
  return done({ ...workflow, steps: workflow.steps.filter((s) => s.id !== stepId) });
}

/** Move a step to a new position. The result is re-validated — moving a
 *  step before a step it depends on is reported, not silently allowed. */
export function moveStep(workflow: Workflow, stepId: string, toIndex: number): EditResult {
  const from = workflow.steps.findIndex((s) => s.id === stepId);
  if (from === -1) return { ok: false, error: `No step is named “${stepId}”.` };
  if (toIndex < 0 || toIndex >= workflow.steps.length)
    return { ok: false, error: `Position ${toIndex} is outside this workflow (0–${workflow.steps.length - 1}).` };
  const steps = [...workflow.steps];
  const [moved] = steps.splice(from, 1);
  steps.splice(toIndex, 0, moved);
  return done({ ...workflow, steps });
}

/** Replace a step's fields (its id and kind stay). */
export function updateStep(workflow: Workflow, stepId: string, patch: Partial<WorkflowStep>): EditResult {
  const at = workflow.steps.findIndex((s) => s.id === stepId);
  if (at === -1) return { ok: false, error: `No step is named “${stepId}”.` };
  if (patch.id !== undefined && patch.id !== stepId)
    return { ok: false, error: "A step's id cannot change — other steps point at it." };
  if (patch.kind !== undefined && patch.kind !== workflow.steps[at].kind)
    return { ok: false, error: "A step's kind cannot change — remove it and add the step you want instead." };
  const steps = [...workflow.steps];
  steps[at] = { ...steps[at], ...patch } as WorkflowStep;
  return done({ ...workflow, steps });
}

/** Rename the workflow. */
export function renameWorkflow(workflow: Workflow, name: string): EditResult {
  if (!name.trim()) return { ok: false, error: "A workflow needs a name." };
  return done({ ...workflow, name });
}

/** Set (or clear) the workflow's triggers. */
export function setTriggers(workflow: Workflow, triggers: WorkflowTrigger | undefined): EditResult {
  if (triggers) return done({ ...workflow, triggers });
  const { triggers: _dropped, ...rest } = workflow;
  return done({ ...rest });
}
