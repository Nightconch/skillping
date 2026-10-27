import { createHash } from "node:crypto";
import type {
  BatchReviewRequest,
  BudgetExceededResult,
  CompactEvidenceCounts,
  CompactReviewRequest,
  ObservationFingerprint,
  ReviewCandidate,
  ReviewEvidenceFact,
  WorkflowReviewPage,
  WorkflowPrototype,
} from "./domain.js";
import { measurePayloadText } from "./payload-metrics.js";
import { REVIEW_RULES } from "./model-guidance.js";

export const REVIEW_SOFT_TARGET = 4096;
export const REVIEW_NORMAL_LIMIT = 6144;
export const REVIEW_CRITICAL_LIMIT = 12288;

type BudgetRepresentative = { work_ref?: string; capability_ref?: string };
type BudgetCandidate = BudgetRepresentative;
type BudgetRequest = {
  kind?: string;
  review_reason?: string;
  depends_on?: string;
  work_ref?: string;
  capability_ref?: string;
  candidates?: BudgetCandidate[];
  retrieval?: { has_more?: boolean };
  catalog?: { items: unknown[]; has_more: boolean; next_cursor?: string };
};
type BudgetPayload = {
  status: string;
  requests?: BudgetRequest[];
  candidates?: BudgetCandidate[];
  has_more?: boolean;
  evidence?: BudgetRepresentative[];
  prototype_ref?: string;
  counts?: CompactEvidenceCounts;
  definitions?: {
    works?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
  };
  [key: string]: unknown;
};

const pruneDefinitions = (payload: BudgetPayload) => {
  if (!payload.definitions) return;
  const works = new Set<string>();
  const capabilities = new Set<string>();
  if (payload.prototype_ref) capabilities.add(payload.prototype_ref);
  for (const row of payload.evidence ?? []) {
    if (row.work_ref) works.add(row.work_ref);
    if (row.capability_ref) capabilities.add(row.capability_ref);
  }
  for (const request of payload.requests ?? []) {
    if (request.work_ref) works.add(request.work_ref);
    if (request.capability_ref) capabilities.add(request.capability_ref);
    for (const candidate of request.candidates ?? []) {
      if (candidate.work_ref) works.add(candidate.work_ref);
    }
  }
  const keep = (values: Record<string, unknown> | undefined, refs: Set<string>) =>
    Object.fromEntries(Object.entries(values ?? {}).filter(([ref]) => refs.has(ref)));
  payload.definitions.works = keep(payload.definitions.works, works);
  payload.definitions.capabilities = keep(payload.definitions.capabilities, capabilities);
};

const criticalPayload = (payload: BudgetPayload) =>
  payload.budget_mode === "critical" || payload.has_more === true || (payload.requests ?? []).some(request => request.kind === "episode" ||
    request.review_reason === "confirm" || request.depends_on !== undefined || request.retrieval?.has_more === true || request.catalog?.has_more === true) ||
  (payload.counts?.pending.episodes ?? 0) > 0 || (payload.counts?.withdrawn.episodes ?? 0) > 0;

export const reviewRequestBudgetMode = (request: BatchReviewRequest): "normal" | "critical" => request.kind === "episode" ||
  request.critical === true || request.review_reason === "confirm" || request.depends_on !== undefined ||
  request.retrieval?.has_more === true || request.candidates.some(candidate =>
    (candidate.pending_evidence?.length ?? 0) > 0 || (candidate.withdrawn_evidence?.length ?? 0) > 0)
  ? "critical" : "normal";

export function reviewPayloadBudget(input: unknown): {
  budgetMode: "normal" | "critical";
  applicableLimit: typeof REVIEW_NORMAL_LIMIT | typeof REVIEW_CRITICAL_LIMIT;
} | undefined {
  const payload = input as BudgetPayload;
  if (payload.status === "budget_exceeded" &&
      (payload.budget_mode === "normal" || payload.budget_mode === "critical") &&
      (payload.applicable_limit === REVIEW_NORMAL_LIMIT || payload.applicable_limit === REVIEW_CRITICAL_LIMIT)) {
    return { budgetMode: payload.budget_mode, applicableLimit: payload.applicable_limit };
  }
  if (payload.status !== "review_required" && payload.status !== "ok") return undefined;
  const budgetMode = criticalPayload(payload) ? "critical" as const : "normal" as const;
  return { budgetMode, applicableLimit: budgetMode === "critical" ? REVIEW_CRITICAL_LIMIT : REVIEW_NORMAL_LIMIT };
}

export function budgetReviewPayload<T>(input: T, forcedMode?: "normal" | "critical"): {
  payload: T | BudgetExceededResult;
  budgetMode: "normal" | "critical";
  applicableLimit: typeof REVIEW_NORMAL_LIMIT | typeof REVIEW_CRITICAL_LIMIT;
} {
  const payload = structuredClone(input) as T & BudgetPayload;
  const inferred = reviewPayloadBudget(payload);
  let budgetMode = forcedMode ?? inferred?.budgetMode ?? "normal";
  let applicableLimit: typeof REVIEW_NORMAL_LIMIT | typeof REVIEW_CRITICAL_LIMIT = budgetMode === "critical" ? REVIEW_CRITICAL_LIMIT : REVIEW_NORMAL_LIMIT;
  let measurement = measurePayloadText(JSON.stringify(payload));
  const pages = [
    ...(payload.requests ?? []).flatMap(request => request.catalog ? [{ rows: request.catalog.items, owner: request.catalog }] : []),
    ...(payload.status === "ok" && payload.mode === "retrieval" ? [{ rows: payload.candidates ?? [], owner: payload }] : []),
    ...(payload.evidence ? [{ rows: payload.evidence, owner: payload }] : []),
  ];
  // Keep complete units. Storage attaches the cursor after measuring the delivered prefix.
  while (measurement.estimatedTokens > REVIEW_SOFT_TARGET) {
    const page = pages.filter(page => page.rows.length > 1).sort((a, b) => b.rows.length - a.rows.length)[0];
    if (!page) break;
    page.rows.pop();
    page.owner.has_more = true;
    page.owner.next_cursor = "00000000-0000-0000-0000-000000000000";
    pruneDefinitions(payload);
    measurement = measurePayloadText(JSON.stringify(payload));
  }
  if (!forcedMode && criticalPayload(payload)) {
    budgetMode = "critical";
    applicableLimit = REVIEW_CRITICAL_LIMIT;
  }
  if (measurement.estimatedTokens > applicableLimit) return {
    payload: {
      status: "budget_exceeded" as const,
      estimated_payload_tokens: measurement.estimatedTokens,
      estimator_version: measurement.estimatorVersion,
      budget_mode: budgetMode,
      applicable_limit: applicableLimit,
      resolution: "uncertain" as const,
    },
    budgetMode,
    applicableLimit,
  };
  return { payload, budgetMode, applicableLimit };
}

const opaque = (prefix: string, ...parts: unknown[]) => `${prefix}_${createHash("sha256")
  .update(JSON.stringify(parts), "utf8").digest("base64url").slice(0, 22)}`;

export const reviewEvidenceRef = (reviewSetId: string, requestId: string, workflowId: number,
  episodeId: number, codexTaskId: string) => opaque("ev", reviewSetId, requestId, workflowId, episodeId, codexTaskId);

export const workflowCatalogItem = (candidate: ReviewCandidate) => ({ workflow_id: candidate.workflow_id,
  description: [candidate.prototype.core_goal, ...(candidate.prototype.essential_steps.length ?
    [`方法：${candidate.prototype.essential_steps.join("；")}`] : [])].join("；") });

export function reviewCandidateFacts(reviewSetId: string, requestId: string, candidate: ReviewCandidate): ReviewEvidenceFact[] {
  return [
    ...(candidate.evidence ?? []).map(row => ({ evidence_ref: reviewEvidenceRef(reviewSetId, requestId, candidate.workflow_id,
      row.episode_id, row.codex_task_id), state: "established" as const, codex_task_id: row.codex_task_id, work: row.work, capability: row.capability })),
    ...(["proposed", "pending", "withdrawn"] as const).flatMap(state => (candidate[`${state}_evidence`] ?? []).map(row => ({
      evidence_ref: opaque("ev", reviewSetId, requestId, candidate.workflow_id, state, row), state,
      codex_task_id: row.codex_task_id, work: row.work, capability: row.capability,
    }))),
  ];
}

export function buildWorkflowReviewPage(input: { reviewSetId: string; requestId: string; candidate: ReviewCandidate;
  facts: readonly ReviewEvidenceFact[]; hasMore: boolean; nextCursor?: string }): WorkflowReviewPage {
  const works: Record<string, ObservationFingerprint> = {}, capabilities: Record<string, WorkflowPrototype> = {};
  const define = <T>(prefix: string, values: Record<string, T>, value: T) => {
    const ref = opaque(prefix, input.reviewSetId, value);
    values[ref] = value;
    return ref;
  };
  const prototype_ref = define("c", capabilities, input.candidate.prototype);
  return { status: "ok", mode: "workflow", review_set_id: input.reviewSetId, request_id: input.requestId,
    workflow_id: input.candidate.workflow_id, revision: reviewCandidateRevision(input.candidate), prototype_ref,
    definitions: { works, capabilities }, counts: reviewCandidateCounts(input.candidate),
    evidence: input.facts.map(({ work, capability, ...row }) => ({ ...row,
      work_ref: define("w", works, work), capability_ref: define("c", capabilities, capability) })),
    has_more: input.hasMore, ...(input.nextCursor ? { next_cursor: input.nextCursor } : {}) };
}

export const reviewCandidateRevision = (candidate: ReviewCandidate) => opaque("rev", candidate.workflow_id,
  candidate.prototype, candidate.snapshot, reviewCandidateCounts(candidate), candidate.evidence,
  candidate.proposed_evidence, candidate.pending_evidence, candidate.withdrawn_evidence);

const evidenceCounts = (rows: readonly { episode_id: number; codex_task_id: string }[]) => ({
  episodes: new Set(rows.map(row => row.episode_id)).size,
  codex_tasks: new Set(rows.map(row => row.codex_task_id)).size,
});

export function reviewCandidateCounts(candidate: ReviewCandidate): CompactEvidenceCounts {
  const established = candidate.evidence ?? [];
  const proposed = candidate.proposed_evidence ?? [];
  const pending = candidate.pending_evidence ?? [];
  const withdrawn = candidate.withdrawn_evidence ?? [];
  const possibleRows = [...established, ...proposed, ...withdrawn];
  return {
    established: evidenceCounts(established),
    possible: {
      episodes: candidate.episode_count ?? evidenceCounts(possibleRows).episodes + pending.length,
      codex_tasks: candidate.task_count ?? new Set([...possibleRows.map(row => row.codex_task_id), ...pending.map(row => row.codex_task_id)]).size,
    },
    proposed: evidenceCounts(proposed),
    pending: { episodes: pending.length, codex_tasks: new Set(pending.map(row => row.codex_task_id)).size },
    withdrawn: evidenceCounts(withdrawn),
  };
}


export function buildCompactReviewPacket(input: {
  reviewSetId: string;
  sessionId: string;
  turnId: string;
  requests: readonly BatchReviewRequest[];
}) {
  const works: Record<string, ObservationFingerprint> = {};
  const capabilities: Record<string, WorkflowPrototype> = {};
  const references = new Map<string, string>();
  const define = <T>(prefix: string, values: Record<string, T>, value: T) => {
    const serialized = JSON.stringify(value);
    const key = `${prefix}\0${serialized}`;
    const prior = references.get(key);
    if (prior) return prior;
    const ref = `${prefix}${Object.keys(values).length + 1}`;
    values[ref] = value;
    references.set(key, ref);
    return ref;
  };

  const requests: CompactReviewRequest[] = input.requests.map(request => {
    const work_ref = define("w", works, request.work);
    if (request.kind === "episode") return {
      request_id: request.request_id,
      kind: request.kind,
      work_ref,
      candidates: request.candidates.map(candidate => ({
        episode_id: candidate.episode_id,
        work_ref: define("w", works, candidate.work),
      })),
    };
    return {
      request_id: request.request_id, kind: request.kind, review_reason: request.review_reason,
      work_ref, capability_ref: define("c", capabilities, request.capability),
      ...(request.depends_on ? { depends_on: request.depends_on } : {}),
      ...(request.scan ? { scan: request.scan } : {}),
      catalog: { items: request.candidates.map(workflowCatalogItem), has_more: false },
    };
  });

  return {
    status: "review_required" as const,
    review_contract_version: 5 as const,
    review_set_id: input.reviewSetId,
    ...(input.requests.some(request => reviewRequestBudgetMode(request) === "critical") ? { budget_mode: "critical" as const } : {}),
    definitions: { works, capabilities },
    requests,
    rules: REVIEW_RULES,
    review_call: { phase: "review" as const, schema_version: 3 as const, session_id: input.sessionId, turn_id: input.turnId },
  };
}
