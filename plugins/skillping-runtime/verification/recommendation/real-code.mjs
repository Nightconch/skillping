import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const runtime = path.resolve(import.meta.dirname, "../..");
const NOW = 1_792_454_400_000;
const WINDOW = 30 * 86_400_000;
const TIMEOUT = 600_000;
const CWD = "E:/fixture/workspace";
const prototype = {
  core_goal: "Implement an approved change and verify the integrated result",
  input_roles: ["Approved specification", "Runnable repository"],
  output: "Verified implementation",
  essential_steps: ["Inspect dependencies", "Implement the change", "Verify behavior"],
  variable_slots: [], scope: "global"
};
const controls = async () => ({ detectionEnabled: true, recommendationEnabled: true });
const plain = value => JSON.parse(JSON.stringify(value));

function check(rule, condition, message) {
  if (condition) return;
  const error = new Error(`${rule}: ${message}`);
  error.rule = rule;
  throw error;
}

async function fixture(buildRoot, events, count = 1) {
  const root = await mkdtemp(path.join(tmpdir(), "skillping-recommendation-"));
  const load = file => import(pathToFileURL(path.join(buildRoot, "dist", file)));
  const [{ openStorage }, { openConfigStore }, { createScoutEngine, releaseIdleStorage }, { createHandlers }] = await Promise.all([
    load("storage.js"), load("config.js"), load("engine.js"), load("mcp/server.js")
  ]);
  let now = NOW;
  let sequence = 0;
  const config = await openConfigStore(root, () => now);
  await config.updateConfig(current => ({ ...current, intro_seen: true, recommendation_pace: "eager", decision_model: {
    ...current.decision_model, enabled: true, allow_external: true, api_key: "isolated-fixture-key",
    matching: { threshold: 0.8 }, existence: null
  } }));
  const filename = path.join(root, "scout.sqlite");
  const store = await openStorage({ filename, now: () => now, recommendationPace: () => "eager" });
  const db = new DatabaseSync(filename);
  for (let i = 0; i < count; i++) db.prepare(`INSERT INTO workflows
    (scope_kind,scope_value,state,prototype_json,prototype_version,representatives_json,last_seen_at,suppression,created_at,updated_at)
    VALUES('global',NULL,'confirmed',?,3,'[]',?,'none',?,?)`).run(JSON.stringify(prototype), now, now, now);
  const record = (task, turn) => ({
    codex_task_id: task, turn_id: turn, message_id: "", source: "realtime", occurred_at: now,
    expires_at: now + WINDOW, workspace_path: CWD,
    prompt: `Implement independent work ${task} ${turn}`, recommendation_enabled: true,
    observations: [{ relation: "new", confidence: "high", variable_slots: [],
      fingerprint: { ...prototype }, capabilities: [{ ...prototype, confidence: "high" }] }]
  });
  const add = async (task = `task-${sequence}`, turn = `turn-${sequence++}`) => {
    const plan = await store.prepareDecisionMatch(record(task, turn), controls);
    assert.ok(plan, "fixture prepares current decision protocol");
    const result = await store.finalizeDecisionMatch(plan.token,
      { source: "decision_model", matchedWorkflowIds: Array.from({ length: count }, (_, i) => i + 1) }, controls);
    assert.ok(result && result !== "stale", "fixture applies current decision protocol");
    assert.equal(result.review, undefined, "fixture uses independently confirmed workflows");
    return { task, turn };
  };
  for (let i = 0; i < 4; i++) await add();
  const fetch = async (_url, init) => new Response(JSON.stringify({ model: "kettei-fat", version: "fixture-v1",
    answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(id => [id, { type: "noul", noul: 1 }])),
    usage: { input_tokens: 10, output_tokens: 0, tokenizer: { name: "fixture", revision: "1" } },
    timing_ms: { render: 1, score: 1, load: 0 } }));
  const engine = await createScoutEngine({ pluginRoot: runtime, dataDir: root, now: () => now, spawnProcess: spawn, fetch });
  const handlers = createHandlers(engine);
  const extraStores = [];
  const snapshot = () => plain({
    dispatches: db.prepare("SELECT id,workflow_id,state,claimed_at,finished_at,error_code FROM dispatches ORDER BY id").all(),
    requests: db.prepare("SELECT id,dispatch_id,completed_at,recommendation_count FROM recommendation_requests ORDER BY dispatch_id").all(),
    workflows: db.prepare("SELECT id,cooldown_until,recommendation_silenced_by FROM workflows ORDER BY id").all()
  });
  const log = action => events.push({ action, now, ...snapshot() });
  const claim = async (task = "task-3", turn = "turn-3", connection = store) => {
    const result = await connection.claimDispatch({ codexTaskId: task, turnId: turn, cwd: CWD, claimedAt: now, recommendation: "web" });
    log(`claim ${task}/${turn}`);
    return result;
  };
  const packet = async (task = "current-task", turn = "current-turn") => {
    await handlers.stage_prompt({ session_id: task, turn_id: turn, prompt: `Implement independent work ${turn}`, cwd: CWD, model: "fixture-host" });
    const result = await handlers.observe_turn({ phase: "extract", schema_version: 6, session_id: task, turn_id: turn,
      disposition: "analyze", items: [{ core_goal: prototype.core_goal, input_roles: prototype.input_roles,
        output: prototype.output, essential_steps: prototype.essential_steps,
        scope_hint: "global", confidence: "high", capabilities: [{ ...prototype, confidence: "high" }] }] });
    assert.equal(result.status, "accepted", "production v6 extraction accepted");
    assert.equal(typeof result.recommendation_instructions, "string", "production accepted result carries web packet");
    const value = JSON.parse(result.recommendation_instructions);
    assert.equal(value.finish_call.tool, "finish_recommendation");
    assert.match(value.finish_call.arguments.recommendation_id, /^[a-f0-9-]{36}$/u);
    log(`observe_turn packet ${task}/${turn}`);
    return { id: value.finish_call.arguments.recommendation_id, task, turn };
  };
  const finish = async (id, receipt) => {
    const result = await handlers.finish_recommendation({ recommendation_id: id, ...receipt });
    log(`finish_recommendation ${receipt.status} -> ${result.status}`);
    return result;
  };
  return { root, config, store, db, handlers, add, claim, packet, finish, snapshot, log,
    now: () => now, advance: ms => { now += ms; },
    otherStore: async () => {
      const other = await openStorage({ filename, now: () => now, recommendationPace: () => "eager" });
      extraStores.push(other);
      return other;
    },
    close: async () => {
      await releaseIdleStorage(engine);
      for (const other of extraStores) other.close();
      store.close();
      db.close();
      assert.equal(path.dirname(root), path.resolve(tmpdir()));
      assert.ok(path.basename(root).startsWith("skillping-recommendation-"));
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function withFixture(buildRoot, events, work, count) {
  const data = await fixture(buildRoot, events, count);
  try { await work(data); } finally { await data.close(); }
}

const scenarios = {
  async "turn-receipt"(buildRoot, events) {
    await withFixture(buildRoot, events, async data => {
      const other = await data.otherStore();
      const claims = await Promise.all([data.claim(), data.claim("task-3", "turn-3", other)]);
      check("ONE_CLAIM_PER_TURN", claims.filter(Boolean).length === 1, "independent connections claimed two workflows for one turn");
      const first = claims.find(Boolean);
      assert.ok(first.recommendation_id);
      assert.equal((await data.finish(first.recommendation_id, { status: "unavailable", unavailable_reason: "lookup_failed" })).status, "accepted");
      check("ONE_CLAIM_PER_TURN", await data.claim("task-3", "turn-3", other) === undefined, "a failure released the persistent turn receipt");
      assert.equal(data.snapshot().requests.length, 1);
    }, 2);
  },
  async "completion"(buildRoot, events) {
    for (const count of [0, 3]) await withFixture(buildRoot, events, async data => {
      const packet = await data.packet();
      const receipt = { status: "completed", recommendation_count: count };
      const finishedAt = data.now();
      check("COMPLETION_ATOMICITY", (await data.finish(packet.id, receipt)).status === "accepted", "a valid public completed receipt was rejected");
      const state = data.snapshot();
      check("COMPLETION_ATOMICITY", state.dispatches[0].state === "dispatched" && state.requests[0].completed_at === finishedAt &&
        state.requests[0].recommendation_count === count && state.workflows[0].cooldown_until === finishedAt + WINDOW &&
        state.workflows[0].recommendation_silenced_by === null, "completion receipt, dispatched state and cooldown diverged");
      assert.equal((await data.finish(packet.id, receipt)).status, "ignored", "duplicate completion");
      assert.equal((await data.finish(packet.id, { status: "no_improvement", baseline_skill: "fixture:applied" })).status, "ignored", "late opposing completion");
      assert.equal(await data.store.retryUnverifiedDispatch(state.dispatches[0].id, data.now()), false, "verified web result cannot enter legacy retry");
      assert.deepEqual(data.snapshot(), state, "duplicate completion has no effects");
      await data.add("next-task", "next-turn");
      assert.equal(await data.claim("next-task", "next-turn"), undefined, "completed(0) also starts cooldown");
    });
  },
  async "baseline-silence"(buildRoot, events) {
    await withFixture(buildRoot, events, async data => {
      const packet = await data.packet();
      const receipt = { status: "no_improvement", baseline_skill: "fixture:applied-core" };
      check("BASELINE_SILENCE", (await data.finish(packet.id, receipt)).status === "accepted", "valid no_improvement receipt rejected");
      const state = data.snapshot();
      check("BASELINE_SILENCE", state.dispatches[0].state === "dispatched" && state.requests[0].completed_at === data.now() &&
        state.requests[0].recommendation_count === 0 && state.workflows[0].recommendation_silenced_by === receipt.baseline_skill &&
        state.workflows[0].cooldown_until === null, "baseline receipt and permanent capability silence diverged");
      assert.equal(await data.store.retryUnverifiedDispatch(state.dispatches[0].id, data.now()), false);
      assert.equal((await data.finish(packet.id, { status: "completed", recommendation_count: 2 })).status, "ignored");
      data.advance(WINDOW + 1);
      for (let i = 0; i < 4; i++) await data.add(`silenced-task-${i}`, `silenced-turn-${i}`);
      assert.equal(await data.claim("silenced-task-3", "silenced-turn-3"), undefined, "silence outlives cooldown and still allows new observations");
      assert.ok(data.db.prepare("SELECT COUNT(*) AS n FROM episode_workflows").get().n >= 4);
    });
  },
  async "expiry"(buildRoot, events) {
    for (const elapsed of [30_000, TIMEOUT - 1, TIMEOUT, TIMEOUT + 1]) await withFixture(buildRoot, events, async data => {
      const packet = await data.packet();
      data.advance(elapsed);
      const result = await data.finish(packet.id, { status: "no_improvement", baseline_skill: "fixture:applied-core" });
      check("WEB_EXPIRY", result.status === (elapsed < TIMEOUT ? "accepted" : "ignored"), `web completion at ${elapsed}ms violated the ten-minute boundary`);
      const state = data.snapshot();
      if (elapsed >= TIMEOUT) check("WEB_EXPIRY", state.dispatches[0].state === "failed" && state.dispatches[0].error_code === "dispatch_interrupted" &&
        state.requests[0].completed_at === null && state.workflows[0].recommendation_silenced_by === null && state.workflows[0].cooldown_until === null,
        "expired no_improvement authorized silence or completion");
    });
    await withFixture(buildRoot, events, async data => {
      const packet = await data.packet();
      data.advance(30_000);
      await (await data.otherStore()).getStatusCounts();
      assert.equal(data.snapshot().dispatches[0].state, "dispatching", "web claim survives legacy thirty-second recovery");
      data.advance(TIMEOUT - 30_000);
      await data.store.getStatusCounts();
      check("WEB_EXPIRY", data.snapshot().dispatches[0].state === "failed", "lazy cleanup did not retire exactly expired web request");
      assert.equal((await data.finish(packet.id, { status: "completed", recommendation_count: 1 })).status, "ignored");
    });
  },
  async "final-eligibility"(buildRoot, events) {
    const changes = {
      evidence: data => data.db.prepare(`DELETE FROM episode_workflows WHERE observation_id IN
        (SELECT o.id FROM observations o JOIN prompts p ON p.id=o.prompt_id WHERE p.codex_task_id='current-task')`).run(),
      prototype: data => data.db.prepare("UPDATE workflows SET prototype_json=?").run(JSON.stringify({ ...prototype, output: "A materially different result" })),
      threshold: data => data.db.prepare("DELETE FROM episode_workflows WHERE episode_id IN (SELECT id FROM episodes WHERE codex_task_id!='current-task')").run(),
      scope: data => data.db.exec("UPDATE workflows SET scope_kind='project',scope_value='e:/other/project'"),
      suppression: data => data.db.exec("UPDATE workflows SET suppression='permanent'"),
      state: data => data.db.exec("UPDATE workflows SET state='invalidated'"),
      version: data => data.db.exec("UPDATE workflows SET prototype_version=1"),
      cooldown: data => data.db.prepare("UPDATE workflows SET cooldown_until=?").run(data.now() + 1),
      silence: data => data.db.exec("UPDATE workflows SET recommendation_silenced_by='fixture:other'"),
      detection: data => data.config.updateConfig(current => ({ ...current, detection_enabled: false })),
      recommendation: data => data.config.updateConfig(current => ({ ...current, recommendation_enabled: false }))
    };
    for (const [name, change] of Object.entries(changes)) await withFixture(buildRoot, events, async data => {
      const packet = await data.packet();
      await change(data);
      data.log(`invalidate ${name}`);
      const result = await data.finish(packet.id, { status: "completed", recommendation_count: 2 });
      const state = data.snapshot();
      check("FINAL_ELIGIBILITY", result.status === "ignored" && state.dispatches[0].state === "cancelled" && state.requests[0].completed_at === null,
        `completion ignored changed ${name} and committed a stale receipt`);
    });
  },
  async "invalid-and-stop"(buildRoot, events) {
    await withFixture(buildRoot, events, async data => {
      const packet = await data.packet();
      const before = data.snapshot();
      for (const receipt of [
        { status: "completed", recommendation_count: -1 }, { status: "completed", recommendation_count: 4 },
        { status: "completed", recommendation_count: 1.5 }, { status: "completed", recommendation_count: 1, baseline_skill: "fixture" },
        { status: "no_improvement", baseline_skill: "E:/private/path" }, { status: "no_improvement", baseline_skill: "fixture", recommendation_count: 0 },
        { status: "unavailable", unavailable_reason: "not_tried" }, { status: "unavailable", unavailable_reason: "tools_missing", recommendation_count: 0 }
      ]) assert.equal((await data.finish(packet.id, receipt)).status, "invalid", "strict selected receipt fields");
      assert.equal((await data.finish("malformed", { status: "completed", recommendation_count: 0 })).status, "invalid");
      assert.equal((await data.finish("00000000-0000-4000-8000-000000000000", { status: "completed", recommendation_count: 0 })).status, "ignored");
      assert.deepEqual(data.snapshot(), before, "invalid and unknown receipts have no effect");
      assert.deepEqual(await data.handlers.claim_dispatch({ session_id: packet.task, turn_id: packet.turn, stop_hook_active: false }), {}, "public Stop handler never claims");
      check("STOP_INTERRUPTION", data.snapshot().dispatches[0].state === "failed" && data.snapshot().dispatches[0].error_code === "dispatch_interrupted",
        "Stop did not interrupt the in-flight web request");
      assert.equal((await data.finish(packet.id, { status: "completed", recommendation_count: 1 })).status, "ignored");
    });
  },
  async "failure-retry"(buildRoot, events) {
    for (const reason of ["tools_missing", "guide_unreadable", "lookup_failed", "query_unsafe"]) await withFixture(buildRoot, events, async data => {
      const first = await data.claim();
      for (let attempt = 0; attempt < 3; attempt++) {
        let claim = first;
        if (attempt > 0) {
          data.advance(attempt === 1 ? 1 : 300_000);
          const ids = await data.add(`retry-task-${attempt}`, `retry-turn-${attempt}`);
          claim = await data.claim(ids.task, ids.turn);
        }
        assert.ok(claim, `retry ${attempt} allowed at five-minute equality`);
        const result = await data.finish(claim.recommendation_id, { status: "unavailable", unavailable_reason: reason });
        check("FAILURE_RETRY", result.status === "accepted", "checked lookup failure was not recorded");
        const state = data.snapshot();
        check("FAILURE_RETRY", state.dispatches.at(-1).state === "failed" && state.dispatches.at(-1).error_code === `search_unavailable:${reason}` &&
          state.requests.every(item => item.completed_at === null) && state.workflows[0].cooldown_until === null && state.workflows[0].recommendation_silenced_by === null,
          "lookup failure authorized a success receipt, cooldown or silence");
        if (attempt === 0) {
          data.advance(299_999);
          const ids = await data.add("early-task", "early-turn");
          assert.equal(await data.claim(ids.task, ids.turn), undefined, "retry before five minutes denied");
        }
      }
      data.advance(300_000);
      const capped = await data.add("capped-task", "capped-turn");
      check("FAILURE_RETRY", await data.claim(capped.task, capped.turn) === undefined, "fourth retry inside one-hour window passed cap");
      data.advance(3_600_000 - 900_000);
      const boundary = await data.add("boundary-task", "boundary-turn");
      check("FAILURE_RETRY", !!await data.claim(boundary.task, boundary.turn), "one-hour equality did not expire first failed attempt");
    });
  },
  async "contention"(buildRoot, events) {
    await withFixture(buildRoot, events, async data => {
      const claim = await data.claim();
      let reads = 0;
      data.db.exec("BEGIN IMMEDIATE");
      const result = await data.store.finishRecommendation({ recommendation_id: claim.recommendation_id, status: "completed", recommendation_count: 1,
        finishedAt: data.now(), dispatchEnabled: async () => {
          if (++reads === 2) data.db.exec("ROLLBACK");
          return reads === 1;
        } });
      check("LIVE_RETRY_CONTROLS", reads === 2 && result === false && data.snapshot().requests[0].completed_at === null &&
        data.snapshot().dispatches[0].state === "cancelled", "bounded busy retry did not refresh disabled control before committing");
      data.log("busy retry refreshed controls");
    });
    await withFixture(buildRoot, events, async data => {
      const packet = await data.packet();
      const other = await data.otherStore();
      const value = { recommendation_id: packet.id, status: "completed", recommendation_count: 2, finishedAt: data.now(), dispatchEnabled: async () => true };
      const results = await Promise.all([data.store.finishRecommendation(value), other.finishRecommendation(value)]);
      check("COMPLETION_ATOMICITY", results.filter(Boolean).length === 1, "competing completions committed twice");
      check("COMPLETION_ATOMICITY", data.snapshot().requests.filter(item => item.completed_at !== null).length === 1, "completion receipt duplicated");
      data.log("independent connections competed for completion");
    });
  }
};

export const scenarioNames = Object.keys(scenarios);

export async function runScenario(buildRoot, name) {
  const events = [];
  try {
    assert.ok(Object.hasOwn(scenarios, name), `known scenario ${name}`);
    await scenarios[name](buildRoot, events);
    return { kind: "pass", scenario: name, events };
  } catch (error) {
    return { kind: error.rule ? "invariant-failed" : "incomplete", scenario: name,
      rule: error.rule ?? null, message: error.message, stack: error.stack, events };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const result = await runScenario(path.resolve(process.argv[2] ?? runtime), process.argv[3]);
  console.log(JSON.stringify(result));
  process.exitCode = result.kind === "pass" ? 0 : 1;
}
