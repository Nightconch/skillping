import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const runtime = path.resolve(import.meta.dirname, "..");
const dist = process.env.SKILLPING_COUNTING_DIST ?? path.join(runtime, "dist");
const { openConfigStore, RECOMMENDATION_PACES } = await import(pathToFileURL(path.join(dist, "config.js")));
const { openStorage, meetsThreshold } = await import(pathToFileURL(path.join(dist, "storage.js")));
const { createScoutEngine, releaseIdleStorage } = await import(pathToFileURL(path.join(dist, "engine.js")));
const NOW = 1_792_454_400_000;
const WINDOW = 30 * 24 * 60 * 60 * 1000;
const requirements = { eager: [3, 2], balanced: [5, 3], cautious: [8, 4] };
const capability = {
  core_goal: "Implement an approved design and verify the resulting program",
  input_roles: ["Approved design", "Runnable code"], output: "Verified implementation",
  essential_steps: ["Inspect dependencies", "Implement changes", "Check expected behavior"],
  variable_slots: [], scope: "global"
};
const work = { core_goal: "Deliver the approved change", input_roles: ["Design"], output: "Working program",
  essential_steps: ["Implement", "Verify"], scope: "global" };

async function fixture(t, pace = "eager") {
  const root = await mkdtemp(path.join(tmpdir(), "skillping-counting-"));
  let now = NOW;
  const filename = path.join(root, "scout.sqlite");
  const store = await openStorage({ filename, now: () => now, recommendationPace: () => pace });
  const db = new DatabaseSync(filename);
  const engines = [];
  t.after(async () => {
    for (const engine of engines) await releaseIdleStorage(engine);
    if (db.isOpen) db.close();
    store.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()), "FIXTURE: temporary data parent");
    assert.ok(path.basename(root).startsWith("skillping-counting-"), "FIXTURE: temporary data prefix");
    await rm(root, { recursive: true, force: true });
  });
  const seed = (prototype = capability, scopeValue = null) => Number(db.prepare(`INSERT INTO workflows
    (scope_kind,scope_value,state,prototype_json,prototype_version,representatives_json,last_seen_at,suppression,created_at,updated_at)
    VALUES(?,?,'confirmed',?,3,'[]',?,'none',?,?)`)
    .run(prototype.scope, scopeValue, JSON.stringify(prototype), now, now, now).lastInsertRowid);
  seed();
  const controls = async () => ({ detectionEnabled: true, recommendationEnabled: true });
  const record = (turn, task = "task-1", overrides = {}) => ({
    codex_task_id: task, turn_id: turn, message_id: "", source: "realtime", occurred_at: now,
    expires_at: now + WINDOW, workspace_path: "E:/fixture/workspace", prompt: `Requested operation ${turn}`,
    recommendation_enabled: true, observations: [{ relation: "new", confidence: "high",
      fingerprint: work, capabilities: [{ ...capability, confidence: "high" }] }], ...overrides
  });
  const save = async (value, readControls = controls, matchedWorkflowIds = [1]) => {
    const plan = await store.prepareDecisionMatch(value, readControls);
    if (!plan) return undefined;
    const result=await store.finalizeDecisionMatch(plan.token, { source: "decision_model", matchedWorkflowIds }, readControls);
    if (plan.candidates.length>1&&result?.review) {
      const request=result.review.requests[0];
      for (const candidate of result.review.payload.requests[0].catalog.items) {
        let cursor;
        do {
          const page=await store.getReviewEvidence({review_set_id:result.review.review_set_id,request_id:request.request_id,
            workflow_id:candidate.workflow_id,...(cursor?{cursor}:{})},readControls);
          assert.equal(page.status,"ok","FIXTURE: final matching evidence readable");
          cursor=page.next_cursor;
        } while(cursor);
      }
      assert.equal(await store.resolveReview({...result.review.payload.review_call,review_set_id:result.review.review_set_id,
        decisions:[{request_id:request.request_id,kind:"capability",review_reason:request.review_reason,
          verdict:"same",selected_workflow_id:matchedWorkflowIds[0]}]},readControls),true,"FIXTURE: single attribution commits");
    }
    return result;
  };
  const pending = () => Number(db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE state='pending'").get().n);
  const cardinalities = () => db.prepare(`SELECT COUNT(DISTINCT e.id) AS episodes,
    COUNT(DISTINCT e.codex_task_id) AS tasks FROM episode_workflows ew JOIN episodes e ON e.id=ew.episode_id WHERE ew.workflow_id=1`).get();
  return { root, store, db, seed, record, save, pending, cardinalities, engines,
    now: () => now, setNow: value => { now = value; } };
}

test("pace thresholds require both independent episodes and distinct tasks", async t => {
  for (const [pace, [minEpisodes, minTasks]] of Object.entries(requirements)) {
    assert.equal(RECOMMENDATION_PACES[pace].min_occurrences, minEpisodes, "COUNT_THRESHOLDS: episode configuration");
    assert.equal(RECOMMENDATION_PACES[pace].min_chats, minTasks, "COUNT_THRESHOLDS: task configuration");
    for (let episodes = 0; episodes <= 10; episodes++) for (let tasks = 0; tasks <= episodes; tasks++) {
      assert.equal(meetsThreshold({ episode_count: episodes, task_count: tasks }, pace),
        episodes >= minEpisodes && tasks >= minTasks, `COUNT_THRESHOLDS: ${pace} ${episodes}/${tasks}`);
    }
    const data = await fixture(t, pace);
    for (let i = 0; i < minEpisodes; i++) {
      await data.save(data.record(`same-task-${i}`));
      assert.equal(data.pending(), 0, `COUNT_TASKS: ${pace} same-task occurrences cannot dispatch`);
    }
    for (let i = 1; i < minTasks; i++) {
      await data.save(data.record(`new-task-${i}`, `task-${i + 1}`));
      assert.equal(data.pending(), i === minTasks - 1 ? 1 : 0, `COUNT_TASKS: ${pace} distinct task boundary`);
    }
    const fewer = await fixture(t, pace);
    for (let i = 0; i < minEpisodes - 1; i++) await fewer.save(fewer.record(`below-${i}`, `task-${i % minTasks}`));
    assert.equal(fewer.pending(), 0, `COUNT_EPISODES: ${pace} requires its episode boundary`);
    await fewer.save(fewer.record("at-boundary", "task-0"));
    assert.equal(fewer.pending(), 1, `COUNT_EPISODES: ${pace} dispatches at both boundaries`);
  }
});

test("all paces require current v3 confirmation before forming evidence can dispatch", async t => {
  for (const [pace, [minEpisodes, minTasks]] of Object.entries(requirements)) {
    const data = await fixture(t, pace);
    let result;
    for (let i = 0; i < minEpisodes; i++) {
      result = await data.save(data.record(`confirm-${i}`, `task-${i % minTasks}`));
      if (i === 0) data.db.exec("UPDATE workflows SET state='forming' WHERE id=1");
      assert.equal(data.pending(), 0, "COUNT_CONFIRM: forming evidence cannot dispatch");
      if (i < minEpisodes - 1) assert.equal(result.review, undefined, "COUNT_CONFIRM: confirmation waits for current pace");
    }
    const request = result.review.requests[0];
    assert.equal(request.review_reason, "confirm", "COUNT_CONFIRM: threshold requires confirmation");
    const context = { review_set_id: result.review.review_set_id, request_id: request.request_id };
    const controls = async () => ({ detectionEnabled: true, recommendationEnabled: true });
    assert.equal((await data.store.getReviewEvidence(context, controls)).status, "ok", "COUNT_CONFIRM: current catalog is readable");
    assert.equal((await data.store.getReviewEvidence({ ...context, workflow_id: 1 }, controls)).status, "ok", "COUNT_CONFIRM: evidence page is readable");
    assert.equal(await data.store.resolveReview({ phase: "review", schema_version: 3,
      session_id: `task-${(minEpisodes - 1) % minTasks}`, turn_id: `confirm-${minEpisodes - 1}`,
      review_set_id: context.review_set_id, decisions: [{ request_id: request.request_id,
        kind: "capability", review_reason: "confirm", verdict: "same", selected_workflow_id: 1 }] }, controls), true,
    "COUNT_CONFIRM: current v3 review commits confirmation");
    assert.equal(data.pending(), 1, "COUNT_CONFIRM: confirmed evidence queues once");
  }
});

test("repeated submissions dedupe by turn and by normalized workspace within a task", async t => {
  const data = await fixture(t);
  const first = data.record("original", "task-a", { prompt: "Please carry out operation alpha with all supplied inputs." });
  const results = await Promise.all([data.save(first), data.save(first)]);
  assert.equal(results.filter(result => result?.created).length, 1, "COUNT_DEDUPE: simultaneous same-turn retry writes once");
  await data.save({ ...first, turn_id: "retry", workspace_path: "e:\\FIXTURE\\workspace" });
  assert.equal(Number(data.cardinalities().episodes), 1, "COUNT_DEDUPE: same text and normalized workspace do not add episodes");
  await data.save({ ...first, turn_id: "other-workspace", workspace_path: "E:/fixture/other" });
  assert.equal(Number(data.cardinalities().episodes), 2, "COUNT_DEDUPE: a different workspace is a separate request");
  await data.save({ ...first, turn_id: "other-task", codex_task_id: "task-b" });
  assert.equal(Number(data.cardinalities().episodes), 3, "COUNT_DEDUPE: another task contributes independently");
  assert.equal(Number(data.cardinalities().tasks), 2, "COUNT_DEDUPE: distinct task identity is retained");
  assert.equal(data.pending(), 1, "COUNT_DEDUPE: valid independent evidence still reaches eager threshold");
});

test("rolling counts use an open lower boundary and reject future or expired evidence", async t => {
  const boundaries = [
    { episode: -WINDOW + 1, prompt: -WINDOW + 1, expiry: 1, eligible: true },
    { episode: -WINDOW, prompt: 0, expiry: 1, eligible: false },
    { episode: 0, prompt: -WINDOW, expiry: 1, eligible: false },
    { episode: -WINDOW - 1, prompt: 0, expiry: 1, eligible: false },
    { episode: 1, prompt: 0, expiry: 1, eligible: false },
    { episode: 0, prompt: 1, expiry: 1, eligible: false },
    { episode: 0, prompt: 0, expiry: 0, eligible: false },
    { episode: 0, prompt: 0, expiry: 1, eligible: true }
  ];
  for (const [index, boundary] of boundaries.entries()) {
    const data = await fixture(t);
    for (let i = 0; i < 3; i++) await data.save(data.record(`window-${i}`, i === 0 ? "task-a" : "task-b"));
    assert.equal(data.pending(), 1, "COUNT_WINDOW: current evidence queues before aging");
    data.db.prepare("UPDATE episodes SET started_at=? WHERE id=1").run(NOW + boundary.episode);
    data.db.prepare("UPDATE prompts SET occurred_at=?,expires_at=? WHERE id=1").run(NOW + boundary.prompt, NOW + boundary.expiry);
    data.db.prepare(`INSERT INTO prompts
      (codex_task_id,turn_id,message_id,source,occurred_at,expires_at,workspace_path,body)
      VALUES('cleanup-sentinel','expired','','realtime',?,?,'E:/fixture/workspace','Expired fixture')`).run(NOW - WINDOW - 1, NOW - 1);
    data.db.exec(`CREATE TRIGGER retain_expired_fixture BEFORE DELETE ON prompts
      BEGIN SELECT RAISE(ABORT,'fixture-retains-expired-evidence'); END;`);
    const claim = await data.store.claimDispatch({ codexTaskId: "task-b", turnId: "window-2",
      cwd: "E:/fixture/workspace", claimedAt: NOW, recommendation: "web" });
    assert.equal(!!claim, boundary.eligible, `COUNT_WINDOW: boundary ${index} ${JSON.stringify(boundary)}`);
    if (claim) assert.equal(claim.confirmation_episode_count, 3, "COUNT_WINDOW: accepted count includes only current evidence");
  }
});

test("global evidence crosses projects while project evidence stays in its normalized scope", async t => {
  const data = await fixture(t);
  const project = { ...capability, scope: "project" };
  data.seed(project, "e:/fixture/workspace");
  data.seed(project, "e:/fixture/other");
  const globalPlan = await data.store.prepareDecisionMatch(data.record("global"), async () => ({ detectionEnabled: true, recommendationEnabled: true }));
  assert.deepEqual(globalPlan.candidates.map(item => item.workflow_id), [1], "COUNT_SCOPE: global candidate scope");
  for (const [cwd, expected] of [["E:\\FIXTURE\\workspace", [2]], ["e:/fixture/other", [3]], [undefined, []]]) {
    const value = data.record(`project-${expected}`, "task-a", { workspace_path: cwd,
      observations: [{ relation: "new", confidence: "high", fingerprint: { ...work, scope: "project" },
        capabilities: [{ ...project, confidence: "high" }] }] });
    const plan = await data.store.prepareDecisionMatch(value, async () => ({ detectionEnabled: true, recommendationEnabled: true }));
    assert.deepEqual(plan.candidates.map(item => item.workflow_id), expected, "COUNT_SCOPE: project candidates require normalized matching workspace");
  }
  for (let i = 0; i < 3; i++) await data.save(data.record(`global-${i}`, `task-${i % 2}`, { workspace_path: `E:/project-${i}` }));
  assert.equal(data.pending(), 1, "COUNT_SCOPE: global evidence aggregates across projects");
  const isolated = await fixture(t);
  isolated.db.prepare("UPDATE workflows SET scope_kind='project',scope_value=?,prototype_json=? WHERE id=1")
    .run("e:/fixture/workspace", JSON.stringify(project));
  for (let i = 0; i < 3; i++) await isolated.save(isolated.record(`project-hit-${i}`, `task-${i % 2}`, {
    workspace_path: i % 2 ? "e:\\FIXTURE\\workspace" : "E:/fixture/workspace",
    observations: [{ relation: "new", confidence: "high", fingerprint: { ...work, scope: "project" },
      capabilities: [{ ...project, confidence: "high" }] }]
  }));
  assert.equal(isolated.pending(), 1, "COUNT_SCOPE: aliases contribute to one project workflow");
  assert.equal(await isolated.store.claimDispatch({ codexTaskId: "task-0", turnId: "project-hit-2", cwd: "E:/unrelated", claimedAt: NOW, recommendation: "web" }), undefined,
    "COUNT_SCOPE: project claim cannot cross workspace");
  assert.ok(await isolated.store.claimDispatch({ codexTaskId: "task-0", turnId: "project-hit-2", cwd: "E:\\FIXTURE\\workspace", claimedAt: NOW, recommendation: "web" }),
    "COUNT_SCOPE: project claim accepts normalized alias");
});

async function engineFixture(t, settings = {}) {
  const data = await fixture(t);
  const config = await openConfigStore(data.root, data.now);
  await config.updateConfig(current => ({ ...current, recommendation_pace: "eager", ...settings }));
  const engine = await createScoutEngine({ pluginRoot: runtime, dataDir: data.root, now: data.now, spawnProcess: spawn,
    fetch: async () => assert.fail("COUNT_OFFLINE: default checks cannot call an online model") });
  data.engines.push(engine);
  const stage = (task, turn, prompt = `Implement requested work ${turn} with verification.`) => engine.stagePrompt({
    session_id: task, turn_id: turn, prompt, cwd: "E:/fixture/workspace", model: "host-model"
  });
  const extract = (task, turn) => ({ phase: "extract", schema_version: 6, session_id: task, turn_id: turn,
    disposition: "analyze", items: [{ core_goal: work.core_goal, input_roles: work.input_roles,
      output: work.output, essential_steps: work.essential_steps, scope_hint: "global", confidence: "high",
      capabilities: [{ ...capability, confidence: "high" }] }] });
  const observe=engine.observeTurn.bind(engine);
  engine.observeTurn=async input=>{
    let result=await observe(input);
    for(let step=0;result.status==="review_required"&&step<10;step++) {
      const request=result.requests[0];
      for(const candidate of request.catalog.items) {
        let cursor;
        do {
          const page=await engine.getReviewEvidence({review_set_id:result.review_set_id,request_id:request.request_id,
            workflow_id:candidate.workflow_id,...(cursor?{cursor}:{})});
          assert.equal(page.status,"ok","FIXTURE: main model evidence is readable");
          cursor=page.next_cursor;
        } while(cursor);
      }
      result=await observe({...result.review_call,review_set_id:result.review_set_id,decisions:[{
        request_id:request.request_id,kind:"capability",review_reason:request.review_reason,verdict:"same",selected_workflow_id:1}]});
    }
    return result;
  };
  return { ...data, config, engine, stage, extract };
}

test("workflow feedback requires bound references and preserves stronger restrictions and evidence", async t => {
  const data = await engineFixture(t);
  const second = data.seed();
  for (const [workflowId, prefix] of [[1, "bound"], [second, "other"]]) {
    for (let i = 0; i < 3; i++) await data.save(data.record(`${prefix}-${i}`, `${prefix}-task-${i % 2}`), undefined, [workflowId]);
  }
  await data.save(data.record("ambiguous", "ambiguous-task"));
  // Retained pre-v6 multi-attribution still makes an unbound feedback reference ambiguous.
  data.db.prepare(`INSERT INTO episode_workflows SELECT episode_id,?,observation_id,capability_json,relevance_order
    FROM episode_workflows WHERE observation_id=(SELECT MAX(id) FROM observations)`).run(second);
  const tables = ["workflows", "dispatches", "prompts", "observations", "episodes", "episode_workflows"];
  const snapshot = () => tables.map(table => data.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());
  const workflow = () => data.db.prepare("SELECT * FROM workflows WHERE id=1").get();
  const secondDispatch = data.db.prepare("SELECT id FROM dispatches WHERE workflow_id=?").get(second).id;
  const original = snapshot();
  const commands = ["cooldown_workflow", "suppress_workflow", "invalidate_workflow", "cover_workflow", "reopen_covered_workflow"];
  const invalidReferences = [
    { session_id: "missing-task" },
    { session_id: "bound-task-0", workflow_id: second + 1000 },
    { session_id: "other-task-0", workflow_id: 1 },
    { session_id: "ambiguous-task" },
    { session_id: "bound-task-0", dispatch_id: secondDispatch },
    { session_id: "bound-task-0", dispatch_id: secondDispatch + 1000 }
  ];
  for (const command of commands) for (const reference of invalidReferences) {
    assert.equal((await data.engine.control({ command, ...reference })).status, "needs_context", "COUNT_FEEDBACK: unbound reference rejects");
    assert.deepEqual(snapshot(), original, "COUNT_FEEDBACK: rejected feedback leaves workflows, dispatches and evidence unchanged");
  }
  const reference = { session_id: "bound-task-0", workflow_id: 1 };
  assert.equal((await data.engine.control({ command: "cooldown_workflow", ...reference })).status, "ok", "COUNT_FEEDBACK: bound cooldown succeeds");
  const cooldown = NOW + WINDOW;
  assert.equal(workflow().cooldown_until, cooldown, "COUNT_FEEDBACK: cooldown lasts thirty days");
  assert.equal((await data.engine.control({ command: "cover_workflow", ...reference })).status, "ok", "COUNT_FEEDBACK: bound cover succeeds");
  assert.equal(workflow().suppression, "permanent", "COUNT_FEEDBACK: coverage suspends recommendations");
  assert.equal(workflow().suppression_reason, "covered", "COUNT_FEEDBACK: coverage records its reason");
  assert.equal((await data.engine.control({ command: "reopen_covered_workflow", ...reference })).status, "ok", "COUNT_FEEDBACK: bound reopen succeeds");
  assert.equal(workflow().suppression, "none", "COUNT_FEEDBACK: reopen removes coverage suspension");
  assert.equal(workflow().suppression_reason, null, "COUNT_FEEDBACK: reopen clears coverage reason");
  assert.equal(workflow().cooldown_until, cooldown, "COUNT_FEEDBACK: reopening coverage retains active cooldown");
  await data.save(data.record("after-reopen", "bound-task-0"));
  assert.equal(data.pending(), 1, "COUNT_FEEDBACK: retained cooldown blocks new dispatch for reopened workflow");
  assert.equal((await data.engine.control({ command: "suppress_workflow", ...reference })).status, "ok", "COUNT_FEEDBACK: bound refusal succeeds");
  const refused = workflow();
  assert.equal(refused.suppression, "permanent", "COUNT_FEEDBACK: explicit refusal suspends recommendations");
  assert.equal(refused.suppression_reason, "user", "COUNT_FEEDBACK: explicit refusal records its stronger reason");
  for (const command of ["cover_workflow", "reopen_covered_workflow"]) {
    assert.equal((await data.engine.control({ command, ...reference })).status, "ok", "COUNT_FEEDBACK: covered commands acknowledge existing refusal");
    assert.deepEqual(workflow(), refused, "COUNT_FEEDBACK: cover and reopen retain explicit user refusal");
  }
  const claim = await data.store.claimDispatch({ codexTaskId: "other-task-0", turnId: "other-0",
    cwd: "E:/fixture/workspace", claimedAt: NOW, recommendation: "web" });
  assert.equal(claim?.workflow_id, second, "COUNT_FEEDBACK: second workflow has an open dispatch");
  assert.equal(data.db.prepare("SELECT state FROM dispatches WHERE id=?").get(claim.id).state, "dispatching", "COUNT_FEEDBACK: dispatch is claimed before invalidation");
  const evidence = snapshot().slice(2);
  assert.equal((await data.engine.control({ command: "invalidate_workflow", session_id: "other-task-0", dispatch_id: claim.id })).status, "ok",
    "COUNT_FEEDBACK: bound dispatch reference invalidates its workflow");
  assert.equal(data.db.prepare("SELECT state FROM workflows WHERE id=?").get(second).state, "invalidated", "COUNT_FEEDBACK: invalidation persists");
  assert.equal(data.db.prepare("SELECT state FROM dispatches WHERE id=?").get(claim.id).state, "cancelled", "COUNT_FEEDBACK: invalidation cancels an open dispatch");
  assert.deepEqual(snapshot().slice(2), evidence, "COUNT_FEEDBACK: invalidation retains observed evidence");
});

test("current v6 skip and one corrected extraction cannot inflate episode counts", async t => {
  const data = await engineFixture(t);
  await data.stage("task-a", "first");
  const invalid = data.extract("task-a", "first");
  delete invalid.items[0].output;
  const rejected = await data.engine.observeTurn(invalid);
  assert.equal(rejected.status, "invalid", "COUNT_V6: malformed extract is rejected");
  assert.equal(rejected.retry_allowed, true, "COUNT_V6: first correction is allowed");
  assert.equal((await data.engine.observeTurn(data.extract("task-a", "first"))).status, "accepted", "COUNT_V6: corrected extraction is accepted");
  assert.equal((await data.engine.observeTurn(data.extract("task-a", "first"))).status, "ignored", "COUNT_V6: repeated accepted extract is ignored");
  for (let i = 0; i < 5; i++) {
    const turn = `follow-up-${i}`;
    await data.stage("task-a", turn, `Continue work and adjust presentation ${i}.`);
    assert.equal((await data.engine.observeTurn({ phase: "extract", schema_version: 6,
      session_id: "task-a", turn_id: turn, disposition: "skip", items: [] })).status, "accepted", "COUNT_V6: continuation skips persist no work");
  }
  assert.equal(Number(data.cardinalities().episodes), 1, "COUNT_V6: corrected retry and continuations keep one episode");
  assert.equal(Number(data.db.prepare("SELECT COUNT(*) AS n FROM prompts").get().n), 1, "COUNT_V6: skip payloads do not persist prompts");
});

test("both switches gate counting and dispatch independently through current v6", async t => {
  for (const detection_enabled of [false, true]) for (const recommendation_enabled of [false, true]) {
    const data = await engineFixture(t, { detection_enabled, recommendation_enabled });
    for (let i = 0; i < 3; i++) {
      const task = `switch-task-${i % 2}`, turn = `switch-${i}`;
      const staged = await data.stage(task, turn);
      assert.equal(!!staged.hookSpecificOutput, detection_enabled, "COUNT_SWITCHES: detection gates extraction instructions");
      const result = await data.engine.observeTurn(data.extract(task, turn));
      assert.equal(result.status, detection_enabled ? "accepted" : "ignored", "COUNT_SWITCHES: detection gates observation writes");
    }
    assert.equal(Number(data.cardinalities().episodes), detection_enabled ? 3 : 0, "COUNT_SWITCHES: recommendation off retains counted evidence");
    assert.equal(data.pending(), detection_enabled && recommendation_enabled ? 1 : 0, "COUNT_SWITCHES: both switches required to queue");
    const fresh = (await openConfigStore(data.root, data.now)).readConfig();
    assert.equal(fresh.detection_enabled, detection_enabled, "COUNT_SWITCHES: detection preference survives fresh store");
    assert.equal(fresh.recommendation_enabled, recommendation_enabled, "COUNT_SWITCHES: recommendation preference survives fresh store");
  }
});

test("current v6 uses each configured pace for real dispatch eligibility", async t => {
  for (const [pace, [minEpisodes, minTasks]] of Object.entries(requirements)) {
    const data = await engineFixture(t, { recommendation_pace: pace });
    for (let i = 0; i < minEpisodes; i++) {
      const task = `pace-task-${i % minTasks}`, turn = `pace-${i}`;
      await data.stage(task, turn);
      assert.equal((await data.engine.observeTurn(data.extract(task, turn))).status, "accepted", "COUNT_PACE_RUNTIME: current extract accepted");
      assert.equal(data.pending(), i === minEpisodes - 1 ? 1 : 0, `COUNT_PACE_RUNTIME: ${pace} queues at its configured threshold`);
    }
  }
});

test("switch commands preserve counts and require new eligible work after reopening", async t => {
  const data = await engineFixture(t, { recommendation_enabled: false });
  for (let i = 0; i < 3; i++) {
    await data.stage(`task-${i % 2}`, `disabled-${i}`);
    assert.equal((await data.engine.observeTurn(data.extract(`task-${i % 2}`, `disabled-${i}`))).status, "accepted", "COUNT_REOPEN: disabled recommendations still count");
  }
  assert.equal(data.pending(), 0, "COUNT_REOPEN: recommendation off does not queue");
  assert.equal((await data.engine.control({ command: "enable_recommendations" })).status, "ok", "COUNT_REOPEN: recommendation command succeeds");
  assert.equal(data.pending(), 0, "COUNT_REOPEN: enabling does not dispatch past evidence immediately");
  await data.stage("task-a", "after-reopen");
  await data.engine.observeTurn(data.extract("task-a", "after-reopen"));
  assert.equal(data.pending(), 1, "COUNT_REOPEN: new independent work can queue retained evidence");
  const closedRecommendation = await data.engine.control({ command: "disable_recommendations" });
  assert.equal(closedRecommendation.status, "ok", "COUNT_REOPEN: recommendation disable succeeds");
  assert.equal(closedRecommendation.summary.detection_enabled, true, "COUNT_REOPEN: recommendation toggle retains detection");
  assert.equal(data.pending(), 0, "COUNT_REOPEN: disabling cancels pending dispatch");
  await data.engine.control({ command: "enable_recommendations" });
  await data.stage("task-a", "before-detection-close");
  const closedDetection = await data.engine.control({ command: "disable_detection" });
  assert.equal(closedDetection.status, "ok", "COUNT_REOPEN: detection disable succeeds");
  assert.equal(closedDetection.summary.recommendation_enabled, true, "COUNT_REOPEN: detection toggle retains recommendation preference");
  assert.equal((await data.engine.observeTurn(data.extract("task-a", "before-detection-close"))).status, "ignored", "COUNT_REOPEN: disable discards staged work");
  assert.equal(Number(data.cardinalities().episodes), 4, "COUNT_REOPEN: disabled staged work adds no episode");
  const persisted = (await openConfigStore(data.root, data.now)).readConfig();
  assert.equal(persisted.detection_enabled, false, "COUNT_REOPEN: detection command persists");
  assert.equal(persisted.recommendation_enabled, true, "COUNT_REOPEN: recommendation command persists");
  assert.equal((await data.engine.control({ command: "enable_detection" })).status, "ok", "COUNT_REOPEN: detection reopens");
  assert.equal(data.pending(), 0, "COUNT_REOPEN: enabling detection does not revive cancelled dispatch");
  await data.stage("task-a", "fresh-detection-work");
  await data.engine.observeTurn(data.extract("task-a", "fresh-detection-work"));
  assert.equal(data.pending(), 1, "COUNT_REOPEN: new eligible work queues after detection reopening");
});

test("pace commands persist all three behaviors for a fresh engine", async t => {
  const data = await engineFixture(t);
  for (const pace of Object.keys(requirements)) {
    const result = await data.engine.control({ command: "set_recommendation_pace", pace });
    assert.equal(result.status, "ok", "COUNT_PACE_CONTROL: current command succeeds");
    assert.equal(result.summary.recommendation_pace, pace, "COUNT_PACE_CONTROL: returned summary matches pace");
    const freshConfig = await openConfigStore(data.root, data.now);
    assert.equal(freshConfig.readConfig().recommendation_pace, pace, "COUNT_PACE_CONTROL: fresh store reads persisted pace");
    assert.equal(JSON.parse(await readFile(path.join(data.root, "config.json"), "utf8")).recommendation_pace, pace,
      "COUNT_PACE_CONTROL: disk stores requested pace");
  }
  await releaseIdleStorage(data.engine);
  const freshEngine = await createScoutEngine({ pluginRoot: runtime, dataDir: data.root, now: data.now, spawnProcess: spawn });
  data.engines.push(freshEngine);
  const status = await freshEngine.control({ command: "status" });
  assert.equal(status.summary.recommendation_pace, "cautious", "COUNT_PACE_CONTROL: fresh engine uses persisted setting");
});
