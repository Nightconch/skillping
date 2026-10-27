import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execute = promisify(execFile);
const here = import.meta.dirname;
const runtime = path.resolve(here, "../..");
const buildRoot = await realpath(process.argv[2]);
const workRoot = await realpath(path.join(here, ".work"));
assert.ok(!path.relative(workRoot, buildRoot).startsWith("..") && buildRoot !== workRoot, "FIXTURE: isolated build path");
const configModule = path.join(buildRoot, "dist/config.js");
const { openConfigStore } = await import(pathToFileURL(configModule).href);
const { createScoutEngine, releaseIdleStorage } = await import(pathToFileURL(path.join(buildRoot, "dist/engine.js")).href);
const { openStorage } = await import(pathToFileURL(path.join(buildRoot, "dist/storage.js")).href);
const scenario = process.argv[3];
const events = [];
const NOW = 1_792_454_400_000;
const exists = file => stat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const record = (action, observed = {}) => events.push({ action, ...observed });
function invariant(rule, condition, observed) {
  record(rule, observed);
  if (!condition) {
    const error = new assert.AssertionError({ message: rule, actual: observed, expected: "business invariant holds", operator: "invariant" });
    error.rule = rule;
    throw error;
  }
}

async function fixture({ settings = false, fetch } = {}) {
  const root = await mkdtemp(path.join(buildRoot, "data-"));
  let clock = NOW;
  const now = () => clock;
  const config = await openConfigStore(root, now);
  await config.updateConfig(current => ({ ...current, detection_enabled: !settings,
    recommendation_enabled: false, recommendation_pace: "cautious", intro_seen: true,
    decision_model: { ...current.decision_model, api_key: "verification-key-sentinel",
      existence: { threshold: 0.73 }, matching: { threshold: 0.61 } } }));
  const store = await openStorage({ filename: path.join(root, "scout.sqlite"), now });
  store.close();
  await writeFile(path.join(root, "key.dpapi"), "local-data-key-sentinel");
  const engine = await createScoutEngine({ pluginRoot: runtime, dataDir: root, now, spawnProcess: spawn,
    fetch: fetch ?? (async () => { throw new Error("FIXTURE: network not allowed"); }) });
  record("fixture-created", { generation: config.readConfig().data_generation });
  return { root, config, engine, now, setNow: value => { clock = value; } };
}

const request = data => data.engine.control({ command: "request_clear", session_id: "session-A" });
async function confirm(data, token, session = "session-A") {
  const result = await data.engine.control({ command: "confirm_clear", session_id: session, confirmation_token: token });
  record("confirm-result", { session, status: result.status });
  return result;
}
async function clear(data) {
  const issued = await request(data);
  assert.equal(issued.status, "confirmation_required", "FIXTURE: confirmation issued");
  return confirm(data, issued.confirmation_token);
}
const retained = config => ({ detection_enabled: config.detection_enabled,
  recommendation_enabled: config.recommendation_enabled, recommendation_pace: config.recommendation_pace,
  intro_seen: config.intro_seen, decision_model: config.decision_model });

async function authorization() {
  const data = await fixture();
  try {
    const missing = await data.engine.control({ command: "confirm_clear", session_id: "session-A" });
    invariant("AUTHORIZATION", missing.status === "needs_context" && await exists(path.join(data.root, "scout.sqlite")),
      { case: "missing-confirmation", status: missing.status });
    let issued = await request(data);
    const wrongSession = await confirm(data, issued.confirmation_token, "session-B");
    invariant("AUTHORIZATION", wrongSession.status === "needs_context" && await exists(path.join(data.root, "scout.sqlite")),
      { case: "wrong-session", status: wrongSession.status, databaseExists: await exists(path.join(data.root, "scout.sqlite")) });
    const wrongToken = await confirm(data, "0".repeat(64));
    invariant("AUTHORIZATION", wrongToken.status === "needs_context", { case: "wrong-token", status: wrongToken.status });
    const prior = issued;
    issued = await request(data);
    const replaced = await confirm(data, prior.confirmation_token);
    invariant("AUTHORIZATION", replaced.status === "needs_context", { case: "replaced-token", status: replaced.status });
    data.setNow(issued.expires_at);
    const expired = await confirm(data, issued.confirmation_token);
    invariant("AUTHORIZATION", expired.status === "needs_context" && await exists(path.join(data.root, "key.dpapi")),
      { case: "expiry-equality", status: expired.status });
    data.setNow(issued.expires_at + 1);
    issued = await request(data);
    const success = await confirm(data, issued.confirmation_token);
    invariant("AUTHORIZATION", success.status === "ok", { case: "valid-token", status: success.status });
    const reused = await confirm(data, issued.confirmation_token);
    invariant("AUTHORIZATION", reused.status === "needs_context", { case: "reused-token", status: reused.status });
  } finally { await releaseIdleStorage(data.engine); }
}

async function retention() {
  const data = await fixture({ settings: true });
  try {
    const before = retained(data.config.readConfig());
    for (const name of ["import-progress.json", "diagnostics.log", "diagnostics.log.1"]) await writeFile(path.join(data.root, name), "old-evidence");
    await mkdir(path.join(data.root, "history-worker-fixture"));
    await writeFile(path.join(data.root, "history-worker-fixture", "schema.json"), "{}");
    await writeFile(path.join(data.root, "history-worker-fixture", "output.json"), "{}");
    const result = await clear(data);
    const config = await data.config.refreshConfig();
    const remaining = (await readdir(data.root)).filter(name => /^(scout\.sqlite|key\.dpapi|history-worker-|import-progress\.json|diagnostics\.log)/u.test(name));
    invariant("SETTINGS_RETAINED", result.status === "ok" && JSON.stringify(retained(config)) === JSON.stringify(before),
      { status: result.status, settingsEqual: JSON.stringify(retained(config)) === JSON.stringify(before) });
    invariant("NO_STALE_WRITE", config.data_generation === 1 && config.clear_pending === false && remaining.length === 0,
      { case: "success-postconditions", generation: config.data_generation, pending: config.clear_pending, remaining });
  } finally { await releaseIdleStorage(data.engine); }
}

async function oldGeneration() {
  const data = await fixture();
  try {
    const generation = data.config.readConfig().data_generation;
    assert.equal((await clear(data)).status, "ok", "FIXTURE: clear succeeds");
    let entered = false;
    let code;
    try {
      await data.config.withDataAccess(generation, async () => {
        entered = true;
        const store = await openStorage({ filename: path.join(data.root, "scout.sqlite"), now: data.now });
        const db = new DatabaseSync(path.join(data.root, "scout.sqlite"));
        db.exec("CREATE TABLE old_generation_probe(value TEXT); INSERT INTO old_generation_probe VALUES('old-evidence')");
        db.close();
        store.close();
      });
    } catch (error) { code = error.message; }
    invariant("NO_STALE_WRITE", !entered && code === "DATA_GENERATION_CHANGED" && !await exists(path.join(data.root, "scout.sqlite")),
      { generation, callbackEntered: entered, error: code ?? null, databaseRecreated: await exists(path.join(data.root, "scout.sqlite")) });
  } finally { await releaseIdleStorage(data.engine); }
}

async function partialFailure() {
  const data = await fixture();
  try {
    await rm(path.join(data.root, "key.dpapi"));
    await mkdir(path.join(data.root, "key.dpapi"));
    const result = await clear(data);
    const config = await data.config.refreshConfig();
    invariant("FAILURE_SAFE", result.status === "unavailable" && result.code === "CLEAR_FAILED" &&
      config.data_generation === 0 && config.clear_pending === true && !await exists(path.join(data.root, "scout.sqlite")),
    { status: result.status, code: result.code ?? null, generation: config.data_generation, pending: config.clear_pending,
      databaseDeleted: !await exists(path.join(data.root, "scout.sqlite")) });
    const fresh = await openConfigStore(data.root, data.now);
    let entered = false;
    let code;
    try { await fresh.withDataAccess(0, async () => { entered = true; }); }
    catch (error) { code = error.message; }
    invariant("FAILURE_SAFE", !entered && code === "DATA_GENERATION_CHANGED", { case: "persistent-pause", callbackEntered: entered, error: code ?? null });
    const staged = await data.engine.stagePrompt({ session_id: "session-A", turn_id: "blocked", prompt: "Build a reusable check.", cwd: runtime, model: "fixture" });
    invariant("FAILURE_SAFE", Object.keys(staged).length === 0, { case: "local-block", staged: Object.keys(staged) });
    await rmdir(path.join(data.root, "key.dpapi"));
    const retry = await clear(data);
    invariant("FAILURE_SAFE", retry.status === "ok" && (await data.config.refreshConfig()).data_generation === 1,
      { case: "fresh-confirmation-retry", status: retry.status });
  } finally { await releaseIdleStorage(data.engine); }
}

async function nativeGate() {
  const data = await fixture();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), buildRoot, "hold-gate", data.root],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`gate child exited ${code}`))); });
  const messages = [];
  const entered = new Promise((resolve, reject) => {
    child.on("message", message => { messages.push(message); if (message.event === "entered") resolve(); });
    child.once("exit", code => reject(new Error(`gate child exited before entry: ${code}`)));
    child.once("error", reject);
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    await entered;
    const gate = new DatabaseSync(path.join(data.root, "clear-lock.sqlite"));
    let busy = false;
    try { gate.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); gate.exec("ROLLBACK"); }
    catch (error) { busy = error.errcode === 5 || /locked|busy/iu.test(error.message); }
    finally { gate.close(); }
    invariant("NO_STALE_WRITE", busy, { case: "native-shared-excludes-exclusive", exclusiveBlocked: busy });
    child.send({ action: "release" });
    await done;
    const gateAfter = new DatabaseSync(path.join(data.root, "clear-lock.sqlite"));
    gateAfter.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK");
    gateAfter.close();
    record("native-exclusive-succeeds-after-release", { messages });
    const crashed = spawn(process.execPath, [fileURLToPath(import.meta.url), buildRoot, "hold-gate", data.root],
      { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    const exited = new Promise((resolve, reject) => { crashed.once("error", reject); crashed.once("exit", resolve); });
    const held = new Promise((resolve, reject) => {
      crashed.on("message", message => { if (message.event === "entered") resolve(); });
      crashed.once("exit", () => reject(new Error("FIXTURE: crash reader exited before entry")));
      crashed.once("error", reject);
    });
    const watchdog = setTimeout(() => crashed.kill(), 15_000);
    try {
      await held;
      assert.ok(crashed.kill(), "FIXTURE: terminate a reader holding the real shared gate");
      await exited;
      const afterExit = new DatabaseSync(path.join(data.root, "clear-lock.sqlite"));
      afterExit.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK");
      afterExit.close();
      record("native-lock-released-after-process-exit", { exclusiveAcquired: true });
    } finally {
      clearTimeout(watchdog);
      if (crashed.exitCode === null && crashed.signalCode === null) crashed.kill();
      await exited.catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await done.catch(() => undefined);
    await releaseIdleStorage(data.engine);
  }
}

async function lateResponse() {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let signal, batches=0;
  const data = await fixture({ fetch: async (_url, init) => {
    signal = init.signal;
    batches++;
    if (batches===2) { started.resolve();await release.promise; }
    return new Response(JSON.stringify({ model: "kettei-fat", answers:Object.fromEntries(
      Object.keys(JSON.parse(init.body).questions).map(id=>[id,{type:"noul",noul:1}])) }));
  } });
  try {
    const prototype = { core_goal: "Implement an approved specification and its dependent work items",
      input_roles: ["Approved specification", "Dependent work items", "Runnable repository"],
      output: "Integrated implementation and verification evidence", essential_steps: ["Resolve dependencies", "Implement isolated tasks", "Integrate changes", "Test and review"],
      variable_slots: [], scope: "global" };
    const db = new DatabaseSync(path.join(data.root, "scout.sqlite"));
    for(let i=0;i<7;i++) db.prepare(`INSERT INTO workflows(scope_kind,scope_value,state,prototype_json,prototype_version,representatives_json,last_seen_at,suppression,created_at,updated_at)
      VALUES('global',NULL,'confirmed',?,3,'[]',?,'none',?,?)`).run(JSON.stringify(prototype), NOW, NOW, NOW);
    db.close();
    await data.config.updateConfig(current => ({ ...current, decision_model: { ...current.decision_model, enabled: true,
      allow_external: true, existence: null, matching: { threshold: 0.5 } } }));
    await data.engine.stagePrompt({ session_id: "session-A", turn_id: "late", prompt: "Implement the approved design and verify the resulting code.", cwd: runtime, model: "fixture" });
    const extraction = data.engine.observeTurn({ phase: "extract", schema_version: 6, session_id: "session-A", turn_id: "late", disposition: "analyze", items: [{
      core_goal: "Deliver the approved change", input_roles: ["Approved design"], output: "Working implementation",
      essential_steps: ["Inspect dependencies", "Implement the design", "Verify behavior"], scope_hint: "global", confidence: "high",
      capabilities: [{ ...prototype, confidence: "high" }]
    }] });
    await started.promise;
    invariant("NO_STALE_WRITE",batches===2,{case:"second-matching-batch-in-flight",batches});
    record("second-matching-batch-in-flight");
    const result = await clear(data);
    release.resolve();
    const late = await extraction;
    const fresh = await openStorage({ filename: path.join(data.root, "scout.sqlite"), now: data.now });
    const counts = await fresh.getStatusCounts();
    fresh.close();
    invariant("NO_STALE_WRITE", result.status === "ok" && signal.aborted && late.status === "ignored" && counts.episodes === 0,
      { case: "late-matching-response", clearStatus: result.status, aborted: signal.aborted, responseStatus: late.status, episodes: counts.episodes });
  } finally { release.resolve(); await releaseIdleStorage(data.engine); }
}

try {
  if (scenario === "hold-gate") {
    const root = await realpath(process.argv[4]);
    assert.ok(!path.relative(buildRoot, root).startsWith(".."), "FIXTURE: child data path");
    const config = await openConfigStore(root, () => NOW);
    const release = new Promise(resolve => process.once("message", message => { assert.equal(message.action, "release"); resolve(); }));
    await config.withDataAccess(config.readConfig().data_generation, async () => { process.send({ event: "entered" }); await release; });
    process.disconnect();
  } else {
    const cases = { authorization, retention, "old-generation": oldGeneration, "partial-failure": partialFailure,
      "native-gate": nativeGate, "late-response": lateResponse };
    assert.ok(Object.hasOwn(cases, scenario), "FIXTURE: known scenario");
    await cases[scenario]();
    console.log(JSON.stringify({ kind: "pass", scenario, events }));
  }
} catch (error) {
  console.log(JSON.stringify({ kind: error.code === "ERR_ASSERTION" && error.rule ? "invariant-failed" : "incomplete",
    scenario, rule: error.rule ?? null, error: error.message, events, stack: error.rule ? undefined : error.stack }));
  process.exitCode = 1;
}
