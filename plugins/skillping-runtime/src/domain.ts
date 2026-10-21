import type { spawn } from "node:child_process";
import { z } from "zod";
import { recommendationPaceSchema, type RecommendationPace } from "./config.js";

export type StagePromptInput = {
  session_id: string;
  turn_id: string;
  prompt: string;
  cwd: string;
  model: string;
};

export type ClaimDispatchInput = {
  session_id: string;
  turn_id: string;
  stop_hook_active: boolean;
};

export const dispositionSchema = z.enum(["analyze", "control", "optout", "sensitive", "uncertain"]);
const binaryDispositionSchema = z.enum(["analyze", "skip"]);
export const relationSchema = z.enum(["new", "continue", "modify"]);
export const scopeSchema = z.enum(["project", "global"]);
export const confidenceSchema = z.enum(["low", "medium", "high"]);

export const observationItemSchema = z.object({
  relation: relationSchema,
  core_goal: z.string().min(1),
  input_roles: z.array(z.string().min(1)),
  output: z.string().min(1),
  essential_steps: z.array(z.string().min(1)).max(4),
  variables: z.array(z.string().min(1)),
  scope_hint: scopeSchema,
  confidence: confidenceSchema
}).strict();

export const workflowPrototypeSchema = z.object({
  core_goal: z.string().min(1),
  input_roles: z.array(z.string().min(1)),
  output: z.string().min(1),
  essential_steps: z.array(z.string().min(1)),
  variable_slots: z.array(z.string().min(1)),
  scope: scopeSchema
}).strict();

export const observationFingerprintSchema = z.object({
  core_goal: z.string().min(1),
  input_roles: z.array(z.string().min(1)),
  output: z.string().min(1),
  essential_steps: z.array(z.string().min(1)),
  scope: scopeSchema
}).strict();

export const historyExtractSchema = z.object({
  disposition: dispositionSchema,
  items: z.array(observationItemSchema).max(3)
}).strict().superRefine((value, context) => {
  if (value.disposition !== "analyze" && value.items.length !== 0) {
    context.addIssue({ code: "custom", message: "non-analyze disposition requires empty items" });
  }
});

export const capabilityItemSchema = workflowPrototypeSchema.extend({ confidence: confidenceSchema }).strict();
export const capabilityObservationItemSchema = observationItemSchema.extend({
  variables: observationItemSchema.shape.variables.optional(),
  capabilities: z.array(z.union([capabilityItemSchema, z.object({
    base: z.literal("work"),
    core_goal: z.string().min(1),
    scope: scopeSchema,
    confidence: confidenceSchema,
    input_roles: workflowPrototypeSchema.shape.input_roles.optional(),
    output: workflowPrototypeSchema.shape.output.optional(),
    essential_steps: workflowPrototypeSchema.shape.essential_steps.optional(),
    variable_slots: workflowPrototypeSchema.shape.variable_slots.optional()
  }).strict()])).max(3)
}).strict();
export const minimalCapabilityExtractSchema = z.object({
  phase: z.literal("extract"), schema_version: z.literal(6),
  session_id: z.string().min(1), turn_id: z.string().min(1),
  disposition: binaryDispositionSchema,
  items: z.array(capabilityObservationItemSchema.omit({ relation: true }).extend({
    capabilities: capabilityObservationItemSchema.shape.capabilities.length(1)
  })).max(1)
}).strict().superRefine((value, context) => {
  if (value.items.length !== (value.disposition === "analyze" ? 1 : 0)) {
    context.addIssue({ code: "custom", message: "analyze requires one item; skip requires empty items" });
  }
});

const capabilityDecisionSchema = z.object({
  request_id: z.string().min(1), kind: z.literal("capability"),
  review_reason: z.enum(["match", "confirm"]), verdict: z.enum(["same", "different", "uncertain"]),
  selected_workflow_id: z.number().int().positive().optional().describe("Copy a positive integer catalog workflow_id; required only for verdict=same, otherwise omit."),
  final_prototype: workflowPrototypeSchema.optional().describe("Only confirm+same permits a revised full prototype. Mutually exclusive with final_prototype_ref; omit both to inherit the selected frozen prototype."),
  final_prototype_ref: z.string().regex(/^c[1-9]\d*$/).optional().describe("For confirm+same, omit this and final_prototype to inherit the selected frozen prototype. Do not copy prototype_ref from a detail page: those opaque references are not accepted here. Legacy c1-style references only; mutually exclusive with final_prototype.")
}).strict().superRefine((value, context) => {
  if ((value.verdict === "same") !== (value.selected_workflow_id !== undefined)) {
    context.addIssue({ code: "custom", message: "same requires selected_workflow_id only" });
  }
  const prototypeChoices = Number(value.final_prototype !== undefined) + Number(value.final_prototype_ref !== undefined);
  if (prototypeChoices > (value.review_reason === "confirm" && value.verdict === "same" ? 1 : 0)) {
    context.addIssue({ code: "custom", message: "only confirm + same accepts one final prototype or reference" });
  }
});
const episodeDecisionSchema = z.union([
  z.strictObject({ request_id: z.string().min(1), kind: z.literal("episode"), review_reason: z.enum(["match", "confirm"]).optional(), verdict: z.literal("same"), selected_episode_id: z.number().int().positive() }),
  z.strictObject({ request_id: z.string().min(1), kind: z.literal("episode"), review_reason: z.enum(["match", "confirm"]).optional(), verdict: z.literal("uncertain") })
]);
// Transport accepts duplicate IDs so Runtime can discard just those decisions.
export const capabilityReviewTransportSchema = z.strictObject({
  phase: z.literal("review"), schema_version: z.literal(3),
  session_id: z.string().min(1), turn_id: z.string().min(1),
  review_set_id: z.string().trim().min(1).max(128).optional().describe("Echo review_required.review_set_id (1–128 characters); required for the current progressive review contract."),
  decisions: z.array(z.union([capabilityDecisionSchema, episodeDecisionSchema])).max(12).describe("At most 12 decisions, one per returned request_id; do not duplicate IDs or add requests.")
});

export const reviewEvidenceInputSchema = z.strictObject({
  review_set_id: z.string().trim().min(1).max(128).describe("Copy the current review_required.review_set_id exactly (1–128 characters)."),
  request_id: z.string().trim().min(1).max(128).describe("Copy the selected request_id from this review set exactly (1–128 characters)."),
  workflow_id: z.number().int().positive().optional().describe("Positive integer from this request's catalog; include for that Workflow's details, omit for catalog pages."),
  cursor: z.string().trim().min(1).max(128).optional().describe("For continuation, copy that page's next_cursor exactly (1–128 characters), keeping the same set/request/workflow. Omit only for the first page; catalog and detail cursors are separate."),
  limit: z.number().int().min(1).max(50).optional().describe("Optional integer 1–50. Prefer omitting it for budgeted paging; use next_cursor to continue."),
});
// Model output authoring additionally requires unique request IDs.
export const capabilityReviewSchema = capabilityReviewTransportSchema.superRefine((value, context) => {
  if (new Set(value.decisions.map(item => item.request_id)).size !== value.decisions.length) {
    context.addIssue({ code: "custom", message: "duplicate request_id" });
  }
});
export const observeTurnSchema = z.union([minimalCapabilityExtractSchema, capabilityReviewTransportSchema]);

export type Disposition = z.infer<typeof dispositionSchema>;
export type Relation = z.infer<typeof relationSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type ObservationItem = z.infer<typeof observationItemSchema>;
export type WorkflowPrototype = z.infer<typeof workflowPrototypeSchema>;
export type ObservationFingerprint = z.infer<typeof observationFingerprintSchema>;
export type MinimalCapabilityExtract = z.infer<typeof minimalCapabilityExtractSchema>;
export type CapabilityReview = z.infer<typeof capabilityReviewSchema>;
export type ObserveTurnInput = z.infer<typeof observeTurnSchema>;
export type ReviewEvidenceInput = z.infer<typeof reviewEvidenceInputSchema>;

export type ReviewCandidate = {
  workflow_id: number;
  score: number;
  prototype: WorkflowPrototype;
  snapshot?: {
    prototype_version: number;
    scope_kind: Scope;
    scope_value: string | null;
    state: "forming" | "confirmed" | "invalidated";
    suppression: "none" | "permanent";
    cooldown_until: number | null;
  };
  representatives: ObservationFingerprint[];
  evidence?: Array<{ episode_id: number; codex_task_id: string; started_at?: number; work: ObservationFingerprint; capability: WorkflowPrototype }>;
  proposed_evidence?: Array<{ episode_id: number; codex_task_id: string; work: ObservationFingerprint; capability: WorkflowPrototype }>;
  episode_count?: number;
  task_count?: number;
  pending_evidence?: Array<{ request_id: string; episode_candidates: number[]; codex_task_id: string; work: ObservationFingerprint; capability: WorkflowPrototype }>;
  withdrawn_evidence?: Array<{ request_id: string; episode_id: number; codex_task_id: string; work: ObservationFingerprint; capability: WorkflowPrototype }>;
};

export type CapabilityReviewRequest = {
  request_id: string;
  kind: "capability";
  review_reason: "match" | "confirm";
  capability: WorkflowPrototype;
  work: ObservationFingerprint;
  candidates: ReviewCandidate[];
  depends_on?: string;
  critical?: boolean;
  retrieval?: {
    total_candidates: number;
    full_candidate_count: number;
    has_more: boolean;
    next_cursor?: string;
  };
};

export type EpisodeReviewRequest = { request_id: string; kind: "episode"; work: ObservationFingerprint;
  candidates: Array<{ episode_id: number; work: ObservationFingerprint }> };
export type BatchReviewRequest = CapabilityReviewRequest | EpisodeReviewRequest;

export type ExtractReviewRequest = {
  review_reason: "match" | "confirm";
  candidates: [ReviewCandidate, ...ReviewCandidate[]];
};

export type CompactEvidenceCounts = Record<"established" | "possible" | "proposed" | "pending" | "withdrawn", {
  episodes: number;
  codex_tasks: number;
}>;

export type WorkflowCatalogItem = { workflow_id: number; description: string };

export type CompactReviewRequest =
  | { request_id: string; kind: "episode"; work_ref: string;
      candidates: Array<{ episode_id: number; work_ref: string }> }
  | { request_id: string; kind: "capability"; review_reason: "match" | "confirm";
      work_ref: string; capability_ref: string; depends_on?: string;
      catalog: { items: WorkflowCatalogItem[]; has_more: boolean; next_cursor?: string } };

export type BudgetExceededResult = {
  status: "budget_exceeded";
  estimated_payload_tokens: number;
  estimator_version: "byte_div_2_v1";
  budget_mode: "normal" | "critical";
  applicable_limit: 6144 | 12288;
  resolution: "uncertain";
};

export type ReviewRequiredResult = {
  status: "review_required";
  matching_source?: MatchingSource;
  refresh_reason?: "snapshot_stale";
  review_contract_version: 5;
  review_set_id: string;
  budget_mode?: "critical";
  definitions: { works: Record<string, ObservationFingerprint>; capabilities: Record<string, WorkflowPrototype> };
  requests: CompactReviewRequest[];
  rules: string;
  review_call: { phase: "review"; schema_version: 3; session_id: string; turn_id: string };
};

export type ReviewEvidenceFact = { evidence_ref: string; state: "established" | "proposed" | "pending" | "withdrawn";
  codex_task_id: string; work: ObservationFingerprint; capability: WorkflowPrototype };

export type WorkflowReviewPage = { status: "ok"; mode: "workflow"; review_set_id: string; request_id: string;
  workflow_id: number; revision: string; prototype_ref: string;
  definitions: { works: Record<string, ObservationFingerprint>; capabilities: Record<string, WorkflowPrototype> };
  counts: CompactEvidenceCounts; evidence: Array<Omit<ReviewEvidenceFact, "work" | "capability"> & { work_ref: string; capability_ref: string }>;
  has_more: boolean; next_cursor?: string; budget_mode?: "critical" };

export type ReviewEvidenceResult =
  | BudgetExceededResult
  | { status: "error"; code: "DB_BUSY"; retry_allowed: false; instructions: string }
  | ReviewRequiredResult
  | { status: "accepted"; deferred: Array<{ position: number; reason: string }> }
  | { status: "error"; code: "REVIEW_SET_UNAVAILABLE" | "REQUEST_MISMATCH" | "WORKFLOW_MISMATCH" |
      "CURSOR_MISMATCH" | "SNAPSHOT_STALE" | "CONTROL_STATE_INVALID" }
  | { status: "invalid"; code: "INVALID_INPUT"; field?: "limit"; retry_allowed?: boolean; instructions?: string }
  | WorkflowReviewPage
  | { status: "ok"; mode: "retrieval"; review_set_id: string; request_id: string;
      candidates: Array<{ episode_id: number; work: ObservationFingerprint } | WorkflowCatalogItem>;
      has_more: boolean; next_cursor?: string; budget_mode?: "critical" };

export type UserPromptHookResult =
  | Record<string, never>
  | { hookSpecificOutput: { hookEventName: "UserPromptSubmit"; additionalContext: string } };

export type StopHookResult = Record<string, never> | { decision: "block"; reason: string };

export const recommendationUnavailableReasonSchema = z.enum([
  "tools_missing", "guide_unreadable", "lookup_failed", "query_unsafe"
]).describe("Model-reported checked cause: tools_missing only after host tool discovery; guide_unreadable only after a failed guide read; lookup_failed only after required lookup fails or is denied; query_unsafe only when no safe public query can be formed. Do not infer failure from SQL/task execution restrictions or from not having tried.");

export const finishRecommendationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    recommendation_id: z.uuid().describe("Copy the UUID from recommendation_instructions.finish_call.arguments."), status: z.literal("completed"),
    recommendation_count: z.number().int().min(0).max(3).describe("Required only for completed: integer 0–3, counting suitable deduplicated choices including installed Skills."),
  }),
  z.strictObject({
    recommendation_id: z.uuid().describe("Copy the UUID from recommendation_instructions.finish_call.arguments."),
    status: z.literal("unavailable"), unavailable_reason: recommendationUnavailableReasonSchema,
  }),
  z.strictObject({
    recommendation_id: z.uuid().describe("Copy the UUID from recommendation_instructions.finish_call.arguments."),
    status: z.literal("no_improvement").describe("Only after complete bounded discovery and comparison: an actually applied core-task Skill satisfies the frozen capability and no candidate adds a concrete improvement. Permanently stops automatic recommendations for this capability and scope; never use for failed, incomplete or uncertain checks."),
    baseline_skill: z.string().max(160).regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?|[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*)$/)
      .describe("Required only for no_improvement: exact Skill name, plugin-qualified name, or observed owner/repo@skill actually applied to the core task. Installed, read, promised or auxiliary-only use is insufficient. No paths, source bodies or usage telemetry."),
  }),
]);
export type FinishRecommendationInput = z.infer<typeof finishRecommendationSchema>;
export type FinishRecommendationResult =
  | { status: "accepted" | "ignored" }
  | { status: "invalid"; code: "INVALID_INPUT" }
  | { status: "unavailable"; code: "RECOMMENDATION_FINISH_FAILED" };

export type MatchingSource = "decision_model" | "main_model_fallback";

export type ObserveTurnResult =
  | BudgetExceededResult
  | { status: "ignored" }
  | { status: "accepted"; disposition?: "skip"; deferred?: Array<{ position: number; reason: string }>; matching_source?: MatchingSource }
  | { status: "invalid"; code: "INVALID_INPUT" | "EVIDENCE_REQUIRED" | "PROMPT_EXCERPT"; retry_allowed: boolean }
  | { status: "unavailable"; code: "DB_BUSY" | "DB_CORRUPT" | "DB_UNAVAILABLE" | "KEY_TIMEOUT" | "KEY_UNREADABLE"; retry_allowed: boolean; instructions: string }
  | ReviewRequiredResult
  | { status: "review_required"; review_reason: "match" | "confirm"; candidates: ReviewCandidate[]; instructions: string };

const switchControlSchema = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("status") }),
  z.strictObject({ command: z.literal("help") }),
  z.strictObject({ command: z.literal("set_recommendation_pace"), pace: recommendationPaceSchema }),
  z.strictObject({ command: z.literal("enable_detection") }),
  z.strictObject({ command: z.literal("disable_detection") }),
  z.strictObject({ command: z.literal("enable_recommendations") }),
  z.strictObject({ command: z.literal("disable_recommendations") }),
  z.strictObject({ command: z.literal("retry_unverified_dispatch"), dispatch_id: z.number().int().positive() }),
  z.strictObject({ command: z.literal("import_history"), confirmed: z.boolean() }),
  z.strictObject({ command: z.literal("request_clear"), session_id: z.string().trim().min(1) }),
  z.strictObject({ command: z.literal("confirm_clear"), session_id: z.string().trim().min(1), confirmation_token: z.string().min(1) }),
  z.strictObject({ command: z.literal("skip_turn"), session_id: z.string().min(1), turn_id: z.string().min(1) }),
  z.strictObject({
    command: z.enum(["cooldown_workflow", "suppress_workflow", "invalidate_workflow", "cover_workflow", "reopen_covered_workflow"]),
    session_id: z.string().min(1),
    workflow_id: z.number().int().positive().optional(),
    dispatch_id: z.number().int().positive().optional()
  })
]);

export const controlSchema = switchControlSchema.superRefine((value, context) => {
  if ("workflow_id" in value && value.workflow_id !== undefined && value.dispatch_id !== undefined) {
    context.addIssue({ code: "custom", message: "provide at most one Workflow reference" });
  }
});

export type ControlInput = z.infer<typeof controlSchema>;

export type ScoutStatus = {
  detection_enabled: boolean;
  recommendation_enabled: boolean;
  recommendation_pace: RecommendationPace;
  health: { state: "healthy" | "degraded"; codes: import("./config.js").DiagnosticCode[] };
  import_state: "idle" | "running" | "paused" | "completed" | "unavailable";
  counts: {
    episodes: number;
    forming: number;
    confirmed: number;
    pending: number;
    blocked: number;
    cooldown: number;
    suppressed: number;
    invalidated: number;
  };
  payload_estimates_30d: PayloadEstimates30d;
};

export type PayloadEstimates30d = {
  review_payload_count: number;
  estimated_tokens_p50: number | null;
  estimated_tokens_p95: number | null;
  estimated_tokens_max: number | null;
  critical_payload_count: number;
  normal_limit_exceeded_count: number;
  critical_limit_exceeded_count: number;
  estimator_version: "byte_div_2_v1";
};

export type ControlResult = (
  | { status: "confirmation_required"; message: string; confirmation_token: string; expires_at: number }
  | { status: "ok"; message: string; summary?: ScoutStatus; help?: {
    recommendation_pace: RecommendationPace;
    window_days: number;
    paces: Array<{ id: RecommendationPace; label: string; description: string; min_occurrences: number; min_chats: number }>;
  } }
  | { status: "needs_context"; message: string }
  | { status: "unavailable"; code: string; message: string; summary?: ScoutStatus }
) & { onboarding?: "first_use" };

export type EngineDeps = {
  now: () => number;
  pluginRoot: string;
  dataDir: string;
  spawnProcess: typeof spawn;
  fetch?: typeof fetch;
};

export type PayloadMeasurementInput = {
  session_id: string;
  turn_id: string;
  phase: "extract" | "review" | "retry" | "evidence_expansion";
  result_status: string;
  payload: string;
  budget_mode: "unbudgeted" | "normal" | "critical";
  applicable_limit: number | null;
};

export type ScoutEngine = {
  stagePrompt(input: StagePromptInput): Promise<UserPromptHookResult>;
  observeTurn(input: ObserveTurnInput): Promise<ObserveTurnResult>;
  getReviewEvidence(input: unknown): Promise<ReviewEvidenceResult>;
  claimDispatch(input: ClaimDispatchInput): Promise<StopHookResult>;
  finishRecommendation(input: FinishRecommendationInput): Promise<FinishRecommendationResult>;
  control(input: ControlInput): Promise<ControlResult>;
};
