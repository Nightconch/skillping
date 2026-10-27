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

const catalogIds = packet => packet.requests[0].catalog.items.map(item => item.workflow_id);

async function loadEvidence(target, packet, workflowId, limit) {
  const context = { review_set_id: packet.review_set_id, request_id: packet.requests[0].request_id, workflow_id: workflowId };
  let cursor;
  const pages = [];
  do {
    const page = await target.getReviewEvidence({ ...context, ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) }, controls);
    assert.equal(page.status, "ok", `read evidence for ${workflowId}`);
    assert.equal(page.mode, "workflow");
    pages.push(page);
    cursor = page.has_more ? page.next_cursor : undefined;
    assert.equal(page.has_more, cursor !== undefined, "continuation has an opaque cursor");
  } while (cursor);
  return pages;
}

async function reviewStep(target, packet, selected, verdict = selected === undefined ? "different" : "same") {
  const request = packet.requests[0];
  let cursor = request.catalog.next_cursor;
  while (cursor) {
    const page = await target.getReviewEvidence({ review_set_id: packet.review_set_id, request_id: request.request_id, cursor }, controls);
    assert.equal(page.status, "ok");
    cursor = page.has_more ? page.next_cursor : undefined;
  }
  if (verdict === "same") {
    const ids = request.scan?.phase === "final" && packet.matching_source === "decision_model" ? catalogIds(packet) : [selected];
    for (const id of ids) await loadEvidence(target, packet, id);
  }
  const input = { ...packet.review_call, review_set_id: packet.review_set_id, decisions: [{ request_id: request.request_id,
    kind: "capability", review_reason: request.review_reason, verdict, ...(verdict === "same" ? { selected_workflow_id: selected } : {}) }] };
  return target.resolveReview ? target.resolveReview(input, controls) : target.observeTurn(input);
}

async function finishReview(target, packet, selected) {
  for (let step = 0; step < 50; step++) {
    const same = selected !== undefined && catalogIds(packet).includes(selected);
    const result = await reviewStep(target, packet, same ? selected : undefined);
    if (result?.status !== "review_required") return result;
    packet = result;
  }
  assert.fail("bounded review did not finish");
}

async function saveSelection(data, value, selected = 1) {
  const plan = await data.store.prepareDecisionMatch(value, controls);
  assert.ok(plan);
  const runner = plan.candidates.find(candidate => candidate.workflow_id !== selected)?.workflow_id;
  const result = await data.store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: [selected],
    ...(runner === undefined ? {} : { runnerUpWorkflowId: runner }) }, controls);
  if (result?.review) await finishReview(data.store, result.review.payload, selected);
  return result;
}

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

test("preparation is read-only and freezes every qualified candidate in stable order", async t => {
  const { store, db, record } = await fixture(t, 7);
  hasDecisionStorage(store);
  const plan = await store.prepareDecisionMatch(record(), controls);
  assert.deepEqual(plan.candidates.map(item => item.workflow_id), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM prompts").get().n, 0);
  db.exec("BEGIN IMMEDIATE; ROLLBACK;");
  const result = await store.finalizeDecisionMatch(plan.token, { source: "main_model_fallback" }, controls);
  assert.equal(result.matching_source, "main_model_fallback");
  assert.deepEqual(result.review.requests[0].candidates.map(item => item.workflow_id), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(catalogIds(result.review.payload), [1, 2, 3, 4, 5]);
  assert.deepEqual(result.review.payload.requests[0].scan, { phase: "scan", evaluated: 0, total: 7 });
  assert.equal(edges(db).length, 0);
});

test("a complete positive scan commits one attribution only after final evidence and dedupes retries", async t => {
  const data = await fixture(t);
  const { store, db, record } = data;
  hasDecisionStorage(store);
  const plan = await store.prepareDecisionMatch(record(), controls);
  const outcome = { source: "decision_model", matchedWorkflowIds: [2], runnerUpWorkflowId: 1 };
  const result = await store.finalizeDecisionMatch(plan.token, outcome, controls);
  assert.equal(result.matching_source, "decision_model");
  assert.deepEqual(edges(db), [], "provisional numerical winner is not evidence");
  assert.equal(await finishReview(store, result.review.payload, 2), true);
  assert.deepEqual(edges(db), [{ workflow_id: 2, episode_id: 1 }]);
  assert.equal(await store.finalizeDecisionMatch(plan.token, outcome, controls), "stale");
  const retry = await store.prepareDecisionMatch(record(), controls);
  if (retry) await store.finalizeDecisionMatch(retry.token, outcome, controls);
  assert.equal(edges(db).length, 1);
  const repeatedBody = { ...record("turn-retry"), prompt: record().prompt };
  const repeat = await store.prepareDecisionMatch(repeatedBody, controls);
  if (repeat) await store.finalizeDecisionMatch(repeat.token, outcome, controls);
  assert.equal(edges(db).length, 1);
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
  for (const ids of [[1, 2], [1, 999], [1, 1], [1, 1.2]]) {
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
    const result = await store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: [1], runnerUpWorkflowId: 2 }, readControls);
    assert.ok(result === undefined || result === "stale");
    assert.equal(edges(db).length, 0);
  }
});

test("one selected workflow receives confirmation and suppression still blocks dispatch", async t => {
  const data = await fixture(t);
  const { store, db, record } = data;
  hasDecisionStorage(store);
  for (let i = 0; i < 3; i++) {
    const result = await saveSelection(data, record(`turn-${i}`, `task-${i}`));
    if (i === 0) db.exec("UPDATE workflows SET state='forming';");
    if (i === 2) {
      assert.equal(result.review.requests.length, 1);
      assert.ok(result.review.requests.every(request => request.review_reason === "confirm"));
    }
  }
  assert.equal(edges(db).filter(edge => edge.workflow_id === 1).length, 3);
  assert.equal(edges(db).filter(edge => edge.workflow_id === 2).length, 0);
  await store.cancelOpenDispatches(NOW);
  db.exec("UPDATE workflows SET state='confirmed',suppression='permanent';");
  await saveSelection(data, record("turn-suppressed", "task-new"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE state='pending'").get().n, 0);
});

test("a retained confirmed prototype from an older version cannot count threshold work before v3 evidence review", async t => {
  const data = await fixture(t, 1);
  for (let index = 0; index < 2; index++) await saveSelection(data, data.record(`prior-${index}`, `prior-task-${index}`));
  data.db.exec("UPDATE workflows SET prototype_version=1 WHERE id=1");
  const plan = await data.store.prepareDecisionMatch(data.record(), controls);
  const result = await data.store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: [1] }, controls);
  assert.equal(result.review.payload.requests[0].review_reason, "confirm");
  assert.equal(result.review.payload.requests[0].scan.phase, "final");
  assert.equal(edges(data.db).length, 2, "old confirmation cannot authorize the proposed third contribution");
  assert.equal(data.db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE state='pending'").get().n, 0);
  assert.equal(await finishReview(data.store, result.review.payload, 1), true);
  assert.equal(edges(data.db).length, 3);
  assert.equal(data.db.prepare("SELECT prototype_version FROM workflows WHERE id=1").get().prototype_version, 3);
});

test("recommendations off cannot count a forming candidate before its final evidence review", async t => {
  const data=await fixture(t,1);
  for(let index=0;index<2;index++) await saveSelection(data,data.record(`prior-${index}`,`prior-task-${index}`));
  data.db.exec("UPDATE workflows SET state='forming' WHERE id=1");
  const disabled=async()=>({detectionEnabled:true,recommendationEnabled:false});
  const plan=await data.store.prepareDecisionMatch(data.record(),disabled);
  const result=await data.store.finalizeDecisionMatch(plan.token,{source:"decision_model",matchedWorkflowIds:[1]},disabled);
  assert.equal(result.review.payload.requests[0].scan.phase,"final");
  assert.equal(result.review.payload.requests[0].review_reason,"match");
  assert.equal(edges(data.db).length,2,"proposed evidence must wait even when recommendations are off");
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
  const changedPace = await data.engine.control({ command: "set_recommendation_pace", pace: "cautious" });
  outputs.push(changedPace);
  assert.equal(changedPace.status, "ok");
  assert.equal(changedPace.summary.recommendation_pace, "cautious");
  assert.equal((await openConfigStore(data.root, data.now)).readConfig().recommendation_pace, "cautious");
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
  assert.equal(result.status, "review_required");
  assert.equal(result.matching_source, "decision_model");
  assert.equal(calls, 1);
  assert.deepEqual(catalogIds(result), [2, 1]);
  assert.deepEqual(edges(data.db), []);
  assert.equal((await finishReview(data.engine, result, 2)).status, "accepted");
  assert.deepEqual(edges(data.db), [{ workflow_id: 2, episode_id: 1 }]);
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
  for (let i = 0; i < 2; i++) {
    await saveSelection(data, data.record(`turn-${i}`, `task-${i}`));
    if (i === 0) data.db.exec("UPDATE workflows SET state='forming' WHERE id=1;");
  }
  const plan = await data.store.prepareDecisionMatch(data.record("turn-2", "task-2"), controls);
  data.result = await data.store.finalizeDecisionMatch(plan.token,
    { source: "decision_model", matchedWorkflowIds: [1], runnerUpWorkflowId: 2 }, controls);
  return data;
}

test("final confirmation counts only the selected workflow and allows one search claim per turn", async t => {
  const { store, db, result } = await confirmationFixture(t);
  assert.equal(edges(db).length, 2, "confirmation has not added its proposed evidence");
  assert.equal(result.review.payload.requests[0].review_reason, "confirm");
  assert.equal(await finishReview(store, result.review.payload, 1), true);
  assert.deepEqual(db.prepare("SELECT state FROM workflows ORDER BY id").all().map(row => row.state), ["confirmed", "confirmed"]);
  assert.deepEqual(edges(db), [1, 2, 3].map(episode_id => ({ workflow_id: 1, episode_id })));
  const first = await store.claimDispatch({ codexTaskId: "task-2", turnId: "turn-2", cwd: "E:/fixture/workspace", claimedAt: NOW });
  assert.ok(first);
  assert.equal(first.workflow_id, 1);
  assert.equal(await store.claimDispatch({ codexTaskId: "task-2", turnId: "turn-2", cwd: "E:/fixture/workspace", claimedAt: NOW }), undefined);
});

test("uncertain confirmation preserves established evidence without counting the proposed work", async t => {
  const { store, db, result } = await confirmationFixture(t);
  const before = edges(db);
  assert.equal(await reviewStep(store, result.review.payload, undefined, "uncertain"), false);
  assert.deepEqual(edges(db), before);
  assert.equal(db.prepare("SELECT state FROM workflows WHERE id=1").get().state, "forming");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dispatches").get().n, 0);
});

test("a changed candidate restarts confirmation as a full main-model scan", async t => {
  const { store, db, result } = await confirmationFixture(t);
  db.prepare("UPDATE workflows SET cooldown_until=? WHERE id=1").run(NOW + 1000);
  const refreshed = await store.refreshReview(result.review.review_set_id, controls);
  assert.equal(refreshed.status, "review_required");
  assert.equal(refreshed.matching_source, "main_model_fallback");
  assert.deepEqual(catalogIds(refreshed), [1, 2]);
  assert.equal(refreshed.requests[0].scan.phase, "scan");
  assert.notEqual(refreshed.review_set_id, result.review.review_set_id);
  assert.equal(edges(db).length, 2);
});

test("refresh includes newly eligible later candidates and can select one beyond the first batch", async t => {
  const { store, db, result } = await confirmationFixture(t);
  for (let i = 0; i < 5; i++) db.prepare(`INSERT INTO workflows
    (scope_kind,scope_value,state,prototype_json,prototype_version,representatives_json,last_seen_at,suppression,created_at,updated_at)
    VALUES('global',NULL,'confirmed',?,3,'[]',?,'none',?,?)`).run(JSON.stringify(prototype), NOW, NOW, NOW);
  const refreshed = await store.refreshReview(result.review.review_set_id, controls);
  assert.equal(refreshed.status, "review_required");
  assert.deepEqual(catalogIds(refreshed), [1, 2, 3, 4, 5]);
  assert.equal(refreshed.requests[0].scan.total, 7);
  assert.equal(await finishReview(store, refreshed, 7), true);
  assert.equal(edges(db).filter(edge => edge.workflow_id === 7).length, 1);
  assert.equal(edges(db).filter(edge => edge.workflow_id === 1).length, 2);
});

test("host fallback compares its tentative winner with later candidates before one final commit", async t => {
  const { store, db, record } = await fixture(t, 7);
  const plan = await store.prepareDecisionMatch(record(), controls);
  const result = await store.finalizeDecisionMatch(plan.token, { source: "main_model_fallback" }, controls);
  const first = result.review.payload;
  const second = await reviewStep(store, first, 2);
  assert.equal(second.status, "review_required");
  assert.deepEqual(catalogIds(second), [2, 6, 7]);
  assert.deepEqual(edges(db), []);
  const final = await reviewStep(store, second, 7);
  assert.equal(final.status, "review_required");
  assert.equal(final.requests[0].scan.phase, "final");
  assert.deepEqual(catalogIds(final), [7]);
  assert.deepEqual(edges(db), []);
  assert.equal(await reviewStep(store, final, 7), true);
  assert.deepEqual(edges(db), [{ workflow_id: 7, episode_id: 1 }]);
});

test("duplicate intermediate review requests cannot skip a batch or count a provisional winner", async t => {
  const { store, db, record } = await fixture(t, 7);
  const plan = await store.prepareDecisionMatch(record(), controls);
  const result = await store.finalizeDecisionMatch(plan.token, { source: "main_model_fallback" }, controls);
  const first = result.review.payload;
  const request = first.requests[0];
  await loadEvidence(store, first, 1);
  const input = { ...first.review_call, review_set_id: first.review_set_id, decisions: [{ request_id: request.request_id,
    kind: "capability", review_reason: request.review_reason, verdict: "same", selected_workflow_id: 1 }] };
  const results = await Promise.all([store.resolveReview(input, controls), store.resolveReview(input, controls)]);
  const next = results.filter(result => result?.status === "review_required");
  assert.equal(next.length, 1);
  assert.deepEqual(catalogIds(next[0]), [1, 6, 7]);
  assert.deepEqual(edges(db), []);
  assert.equal(await finishReview(store, next[0], 7), true);
  assert.deepEqual(edges(db), [{ workflow_id: 7, episode_id: 1 }]);
  assert.equal(await store.resolveReview(input, controls), false);
  assert.deepEqual(edges(db), [{ workflow_id: 7, episode_id: 1 }]);
});

test("Sqwish scans later batches once and carries the global top two into final evidence review", async t => {
  for (const order of [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], [5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4]]) {
    const batches = [], states = [], models = [];
    const data = await engineFixture(t, async (_url, init) => {
      const body = JSON.parse(init.body);
      const ids = Object.keys(body.questions).map(id => Number(id.slice("workflow_".length)));
      batches.push(ids); states.push(body.state); models.push(body.model);
      data.db.exec("BEGIN IMMEDIATE; ROLLBACK;");
      return response(Object.fromEntries(ids.map(id => [`workflow_${id}`, noul(order[id - 1] / 12)])));
    }, { existence: null }, 12);
    for (const [index, rank] of order.entries()) data.db.prepare("UPDATE workflows SET prototype_json=? WHERE id=?")
      .run(JSON.stringify({ ...prototype, core_goal: `Reusable method ${rank}` }), index + 1);
    await data.stage();
    const result = await data.extract();
    assert.equal(result.status, "review_required");
    assert.equal(result.matching_source, "decision_model");
    const expected = order.indexOf(12) + 1, runner = order.indexOf(11) + 1;
    assert.deepEqual(catalogIds(result), [expected, runner]);
    assert.deepEqual(batches, [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12]]);
    assert.equal(new Set(batches.flat()).size, 12);
    assert.equal(new Set(states).size, 1, "current work and rules are repeated unchanged");
    assert.deepEqual(models, ["kettei-fat", "kettei-fat", "kettei-fat"]);
    assert.deepEqual(edges(data.db), [], "no numerical winner contributes before evidence review");
    assert.equal((await finishReview(data.engine, result, expected)).status, "accepted");
    assert.deepEqual(edges(data.db), [{ workflow_id: expected, episode_id: 1 }]);
  }
});

test("main-model comparisons retain one winner across changed order and batch grouping", async t => {
  for (const order of [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], [4, 8, 2, 11, 5, 1, 7, 12, 6, 9, 3, 10]]) {
    const data = await engineFixture(t, async () => assert.fail("disabled Sqwish must stay local"), { existence: null, enabled: false }, 12);
    for (const [index, rank] of order.entries()) data.db.prepare("UPDATE workflows SET prototype_json=? WHERE id=?")
      .run(JSON.stringify({ ...prototype, core_goal: `Reusable method ${rank}` }), index + 1);
    await data.stage();
    let packet = await data.extract();
    const seen = new Set(), sets = new Set();
    let decisions = 0;
    while (packet.status === "review_required") {
      assert.equal(packet.matching_source, "main_model_fallback");
      assert.equal(sets.has(packet.review_set_id), false, "valid steps rotate the review set");
      sets.add(packet.review_set_id);
      const ids = catalogIds(packet);
      assert.ok(ids.length <= 5);
      for (const id of ids) seen.add(id);
      const best = ids.reduce((winner, id) => order[id - 1] > order[winner - 1] ? id : winner);
      assert.deepEqual(edges(data.db), [], "all tournament decisions remain provisional");
      packet = await reviewStep(data.engine, packet, best);
      decisions++;
      assert.ok(decisions <= 5, "bounded tournament plus final evidence");
    }
    assert.equal(packet.status, "accepted");
    assert.equal(seen.size, 12);
    assert.equal(decisions, 4);
    assert.deepEqual(edges(data.db), [{ workflow_id: order.indexOf(12) + 1, episode_id: 1 }]);
  }
});

test("the sixth candidate can win native fallback after extraction correction without spending recovery on batching", async t => {
  const data = await engineFixture(t, async () => assert.fail("native fallback"), { existence: null, enabled: false }, 11);
  await data.stage();
  const invalid = await data.engine.observeTurn({ phase: "extract", schema_version: 6, session_id: "task-1", turn_id: "turn-1",
    disposition: "analyze", items: [] });
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.retry_allowed, true);
  const first = await data.extract();
  assert.deepEqual(catalogIds(first), [1, 2, 3, 4, 5]);
  const second = await reviewStep(data.engine, first);
  assert.deepEqual(catalogIds(second), [6, 7, 8, 9, 10]);
  const third = await reviewStep(data.engine, second, 6);
  assert.deepEqual(catalogIds(third), [6, 11]);
  const final = await reviewStep(data.engine, third, 6);
  assert.equal(final.requests[0].scan.phase, "final");
  assert.deepEqual(edges(data.db), []);
  assert.equal((await reviewStep(data.engine, final, 6)).status, "accepted");
  assert.deepEqual(edges(data.db), [{ workflow_id: 6, episode_id: 1 }]);
});

test("only complete all-negative scans create a new workflow on either matching path", async t => {
  for (const numeric of [true, false]) {
    const calls = [];
    const data = await engineFixture(t, async (_url, init) => {
      const ids = Object.keys(JSON.parse(init.body).questions);
      calls.push(ids);
      return response(Object.fromEntries(ids.map(id => [id, noul(0.79)])));
    }, { existence: null, enabled: numeric }, 7);
    await data.stage();
    const result = await data.extract();
    if (numeric) {
      assert.equal(result.status, "accepted");
      assert.equal(calls.flat().length, 7);
    } else {
      assert.deepEqual(edges(data.db), []);
      const second = await reviewStep(data.engine, result);
      assert.equal(second.status, "review_required");
      assert.deepEqual(catalogIds(second), [6, 7]);
      assert.deepEqual(edges(data.db), []);
      assert.equal((await reviewStep(data.engine, second)).status, "accepted");
      assert.equal(calls.length, 0);
    }
    assert.deepEqual(edges(data.db), [{ workflow_id: 8, episode_id: 1 }]);
  }
});

test("equal and near Sqwish scores require evidence and uncertain never chooses an arbitrary winner", async t => {
  for (const scores of [[0.95, 0.95], [0.801, 0.799], [0.8, 0.2]]) {
    const data = await engineFixture(t, async () => response({ workflow_1: noul(scores[0]), workflow_2: noul(scores[1]) }), { existence: null });
    await data.stage();
    const packet = await data.extract();
    assert.equal(packet.status, "review_required");
    assert.equal(packet.requests[0].scan.phase, "final");
    assert.deepEqual(catalogIds(packet), [1, 2]);
    assert.deepEqual(edges(data.db), []);
    const result = await reviewStep(data.engine, packet, undefined, "uncertain");
    assert.equal(result.status, "accepted");
    assert.equal(result.deferred[0].reason, "review_uncertain");
    assert.deepEqual(edges(data.db), []);
    assert.equal(data.db.prepare("SELECT COUNT(*) AS n FROM workflows").get().n, 2);
  }
});

test("a failed later Sqwish batch discards its provisional maximum and restarts the full main scan", async t => {
  const batches = [];
  const data = await engineFixture(t, async (_url, init) => {
    const ids = Object.keys(JSON.parse(init.body).questions);
    batches.push(ids);
    return batches.length === 1 ? response(Object.fromEntries(ids.map(id => [id, noul(id === "workflow_1" ? 1 : 0)])))
      : new Response("unavailable", { status: 503 });
  }, { existence: null }, 7);
  await data.stage();
  const packet = await data.extract();
  assert.equal(packet.matching_source, "main_model_fallback");
  assert.deepEqual(catalogIds(packet), [1, 2, 3, 4, 5]);
  assert.equal(packet.requests[0].scan.evaluated, 0);
  assert.deepEqual(batches.map(ids => ids.length), [5, 2]);
  assert.deepEqual(edges(data.db), []);
  assert.equal((await finishReview(data.engine, packet, 7)).status, "accepted");
  assert.deepEqual(edges(data.db), [{ workflow_id: 7, episode_id: 1 }]);
});

test("the matching timeout is one absolute budget across Sqwish batches", async t => {
  let calls = 0, data;
  data = await engineFixture(t, async (_url, init) => {
    calls++;
    data.advance(calls === 1 ? 70 : 40);
    return response(Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(id => [id, noul(1)])));
  }, { existence: null, match_timeout_ms: 100 }, 7);
  await data.stage();
  const result = await data.extract();
  assert.equal(calls, 2);
  assert.equal(result.matching_source, "main_model_fallback");
  assert.equal(result.requests[0].scan.evaluated, 0);
  assert.deepEqual(edges(data.db), []);
});

test("Sqwish aggregate upload budget cannot reset when a new batch starts", async t => {
  let uploaded = 0, calls = 0;
  const data = await engineFixture(t, async (_url, init) => {
    calls++;
    uploaded += Buffer.byteLength(init.body);
    return response(Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(id => [id, noul(0)])));
  }, { existence: null, match_timeout_ms: 10_000 }, 100);
  data.db.prepare("UPDATE workflows SET prototype_json=?").run(JSON.stringify({ ...prototype, essential_steps: ["Apply the rule ".repeat(150)] }));
  await data.stage();
  const result = await data.extract();
  assert.ok(calls > 1 && calls < 20, "bounded whole scan stops before all candidates");
  assert.ok(uploaded <= 256 * 1024);
  assert.equal(result.matching_source, "main_model_fallback");
  assert.deepEqual(edges(data.db), [], "incomplete all-negative result cannot create a new workflow");
});

test("rejecting the numerical shortlist restarts every candidate through main-model comparison", async t => {
  const { store, db, record } = await fixture(t, 7);
  const plan = await store.prepareDecisionMatch(record(), controls);
  const result = await store.finalizeDecisionMatch(plan.token,
    { source: "decision_model", matchedWorkflowIds: [2], runnerUpWorkflowId: 1 }, controls);
  assert.deepEqual(catalogIds(result.review.payload), [2, 1]);
  const restarted = await reviewStep(store, result.review.payload);
  assert.equal(restarted.matching_source, "main_model_fallback");
  assert.deepEqual(catalogIds(restarted), [1, 2, 3, 4, 5]);
  assert.equal(restarted.requests[0].scan.total, 7);
  assert.deepEqual(edges(db), []);
  assert.equal(await finishReview(store, restarted, 7), true);
  assert.deepEqual(edges(db), [{ workflow_id: 7, episode_id: 1 }]);
});

test("main-model payload budget accumulates evidence reads across batch changes", async t => {
  const { store, db, record } = await fixture(t, 7);
  const plan = await store.prepareDecisionMatch(record(), controls);
  const result = await store.finalizeDecisionMatch(plan.token, { source: "main_model_fallback" }, controls);
  let packet = result.review.payload;
  let initialBytes = Buffer.byteLength(JSON.stringify(packet));
  const firstContext = { review_set_id: packet.review_set_id, request_id: packet.requests[0].request_id, workflow_id: 1 };
  while (initialBytes < 150_000) {
    const page = await store.getReviewEvidence(firstContext, controls);
    assert.equal(page.status, "ok");
    initialBytes += Buffer.byteLength(JSON.stringify(page));
  }
  packet = await reviewStep(store, packet, 1);
  assert.equal(packet.status, "review_required");
  assert.deepEqual(catalogIds(packet), [1, 6, 7]);
  const secondContext = { review_set_id: packet.review_set_id, request_id: packet.requests[0].request_id, workflow_id: 1 };
  let laterBytes = 0, exhausted;
  for (let count = 0; count < 500; count++) {
    const page = await store.getReviewEvidence(secondContext, controls);
    if (page.status === "budget_exceeded") { exhausted = page; break; }
    assert.equal(page.status, "ok");
    laterBytes += Buffer.byteLength(JSON.stringify(page));
  }
  assert.equal(exhausted?.scan_limit_bytes, 256 * 1024);
  assert.equal(exhausted.resolution, "uncertain");
  assert.ok(laterBytes < 150_000, "a new batch does not reset the total payload budget");
  assert.deepEqual(edges(db), []);
  assert.equal(await store.resolveReview({ ...packet.review_call, review_set_id: packet.review_set_id,
    decisions: [{ request_id: packet.requests[0].request_id, kind: "capability", review_reason: packet.requests[0].review_reason,
      verdict: "same", selected_workflow_id: 1 }] }, controls), false, "exhausted partial winner cannot commit");
});

test("catalog and evidence continuation pages neither skip facts nor authorize incomplete final evidence", async t => {
  const data = await fixture(t, 1);
  for (let index = 0; index < 6; index++) await saveSelection(data, data.record(`prior-${index}`, `prior-task-${index}`));
  const plan = await data.store.prepareDecisionMatch(data.record(), controls);
  const result = await data.store.finalizeDecisionMatch(plan.token, { source: "main_model_fallback" }, controls);
  const first = result.review.payload;
  const pages = await loadEvidence(data.store, first, 1, 1);
  assert.equal(pages.length, 7);
  const refs = pages.flatMap(page => page.evidence.map(row => row.evidence_ref));
  assert.equal(new Set(refs).size, 7);
  const final = await reviewStep(data.store, first, 1);
  const request = final.requests[0];
  const input = { ...final.review_call, review_set_id: final.review_set_id, decisions: [{ request_id: request.request_id,
    kind: "capability", review_reason: request.review_reason, verdict: "same", selected_workflow_id: 1 }] };
  const page = await data.store.getReviewEvidence({ review_set_id: final.review_set_id, request_id: request.request_id, workflow_id: 1, limit: 1 }, controls);
  assert.equal(page.has_more, true);
  const unfinished = await data.store.resolveReview(input, controls);
  assert.equal(unfinished.status, "review_required", "more reads remain a normal continuation");
  assert.equal(unfinished.review_set_id, final.review_set_id, "valid evidence receipts remain usable");
  assert.equal(edges(data.db).length, 6);
  assert.equal(await reviewStep(data.store, unfinished, 1), true);
  assert.equal(edges(data.db).length, 7);
});

test("losing-candidate semantics, evidence and membership remain frozen through the final commit", async t => {
  for (const change of ["semantics", "evidence", "membership"]) {
    const data = await fixture(t, 7);
    const plan = await data.store.prepareDecisionMatch(data.record(), controls);
    const result = await data.store.finalizeDecisionMatch(plan.token, { source: "main_model_fallback" }, controls);
    const second = await reviewStep(data.store, result.review.payload, 1);
    const final = await reviewStep(data.store, second, 7);
    await loadEvidence(data.store, final, 7);
    if (change === "semantics") data.db.exec("UPDATE workflows SET prototype_version=1 WHERE id=3");
    if (change === "evidence") await saveSelection(data, data.record("independent", "independent-task"), 3);
    if (change === "membership") data.db.prepare(`INSERT INTO workflows
      (scope_kind,scope_value,state,prototype_json,prototype_version,representatives_json,last_seen_at,suppression,created_at,updated_at)
      VALUES('global',NULL,'confirmed',?,3,'[]',?,'none',?,?)`).run(JSON.stringify(prototype), NOW, NOW, NOW);
    const request = final.requests[0];
    const resolved = await data.store.resolveReview({ ...final.review_call, review_set_id: final.review_set_id,
      decisions: [{ request_id: request.request_id, kind: "capability", review_reason: request.review_reason,
        verdict: "same", selected_workflow_id: 7 }] }, controls);
    assert.equal(resolved, "stale", change);
    assert.equal(edges(data.db).filter(edge => edge.workflow_id === 7).length, 0, change);
  }
});

test("review-stage cancellation, expiry and frozen configuration reject both matching paths", async t => {
  for (const numeric of [true, false]) for (const action of ["skip", "generation", "settings", "decision_cycle", "recommendations", "detection", "expiry"]) {
    const data = await engineFixture(t, async (_url, init) => response(Object.fromEntries(
      Object.keys(JSON.parse(init.body).questions).map(id => [id, noul(1)]))), { existence: null, enabled: numeric }, 7);
    await data.stage();
    const packet = await data.extract();
    assert.equal(packet.status, "review_required");
    const request = packet.requests[0];
    for (const id of catalogIds(packet)) await loadEvidence(data.engine, packet, id);
    if (action === "skip") await data.engine.control({ command: "skip_turn", session_id: "task-1", turn_id: "turn-1" });
    if (action === "generation") await data.config.updateConfig(config => ({ ...config, data_generation: config.data_generation + 1 }));
    if (action === "settings") await data.config.updateConfig(config => ({ ...config, decision_model: {
      ...config.decision_model, matching: { threshold: 0.9 } } }));
    if (action === "decision_cycle") {
      await data.config.updateConfig(config => ({ ...config, decision_model: { ...config.decision_model, enabled: !numeric } }));
      await data.config.updateConfig(config => ({ ...config, decision_model: { ...config.decision_model, enabled: numeric } }));
    }
    if (action === "recommendations") await data.engine.control({ command: "enable_recommendations" });
    if (action === "detection") await data.engine.control({ command: "disable_detection" });
    if (action === "expiry") data.advance(600_001);
    const resolved = await data.engine.observeTurn({ ...packet.review_call, review_set_id: packet.review_set_id,
      decisions: [{ request_id: request.request_id, kind: "capability", review_reason: request.review_reason,
        verdict: "same", selected_workflow_id: catalogIds(packet)[0] }] });
    assert.equal(resolved.status, "ignored", `${numeric}/${action}`);
    assert.deepEqual(edges(data.db), [], `${numeric}/${action}`);
  }
});

test("clearing a pending review invalidates every frozen batch and its late final response", async t => {
  for (const numeric of [true, false]) {
    const data = await engineFixture(t, async (_url, init) => response(Object.fromEntries(
      Object.keys(JSON.parse(init.body).questions).map(id => [id, noul(1)]))), { existence: null, enabled: numeric }, 7);
    await data.stage();
    const packet = await data.extract();
    const request = packet.requests[0];
    for (const id of catalogIds(packet)) await loadEvidence(data.engine, packet, id);
    data.db.close(); data.store.close();
    const confirmation = await data.engine.control({ command: "request_clear", session_id: "task-1" });
    const cleared = await data.engine.control({ command: "confirm_clear", session_id: "task-1", confirmation_token: confirmation.confirmation_token });
    assert.equal(cleared.status, "ok");
    assert.equal((await data.engine.observeTurn({ ...packet.review_call, review_set_id: packet.review_set_id,
      decisions: [{ request_id: request.request_id, kind: "capability", review_reason: request.review_reason,
        verdict: "same", selected_workflow_id: catalogIds(packet)[0] }] })).status, "ignored");
    const fresh = await openStorage({ filename: path.join(data.root, "scout.sqlite"), now: data.now });
    assert.equal((await fresh.getStatusCounts()).episodes, 0);
    fresh.close();
  }
});

test("evidence changes after preparation invalidate the entire original result", async t => {
  const data = await fixture(t);
  const { store, db, record } = data;
  const older = await store.prepareDecisionMatch(record(), controls);
  await saveSelection(data, record("turn-new", "task-new"));
  assert.equal(await store.finalizeDecisionMatch(older.token, { source: "decision_model", matchedWorkflowIds: [1], runnerUpWorkflowId: 2 }, controls), "stale");
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
  const result = await store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds: [1], runnerUpWorkflowId: 4 }, controls);
  assert.equal(await finishReview(store, result.review.payload, 1), true);
  assert.deepEqual(edges(db), [{ workflow_id: 1, episode_id: 1 }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dispatches").get().n, 0);
});

test("cooldown blocks new dispatches while only the final winner gains evidence", async t => {
  const data = await fixture(t);
  const { store, db, record, advance } = data;
  for (let i = 0; i < 3; i++) {
    await saveSelection(data, record(`turn-${i}`, `task-${i}`));
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE state='pending'").get().n, 1);
  await store.cancelOpenDispatches(NOW);
  db.prepare("UPDATE workflows SET cooldown_until=?").run(NOW + 1000);
  await saveSelection(data, record("turn-muted", "task-muted"));
  assert.equal(edges(db).length, 4);
  assert.equal(edges(db).filter(edge => edge.workflow_id === 2).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE state='pending'").get().n, 0);
  advance(1001);
  await saveSelection(data, record("turn-resumed", "task-resumed"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE state='pending'").get().n, 1);
});

test("clear aborts a later matching batch and no partial or late response recreates evidence", async t => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let signal, calls = 0;
  const data = await engineFixture(t, async (_url, init) => {
    calls++;
    const answers = Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(id => [id, noul(1)]));
    if (calls === 1) return response(answers);
    signal = init.signal; started.resolve();
    await release.promise; return response(answers);
  }, { existence: null }, 7);
  await data.stage();
  const extraction = data.extract();
  await started.promise;
  assert.equal(calls, 2);
  assert.deepEqual(edges(data.db), []);
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
