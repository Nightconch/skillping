import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openConfigStore } from "../dist/config.js";
import { historyExtractSchema, observeTurnSchema } from "../dist/domain.js";
import { buildRelease } from "./build-release.mjs";

const execute = promisify(execFile);
const NOW = 1_792_454_400_000;
const configModule = new URL("../dist/config.js", import.meta.url).href;
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "skillping-architecture-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("skillping-architecture-"));
    await rm(root, { recursive: true, force: true });
  });
  return { root, config: await openConfigStore(root, () => NOW), file: path.join(root, "config.json") };
}

test("release upgrades its owned legacy inventory with the matching guide and preserves unknown files", async t=>{
  const {root}=await fixture(t);
  const output=path.join(root,"release");
  const document=path.join(output,"docs/workflow-matching.md");
  const receiptFile=path.join(output,".skillping-release.json");
  await buildRelease(output);
  const expected=await readFile(new URL("../../../docs/workflow-matching.md",import.meta.url),"utf8");
  assert.equal(await readFile(document,"utf8"),expected);
  const receipt=JSON.parse(await readFile(receiptFile,"utf8"));
  await rm(document);
  delete receipt.entries["docs/workflow-matching.md"];
  await writeFile(receiptFile,JSON.stringify(receipt));
  await buildRelease(output);
  assert.equal(await readFile(document,"utf8"),expected);
  const unrelated=path.join(output,"unrelated.txt");
  await writeFile(unrelated,"preserve this file");
  await assert.rejects(buildRelease(output),/unrecognized release output/u);
  assert.equal(await readFile(unrelated,"utf8"),"preserve this file");
});

test("new configuration has no unused implementation version fields", async t => {
  const { config } = await fixture(t);
  assert.equal(Object.hasOwn(config.readConfig(), "versions"), false);
});

test("existing configuration ignores decorative version metadata and does not require it", async t => {
  const { config, file } = await fixture(t);
  const value = config.readConfig();
  value.versions = { extract_instruction: 14, observation_schema: "retired", matcher: 2, dispatch_template: null };
  await writeFile(file, JSON.stringify(value));
  assert.equal((await config.refreshConfig()).detection_enabled, true);
  delete value.versions;
  await writeFile(file, JSON.stringify(value));
  assert.equal((await config.refreshConfig()).detection_enabled, true);
  value.schema_version = 2;
  await writeFile(file, JSON.stringify(value));
  await assert.rejects(config.refreshConfig(), { message: "CONFIG_INVALID" });
});

test("unchanged success and settings do not replace the configuration file", async t => {
  const { config, file } = await fixture(t);
  const sentinel = new Date("2000-01-01T00:00:00Z");
  await utimes(file, sentinel, sentinel);
  const before = await stat(file, { bigint: true });
  const bytes = await readFile(file, "utf8");
  await config.recordSuccess("storage");
  await config.recordSuccess("storage");
  await config.updateConfig(current => ({ ...current }));
  const after = await stat(file, { bigint: true });
  assert.equal(await readFile(file, "utf8"), bytes);
  assert.equal(after.ino, before.ino, "no-op must not replace the file");
  assert.equal(after.mtimeNs, before.mtimeNs, "no-op must not write the file");
});

test("read refreshes work while another connection holds the config write lock", async t => {
  const { root, config, file } = await fixture(t);
  const lock = new DatabaseSync(path.join(root, "config-lock.sqlite"));
  try {
    lock.exec("BEGIN IMMEDIATE");
    assert.equal(JSON.parse(await readFile(file, "utf8")).detection_enabled, true);
    assert.equal((await config.refreshConfig()).detection_enabled, true);
    assert.deepEqual(await config.refreshImportProgress(), config.readImportProgress());
    await assert.rejects(config.updateConfig(current => ({ ...current, intro_seen: true })), { message: "CONFIG_WRITE_FAILED" });
    assert.equal((await config.refreshConfig()).intro_seen, false);
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
  await config.updateConfig(current => ({ ...current, intro_seen: true }));
  assert.equal((await config.refreshConfig()).intro_seen, true);
});

test("read refresh stays ordered after an outstanding update in the same process", async t => {
  const { root, config } = await fixture(t);
  const other = await openConfigStore(root, () => NOW);
  const pending = config.updateConfig(current => ({ ...current, detection_enabled: false }));
  const refreshed = other.refreshConfig();
  await pending;
  assert.equal((await refreshed).detection_enabled, false);
  assert.equal(other.readConfig().decision_revision, 1);
});

test("import progress refresh stays ordered after an outstanding progress write", async t => {
  const { root, config } = await fixture(t);
  const other = await openConfigStore(root, () => NOW);
  const progress = { ...config.readImportProgress(), completed_batch: 1 };
  const pending = config.writeImportProgress(progress);
  const refreshed = other.refreshImportProgress();
  await pending;
  assert.equal((await refreshed).completed_batch, 1);
});

const failureScript = [
  'const { openConfigStore } = await import(process.argv[1]);',
  'const store = await openConfigStore(process.argv[2], () => 1792454400000);',
  'const component = process.argv[3];',
  'for (let index = 0; index < Number(process.argv[4]); index++) {',
  '  await store.recordFailure(component, component === "history" ? "HISTORY_ERROR" : "DB_BUSY");',
  '}',
].join("\n");
const recordFailures = async (root, component, count) => execute(process.execPath,
  ["--input-type=module", "-e", failureScript, configModule, root, component, String(count)], { timeout: 10_000, windowsHide: true });

test("success refreshes another process's failure before clearing only its component", async t => {
  const { root, config, file } = await fixture(t);
  assert.equal(config.readConfig().health.state, "healthy");
  await recordFailures(root, "storage", 1);
  await recordFailures(root, "history", 1);
  await config.recordSuccess("storage");
  const restored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(restored.health.codes.storage, undefined);
  assert.equal(restored.health.consecutive_failures.storage, undefined);
  assert.equal(restored.health.codes.history, "HISTORY_ERROR");
  assert.equal(restored.health.consecutive_failures.history, 1);
  assert.equal(restored.health.state, "degraded");
  await config.recordSuccess("history");
  assert.equal(JSON.parse(await readFile(file, "utf8")).health.state, "healthy");
});

test("independent processes preserve both streams of configuration updates", async t => {
  const { root, config } = await fixture(t);
  await Promise.all([recordFailures(root, "storage", 6), recordFailures(root, "history", 6)]);
  const latest = await config.refreshConfig();
  assert.equal(latest.health.consecutive_failures.storage, 6);
  assert.equal(latest.health.consecutive_failures.history, 6);
});

const nativeRename = fs.rename;
function interceptRename(t, implementation) {
  const replacement = t.mock.method(fs, "rename", implementation);
  syncBuiltinESMExports();
  t.after(() => {
    replacement.mock.restore();
    syncBuiltinESMExports();
  });
  return replacement;
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`atomic config replacement survives transient Windows ${code}`, { skip: process.platform !== "win32" }, async t => {
    const { root, config, file } = await fixture(t);
    await config.updateConfig(current => ({ ...current, recommendation_pace: "cautious", intro_seen: true,
      decision_model: { ...current.decision_model, api_key: "isolated-test-key" } }));
    const before = await readFile(file, "utf8");
    let denials = 0;
    interceptRename(t, async (source, target) => {
      if (target === file && denials++ < 2) {
        assert.equal(await readFile(file, "utf8"), before, "destination stays complete until atomic replacement");
        assert.equal(JSON.parse(await readFile(source, "utf8")).detection_enabled, false);
        throw Object.assign(new Error("controlled transient sharing denial"), { code });
      }
      return nativeRename(source, target);
    });
    const updated = await config.updateConfig(current => ({ ...current, detection_enabled: false }));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ...JSON.parse(before), detection_enabled: false, decision_revision: 2 });
    assert.equal(updated.decision_model.api_key, "isolated-test-key");
    assert.ok(denials > 2, "must reach a successful rename after the denials");
    assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith(".tmp")), []);
  });
}

test("atomic replacement survives a native independent-process Windows sharing denial", { skip: process.platform !== "win32" }, async t => {
  const { config, file } = await fixture(t);
  const before = await readFile(file, "utf8");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$stream = [System.IO.File]::Open($env:SKILLPING_TEST_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); [Console]::WriteLine('held'); [Console]::ReadLine() | Out-Null; $stream.Dispose()"],
  { env: { ...process.env, SKILLPING_TEST_FILE: file }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await closed;
  });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const [ready] = await once(lines, "line", { signal: AbortSignal.timeout(10_000) });
  assert.equal(ready, "held", "independent process holds a real handle without FileShare.Delete");
  let denial;
  interceptRename(t, async (source, target) => {
    try { return await nativeRename(source, target); }
    catch (error) {
      if (target === file && !denial) {
        denial = error;
        assert.equal(error.code, "EPERM", "native Windows rename must demonstrate the reported errno");
        assert.equal(await readFile(file, "utf8"), before);
        child.stdin.end("\n");
        const [exitCode] = await closed;
        assert.equal(exitCode, 0);
      }
      throw error;
    }
  });
  await config.updateConfig(current => ({ ...current, intro_seen: true }));
  assert.equal(denial?.code, "EPERM");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ...JSON.parse(before), intro_seen: true });
});

for (const code of ["EPERM", "EACCES", "EBUSY", "EIO"]) {
  test(`failed atomic replacement preserves data and cause for ${code}`, async t => {
    const { root, config, file } = await fixture(t);
    const before = await readFile(file, "utf8");
    const failure = Object.assign(new Error("controlled persistent replacement failure"), { code });
    let attempts = 0;
    const replacement = interceptRename(t, async () => { attempts++; throw failure; });
    await assert.rejects(config.updateConfig(current => ({ ...current, intro_seen: true })), error => {
      assert.equal(error.message, "CONFIG_WRITE_FAILED");
      assert.equal(error.cause, failure);
      return true;
    });
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(config.readConfig().health.codes.config, "CONFIG_WRITE_FAILED");
    assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith(".tmp")), []);
    if (process.platform === "win32" && code !== "EIO") assert.ok(attempts > 1 && attempts <= 6, "sharing failures have a finite retry budget");
    else assert.equal(attempts, 1, "unrelated errors and other platforms fail immediately");
    replacement.mock.restore();
    syncBuiltinESMExports();
    await config.updateConfig(current => ({ ...current, intro_seen: true }));
    assert.equal((await config.refreshConfig()).intro_seen, true, "failed write releases the writer lock and queue");
  });
}

test("import progress uses the same atomic replacement recovery", { skip: process.platform !== "win32" }, async t => {
  const { root, config } = await fixture(t);
  const file = path.join(root, "import-progress.json");
  await config.writeImportProgress(config.readImportProgress());
  const before = await readFile(file, "utf8");
  let denials = 0;
  interceptRename(t, async (source, target) => {
    if (target === file && denials++ === 0) {
      assert.equal(await readFile(file, "utf8"), before);
      throw Object.assign(new Error("controlled progress replacement denial"), { code: "EPERM" });
    }
    return nativeRename(source, target);
  });
  await config.writeImportProgress({ ...config.readImportProgress(), completed_batch: 1 });
  assert.equal(JSON.parse(await readFile(file, "utf8")).completed_batch, 1);
  assert.equal(config.readImportProgress().completed_batch, 1);
  assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith(".tmp")), []);
});

test("the live observation contract accepts current versions and rejects retired transports", () => {
  const ids = { session_id: "fixture-task", turn_id: "fixture-turn" };
  assert.equal(observeTurnSchema.safeParse({ ...ids, phase: "extract", schema_version: 6, disposition: "skip", items: [] }).success, true);
  assert.equal(observeTurnSchema.safeParse({ ...ids, phase: "review", schema_version: 3, decisions: [] }).success, true);
  for (const schema_version of [2, 3, 4, 5]) {
    const disposition = schema_version === 5 ? "skip" : "analyze";
    assert.equal(observeTurnSchema.safeParse({ ...ids, phase: "extract", schema_version, disposition, items: [] }).success, false,
      "retired extract version " + schema_version);
  }
  assert.equal(observeTurnSchema.safeParse({ ...ids, phase: "review", schema_version: 2, review_reason: "match", verdict: "uncertain" }).success, false);
  assert.equal(observeTurnSchema.safeParse({ ...ids, phase: "extract", schema_version: 6, disposition: "analyze", items: [] }).success, false);
});

test("history keeps relation-aware observations and non-binary dispositions", () => {
  const item = { relation: "continue", core_goal: "Summarize experimental evidence",
    input_roles: ["Research observations"], output: "Evidence summary", essential_steps: ["Compare evidence"],
    variables: [], scope_hint: "global", confidence: "high" };
  assert.equal(historyExtractSchema.safeParse({ disposition: "analyze", items: [item] }).success, true);
  assert.equal(historyExtractSchema.safeParse({ disposition: "control", items: [] }).success, true);
  assert.equal(historyExtractSchema.safeParse({ disposition: "control", items: [item] }).success, false);
});

