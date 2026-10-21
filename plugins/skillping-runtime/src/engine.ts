import { access, readFile, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { openConfigStore, RECOMMENDATION_PACES, RECOMMENDATION_WINDOW_DAYS, recommendationPaceSchema,
  type ScoutConfig, type DiagnosticCode, type DiagnosticComponent, type HealthWarning } from "./config.js";
import { importCodexHistory } from "./history-import.js";
import { hasPromptExcerpt, isExternalContentSafe } from "./privacy.js";
import { decideQuestions, type DecisionOutput } from "./decisions.js";
import { RECOMMENDATION_RULES } from "./model-guidance.js";
import { emptyPayloadEstimates, measurePayloadText } from "./payload-metrics.js";
import {
  openStorage,
  StorageError,
  type PayloadMeasurement,
  type Storage,
  type ObservationRecord,
  type DecisionMatchOutcome,
} from "./storage.js";
import {
  controlSchema,
  observeTurnSchema,
  reviewEvidenceInputSchema,
  finishRecommendationSchema,
  type FinishRecommendationInput,
  type FinishRecommendationResult,
  type ClaimDispatchInput,
  type ControlInput,
  type ControlResult,
  type EngineDeps,
  type ObserveTurnInput,
  type ObserveTurnResult,
  type PayloadMeasurementInput,
  type ReviewEvidenceResult,
  type ReviewRequiredResult,
  type BudgetExceededResult,
  type ScoutEngine,
  type ScoutStatus,
  type StagePromptInput,
  type StopHookResult,
  type UserPromptHookResult
} from "./domain.js";

const STAGING_TTL_MS = 10 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HOOK_RETURN_RESERVE_MS = 300;
const HOOK_TIMEOUT_MS = 6000;
const REUSABLE_WORK_CRITERIA = "Does the current user request define work with reusable inputs, a result, and a transferable method or decision rules after incidental values are replaced? Simple tasks and existing workflows are eligible. Exclude SkillPing or Hook controls and reviews, explicit opt-outs, private or unsafe content, ordinary questions without a reusable method, and continuation, retry, formatting or requirement changes to the same work. Judge only the current user request; never infer work from assistant plans or execution outcomes.";
const decisionDescription = ({ core_goal, input_roles, output, essential_steps }: ObservationRecord["observations"][number]["fingerprint"]) =>
  ({ core_goal, input_roles, output, essential_steps });
const completeDecision = (output: DecisionOutput) =>
  output.actualModel === "kettei-fat" &&
  output.answers.every(answer => answer.status === "judged");
type DataOperations = {
  generation: number;
  clearing: boolean;
  blocked: boolean;
  active: Set<Promise<unknown>>;
  owners: Set<{ invalidate(): void; release(): Promise<void>; close(): Promise<void> }>;
  closing?: Promise<void>;
  history?: Promise<void>;
};
// Process-local coordination shares the configured data directory; idle handles are released for other processes.
const dataOperations = new Map<string, DataOperations>();
const payloadMeasurementRecorders = new WeakMap<ScoutEngine, (input: PayloadMeasurementInput) => Promise<void>>();
const idleStorageReleasers = new WeakMap<ScoutEngine, () => Promise<void>>();
const dataOperationCancelled = new Error("DATA_OPERATION_CANCELLED");

export async function recordPayloadMeasurement(engine: ScoutEngine, input: PayloadMeasurementInput) {
  await payloadMeasurementRecorders.get(engine)?.(input);
}

export async function releaseIdleStorage(engine: ScoutEngine) {
  await idleStorageReleasers.get(engine)?.().catch(() => undefined);
}

type ObservationPhase = "extract" | "review";
type StagedPhase = ObservationPhase | "processing";
type StagedPrompt = {
  prompt: string;
  cwd: string;
  model: string;
  occurredAt: number;
  nextPhase: StagedPhase;
  invalidPhase?: ObservationPhase;
  reviewSetId?: string;
  judgmentCount: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  decisionController: AbortController;
  existenceDecision?: { signature: string; result: Promise<boolean | undefined> };
};
type TurnReceipt = { cwd: string; canDispatch: boolean; consumed: boolean; expiresAt: number };

const keyFor = (sessionId: string, turnId: string) => `${sessionId}\0${turnId}`;
const hookIdentifiers = (input: StagePromptInput) => `session_id=${JSON.stringify(input.session_id)} turn_id=${JSON.stringify(input.turn_id)}`;
const isNonBlank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isStandaloneUnnamedControl = (text: string) => /^(?:pause|resume)\s+recommendations?(?:\s*(?:[,;，；]\s*)?(?:(?:but\s+)?keep(?:ing)?\s+detection(?:\s+(?:enabled|on))?|但继续保持\s*detection))?\s*[.!。]?$/iu.test(text);
const isShortOneTurnOptOut = (text: string) => /^(?:(?:skip|ignore|exclude|(?:do\s+not|don't)\s+(?:use|record|analy[sz]e|track))\s+(?:this(?:\s+current)?|the\s+current)\s+(?:request|turn|task|prompt|time)(?:\s+(?:from|for|in|with)\s+(?:the\s+)?(?:scout\s+)?(?:observations?|tracking|detection|recommendations?|log))?|keep\s+(?:this(?:\s+current)?|the\s+current)\s+(?:request|turn|task|prompt)\s+out(?:\s+of\s+(?:scout\s+)?(?:observations?|tracking|detection|recommendations?))?)\s*[.!。]?$/iu.test(text);
const isControlPrompt = (prompt: string) => {
  if (/\$skillping\b/iu.test(prompt)) return true;
  const text = prompt.trim().replace(/\bskillping\b/giu, "scout");
  if (/^(?:scout-help|(?:把\s*)?scout\s*(?:推荐(?:节奏|挡位)\s*)?(?:调成|切换到|设为)\s*(?:积极|均衡|谨慎)档|set\s+scout\s+pace\s+to\s+(?:eager|balanced|cautious))\s*[.!。]?$/iu.test(text)) return true;
  const compact = text.replace(/[.!。]$/u, "").replaceAll(/\s+/gu, "").toLowerCase();
  if (new Set([
    "查看状态", "查看已安装skill", "查看当前codex安装的skill", "开启检测", "关闭检测", "开启推荐", "关闭推荐", "导入近30天历史", "清空全部数据", "确认清空",
    "清空scout的全部数据", "清空scout全部数据", "clearallscoutdata",
    "关闭scout", "不要记录分析", "不再推荐任何skill", "关闭推荐，检测继续", "先不用这个", "以后别推荐这类",
    "以后永远别推荐这类，仍可继续记录", "这几个不是同一类", "判断错了", "这几个不是同一类/判断错了",
    "这几条不是重复工作，取消这次归类，原记录别删",
    "已在使用", "已有skill可以处理这个需求", "现有skill不够用",
    "turnscoutdetectionoffuntilienableitagain",
    "pausescoutrecommendations,butkeepscoutdetection",
    "mutescoutrecommendationswhileleavingdetectionenabled"
  ]).has(compact)) return true;
  if (isStandaloneUnnamedControl(text)) return true;
  return /^(?:(?:enable|disable|pause|resume|mute|unmute|open|close)\s+scout(?:\s+(?:detection|recommendations?|tracking))?|turn\s+scout(?:\s+(?:detection|recommendations?|tracking))?\s+(?:on|off)|(?:重新)?(?:开启|关闭|暂停|恢复)\s*scout\s*(?:检测|推荐|记录|分析|功能)?)\s*[.!。]?$/iu.test(text);
};
const isOptOut = (prompt: string) => {
  const text = prompt.trim().replace(/\bskillping\b/giu, "scout");
  return /^(?:(?:这次|本次)不要记录(?:这项工作)?|不要记录这次|请在本轮跳过\s*scout\s*的分析和记录|不要把当前任务加入\s*scout\s*跟踪)\s*[.!。]?$/iu.test(text) ||
    isShortOneTurnOptOut(text);
};
const hasExplicitSkill = (prompt: string) =>
  /\[\$[a-z][a-z0-9-]*\]\([^)\r\n]*SKILL\.md\)/i.test(prompt) ||
  /(?:^|[^\w$])\$[a-z][a-z0-9]*-[a-z0-9-]+(?=\s|$|[.,!?，。！？])/i.test(prompt) ||
  /^\s*\$[a-z][a-z0-9-]*(?=\s|$)/i.test(prompt);
const hasCredential = (prompt: string) => /(?:\b(?:password|passphrase|token|api[_ -]?key|private[_ -]?key|recovery[_ -]?code)\b\s*(?:=|:)\s*\S+|\b(?:my|secret|access)\s+(?:password|passphrase|token|api[_ -]?key|private[_ -]?key|recovery[_ -]?code)\s+(?:is|=|:)\s*\S+|(?:密码|私钥|令牌|访问令牌|恢复码)\s*(?:[:=：]|是|为)\s*\S+|\bsk-(?:proj-)?[a-z0-9_]{16,}\b|\b(?:gh[pousr]_|github_pat_)[a-z0-9_]{20,}\b|\bAKIA[A-Z0-9]{16}\b|\bxox[baprs]-[a-z0-9-]{12,}\b|-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----)/i.test(prompt);

export async function createScoutEngine(deps: EngineDeps): Promise<ScoutEngine> {
  deps = { ...deps, dataDir: await realpath(deps.dataDir) };
  const directoryKey = deps.dataDir.toLowerCase();
  let shared = dataOperations.get(directoryKey);
  if (!shared) {
    shared = { generation: 0, clearing: false, blocked: false, active: new Set(), owners: new Set() };
    dataOperations.set(directoryKey, shared);
  }
  const operations = shared;
  const configStore = await openConfigStore(deps.dataDir, deps.now);
  operations.blocked ||= configStore.readConfig().clear_pending === true;
  const closeWhenIdle = () => {
    if (operations.clearing || operations.active.size > 0) return operations.closing ?? Promise.resolve();
    if (operations.closing) return operations.closing;
    let closing!: Promise<void>;
    closing = (async () => {
      for (const owner of operations.owners) await owner.release();
    })().finally(() => { if (operations.closing === closing) delete operations.closing; });
    operations.closing = closing;
    return closing;
  };
  const latestConfig = async () => {
    try {
      return await configStore.refreshConfig();
    } catch {
      return undefined;
    }
  };
  const detectionEnabled = async () => {
    const config = await latestConfig();
    return config?.detection_enabled === true && config.clear_pending !== true && !operations.blocked;
  };
  const dispatchEnabled = async () => {
    const config = await latestConfig();
    return config?.detection_enabled === true && config.recommendation_enabled === true && config.clear_pending !== true && !operations.blocked;
  };
  const extractContext = await readFile(path.join(deps.pluginRoot, "prompts", "extract-v6.md"), "utf8")
    .then((value) => value.trim(), () => null);
  const staged = new Map<string, StagedPrompt>();
  const turnReceipts = new Map<string, TurnReceipt>();
  const skippedTurns = new Map<string, number>();
  const pendingMeasurements = new Map<string, PayloadMeasurement[]>();
  const detachedMeasurements = new Set<string>();
  let storage: Storage | undefined;
  let storageOpening: Promise<Storage> | undefined;
  let dataGeneration = configStore.readConfig().data_generation;

  const controlsFromConfig = (config: ScoutConfig | undefined, key: string, current: StagedPrompt) => {
    const eligible = config?.detection_enabled === true && config.clear_pending !== true &&
      config.data_generation === dataGeneration && !operations.blocked && staged.get(key) === current && !skippedTurns.has(key);
    return { detectionEnabled: eligible, recommendationEnabled: eligible && config?.recommendation_enabled === true };
  };
  const turnControls = async (key: string, current: StagedPrompt) => controlsFromConfig(await latestConfig(),key,current);
  const turnEligible = async (key: string, current: StagedPrompt) => (await turnControls(key,current)).detectionEnabled;

  const recordHealthFailure = async (component: DiagnosticComponent, code: DiagnosticCode, expectedGeneration = dataGeneration) => {
    try {
      await configStore.withDataAccess(expectedGeneration, () => configStore.recordFailure(component, code));
    } catch {
      // Health reporting is itself fail-open, including after a concurrent clear.
    }
  };

  const recordFailure = async (error: unknown, expectedGeneration = dataGeneration) => {
    if (error === dataOperationCancelled) return;
    const failure: HealthWarning = {
      component: "storage",
      code: error instanceof StorageError ? error.code : "DB_BUSY"
    };
    await recordHealthFailure(failure.component, failure.code, expectedGeneration);
  };

  const recordSuccess = async (component: DiagnosticComponent, expectedGeneration = dataGeneration) => {
    try {
      await configStore.withDataAccess(expectedGeneration, () => configStore.recordSuccess(component));
    } catch {
      // Health reporting is itself fail-open, including after a concurrent clear.
    }
  };

  const syncStorageGeneration = async () => {
    const config = await latestConfig() ?? configStore.readConfig();
    if (!operations.clearing) operations.blocked = config.clear_pending === true;
    if (dataGeneration !== config.data_generation) {
      invalidateState();
      storage?.close();
      storage = undefined;
      storageOpening = undefined;
      dataGeneration = config.data_generation;
    }
    return config;
  };

  const withDataGeneration = async <T>(expectedGeneration: number, work: () => Promise<T>) => {
    try {
      return await configStore.withDataAccess(expectedGeneration, work);
    } catch (error) {
      if (error instanceof Error && error.message === "DATA_GENERATION_CHANGED") {
        await syncStorageGeneration();
        throw dataOperationCancelled;
      }
      throw error;
    }
  };

  const openStorageInsideGate = async () => {
    if (storage) {
      storage.ensureOpen();
      return storage;
    }
    const opening = storageOpening ??= (async () => {
      storage = await openStorage({ filename: path.join(deps.dataDir, "scout.sqlite"), now: deps.now,
        recommendationPace: () => configStore.readConfig().recommendation_pace });
      if (configStore.readConfig().health.codes.key) await configStore.recordSuccess("key").catch(() => {});
      return storage;
    })();
    try {
      return await opening;
    } catch (error) {
      if (storageOpening === opening) storageOpening = undefined;
      throw error;
    }
  };

  const getStorage = async () => {
    if (operations.blocked) throw new StorageError("DB_UNAVAILABLE");
    // An in-flight handle must finish so a Windows clear waiting on that handle can proceed.
    if (storage?.isOpen()) return storage;
    if (storage) return withDataGeneration(dataGeneration, openStorageInsideGate);
    const config = await syncStorageGeneration();
    if (operations.blocked || config.clear_pending === true) throw new StorageError("DB_UNAVAILABLE");
    return withDataGeneration(config.data_generation, openStorageInsideGate);
  };

  const releaseHistoryStorage = async () => {
    while (true) {
      const peers = [...operations.active].filter(active => active !== operations.history);
      if (peers.length === 0) {
        storage?.release();
        return;
      }
      await Promise.allSettled(peers);
    }
  };

  const clearMeasurementState = (key: string) => {
    pendingMeasurements.delete(key);
    detachedMeasurements.delete(key);
  };

  const discard = (key: string, clearMeasurements = true) => {
    const current = staged.get(key);
    if (!current) return;
    clearTimeout(current.cleanupTimer);
    current.decisionController.abort();
    staged.delete(key);
    if (clearMeasurements) clearMeasurementState(key);
  };

  const discardRejectedTurn = (key: string) => {
    discard(key);
    detachedMeasurements.add(key);
  };

  const rememberTurn = (key: string, current: StagedPrompt, canDispatch: boolean) => {
    clearTimeout(current.cleanupTimer);
    staged.delete(key);
    turnReceipts.set(key, {
      cwd: current.cwd,
      canDispatch,
      consumed: false,
      expiresAt: deps.now() + STAGING_TTL_MS,
    });
  };

  const discardPendingReview = async (current: StagedPrompt, sessionId: string, turnId: string) => {
    if (current.nextPhase !== "review") return;
    try {
      await (await getStorage()).discardReview(sessionId, turnId);
      await recordSuccess("storage");
    } catch (error) {
      await recordFailure(error);
    }
  };

  const discardExpired = () => {
    const now = deps.now();
    for (const [key, value] of staged) {
      if (now - value.occurredAt >= STAGING_TTL_MS) discard(key);
    }
    for (const [key, value] of turnReceipts) {
      if (value.expiresAt <= now) turnReceipts.delete(key);
    }
    for (const [key, expiresAt] of skippedTurns) {
      if (expiresAt <= now) skippedTurns.delete(key);
    }
  };

  const status = async (): Promise<ScoutStatus> => {
    const statusGeneration = dataGeneration;
    let counts = { episodes: 0, forming: 0, confirmed: 0, pending: 0, blocked: 0, cooldown: 0, suppressed: 0, invalidated: 0 };
    let payloadEstimates = emptyPayloadEstimates();
    const databaseExists = storage !== undefined || await access(path.join(deps.dataDir, "scout.sqlite")).then(() => true, () => false);
    if (databaseExists && !operations.blocked) {
      try {
        const store = await getStorage();
        counts = await store.getStatusCounts();
        await recordSuccess("storage", statusGeneration);
        try {
          payloadEstimates = await store.getPayloadEstimates30d();
          await recordSuccess("storage", statusGeneration);
        } catch {
          await recordHealthFailure("storage", "PAYLOAD_ESTIMATE_AGGREGATION_FAILED", statusGeneration);
        }
      } catch (error) {
        await recordFailure(error, statusGeneration);
      }
    }
    let importState: ScoutStatus["import_state"] = "paused";
    let progressValid = false;
    try {
      importState = (await configStore.refreshImportProgress()).status;
      progressValid = true;
    } catch {
      await recordHealthFailure("history", "HISTORY_ERROR", statusGeneration);
    }
    let config = await latestConfig() ?? configStore.readConfig();
    if (progressValid && config.health.consecutive_failures.history !== undefined) {
      await recordSuccess("history", statusGeneration);
      config = await latestConfig() ?? configStore.readConfig();
    }
    return {
      detection_enabled: config.detection_enabled,
      recommendation_enabled: config.recommendation_enabled,
      recommendation_pace: config.recommendation_pace,
      health: { state: config.health.state, codes: [...new Set(Object.values(config.health.codes))].sort() },
      import_state: importState,
      counts,
      payload_estimates_30d: payloadEstimates
    };
  };

  const cancelOpenDispatches = async () => {
    const databaseExists = storage !== undefined || await access(path.join(deps.dataDir, "scout.sqlite")).then(() => true, () => false);
    if (databaseExists) await (await getStorage()).cancelOpenDispatches(deps.now());
  };

  const cancellationFailure = async (field: "detection_enabled" | "recommendation_enabled", persistedDisabled: boolean, error: unknown): Promise<ControlResult> => {
    await recordFailure(error);
    const label = field === "detection_enabled" ? "检测" : "推荐";
    return {
      status: "unavailable",
      code: error instanceof StorageError ? error.code : "DB_UNAVAILABLE",
      message: persistedDisabled
        ? `${label}已关闭，但旧 Dispatch 清理暂不可用；重新开启前会再次清理。`
        : `${label}仍为关闭；旧 Dispatch 清理暂不可用，未重新开启。`,
      summary: await status(),
    };
  };

  const control = async (input: ControlInput): Promise<ControlResult> => {
    const parsed = controlSchema.safeParse(input);
    if (!parsed.success) return { status: "needs_context", message: "请说明当前 Codex Task 中要调整的 Workflow。" };
    input = parsed.data;
    if (input.command === "help") {
      const config = await latestConfig();
      if (!config) return { status: "unavailable", code: "CONFIG_INVALID", message: "无法读取当前挡位；配置文件已保留。" };
      return { status: "ok", message: "SkillPing 使用帮助已读取。", help: {
        recommendation_pace: config.recommendation_pace,
        window_days: RECOMMENDATION_WINDOW_DAYS,
        paces: recommendationPaceSchema.options.map(id => ({ id, ...RECOMMENDATION_PACES[id] }))
      } };
    }
    if (input.command === "request_clear") {
      const config = await latestConfig();
      if (!config) return { status: "unavailable", code: "CONFIG_INVALID", message: "无法读取最新配置，未创建清空确认。" };
      confirmation = { sessionId: input.session_id, token: randomBytes(32).toString("hex"), expiresAt: deps.now() + STAGING_TTL_MS,
        generation: operations.generation, dataGeneration: config.data_generation, clearPending: config.clear_pending === true };
      return { status: "confirmation_required", confirmation_token: confirmation.token, expires_at: confirmation.expiresAt,
        message: "将清空 SkillPing 全部证据、冷却、静默、导入进度、诊断及密钥；保留检测/推荐开关、首次介绍偏好及无业务内容的协调文件。应用无法恢复。请在当前控制流程中明确回复‘确认清空’。" };
    }
    if (input.command === "confirm_clear") {
      const current = confirmation;
      if (!current || current.token !== input.confirmation_token || current.sessionId !== input.session_id || current.expiresAt <= deps.now() ||
        current.generation !== operations.generation || operations.clearing) {
        return { status: "needs_context", message: "没有当前控制流程中有效的清空确认；请重新明确请求清空 SkillPing 全部数据。" };
      }
      confirmation = undefined;
      operations.clearing = true;
      operations.blocked = true;
      operations.generation += 1;
      for (const owner of operations.owners) owner.invalidate();
      try {
        await operations.closing?.catch(() => undefined);
        // Do not hold the config queue while operations finish their final config reads.
        await Promise.allSettled([...operations.active]);
        for (const owner of operations.owners) await owner.close();
        await configStore.clearData({ dataGeneration: current.dataGeneration, clearPending: current.clearPending });
        for (const owner of operations.owners) owner.invalidate();
        operations.blocked = false;
        return { status: "ok", message: "SkillPing 全部数据及密钥已清空，应用无法恢复；检测/推荐开关、首次介绍偏好及无业务内容的协调文件已保留。" };
      } catch (error) {
        if (error instanceof Error && error.message === "CLEAR_CONFIRMATION_STALE") {
          operations.blocked = (await latestConfig())?.clear_pending === true;
          return { status: "needs_context", message: "清空确认已失效；请重新明确请求清空 SkillPing 全部数据。" };
        }
        return { status: "unavailable", code: "CLEAR_FAILED", message: "清空未完成，可能已有部分文件删除；不能宣称数据保留或全部清空。SkillPing 数据操作已暂停，请重新请求并确认清空后重试。" };
      } finally { operations.clearing = false; }
    }
    if (operations.blocked && input.command !== "status") return { status: "unavailable", code: "CLEAR_FAILED", message: "上次清空尚未完成；请重新请求并确认清空后重试。" };
    if (input.command === "status") {
      const current = await latestConfig() ?? configStore.readConfig();
      let onboarding: "first_use" | undefined;
      if (!current.intro_seen) {
        try {
          await configStore.updateConfig((config) => {
            if (!config.intro_seen) onboarding = "first_use";
            return { ...config, intro_seen: true };
          });
        } catch (error) {
          const code = error instanceof Error && error.message === "CONFIG_INVALID" ? "CONFIG_INVALID" : "CONFIG_WRITE_FAILED";
          return { status: "unavailable", code, message: "首次介绍偏好无法保存；现有配置已保留。", summary: await status() };
        }
      }
      return { status: "ok", message: "SkillPing 状态已读取。", summary: await status(), ...(onboarding ? { onboarding } : {}) };
    }
    if (input.command === "set_recommendation_pace") {
      const pace = input.pace;
      try {
        await configStore.updateConfig(config => ({ ...config, recommendation_pace: pace }));
      } catch (error) {
        const code = error instanceof Error && error.message === "CONFIG_INVALID" ? "CONFIG_INVALID" : "CONFIG_WRITE_FAILED";
        return { status: "unavailable", code, message: "推荐挡位未能保存；原设置已保留。", summary: await status() };
      }
      return { status: "ok", message: `已切换为${RECOMMENDATION_PACES[input.pace].label}档，后续工作按新挡位判断。`, summary: await status() };
    }
    if (input.command === "import_history") {
      if (!input.confirmed) return { status: "ok", message: "未读取历史；实时观察与 Dispatch 保持可用。", summary: await status() };
      if (operations.history) return { status: "ok", message: "最近 30 天历史正在导入。", summary: await status() };
      const importGeneration = dataGeneration;
      let latest = configStore.readImportProgress();
      try {
        latest = await withDataGeneration(importGeneration, async () => {
          const previous = await configStore.refreshImportProgress();
          return configStore.writeImportProgress({
            schema_version: 1,
            status: "running",
            window_days: 30,
            model: null,
            cursor: previous.status === "paused" || previous.status === "running" ? previous.cursor : null,
            source_id: previous.status === "paused" || previous.status === "running" ? previous.source_id : null,
            completed_batch: previous.status === "paused" || previous.status === "running" ? previous.completed_batch : 0,
          });
        });
      } catch {
        return { status: "unavailable", code: "HISTORY_PROGRESS_WRITE_FAILED", message: "历史导入状态无法保存；实时观察与 Dispatch 保持可用。", summary: await status() };
      }
      const job = (async () => {
        try {
          await importCodexHistory({
            cwd: deps.pluginRoot, dataDir: deps.dataDir, now: deps.now(), cursor: latest.cursor,
            completedBatch: latest.completed_batch, spawnProcess: deps.spawnProcess,
            startWorker: work => withDataGeneration(importGeneration, work),
            workerCancelled: async () => {
              const config = await latestConfig();
              return config === undefined || config.clear_pending === true || config.data_generation !== importGeneration;
            },
            async record(value) {
              try {
                await withDataGeneration(importGeneration, async () => {
                  const store = await openStorageInsideGate();
                  await store.recordObservation(value, async () => ({ detectionEnabled: true, recommendationEnabled: false }));
                  await configStore.recordSuccess("storage").catch(() => {});
                });
              } finally {
                await releaseHistoryStorage();
              }
            },
            async progress(value) {
              latest = await withDataGeneration(importGeneration, () => configStore.writeImportProgress({
                schema_version: 1, status: "running", window_days: 30, model: null,
                cursor: value.cursor, source_id: value.sourceId, completed_batch: value.completedBatch
              }));
            },
          });
          await withDataGeneration(importGeneration, async () => {
            latest = await configStore.writeImportProgress({ ...latest, status: "completed", cursor: null });
            await configStore.recordSuccess("history").catch(() => {});
          });
        } catch (error) {
          if (error === dataOperationCancelled) return;
          await withDataGeneration(importGeneration, async () => {
            await configStore.writeImportProgress({ ...latest, status: "paused" });
            await configStore.recordFailure("history", "HISTORY_ERROR");
          }).catch(() => {});
        }
      })();
      operations.history = job;
      operations.active.add(job);
      void job.finally(() => {
        if (operations.history === job) delete operations.history;
        operations.active.delete(job);
        void closeWhenIdle().catch(() => {});
      }).catch(() => {});
      return { status: "ok", message: "已开始导入最近 30 天 Codex 历史；实时观察与推荐保持可用。", summary: await status() };
    }
    if (input.command === "retry_unverified_dispatch") {
      try {
        const applied = await (await getStorage()).retryUnverifiedDispatch(input.dispatch_id, deps.now());
        return { status: applied ? "ok" : "needs_context", message: applied
          ? "旧版未验证派发已排入待处理，原记录保留；后续符合条件的新请求才会执行搜索。"
          : "该派发不存在、已有搜索回执、已有后续派发或工作流不可用，未修改。" };
      } catch (error) {
        await recordFailure(error);
        return { status: "unavailable", code: "DB_UNAVAILABLE", message: "恢复未完成，未执行搜索。" };
      }
    }
    if (input.command === "skip_turn") {
      const key = keyFor(input.session_id, input.turn_id);
      const current = staged.get(key);
      if (current?.nextPhase === "review" && storage) await (await getStorage()).discardReview(input.session_id, input.turn_id);
      discard(key);
      clearMeasurementState(key);
      turnReceipts.delete(key);
      skippedTurns.set(key, deps.now() + STAGING_TTL_MS);
      return { status: "ok", message: "本轮已跳过。", summary: await status() };
    }
    // All remaining Task-scoped commands are Workflow feedback. Keep this map exhaustive.
    if ("session_id" in input) {
      const feedback = {
        cooldown_workflow: { action: "cooldown", message: "该 Workflow 已冷却30天。" },
        suppress_workflow: { action: "suppress", message: "该 Workflow 已永久静默；后续观察仍可更新。" },
        invalidate_workflow: { action: "invalidate", message: "该 Workflow 已标记为判断无效。" },
        cover_workflow: { action: "cover", message: "该 Workflow 已标记为已有 Skill 覆盖，自动推荐已暂停；后续观察仍可更新。" },
        reopen_covered_workflow: { action: "reopen_covered", message: "该 Workflow 的已覆盖暂停已解除；冷却及其他限制仍然有效，后续相关工作达标时才会搜索。" },
      } as const satisfies Record<typeof input.command, {
        action: Parameters<Storage["applyWorkflowFeedback"]>[0]["action"];
        message: string;
      }>;
      const { action, message } = feedback[input.command];
      const databaseExists = storage !== undefined || await access(path.join(deps.dataDir, "scout.sqlite")).then(() => true, () => false);
      if (!databaseExists) return { status: "needs_context", message: "当前 Codex Task 中没有可唯一定位的 Workflow；请说明要调整哪一个。" };
      try {
        const applied = await (await getStorage()).applyWorkflowFeedback({
          action,
          codexTaskId: input.session_id,
          ...(input.workflow_id === undefined ? {} : { workflowId: input.workflow_id }),
          ...(input.dispatch_id === undefined ? {} : { dispatchId: input.dispatch_id }),
          changedAt: deps.now(),
        });
        if (!applied) return { status: "needs_context", message: "当前 Codex Task 中没有可唯一定位的 Workflow；请说明要调整哪一个。" };
        if (applied === "user_refusal") return { status: "ok", message: "该 Workflow 已被明确拒绝，永久静默保持不变。", summary: await status() };
        if (applied === "not_covered") return { status: "ok", message: "该 Workflow 没有待恢复的已覆盖状态；现有限制保持不变。", summary: await status() };
        return { status: "ok", message, summary: await status() };
      } catch (error) {
        await recordFailure(error);
        return { status: "unavailable", code: error instanceof StorageError ? error.code : "DB_UNAVAILABLE", message: "反馈未应用；现有记录已保留。" };
      }
    }
    const changes = {
      enable_detection: ["detection_enabled", true, "检测已开启。"],
      disable_detection: ["detection_enabled", false, "检测已关闭。"],
      enable_recommendations: ["recommendation_enabled", true, "推荐已开启。"],
      disable_recommendations: ["recommendation_enabled", false, "推荐已关闭。"]
    } as const;
    const [field, value, message] = changes[input.command];
    const previous = await latestConfig() ?? configStore.readConfig();
    if (value && previous[field] === false) {
      try {
        await cancelOpenDispatches();
      } catch (error) {
        return cancellationFailure(field, false, error);
      }
    }
    try {
      await configStore.updateConfig((config) => ({ ...config, [field]: value }));
    } catch (error) {
      const code = error instanceof Error && error.message === "CONFIG_INVALID" ? "CONFIG_INVALID" : "CONFIG_WRITE_FAILED";
      return { status: "unavailable", code, message: "设置未更改；现有配置已保留。" };
    }
    if (!value) {
      if (field === "detection_enabled") {
        for (const [key, current] of staged) {
          if (current.nextPhase === "review" && storage) {
            const [sessionId, turnId] = key.split("\0");
            await (await getStorage()).discardReview(sessionId!, turnId!);
          }
          discard(key);
        }
        turnReceipts.clear();
      }
      try {
        await cancelOpenDispatches();
      } catch (error) {
        return cancellationFailure(field, true, error);
      }
    }
    return { status: "ok", message, summary: await status() };
  };

  const stageLocally = (input: StagePromptInput, config: ScoutConfig | undefined) => {
    discardExpired();
    if (!isNonBlank(input.session_id) || !isNonBlank(input.turn_id) || !isNonBlank(input.prompt) ||
      !isNonBlank(input.cwd) || !isNonBlank(input.model) || config?.detection_enabled !== true || config.clear_pending === true || operations.blocked || input.prompt.includes("scout_internal") ||
      isControlPrompt(input.prompt) || isOptOut(input.prompt) || hasExplicitSkill(input.prompt) || hasCredential(input.prompt)) {
      return undefined;
    }
    if (!extractContext) return undefined;
    const key = keyFor(input.session_id, input.turn_id);
    if (turnReceipts.has(key) || skippedTurns.has(key)) return undefined;
    if (!staged.has(key)) {
      const cleanupTimer = setTimeout(() => discard(key), STAGING_TTL_MS);
      cleanupTimer.unref?.();
      staged.set(key, {
        prompt: input.prompt,
        cwd: input.cwd,
        model: input.model,
        occurredAt: deps.now(),
        nextPhase: "extract",
        judgmentCount: 0,
        decisionController: new AbortController(),
        cleanupTimer
      });
    }
    const current = staged.get(key)!;
    if (current.prompt !== input.prompt || current.cwd !== input.cwd || current.model !== input.model) return undefined;
    return {key,current};
  };
  const hookContext = (input: StagePromptInput): UserPromptHookResult => ({ hookSpecificOutput: {
    hookEventName: "UserPromptSubmit", additionalContext: `${extractContext}\n\nUse these exact Hook identifiers: ${hookIdentifiers(input)}.`
  } });
  const stagePrompt = async (input: StagePromptInput, startedAt: number, signal: AbortSignal): Promise<UserPromptHookResult> => {
    if (signal.aborted) return {};
    const config = await latestConfig();
    if (signal.aborted) return {};
    const local = stageLocally(input,config);
    if (!local || !config) return {};
    const {key,current} = local;
    const settings = config.decision_model;
    const threshold = settings.existence?.threshold;
    const timeoutMs = Math.min(settings.precheck_timeout_ms,Math.floor(HOOK_TIMEOUT_MS-HOOK_RETURN_RESERVE_MS-(performance.now()-startedAt)));
    if (settings.enabled && settings.allow_external && threshold !== undefined && timeoutMs > 0 && isExternalContentSafe(current.prompt)) {
      const signature = JSON.stringify([config.data_generation,config.decision_revision,settings]);
      if (current.existenceDecision?.signature !== signature) current.existenceDecision = { signature, result: (async () => {
        const result = await decideQuestions({ content: current.prompt, questions: [{id:"reusable_work",criteria:REUSABLE_WORK_CRITERIA}] }, {
          enabled:true,model:settings.model,timeoutMs,signal:AbortSignal.any([current.decisionController.signal,signal]),
          ...(deps.sqwishApiKey ? {apiKey:deps.sqwishApiKey} : {}),...(deps.fetch ? {fetch:deps.fetch} : {})
        });
        const after = await latestConfig();
        if (signal.aborted || after?.decision_revision !== config.decision_revision || after?.data_generation !== config.data_generation ||
            JSON.stringify(after.decision_model) !== JSON.stringify(settings) || !controlsFromConfig(after,key,current).detectionEnabled) return undefined;
        const answer = result.answers[0];
        return completeDecision(result) && answer?.status === "judged" ? answer.yesProbability >= threshold : undefined;
      })() };
      const hasWork = await current.existenceDecision.result;
      const after = configStore.readConfig();
      if (!controlsFromConfig(after,key,current).detectionEnabled) { discard(key); return {}; }
      if (!signal.aborted && hasWork === false && after.decision_revision === config.decision_revision &&
          JSON.stringify(after.decision_model) === JSON.stringify(settings)) {
        discard(key);
        skippedTurns.set(key,deps.now()+STAGING_TTL_MS);
        return {};
      }
    }
    return hookContext(input);
  };

  const recordDecisionObservation = async (store: Storage, value: ObservationRecord, key: string, current: StagedPrompt,
    config: Awaited<ReturnType<typeof configStore.refreshConfig>>) => {
    const settings = config.decision_model, threshold = settings.matching?.threshold;
    if (!settings.enabled || !settings.allow_external || threshold === undefined) return store.recordObservation(value,() => turnControls(key,current));
    const expectedGeneration = config.data_generation;
    const readControls = async () => {
      const after = await latestConfig();
      const eligible = after?.data_generation === expectedGeneration && after.decision_revision === config.decision_revision &&
        JSON.stringify(after.decision_model) === JSON.stringify(settings) && !current.decisionController.signal.aborted;
      const controls = controlsFromConfig(after,key,current);
      return {detectionEnabled:eligible&&controls.detectionEnabled,recommendationEnabled:eligible&&controls.recommendationEnabled};
    };
    const pending = await store.prepareDecisionMatch(value,readControls);
    if (!pending) return undefined;
    const input = { content: JSON.stringify({work:decisionDescription(pending.work),capability:decisionDescription(pending.capability)}),
      questions:pending.candidates.map(candidate=>({id:`workflow_${candidate.workflow_id}`,
        criteria:`Does the work match this prototype's goal, reusable method, necessary conditions, inputs and output? Topic, tools or file format alone are insufficient. Do not invent missing requirements. Prototype: ${JSON.stringify(decisionDescription(candidate.prototype))}`})) };
    let outcome: DecisionMatchOutcome = {source:"main_model_fallback"};
    if (pending.candidates.length === 0) outcome = {source:"decision_model",matchedWorkflowIds:[]};
    else if ([pending.work,pending.capability,...pending.candidates.map(candidate=>candidate.prototype)]
      .every(description=>Object.values(decisionDescription(description)).flat().every(isExternalContentSafe))) {
      const result = await decideQuestions(input,{enabled:true,model:settings.model,timeoutMs:settings.match_timeout_ms,
        signal:current.decisionController.signal,...(deps.sqwishApiKey ? {apiKey:deps.sqwishApiKey} : {}),...(deps.fetch ? {fetch:deps.fetch} : {})});
      if (completeDecision(result)) outcome = {source:"decision_model",matchedWorkflowIds:pending.candidates.flatMap((candidate,index)=>{
        const answer = result.answers[index];
        return answer?.status === "judged" && answer.yesProbability >= threshold ? [candidate.workflow_id] : [];
      })};
    }
    let stored = await withDataGeneration(expectedGeneration,() => store.finalizeDecisionMatch(pending.token,outcome,readControls));
    if (stored === "stale" && current.invalidPhase === undefined && (await readControls()).detectionEnabled) {
      current.invalidPhase = "review";
      const fresh = await store.prepareDecisionMatch(value,readControls);
      stored = fresh ? await withDataGeneration(expectedGeneration,() => store.finalizeDecisionMatch(fresh.token,{source:"main_model_fallback"},readControls)) : undefined;
      if (stored && stored !== "stale" && stored.review) stored.review.payload.refresh_reason = "snapshot_stale";
    }
    return stored === "stale" ? undefined : stored;
  };

  const refreshStaleReview = async (key: string, current: StagedPrompt): Promise<ReviewRequiredResult | BudgetExceededResult |
    { status: "accepted"; deferred: Array<{ position: number; reason: string }> }> => {
    const store = await getStorage();
    // Input correction and snapshot refresh share the existing single review recovery allowance.
    if (await turnEligible(key,current) && current.invalidPhase !== "review" && current.reviewSetId) {
      current.invalidPhase = "review";
      try {
        const refreshed = await store.refreshReview(current.reviewSetId, () => turnControls(key,current));
        if (refreshed && await turnEligible(key,current)) {
          if (refreshed.status === "review_required") current.reviewSetId = refreshed.review_set_id;
          else rememberTurn(key,current,false);
          return refreshed;
        }
      } catch (error) {
        await recordFailure(error);
      }
    }
    const [sessionId,turnId] = key.split("\0");
    await store.discardReview(sessionId!,turnId!);
    rememberTurn(key,current,false);
    return { status: "accepted", deferred: [{ position: 0, reason: "review_snapshot_stale" }] };
  };

  const observeTurn = async (input: ObserveTurnInput): Promise<ObserveTurnResult> => {
    discardExpired();
    const maybeIds = input as Partial<{ session_id: unknown; turn_id: unknown }>;
    if (typeof maybeIds.session_id !== "string" || typeof maybeIds.turn_id !== "string") return { status: "ignored" };
    const key = keyFor(maybeIds.session_id, maybeIds.turn_id);
    const current = staged.get(key);
    if (!current) return { status: "ignored" };
    if (current.nextPhase === "processing") return { status: "ignored" };
    current.judgmentCount += 1;
    const parsed = observeTurnSchema.safeParse(input);
    if (!parsed.success) {
      if (current.judgmentCount >= 2 && current.nextPhase !== "review") {
        await discardPendingReview(current, maybeIds.session_id, maybeIds.turn_id);
        discardRejectedTurn(key);
        return { status: "invalid", code: "INVALID_INPUT", retry_allowed: false };
      }
      if (current.invalidPhase === current.nextPhase) {
        await discardPendingReview(current, maybeIds.session_id, maybeIds.turn_id);
        discardRejectedTurn(key);
        return { status: "invalid", code: "INVALID_INPUT", retry_allowed: false };
      }
      current.invalidPhase = current.nextPhase;
      return { status: "invalid", code: "INVALID_INPUT", retry_allowed: true };
    }
    if (parsed.data.phase !== current.nextPhase) {
      if (current.judgmentCount >= 2) {
        await discardPendingReview(current, maybeIds.session_id, maybeIds.turn_id);
        discardRejectedTurn(key);
      }
      return { status: "ignored" };
    }
    if (hasPromptExcerpt(parsed.data, current.prompt)) {
      const canCorrect = current.invalidPhase !== parsed.data.phase &&
        (parsed.data.phase === "review" || current.judgmentCount < 2);
      if (canCorrect) {
        current.invalidPhase = parsed.data.phase;
        return { status: "invalid", code: "PROMPT_EXCERPT", retry_allowed: true };
      }
      await discardPendingReview(current, maybeIds.session_id, maybeIds.turn_id);
      discardRejectedTurn(key);
      return { status: "invalid", code: "PROMPT_EXCERPT", retry_allowed: false };
    }
    if (parsed.data.phase === "review") {
      if (parsed.data.review_set_id !== undefined && parsed.data.review_set_id !== current.reviewSetId) {
        if (current.invalidPhase === "review") {
          await discardPendingReview(current, maybeIds.session_id, maybeIds.turn_id);
          discardRejectedTurn(key);
          return { status: "invalid", code: "INVALID_INPUT", retry_allowed: false };
        }
        current.invalidPhase = "review";
        return { status: "invalid", code: "INVALID_INPUT", retry_allowed: true };
      }
      let resolved: boolean | "invalid" | "evidence_required" | "stale" = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const store = await getStorage();
          const config = await latestConfig();
          if (config?.detection_enabled !== true || !await turnEligible(key, current)) {
            await store.discardReview(parsed.data.session_id, parsed.data.turn_id);
            discard(key);
            return { status: "ignored" };
          }
          resolved = await store.resolveReview(parsed.data, () => turnControls(key, current));
          if (resolved === "stale") return await refreshStaleReview(key,current);
          await recordSuccess("storage");
          break;
        } catch (error) {
          const code = error instanceof StorageError ? error.code : "DB_UNAVAILABLE";
          if (!await turnEligible(key, current)) {
            discard(key);
            return { status: "ignored" };
          }
          // Reopening an idle handle can also hit the lock; retry the whole operation once.
          if (code === "DB_BUSY" && attempt === 0) {
            await new Promise(resolve => setTimeout(resolve, 25));
            continue;
          }
          await recordFailure(error);
          const retryAllowed = code === "DB_BUSY" && current.invalidPhase !== "review";
          if (retryAllowed) current.invalidPhase = "review";
          else {
            await storage?.discardReview(parsed.data.session_id, parsed.data.turn_id);
            discardRejectedTurn(key);
          }
          return { status: "unavailable", code, retry_allowed: retryAllowed,
            instructions: retryAllowed
              ? "SkillPing storage is busy; this review was not saved. Resubmit the same review once with the same identifiers and decisions. Do not re-extract."
              : "SkillPing could not save this review. Stop SkillPing for this turn and continue the user's task; do not resubmit or re-extract." };
        }
      }
      if (!await turnEligible(key, current)) {
        discard(key);
        return { status: "ignored" };
      }
      if (resolved === "invalid" || resolved === "evidence_required") {
        const code = resolved === "evidence_required" ? "EVIDENCE_REQUIRED" as const : "INVALID_INPUT" as const;
        if (current.invalidPhase === "review") {
          await discardPendingReview(current, parsed.data.session_id, parsed.data.turn_id);
          discardRejectedTurn(key);
          return { status: "invalid", code, retry_allowed: false };
        }
        current.invalidPhase = "review";
        return { status: "invalid", code, retry_allowed: true };
      }
      rememberTurn(key, current, resolved === true);
      const deferred = parsed.data.decisions.flatMap((decision, position) =>
        decision.verdict === "uncertain" ? [{ position, reason: "review_uncertain" }] : []);
      return { status: "accepted", ...(deferred.length ? { deferred } : {}) };
    }
    if (parsed.data.disposition !== "analyze") {
      discard(key);
      return { status: "accepted", disposition: "skip" };
    }
    const correctedRetry = current.judgmentCount >= 2 && current.invalidPhase === parsed.data.phase;
    if (current.judgmentCount >= 2 && !correctedRetry) {
      discard(key);
      return { status: "accepted" };
    }
    current.nextPhase = "processing";
    if (!await turnEligible(key, current)) {
      discard(key);
      return { status: "ignored" };
    }
    let storageReview;
    let storageBudget;
    let deferred: Array<{ position: number; reason: string }> | undefined;
    let matchingSource: import("./domain.js").MatchingSource | undefined;
    let storageSucceeded = parsed.data.items.length === 0;
    if (parsed.data.items.length > 0) {
      try {
        const store = await getStorage();
        if (!await turnEligible(key, current)) {
          discard(key);
          return { status: "ignored" };
        }
        const config = await latestConfig();
        if (config?.detection_enabled !== true || !await turnEligible(key, current)) {
          discard(key);
          return { status: "ignored" };
        }
        const value: ObservationRecord = {
          codex_task_id: parsed.data.session_id,
          turn_id: parsed.data.turn_id,
          message_id: "",
          source: "realtime",
          occurred_at: current.occurredAt,
          expires_at: current.occurredAt + RETENTION_MS,
          workspace_path: current.cwd,
          prompt: current.prompt,
          recommendation_enabled: config.recommendation_enabled,
          observations: parsed.data.items.map((item) => ({
            relation: "new",
            confidence: item.confidence,
            variable_slots: item.variables ?? [],
            capabilities: item.capabilities.map(candidate => "base" in candidate ? {
              core_goal: candidate.core_goal,
              input_roles: candidate.input_roles ?? item.input_roles,
              output: candidate.output ?? item.output,
              essential_steps: candidate.essential_steps ?? item.essential_steps,
              variable_slots: candidate.variable_slots ?? [],
              scope: candidate.scope,
              confidence: candidate.confidence,
            } : candidate),
            fingerprint: {
              core_goal: item.core_goal,
              input_roles: item.input_roles,
              output: item.output,
              essential_steps: item.essential_steps,
              scope: item.scope_hint
            }
          }))
        };
        const stored = await recordDecisionObservation(store,value,key,current,config);
        if (!stored) { discard(key); return {status:"ignored"}; }
        matchingSource = stored?.matching_source;
        storageReview = stored?.review;
        storageBudget = stored?.budget_exceeded;
        deferred = stored?.deferred;
        storageSucceeded = stored !== undefined;
        await recordSuccess("storage");
      } catch (error) {
        await recordFailure(error);
        const eligible = await turnEligible(key, current);
        // End the failed turn without a receipt, so payload accounting cannot retry the key again.
        discard(key);
        if (!eligible) return { status: "ignored" };
        return { status: "unavailable",
          code: error instanceof StorageError ? error.code : "DB_UNAVAILABLE",
          retry_allowed: false,
          instructions: "SkillPing extraction was not saved. Stop SkillPing for this turn and continue the user's task; do not resubmit or re-extract." };
      }
    }
    if (!await turnEligible(key, current)) {
      discard(key);
      return { status: "ignored" };
    }
    if (storageBudget) {
      rememberTurn(key, current, false);
      return storageBudget;
    }
    if (storageReview && storageReview.requests.length > 0) {
      current.nextPhase = "review";
      current.reviewSetId = storageReview.payload.review_set_id;
      if (correctedRetry) current.invalidPhase = "review";
      else delete current.invalidPhase;
      return storageReview.payload;
    }
    if (storageReview) await (await getStorage()).discardReview(parsed.data.session_id, parsed.data.turn_id);
    rememberTurn(key, current, storageSucceeded);
    return { status: "accepted", ...(matchingSource ? {matching_source:matchingSource} : {}), ...(deferred?.length ? { deferred } : {}) };
  };

  const claimDispatch = async (input: ClaimDispatchInput): Promise<StopHookResult> => {
    discardExpired();
    const key = keyFor(input.session_id, input.turn_id);
    discard(key);
    const receipt = turnReceipts.get(key);
    if (input.stop_hook_active) {
      if (receipt) receipt.consumed = true;
      if (await access(path.join(deps.dataDir, "scout.sqlite")).then(() => true, () => false)) {
        try {
          await (await getStorage()).interruptRecommendation({codexTaskId:input.session_id,turnId:input.turn_id,finishedAt:deps.now()});
        } catch (error) { await recordFailure(error); }
      }
      return {};
    }
    if (!receipt || receipt.consumed) return {};
    receipt.consumed = true;
    if (!receipt.canDispatch || !await dispatchEnabled()) return {};
    if (storage === undefined && !await access(path.join(deps.dataDir, "scout.sqlite")).then(() => true, () => false)) return {};

    let store: Storage;
    let claim;
    try {
      store = await getStorage();
      claim = await store.claimDispatch({
        codexTaskId: input.session_id,
        turnId: input.turn_id,
        cwd: receipt.cwd,
        claimedAt: deps.now(),
        recommendation: "web",
      });
      await recordSuccess("storage");
    } catch (error) {
      await recordFailure(error);
      return {};
    }
    if (!claim) return {};
    const failClaim = async (errorCode: string) => {
      try {
        await store.failDispatch({
          dispatchId: claim.id,
          codexTaskId: input.session_id,
          turnId: input.turn_id,
          errorCode,
          finishedAt: deps.now(),
        });
        await recordSuccess("storage");
      } catch (error) {
        await recordFailure(error);
      }
    };

    if (!await dispatchEnabled() || !claim.recommendation_id) { await failClaim("search_cancelled"); return {}; }
    const reason = JSON.stringify({
      capability: claim.prototype,
      rules: `Bundled find-skills guide: ${JSON.stringify(path.resolve(deps.pluginRoot, "third-party/find-skills/SKILL.md"))}\n${RECOMMENDATION_RULES}`,
      finish_call: {tool:"finish_recommendation",arguments:{recommendation_id:claim.recommendation_id}},
    });
    return { decision: "block", reason };
  };

  const finishRecommendation = async (input: FinishRecommendationInput): Promise<FinishRecommendationResult> => {
    const parsed = finishRecommendationSchema.safeParse(input);
    if (!parsed.success) return {status:"invalid",code:"INVALID_INPUT"};
    if (!await access(path.join(deps.dataDir,"scout.sqlite")).then(() => true,() => false)) return {status:"ignored"};
    try {
      const committed = await (await getStorage()).finishRecommendation({...parsed.data,finishedAt:deps.now(),dispatchEnabled});
      await recordSuccess("storage");
      return {status:committed ? "accepted" : "ignored"};
    } catch (error) {
      await recordFailure(error);
      return {status:"unavailable",code:"RECOMMENDATION_FINISH_FAILED"};
    }
  };

  const getReviewEvidence = async (raw: unknown): Promise<ReviewEvidenceResult> => {
    const parsed = reviewEvidenceInputSchema.safeParse(raw);
    if (!parsed.success) {
      // A page-size typo must use the same recovery allowance as review correction.
      const corrected = raw && typeof raw === "object" && !Array.isArray(raw)
        ? reviewEvidenceInputSchema.safeParse({ ...raw, limit: undefined }) : undefined;
      const pending = corrected?.success ? [...staged].find(([, current]) =>
        current.nextPhase === "review" && current.reviewSetId === corrected.data.review_set_id) : undefined;
      if (!pending) return { status: "invalid", code: "INVALID_INPUT" };
      const [key, current] = pending;
      const retryAllowed = await turnEligible(key, current) && current.invalidPhase !== "review";
      if (retryAllowed) current.invalidPhase = "review";
      else {
        const [sessionId, turnId] = key.split("\0");
        await discardPendingReview(current, sessionId!, turnId!);
        discardRejectedTurn(key);
      }
      return { status: "invalid", code: "INVALID_INPUT", field: "limit", retry_allowed: retryAllowed,
        instructions: retryAllowed
          ? "limit must be an integer from 1 to 50. Retry this evidence call once with the same IDs and cursor, omitting limit to use the budgeted default. Do not re-extract or submit uncertain for this parameter error."
          : "Stop SkillPing for this turn and continue the user's task; the shared correction allowance is exhausted or the turn is no longer eligible." };
    }
    const input = parsed.data;
    if (!storage || operations.blocked) return { status: "error", code: "REVIEW_SET_UNAVAILABLE" };
    for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stagedReview = [...staged].find(([,current])=>current.nextPhase==="review" && current.reviewSetId===input.review_set_id);
      const result = await (await getStorage()).getReviewEvidence(input, async () => {
        const config = await latestConfig();
        return {
          detectionEnabled: config?.detection_enabled === true && config.clear_pending !== true && !operations.blocked,
          recommendationEnabled: config?.recommendation_enabled === true,
        };
      }, stagedReview ? () => refreshStaleReview(stagedReview[0],stagedReview[1]) : undefined);
      await recordSuccess("storage");
      return result;
    } catch (error) {
      if (error instanceof StorageError && error.code === "DB_BUSY" && attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 25));
        continue;
      }
      await recordFailure(error);
      if (error instanceof StorageError && error.code === "DB_BUSY") {
        const pending = [...staged].find(([, current]) => current.reviewSetId === input.review_set_id);
        if (pending) {
          const [sessionId, turnId] = pending[0].split("\0");
          await storage?.discardReview(sessionId!, turnId!);
          discardRejectedTurn(pending[0]);
        }
        return { status: "error", code: "DB_BUSY", retry_allowed: false,
          instructions: "SkillPing evidence is temporarily unavailable because storage is busy after one internal retry. Stop SkillPing for this turn and continue the user's task; do not re-extract or resubmit." };
      }
      return { status: "error", code: "REVIEW_SET_UNAVAILABLE" };
    }
    }
    return { status: "error", code: "REVIEW_SET_UNAVAILABLE" };
  };

  const persistPayloadMeasurement = async (input: PayloadMeasurementInput) => {
    const key = keyFor(input.session_id, input.turn_id);
    const detached = detachedMeasurements.delete(key);
    const eligible = staged.has(key) || detached ||
      (input.result_status !== "ignored" && turnReceipts.has(key));
    if (!eligible) return;
    const occurredAt = deps.now();
    const measurement: PayloadMeasurement = {
      codexTaskId: input.session_id,
      turnId: input.turn_id,
      occurredAt,
      expiresAt: occurredAt + RETENTION_MS,
      phase: input.phase,
      resultStatus: input.result_status,
      ...measurePayloadText(input.payload),
      budgetMode: input.budget_mode,
      applicableLimit: input.applicable_limit,
    };
    const remaining = [...pendingMeasurements.get(key) ?? [], measurement];
    try {
      const store = await getStorage();
      while (remaining.length) {
        if (!await store.recordPayloadMeasurement(remaining[0]!)) {
          if (staged.has(key)) pendingMeasurements.set(key, remaining);
          return;
        }
        remaining.shift();
      }
      pendingMeasurements.delete(key);
      await recordSuccess("storage");
    } catch (error) {
      if (staged.has(key)) pendingMeasurements.set(key, remaining);
      await recordFailure(error);
    }
  };

  let confirmation: { sessionId: string; token: string; expiresAt: number; generation: number;
    dataGeneration: number; clearPending: boolean } | undefined;
  function invalidateState() {
    for (const key of staged.keys()) discard(key);
    turnReceipts.clear();
    skippedTurns.clear();
    pendingMeasurements.clear();
    detachedMeasurements.clear();
    confirmation = undefined;
    configStore.resetImportSnapshot();
  }
  operations.owners.add({
    invalidate: invalidateState,
    async release() {
      await storageOpening?.catch(() => undefined);
      storage?.release();
    },
    async close() {
      await storageOpening?.catch(() => undefined);
      storage?.close();
      storage = undefined;
      storageOpening = undefined;
    },
  });
  const track = <T>(work: () => Promise<T>, cancelled: T): Promise<T> => {
    let pending!: Promise<T>;
    pending = (async () => {
      try {
        await operations.closing?.catch(() => undefined);
        if (operations.clearing) return cancelled;
        await syncStorageGeneration();
        if (operations.blocked) return cancelled;
        const generation = operations.generation;
        const value = await work();
        return generation === operations.generation ? value : cancelled;
      } finally {
        operations.active.delete(pending);
      }
    })();
    operations.active.add(pending);
    return pending;
  };
  const engine: ScoutEngine = {
    stagePrompt: input => {
      const startedAt = performance.now();
      const controller = new AbortController();
      let hookTimer: ReturnType<typeof setTimeout>;
      const fallback = new Promise<UserPromptHookResult>(resolve => {
        hookTimer = setTimeout(() => {
          controller.abort();
          resolve(stageLocally(input,configStore.readConfig()) ? hookContext(input) : {});
        },HOOK_TIMEOUT_MS-HOOK_RETURN_RESERVE_MS);
      });
      return Promise.race([track(() => stagePrompt(input,startedAt,controller.signal), {}),fallback])
        .finally(() => clearTimeout(hookTimer));
    },
    observeTurn: input => track(() => observeTurn(input), { status: "ignored" }),
    getReviewEvidence: input => track(() => getReviewEvidence(input), { status: "error", code: "REVIEW_SET_UNAVAILABLE" }),
    claimDispatch: input => track(() => claimDispatch(input), {}),
    finishRecommendation: input => track(() => finishRecommendation(input), {status:"ignored"}),
    control: input => input?.command === "help" || input?.command === "request_clear" || input?.command === "confirm_clear"
      ? control(input)
      : track(() => control(input), { status: "unavailable", code: "CLEAR_FAILED", message: "清空已取消旧操作。" }),
  };
  payloadMeasurementRecorders.set(engine, input => track(() => persistPayloadMeasurement(input), undefined));
  idleStorageReleasers.set(engine, closeWhenIdle);
  return engine;
}
