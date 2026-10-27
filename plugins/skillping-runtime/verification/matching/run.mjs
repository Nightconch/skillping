import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { modelBounds, verifyModel } from "./model.mjs";
import { scenarioNames } from "./real-code.mjs";

const execute = promisify(execFile);
const here = import.meta.dirname;
const runtime = path.resolve(here, "../..");
const modelOnly = process.argv.includes("--model-only");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const readSource = async file => (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
const work = path.join(import.meta.dirname, ".work");
await mkdir(work, { recursive: true });
const runRoot = await mkdtemp(path.join(work, "run-"));
const report = { status: "incomplete", started: new Date().toISOString(), node: process.version,
  scope: modelOnly ? "bounded independent scan safety model" : "bounded scan model and actual SQLite scenarios; no refinement proof",
  model_bounds: modelBounds, models: [], baseline: [], mutations: [], baseline_after: [], source_unchanged: false };

async function command(args) {
  try {
    const result = await execute(process.execPath, args, { cwd: runtime, windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, ...result };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function checkSources(manifest) {
  assert.equal(manifest.source_hash_format, "sha256-utf8-lf");
  assert.ok(Object.keys(manifest.sources).length >= 3, "matching source mapping pins are present");
  for (const [file, expected] of Object.entries(manifest.sources)) {
    assert.match(expected, /^[a-f0-9]{64}$/u);
    const bytes = await readFile(path.join(runtime, file));
    const raw = sha256(bytes);
    if (report.source_raw_sha256?.[file]) assert.equal(raw, report.source_raw_sha256[file], "SOURCE_CHANGED_DURING_RUN");
    (report.source_raw_sha256 ??= {})[file] = raw;
    assert.equal(sha256(bytes.toString("utf8").replaceAll("\r\n", "\n")), expected,
      `SOURCE_MAPPING_STALE: reconcile matching model/scenarios with ${file} before updating pins`);
  }
  report.source_locations = {};
  for (const [rule, definition] of Object.entries(manifest.rules)) {
    const source = await readSource(path.join(runtime, definition.source));
    assert.equal(source.split(definition.anchor).length, 2, `unique source anchor for ${rule}`);
    report.source_locations[rule] = { file: `plugins/skillping-runtime/${definition.source}`,
      line: source.slice(0, source.indexOf(definition.anchor)).split("\n").length,
      source_sha256: manifest.sources[definition.source], promise: definition.promise };
  }
}

async function compile(label, mutation) {
  const directory = path.join(runRoot, label);
  await mkdir(directory);
  await cp(path.join(runtime, "src"), path.join(directory, "src"), { recursive: true });
  await cp(path.join(runtime, "tsconfig.json"), path.join(directory, "tsconfig.json"));
  if (mutation) {
    const file = path.join(directory, mutation.source);
    const source = await readSource(file);
    assert.equal(source.split(mutation.before).length, 2, `unique mutation anchor ${mutation.id}`);
    const changed = source.replace(mutation.before, mutation.after);
    await writeFile(file, changed);
    await writeFile(path.join(directory, "mutation.json"), JSON.stringify({ ...mutation,
      before_sha256: sha256(source), after_sha256: sha256(changed), oracle_changed: false }, null, 2) + "\n");
  }
  const result = await command([path.join(runtime, "node_modules/typescript/bin/tsc"), "-p", path.join(directory, "tsconfig.json")]);
  await writeFile(path.join(directory, "compile.log"), result.stdout + result.stderr);
  assert.equal(result.code, 0, `INCOMPLETE: ${label} compilation failed; not a detected business defect`);
  const dist = await realpath(path.join(directory, "dist"));
  for (const entry of await readdir(dist, { recursive: true })) {
    if (!entry.endsWith(".js")) continue;
    const source = await readFile(path.join(dist, entry), "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])(\.[^"']+)\1/gu)) {
      const dependency = await realpath(path.resolve(path.dirname(path.join(dist, entry)), match[2]));
      assert.ok(!path.relative(dist, dependency).startsWith(".."), `isolated import escaped ${entry}`);
    }
  }
  return directory;
}

async function scenario(directory, name, label) {
  const result = await command([path.join(here, "real-code.mjs"), directory, name]);
  let observed;
  try { observed = JSON.parse(result.stdout.trim()); }
  catch { throw new Error(`INCOMPLETE: no structured result for ${name}\n${result.stdout}\n${result.stderr}`); }
  assert.equal(observed.scenario, name, "matching scenario identity");
  const artifact = path.join(directory, `${label}-${name}.json`);
  await writeFile(artifact, JSON.stringify({ ...observed, process_exit: result.code, stderr: result.stderr }, null, 2) + "\n");
  return { ...observed, process_exit: result.code, artifact,
    replay: `rtk proxy node plugins/skillping-runtime/verification/matching/real-code.mjs "${directory}" ${name}` };
}

try {
  report.models = verifyModel();
  if (!modelOnly) {
    const manifest = JSON.parse(await readFile(path.join(here, "verification.json"), "utf8"));
    report.sync_commit = manifest.sync_commit;
    report.sync_note = manifest.sync_note;
    await checkSources(manifest);
    report.oracle_sha256 = {};
    for (const file of ["model.mjs", "real-code.mjs"]) report.oracle_sha256[file] = sha256(await readFile(path.join(here, file)));
    const baseline = await compile("baseline");
    for (const name of scenarioNames) {
      const result = await scenario(baseline, name, "before");
      report.baseline.push(result);
      assert.ok(result.kind === "pass" && result.process_exit === 0, `clean baseline finding: ${name}; ${result.message}`);
    }
    for (const mutation of manifest.mutations) {
      const directory = await compile(mutation.id, mutation);
      const result = await scenario(directory, mutation.scenario, "mutant");
      const model = report.models.find(item => item.fault === mutation.model_fault);
      const killed = result.kind === "invariant-failed" && result.rule === mutation.rule && result.process_exit === 1 && model?.rule === mutation.rule;
      report.mutations.push({ id: mutation.id, rule: mutation.rule, compiled: true, killed,
        source: report.source_locations[mutation.rule], patch: path.join(directory, "mutation.json"), result });
      assert.ok(killed, `INCOMPLETE: ${mutation.id} did not fail its designated business invariant`);
    }
    for (const name of scenarioNames) {
      const result = await scenario(baseline, name, "after");
      report.baseline_after.push(result);
      assert.ok(result.kind === "pass" && result.process_exit === 0, `final clean baseline finding: ${name}; ${result.message}`);
    }
    for (const [file, expected] of Object.entries(report.oracle_sha256)) {
      assert.equal(sha256(await readFile(path.join(here, file))), expected, "ORACLE_CHANGED_DURING_RUN");
    }
    await checkSources(manifest);
    report.source_unchanged = true;
  }
  report.status = "pass";
} catch (error) {
  report.status = [...report.baseline, ...report.baseline_after].some(result => result.kind === "invariant-failed") ? "code-finding" : "incomplete";
  report.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  const filename = path.join(runRoot, "report.json");
  await writeFile(filename, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, report: filename,
    model_states: report.models[0]?.states, model_transitions: report.models[0]?.transitions,
    counterexamples: Math.max(0, report.models.length - 1),
    scenarios_before: report.baseline.length, source_variants: report.mutations.map(item => ({ id: item.id, killed: item.killed })),
    scenarios_after: report.baseline_after.length, source_unchanged: report.source_unchanged }));
}
