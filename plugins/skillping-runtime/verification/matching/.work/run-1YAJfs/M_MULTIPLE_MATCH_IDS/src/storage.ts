import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { hasPromptExcerpt } from "./privacy.js";
import type { MatchingSource } from "./domain.js";
import { capabilityItemSchema, capabilityReviewTransportSchema, workflowPrototypeSchema, finishRecommendationSchema, recommendationUnavailableReasonSchema, type FinishRecommendationInput, type BatchReviewRequest, type BudgetExceededResult, type EpisodeReviewRequest, type CapabilityReview, type CapabilityReviewRequest, type Confidence, type ObservationFingerprint, type PayloadEstimates30d, type ReviewEvidenceInput, type ReviewEvidenceResult, type ReviewRequiredResult, type WorkflowPrototype } from "./domain.js";
import { chooseMatch, scoreWorkflow, workspaceKey, type MatchDecision } from "./matcher.js";
import { budgetReviewPayload, buildCompactReviewPacket, buildWorkflowReviewPage, reviewCandidateFacts, workflowCatalogItem, reviewRequestBudgetMode } from "./review-packet.js";
import { emptyPayloadEstimates, measurePayloadText } from "./payload-metrics.js";
import { RECOMMENDATION_PACES, RECOMMENDATION_WINDOW_DAYS, type RecommendationPace } from "./config.js";

type StorageCode = "DB_BUSY" | "DB_CORRUPT" | "DB_UNAVAILABLE";
const BUSY_RETRY_DELAY_MS = 25;
const WORKFLOW_WINDOW_MS = RECOMMENDATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const REVIEW_SET_TTL_MS = 10 * 60 * 1000;
export const MATCH_REVIEW_MAX_BYTES = 256 * 1024;
const MATCH_BATCH_SIZE = 5;
// Outlives the 20s Stop budget so concurrent readers cannot retire a live claim.
export const DISPATCH_CLAIM_TIMEOUT_MS = 30_000;
// Host search and bounded body reading happen between tool calls; expiry is checked lazily.
export const WEB_RECOMMENDATION_TIMEOUT_MS = 10 * 60_000;
// Include existing aggregate failures; checked causes share their retention and retry limits.
const RETRYABLE_DISPATCH_ERRORS_SQL = ["search_unavailable", "dispatch_interrupted",
  ...recommendationUnavailableReasonSchema.options.map(reason => `search_unavailable:${reason}`)]
  .map(code => `'${code}'`).join(",");

export class StorageError extends Error {
  readonly code: StorageCode;

  constructor(code: StorageCode) {
    super(code);
    this.code = code;
  }
}

export type ObservationRecord = {
  codex_task_id: string;
  turn_id: string;
  message_id: string;
  source: "realtime" | "history";
  occurred_at: number;
  expires_at: number;
  workspace_path?: string;
  attachment_types?: string[];
  prompt: string;
  recommendation_enabled?: boolean;
  observations: Array<{
    relation: "new" | "continue" | "modify";
    confidence?: Confidence;
    capabilities?: Array<WorkflowPrototype & { confidence: Confidence }>;
    variable_slots?: string[];
    fingerprint: {
      core_goal: string;
      input_roles: string[];
      output: string;
      essential_steps: string[];
      scope: "global" | "project";
    };
  }>;
};

export type ObservationResult = {
  prompt_id: number;
  created: boolean;
  matching_source?: MatchingSource;
  deferred?: Array<{ position: number; reason: string }>;
  budget_exceeded?: BudgetExceededResult;
  review?: { review_set_id: string; expires_at: number; requests: BatchReviewRequest[]; payload: ReviewRequiredResult };
};

export type StorageStatusCounts = {
  episodes: number;
  forming: number;
  confirmed: number;
  pending: number;
  blocked: number;
  cooldown: number;
  suppressed: number;
  invalidated: number;
};

export type WorkflowFeedback = "cooldown" | "suppress" | "invalidate" | "cover" | "reopen_covered";

export type DispatchBlockReason = "find_skills_missing" | "find_skills_disabled" | "readiness_unavailable";

export type DispatchClaim = {
  id: number;
  recommendation_id?: string;
  workflow_id: number;
  created_at: number;
  confirmed_at: number | null;
  confirmation_episode_count: number | null;
  confirmation_task_count: number | null;
  trigger_source: "realtime" | "history";
  blocked_before: boolean;
  prototype: WorkflowPrototype;
};

export type ObservationControls = { detectionEnabled: boolean; recommendationEnabled: boolean };

export type PreparedDecisionMatch = {
  token: string;
  expiresAt: number;
  work: ObservationFingerprint;
  capability: WorkflowPrototype;
  candidates: Array<{ workflow_id: number; prototype: WorkflowPrototype }>;
};
export type DecisionMatchOutcome =
  | { source: "decision_model"; matchedWorkflowIds: number[]; runnerUpWorkflowId?: number }
  | { source: "main_model_fallback" };

export type PayloadMeasurement = {
  codexTaskId: string;
  turnId: string;
  occurredAt: number;
  expiresAt: number;
  phase: "extract" | "review" | "retry" | "evidence_expansion";
  resultStatus: string;
  payloadBytes: number;
  estimatedTokens: number;
  estimatorVersion: "byte_div_2_v1";
  budgetMode: "unbudgeted" | "normal" | "critical";
  applicableLimit: number | null;
};

export type Storage = {
  recordPayloadMeasurement(value: PayloadMeasurement): Promise<boolean>;
  recordObservation(value: ObservationRecord, readControls?: () => Promise<ObservationControls>): Promise<ObservationResult | undefined>;
  prepareDecisionMatch(value: ObservationRecord, readControls: () => Promise<ObservationControls>): Promise<PreparedDecisionMatch | undefined>;
  finalizeDecisionMatch(token: string, outcome: DecisionMatchOutcome, readControls: () => Promise<ObservationControls>): Promise<ObservationResult | "stale" | undefined>;
  getReviewEvidence(value: ReviewEvidenceInput, readControls: () => Promise<ObservationControls>, onStale?: () => Promise<ReviewEvidenceResult>): Promise<ReviewEvidenceResult>;
  refreshReview(reviewSetId: string, readControls: () => Promise<ObservationControls>): Promise<ReviewRequiredResult | BudgetExceededResult | undefined>;
  resolveReview(value: CapabilityReview, readControls: () => Promise<ObservationControls>): Promise<boolean | "invalid" | "evidence_required" | "stale" | ReviewRequiredResult | BudgetExceededResult>;
  discardReview(sessionId: string, turnId: string): Promise<void>;
  applyWorkflowFeedback(value: { action: WorkflowFeedback; codexTaskId: string; workflowId?: number; dispatchId?: number; changedAt: number }): Promise<boolean | "user_refusal" | "not_covered">;
  cancelOpenDispatches(finishedAt: number): Promise<void>;
  retryUnverifiedDispatch(dispatchId: number, at: number): Promise<boolean>;
  claimDispatch(value: { codexTaskId: string; turnId: string; cwd: string; claimedAt: number; recommendation?: "web" }): Promise<DispatchClaim | undefined>;
  finishRecommendation(value: FinishRecommendationInput & { finishedAt: number; dispatchEnabled: () => Promise<boolean> }): Promise<boolean>;
  interruptRecommendation(value: { codexTaskId: string; turnId: string; finishedAt: number }): Promise<void>;
  blockDispatch(value: { dispatchId: number; codexTaskId: string; turnId: string; cwd: string; reason: DispatchBlockReason; finishedAt: number; dispatchEnabled: () => Promise<boolean> }): Promise<boolean>;
  failDispatch(value: { dispatchId: number; codexTaskId: string; turnId: string; errorCode: string; finishedAt: number }): Promise<boolean>;
  completeDispatch(value: { dispatchId: number; codexTaskId: string; turnId: string; cwd: string; finishedAt: number; dispatchEnabled: () => Promise<boolean>; searchResultCount: number }): Promise<boolean>;
  getStatusCounts(): Promise<StorageStatusCounts>;
  getPayloadEstimates30d(): Promise<PayloadEstimates30d>;
  getPrompt(promptId: number): string;
  isOpen(): boolean;
  ensureOpen(): void;
  release(): void;
  close(): void;
};

type WorkflowRow = {
  id: number;
  scope_kind: "global" | "project";
  scope_value: string | null;
  state: "forming" | "confirmed" | "invalidated";
  prototype_json: string;
  prototype_version: number;
  representatives_json: string;
  suppression: "none" | "permanent";
  recommendation_silenced_by: string | null;
  cooldown_until: number | null;
  updated_at: number;
};

export function meetsThreshold(counts: { episode_count: number; task_count: number }, pace: RecommendationPace = "balanced") {
  const conditions = RECOMMENDATION_PACES[pace];
  return counts.episode_count >= conditions.min_occurrences && counts.task_count >= conditions.min_chats;
}

function storageCode(error: unknown): StorageCode {
  const text = `${(error as { code?: unknown })?.code ?? ""} ${(error as Error)?.message ?? ""}`.toLowerCase();
  if (text.includes("busy") || text.includes("locked")) return "DB_BUSY";
  if (text.includes("corrupt") || text.includes("malformed") || text.includes("not a database")) return "DB_CORRUPT";
  return "DB_UNAVAILABLE";
}

function recoverDispatches(db: DatabaseSync, now: number) {
  db.prepare(`UPDATE dispatches SET state = 'failed', error_code = 'dispatch_interrupted', finished_at = ?
    WHERE state = 'dispatching' AND (claimed_at IS NULL OR claimed_at <= ? - CASE
      WHEN EXISTS (SELECT 1 FROM recommendation_requests r WHERE r.dispatch_id=dispatches.id) THEN ? ELSE ? END)`)
    .run(now, now, WEB_RECOMMENDATION_TIMEOUT_MS, DISPATCH_CLAIM_TIMEOUT_MS);
}

function schema(db: DatabaseSync, now: number) {
  const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  if (![0, 6].includes(version)) throw new StorageError("DB_UNAVAILABLE");
  if (version === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()) {
    throw new StorageError("DB_UNAVAILABLE");
  }
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 250;");
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY,
      codex_task_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK (source IN ('realtime', 'history')),
      occurred_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      workspace_path TEXT,
      attachment_types_json TEXT,
      body TEXT NOT NULL,
      UNIQUE (codex_task_id, turn_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS workflows (
      id INTEGER PRIMARY KEY,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project')),
      scope_value TEXT,
      state TEXT NOT NULL CHECK (state IN ('forming', 'confirmed', 'invalidated')),
      prototype_json TEXT NOT NULL,
      prototype_version INTEGER NOT NULL,
      representatives_json TEXT NOT NULL,
      confirmation_episode_count INTEGER,
      confirmation_task_count INTEGER,
      confirmed_at INTEGER,
      last_seen_at INTEGER NOT NULL,
      cooldown_until INTEGER,
      suppression TEXT NOT NULL CHECK (suppression IN ('none', 'permanent')),
      muted_at INTEGER,
      invalidated_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY,
      codex_task_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY,
      prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2),
      relation TEXT NOT NULL CHECK (relation IN ('new', 'continue', 'modify')),
      fingerprint_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      variables_json TEXT NOT NULL DEFAULT '[]',
      extractor_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (prompt_id, position)
    );
    CREATE TABLE IF NOT EXISTS dispatches (
      id INTEGER PRIMARY KEY,
      workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      triggered_by_episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
      trigger_source TEXT NOT NULL CHECK (trigger_source IN ('realtime', 'history')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'blocked', 'dispatching', 'dispatched', 'failed', 'cancelled')),
      claimed_codex_task_id TEXT,
      claimed_turn_id TEXT,
      prompt_template_version INTEGER NOT NULL,
      blocked_reason TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER,
      finished_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_dispatch_per_workflow
      ON dispatches(workflow_id) WHERE state IN ('pending', 'blocked', 'dispatching');
    CREATE TABLE IF NOT EXISTS dispatch_search_receipts (
      dispatch_id INTEGER PRIMARY KEY REFERENCES dispatches(id) ON DELETE CASCADE,
      completed_at INTEGER NOT NULL,
      result_count INTEGER NOT NULL CHECK (result_count BETWEEN 0 AND 5)
    );
    CREATE TABLE IF NOT EXISTS dispatch_turn_receipts (
      codex_task_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY (codex_task_id, turn_id)
    );
    CREATE TABLE IF NOT EXISTS recommendation_requests (
      id TEXT PRIMARY KEY,
      dispatch_id INTEGER NOT NULL UNIQUE REFERENCES dispatches(id) ON DELETE CASCADE,
      cwd TEXT NOT NULL,
      prototype_json TEXT NOT NULL,
      completed_at INTEGER,
      recommendation_count INTEGER CHECK (recommendation_count BETWEEN 0 AND 3),
      CHECK ((completed_at IS NULL AND recommendation_count IS NULL) OR
        (completed_at IS NOT NULL AND recommendation_count IS NOT NULL))
    );
  `);
  if (!db.prepare("PRAGMA table_info(workflows)").all().some(column => column.name === "suppression_reason")) {
    db.exec("ALTER TABLE workflows ADD COLUMN suppression_reason TEXT CHECK (suppression_reason IN ('user', 'covered'));");
  }
  db.exec("UPDATE workflows SET suppression_reason = 'user' WHERE suppression = 'permanent' AND suppression_reason IS NULL;");
  if (!db.prepare("PRAGMA table_info(workflows)").all().some(column => column.name === "recommendation_silenced_by")) {
    db.exec("ALTER TABLE workflows ADD COLUMN recommendation_silenced_by TEXT CHECK (length(recommendation_silenced_by) BETWEEN 1 AND 160);");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_workflows (
      episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      capability_json TEXT NOT NULL,
      relevance_order INTEGER NOT NULL CHECK(relevance_order BETWEEN 0 AND 2),
      PRIMARY KEY (episode_id, workflow_id)
    );
    CREATE INDEX IF NOT EXISTS episode_workflows_by_workflow ON episode_workflows(workflow_id, episode_id);
  `);

  db.exec(`CREATE TABLE IF NOT EXISTS payload_measurements (
    id INTEGER PRIMARY KEY,
    codex_task_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('extract', 'review', 'retry', 'evidence_expansion')),
    call_sequence INTEGER NOT NULL CHECK (call_sequence > 0),
    result_status TEXT NOT NULL CHECK (length(result_status) BETWEEN 1 AND 64),
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
    estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
    estimator_version TEXT NOT NULL CHECK (estimator_version = 'byte_div_2_v1'),
    budget_mode TEXT NOT NULL CHECK (budget_mode IN ('unbudgeted', 'normal', 'critical')),
    applicable_limit INTEGER CHECK (
      (budget_mode = 'unbudgeted' AND applicable_limit IS NULL) OR
      (budget_mode != 'unbudgeted' AND applicable_limit >= 0)
    ),
    UNIQUE (codex_task_id, turn_id, call_sequence)
  );`);
  if (db.prepare("PRAGMA foreign_key_check").all().length) throw new StorageError("DB_CORRUPT");
  db.exec("PRAGMA user_version = 6; COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
  // Adopt retained claims from installations predating durable turn receipts.
  db.prepare(`INSERT OR IGNORE INTO dispatch_turn_receipts (codex_task_id, turn_id, claimed_at)
    SELECT claimed_codex_task_id, claimed_turn_id, MAX(claimed_at) FROM dispatches
    WHERE claimed_codex_task_id IS NOT NULL AND claimed_turn_id IS NOT NULL AND claimed_at > ?
    GROUP BY claimed_codex_task_id, claimed_turn_id`).run(now - WORKFLOW_WINDOW_MS);
  recoverDispatches(db, now);
}

export async function openStorage(options: { filename: string; now: () => number; recommendationPace?: () => RecommendationPace }): Promise<Storage> {
  const meetsCurrentThreshold = (counts: { episode_count: number; task_count: number }) =>
    meetsThreshold(counts, options.recommendationPace?.() ?? "balanced");
  let initializedSchemaVersion: number | undefined;
  const openOnce = () => {
    let opened: DatabaseSync | undefined;
    try {
      opened = new DatabaseSync(options.filename);
      opened.exec("PRAGMA busy_timeout = 250;");
      const version = Number(opened.prepare("PRAGMA user_version").get()!.user_version);
      const structure = Number(opened.prepare("PRAGMA schema_version").get()!.schema_version);
      // Idle evidence reads must not acquire a migration write lock for an unchanged, validated schema.
      if (version === 6 && structure === initializedSchemaVersion &&
          opened.prepare("PRAGMA journal_mode").get()!.journal_mode === "wal") {
        opened.exec("PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
        if (opened.prepare("PRAGMA foreign_key_check").all().length) throw new StorageError("DB_CORRUPT");
      } else {
        schema(opened, options.now());
        initializedSchemaVersion = Number(opened.prepare("PRAGMA schema_version").get()!.schema_version);
      }
      return opened;
    } catch (error) {
      opened?.close();
      throw new StorageError(storageCode(error));
    }
  };
  let opened: DatabaseSync | undefined;
  try {
    opened = openOnce();
  } catch (error) {
    if (!(error instanceof StorageError) || error.code !== "DB_BUSY") throw error;
    await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
    opened = openOnce();
  }

  let nextCleanupAt = 0;
  let cleanupDataVersion: number | undefined;
  let closed = false;
  const db = new Proxy({} as DatabaseSync, { get(_target, property) {
    if (closed) throw new StorageError("DB_UNAVAILABLE");
    const current = opened ??= openOnce();
    const value = Reflect.get(current, property, current);
    return typeof value === "function" ? value.bind(current) : value;
  } });
  const cleanupMeasurements = (now: number) => {
    db.prepare("DELETE FROM payload_measurements WHERE expires_at <= ? OR occurred_at <= ?").run(now, now - WORKFLOW_WINDOW_MS);
  };
  const cleanup = () => {
    const now = options.now();
    if (closed) return;
    let active = false;
    try {
      const dataVersion = Number(db.prepare("PRAGMA data_version").get()!.data_version);
      if (now < nextCleanupAt && dataVersion === cleanupDataVersion) return;
      db.exec("BEGIN IMMEDIATE");
      active = true;
      recoverDispatches(db, now);
      cleanupMeasurements(now);
      db.prepare("DELETE FROM dispatch_turn_receipts WHERE claimed_at <= ?").run(now - WORKFLOW_WINDOW_MS);
      db.prepare("DELETE FROM prompts WHERE expires_at <= ? OR occurred_at <= ?").run(now, now - WORKFLOW_WINDOW_MS);
      db.prepare("DELETE FROM episodes WHERE last_seen_at <= ? AND NOT EXISTS (SELECT 1 FROM observations WHERE episode_id = episodes.id)").run(now - WORKFLOW_WINDOW_MS);
      db.prepare("DELETE FROM workflows WHERE state IN ('forming', 'invalidated') AND suppression != 'permanent' AND recommendation_silenced_by IS NULL AND last_seen_at <= ?").run(now - WORKFLOW_WINDOW_MS);
      db.prepare(`DELETE FROM dispatches WHERE state IN ('dispatched', 'failed', 'cancelled')
        AND NOT (COALESCE(error_code, '') IN (${RETRYABLE_DISPATCH_ERRORS_SQL}) AND finished_at > ?) AND id NOT IN (
        SELECT d.id FROM dispatches d WHERE d.state IN ('dispatched', 'failed', 'cancelled') AND NOT EXISTS (
          SELECT 1 FROM dispatches newer WHERE newer.workflow_id = d.workflow_id AND newer.state IN ('dispatched', 'failed', 'cancelled')
          AND (COALESCE(newer.finished_at, newer.created_at) > COALESCE(d.finished_at, d.created_at)
            OR (COALESCE(newer.finished_at, newer.created_at) = COALESCE(d.finished_at, d.created_at) AND newer.id > d.id))))`).run(now - 3_600_000);
      db.prepare("DELETE FROM episode_workflows WHERE episode_id IN (SELECT id FROM episodes WHERE started_at <= ?)").run(now-WORKFLOW_WINDOW_MS);
      for (const row of db.prepare("SELECT id FROM workflows").all()) {
        const representatives = db.prepare(`SELECT o.fingerprint_json FROM episode_workflows ew JOIN observations o ON o.id=ew.observation_id
          WHERE ew.workflow_id=? ORDER BY o.created_at DESC, o.id DESC LIMIT 3`).all(row.id!);
        db.prepare("UPDATE workflows SET representatives_json=? WHERE id=?").run(JSON.stringify(representatives.map(item => JSON.parse(String(item.fingerprint_json)))), row.id!);
      }
      for (const row of db.prepare("SELECT id, representatives_json FROM workflows WHERE state = 'confirmed' OR suppression = 'permanent'").all()) {
        const values = JSON.parse(String(row.representatives_json)) as unknown[];
        if (values.length > 3) db.prepare("UPDATE workflows SET representatives_json = ? WHERE id = ?").run(JSON.stringify(values.slice(0, 3)), row.id!);
      }
      const next = db.prepare(`SELECT MIN(at) AS at FROM (
        SELECT MIN(expires_at, occurred_at + ?) AS at FROM prompts
        UNION ALL SELECT last_seen_at + ? FROM workflows WHERE state != 'confirmed' AND suppression != 'permanent' AND recommendation_silenced_by IS NULL
        UNION ALL SELECT claimed_at + CASE WHEN EXISTS (SELECT 1 FROM recommendation_requests r
          WHERE r.dispatch_id=dispatches.id) THEN ${WEB_RECOMMENDATION_TIMEOUT_MS} ELSE ? END FROM dispatches WHERE state = 'dispatching'
        UNION ALL SELECT claimed_at + ? FROM dispatch_turn_receipts
        UNION ALL SELECT expires_at FROM payload_measurements)`)
        .get(WORKFLOW_WINDOW_MS, WORKFLOW_WINDOW_MS, DISPATCH_CLAIM_TIMEOUT_MS, WORKFLOW_WINDOW_MS) as { at: number | null };
      db.exec("COMMIT");
      active = false;
      nextCleanupAt = next.at ?? Infinity;
      cleanupDataVersion = dataVersion;
      // Best effort: a concurrent SQLite reader can keep WAL pages pinned.
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    } catch {
      if (active) { try { db.exec("ROLLBACK"); } catch {} }
      // Logical predicates below remain authoritative if physical deletion fails.
    }
  };
  const parseFingerprint = (value: string) => JSON.parse(value) as ObservationFingerprint;
  const parsePrototype = (value: string) => JSON.parse(value) as WorkflowPrototype;
  // Literal conditions can be case-, Unicode-, and whitespace-sensitive. Any change needs review.
  const capabilityKey = (value: WorkflowPrototype) => JSON.stringify([value.core_goal,value.input_roles,value.output,value.essential_steps,value.scope]);
  const workflowRow = (id: number) => db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow | undefined;
  const recordPayloadMeasurementOnce = (value: PayloadMeasurement) => {
    const integers = [value.occurredAt, value.expiresAt, value.payloadBytes, value.estimatedTokens];
    const now = options.now();
    if (!value.codexTaskId || !value.turnId || !["extract", "review", "retry", "evidence_expansion"].includes(value.phase) ||
        !value.resultStatus || value.resultStatus.length > 64 || !integers.every(item => Number.isInteger(item) && item >= 0) ||
        value.occurredAt > now || value.expiresAt <= now || value.occurredAt <= now - WORKFLOW_WINDOW_MS ||
        value.estimatedTokens !== Math.ceil(value.payloadBytes / 2) ||
        value.estimatorVersion !== "byte_div_2_v1" || !["unbudgeted", "normal", "critical"].includes(value.budgetMode) ||
        (value.budgetMode === "unbudgeted" ? value.applicableLimit !== null : !Number.isInteger(value.applicableLimit) || value.applicableLimit! < 0)) return false;
    let active = false;
    try {
      db.exec("BEGIN IMMEDIATE"); active = true;
      cleanupMeasurements(now);
      db.prepare(`INSERT INTO payload_measurements
        (codex_task_id, turn_id, occurred_at, expires_at, phase, call_sequence, result_status,
          payload_bytes, estimated_tokens, estimator_version, budget_mode, applicable_limit)
        SELECT ?, ?, ?, ?, ?, COALESCE(MAX(call_sequence), 0) + 1, ?, ?, ?, ?, ?, ?
        FROM payload_measurements WHERE codex_task_id=? AND turn_id=?`)
        .run(value.codexTaskId, value.turnId, value.occurredAt, value.expiresAt, value.phase,
          value.resultStatus, value.payloadBytes, value.estimatedTokens, value.estimatorVersion,
          value.budgetMode, value.applicableLimit, value.codexTaskId, value.turnId);
      db.exec("COMMIT"); active = false;
      nextCleanupAt = 0;
      return true;
    } catch (error) {
      if (active) { try { db.exec("ROLLBACK"); } catch {} }
      throw new StorageError(storageCode(error));
    }
  };
  const countsFor = (workflowId: number, at: number) => db.prepare(`SELECT COUNT(DISTINCT e.id) AS episode_count,
      COUNT(DISTINCT e.codex_task_id) AS task_count FROM episode_workflows ew
      JOIN episodes e ON e.id=ew.episode_id JOIN observations o ON o.id=ew.observation_id
      JOIN prompts p ON p.id=o.prompt_id WHERE ew.workflow_id=? AND e.started_at>? AND e.started_at<=?
      AND p.expires_at>? AND p.occurred_at>? AND p.occurred_at<=?`)
    .get(workflowId, at-WORKFLOW_WINDOW_MS, at, at, at-WORKFLOW_WINDOW_MS, at) as { episode_count: number; task_count: number };
  const updateWorkflowShape = (id: number, at: number) => {
    const representatives = db.prepare(`SELECT o.fingerprint_json FROM episode_workflows ew
      JOIN episodes e ON e.id=ew.episode_id JOIN observations o ON o.id=ew.observation_id
      JOIN prompts p ON p.id=o.prompt_id WHERE ew.workflow_id=? AND e.started_at>? AND e.started_at<=?
      AND p.expires_at>? AND p.occurred_at>? AND p.occurred_at<=? ORDER BY e.started_at DESC, e.id DESC LIMIT 3`)
      .all(id, at-WORKFLOW_WINDOW_MS, at, at, at-WORKFLOW_WINDOW_MS, at).map(row => parseFingerprint(String(row.fingerprint_json)));
    db.prepare("UPDATE workflows SET representatives_json=?, last_seen_at=MAX(last_seen_at,?), updated_at=MAX(updated_at+1,?) WHERE id=?")
      .run(JSON.stringify(representatives), at, at, id);
  };

  const evidenceFor = (id: number, at: number) => db.prepare(`SELECT e.id AS episode_id, e.codex_task_id, e.started_at,
      o.id AS observation_id, o.fingerprint_json, ew.capability_json FROM episode_workflows ew
      JOIN episodes e ON e.id=ew.episode_id JOIN observations o ON o.id=ew.observation_id JOIN prompts p ON p.id=o.prompt_id
      WHERE ew.workflow_id=? AND e.started_at>? AND e.started_at<=? AND p.expires_at>? AND p.occurred_at>? AND p.occurred_at<=?
      ORDER BY e.id`).all(id, at-WORKFLOW_WINDOW_MS, at, at, at-WORKFLOW_WINDOW_MS, at);
  const currentEvidence = (id: number, task: string, turn: string, at: number) => db.prepare(`SELECT 1 FROM episode_workflows ew
      JOIN episodes e ON e.id=ew.episode_id JOIN observations o ON o.id=ew.observation_id JOIN prompts p ON p.id=o.prompt_id
      WHERE ew.workflow_id=? AND p.codex_task_id=? AND p.turn_id=? AND e.started_at>? AND e.started_at<=?
      AND p.expires_at>? AND p.occurred_at>? AND p.occurred_at<=? AND o.extractor_version=3`).get(id,task,turn,at-WORKFLOW_WINDOW_MS,at,at,at-WORKFLOW_WINDOW_MS,at);
  const controlled = (row: WorkflowRow, at: number, cwd?: string) => row.state !== "invalidated" && row.suppression === "none" &&
    row.recommendation_silenced_by === null &&
    (row.cooldown_until === null || row.cooldown_until <= at) && (row.scope_kind === "global" || workspaceKey(row.scope_value) === workspaceKey(cwd));
  const queue = (id: number, episode: number, source: string, enabled: boolean, task: string, turn: string, cwd?: string) => {
    const at=options.now(), row=workflowRow(id);
    if (!enabled || !row || row.state!=="confirmed" || row.prototype_version!==3 || !controlled(row,at,cwd) ||
      !meetsCurrentThreshold(countsFor(id,at)) || !currentEvidence(id,task,turn,at)) return;
    if (db.prepare("SELECT 1 FROM dispatches WHERE workflow_id=? AND state IN ('pending','blocked','dispatching')").get(id)) return;
    db.prepare(`INSERT INTO dispatches(workflow_id,triggered_by_episode_id,trigger_source,state,prompt_template_version,created_at)
      VALUES(?,?,?,'pending',1,?)`).run(id,episode,source,at);
  };
  type ReviewSetMetadata = { id: string; expiresAt: number };
  type PendingReview = { request: CapabilityReviewRequest; task: string; turn: string; episode: number; observation: number;
    value: ObservationRecord; retainedWorkflowIds: number[];
    matchingSource?: MatchingSource;
    scan?: { phase: "scan" | "final"; next: number; tentative?: number; activeIds: number[]; payloadBytes: number; expiresAt: number };
    reviewSet?: ReviewSetMetadata;
    source: string; cwd: string | undefined; group: string; relevance: number; selectable: Set<number>;
    snapshots: Map<number,{semantic:string; evidence:string}>; prototypeRefs: Map<number,string>;
    catalogDelivered: Set<number>; evidenceDelivered: Map<number,Set<string>> };
  type PendingEpisode = { request: EpisodeReviewRequest; value: ObservationRecord; prompt: number; position: number;
    reviewSet?: ReviewSetMetadata;
    candidateIds: number[]; snapshots: Map<number,string>; withdrawn: Array<{episode:number; observation:number; workflow:number; capability:string;
      relevance:number; identity:string; workflowIdentity:string}> };
  const pendingEpisodes = new Map<string,PendingEpisode>();
  const reviewIdentity = (row: WorkflowRow) => JSON.stringify([row.prototype_json,row.prototype_version,row.scope_kind,row.scope_value,
    row.state,row.suppression,row.cooldown_until,row.recommendation_silenced_by]);
  const pendingReviews = new Map<string,PendingReview>();
  type FrozenDecisionMatch = PreparedDecisionMatch & {
    value: ObservationRecord;
    expiresAt: number;
    snapshots: PendingReview["snapshots"];
  };
  const pendingDecisionMatches = new Map<string,FrozenDecisionMatch>();
  const reviewCursors = new Map<string,{reviewSetId:string;requestId:string;mode:"workflow"|"retrieval";
    workflowId:number|null;position:number;expiresAt:number}>();
  const discardReviewSet = (reviewSetId: string) => {
    for(const [id,pending] of pendingReviews) if(pending.reviewSet?.id===reviewSetId) pendingReviews.delete(id);
    for(const [id,pending] of pendingEpisodes) if(pending.reviewSet?.id===reviewSetId) pendingEpisodes.delete(id);
    for(const [id,cursor] of reviewCursors) if(cursor.reviewSetId===reviewSetId) reviewCursors.delete(id);
  };
  const requestReviews = (rows: WorkflowRow[], prototype: WorkflowPrototype, work: ObservationFingerprint,
    episode: number, observation: number, value: ObservationRecord, relevance = 0, dependency?: string,
    critical = false): CapabilityReviewRequest[] => {
    const at=options.now();
    const group=randomUUID();
    const candidates=rows.map(row=>{
      const evidence=evidenceFor(row.id,at).map(item=>({episode_id:Number(item.episode_id),codex_task_id:String(item.codex_task_id),started_at:Number(item.started_at),
        work:parseFingerprint(String(item.fingerprint_json)),capability:parsePrototype(String(item.capability_json))}));
      return {workflow_id:row.id,score:scoreWorkflow(prototype,{workflow_id:row.id,prototype:parsePrototype(row.prototype_json),representatives:[],scope_value:row.scope_value},value.workspace_path)??0,
        prototype:parsePrototype(row.prototype_json),snapshot:{prototype_version:row.prototype_version,scope_kind:row.scope_kind,scope_value:row.scope_value,
          state:row.state,suppression:row.suppression,cooldown_until:row.cooldown_until},representatives:evidence.map(item=>item.work).slice(0,3),
        evidence,episode_count:evidence.length,task_count:new Set(evidence.map(item=>item.codex_task_id)).size};
    });
    const request: CapabilityReviewRequest={request_id:randomUUID(),kind:"capability",review_reason:value.recommendation_enabled===true && candidates.some((candidate,index)=>meetsCurrentThreshold(candidate) && controlled(rows[index]!,at,value.workspace_path))?"confirm":"match",capability:prototype,work,candidates,...(dependency?{depends_on:dependency}:{}),...(critical?{critical:true}:{})};
    pendingReviews.set(request.request_id,{request,task:value.codex_task_id,turn:value.turn_id,episode,observation,source:value.source,cwd:value.workspace_path,group,relevance,
      value:{...value,prompt:"",observations:[]},retainedWorkflowIds:rows.filter(row=>countsFor(row.id,at).episode_count===0).map(row=>row.id),
      selectable:new Set(),
      snapshots:new Map(rows.map(row=>[row.id,{semantic:reviewIdentity(row),evidence:JSON.stringify(evidenceFor(row.id,at))}])),
      prototypeRefs:new Map(),catalogDelivered:new Set(),evidenceDelivered:new Map()});
    return [request];
  };
  const activeCandidates = (pending: PendingReview) => pending.scan
    ? pending.scan.activeIds.flatMap(id=>pending.request.candidates.filter(candidate=>candidate.workflow_id===id))
    : pending.request.candidates;
  const scanPayload = <T extends ReviewRequiredResult | ReviewEvidenceResult>(pending: PendingReview, payload: T): T | BudgetExceededResult => {
    if (!pending.scan) return payload;
    pending.scan.payloadBytes += Buffer.byteLength(JSON.stringify(payload),"utf8");
    if (pending.scan.payloadBytes <= MATCH_REVIEW_MAX_BYTES) return payload;
    if (pending.reviewSet) discardReviewSet(pending.reviewSet.id);
    return {status:"budget_exceeded",estimated_payload_tokens:Math.ceil(pending.scan.payloadBytes/2),
      estimator_version:"byte_div_2_v1",budget_mode:"critical",applicable_limit:12288,
      resolution:"uncertain",scan_limit_bytes:MATCH_REVIEW_MAX_BYTES} satisfies BudgetExceededResult;
  };
  const initializeScan = (pending: PendingReview, expiresAt: number, outcome?: DecisionMatchOutcome) => {
    const ids=pending.request.candidates.map(candidate=>candidate.workflow_id);
    const positive=outcome?.source==="decision_model"?outcome.matchedWorkflowIds[0]:undefined;
    pending.scan={phase:positive===undefined?"scan":"final",next:positive===undefined?Math.min(MATCH_BATCH_SIZE,ids.length):ids.length,
      ...(positive===undefined?{}:{tentative:positive}),
      activeIds:positive===undefined?ids.slice(0,MATCH_BATCH_SIZE):[positive,...(outcome?.source==="decision_model"&&outcome.runnerUpWorkflowId!==undefined?[outcome.runnerUpWorkflowId]:[])],
      payloadBytes:0,expiresAt};
  };
  const publishScan = (pending: PendingReview, retainReceipts = false) => {
    const scan=pending.scan!;
    if (!retainReceipts) {
      if (pending.reviewSet) for (const [id,cursor] of reviewCursors) if(cursor.reviewSetId===pending.reviewSet.id) reviewCursors.delete(id);
      pending.catalogDelivered.clear();pending.selectable.clear();pending.prototypeRefs.clear();pending.evidenceDelivered.clear();
    }
    return publishReview([pending.request],pending.value,scan.expiresAt,false,retainReceipts?pending.reviewSet?.id:undefined);
  };

  const augmentReviewEvidence = (requests: BatchReviewRequest[], value: ObservationRecord) => {
    const plans = requests.flatMap(request => {
      const pending = pendingReviews.get(request.request_id);
      return pending ? [pending] : [];
    });
    for(const request of requests) if(request.kind==="capability") {
      for(const candidate of request.candidates) {
        const proposed=new Map<number,NonNullable<typeof candidate.proposed_evidence>[number]>();
        for(const plan of plans) if(plan.episode && plan.request.candidates.some(row=>row.workflow_id===candidate.workflow_id) &&
          !candidate.evidence!.some(e=>e.episode_id===plan.episode) && !proposed.has(plan.episode))
          proposed.set(plan.episode,{episode_id:plan.episode,codex_task_id:value.codex_task_id,work:plan.request.work,capability:plan.request.capability});
        candidate.proposed_evidence=[...proposed.values()];
        const dependencies=new Map(plans.filter(p=>p.request.depends_on&&p.request.candidates.some(row=>row.workflow_id===candidate.workflow_id)).map(p=>[p.request.depends_on!,p]));
        candidate.pending_evidence=[...dependencies].map(([id,p])=>({request_id:id,
          episode_candidates:pendingEpisodes.get(id)!.request.candidates.map(c=>c.episode_id),codex_task_id:value.codex_task_id,work:p.request.work,capability:p.request.capability}));
        candidate.withdrawn_evidence=[...pendingEpisodes.values()].filter(p=>p.value.codex_task_id===value.codex_task_id&&p.value.turn_id===value.turn_id)
          .flatMap(p=>p.withdrawn.filter(edge=>edge.workflow===candidate.workflow_id).map(edge=>({request_id:p.request.request_id,
            episode_id:edge.episode,codex_task_id:p.value.codex_task_id,
            work:parseFingerprint((JSON.parse(edge.identity) as {fingerprint_json:string}).fingerprint_json),capability:parsePrototype(edge.capability)})));
        const possibleEvidence=[...candidate.evidence!,...candidate.proposed_evidence,...candidate.withdrawn_evidence];
        const possibleEpisodes=new Set(possibleEvidence.map(e=>e.episode_id));
        candidate.episode_count=possibleEpisodes.size;
        candidate.task_count=new Set(possibleEvidence.map(e=>e.codex_task_id)).size;
        // Counts describe the possible batch outcome; unresolved identities never become stored evidence.
        const pendingCount=candidate.pending_evidence.filter(p=>p.episode_candidates.some(id=>!possibleEpisodes.has(id))).length;
        candidate.episode_count+=pendingCount;
        if(pendingCount && !possibleEvidence.some(e=>e.codex_task_id===value.codex_task_id)) candidate.task_count++;
      }
      if(value.recommendation_enabled && request.candidates.some(c=>meetsCurrentThreshold({episode_count:c.episode_count!,task_count:c.task_count!})&&controlled(workflowRow(c.workflow_id)!,options.now(),value.workspace_path))) request.review_reason="confirm";
    }
  };

  const publishReview = (requests: BatchReviewRequest[], value: ObservationRecord, expiresAt: number,
    refreshed = false, existingId?: string): ReviewRequiredResult | BudgetExceededResult => {
    const reviewSetId = existingId??randomUUID();
    for (const request of requests) {
      const pending = pendingReviews.get(request.request_id) ?? pendingEpisodes.get(request.request_id);
      if (pending) pending.reviewSet = { id: reviewSetId, expiresAt };
    }
    const visibleRequests=requests.map(request=>{
      const pending=pendingReviews.get(request.request_id);
      if (!pending?.scan || request.kind!=="capability") return request;
      return {...request,candidates:activeCandidates(pending),scan:{phase:pending.scan.phase,
        evaluated:pending.scan.phase==="final"?pending.request.candidates.length:pending.scan.next-pending.scan.activeIds.filter(id=>id!==pending.scan!.tentative).length,
        total:pending.request.candidates.length,...(pending.scan.tentative===undefined?{}:{tentative_workflow_id:pending.scan.tentative})}};
    });
    const packet: ReviewRequiredResult = buildCompactReviewPacket({ reviewSetId, sessionId: value.codex_task_id, turnId: value.turn_id, requests:visibleRequests });
    if (refreshed) packet.refresh_reason = "snapshot_stale";
    const payload = budgetReviewPayload(packet).payload;
    if (payload.status === "budget_exceeded") { discardReviewSet(reviewSetId); return payload; }
    for (const request of payload.requests) if (request.kind === "capability") {
      const pending = pendingReviews.get(request.request_id)!;
      const count = request.catalog.items.length;
      const candidates=activeCandidates(pending);
      request.catalog.has_more = count < candidates.length;
      if (request.catalog.has_more) {
        const cursor = randomUUID();
        reviewCursors.set(cursor, { reviewSetId, requestId: request.request_id, mode: "retrieval",
          workflowId: null, position: count, expiresAt });
        request.catalog.next_cursor = cursor;
      } else delete request.catalog.next_cursor;
      pending.request.retrieval = { total_candidates: candidates.length, full_candidate_count: count,
        has_more: request.catalog.has_more, ...(request.catalog.next_cursor ? { next_cursor: request.catalog.next_cursor } : {}) };
      for (const row of request.catalog.items) pending.catalogDelivered.add(row.workflow_id);
    }
    const scanPending=requests.length===1?pendingReviews.get(requests[0]!.request_id):undefined;
    if (scanPending?.matchingSource) payload.matching_source=scanPending.matchingSource;
    if (scanPending?.scan) return scanPayload(scanPending,payload);
    return payload;
  };

  const reviewRows = (prototype: WorkflowPrototype, cwd: string | undefined, at: number, retained: number[] = [], target?: number) => {
    const rows = db.prepare(`SELECT * FROM workflows WHERE (state!='invalidated' OR suppression='permanent')
      AND scope_kind=? AND (scope_kind='global' OR lower(replace(scope_value,char(92),'/'))=?) ORDER BY id`)
      .all(prototype.scope,workspaceKey(cwd)) as WorkflowRow[];
    return rows.filter(row=>(target===undefined||row.id===target)&&
      (row.state==='confirmed'||row.suppression==='permanent'||retained.includes(row.id)||countsFor(row.id,at).episode_count>0));
  };
  const workflowSnapshotCurrent = (pending: Pick<PendingReview,"snapshots">, id: number, at: number) => {
    const snapshot = pending.snapshots.get(id), row = workflowRow(id);
    return !!snapshot && !!row && reviewIdentity(row) === snapshot.semantic && JSON.stringify(evidenceFor(id,at)) === snapshot.evidence;
  };
  const confirmationTarget = (pending: PendingReview) => pending.request.review_reason === "confirm" &&
    pending.request.candidates.length === 1 ? pending.request.candidates[0]!.workflow_id : undefined;
  const catalogCurrent = (pending: PendingReview, at: number) => {
    const target = confirmationTarget(pending);
    if (target !== undefined && !pending.scan) return workflowSnapshotCurrent(pending,target,at);
    const rows = reviewRows(pending.request.capability, pending.cwd, at, pending.retainedWorkflowIds);
    return rows.length === pending.snapshots.size && rows.every((row,index)=>
      row.id===pending.request.candidates[index]?.workflow_id && workflowSnapshotCurrent(pending,row.id,at));
  };
  const decisionMatchCurrent = (pending: FrozenDecisionMatch, at: number) => {
    if (pending.expiresAt <= at || pending.value.expires_at <= at) return false;
    const rows = reviewRows(pending.capability,pending.value.workspace_path,at);
    return rows.length === pending.candidates.length && rows.every((row,index) =>
      row.id === pending.candidates[index]?.workflow_id && workflowSnapshotCurrent(pending,row.id,at));
  };
  const prepareDecisionMatch = async (value: ObservationRecord, readControls: () => Promise<ObservationControls>) => {
    if (closed || !(await readControls()).detectionEnabled || closed) return undefined;
    const observation = value.observations[0], capability = observation?.capabilities?.[0];
    if (value.source !== "realtime" || value.observations.length !== 1 || observation?.relation !== "new" ||
        observation.capabilities?.length !== 1 || !capability) return undefined;
    if (!capabilityItemSchema.safeParse(capability).success || hasPromptExcerpt(value.observations,value.prompt)) {
      throw new StorageError("DB_UNAVAILABLE");
    }
    const at = options.now();
    for (const [token,pending] of pendingDecisionMatches) if (pending.expiresAt <= at) pendingDecisionMatches.delete(token);
    if (value.expires_at <= at) return undefined;
    const { confidence: _confidence, ...prototype } = capability;
    const rows = reviewRows(prototype,value.workspace_path,at);
    const plan: PreparedDecisionMatch = { token: randomUUID(), expiresAt:Math.min(value.expires_at,at+REVIEW_SET_TTL_MS), work: observation.fingerprint, capability: prototype,
      candidates: rows.map(row => ({ workflow_id: row.id, prototype: parsePrototype(row.prototype_json) })) };
    pendingDecisionMatches.set(plan.token,{...structuredClone(plan),value:structuredClone(value),
      expiresAt:Math.min(value.expires_at,at+REVIEW_SET_TTL_MS),
      snapshots:new Map(rows.map(row=>[row.id,{semantic:reviewIdentity(row),evidence:JSON.stringify(evidenceFor(row.id,at))}]))});
    return structuredClone(plan);
  };
  const workCurrent = (pending: PendingReview, at: number) => !!db.prepare(`SELECT 1 FROM observations o JOIN episodes e ON e.id=o.episode_id JOIN prompts p ON p.id=o.prompt_id
    WHERE o.id=? AND e.id=? AND p.codex_task_id=? AND p.turn_id=? AND e.started_at>? AND e.started_at<=?
    AND p.expires_at>? AND p.occurred_at>? AND p.occurred_at<=? AND o.id=(SELECT MAX(id) FROM observations WHERE episode_id=e.id)`)
    .get(pending.observation,pending.episode,pending.task,pending.turn,at-WORKFLOW_WINDOW_MS,at,at,at-WORKFLOW_WINDOW_MS,at);

  const getReviewEvidenceOnce = async (value: ReviewEvidenceInput, readControls: () => Promise<ObservationControls>): Promise<ReviewEvidenceResult> => {
    const at=options.now();
    for(const [id,cursor] of reviewCursors) if(cursor.expiresAt<=at) reviewCursors.delete(id);
    const activeSet=[...pendingReviews.values(),...pendingEpisodes.values()]
      .some(pending=>pending.reviewSet?.id===value.review_set_id && pending.reviewSet.expiresAt>at);
    if(!activeSet) return {status:"error",code:"REVIEW_SET_UNAVAILABLE"};
    const pending=pendingReviews.get(value.request_id)??pendingEpisodes.get(value.request_id);
    if(!pending||pending.reviewSet?.id!==value.review_set_id||pending.reviewSet.expiresAt<=at)
      return {status:"error",code:"REQUEST_MISMATCH"};
    const controls=await readControls();
    if(!controls.detectionEnabled||closed) return {status:"error",code:"CONTROL_STATE_INVALID"};
    const mode=value.workflow_id===undefined?"retrieval":"workflow";
    let position=0;
    if(value.cursor) {
      const cursor=reviewCursors.get(value.cursor);
      if(!cursor||cursor.expiresAt<=at||cursor.reviewSetId!==value.review_set_id||cursor.requestId!==value.request_id||
        cursor.mode!==mode||cursor.workflowId!==(value.workflow_id??null)) return {status:"error",code:"CURSOR_MISMATCH"};
      position=cursor.position;
    }
    const nextCursor=(next:number,total:number) => {
      if(next>=total) return undefined;
      const id=randomUUID();
      reviewCursors.set(id,{reviewSetId:value.review_set_id,requestId:value.request_id,mode,
        workflowId:value.workflow_id??null,position:next,expiresAt:pending.reviewSet!.expiresAt});
      return id;
    };
    const finishPage = (page: Extract<ReviewEvidenceResult, {status:"ok"}>, total: number): ReviewEvidenceResult => {
      const critical=reviewRequestBudgetMode(pending.request)==="critical";
      const result=budgetReviewPayload({...page,...(critical?{budget_mode:"critical" as const}:{}),
        ...(page.has_more?{next_cursor:"00000000-0000-0000-0000-000000000000"}:{})},critical?"critical":undefined).payload as ReviewEvidenceResult;
      if(result.status!=="ok") return result;
      const count=result.mode==="workflow"?result.evidence.length:result.candidates.length;
      const next=position+count;
      result.has_more=next<total;
      const cursor=nextCursor(next,total);
      if(cursor) result.next_cursor=cursor; else delete result.next_cursor;
      return result;
    };
    const limit=value.limit??10;
    if(pending.request.kind==="episode") {
      if(value.workflow_id!==undefined) return {status:"error",code:"WORKFLOW_MISMATCH"};
      const episodePending=pending as PendingEpisode;
      const eligible=new Set(episodeCandidates(episodePending.value,episodePending.request.work).map(candidate=>candidate.id));
      if(!episodePending.request.candidates.every(candidate=>eligible.has(candidate.episode_id)&&
        episodeSnapshot(candidate.episode_id)===episodePending.snapshots.get(candidate.episode_id)))
        return {status:"error",code:"SNAPSHOT_STALE"};
      const candidates=episodePending.request.candidates.slice(position,position+limit);
      return finishPage({status:"ok",mode:"retrieval",review_set_id:value.review_set_id,request_id:value.request_id,candidates,
        has_more:position+candidates.length<episodePending.request.candidates.length},episodePending.request.candidates.length);
    }
    const capabilityPending=pending as PendingReview;
    if(!capabilityPending.request.depends_on && !workCurrent(capabilityPending,at)) return {status:"error",code:"SNAPSHOT_STALE"};
    if(mode==="retrieval") {
      if(!catalogCurrent(capabilityPending,at)) return {status:"error",code:"SNAPSHOT_STALE"};
      const catalog=activeCandidates(capabilityPending);
      const candidates=catalog.slice(position,position+limit).map(workflowCatalogItem);
      return finishPage({status:"ok",mode:"retrieval",review_set_id:value.review_set_id,request_id:value.request_id,candidates,
        has_more:position+candidates.length<catalog.length},catalog.length);
    }
    const candidate=activeCandidates(capabilityPending).find(item=>item.workflow_id===value.workflow_id);
    if(!candidate) return {status:"error",code:"WORKFLOW_MISMATCH"};
    if(!workflowSnapshotCurrent(capabilityPending,candidate.workflow_id,at)) return {status:"error",code:"SNAPSHOT_STALE"};
    const evidence=reviewCandidateFacts(value.review_set_id,value.request_id,candidate);
    const page=evidence.slice(position,position+(value.limit??evidence.length));
    return finishPage(buildWorkflowReviewPage({reviewSetId:value.review_set_id,requestId:value.request_id,candidate,
      facts:page,hasMore:position+page.length<evidence.length}),evidence.length);
  };

  const claimOnce = (value: { codexTaskId: string; turnId: string; cwd: string; claimedAt: number; recommendation?: "web" }) => {
    cleanup();
    nextCleanupAt = 0;
    let active = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      active = true;
      if (db.prepare(`SELECT 1 FROM dispatch_turn_receipts
        WHERE codex_task_id = ? AND turn_id = ? AND claimed_at > ?`)
        .get(value.codexTaskId, value.turnId, options.now() - WORKFLOW_WINDOW_MS)) {
        db.exec("COMMIT");
        active = false;
        return undefined;
      }
      db.prepare(`UPDATE dispatches SET state = 'cancelled', finished_at = ?
        WHERE state IN ('pending', 'blocked') AND workflow_id IN (
          SELECT id FROM workflows WHERE state != 'confirmed' OR suppression != 'none' OR recommendation_silenced_by IS NOT NULL OR (cooldown_until IS NOT NULL AND cooldown_until > ?)
        )`).run(value.claimedAt, value.claimedAt);
      const rows = db.prepare(`SELECT d.id, d.workflow_id, d.created_at, d.trigger_source, d.blocked_reason,
          w.prototype_json, w.confirmed_at, w.confirmation_episode_count, w.confirmation_task_count
        FROM dispatches d JOIN workflows w ON w.id = d.workflow_id
        WHERE d.state IN ('pending', 'blocked')
          AND w.state = 'confirmed' AND w.prototype_version = 3 AND w.suppression = 'none' AND w.recommendation_silenced_by IS NULL
          AND (w.cooldown_until IS NULL OR w.cooldown_until <= ?)
          AND (w.scope_kind = 'global' OR lower(replace(w.scope_value,char(92),'/')) = ?)
          AND NOT EXISTS (SELECT 1 FROM dispatches failed WHERE failed.workflow_id = d.workflow_id
            AND failed.error_code IN (${RETRYABLE_DISPATCH_ERRORS_SQL}) AND failed.finished_at > ?)
          AND (SELECT COUNT(*) FROM dispatches failed WHERE failed.workflow_id = d.workflow_id
            AND failed.error_code IN (${RETRYABLE_DISPATCH_ERRORS_SQL}) AND failed.finished_at > ?) < 3
          AND EXISTS (
          SELECT 1 FROM prompts p
          JOIN observations o ON o.prompt_id = p.id
          JOIN episodes e ON e.id = o.episode_id
          JOIN episode_workflows ew ON ew.observation_id=o.id
          WHERE p.codex_task_id = ? AND p.turn_id = ? AND ew.workflow_id = d.workflow_id AND p.expires_at > ? AND p.occurred_at > ?
            AND p.occurred_at <= ? AND e.started_at > ? AND e.started_at <= ?
            AND o.extractor_version=3
        ) ORDER BY d.created_at, d.id
        `).all(value.claimedAt, workspaceKey(value.cwd), value.claimedAt - 300_000, value.claimedAt - 3_600_000,
          value.codexTaskId, value.turnId, options.now(), options.now() - WORKFLOW_WINDOW_MS, options.now(), options.now()-WORKFLOW_WINDOW_MS, options.now()) as {
          id: number;
          workflow_id: number;
          created_at: number;
          trigger_source: "realtime" | "history";
          blocked_reason: string | null;
          prototype_json: string;
          confirmed_at: number | null;
          confirmation_episode_count: number | null;
          confirmation_task_count: number | null;
        }[];
      const relevance = (id:number) => Number(db.prepare(`SELECT MIN(o.position*3+ew.relevance_order) AS rank FROM episode_workflows ew
        JOIN observations o ON o.id=ew.observation_id JOIN prompts p ON p.id=o.prompt_id
        WHERE ew.workflow_id=? AND p.codex_task_id=? AND p.turn_id=?`).get(id,value.codexTaskId,value.turnId)!.rank);
      const row=rows.filter(row=>meetsCurrentThreshold(countsFor(row.workflow_id,options.now())))
        .sort((a,b)=>relevance(a.workflow_id)-relevance(b.workflow_id)||a.created_at-b.created_at||a.id-b.id)[0];
      if (!row || !meetsCurrentThreshold(countsFor(row.workflow_id, options.now()))) {
        db.exec("COMMIT");
        active = false;
        return undefined;
      }
      const parsedPrototype = workflowPrototypeSchema.safeParse((() => {
        try { return JSON.parse(row.prototype_json); } catch { return undefined; }
      })());
      if (!parsedPrototype.success) {
        db.prepare(`UPDATE dispatches SET state = 'failed', error_code = 'dispatch_payload_invalid', finished_at = ?
          WHERE id = ? AND state IN ('pending', 'blocked')`).run(value.claimedAt, row.id);
        db.exec("COMMIT");
        active = false;
        return undefined;
      }
      const claimed = db.prepare(`UPDATE dispatches SET state = 'dispatching', claimed_codex_task_id = ?,
          claimed_turn_id = ?, claimed_at = ?, finished_at = NULL, error_code = NULL
        WHERE id = ? AND state IN ('pending', 'blocked')`)
        .run(value.codexTaskId, value.turnId, value.claimedAt, row.id).changes === 1;
      if (claimed) db.prepare(`INSERT OR REPLACE INTO dispatch_turn_receipts (codex_task_id, turn_id, claimed_at)
        VALUES (?, ?, ?)`).run(value.codexTaskId, value.turnId, value.claimedAt);
      const recommendationId = claimed && value.recommendation === "web" ? randomUUID() : undefined;
      if (recommendationId) db.prepare(`INSERT INTO recommendation_requests (id,dispatch_id,cwd,prototype_json)
        VALUES (?,?,?,?)`).run(recommendationId,row.id,value.cwd,row.prototype_json);
      db.exec("COMMIT");
      active = false;
      if (!claimed) return undefined;
      return {
        id: row.id,
        ...(recommendationId ? { recommendation_id: recommendationId } : {}),
        workflow_id: row.workflow_id,
        created_at: row.created_at,
        confirmed_at: row.confirmed_at,
        confirmation_episode_count: countsFor(row.workflow_id,options.now()).episode_count,
        confirmation_task_count: countsFor(row.workflow_id,options.now()).task_count,
        trigger_source: row.trigger_source,
        blocked_before: row.blocked_reason !== null,
        prototype: parsedPrototype.data,
      };
    } catch (error) {
      if (active) {
        try { db.exec("ROLLBACK"); } catch {}
      }
      throw new StorageError(storageCode(error));
    }
  };

  type FinalEligibilityRow = {
    workflow_id: number;
    state: string;
    scope_kind: "global" | "project";
    scope_value: string | null;
    suppression: string;
    recommendation_silenced_by: string | null;
    cooldown_until: number | null;
    blocked_reason: string | null;
    prototype_version: number;
    prototype_json: string;
  };
  const finalRow = (dispatchId: number, codexTaskId: string, turnId: string) => db.prepare(`SELECT d.workflow_id,
      d.blocked_reason, w.state, w.prototype_version, w.prototype_json, w.scope_kind, w.scope_value, w.suppression, w.cooldown_until, w.recommendation_silenced_by
    FROM dispatches d JOIN workflows w ON w.id = d.workflow_id
    WHERE d.id = ? AND d.state = 'dispatching' AND d.claimed_codex_task_id = ? AND d.claimed_turn_id = ?`)
    .get(dispatchId, codexTaskId, turnId) as FinalEligibilityRow | undefined;
  const finallyEligible = (row: FinalEligibilityRow | undefined, cwd: string, at: number, dispatchEnabled: () => boolean) =>
    dispatchEnabled() && row?.state === "confirmed" && row.prototype_version === 3 && meetsCurrentThreshold(countsFor(row.workflow_id, Math.max(at, options.now()))) && row.suppression === "none" && row.recommendation_silenced_by === null &&
    (row.cooldown_until === null || row.cooldown_until <= at) &&
    (row.scope_kind === "global" || workspaceKey(row.scope_value) === workspaceKey(cwd));

  const blockOnce = (value: {
    dispatchId: number;
    codexTaskId: string;
    turnId: string;
    cwd: string;
    reason: DispatchBlockReason;
    finishedAt: number;
    dispatchEnabled: boolean;
  }) => {
    nextCleanupAt = 0;
    let active = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      active = true;
      const row = finalRow(value.dispatchId, value.codexTaskId, value.turnId);
      if (!finallyEligible(row, value.cwd, value.finishedAt, () => value.dispatchEnabled) || !row ||
        !currentEvidence(row.workflow_id,value.codexTaskId,value.turnId,Math.max(value.finishedAt,options.now()))) {
        db.prepare(`UPDATE dispatches SET state = 'cancelled', finished_at = ?
          WHERE id = ? AND state = 'dispatching' AND claimed_codex_task_id = ? AND claimed_turn_id = ?`)
          .run(value.finishedAt, value.dispatchId, value.codexTaskId, value.turnId);
        db.exec("COMMIT");
        active = false;
        return false;
      }
      const changed = db.prepare(`UPDATE dispatches SET state = 'blocked', blocked_reason = ?, finished_at = ?
        WHERE id = ? AND state = 'dispatching' AND claimed_codex_task_id = ? AND claimed_turn_id = ?`)
        .run(value.reason, value.finishedAt, value.dispatchId, value.codexTaskId, value.turnId).changes === 1;
      db.exec("COMMIT");
      active = false;
      return changed && row?.blocked_reason === null;
    } catch (error) {
      if (active) {
        try { db.exec("ROLLBACK"); } catch {}
      }
      throw new StorageError(storageCode(error));
    }
  };

  const failOnce = (value: { dispatchId: number; codexTaskId: string; turnId: string; errorCode: string; finishedAt: number }) => {
    nextCleanupAt = 0;
    try {
      return db.prepare(`UPDATE dispatches SET state = 'failed', error_code = ?, finished_at = ?
        WHERE id = ? AND state = 'dispatching' AND claimed_codex_task_id = ? AND claimed_turn_id = ?`)
        .run(value.errorCode, value.finishedAt, value.dispatchId, value.codexTaskId, value.turnId).changes === 1;
    } catch (error) {
      throw new StorageError(storageCode(error));
    }
  };

  const completeOnce = (value: {
    dispatchId: number;
    codexTaskId: string;
    turnId: string;
    cwd: string;
    finishedAt: number;
    dispatchEnabled: boolean;
    searchResultCount?: number;
    recommendation?: { id: string; count: number; baselineSkill?: string };
  }) => {
    nextCleanupAt = 0;
    let active = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      active = true;
      const row = finalRow(value.dispatchId, value.codexTaskId, value.turnId);
      const frozen = value.recommendation ? db.prepare(`SELECT r.prototype_json,d.claimed_at FROM recommendation_requests r
        JOIN dispatches d ON d.id=r.dispatch_id WHERE r.id=? AND r.dispatch_id=? AND r.cwd=? AND r.completed_at IS NULL`)
        .get(value.recommendation.id,value.dispatchId,value.cwd) as {prototype_json:string;claimed_at:number} | undefined : undefined;
      if (frozen && frozen.claimed_at <= Math.max(value.finishedAt,options.now())-WEB_RECOMMENDATION_TIMEOUT_MS) {
        failOnce({...value,errorCode:"dispatch_interrupted"});
        db.exec("COMMIT"); active = false;
        return false;
      }
      const eligible = finallyEligible(row, value.cwd, value.finishedAt, () => value.dispatchEnabled) && row &&
        currentEvidence(row.workflow_id,value.codexTaskId,value.turnId,Math.max(value.finishedAt,options.now())) &&
        (!value.recommendation || frozen?.prototype_json === row.prototype_json);
      if (!eligible || !row) {
        db.prepare(`UPDATE dispatches SET state = 'cancelled', finished_at = ?
          WHERE id = ? AND state = 'dispatching' AND claimed_codex_task_id = ? AND claimed_turn_id = ?`)
          .run(value.finishedAt, value.dispatchId, value.codexTaskId, value.turnId);
        db.exec("COMMIT");
        active = false;
        return false;
      }
      const changed = db.prepare(`UPDATE dispatches SET state = 'dispatched', finished_at = ?
        WHERE id = ? AND state = 'dispatching' AND claimed_codex_task_id = ? AND claimed_turn_id = ?`)
        .run(value.finishedAt, value.dispatchId, value.codexTaskId, value.turnId).changes === 1;
      if (changed) {
        if (value.recommendation) {
          db.prepare("UPDATE recommendation_requests SET completed_at=?,recommendation_count=? WHERE id=?")
            .run(value.finishedAt,value.recommendation.count,value.recommendation.id);
        } else {
          db.prepare("INSERT INTO dispatch_search_receipts (dispatch_id, completed_at, result_count) VALUES (?, ?, ?)")
            .run(value.dispatchId, value.finishedAt, value.searchResultCount!);
        }
        if (value.recommendation?.baselineSkill) {
          db.prepare("UPDATE workflows SET recommendation_silenced_by=?,updated_at=MAX(updated_at+1,?) WHERE id=?")
            .run(value.recommendation.baselineSkill,value.finishedAt,row.workflow_id);
        } else {
          db.prepare("UPDATE workflows SET cooldown_until = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?")
            .run(value.finishedAt + WORKFLOW_WINDOW_MS, value.finishedAt, row.workflow_id);
        }
      }
      db.exec("COMMIT");
      active = false;
      return changed;
    } catch (error) {
      if (active) {
        try { db.exec("ROLLBACK"); } catch {}
      }
      throw new StorageError(storageCode(error));
    }
  };

  const episodeCandidates = (value:ObservationRecord, work:ObservationFingerprint) => (db.prepare(`SELECT e.id,o.fingerprint_json,p.workspace_path FROM episodes e
    JOIN observations o ON o.episode_id=e.id JOIN prompts p ON p.id=o.prompt_id
    WHERE e.codex_task_id=? AND e.started_at>? AND e.started_at<=? AND p.expires_at>? AND p.occurred_at>? AND p.occurred_at<=?
    AND o.id=(SELECT MAX(id) FROM observations WHERE episode_id=e.id) ORDER BY e.id`)
    .all(value.codex_task_id,options.now()-WORKFLOW_WINDOW_MS,options.now(),options.now(),options.now()-WORKFLOW_WINDOW_MS,options.now()) as Array<{id:number;fingerprint_json:string;workspace_path:string}>)
    .filter(row=>parseFingerprint(row.fingerprint_json).scope===work.scope && (work.scope==="global"||workspaceKey(row.workspace_path)===workspaceKey(value.workspace_path)));
  const episodeSnapshot = (id:number) => JSON.stringify(db.prepare(`SELECT e.*,o.id AS observation_id,o.fingerprint_json,o.capabilities_json,p.expires_at,p.workspace_path FROM episodes e
    JOIN observations o ON o.episode_id=e.id JOIN prompts p ON p.id=o.prompt_id WHERE e.id=? AND o.id=(SELECT MAX(id) FROM observations WHERE episode_id=e.id)`).get(id));
  const insertObservation = (value:ObservationRecord,prompt:number,position:number,episode:number) => {
    const o=value.observations[position]!;
    const capabilities=o.capabilities??[{...o.fingerprint,variable_slots:o.variable_slots??[],confidence:o.confidence??"high"}];
    const id=Number(db.prepare(`INSERT INTO observations(prompt_id,episode_id,position,relation,fingerprint_json,capabilities_json,variables_json,extractor_version,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(prompt,episode,position,o.relation,JSON.stringify(o.fingerprint),JSON.stringify(capabilities),JSON.stringify(o.variable_slots??[]),o.capabilities===undefined?2:3,value.occurred_at).lastInsertRowid);
    db.prepare("UPDATE episodes SET last_seen_at=MAX(last_seen_at,?) WHERE id=?").run(value.occurred_at,episode);
    return id;
  };
  const createWorkflow = (prototype:WorkflowPrototype,cwd:string|undefined,at:number,version=3) => Number(db.prepare(`INSERT INTO workflows
    (scope_kind,scope_value,state,prototype_json,prototype_version,representatives_json,last_seen_at,suppression,created_at,updated_at)
    VALUES(?,?,'forming',?,?,'[]',?,'none',?,?)`).run(prototype.scope,prototype.scope==="project"?workspaceKey(cwd):null,JSON.stringify(prototype),version,at,at,at).lastInsertRowid);
  const associate = (episode:number,id:number,observation:number,prototype:WorkflowPrototype,relevance:number) => db.prepare(`INSERT INTO episode_workflows
    (episode_id,workflow_id,observation_id,capability_json,relevance_order) VALUES(?,?,?,?,?) ON CONFLICT(episode_id,workflow_id) DO UPDATE SET
    observation_id=excluded.observation_id,capability_json=CASE WHEN excluded.relevance_order<relevance_order THEN excluded.capability_json ELSE capability_json END,
    relevance_order=MIN(relevance_order,excluded.relevance_order)`).run(episode,id,observation,JSON.stringify(prototype),relevance);

  const refreshReviewOnce = async (reviewSetId: string, readControls: () => Promise<ObservationControls>) => {
    const controls = await readControls();
    if (!controls.detectionEnabled || closed) return undefined;
    const batch = [...pendingReviews.values()].filter(p=>p.reviewSet?.id===reviewSetId);
    const identities = [...pendingEpisodes.values()].filter(p=>p.reviewSet?.id===reviewSetId);
    const all = [...batch,...identities];
    const at = options.now();
    if (!all.length || all.some(p=>p.reviewSet!.expiresAt<=at || p.value.expires_at<=at)) return undefined;
    let active = false;
    try {
      db.exec("BEGIN IMMEDIATE"); active = true;
      // Never replay an older work update over a newer observation, or resurrect withdrawn evidence.
      if (batch.some(p=>!p.request.depends_on && !workCurrent(p,at)) ||
          identities.some(p=>!db.prepare("SELECT 1 FROM prompts WHERE id=? AND expires_at>?").get(p.prompt,at) ||
            p.request.candidates.some(c=>episodeSnapshot(c.episode_id)!==p.snapshots.get(c.episode_id) ||
              !episodeCandidates(p.value,p.request.work).some(e=>e.id===c.episode_id)))) {
        db.exec("ROLLBACK"); active = false; return undefined;
      }
      const requests: BatchReviewRequest[] = [];
      const dependencies = new Map<string,string>();
      const expiresAt = Math.min(...all.map(p=>p.reviewSet!.expiresAt));
      // Old request IDs, prototype references, delivery receipts and cursors cannot authorize the new snapshot.
      discardReviewSet(reviewSetId);
      for (const pending of identities) {
        const request = { ...pending.request, request_id: randomUUID() };
        dependencies.set(pending.request.request_id,request.request_id);
        const withdrawn = pending.withdrawn.filter(edge=>{
          const row = workflowRow(edge.workflow);
          return row && reviewIdentity(row)===edge.workflowIdentity && episodeSnapshot(edge.episode)===edge.identity &&
            !db.prepare("SELECT 1 FROM episode_workflows WHERE episode_id=?").get(edge.episode);
        });
        pendingEpisodes.set(request.request_id,{...pending,request,withdrawn});
        requests.push(request);
      }
      for (const pending of batch) {
        const value = {...pending.value,recommendation_enabled:controls.recommendationEnabled};
        const target = pending.scan?undefined:confirmationTarget(pending);
        const rows = reviewRows(pending.request.capability,pending.cwd,at,pending.retainedWorkflowIds,target);
        const fresh = requestReviews(rows,pending.request.capability,pending.request.work,pending.episode,pending.observation,
          value,pending.relevance,pending.request.depends_on?dependencies.get(pending.request.depends_on):undefined,pending.request.critical);
        for (const request of fresh) {
          if (target !== undefined) request.review_reason = "confirm";
          const replacement = pendingReviews.get(request.request_id)!;
          if (pending.matchingSource) replacement.matchingSource = pending.matchingSource;
          if (pending.scan) {
            initializeScan(replacement,pending.scan.expiresAt);
            replacement.scan!.payloadBytes=pending.scan.payloadBytes;
            replacement.matchingSource="main_model_fallback";
          }
        }
        requests.push(...fresh);
      }
      const value = {...all[0]!.value,recommendation_enabled:controls.recommendationEnabled};
      augmentReviewEvidence(requests,value);
      const result = publishReview(requests,value,expiresAt,true);
      const source = batch.some(pending=>pending.scan)?"main_model_fallback":batch[0]?.matchingSource;
      if (result.status === "review_required" && source) result.matching_source = source;
      db.exec("COMMIT"); active = false;
      return result;
    } catch (error) {
      if (active) { try { db.exec("ROLLBACK"); } catch {} }
      // A failed refresh must not leave a partly built review available.
      for (const pending of [...pendingReviews.values()]) if (batch.some(p=>p.task===pending.task&&p.turn===pending.turn)) pendingReviews.delete(pending.request.request_id);
      for (const pending of [...pendingEpisodes.values()]) if (identities.some(p=>p.prompt===pending.prompt)) pendingEpisodes.delete(pending.request.request_id);
      throw new StorageError(storageCode(error));
    }
  };

  const recordOnce = async (value: ObservationRecord, readControls: () => Promise<ObservationControls>,
    decisionMatch?: { pending: FrozenDecisionMatch; outcome: DecisionMatchOutcome }) => {
    if (value.observations.length > 3 || value.observations.some(item => (item.capabilities?.length ?? 0) > 3)) throw new StorageError("DB_UNAVAILABLE");
    for (const observation of value.observations) {
      if (observation.capabilities?.some(item => !capabilityItemSchema.safeParse(item).success)) {
        throw new StorageError("DB_UNAVAILABLE");
      }
    }
    if (hasPromptExcerpt(value.observations, value.prompt)) throw new StorageError("DB_UNAVAILABLE");
    if (!(await readControls()).detectionEnabled || closed) return undefined;
    value = { ...value, expires_at: Math.min(value.expires_at, value.occurred_at + WORKFLOW_WINDOW_MS) };
    if (value.expires_at <= options.now()) return undefined;
    const controls = await readControls();
    if (!controls.detectionEnabled || closed || value.expires_at <= options.now()) return undefined;
    value={...value,recommendation_enabled:controls.recommendationEnabled};
    cleanup();
    let active = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      active = true;
      if (decisionMatch && !decisionMatchCurrent(decisionMatch.pending,options.now())) {
        db.exec("ROLLBACK"); active = false; return "stale" as const;
      }
      const existing = db.prepare("SELECT id FROM prompts WHERE codex_task_id = ? AND turn_id = ? AND message_id = ?")
        .get(value.codex_task_id, value.turn_id, value.message_id) as { id: number } | undefined;
      if (existing) {
        db.exec("COMMIT");
        active = false;
        return { prompt_id: existing.id, created: false };
      }
      if (value.source === "realtime" && value.workspace_path && !value.attachment_types?.length &&
        value.observations.length > 0 && value.observations.every(item => item.relation === "new")) {
        const linked = db.prepare(`SELECT DISTINCT p.id, p.workspace_path, p.body FROM prompts p
          JOIN observations o ON o.prompt_id = p.id JOIN episode_workflows ew ON ew.observation_id = o.id
          WHERE p.codex_task_id = ? AND p.source = 'realtime' AND p.expires_at > ?
          AND (p.attachment_types_json IS NULL OR p.attachment_types_json = '[]') ORDER BY p.id DESC`)
          .all(value.codex_task_id, options.now()) as Array<{ id: number; workspace_path: string | null; body: string }>;
        for (const prior of linked) {
          if (!prior.workspace_path || workspaceKey(prior.workspace_path) !== workspaceKey(value.workspace_path)) continue;
          if (prior.body === value.prompt) {
            db.exec("COMMIT");
            active = false;
            return { prompt_id: prior.id, created: false };
          }
        }
      }
      const promptId = Number(db.prepare(`INSERT INTO prompts
        (codex_task_id, turn_id, message_id, source, occurred_at, expires_at, workspace_path, attachment_types_json, body)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(value.codex_task_id, value.turn_id, value.message_id, value.source, value.occurred_at, value.expires_at,
          value.workspace_path ?? null, value.attachment_types ? JSON.stringify(value.attachment_types) : null, value.prompt).lastInsertRowid);
      const deferred: NonNullable<ObservationResult["deferred"]> = [];
      const requests: BatchReviewRequest[] = [];
      const plans: Array<{rows: WorkflowRow[]; prototype: WorkflowPrototype; work: ObservationFingerprint;
        episode: number; observation: number; relevance: number; critical: boolean; dependency?: string | undefined}> = [];
      const touched: Array<{id:number; episode:number; observation:number; prototype:WorkflowPrototype; work:ObservationFingerprint; relevance:number; critical:boolean}> = [];
      for (const [position, observation] of value.observations.entries()) {
        let episodeId = 0, observationId = 0, dependency: string | undefined;
        const oldIds: number[] = [];
        if (observation.relation === "new") {
          episodeId = Number(db.prepare("INSERT INTO episodes (codex_task_id, started_at, last_seen_at) VALUES (?, ?, ?)")
            .run(value.codex_task_id, value.occurred_at, value.occurred_at).lastInsertRowid);
        } else {
          const episodes = episodeCandidates(value, observation.fingerprint);
          const matches = episodes.filter(row => chooseMatch({...observation.fingerprint,confidence:observation.confidence??"high"}, [{
            workflow_id:row.id,prototype:{...parseFingerprint(row.fingerprint_json),variable_slots:[]}, representatives:[parseFingerprint(row.fingerprint_json)],
            scope_value:observation.fingerprint.scope==="project"?row.workspace_path:null}],value.workspace_path).kind==="direct");
          if(matches.length===1) episodeId=matches[0]!.id;
          else {
            deferred.push({position,reason:"unresolved_episode"});
            const candidates=matches.length?matches:episodes;
            const withdrawn: PendingEpisode["withdrawn"] = [];
            // Uncertain edits revoke potential old contributions before requesting identity.
            if(observation.relation==="modify" && observation.capabilities?.length!==0) for(const row of candidates) {
              const ids=db.prepare("SELECT * FROM episode_workflows WHERE episode_id=?").all(row.id);
              for(const edge of ids) withdrawn.push({episode:row.id,observation:Number(edge.observation_id),workflow:Number(edge.workflow_id),
                capability:String(edge.capability_json),relevance:Number(edge.relevance_order),identity:episodeSnapshot(row.id),workflowIdentity:reviewIdentity(workflowRow(Number(edge.workflow_id))!)});
              oldIds.push(...ids.map(id=>Number(id.workflow_id)));
              db.prepare("DELETE FROM episode_workflows WHERE episode_id=?").run(row.id);
              for(const id of ids) updateWorkflowShape(Number(id.workflow_id),options.now());
            }
            if(!candidates.length || observation.capabilities===undefined) continue;
            dependency=randomUUID();
            const request:EpisodeReviewRequest={request_id:dependency,kind:"episode",work:observation.fingerprint,
              candidates:candidates.slice(0,5).map(row=>({episode_id:row.id,work:parseFingerprint(row.fingerprint_json)}))};
            requests.push(request);
            pendingEpisodes.set(dependency,{request,value,prompt:promptId,position,withdrawn,candidateIds:candidates.map(row=>row.id),
              snapshots:new Map(candidates.slice(0,5).map(row=>[row.id,episodeSnapshot(row.id)]))});
          }
        }
        const capabilities = observation.capabilities ?? [{...observation.fingerprint,variable_slots:observation.variable_slots??[],confidence:observation.confidence??"high"}];
        if(episodeId) {
          if(capabilities.length) {
            oldIds.push(...db.prepare("SELECT workflow_id FROM episode_workflows WHERE episode_id=?").all(episodeId).map(row=>Number(row.workflow_id)));
            db.prepare("DELETE FROM episode_workflows WHERE episode_id=?").run(episodeId);
          }
          observationId=insertObservation(value,promptId,position,episodeId);
          for(const id of oldIds) updateWorkflowShape(id,options.now());
        }
        if(!capabilities.length) deferred.push({position,reason:"no_capability"});
        for(const [relevance,{confidence,...prototype}] of capabilities.entries()) {
          const candidates=reviewRows(prototype,value.workspace_path,options.now(),oldIds);
          if (decisionMatch) {
            const outcome=decisionMatch.outcome;
            const ids=outcome.source==="decision_model"?outcome.matchedWorkflowIds:[];
            const selected=candidates.find(row=>row.id===ids[0]);
            const counts=selected?countsFor(selected.id,options.now()):undefined;
            const needsConfirmation=selected&&counts&&(selected.state!=="confirmed"||selected.prototype_version!==3)&&
              meetsCurrentThreshold({episode_count:counts.episode_count+1,task_count:counts.task_count+
                (evidenceFor(selected.id,options.now()).some(row=>row.codex_task_id===value.codex_task_id)?0:1)});
            if ((outcome.source === "main_model_fallback" && candidates.length) ||
                (outcome.source === "decision_model" && ids.length>0 && (candidates.length>1 || needsConfirmation))) {
              deferred.push({position,reason:"capability_review_required"});
              plans.push({rows:candidates,prototype,work:observation.fingerprint,episode:episodeId,observation:observationId,
                relevance,critical:false});
            } else {
              for (const id of ids.length ? ids : [createWorkflow(prototype,value.workspace_path,value.occurred_at)]) {
                associate(episodeId,id,observationId,prototype,relevance);
                updateWorkflowShape(id,options.now());
                touched.push({id,episode:episodeId,observation:observationId,prototype,work:observation.fingerprint,relevance,critical:false});
              }
            }
            continue;
          }
          const identical=candidates.filter(row=>capabilityKey(parsePrototype(row.prototype_json))===capabilityKey(prototype));
          const decision:MatchDecision=observation.capabilities===undefined?chooseMatch({...prototype,confidence},candidates.map(row=>({workflow_id:row.id,prototype:parsePrototype(row.prototype_json),representatives:[],scope_value:row.scope_value})),value.workspace_path):
            identical.length===1?{kind:"direct",workflow_id:identical[0]!.id,score:1}:{kind:"new"};
          if(dependency || confidence!=="high" || (decision.kind!=="direct" && candidates.length && (observation.capabilities!==undefined||decision.kind==="review"))) {
            deferred.push({position,reason:"capability_review_required"});
            plans.push({rows:candidates,prototype,work:observation.fingerprint,episode:episodeId,observation:observationId,relevance,
              critical:observation.relation==="modify",dependency});
            continue;
          }
          const id=decision.kind==="direct"?decision.workflow_id:createWorkflow(prototype,value.workspace_path,value.occurred_at,observation.capabilities===undefined?1:3);
          associate(episodeId,id,observationId,prototype,relevance);
          updateWorkflowShape(id,options.now());
          if(observation.capabilities!==undefined) touched.push({id,episode:episodeId,observation:observationId,prototype,work:observation.fingerprint,relevance,
            critical:observation.relation==="modify"});
          else if(meetsCurrentThreshold(countsFor(id,options.now()))) deferred.push({position,reason:"capability_confirmation_required"});
        }
      }
      // All direct writes finish before snapshots; all proposed evidence participates in confirmation.
      for(const item of touched) {
        const row=workflowRow(item.id)!;
        if(meetsCurrentThreshold(countsFor(item.id,options.now()))) {
          if(row.state==="confirmed"&&row.prototype_version===3) queue(item.id,item.episode,value.source,value.recommendation_enabled===true,value.codex_task_id,value.turn_id,value.workspace_path);
          else if(!plans.some(p=>p.episode===item.episode&&p.relevance===item.relevance&&p.rows.some(candidate=>candidate.id===item.id))) plans.push({...item,rows:[row]});
        }
      }
      for(const plan of plans) requests.push(...requestReviews(plan.rows,plan.prototype,plan.work,plan.episode,plan.observation,value,
        plan.relevance,plan.dependency,plan.critical));
      if (decisionMatch) for (const request of requests) {
        const pending = pendingReviews.get(request.request_id);
        if (pending) {
          pending.matchingSource = decisionMatch.outcome.source;
          initializeScan(pending,decisionMatch.pending.expiresAt,decisionMatch.outcome);
        }
      }
      augmentReviewEvidence(requests,value);
      const reviewExpiresAt=Math.min(value.expires_at,options.now()+REVIEW_SET_TTL_MS,decisionMatch?.pending.expiresAt??Infinity);
      const reviewPayload=requests.length?publishReview(requests,value,reviewExpiresAt):undefined;
      if (decisionMatch && reviewPayload?.status === "review_required") reviewPayload.matching_source = decisionMatch.outcome.source;
      const reviewSetId=reviewPayload?.status==="review_required"?reviewPayload.review_set_id:undefined;
      if(reviewPayload?.status==="budget_exceeded") {
        db.exec("ROLLBACK");
        active=false;
        return {prompt_id:promptId,created:false,budget_exceeded:reviewPayload};
      }
      db.exec("COMMIT");
      active = false;
      nextCleanupAt = Math.min(nextCleanupAt, value.expires_at);
      return { prompt_id: promptId, created: true, ...(decisionMatch ? {matching_source:decisionMatch.outcome.source} : {}), ...(deferred.length ? { deferred } : {}),
        ...(reviewSetId ? {review:{review_set_id:reviewSetId,expires_at:reviewExpiresAt,requests,payload:reviewPayload!}} : {}) };
    } catch (error) {
      if (active) {
        try { db.exec("ROLLBACK"); } catch {}
      }
      throw new StorageError(storageCode(error));
    }
  };
  const recordWithRetry = async (value: ObservationRecord, readControls: () => Promise<ObservationControls>,
    decisionMatch?: { pending: FrozenDecisionMatch; outcome: DecisionMatchOutcome }) => {
    try { return await recordOnce(value,readControls,decisionMatch); }
    catch (error) {
      if (!(error instanceof StorageError) || error.code !== "DB_BUSY") throw error;
      await new Promise(resolve => setTimeout(resolve,BUSY_RETRY_DELAY_MS));
      return recordOnce(value,readControls,decisionMatch);
    }
  };

  const relevantWorkflowIds = (codexTaskId: string, changedAt: number) => (db.prepare(`SELECT DISTINCT w.id
      FROM workflows w
      WHERE w.state != 'invalidated' AND (
        EXISTS (SELECT 1 FROM episode_workflows ew JOIN episodes e ON e.id=ew.episode_id JOIN observations o ON o.id=ew.observation_id JOIN prompts p ON p.id=o.prompt_id
          WHERE ew.workflow_id = w.id AND e.codex_task_id = ? AND e.started_at > ? AND e.started_at <= ? AND p.expires_at > ? AND p.occurred_at > ? AND p.occurred_at <= ?)
        OR EXISTS (SELECT 1 FROM dispatches d LEFT JOIN episodes e ON e.id = d.triggered_by_episode_id
          WHERE d.workflow_id = w.id AND (d.claimed_codex_task_id = ? OR e.codex_task_id = ?) AND d.created_at > ?)
      ) ORDER BY w.id`)
    .all(codexTaskId, Math.max(changedAt, options.now()) - WORKFLOW_WINDOW_MS, options.now(), options.now(), options.now() - WORKFLOW_WINDOW_MS, options.now(),
      codexTaskId, codexTaskId, Math.max(changedAt, options.now()) - WORKFLOW_WINDOW_MS) as Array<{ id: number }>).map(({ id }) => id);

  const applyFeedbackOnce = (value: { action: WorkflowFeedback; codexTaskId: string; workflowId?: number; dispatchId?: number; changedAt: number }) => {
    cleanup();
    nextCleanupAt = 0;
    let active = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      active = true;
      let candidates = relevantWorkflowIds(value.codexTaskId, value.changedAt);
      if (value.workflowId !== undefined) candidates = candidates.filter((id) => id === value.workflowId);
      if (value.dispatchId !== undefined) {
        const dispatch = db.prepare(`SELECT d.workflow_id FROM dispatches d
            LEFT JOIN episodes e ON e.id = d.triggered_by_episode_id
            WHERE d.id = ? AND d.created_at > ? AND (d.claimed_codex_task_id = ? OR e.codex_task_id = ?)`)
          .get(value.dispatchId, Math.max(value.changedAt, options.now()) - WORKFLOW_WINDOW_MS, value.codexTaskId, value.codexTaskId) as { workflow_id: number } | undefined;
        candidates = dispatch ? candidates.filter((id) => id === dispatch.workflow_id) : [];
      }
      if (candidates.length !== 1) {
        db.exec("COMMIT");
        active = false;
        return false;
      }
      const workflowId = candidates[0]!;
      if (value.action === "cover" || value.action === "reopen_covered") {
        const row = db.prepare("SELECT suppression, suppression_reason FROM workflows WHERE id = ?").get(workflowId)!;
        const outcome = row.suppression === "permanent" && row.suppression_reason !== "covered" ? "user_refusal" :
          value.action === "reopen_covered" && (row.suppression !== "permanent" || row.suppression_reason !== "covered") ? "not_covered" : undefined;
        if (outcome) {
          db.exec("COMMIT");
          active = false;
          return outcome;
        }
      }
      if (value.action === "cooldown") {
        db.prepare("UPDATE workflows SET cooldown_until = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?")
          .run(value.changedAt + WORKFLOW_WINDOW_MS, value.changedAt, workflowId);
      } else if (value.action === "suppress") {
        db.prepare("UPDATE workflows SET suppression = 'permanent', suppression_reason = 'user', muted_at = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?")
          .run(value.changedAt, value.changedAt, workflowId);
      } else if (value.action === "cover") {
        db.prepare("UPDATE workflows SET suppression = 'permanent', suppression_reason = 'covered', muted_at = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?")
          .run(value.changedAt, value.changedAt, workflowId);
      } else if (value.action === "reopen_covered") {
        db.prepare("UPDATE workflows SET suppression = 'none', suppression_reason = NULL, muted_at = NULL, updated_at = MAX(updated_at + 1, ?) WHERE id = ?")
          .run(value.changedAt, workflowId);
      } else {
        db.prepare("UPDATE workflows SET state = 'invalidated', invalidated_at = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?")
          .run(value.changedAt, value.changedAt, workflowId);
      }
      if (value.action !== "reopen_covered") db.prepare("UPDATE dispatches SET state = 'cancelled', finished_at = ? WHERE workflow_id = ? AND state IN ('pending', 'blocked', 'dispatching')")
        .run(value.changedAt, workflowId);
      db.exec("COMMIT");
      active = false;
      return true;
    } catch (error) {
      if (active) {
        try { db.exec("ROLLBACK"); } catch {}
      }
      throw new StorageError(storageCode(error));
    }
  };

  const cancelOpenOnce = (finishedAt: number) => {
    nextCleanupAt = 0;
    try {
      db.prepare("UPDATE dispatches SET state = 'cancelled', finished_at = ? WHERE state IN ('pending', 'blocked', 'dispatching')")
        .run(finishedAt);
    } catch (error) {
      throw new StorageError(storageCode(error));
    }
  };

  return {
    async recordPayloadMeasurement(value) {
      try {
        return recordPayloadMeasurementOnce(value);
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "DB_BUSY") throw error;
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
        return recordPayloadMeasurementOnce(value);
      }
    },
    async recordObservation(value, readControls = async () => ({detectionEnabled:true,recommendationEnabled:value.recommendation_enabled===true})) {
      const result = await recordWithRetry(value,readControls);
      return result === "stale" ? undefined : result;
    },
    prepareDecisionMatch,
    async finalizeDecisionMatch(token, outcome, readControls) {
      const pending = pendingDecisionMatches.get(token);
      if (!pending || closed) return "stale";
      try {
        if (outcome.source === "decision_model" && (false ||
            outcome.matchedWorkflowIds.some(id => !Number.isSafeInteger(id) || !pending.candidates.some(candidate => candidate.workflow_id === id)))) {
          throw new StorageError("DB_UNAVAILABLE");
        }
        if (outcome.source==="decision_model" && outcome.runnerUpWorkflowId!==undefined &&
            (!outcome.matchedWorkflowIds.length || outcome.runnerUpWorkflowId===outcome.matchedWorkflowIds[0] ||
              !pending.candidates.some(candidate=>candidate.workflow_id===outcome.runnerUpWorkflowId))) throw new StorageError("DB_UNAVAILABLE");
        return await recordWithRetry(pending.value,readControls,{pending,outcome});
      } finally { pendingDecisionMatches.delete(token); }
    },
    refreshReview: refreshReviewOnce,
    async getReviewEvidence(value, readControls, onStale) {
      const pending=pendingReviews.get(value.request_id)??pendingEpisodes.get(value.request_id);
      const occurredAt=options.now();
      let raw: ReviewEvidenceResult;
      try { raw=await getReviewEvidenceOnce(value,readControls); }
      catch (error) {
        if (storageCode(error) === "DB_BUSY") throw new StorageError("DB_BUSY");
        raw={status:"error",code:"REVIEW_SET_UNAVAILABLE"};
      }
      if(raw.status==="error" && raw.code==="SNAPSHOT_STALE" && onStale) raw=await onStale();
      const critical=raw.status!=="review_required"&&pending!==undefined&&reviewRequestBudgetMode(pending.request)==="critical";
      const budgeted=budgetReviewPayload(raw,critical?"critical":undefined);
      let result=budgeted.payload as ReviewEvidenceResult;
      if (pending&&"scan" in pending&&pending.scan&&pendingReviews.get(value.request_id)===pending&&
          pending.reviewSet?.id===value.review_set_id&&result.status!=="review_required") {
        result=scanPayload(pending,result);
        if (result.status==="budget_exceeded") discardReviewSet(value.review_set_id);
      }
      if(raw.status==="ok"&&raw.mode==="retrieval"&&result.status==="ok"&&result.mode==="retrieval"&&pending&&"selectable" in pending) {
        for(const candidate of result.candidates) if("workflow_id" in candidate) {
          pending.catalogDelivered.add(candidate.workflow_id);
        }
      }
      if(result.status==="ok"&&result.mode==="workflow"&&pending&&"selectable" in pending) {
        pending.selectable.add(result.workflow_id);
        pending.prototypeRefs.set(result.workflow_id,result.prototype_ref);
        const delivered=pending.evidenceDelivered.get(result.workflow_id)??new Set<string>();
        for(const row of result.evidence) delivered.add(row.evidence_ref);
        pending.evidenceDelivered.set(result.workflow_id,delivered);
      }
      if(pending?.reviewSet?.id===value.review_set_id&&pending.reviewSet.expiresAt>occurredAt) {
        const codexTaskId="task" in pending?pending.task:pending.value.codex_task_id;
        const turnId="turn" in pending?pending.turn:pending.value.turn_id;
        try {
          recordPayloadMeasurementOnce({codexTaskId,turnId,occurredAt,expiresAt:occurredAt+WORKFLOW_WINDOW_MS,
            phase:"evidence_expansion",resultStatus:result.status,
            ...measurePayloadText(JSON.stringify(result)),budgetMode:budgeted.budgetMode,applicableLimit:budgeted.applicableLimit});
        } catch {}
      }
      return result;
    },
    async resolveReview(value, readControls) {
      if(!capabilityReviewTransportSchema.safeParse(value).success) return false;
      const decisions=value.decisions.filter(d=>value.decisions.filter(other=>other.request_id===d.request_id).length===1);
      const reviewAt=options.now();
      for(const [id,pending] of pendingReviews) if((pending.reviewSet?.expiresAt??0)<=reviewAt) pendingReviews.delete(id);
      for(const [id,pending] of pendingEpisodes) if((pending.reviewSet?.expiresAt??0)<=reviewAt) pendingEpisodes.delete(id);
      const batch=[...pendingReviews.values()].filter(p=>p.task===value.session_id&&p.turn===value.turn_id);
      const identities=[...pendingEpisodes.values()].filter(p=>p.value.codex_task_id===value.session_id&&p.value.turn_id===value.turn_id);
      if(!batch.length&&!identities.length) return false;
      if(value.review_set_id!==undefined&&[...batch,...identities].some(p=>p.reviewSet?.id!==value.review_set_id)) return false;
      const {detectionEnabled,recommendationEnabled}=await readControls();
      if(!detectionEnabled||closed) return false;
      let active=false;
      try {
        db.exec("BEGIN IMMEDIATE");active=true;
        const at=options.now();
        // Validate model-selected identities while the frozen review is still available for one correction.
        const invalid=(code: "invalid" | "evidence_required" | "stale" = "invalid") => {db.exec("ROLLBACK");active=false;return code;};
        const scanning=batch.length===1&&identities.length===0?batch[0]:undefined;
        if (scanning?.scan) {
          const scan=scanning.scan;
          if (value.review_set_id!==scanning.reviewSet?.id) return invalid();
          if (scan.expiresAt<=at || !workCurrent(scanning,at) || !catalogCurrent(scanning,at)) return invalid("stale");
          const decision=decisions.length===1?decisions[0]:undefined;
          if (!decision || decision.request_id!==scanning.request.request_id || decision.kind!=="capability" ||
              decision.review_reason!==scanning.request.review_reason) return invalid();
          const finishScan = () => {
            db.exec("COMMIT");active=false;
            discardReviewSet(scanning.reviewSet!.id);
            return false;
          };
          if (decision.verdict==="uncertain") return finishScan();
          const activeIds=activeCandidates(scanning).map(candidate=>candidate.workflow_id);
          const completeEvidence=(id:number) => {
            const candidate=scanning.request.candidates.find(candidate=>candidate.workflow_id===id)!;
            return scanning.selectable.has(id)&&reviewCandidateFacts(scanning.reviewSet!.id,scanning.request.request_id,candidate)
              .every(row=>scanning.evidenceDelivered.get(id)?.has(row.evidence_ref));
          };
          if (decision.verdict==="same" && !activeIds.includes(decision.selected_workflow_id!)) return invalid();
          const needsEvidence=decision.verdict==="same" && (scan.phase==="final"
            ? (scanning.matchingSource==="decision_model"?activeIds:[decision.selected_workflow_id!]).some(id=>!completeEvidence(id))
            : !scanning.selectable.has(decision.selected_workflow_id!));
          if (activeIds.some(id=>!scanning.catalogDelivered.has(id)) || needsEvidence) {
            db.exec("COMMIT");active=false;
            return publishScan(scanning,true);
          }
          if (scan.phase==="scan") {
            if (decision.final_prototype!==undefined || decision.final_prototype_ref!==undefined) return invalid();
            if (decision.verdict==="same") scan.tentative=decision.selected_workflow_id!;
            else delete scan.tentative;
            if (scan.next<scanning.request.candidates.length) {
              const size=MATCH_BATCH_SIZE-Number(scan.tentative!==undefined);
              const next=scanning.request.candidates.slice(scan.next,scan.next+size).map(candidate=>candidate.workflow_id);
              scan.next+=next.length;
              scan.activeIds=[...(scan.tentative===undefined?[]:[scan.tentative]),...next];
              db.exec("COMMIT");active=false;
              return publishScan(scanning);
            }
            if (scan.tentative!==undefined) {
              scan.phase="final";scan.activeIds=[scan.tentative];
              db.exec("COMMIT");active=false;
              return publishScan(scanning);
            }
          } else if (decision.verdict==="different") {
            if (scanning.matchingSource!=="decision_model") return finishScan();
            const payloadBytes=scan.payloadBytes;
            initializeScan(scanning,scan.expiresAt);
            scanning.scan!.payloadBytes=payloadBytes;
            scanning.matchingSource="main_model_fallback";
            db.exec("COMMIT");active=false;
            return publishScan(scanning);
          }
          if (scan.next!==scanning.request.candidates.length) return invalid();
        }
        const delivered=(pending:PendingReview,id:number) => {
          const candidate=pending.request.candidates.find(candidate=>candidate.workflow_id===id);
          return pending.selectable.has(id) && (pending.request.review_reason!=="confirm" || !!candidate &&
            reviewCandidateFacts(pending.reviewSet!.id,pending.request.request_id,candidate)
              .every(row=>pending.evidenceDelivered.get(id)?.has(row.evidence_ref)));
        };
        for(const pending of batch.length===1?batch:[]) {
          const decision=decisions.find(d=>d.request_id===pending.request.request_id);
          if(!decision||decision.verdict==="uncertain") continue;
          if(decision.kind!=="capability"||decision.review_reason!==pending.request.review_reason) return invalid();
          if(decision.verdict==="same") {
            const id=decision.selected_workflow_id!;
            if(!pending.request.candidates.some(candidate=>candidate.workflow_id===id)||
              (decision.final_prototype_ref!==undefined&&pending.prototypeRefs.get(id)!==decision.final_prototype_ref)) return invalid();
            if(!delivered(pending,id)) return invalid("evidence_required");
          } else if(!pending.scan&&pending.catalogDelivered.size<pending.request.candidates.length) return invalid();
          if ((!pending.request.depends_on && !workCurrent(pending,at)) ||
              !(pending.scan?catalogCurrent(pending,at):decision.verdict==="same" ? workflowSnapshotCurrent(pending,decision.selected_workflow_id!,at) : catalogCurrent(pending,at))) return invalid("stale");
        }
        for(const pending of identities) {
          const decision=decisions.find(d=>d.request_id===pending.request.request_id);
          if(decision?.kind!=="episode"||decision.verdict!=="same") continue;
          if(!pending.snapshots.has(decision.selected_episode_id)) return invalid();
          if(episodeSnapshot(decision.selected_episode_id)!==pending.snapshots.get(decision.selected_episode_id)||
            pending.value.expires_at<=at||!episodeCandidates(pending.value,pending.request.work).some(e=>e.id===decision.selected_episode_id)) return invalid("stale");
        }
        const identitySelections=new Map<string,{pending:PendingEpisode;episode:number}>();
        for(const pending of identities) {
          const decision=decisions.find(d=>d.request_id===pending.request.request_id);
          if(decision?.kind!=="episode"||decision.verdict!=="same") continue;
          const id=decision.selected_episode_id;
          if(!pending.snapshots.has(id)||episodeSnapshot(id)!==pending.snapshots.get(id)||pending.value.expires_at<=at||
            !episodeCandidates(pending.value,pending.request.work).some(e=>e.id===id)) continue;
          identitySelections.set(pending.request.request_id,{pending,episode:id});
        }
        // Conflicting updates of one Episode are ambiguous, never last-writer-wins.
        const conflictingEpisodes=new Set([...identitySelections.values()].filter(item=>[...identitySelections.values()].filter(p=>p.episode===item.episode).length>1).map(item=>item.episode));
        for(const [key,item] of identitySelections) if(conflictingEpisodes.has(item.episode)) identitySelections.delete(key);
        const validPages=batch.flatMap(pending=>{
          const decision=decisions.find(d=>d.request_id===pending.request.request_id);
          if(decision?.kind!=="capability"||decision.review_reason!==pending.request.review_reason||decision.verdict==="uncertain") return [];
          if(decision.verdict==="same"&&!delivered(pending,decision.selected_workflow_id!)) return [];
          if(decision.verdict==="different"&&!pending.scan&&pending.catalogDelivered.size<pending.request.candidates.length) return [];
          const dependency=pending.request.depends_on;
          const current=dependency?identitySelections.has(dependency):workCurrent(pending,at);
          if(!current || !(decision.verdict==="same" ? workflowSnapshotCurrent(pending,decision.selected_workflow_id!,at) : catalogCurrent(pending,at))) return [];
          if(decision.verdict==="same") {
            const row=workflowRow(decision.selected_workflow_id!);
            const candidate=pending.request.candidates.find(item=>item.workflow_id===row?.id);
            let finalPrototype=decision.final_prototype??candidate?.prototype;
            if(decision.final_prototype_ref!==undefined) {
              finalPrototype=pending.prototypeRefs.get(row?.id??0)===decision.final_prototype_ref?candidate?.prototype:undefined;
            }
            if(!row||!pending.snapshots.has(row.id)||row.state==="invalidated"||row.scope_kind!==pending.request.capability.scope||
              (row.scope_kind==="project"&&workspaceKey(row.scope_value)!==workspaceKey(pending.cwd))||
              (decision.review_reason==="confirm"&&finalPrototype?.scope!==row.scope_kind)) return [];
            return [{pending,decision,finalPrototype}];
          }
          return [{pending,decision,finalPrototype:undefined}];
        });
        const valid=[...new Set(batch.map(pending=>pending.group))].flatMap(group=>{
          const pages=batch.filter(pending=>pending.group===group);
          const reviewed=pages.map(page=>validPages.find(item=>item.pending===page));
          const same=reviewed.filter(item=>item?.decision.verdict==="same");
          if(same.length) return [same[0]!];
          return reviewed.some(item=>!item) ? [] : [reviewed[0]!];
        }).map(item=>({...item,pending:{...item.pending}}));
        const selectedEpisodes=new Set([...identitySelections.values()].map(item=>item.episode));
        const unresolvedEpisodes=new Set(identities.filter(p=>!identitySelections.has(p.request.request_id))
          .flatMap(p=>p.candidateIds));
        // Resolve uncertainty without resurrecting evidence changed while the review was pending.
        const restorations=[...identitySelections.values()].flatMap(({pending})=>pending.withdrawn).filter(edge=>{
          const row=workflowRow(edge.workflow);
          return !selectedEpisodes.has(edge.episode) && !unresolvedEpisodes.has(edge.episode) && episodeSnapshot(edge.episode)===edge.identity && row &&
            row.state!=="invalidated" && reviewIdentity(row)===edge.workflowIdentity &&
            !db.prepare("SELECT 1 FROM episode_workflows WHERE episode_id=?").get(edge.episode) &&
            db.prepare(`SELECT 1 FROM observations o JOIN episodes e ON e.id=o.episode_id JOIN prompts p ON p.id=o.prompt_id
              WHERE o.id=? AND e.id=? AND e.started_at>? AND e.started_at<=? AND p.expires_at>? AND p.occurred_at>? AND p.occurred_at<=?
              AND o.id=(SELECT MAX(id) FROM observations WHERE episode_id=e.id)`)
              .get(edge.observation,edge.episode,at-WORKFLOW_WINDOW_MS,at,at,at-WORKFLOW_WINDOW_MS,at);
        });
        // Nothing mutates until every identity, semantic snapshot and evidence snapshot has been checked.
        for(const edge of restorations) associate(edge.episode,edge.workflow,edge.observation,parsePrototype(edge.capability),edge.relevance);
        for(const id of new Set(restorations.map(edge=>edge.workflow))) updateWorkflowShape(id,at);
        for(const [key,{pending,episode}] of identitySelections) {
          const changesCapabilities=(pending.value.observations[pending.position]!.capabilities?.length??0)>0;
          const old=changesCapabilities?db.prepare("SELECT workflow_id FROM episode_workflows WHERE episode_id=?").all(episode):[];
          if(changesCapabilities) db.prepare("DELETE FROM episode_workflows WHERE episode_id=?").run(episode);
          const observation=insertObservation(pending.value,pending.prompt,pending.position,episode);
          for(const id of old) updateWorkflowShape(Number(id.workflow_id),at);
          for(const item of valid) if(item.pending.request.depends_on===key) Object.assign(item.pending,{episode,observation});
        }
        const applied: Array<{id:number;pending:PendingReview;decision:typeof valid[number]["decision"];finalPrototype:WorkflowPrototype|undefined}>=[];
        for(const {pending,decision,finalPrototype} of valid) {
          let id:number;
          if(decision.verdict==="different") {
            // Revoke only this capability; independent sibling contributions remain intact.
            const target = confirmationTarget(pending) ?? null;
            db.prepare("DELETE FROM episode_workflows WHERE episode_id=? AND observation_id=? AND capability_json=? AND (? IS NULL OR workflow_id=?)")
              .run(pending.episode,pending.observation,JSON.stringify(pending.request.capability),target,target);
            id=createWorkflow(pending.request.capability,pending.cwd,at);
          } else id=decision.selected_workflow_id!;
          associate(pending.episode,id,pending.observation,pending.request.capability,pending.relevance);
          applied.push({id,pending,decision,finalPrototype});
        }
        for(const id of new Set(applied.flatMap(p=>[p.id,...p.pending.snapshots.keys()]))) updateWorkflowShape(id,at);
        for(const {id,pending,decision,finalPrototype} of applied) if(decision.verdict==="same"&&decision.review_reason==="confirm") {
          const confirmations=applied.filter(p=>p.id===id&&p.decision.verdict==="same"&&p.decision.review_reason==="confirm");
          if(new Set(confirmations.map(p=>capabilityKey(p.finalPrototype!))).size!==1) continue;
          const counts=countsFor(id,at);
          if(recommendationEnabled&&controlled(workflowRow(id)!,at,pending.cwd)&&meetsCurrentThreshold(counts)) {
            db.prepare(`UPDATE workflows SET state='confirmed',prototype_version=3,prototype_json=?,confirmed_at=?,confirmation_episode_count=?,confirmation_task_count=? WHERE id=?`)
              .run(JSON.stringify(finalPrototype),at,counts.episode_count,counts.task_count,id);
          }
        }
        // Already confirmed direct siblings can still dispatch when another decision was missing.
        const related=db.prepare(`SELECT DISTINCT ew.workflow_id,ew.episode_id FROM episode_workflows ew JOIN observations o ON o.id=ew.observation_id
          JOIN prompts p ON p.id=o.prompt_id WHERE p.codex_task_id=? AND p.turn_id=? AND o.extractor_version=3`).all(value.session_id,value.turn_id);
        for(const row of related) queue(Number(row.workflow_id),Number(row.episode_id),"realtime",recommendationEnabled,value.session_id,value.turn_id,batch[0]?.cwd??identities[0]?.value.workspace_path);
        const resolved=applied.length>0 || related.some(row=>workflowRow(Number(row.workflow_id))?.state==="confirmed"&&meetsCurrentThreshold(countsFor(Number(row.workflow_id),at)));
        db.exec("COMMIT");active=false;nextCleanupAt=0;
        for(const p of batch) pendingReviews.delete(p.request.request_id);
        for(const p of identities) pendingEpisodes.delete(p.request.request_id);
        return resolved;
      } catch(error) {if(active){try{db.exec("ROLLBACK");}catch{}}throw new StorageError(storageCode(error));}
    },
    async discardReview(sessionId,turnId) {
      for (const [token,pending] of pendingDecisionMatches) if (pending.value.codex_task_id===sessionId&&pending.value.turn_id===turnId) pendingDecisionMatches.delete(token);
      const reviewSetIds=new Set<string>();
      for(const [id,pending] of pendingReviews) if(pending.task===sessionId&&pending.turn===turnId) {
        if(pending.reviewSet) reviewSetIds.add(pending.reviewSet.id); else pendingReviews.delete(id);
      }
      for(const [id,pending] of pendingEpisodes) if(pending.value.codex_task_id===sessionId&&pending.value.turn_id===turnId) {
        if(pending.reviewSet) reviewSetIds.add(pending.reviewSet.id); else pendingEpisodes.delete(id);
      }
      for(const reviewSetId of reviewSetIds) discardReviewSet(reviewSetId);
    },
    async applyWorkflowFeedback(value) {
      try {
        return applyFeedbackOnce(value);
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "DB_BUSY") throw error;
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
        return applyFeedbackOnce(value);
      }
    },
    async cancelOpenDispatches(finishedAt) {
      try {
        cancelOpenOnce(finishedAt);
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "DB_BUSY") throw error;
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
        cancelOpenOnce(finishedAt);
      }
    },
    async claimDispatch(value) {
      try {
        return claimOnce(value);
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "DB_BUSY") throw error;
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
        return claimOnce(value);
      }
    },
    async blockDispatch(value) {
      const attempt = async () => blockOnce({ ...value, dispatchEnabled: await value.dispatchEnabled() });
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "DB_BUSY") throw error;
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
        return attempt();
      }
    },
    async failDispatch(value) {
      try {
        return failOnce(value);
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "DB_BUSY") throw error;
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
        return failOnce(value);
      }
    },
    async interruptRecommendation(value) {
      const attempt = () => {
        nextCleanupAt = 0;
        db.prepare(`UPDATE dispatches SET state='failed',error_code='dispatch_interrupted',finished_at=?
          WHERE state='dispatching' AND claimed_codex_task_id=? AND claimed_turn_id=?
          AND EXISTS (SELECT 1 FROM recommendation_requests r WHERE r.dispatch_id=dispatches.id)`)
          .run(value.finishedAt,value.codexTaskId,value.turnId);
      };
      try { attempt(); } catch (error) {
        if (storageCode(error) !== "DB_BUSY") throw new StorageError(storageCode(error));
        await new Promise(resolve => setTimeout(resolve,BUSY_RETRY_DELAY_MS));
        try { attempt(); } catch (retryError) { throw new StorageError(storageCode(retryError)); }
      }
    },
    async finishRecommendation(value) {
      const { finishedAt: _finishedAt, dispatchEnabled: _dispatchEnabled, ...input } = value;
      if (!finishRecommendationSchema.safeParse(input).success) return false;
      const attempt = async () => {
        const enabled = await value.dispatchEnabled();
        // Do not run best-effort cleanup here: its swallowed busy wait would hide
        // contention from the bounded retry that refreshes the live switches.
        const request = db.prepare(`SELECT r.dispatch_id,r.cwd,d.claimed_codex_task_id,d.claimed_turn_id,d.claimed_at
          FROM recommendation_requests r JOIN dispatches d ON d.id=r.dispatch_id
          WHERE r.id=? AND r.completed_at IS NULL AND d.state='dispatching'`).get(value.recommendation_id) as {
            dispatch_id:number;cwd:string;claimed_codex_task_id:string;claimed_turn_id:string;claimed_at:number;
          } | undefined;
        if (!request) return false;
        const bound = {dispatchId:request.dispatch_id,codexTaskId:request.claimed_codex_task_id,
          turnId:request.claimed_turn_id,finishedAt:value.finishedAt};
        if (request.claimed_at <= Math.max(value.finishedAt,options.now())-WEB_RECOMMENDATION_TIMEOUT_MS) {
          failOnce({...bound,errorCode:"dispatch_interrupted"});
          return false;
        }
        if (value.status === "unavailable") return failOnce({...bound,errorCode:`search_unavailable:${value.unavailable_reason}`});
        return completeOnce({...bound,cwd:request.cwd,dispatchEnabled:enabled,
          recommendation:value.status === "no_improvement"
            ? {id:value.recommendation_id,count:0,baselineSkill:value.baseline_skill}
            : {id:value.recommendation_id,count:value.recommendation_count}});
      };
      try { return await attempt(); } catch (error) {
        if (storageCode(error) !== "DB_BUSY") throw new StorageError(storageCode(error));
        await new Promise(resolve => setTimeout(resolve,BUSY_RETRY_DELAY_MS));
        try { return await attempt(); } catch (retryError) { throw new StorageError(storageCode(retryError)); }
      }
    },
    async retryUnverifiedDispatch(dispatchId, at) {
      let active = false;
      try {
        db.exec("BEGIN IMMEDIATE"); active = true;
        const row = db.prepare(`SELECT d.workflow_id, d.trigger_source FROM dispatches d
          JOIN workflows w ON w.id = d.workflow_id
          WHERE d.id = ? AND d.state = 'dispatched' AND w.state = 'confirmed' AND w.prototype_version = 3 AND w.suppression = 'none' AND w.recommendation_silenced_by IS NULL
          AND NOT EXISTS (SELECT 1 FROM dispatch_search_receipts r WHERE r.dispatch_id = d.id)
          AND NOT EXISTS (SELECT 1 FROM recommendation_requests r WHERE r.dispatch_id=d.id AND r.completed_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM dispatches newer WHERE newer.workflow_id = d.workflow_id AND newer.id > d.id)`)
          .get(dispatchId) as { workflow_id: number; trigger_source: string } | undefined;
        if (!row || !meetsCurrentThreshold(countsFor(row.workflow_id, Math.max(at, options.now())))) { db.exec("COMMIT"); active = false; return false; }
        db.prepare("UPDATE workflows SET cooldown_until = NULL, updated_at = MAX(updated_at + 1, ?) WHERE id = ?")
          .run(at, row.workflow_id);
        db.prepare(`INSERT INTO dispatches (workflow_id, trigger_source, state, prompt_template_version, created_at)
          VALUES (?, ?, 'pending', 1, ?)`).run(row.workflow_id, row.trigger_source, at);
        db.exec("COMMIT"); active = false; nextCleanupAt = 0;
        return true;
      } catch (error) {
        if (active) { try { db.exec("ROLLBACK"); } catch {} }
        throw new StorageError(storageCode(error));
      }
    },
    async completeDispatch(value) {
      if (!Number.isInteger(value.searchResultCount) || value.searchResultCount < 0 || value.searchResultCount > 5) return false;
      const attempt = async () => completeOnce({ ...value, dispatchEnabled: await value.dispatchEnabled() });
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "DB_BUSY") throw error;
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
        return attempt();
      }
    },
    async getStatusCounts() {
      cleanup();
      const now = options.now();
      const workflows = db.prepare(`SELECT
          SUM(CASE WHEN state = 'forming' AND last_seen_at > ? THEN 1 ELSE 0 END) AS forming,
          SUM(CASE WHEN state = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
          SUM(CASE WHEN cooldown_until IS NOT NULL AND cooldown_until > ? THEN 1 ELSE 0 END) AS cooldown,
          SUM(CASE WHEN suppression = 'permanent' OR recommendation_silenced_by IS NOT NULL THEN 1 ELSE 0 END) AS suppressed,
          SUM(CASE WHEN state = 'invalidated' AND last_seen_at > ? THEN 1 ELSE 0 END) AS invalidated
        FROM workflows WHERE state = 'confirmed' OR suppression = 'permanent' OR (last_seen_at > ? AND (EXISTS (
          SELECT 1 FROM episode_workflows ew JOIN episodes e ON e.id=ew.episode_id JOIN observations o ON o.id=ew.observation_id JOIN prompts p ON p.id=o.prompt_id
          WHERE ew.workflow_id = workflows.id AND p.expires_at > ? AND p.occurred_at > ? AND p.occurred_at <= ? AND e.started_at > ? AND e.started_at <= ?)
          OR (state = 'invalidated' AND EXISTS (SELECT 1 FROM dispatches d WHERE d.workflow_id = workflows.id AND d.created_at > ?))))`)
        .get(now - WORKFLOW_WINDOW_MS, now, now - WORKFLOW_WINDOW_MS, now - WORKFLOW_WINDOW_MS, now, now - WORKFLOW_WINDOW_MS, now, now - WORKFLOW_WINDOW_MS, now, now - WORKFLOW_WINDOW_MS) as {
          forming: number | null; confirmed: number | null; cooldown: number | null;
          suppressed: number | null; invalidated: number | null;
        };
      const dispatches = db.prepare(`SELECT
          SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) AS blocked
        FROM dispatches`).get() as { pending: number | null; blocked: number | null };
      const episodeCount = db.prepare(`SELECT COUNT(*) AS n FROM episodes e WHERE e.started_at>? AND e.started_at<=?
        AND EXISTS (SELECT 1 FROM observations o JOIN prompts p ON p.id=o.prompt_id WHERE o.episode_id=e.id
          AND p.expires_at>? AND p.occurred_at>? AND p.occurred_at<=?)`).get(now-WORKFLOW_WINDOW_MS, now, now, now-WORKFLOW_WINDOW_MS, now) as { n: number };
      return {
        episodes: episodeCount.n,
        forming: workflows.forming ?? 0,
        confirmed: workflows.confirmed ?? 0,
        pending: dispatches.pending ?? 0,
        blocked: dispatches.blocked ?? 0,
        cooldown: workflows.cooldown ?? 0,
        suppressed: workflows.suppressed ?? 0,
        invalidated: workflows.invalidated ?? 0,
      };
    },
    async getPayloadEstimates30d() {
      cleanup();
      const now = options.now();
      let rows: Array<{ estimated_tokens: number; budget_mode: string; result_status: string }>;
      try {
        rows = db.prepare(`SELECT estimated_tokens,budget_mode,result_status FROM payload_measurements
          WHERE expires_at > ? AND occurred_at > ? AND occurred_at <= ? ORDER BY estimated_tokens`)
          .all(now, now - WORKFLOW_WINDOW_MS, now) as typeof rows;
      } catch (error) {
        throw new StorageError(storageCode(error));
      }
      if (!rows.length) return emptyPayloadEstimates();
      const rank = (percent: number) => rows[Math.ceil(rows.length * percent) - 1]!.estimated_tokens;
      return {
        review_payload_count: rows.length,
        estimated_tokens_p50: rank(0.5),
        estimated_tokens_p95: rank(0.95),
        estimated_tokens_max: rows.at(-1)!.estimated_tokens,
        critical_payload_count: rows.filter(row => row.budget_mode === "critical").length,
        normal_limit_exceeded_count: rows.filter(row => row.budget_mode === "normal" && row.result_status === "budget_exceeded").length,
        critical_limit_exceeded_count: rows.filter(row => row.budget_mode === "critical" && row.result_status === "budget_exceeded").length,
        estimator_version: "byte_div_2_v1",
      };
    },
    getPrompt(promptId) {
      cleanup();
      const row = db.prepare("SELECT body FROM prompts WHERE id = ? AND expires_at > ? AND occurred_at > ?").get(promptId, options.now(), options.now() - WORKFLOW_WINDOW_MS) as { body?: string } | undefined;
      if (typeof row?.body !== "string") throw new StorageError("DB_UNAVAILABLE");
      return row.body;
    },
    isOpen() { return !closed && opened !== undefined; },
    ensureOpen() {
      if (closed) throw new StorageError("DB_UNAVAILABLE");
      opened ??= openOnce();
    },
    release() {
      if (closed || !opened) return;
      opened.close();
      opened = undefined;
    },
    close() {
      if (closed) return;
      closed = true;
      pendingReviews.clear();
      pendingEpisodes.clear();
      pendingDecisionMatches.clear();
      opened?.close();
      opened = undefined;
    }
  };
}
