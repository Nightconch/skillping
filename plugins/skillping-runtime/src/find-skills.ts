import type { WorkflowPrototype } from "./domain.js";

export type DispatchTemplateData = {
  id: number;
  created_at: number;
  confirmed_at: number | null;
  confirmation_episode_count: number | null;
  confirmation_task_count: number | null;
  trigger_source: "realtime" | "history";
  prototype: WorkflowPrototype;
};

const explanationFor = (dispatch: DispatchTemplateData) => {
  if (dispatch.trigger_source === "history") {
    return "This recurring workflow was confirmed from the user-authorized import of the last 30 days of Codex history.";
  }
  if (dispatch.confirmation_episode_count && dispatch.confirmation_episode_count >= 5 && dispatch.confirmation_task_count && dispatch.confirmation_task_count >= 3) {
    return `This capability is relevant to the current work and has repeated ${dispatch.confirmation_episode_count} times during the preceding 30 days across ${dispatch.confirmation_task_count} Codex Tasks, as checked when this search was claimed.`;
  }
  return "This workflow was previously confirmed as recurring; this is a queued Dispatch for that Workflow.";
};

export function renderFindSkillsDispatch(template: string, dispatch: DispatchTemplateData) {
  const rendered = template
    .replaceAll("{integer_id}", String(dispatch.id))
    .replaceAll("{engine_generated_explanation}", explanationFor(dispatch))
    .replaceAll("{workflow_prototype_json}", JSON.stringify(dispatch.prototype, null, 2));
  if (!template || /\{(?:integer_id|engine_generated_explanation|workflow_prototype_json)\}/u.test(rendered)) {
    throw new Error("dispatch_template_unavailable");
  }
  return rendered;
}
