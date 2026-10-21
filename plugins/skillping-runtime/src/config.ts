import { appendFile, lstat, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

export const recommendationPaceSchema = z.enum(["eager", "balanced", "cautious"]);
export type RecommendationPace = z.infer<typeof recommendationPaceSchema>;
export const RECOMMENDATION_WINDOW_DAYS = 30;
export const RECOMMENDATION_PACES = {
  eager: { label: "积极", description: "更早发现可能用得上的 Skill", min_occurrences: 3, min_chats: 2 },
  balanced: { label: "均衡", description: "积累足够线索，再给出推荐", min_occurrences: 5, min_chats: 3 },
  cautious: { label: "谨慎", description: "等重复模式更明确时再推荐", min_occurrences: 8, min_chats: 4 }
} as const;

export const DIAGNOSTIC_LIMIT_BYTES = 1024 * 1024;
const WARNING_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const CLEAR_RETRY_DELAY_MS = 25;
const CLEAR_RETRY_TIMEOUT_MS = 15_000;

const componentSchema = z.enum(["config", "storage", "key", "mcp", "history"]);
const codeSchema = z.enum([
  "CONFIG_INVALID",
  "CONFIG_WRITE_FAILED",
  "DB_BUSY",
  "DB_CORRUPT",
  "DB_UNAVAILABLE",
  "KEY_UNREADABLE",
  "KEY_TIMEOUT",
  "MCP_ERROR",
  "HISTORY_ERROR",
  "PAYLOAD_ESTIMATE_AGGREGATION_FAILED"
]);
const healthSchema = z.object({
  state: z.enum(["healthy", "degraded"]),
  codes: z.partialRecord(componentSchema, codeSchema).default({}),
  consecutive_failures: z.record(z.string(), z.number().int().nonnegative()),
  warning_cooldown_until: z.record(z.string(), z.number().int().nonnegative())
}).passthrough();
const decisionThresholdSchema = z.strictObject({
  threshold: z.number().min(0).max(1),
  model_version: z.unknown().optional(),
  criteria_version: z.unknown().optional()
}).transform(({ threshold }) => ({ threshold }));
const decisionModelConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  allow_external: z.boolean().default(false),
  provider: z.literal("sqwish").default("sqwish"),
  model: z.literal("kettei-fat").default("kettei-fat"),
  api_key: z.string().trim().default(""),
  precheck_timeout_ms: z.number().int().min(1).max(5000).default(5000),
  match_timeout_ms: z.number().int().min(1).max(10_000).default(5000),
  existence: decisionThresholdSchema.nullable().default(null),
  matching: decisionThresholdSchema.nullable().default(null)
});
export type DecisionModelConfig = z.infer<typeof decisionModelConfigSchema>;
const configSchema = z.object({
  schema_version: z.literal(1),
  detection_enabled: z.boolean(),
  recommendation_enabled: z.boolean(),
  recommendation_pace: recommendationPaceSchema.default("balanced"),
  decision_model: decisionModelConfigSchema.default(() => decisionModelConfigSchema.parse({})),
  intro_seen: z.boolean(),
  data_generation: z.number().int().nonnegative().default(0),
  decision_revision: z.number().int().nonnegative().default(0),
  next_cleanup_at: z.number().int().nonnegative().nullable(),
  health: healthSchema
}).passthrough();
const importProgressSchema = z.strictObject({
  schema_version: z.literal(1),
  status: z.enum(["idle", "running", "paused", "completed", "unavailable"]),
  window_days: z.literal(30),
  model: z.string().nullable(),
  cursor: z.string().nullable(),
  source_id: z.string().nullable(),
  completed_batch: z.number().int().nonnegative()
});

export type ScoutConfig = z.infer<typeof configSchema>;
export type ImportProgress = z.infer<typeof importProgressSchema>;
export type DiagnosticComponent = z.infer<typeof componentSchema>;
export type DiagnosticCode = z.infer<typeof codeSchema>;
export type HealthWarning = { component: DiagnosticComponent; code: DiagnosticCode };

const defaultConfig = (): ScoutConfig => ({
  schema_version: 1,
  detection_enabled: true,
  recommendation_enabled: true,
  recommendation_pace: "balanced",
  decision_model: decisionModelConfigSchema.parse({}),
  intro_seen: false,
  data_generation: 0,
  decision_revision: 0,
  next_cleanup_at: null,
  health: { state: "healthy", codes: {}, consecutive_failures: {}, warning_cooldown_until: {} }
});

const defaultImportProgress = (): ImportProgress => ({
  schema_version: 1,
  status: "idle",
  window_days: 30,
  model: null,
  cursor: null,
  source_id: null,
  completed_batch: 0
});

let temporarySequence = 0;
const writeTails = new Map<string, Promise<void>>();

async function atomicJsonWrite(filePath: string, value: unknown, failureCode: string) {
  const temporaryPath = `${filePath}.${process.pid}.${++temporarySequence}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw new Error(failureCode, { cause: error });
  }
}

export async function openConfigStore(dataDir: string, now: () => number) {
  const configPath = path.join(dataDir, "config.json");
  const progressPath = path.join(dataDir, "import-progress.json");
  const diagnosticPath = path.join(dataDir, "diagnostics.log");
  let config = defaultConfig();
  let progress = defaultImportProgress();
  const queueKey = path.resolve(dataDir).toLowerCase();
  const enqueue = <T>(work: () => Promise<T>) => {
    const previous = writeTails.get(queueKey) ?? Promise.resolve();
    const result = previous.then(work, work);
    writeTails.set(queueKey, result.then(() => undefined, () => undefined));
    return result;
  };
  const serialize = <T>(work: () => Promise<T>) => enqueue(async () => {
    let lock: DatabaseSync | undefined;
    let active = false;
    try {
      try {
        lock = new DatabaseSync(path.join(dataDir, "config-lock.sqlite"));
        lock.exec("PRAGMA busy_timeout = 250; BEGIN IMMEDIATE");
        active = true;
      } catch (error) {
        throw new Error("CONFIG_WRITE_FAILED", { cause: error });
      }
      const result = await work();
      try { lock.exec("COMMIT"); }
      catch (error) { throw new Error("CONFIG_WRITE_FAILED", { cause: error }); }
      active = false;
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === "CONFIG_WRITE_FAILED") {
        config = { ...config, health: { ...config.health, state: "degraded",
          codes: { ...config.health.codes, config: "CONFIG_WRITE_FAILED" } } };
      }
      throw error;
    } finally {
      if (active) { try { lock?.exec("ROLLBACK"); } catch {} }
      lock?.close();
    }
  });

  const readInitialConfig = async () => {
    try {
      config = configSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        config = { ...config, health: { ...config.health, state: "degraded", codes: { config: "CONFIG_INVALID" }, consecutive_failures: { config: 1 } } };
        return true;
      }
      return false;
    }
  };

  // Existing config is replaced atomically, so startup only needs the write
  // coordinator when creating the file for the first time.
  if (!(await readInitialConfig())) {
    await serialize(async () => {
      if (!(await readInitialConfig())) await atomicJsonWrite(configPath, config, "CONFIG_WRITE_FAILED");
    });
  }

  try {
    progress = importProgressSchema.parse(JSON.parse(await readFile(progressPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      config = { ...config, health: { ...config.health, state: "degraded" } };
    }
  }

  const readConfig = () => structuredClone(config);
  const readImportProgress = () => structuredClone(progress);

  const refreshConfigNow = async () => {
    try {
      config = configSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
    } catch (error) {
      config = { ...config, health: { ...config.health, state: "degraded", codes: { ...config.health.codes, config: "CONFIG_INVALID" } } };
      throw new Error("CONFIG_INVALID", { cause: error });
    }
  };

  const updateConfigNow = async (mutator: (current: ScoutConfig) => ScoutConfig) => {
    await refreshConfigNow();
    const next = configSchema.parse(mutator(readConfig()));
    next.decision_revision = config.decision_revision + Number(next.detection_enabled !== config.detection_enabled ||
      JSON.stringify(next.decision_model) !== JSON.stringify(config.decision_model));
    if (isDeepStrictEqual(next, config)) return readConfig();
    try {
      await atomicJsonWrite(configPath, next, "CONFIG_WRITE_FAILED");
      config = next;
      return readConfig();
    } catch (error) {
      config = { ...config, health: { ...config.health, state: "degraded" } };
      throw error;
    }
  };
  const updateConfig = (mutator: (current: ScoutConfig) => ScoutConfig) => serialize(() => updateConfigNow(mutator));
  const refreshConfig = () => enqueue(async () => {
    await refreshConfigNow();
    return readConfig();
  });

  const writeImportProgressNow = async (value: unknown) => {
    let next: ImportProgress;
    try {
      next = importProgressSchema.parse(value);
    } catch (error) {
      throw new Error("IMPORT_PROGRESS_INVALID", { cause: error });
    }
    await atomicJsonWrite(progressPath, next, "IMPORT_PROGRESS_WRITE_FAILED");
    progress = next;
    return readImportProgress();
  };
  const writeImportProgress = (value: unknown) => serialize(() => writeImportProgressNow(value));
  const refreshImportProgress = () => enqueue(async () => {
    try {
      progress = importProgressSchema.parse(JSON.parse(await readFile(progressPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        progress = defaultImportProgress();
      } else {
        throw new Error("IMPORT_PROGRESS_INVALID", { cause: error });
      }
    }
    return readImportProgress();
  });

  const appendDiagnosticNow = async (componentValue: unknown, codeValue: unknown) => {
    const parsed = z.tuple([componentSchema, codeSchema]).safeParse([componentValue, codeValue]);
    if (!parsed.success) throw new Error("DIAGNOSTIC_INVALID");
    const [component, code] = parsed.data;
    const line = `${new Date(now()).toISOString()}\t${component}\t${code}\n`;
    const currentSize = await stat(diagnosticPath).then((value) => value.size, () => 0);
    if (currentSize + Buffer.byteLength(line) > DIAGNOSTIC_LIMIT_BYTES) {
      await unlink(`${diagnosticPath}.1`).catch(() => {});
      await rename(diagnosticPath, `${diagnosticPath}.1`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await appendFile(diagnosticPath, line, "utf8");
  };
  const appendDiagnostic = (componentValue: unknown, codeValue: unknown) => serialize(() => appendDiagnosticNow(componentValue, codeValue));

  const recordFailure = (component: DiagnosticComponent, code: DiagnosticCode) => serialize(async () => {
    componentSchema.parse(component);
    codeSchema.parse(code);
    await appendDiagnosticNow(component, code);
    const severe = code === "DB_CORRUPT" || code === "KEY_UNREADABLE";
    const key = `${component}:${code}`;
    let warning: HealthWarning | undefined;
    await updateConfigNow((current) => {
      const count = (current.health.consecutive_failures[component] ?? 0) + 1;
      const cooldownUntil = current.health.warning_cooldown_until[key] ?? 0;
      const shouldWarn = (severe || count >= 3) && now() >= cooldownUntil;
      if (shouldWarn) warning = { component, code };
      return {
        ...current,
        health: {
          ...current.health,
          state: "degraded",
          codes: { ...current.health.codes, [component]: code },
          consecutive_failures: { ...current.health.consecutive_failures, [component]: count },
          warning_cooldown_until: shouldWarn
            ? { ...current.health.warning_cooldown_until, [key]: now() + WARNING_COOLDOWN_MS }
            : current.health.warning_cooldown_until
        }
      };
    });
    return warning ? { warning } : {};
  });

  const recordSuccess = (component: DiagnosticComponent) => serialize(() => updateConfigNow((current) => {
    const consecutive = { ...current.health.consecutive_failures };
    const codes = { ...current.health.codes };
    delete consecutive[component];
    delete codes[component];
    return {
      ...current,
      health: {
        ...current.health,
        state: Object.keys(consecutive).length === 0 ? "healthy" : "degraded",
        consecutive_failures: consecutive,
        codes
      }
    };
  }));

  const withDataAccess = async <T>(expectedGeneration: number, work: () => Promise<T>) => {
    const lock = new DatabaseSync(path.join(dataDir, "clear-lock.sqlite"));
    let active = false;
    try {
      lock.exec(`PRAGMA busy_timeout = ${CLEAR_RETRY_TIMEOUT_MS}; BEGIN`);
      active = true;
      lock.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
      const current = await refreshConfig();
      if (current.data_generation !== expectedGeneration || current.clear_pending === true) {
        throw new Error("DATA_GENERATION_CHANGED");
      }
      const result = await work();
      lock.exec("COMMIT");
      active = false;
      return result;
    } finally {
      if (active) { try { lock.exec("ROLLBACK"); } catch {} }
      lock.close();
    }
  };

  const clearData = async (expected: { dataGeneration: number; clearPending: boolean }) => {
    const root = await realpath(dataDir);
    if (root.toLowerCase() !== path.resolve(dataDir).toLowerCase() || (await lstat(dataDir)).isSymbolicLink()) throw new Error("CLEAR_FAILED");
    let owner: DatabaseSync | undefined;
    let ownerActive = false;
    let lock: DatabaseSync | undefined;
    let active = false;
    const beginExclusive = () => {
      lock = new DatabaseSync(path.join(root, "clear-lock.sqlite"));
      lock.exec(`PRAGMA busy_timeout = ${CLEAR_RETRY_TIMEOUT_MS}; BEGIN EXCLUSIVE`);
      active = true;
    };
    const commitExclusive = () => {
      lock!.exec("COMMIT");
      active = false;
      lock!.close();
      lock = undefined;
    };
    try {
      owner = new DatabaseSync(path.join(root, "clear-owner.sqlite"));
      owner.exec(`PRAGMA busy_timeout = ${CLEAR_RETRY_TIMEOUT_MS * 2}; BEGIN IMMEDIATE`);
      ownerActive = true;
      beginExclusive();
      await serialize(() => updateConfigNow(current => {
        if (current.data_generation !== expected.dataGeneration || (current.clear_pending === true) !== expected.clearPending) {
          throw new Error("CLEAR_CONFIRMATION_STALE");
        }
        return { ...current, clear_pending: true };
      }));
      // Let gated peers observe the pause and release database handles before final deletion.
      commitExclusive();

      const deadline = Date.now() + CLEAR_RETRY_TIMEOUT_MS;
      const removeFile = async (target: string, parent: string) => {
        if (path.dirname(target) !== parent) throw new Error("CLEAR_FAILED");
        while (true) {
          const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          });
          if (!entry) return;
          if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("CLEAR_FAILED");
          try {
            await unlink(target);
            return;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return;
            if (process.platform !== "win32" || (code !== "EBUSY" && code !== "EPERM") || Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, CLEAR_RETRY_DELAY_MS));
          }
        }
      };
      const remove = (name: string) => removeFile(path.resolve(root, name), root);
      const removeHistoryWorker = async (name: string) => {
        const worker = path.resolve(root, name);
        if (!name.startsWith("history-worker-") || path.dirname(worker) !== root) throw new Error("CLEAR_FAILED");
        while (true) {
          const directory = await lstat(worker).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          });
          if (!directory) return;
          if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("CLEAR_FAILED");
          const children = await readdir(worker, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          });
          if (!children) return;
          for (const child of children) {
            if ((child.name !== "schema.json" && child.name !== "output.json") || !child.isFile() || child.isSymbolicLink()) {
              throw new Error("CLEAR_FAILED");
            }
            await removeFile(path.resolve(worker, child.name), worker);
          }
          try {
            await rmdir(worker);
            return;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return;
            const retryable = code === "ENOTEMPTY" || (process.platform === "win32" && (code === "EBUSY" || code === "EPERM"));
            if (!retryable || Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, CLEAR_RETRY_DELAY_MS));
          }
        }
      };
      // Keep the original key whenever any database page survives a failed unlink.
      for (const name of ["scout.sqlite", "scout.sqlite-wal", "scout.sqlite-shm"]) await remove(name);

      beginExclusive();
      await serialize(async () => {
        await refreshConfigNow();
        const current = readConfig();
        if (current.data_generation !== expected.dataGeneration || current.clear_pending !== true) {
          throw new Error("CLEAR_CONFIRMATION_STALE");
        }
      });
      for (const name of ["scout.sqlite", "scout.sqlite-wal", "scout.sqlite-shm"]) await remove(name);
      for (const name of await readdir(root)) if (name.startsWith("history-worker-")) await removeHistoryWorker(name);
      await remove("key.dpapi");
      for (const name of [path.basename(progressPath), path.basename(diagnosticPath), `${path.basename(diagnosticPath)}.1`]) await remove(name);
      progress = defaultImportProgress();
      await serialize(() => updateConfigNow(current => {
        if (current.data_generation !== expected.dataGeneration || current.clear_pending !== true) throw new Error("CLEAR_CONFIRMATION_STALE");
        return { ...current, clear_pending: false, data_generation: current.data_generation + 1,
          next_cleanup_at: null, health: defaultConfig().health };
      }));
      commitExclusive();
    } catch (error) {
      if (error instanceof Error && error.message === "CLEAR_CONFIRMATION_STALE") throw error;
      throw new Error("CLEAR_FAILED", { cause: error });
    } finally {
      if (active) { try { lock?.exec("ROLLBACK"); } catch {} }
      lock?.close();
      if (ownerActive) { try { owner?.exec("ROLLBACK"); } catch {} }
      owner?.close();
    }
  };

  const resetImportSnapshot = () => { progress = defaultImportProgress(); };

  return {
    readConfig,
    refreshConfig,
    updateConfig,
    readImportProgress,
    refreshImportProgress,
    writeImportProgress,
    recordFailure,
    recordSuccess,
    appendDiagnostic,
    withDataAccess,
    clearData,
    resetImportSnapshot
  };
}

export async function configureDecisionModel(dataDir: string, apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) return;
  const store = await openConfigStore(dataDir, Date.now);
  await store.updateConfig(current => ({
    ...current,
    decision_model: {
      ...current.decision_model,
      enabled: true,
      allow_external: true,
      api_key: key,
      existence: current.decision_model.existence ?? { threshold: 0.5 },
      matching: current.decision_model.matching ?? { threshold: 0.5 }
    }
  }));
}
