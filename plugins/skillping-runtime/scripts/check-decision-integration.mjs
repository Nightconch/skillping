import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openConfigStore } from "../dist/config.js";
import { openStorage } from "../dist/storage.js";
import { createScoutEngine, releaseIdleStorage } from "../dist/engine.js";

const NOW = 1_792_454_400_000;
const prototype = {
  core_goal: "Implement an approved specification and its dependent work items",
  input_roles: ["Approved specification", "Dependent work items", "Runnable repository"],
  output: "Integrated implementation and verification evidence",
  essential_steps: ["Resolve dependencies", "Implement isolated tasks", "Integrate changes", "Test and review"],
  variable_slots: [], scope: "global"
};
const controls = async () => ({ detectionEnabled: true, recommendationEnabled: true });

async function isolated(t) {
  const root = await mkdtemp(path.join(tmpdir(), "skillping-decision-"));
  t.after(() => removeFixture(root));
  return root;
}

async function removeFixture(root) {
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith("skillping-decision-"));
  await rm(root, { recursive: true, force: true });
}

async function fixture(t, count = 2) {
  const root = await mkdtemp(path.join(tmpdir(), "skillping-decision-"));
  let now = NOW;
  const file = path.join(root, "scout.sqlite");
  const store = await openStorage({ filename: file, now: () => now, recommendationPace: () => "eager" });
  const db = new DatabaseSync(file);
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    if (db.isOpen) db.close();
    store.close();
    await removeFixture(root);
  });
  for (let i = 0; i < count; i++) {
    db.prepare(`INSERT INTO workflows
      (scope_kind,scope_value,state,prototype_json,prototype_version,representatives_json,last_seen_at,suppression,created_at,updated_at)
      VALUES('global',NULL,'confirmed',?,3,'[]',?,'none',?,?)`).run(JSON.stringify(prototype), now, now, now);
  }
  const record = (turn = "turn-1", task = "task-1") => ({
    codex_task_id: task, turn_id: turn, message_id: "", source: "realtime",
    occurred_at: now, expires_at: now + 86_400_000, workspace_path: "E:/fixture/workspace",
    prompt: `Carry out the requested implementation ${turn}`, recommendation_enabled: true,
    observations: [{ relation: "new", confidence: "high", variable_slots: [],
      fingerprint: { core_goal: "Deliver this change", input_roles: ["Specification"],
        output: "Verified code", essential_steps: ["Build", "Check"], scope: "global" },
      capabilities: [{ ...prototype, confidence: "high" }] }]
  });
  return { root, store, db, record, cleanups, now: () => now, advance: value => { now += value; } };
}

function hasDecisionStorage(store) {
  assert.equal(typeof store.prepareDecisionMatch, "function", "storage must freeze candidates before network I/O");
  assert.equal(typeof store.finalizeDecisionMatch, "function", "storage must apply complete decision batches");
}

const edges = db => db.prepare("SELECT workflow_id,episode_id FROM episode_workflows ORDER BY workflow_id,episode_id").all()
  .map(row => ({ workflow_id: Number(row.workflow_id), episode_id: Number(row.episode_id) }));

test("decision configuration starts disabled and without inferred thresholds", async t => {
  const root = await isolated(t);
  const config = await openConfigStore(root, () => NOW);
  assert.equal(config.readConfig().decision_model?.enabled, false);
  assert.equal(config.readConfig().decision_model.allow_external, false);
  assert.equal(config.readConfig().decision_model.api_key, "");
  assert.equal(config.readConfig().decision_model.existence, null);
  assert.equal(config.readConfig().decision_model.matching, null);
  await assert.rejects(config.updateConfig(current => ({ ...current, decision_model: {
    ...current.decision_model, match_timeout_ms: Infinity
  } })));
  await assert.rejects(config.updateConfig(current => ({ ...current, decision_model: {
    ...current.decision_model, api_key: 42
  } })));
});

test("direct config keys are trimmed, persisted and optional for existing configurations", async t => {
  const root = await isolated(t);
  const config = await openConfigStore(root, () => NOW);
  const revision = config.readConfig().decision_revision;
  await config.updateConfig(current => ({ ...current, decision_model: {
    ...current.decision_model, api_key: "  config-only-key  "
  } }));
  assert.equal(config.readConfig().decision_model.api_key, "config-only-key");
  assert.equal(config.readConfig().decision_revision, revision + 1);
  assert.equal((await openConfigStore(root, () => NOW)).readConfig().decision_model.api_key, "config-only-key");
  await config.updateConfig(current => ({ ...current, decision_model: { ...current.decision_model, api_key: "   " } }));
  assert.equal(config.readConfig().decision_model.api_key, "");
  const saved = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"));
  delete saved.decision_model.api_key;
  await writeFile(path.join(root, "config.json"), JSON.stringify(saved));
  assert.equal((await config.refreshConfig()).decision_model.api_key, "");
});

test("precheck allows five seconds and the native Hook leaves time to return", async t => {
  const root = await isolated(t);
  const config = await openConfigStore(root, () => NOW);
  assert.equal(config.readConfig().decision_model.precheck_timeout_ms, 5000);
  await config.updateConfig(current => ({ ...current, decision_model: { ...current.decision_model, precheck_timeout_ms: 5000 } }));
  await assert.rejects(config.updateConfig(current => ({ ...current, decision_model: { ...current.decision_model, precheck_timeout_ms: 5001 } })));
  const manifest = JSON.parse(await readFile(new URL("../../skillping/hooks/hooks.json", import.meta.url), "utf8"));
  const hook = manifest.hooks.UserPromptSubmit[0].hooks[0];
  assert.ok(hook.timeout * 1000 > config.readConfig().decision_model.precheck_timeout_ms);
});

test("decision thresholds no longer require version calibration and discard legacy fields", async t => {
  const root = await isolated(t);
  const config = await openConfigStore(root, () => NOW);
  await config.updateConfig(current => ({ ...current, decision_model: { ...current.decision_model,
    existence: { threshold: 0.7 }, matching: { threshold: 0.8 }
  } }));
  assert.deepEqual(config.readConfig().decision_model.existence, { threshold: 0.7 });
  await config.updateConfig(current => ({ ...current, decision_model: { ...current.decision_model,
    matching: { threshold: 0.8, model_version: "old-version", criteria_version: 1 }
  } }));
  assert.deepEqual(config.readConfig().decision_model.matching, { threshold: 0.8 });
  await assert.rejects(config.updateConfig(current => ({ ...current, decision_model: { ...current.decision_model,
    existence: { threshold: 0.7, api_key: "never-store-credentials" }
  } })));
});

test("preparation is read-only and freezes only five ordered candidates", async t => {
  const { store, db, record } = await fixture(t, 7);
  hasDecisionStorage(store);
  const plan = await store.prepareDecisionMatch(record(), controls);
  assert.deepEqual(plan.candidates.map(item => item.workflow_id), [1, 2, 3, 4, 5]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM prompts").get().n, 0);
  db.exec("BEGIN IMMEDIATE; ROLLBACK;");
  const result = await store.finalizeDecisionMatch(plan.token, { source: "main_model_fallback" }, controls);
  assert.equal(result.matching_source, "main_model_fallback");
  assert.deepEqual(result.review.requests[0].candidates.map(item => item.workflow_id), [1, 2, 3, 4, 5]);
  assert.equal(edges(db).length, 0);
});

test("complete multi-hit decisions count one episode once for every hit", async t => {
  const { store, db, record } = await fixture(t);
  hasDecisionStorage(store);
  const plan = await store.prepareDecisionMatch(record(), controls);
  const result = await store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: [1, 2] }, controls);
  assert.equal(result.matching_source, "decision_model");
  assert.deepEqual(edges(db), [{ workflow_id: 1, episode_id: 1 }, { workflow_id: 2, episode_id: 1 }]);
  assert.equal(await store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: [1, 2] }, controls), "stale");
  const retry = await store.prepareDecisionMatch(record(), controls);
  if (retry) await store.finalizeDecisionMatch(retry.token, { source: "decision_model", matchedWorkflowIds: [1, 2] }, controls);
  assert.equal(edges(db).length, 2);
  const repeatedBody = { ...record("turn-retry"), prompt: record().prompt };
  const repeat = await store.prepareDecisionMatch(repeatedBody, controls);
  if (repeat) await store.finalizeDecisionMatch(repeat.token, { source: "decision_model", matchedWorkflowIds: [1, 2] }, controls);
  assert.equal(edges(db).length, 2);
});

test("a valid zero-hit result creates one forming workflow without host fallback", async t => {
  const { store, db, record } = await fixture(t);
  hasDecisionStorage(store);
  const plan = await store.prepareDecisionMatch(record(), controls);
  const result = await store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: [] }, controls);
  assert.equal(result.review, undefined);
  assert.deepEqual(edges(db), [{ workflow_id: 3, episode_id: 1 }]);
  assert.equal(db.prepare("SELECT state FROM workflows WHERE id=3").get().state, "forming");
});

test("a failed request enters host review even for a unique identical candidate", async t => {
  const { store, db, record } = await fixture(t, 1);
  hasDecisionStorage(store);
  const plan = await store.prepareDecisionMatch(record(), controls);
  const result = await store.finalizeDecisionMatch(plan.token, { source: "main_model_fallback" }, controls);
  assert.equal(result.review.requests[0].candidates[0].workflow_id, 1);
  assert.equal(edges(db).length, 0);
});

test("invalid, duplicate or outside IDs never apply a partial batch", async t => {
  for (const ids of [[1, 999], [1, 1], [1, 1.2]]) {
    const { store, db, record } = await fixture(t);
    hasDecisionStorage(store);
    const plan = await store.prepareDecisionMatch(record(), controls);
    await assert.rejects(store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: ids }, controls));
    assert.equal(edges(db).length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM prompts").get().n, 0);
  }
});

test("changed semantics, controls, expired snapshots and closed stores reject late results", async t => {
  for (const change of ["semantics", "suppression", "expiry", "disabled", "closed"]) {
    const { store, db, record, advance } = await fixture(t);
    hasDecisionStorage(store);
    const plan = await store.prepareDecisionMatch(record(), controls);
    if (change === "semantics") db.prepare("UPDATE workflows SET prototype_version=1 WHERE id=1").run();
    if (change === "suppression") db.prepare("UPDATE workflows SET suppression='permanent' WHERE id=1").run();
    if (change === "expiry") advance(600_001);
    if (change === "closed") store.close();
    const readControls = change === "disabled" ? async () => ({ detectionEnabled: false, recommendationEnabled: false }) : controls;
    const result = await store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: [1, 2] }, readControls);
    assert.ok(result === undefined || result === "stale");
    assert.equal(edges(db).length, 0);
  }
});

test("each hit receives its own confirmation and suppression still blocks dispatch", async t => {
  const { store, db, record } = await fixture(t);
  hasDecisionStorage(store);
  for (let i = 0; i < 3; i++) {
    const plan = await store.prepareDecisionMatch(record(`turn-${i}`, `task-${i}`), controls);
    const result = await store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: [1, 2] }, controls);
    if (i === 0) db.exec("UPDATE workflows SET state='forming';");
    if (i === 2) {
      assert.deepEqual(result.review.requests.map(request => request.candidates.map(item => item.workflow_id)), [[1], [2]]);
      assert.ok(result.review.requests.every(request => request.review_reason === "confirm"));
    }
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dispatches").get().n, 0);
  db.exec("UPDATE workflows SET state='confirmed',suppression='permanent';");
  const plan = await store.prepareDecisionMatch(record("turn-suppressed", "task-new"), controls);
  await store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: [1, 2] }, controls);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dispatches").get().n, 0);
});

const thresholds = { threshold: 0.8 };
const response = answers => new Response(JSON.stringify({ model: "kettei-fat", version: "fixture-v1", answers,
  usage: { input_tokens: 10, output_tokens: 0, tokenizer: { name: "fixture", revision: "1" } },
  timing_ms: { render: 1, score: 1, load: 0 } }));
const noul = probability => ({ type: "noul", noul: probability });

async function engineFixture(t, fetch, settings = {}, count = 2) {
  const data = await fixture(t, count);
  const config = await openConfigStore(data.root, data.now);
  await config.updateConfig(current => ({ ...current, recommendation_enabled: false, decision_model: {
    ...current.decision_model, enabled: true, allow_external: true, api_key: "fixture-key",
    existence: thresholds, matching: thresholds, ...settings
  } }));
  const engine = await createScoutEngine({ pluginRoot: fileURLToPath(new URL("../", import.meta.url)), dataDir: data.root,
    now: data.now, spawnProcess: spawn, fetch });
  data.cleanups.push(async () => { await engine.control({ command: "disable_detection" }); await releaseIdleStorage(engine); });
  const stage = (turn = "turn-1", prompt = "Carry out the requested change and verify its behavior.") => engine.stagePrompt({
    session_id: "task-1", turn_id: turn, prompt, cwd: "E:/fixture/workspace", model: "host-model"
  });
  const extract = (turn = "turn-1", capability = prototype) => engine.observeTurn({
    phase: "extract", schema_version: 6, session_id: "task-1", turn_id: turn, disposition: "analyze", items: [{
      core_goal: "Deliver the approved change", input_roles: ["Approved design"], output: "Working implementation",
      essential_steps: ["Inspect dependencies", "Implement the design", "Verify behavior"], scope_hint: "global", confidence: "high",
      capabilities: [{ ...capability, confidence: "high" }]
    }]
  });
  return { ...data, config, engine, stage, extract };
}

test("direct config keys drive both stages, reload edits and remain private", async t => {
  const keys = ["precheck-config-secret", "matching-config-secret"];
  const headers = [];
  const outputs = [];
  const data = await engineFixture(t, async (_url, init) => {
    headers.push(new Headers(init.headers).get("authorization"));
    assert.ok(keys.every(key => !init.body.includes(key)));
    return response(Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(id => [id, noul(1)])));
  }, { api_key: keys[0] });
  outputs.push(await data.stage());
  assert.ok(outputs[0].hookSpecificOutput);
  await data.config.updateConfig(current => ({ ...current, decision_model: { ...current.decision_model, api_key: keys[1] } }));
  outputs.push(await data.extract());
  assert.equal(outputs[1].matching_source, "decision_model");
  assert.deepEqual(headers, keys.map(key => `Bearer ${key}`));
  outputs.push(await data.engine.control({ command: "status" }));
  outputs.push(await data.engine.control({ command: "help" }));
  outputs.push(await data.engine.control({ command: "set_pace", pace: "cautious" }));
  assert.ok(keys.every(key => !JSON.stringify(outputs).includes(key)));
  assert.equal(JSON.parse(await readFile(path.join(data.root, "config.json"), "utf8")).decision_model.api_key, keys[1]);
  for (const name of await readdir(data.root)) {
    if (name === "config.json") continue;
    const bytes = await readFile(path.join(data.root, name));
    assert.ok(keys.every(key => !bytes.includes(Buffer.from(key))), `credential persisted in ${name}`);
  }
});

test("missing or blank config keys keep both decision stages on native fallback", async t => {
  for (const api_key of ["", "   "]) {
    const data = await engineFixture(t, async () => assert.fail("a blank config key must not send a request"), { api_key });
    assert.ok((await data.stage()).hookSpecificOutput);
    const result = await data.extract();
    assert.equal(result.status, "review_required");
    assert.equal(result.matching_source, "main_model_fallback");
    assert.equal(edges(data.db).length, 0);
  }
});

test("direct config keys survive record clearing while the local data key is deleted", async t => {
  const root = await isolated(t);
  const config = await openConfigStore(root, () => NOW);
  await config.updateConfig(current => ({ ...current, decision_model: { ...current.decision_model, api_key: "retained-connection-key" } }));
  const connection = config.readConfig().decision_model;
  await writeFile(path.join(root, "key.dpapi"), "fixture-data-key");
  const engine = await createScoutEngine({ pluginRoot: fileURLToPath(new URL("../", import.meta.url)), dataDir: root,
    now: () => NOW, spawnProcess: spawn });
  try {
    const confirmation = await engine.control({ command: "request_clear", session_id: "clear-key-task" });
    assert.equal(confirmation.status, "confirmation_required");
    assert.match(confirmation.message, /数据密钥/);
    assert.match(confirmation.message, /API Key/);
    const result = await engine.control({ command: "confirm_clear", session_id: "clear-key-task", confirmation_token: confirmation.confirmation_token });
    assert.equal(result.status, "ok");
    assert.match(result.message, /API Key/);
    assert.deepEqual((await config.refreshConfig()).decision_model, connection);
    await assert.rejects(readFile(path.join(root, "key.dpapi")), { code: "ENOENT" });
    assert.equal(JSON.stringify([confirmation, result]).includes(connection.api_key), false);
  } finally {
    await engine.control({ command: "disable_detection" });
    await releaseIdleStorage(engine);
  }
});

test("precheck consumes a valid response after the former two-second Hook limit", async t => {
  const data = await engineFixture(t, async (_url, init) => {
    await delay(2200, undefined, { signal: init.signal });
    return response({ reusable_work: noul(0.1) });
  });
  assert.equal(Boolean((await data.stage()).hookSpecificOutput), false);
});

test("valid probabilities are adopted without a response version or when its version changes", async t => {
  for (const version of [undefined, "a-new-version"]) {
    const transport = async (_url, init) => new Response(JSON.stringify({ model: "kettei-fat", ...(version ? { version } : {}),
      answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(id => [id, noul(id === "reusable_work" ? 0.1 : 0.95)])) }));
    const negative = await engineFixture(t, transport);
    assert.equal(Boolean((await negative.stage()).hookSpecificOutput), false, "a valid negative precheck must be used");
    const matched = await engineFixture(t, transport, { existence: null }, 1);
    await matched.stage();
    assert.equal((await matched.extract()).matching_source, "decision_model");
    assert.deepEqual(edges(matched.db), [{ workflow_id: 1, episode_id: 1 }]);
  }
});

test("existence false suppresses extraction while failure returns original host instructions", async t => {
  const low = await engineFixture(t, async () => response({ reusable_work: noul(0.1) }));
  assert.equal((await low.stage()).hookSpecificOutput, undefined);
  assert.equal((await low.extract()).status, "ignored");
  assert.equal(low.db.prepare("SELECT COUNT(*) AS n FROM prompts").get().n, 0);
  const failed = await engineFixture(t, async () => { throw new Error("fixture vendor failure"); });
  assert.ok((await failed.stage()).hookSpecificOutput.additionalContext.includes("schema_version=6"));
});

test("disabled, unpermitted, unset thresholds and private inputs remain local", async t => {
  const never = async () => assert.fail("private or disabled content must not leave the process");
  for (const settings of [{ enabled: false }, { allow_external: false }, { existence: null, matching: null }]) {
    const data = await engineFixture(t, never, settings);
    assert.ok((await data.stage()).hookSpecificOutput);
  }
  const privateData = await engineFixture(t, never);
  assert.ok((await privateData.stage("private", "Review C:/private/customer.csv and describe its structure.")).hookSpecificOutput);
  const privateMatch = await engineFixture(t, never, { existence: null });
  await privateMatch.stage();
  const result = await privateMatch.extract("turn-1", { ...prototype, core_goal: "Inspect C:/private/customer.csv for quality" });
  assert.equal(result.status, "review_required");
  assert.equal(result.matching_source, "main_model_fallback");
});

test("Hook total deadline includes a stalled response body and still returns fallback instructions", async t => {
  const data = await engineFixture(t, async () => new Response(new ReadableStream({ start() {} })), { precheck_timeout_ms: 20 });
  const result = await Promise.race([data.stage(), new Promise((_, reject) => setTimeout(() => reject(new Error("Hook failed to return within its budget")), 1700))]);
  assert.ok(result.hookSpecificOutput);
});

test("reused Hook identifiers cannot substitute a safe gate for cached private content", async t => {
  let calls = 0;
  const data = await engineFixture(t, async () => { calls++; return response({ reusable_work: noul(1) }); });
  await data.stage("same-turn", "Review C:/private/customer.csv and describe its structure.");
  assert.equal(Boolean((await data.stage("same-turn", "Describe a public data validation procedure.")).hookSpecificOutput), false);
  assert.equal(calls, 0);
});

test("existence decisions are recomputed after a decision configuration revision", async t => {
  let calls = 0;
  const data = await engineFixture(t, async () => response({ reusable_work: noul(++calls === 1 ? 1 : 0) }));
  assert.ok((await data.stage()).hookSpecificOutput);
  await data.config.updateConfig(current => ({ ...current, decision_model: { ...current.decision_model, enabled: false } }));
  await data.config.updateConfig(current => ({ ...current, decision_model: { ...current.decision_model, enabled: true } }));
  assert.equal(Boolean((await data.stage()).hookSpecificOutput), false);
  assert.equal(calls, 2);
});

test("the Hook returns fallback within its total budget even when configuration reads are slow", async t => {
  const data = await engineFixture(t, async () => new Response(new ReadableStream({ start() {} })), { precheck_timeout_ms: 5000 });
  const original = fsPromises.readFile;
  try {
    fsPromises.readFile = async (file, ...args) => {
      if (path.resolve(String(file)) === path.join(data.root, "config.json")) await delay(250);
      return original(file, ...args);
    };
    syncBuiltinESMExports();
    const pending = data.stage();
    try {
      const result = await Promise.race([pending, delay(5900).then(() => assert.fail("config and decision I/O exceeded the Hook budget"))]);
      assert.ok(result.hookSpecificOutput);
    } finally { await pending; }
  } finally { fsPromises.readFile = original; syncBuiltinESMExports(); }
});

test("a timed-out Hook continuation cannot recreate a turn after the host skips it", async t => {
  const data = await engineFixture(t, async () => assert.fail("expired Hook must not request a decision"));
  const original = fsPromises.readFile;
  const first = Promise.withResolvers();
  const third = Promise.withResolvers();
  let reads = 0;
  try {
    fsPromises.readFile = async (file, ...args) => {
      if (path.resolve(String(file)) === path.join(data.root, "config.json")) {
        reads++;
        if (reads === 1) await first.promise;
        if (reads === 3) await third.promise;
      }
      return original(file, ...args);
    };
    syncBuiltinESMExports();
    assert.ok((await data.stage()).hookSpecificOutput);
    const skipped = data.engine.observeTurn({ phase: "extract", schema_version: 6, session_id: "task-1", turn_id: "turn-1", disposition: "skip", items: [] });
    first.resolve();
    assert.equal((await skipped).status, "accepted");
    third.resolve();
    assert.equal((await data.engine.observeTurn({ phase: "extract", schema_version: 6, session_id: "task-1", turn_id: "turn-1",
      disposition: "skip", items: [] })).status, "ignored");
  } finally { first.resolve(); third.resolve(); fsPromises.readFile = original; syncBuiltinESMExports(); }
});

test("valid matching is decision-first, excludes local metadata and holds no database transaction during HTTP", async t => {
  let data;
  let calls = 0;
  data = await engineFixture(t, async (_url, init) => {
    calls++;
    data.db.exec("BEGIN IMMEDIATE; ROLLBACK;");
    const clearLock = new DatabaseSync(path.join(data.root, "clear-lock.sqlite"));
    try { clearLock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK;"); } finally { clearLock.close(); }
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body.questions), ["workflow_1", "workflow_2"]);
    assert.equal(body.state.includes("E:/fixture/workspace"), false);
    assert.equal(body.state.includes("scope"), false);
    assert.equal(body.state.includes("Carry out the requested change"), false);
    return response({ workflow_1: noul(0.9), workflow_2: noul(1) });
  }, { existence: null });
  await data.stage();
  const result = await data.extract();
  assert.equal(result.status, "accepted");
  assert.equal(result.matching_source, "decision_model");
  assert.equal(calls, 1);
  assert.deepEqual(edges(data.db), [{ workflow_id: 1, episode_id: 1 }, { workflow_id: 2, episode_id: 1 }]);
});

test("complete low and middle probabilities never invoke host matching", async t => {
  const data = await engineFixture(t, async () => response({ workflow_1: noul(0), workflow_2: noul(0.5) }), { existence: null });
  await data.stage();
  const result = await data.extract();
  assert.equal(result.status, "accepted");
  assert.equal(result.matching_source, "decision_model");
  assert.deepEqual(edges(data.db), [{ workflow_id: 3, episode_id: 1 }]);
});

test("one missing or invalid answer falls back on the complete frozen catalog", async t => {
  for (const answers of [{ workflow_1: noul(1) }, { workflow_1: noul(0.9), workflow_2: { type: "noul", noul: "1" } }]) {
    const data = await engineFixture(t, async () => response(answers), { existence: null });
    await data.stage();
    const result = await data.extract();
    assert.equal(result.status, "review_required");
    assert.equal(result.matching_source, "main_model_fallback");
    assert.deepEqual(result.requests[0].catalog.items.map(item => item.workflow_id), [1, 2]);
    assert.equal(edges(data.db).length, 0);
  }
});

test("empty candidate sets are handled locally without matching HTTP", async t => {
  const data = await engineFixture(t, async () => assert.fail("empty candidates must not call fetch"), { existence: null }, 0);
  await data.stage();
  assert.equal((await data.extract()).status, "accepted");
  assert.deepEqual(edges(data.db), [{ workflow_id: 1, episode_id: 1 }]);
});

test("skip, generation changes and decision disable-enable reject late matching writes", async t => {
  for (const action of ["skip", "generation", "decision_cycle"]) {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const data = await engineFixture(t, async () => { started.resolve(); await release.promise; return response({ workflow_1: noul(1), workflow_2: noul(1) }); }, { existence: null });
    await data.stage();
    const extraction = data.extract();
    await started.promise;
    if (action === "skip") await data.engine.control({ command: "skip_turn", session_id: "task-1", turn_id: "turn-1" });
    if (action === "generation") await data.config.updateConfig(current => ({ ...current, data_generation: current.data_generation + 1 }));
    if (action === "decision_cycle") {
      await data.config.updateConfig(current => ({ ...current, decision_model: { ...current.decision_model, enabled: false } }));
      await data.config.updateConfig(current => ({ ...current, decision_model: { ...current.decision_model, enabled: true } }));
    }
    release.resolve();
    assert.equal((await extraction).status, "ignored", action);
    assert.equal(edges(data.db).length, 0);
  }
});

async function confirmationFixture(t) {
  const data = await fixture(t);
  for (let i = 0; i < 3; i++) {
    const plan = await data.store.prepareDecisionMatch(data.record(`turn-${i}`, `task-${i}`), controls);
    data.result = await data.store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: [1, 2] }, controls);
    if (i === 0) data.db.exec("UPDATE workflows SET state='forming';");
  }
  for (const request of data.result.review.requests) {
    const catalog = await data.store.getReviewEvidence({ review_set_id: data.result.review.review_set_id, request_id: request.request_id }, controls);
    assert.equal(catalog.status, "ok");
    assert.deepEqual(catalog.candidates.map(candidate => candidate.workflow_id), [request.candidates[0].workflow_id]);
    const page = await data.store.getReviewEvidence({ review_set_id: data.result.review.review_set_id, request_id: request.request_id,
      workflow_id: request.candidates[0].workflow_id }, controls);
    assert.equal(page.status, "ok");
    assert.equal(page.has_more, false);
  }
  return data;
}

test("legacy host confirmation authorizes both hits and a single search claim per turn", async t => {
  const { store, db, result } = await confirmationFixture(t);
  assert.equal(await store.resolveReview({ phase: "review", schema_version: 3, session_id: "task-2", turn_id: "turn-2",
    review_set_id: result.review.review_set_id, decisions: result.review.requests.map(request => ({
      request_id: request.request_id, kind: "capability", review_reason: "confirm", verdict: "same",
      selected_workflow_id: request.candidates[0].workflow_id
    })) }, controls), true);
  assert.deepEqual(db.prepare("SELECT state FROM workflows ORDER BY id").all().map(row => row.state), ["confirmed", "confirmed"]);
  assert.equal(edges(db).length, 6);
  const first = await store.claimDispatch({ codexTaskId: "task-2", turnId: "turn-2", cwd: "E:/fixture/workspace", claimedAt: NOW });
  assert.ok(first);
  assert.equal(await store.claimDispatch({ codexTaskId: "task-2", turnId: "turn-2", cwd: "E:/fixture/workspace", claimedAt: NOW }), undefined);
});

test("rejecting one hit during confirmation preserves its independently confirmed sibling", async t => {
  const { store, db, result } = await confirmationFixture(t);
  assert.equal(await store.resolveReview({ phase: "review", schema_version: 3, session_id: "task-2", turn_id: "turn-2",
    review_set_id: result.review.review_set_id, decisions: result.review.requests.map((request, index) => ({
      request_id: request.request_id, kind: "capability", review_reason: "confirm",
      ...(index === 0 ? { verdict: "same", selected_workflow_id: 1 } : { verdict: "different" })
    })) }, controls), true);
  assert.equal(edges(db).filter(edge => edge.workflow_id === 1).length, 3);
  assert.equal(edges(db).filter(edge => edge.workflow_id === 2).length, 2);
  assert.equal(edges(db).filter(edge => edge.workflow_id === 3).length, 1);
  assert.equal(db.prepare("SELECT state FROM workflows WHERE id=1").get().state, "confirmed");
});

test("refreshing two singleton confirmations keeps each workflow's independent target", async t => {
  const { store, db, result } = await confirmationFixture(t);
  db.prepare("UPDATE workflows SET cooldown_until=? WHERE id=1").run(NOW + 1000);
  const refreshed = await store.refreshReview(result.review.review_set_id, controls);
  assert.equal(refreshed.status, "review_required");
  assert.equal(refreshed.matching_source, "decision_model");
  assert.deepEqual(refreshed.requests.map(request => request.catalog.items.map(item => item.workflow_id)), [[1], [2]]);
});

test("a singleton confirmation remains available when its target ranks below the catalog limit", async t => {
  const { store, db, result } = await confirmationFixture(t);
  for (let i = 0; i < 5; i++) db.prepare(`INSERT INTO workflows
    (scope_kind,scope_value,state,prototype_json,prototype_version,representatives_json,last_seen_at,suppression,created_at,updated_at)
    VALUES('global',NULL,'confirmed',?,3,'[]',?,'none',?,?)`).run(JSON.stringify(prototype), NOW, NOW, NOW);
  db.prepare("UPDATE workflows SET prototype_json=? WHERE id=1").run(JSON.stringify({ ...prototype,
    core_goal: "Translate a public poem", input_roles: ["Poem"], output: "Translation", essential_steps: ["Translate"] }));
  const refreshed = await store.refreshReview(result.review.review_set_id, controls);
  assert.equal(refreshed.status, "review_required");
  assert.deepEqual(refreshed.requests.map(request => request.catalog.items.map(item => item.workflow_id)), [[1], [2]]);
});

test("host fallback can resolve the capped catalog through the unchanged v3 protocol", async t => {
  const { store, db, record } = await fixture(t, 7);
  const plan = await store.prepareDecisionMatch(record(), controls);
  const result = await store.finalizeDecisionMatch(plan.token, { source: "main_model_fallback" }, controls);
  const request = result.review.requests[0];
  const detail = await store.getReviewEvidence({ review_set_id: result.review.review_set_id,
    request_id: request.request_id, workflow_id: 2 }, controls);
  assert.equal(detail.status, "ok");
  assert.equal(await store.resolveReview({ phase: "review", schema_version: 3, session_id: "task-1", turn_id: "turn-1",
    review_set_id: result.review.review_set_id, decisions: [{ request_id: request.request_id, kind: "capability",
      review_reason: "match", verdict: "same", selected_workflow_id: 2 }] }, controls), true);
  assert.deepEqual(edges(db), [{ workflow_id: 2, episode_id: 1 }]);
});

test("evidence changes after preparation invalidate the entire original result", async t => {
  const { store, db, record } = await fixture(t);
  const older = await store.prepareDecisionMatch(record(), controls);
  const newer = await store.prepareDecisionMatch(record("turn-new", "task-new"), controls);
  await store.finalizeDecisionMatch(newer.token, { source: "decision_model", matchedWorkflowIds: [1] }, controls);
  assert.equal(await store.finalizeDecisionMatch(older.token, { source: "decision_model", matchedWorkflowIds: [1, 2] }, controls), "stale");
  assert.deepEqual(edges(db), [{ workflow_id: 1, episode_id: 1 }]);
});

test("scope and retained state remain local candidate rules", async t => {
  const { store, db, record } = await fixture(t, 4);
  const project = { ...prototype, scope: "project" };
  db.prepare("UPDATE workflows SET scope_kind='project',scope_value=?,prototype_json=? WHERE id IN (1,2,3,4)")
    .run("e:/fixture/workspace", JSON.stringify(project));
  db.prepare("UPDATE workflows SET scope_value='e:/different/workspace' WHERE id=2").run();
  db.exec("UPDATE workflows SET state='invalidated' WHERE id=3; UPDATE workflows SET suppression='permanent',state='invalidated' WHERE id=4;");
  const value = record();
  value.observations[0].fingerprint.scope = "project";
  value.observations[0].capabilities = [{ ...project, confidence: "high" }];
  const plan = await store.prepareDecisionMatch(value, controls);
  assert.deepEqual(plan.candidates.map(item => item.workflow_id), [1, 4]);
  await store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: [1, 4] }, controls);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dispatches").get().n, 0);
});

test("cooldown blocks new dispatches while all matching hits still count", async t => {
  const { store, db, record, advance } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    const plan = await store.prepareDecisionMatch(record(`turn-${i}`, `task-${i}`), controls);
    await store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: [1, 2] }, controls);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE state='pending'").get().n, 2);
  await store.cancelOpenDispatches(NOW);
  db.prepare("UPDATE workflows SET cooldown_until=?").run(NOW + 1000);
  const muted = await store.prepareDecisionMatch(record("turn-muted", "task-muted"), controls);
  await store.finalizeDecisionMatch(muted.token, { source: "decision_model", matchedWorkflowIds: [1, 2] }, controls);
  assert.equal(edges(db).length, 8);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE state='pending'").get().n, 0);
  advance(1001);
  const resumed = await store.prepareDecisionMatch(record("turn-resumed", "task-resumed"), controls);
  await store.finalizeDecisionMatch(resumed.token, { source: "decision_model", matchedWorkflowIds: [1, 2] }, controls);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE state='pending'").get().n, 2);
});

test("clear aborts an in-flight matching request and no response recreates cleared evidence", async t => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let signal;
  const data = await engineFixture(t, async (_url, init) => { signal = init.signal; started.resolve();
    await release.promise; return response({ workflow_1: noul(1), workflow_2: noul(1) }); }, { existence: null });
  await data.stage();
  const extraction = data.extract();
  await started.promise;
  data.db.close(); data.store.close();
  const confirmation = await data.engine.control({ command: "request_clear", session_id: "task-1" });
  assert.equal(typeof confirmation.confirmation_token, "string");
  const cleared = await data.engine.control({ command: "confirm_clear", session_id: "task-1", confirmation_token: confirmation.confirmation_token });
  assert.equal(cleared.status, "ok");
  assert.equal(signal.aborted, true);
  release.resolve();
  assert.equal((await extraction).status, "ignored");
  const fresh = await openStorage({ filename: path.join(data.root, "scout.sqlite"), now: data.now });
  assert.equal((await fresh.getStatusCounts()).episodes, 0);
  fresh.close();
});

test("four implement-spec fixtures report expected and simulated routing separately", async t => {
  const fixtures = JSON.parse(await readFile(new URL("./fixtures/implement-spec-cases.json", import.meta.url), "utf8"));
  const simulated = {
    implement_from_spec_and_tickets: [0.95, 0.94],
    spec_and_tickets_without_implementation: [0.96, 0.04],
    review_spec_without_implementation: [0.93, 0.02],
    thanks_and_close: [0.01, null]
  };
  for (const item of fixtures.cases) {
    let matched = false;
    const [existence, probability] = simulated[item.case_id];
    const data = await engineFixture(t, async (_url, init) => {
      const body = JSON.parse(init.body);
      if (Object.hasOwn(body.questions, "reusable_work")) return response({ reusable_work: noul(existence) });
      matched = true;
      assert.deepEqual(Object.keys(body.questions), ["workflow_1"]);
      return response({ workflow_1: noul(probability) });
    }, {}, 1);
    data.db.prepare("UPDATE workflows SET prototype_json=? WHERE id=1").run(JSON.stringify({
      ...fixtures.candidates[0].prototype, scope: "global", variable_slots: []
    }));
    const staged = await data.stage(item.case_id, item.user_content);
    const hasWork = !!staged.hookSpecificOutput;
    if (hasWork) {
      const work = item.work_description;
      const result = await data.engine.observeTurn({ phase: "extract", schema_version: 6, session_id: "task-1", turn_id: item.case_id,
        disposition: "analyze", items: [{ ...work, scope_hint: "global", confidence: "high", capabilities: [
          { ...work, scope: "global", variable_slots: [], confidence: "high" }
        ] }] });
      assert.equal(result.status, "accepted");
      assert.equal(result.matching_source, "decision_model");
    }
    const observed = { has_reusable_work: hasWork, run_matching: matched,
      matched_workflow_ids: hasWork ? edges(data.db).filter(edge => edge.workflow_id === 1).map(edge => edge.workflow_id) : null };
    t.diagnostic(JSON.stringify({ case_id: item.case_id, expected: item.expected, simulated_observed: observed }));
    assert.deepEqual(observed, item.expected);
  }
});
