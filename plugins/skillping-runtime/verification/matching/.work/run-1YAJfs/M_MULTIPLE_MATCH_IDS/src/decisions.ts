import { z } from "zod";

export type DecisionQuestion = { id: string; criteria: string };
export type DecisionInput = { content: string; questions: DecisionQuestion[] };
type UnjudgedReason = "disabled" | "no_credential" | "timeout" | "request_failed"
  | "missing" | "refusal" | "invalid" | "limit";
export type DecisionAnswer = { id: string } & (
  | { status: "judged"; yesProbability: number }
  | { status: "unjudged"; reason: UnjudgedReason }
);
export type DecisionOutput = {
  provider: "sqwish";
  requestedModel: "kettei-fat";
  actualModel: string | null;
  modelVersion?: string;
  requestId?: string;
  answers: DecisionAnswer[];
};
export type DecisionOptions = {
  enabled: boolean;
  model: "kettei-fat";
  apiKey?: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

export const DECISION_MAX_QUESTIONS = 5;
export const DECISION_MAX_BODY_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const metadataSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
// z.record drops __proto__ before the unexpected-ID check can reject it.
const answersSchema = z.custom<Record<string, unknown>>((value) => typeof value === "object" && value !== null && !Array.isArray(value));
const responseSchema = z.object({
  model: z.string().optional(),
  version: z.unknown().optional(),
  id: z.unknown().optional(),
  answers: answersSchema,
});
const probabilitySchema = z.object({ type: z.literal("noul"), noul: z.number().finite().min(0).max(1) });
const refusalSchema = z.object({ type: z.literal("refusal") });

export async function decideQuestions(input: DecisionInput, options: DecisionOptions): Promise<DecisionOutput> {
  const base: DecisionOutput = { provider: "sqwish", requestedModel: "kettei-fat", actualModel: null, answers: [] };
  const unjudged = (reason: UnjudgedReason): DecisionOutput => ({
    ...base, answers: input.questions.map(({ id }) => ({ id, status: "unjudged", reason })),
  });
  if (input.questions.length === 0) return base;
  if (!options.enabled) return unjudged("disabled");
  const apiKey = options.apiKey?.trim();
  if (!apiKey) return unjudged("no_credential");
  if (new Set(input.questions.map(({ id }) => id)).size !== input.questions.length) return unjudged("invalid");
  if (input.questions.length > DECISION_MAX_QUESTIONS) return unjudged("limit");
  if (options.model !== "kettei-fat" || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) {
    return unjudged("invalid");
  }
  const body = JSON.stringify({
    model: "kettei-fat",
    state: input.content,
    questions: Object.fromEntries(input.questions.map(({ id, criteria }) => [id, { type: "noul", instructions: criteria }])),
  });
  if (Buffer.byteLength(body, "utf8") > DECISION_MAX_BODY_BYTES) return unjudged("limit");
  if (options.signal?.aborted) return unjudged("request_failed");

  const controller = new AbortController();
  const deadline = performance.now() + options.timeoutMs;
  const interrupted = Promise.withResolvers<DecisionOutput>();
  const cancel = (reason: "timeout" | "request_failed"): void => {
    interrupted.resolve(unjudged(reason));
    controller.abort();
  };
  const timer = setTimeout(() => cancel("timeout"), options.timeoutMs);
  const onAbort = (): void => cancel("request_failed");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const request = async (): Promise<DecisionOutput> => {
    let response: Response;
    let text: string;
    try {
      response = await (options.fetch ?? fetch)("https://api.sqwish.ai/v1/systemone", {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        return unjudged("request_failed");
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return unjudged("request_failed");
      }
      if (!response.body) return unjudged("invalid");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) return unjudged("limit");
        chunks.push(chunk.value);
      }
      text = Buffer.concat(chunks).toString("utf8");
    } catch {
      return unjudged("request_failed");
    }
    if (performance.now() >= deadline) return unjudged("timeout");
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return unjudged("limit");
    let json: unknown;
    try { json = JSON.parse(text); } catch { return unjudged("invalid"); }
    const parsed = responseSchema.safeParse(json);
    if (performance.now() >= deadline) return unjudged("timeout");
    if (!parsed.success) return unjudged("invalid");
    const data = parsed.data;
    const actualModel = metadataSchema.safeParse(data.model);
    const version = metadataSchema.safeParse(data.version);
    const requestId = metadataSchema.safeParse(data.id);
    const metadata = {
      actualModel: actualModel.success ? actualModel.data : null,
      ...(version.success ? { modelVersion: version.data } : {}),
      ...(requestId.success ? { requestId: requestId.data } : {}),
    };
    const requiredIds = new Set(input.questions.map(({ id }) => id));
    if (metadata.actualModel !== "kettei-fat" || Object.keys(data.answers).some((id) => !requiredIds.has(id))) {
      return { ...unjudged("invalid"), ...metadata };
    }
    const output: DecisionOutput = {
      ...base,
      ...metadata,
      answers: input.questions.map(({ id }): DecisionAnswer => {
        if (!Object.hasOwn(data.answers, id)) return { id, status: "unjudged", reason: "missing" };
        const answer = data.answers[id];
        const probability = probabilitySchema.safeParse(answer);
        if (probability.success) return { id, status: "judged", yesProbability: probability.data.noul };
        return { id, status: "unjudged", reason: refusalSchema.safeParse(answer).success ? "refusal" : "invalid" };
      }),
    };
    return performance.now() >= deadline ? unjudged("timeout") : output;
  };
  try {
    return await Promise.race([request(), interrupted.promise]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}
