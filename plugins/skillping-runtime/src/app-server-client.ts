import type { ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const ENV_KEYS = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "CODEX_HOME", "LANG", "LC_ALL",
] as const;

export type FindSkillsReadiness =
  | { status: "ready" }
  | { status: "blocked"; reason: "find_skills_missing" | "find_skills_disabled" | "readiness_unavailable" };

type SkillsListResponse = {
  data?: Array<{
    cwd?: unknown;
    skills?: Array<{ name?: unknown; description?: unknown; path?: unknown; scope?: unknown; enabled?: unknown }>;
    errors?: unknown[];
  }>;
};

export type InstalledSkill = {
  name: string;
  description: string;
  path: string;
  scope: string;
  enabled: boolean;
};

export const sanitizedCodexEnv = () => Object.fromEntries(ENV_KEYS.flatMap((key) =>
  process.env[key] === undefined ? [] : [[key, process.env[key]!]]));

const readinessFrom = (value: unknown, cwd: string): FindSkillsReadiness => {
  const result = value as SkillsListResponse;
  if (!Array.isArray(result?.data)) return { status: "blocked", reason: "readiness_unavailable" };
  const entry = result.data.find((candidate) => candidate.cwd === cwd);
  if (!entry || !Array.isArray(entry.skills) || (Array.isArray(entry.errors) && entry.errors.length > 0)) {
    return { status: "blocked", reason: "readiness_unavailable" };
  }
  const skill = entry.skills.find((candidate) => candidate?.name === "find-skills");
  if (!skill) return { status: "blocked", reason: "find_skills_missing" };
  if (skill.enabled === false) return { status: "blocked", reason: "find_skills_disabled" };
  return skill.enabled === true
    ? { status: "ready" }
    : { status: "blocked", reason: "readiness_unavailable" };
};

export const readinessForInstalledSkills = (skills: InstalledSkill[]): FindSkillsReadiness => {
  const skill = skills.find((candidate) => candidate.name === "find-skills");
  if (!skill) return { status: "blocked", reason: "find_skills_missing" };
  return skill.enabled ? { status: "ready" } : { status: "blocked", reason: "find_skills_disabled" };
};

export type CodexAppServer = { request(method: string, params: unknown): Promise<unknown> };

export async function withCodexAppServer<T>(options: {
  cwd: string;
  spawnProcess: typeof spawn;
  timeoutMs: number;
}, work: (client: CodexAppServer) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const child: ChildProcess = options.spawnProcess("codex", ["app-server", "--listen", "stdio://"], {
    cwd: options.cwd, env: sanitizedCodexEnv(), shell: false, signal: controller.signal,
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });

  let closed = false;
  let bytes = 0;
  let buffer = "";
  let nextId = 1;
  const decoder = new StringDecoder("utf8");
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const fail = (error: unknown) => {
    const failure = error instanceof Error ? error : new Error("app_server_unavailable");
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  };
  const send = (message: unknown) => new Promise<void>((resolve, reject) => {
    if (!child.stdin?.writable) return reject(new Error("app_server_unavailable"));
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
  });
  const onMessage = (message: unknown) => {
    const response = message as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof response.id !== "number") return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error !== undefined) {
      const detail = response.error as { message?: unknown };
      request.reject(new Error(typeof detail?.message === "string" ? detail.message : "app_server_request_failed"));
    } else request.resolve(response.result);
  };

  child.on("error", fail);
  child.on("close", () => { closed = true; fail(new Error("app_server_closed")); });
  child.stdin?.on("error", fail);
  child.stdout?.on("error", fail);
  child.stderr?.on("error", fail);
  child.stdout?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) return fail(new Error("app_server_output_too_large"));
    buffer += decoder.write(chunk);
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      try { onMessage(JSON.parse(line)); } catch { fail(new Error("app_server_protocol_invalid")); }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) fail(new Error("app_server_output_too_large"));
  });

  const timer = setTimeout(() => {
    controller.abort();
    fail(new Error("app_server_timeout"));
  }, options.timeoutMs);
  timer.unref?.();
  const client: CodexAppServer = { request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void send({ method, id, params }).catch((error) => { pending.delete(id); reject(error); });
    });
  } };

  try {
    await client.request("initialize", {
      clientInfo: { name: "skillping", title: "SkillPing", version: "1" },
      capabilities: { experimentalApi: true },
    });
    await send({ method: "initialized", params: {} });
    return await work(client);
  } finally {
    clearTimeout(timer);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
    if (!closed) child.kill("SIGKILL");
    if (!closed) await Promise.race([
      new Promise<void>((resolve) => child.once("close", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
  }
}

export async function checkFindSkillsReadiness(options: {
  cwd: string;
  spawnProcess: typeof spawn;
  timeoutMs: number;
}): Promise<FindSkillsReadiness> {
  try {
    return await withCodexAppServer(options, async (client) =>
      readinessFrom(await client.request("skills/list", { cwds: [options.cwd], forceReload: true }), options.cwd));
  } catch {
    return { status: "blocked", reason: "readiness_unavailable" };
  }
}

export async function listCodexSkills(options: {
  cwd: string;
  spawnProcess: typeof spawn;
  timeoutMs: number;
}): Promise<InstalledSkill[]> {
  return withCodexAppServer(options, async (client) => {
    const result = await client.request("skills/list", { cwds: [options.cwd], forceReload: true }) as SkillsListResponse;
    const entry = result.data?.find((candidate) => candidate.cwd === options.cwd);
    if (!entry || !Array.isArray(entry.skills) || (entry.errors?.length ?? 0) > 0) throw new Error("skills_list_unavailable");
    return entry.skills.map((skill) => {
      if (typeof skill.name !== "string" || typeof skill.description !== "string" || typeof skill.path !== "string" ||
          typeof skill.scope !== "string" || typeof skill.enabled !== "boolean") throw new Error("skills_list_invalid");
      return { name: skill.name, description: skill.description, path: skill.path, scope: skill.scope, enabled: skill.enabled };
    });
  });
}
