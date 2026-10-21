#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createScoutEngine, recordPayloadMeasurement, releaseIdleStorage } from "../engine.js";
import {
  controlSchema,
  finishRecommendationSchema,
  type FinishRecommendationInput,
  observeTurnSchema,
  reviewEvidenceInputSchema,
  type EngineDeps,
  type ObserveTurnInput,
  type ScoutEngine
} from "../domain.js";
import { reviewPayloadBudget } from "../review-packet.js";

type JsonObject = Record<string, unknown>;

const stagePromptSchema = {
  session_id: z.string(),
  turn_id: z.string(),
  prompt: z.string(),
  cwd: z.string(),
  model: z.string()
};

const claimDispatchSchema = {
  session_id: z.string(),
  turn_id: z.string(),
  stop_hook_active: z.boolean()
};

const reviewEvidenceToolSchema = z.looseObject({}).meta(z.toJSONSchema(reviewEvidenceInputSchema, {
  target: "draft-7", io: "input"
}));

export const TOOL_NAMES = [
  "stage_prompt",
  "observe_turn",
  "get_review_evidence",
  "finish_recommendation",
  "claim_dispatch",
  "control"
] as const;

export function toMcpResult(payload: JsonObject) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }]
  };
}

export async function verifyPluginDirectories(pluginRoot: string, dataDir: string) {
  if (!pluginRoot) throw new Error("PLUGIN_ROOT is required");
  if (!dataDir) throw new Error("PLUGIN_DATA is required");

  const resolvedRoot = path.resolve(pluginRoot);
  const resolvedData = path.resolve(dataDir);
  await access(resolvedRoot, constants.R_OK).catch(() => {
    throw new Error("PLUGIN_ROOT is not readable");
  });
  await access(resolvedData, constants.R_OK | constants.W_OK).catch(() => {
    throw new Error("PLUGIN_DATA must exist and be writable");
  });

  const sentinel = path.join(resolvedData, `.scout-write-check-${randomUUID()}`);
  const handle = await open(sentinel, "wx").catch(() => {
    throw new Error("PLUGIN_DATA must exist and be writable");
  });
  await handle.close();
  await unlink(sentinel);
  return { pluginRoot: resolvedRoot, dataDir: resolvedData };
}

export function createHandlers(engine: ScoutEngine) {
  const retrying = new Set<string>();
  const run = async <T>(work: () => Promise<T>) => {
    try { return await work(); }
    finally { await releaseIdleStorage(engine); }
  };
  return {
    async stage_prompt(input: z.infer<z.ZodObject<typeof stagePromptSchema>>) {
      return run(() => engine.stagePrompt(input));
    },
    async observe_turn(input: ObserveTurnInput) {
      return run(async () => {
        const key = `${input.session_id}\0${input.turn_id}`;
        const measurementPhase = retrying.has(key) ? "retry" : input.phase;
        const result = await engine.observeTurn(input);
        let finalResult: Record<string, unknown> = result;
        if (result.status === "accepted") {
          const dispatch = await engine.claimDispatch({
            session_id: input.session_id, turn_id: input.turn_id, stop_hook_active: false
          });
          finalResult = dispatch.reason ? { ...result, recommendation_instructions: dispatch.reason } : result;
        }
        if ((result.status === "invalid" || result.status === "unavailable") && result.retry_allowed) retrying.add(key);
        else retrying.delete(key);
        const budget = reviewPayloadBudget(finalResult);
        await recordPayloadMeasurement(engine, {
          session_id: input.session_id,
          turn_id: input.turn_id,
          phase: measurementPhase,
          result_status: result.status,
          payload: JSON.stringify(finalResult),
          budget_mode: budget?.budgetMode ?? "unbudgeted",
          applicable_limit: budget?.applicableLimit ?? null,
        });
        return finalResult;
      });
    },
    async get_review_evidence(input: unknown) {
      return run(() => engine.getReviewEvidence(input));
    },
    async claim_dispatch(input: z.infer<z.ZodObject<typeof claimDispatchSchema>>) {
      return run(async () => {
        // Stop only discards staging/receipts. Recommendations travel in tool results,
        // never a blocking Hook continuation that can replace the original answer.
        await engine.claimDispatch({ ...input, stop_hook_active: true });
        return {};
      });
    },
    async finish_recommendation(input: FinishRecommendationInput) {
      return run(() => engine.finishRecommendation(input));
    },
    async control(input: z.infer<typeof controlSchema>) {
      return run(() => engine.control(input));
    }
  };
}

// The SDK only advertises object-root schemas, so retain each branch's strict fields.
function objectRootSchema(schema: z.ZodType, validateCalls = true) {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
  const branches = (json.anyOf ?? json.oneOf)!;
  const properties: Record<string, { anyOf: unknown[] }> = {};
  for (const branch of branches) {
    for (const [name, field] of Object.entries(branch.properties ?? {})) {
      (properties[name] ??= { anyOf: [] }).anyOf.push(field);
    }
  }
  const root = z.looseObject({});
  const metadata = {
    ...json, type: "object" as const, properties,
    required: branches[0]!.required?.filter((name) => branches.every((branch) => branch.required?.includes(name)))
  };
  if (!validateCalls) return root.meta(metadata);
  return root.superRefine((value, context) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ ...issue });
  }).meta(metadata);
}

export function createMcpServer(engine: ScoutEngine) {
  const handlers = createHandlers(engine);
  const server = new McpServer({
    name: "skillping-runtime",
    version: "0.1.0"
  });

  server.registerTool("stage_prompt", {
    description: "Hook-only UserPromptSubmit boundary. The host supplies session_id, turn_id, prompt, cwd and model as strings. Do not call manually or invent host values; use observe_turn with the IDs supplied by the Hook.",
    inputSchema: stagePromptSchema
  }, async (input) => toMcpResult(await handlers.stage_prompt(input)));

  server.registerTool("observe_turn", {
    description: "For a staged turn, use phase=extract with schema_version=6, or phase=review with schema_version=3. Copy session_id/turn_id from the Hook; send only fields for that phase. Extract: skip requires items=[]; analyze requires exactly one independent work and one capability. Same-work continuation, format changes and requirement updates use skip. A new independent work in the same chat still uses analyze. Do not supply relation. Work has 0–4 essential_steps; lists must be arrays and supplied text must be nonempty. Review: follow review_required.rules and review_call, echo review_set_id, and submit at most 12 decisions with unique request_id values from that set. Use verdict, not decision. Only same supplies a positive integer selected_workflow_id (capability) or selected_episode_id (episode); episode permits only same/uncertain. Details and confirmation evidence must be loaded as instructed. On retry_allowed:true correct once with the same IDs, or refreshed IDs when supplied; on retry_allowed:false or budget_exceeded stop SkillPing calls and continue the user's task.",
    inputSchema: objectRootSchema(observeTurnSchema, false)
  }, async (input) => toMcpResult(await handlers.observe_turn(input as ObserveTurnInput)));

  server.registerTool("get_review_evidence", {
    description: "Pass review_set_id from review_required and request_id from the selected request. Omit workflow_id for frozen catalog pages; include it for the full prototype, counts and concrete evidence. session_id/turn_id belong to observe_turn. When has_more is true, pass that page's next_cursor; keep catalog and evidence cursors separate. Prefer omitting limit; if supplied, it must be an integer 1–50. same requires loaded details; confirm requires all selected evidence pages. Reads do not change classification.",
    inputSchema: reviewEvidenceToolSchema
  }, async (input) => toMcpResult(await handlers.get_review_evidence(input)));

  server.registerTool("claim_dispatch", {
    description: "Hook-only Stop cleanup boundary. The host supplies session_id and turn_id as strings and stop_hook_active as a boolean. Do not call manually. Never emits a conversation continuation.",
    inputSchema: claimDispatchSchema
  }, async (input) => toMcpResult(await handlers.claim_dispatch(input)));

  server.registerTool("finish_recommendation", {
    description: "Finish once using recommendation_instructions.finish_call; copy its recommendation_id. Complete the core user work before comparison. For completed and no_improvement, first pass the packet's NORMAL FINISH CHECK. With fewer than two qualifying choices and remaining six-Skill inspection capacity, inspect plausible unread leaderboard leads, then use the current request's one supplemental query if still needed and not yet attempted. Old requests do not spend this budget; an adequate applied baseline does not bypass continuation. completed requires recommendation_count integer 0–3 after bounded search and body checks, counting only concrete improvements when an actually applied core Skill is the baseline. no_improvement requires baseline_skill (exact applied core Skill reference) and no count: only when it satisfies the whole frozen capability and successful bounded comparison finds no improvement; permanently silences automatic search for this capability and scope, not observations or explicit user searches. Installation, reading, auxiliary use, failed/incomplete lookup or uncertainty cannot justify silence. unavailable omits count and requires unavailable_reason: tools_missing after host discovery, guide_unreadable after failed guide read, lookup_failed after failed/denied required lookup in this request, or query_unsafe when no safe public query exists. Unstarted/unfinished checks and old failure receipts are not current lookup failures; continue allowed checks. Genuine unresolved interruption uses host Stop/expiry cleanup, not an invented receipt or a manual Hook call. Submit only the chosen receipt fields, no bodies, paths, queries or usage telemetry. Ten-minute expiry starts at packet receipt; expiry cannot authorize silence. Only accepted completed permits displaying recommendations; accepted no_improvement stays silent. Do not retry within the turn.",
    inputSchema: objectRootSchema(finishRecommendationSchema, false)
  }, async (input) => toMcpResult(await handlers.finish_recommendation(input as FinishRecommendationInput)));

  server.registerTool("control", {
    description: "SkillPing controls: send only fields for the chosen command. status, enable_detection, disable_detection, enable_recommendations and disable_recommendations take command only. help reads the current recommendation pace and conditions without changing settings. set_recommendation_pace requires pace=eager|balanced|cautious. import_history requires confirmed (boolean reflecting user consent). skip_turn requires session_id and turn_id from the current Hook. Workflow feedback requires session_id and optionally a positive integer workflow_id or dispatch_id, never both; the reference must belong to the current Task. Omit both to resolve its unique relevant Workflow; ask the user when needs_context is returned. retry_unverified_dispatch requires a positive integer dispatch_id. request_clear requires session_id and only asks for confirmation; confirm_clear requires that same session_id and the exact unexpired one-use confirmation_token after explicit user confirmation. Never invent identifiers or confirmation.",
    inputSchema: objectRootSchema(controlSchema)
  }, async (input) => toMcpResult(await handlers.control(controlSchema.parse(input))));

  return server;
}

export async function runServer(env = process.env) {
  const directories = await verifyPluginDirectories(env.PLUGIN_ROOT ?? "", env.PLUGIN_DATA ?? "");
  const deps: EngineDeps = {
    now: Date.now,
    pluginRoot: directories.pluginRoot,
    dataDir: directories.dataDir,
    ...(env.SQWISH_API_KEY ? { sqwishApiKey: env.SQWISH_API_KEY } : {}),
    spawnProcess: (await import("node:child_process")).spawn
  };
  await createMcpServer(await createScoutEngine(deps)).connect(new StdioServerTransport());
}

const isEntryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isEntryPoint) {
  runServer().catch((error) => {
    const message = error instanceof Error && /^(?:PLUGIN_(?:ROOT|DATA).+|CONFIG_[A-Z_]+)$/u.test(error.message)
      ? error.message
      : "STARTUP_FAILED";
    console.error(`SkillPing MCP startup failed: ${message}.`);
    process.exitCode = 1;
  });
}
