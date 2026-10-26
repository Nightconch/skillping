import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execute = promisify(execFile);
const here = import.meta.dirname;
const runtime = path.resolve(here, "../..");
const repository = path.resolve(runtime, "../..");
const manifest = JSON.parse(await readFile(path.join(here, "verification.json"), "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const readSource = async file => (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
const exists = file => stat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const cases = ["authorization", "retention", "old-generation", "partial-failure", "native-gate", "late-response"];
await mkdir(path.join(here, ".work"), { recursive: true });
const runRoot = await mkdtemp(path.join(here, ".work", "run-"));
const report = { started: new Date().toISOString(), sync_commit: manifest.sync_commit, source_hash_format: manifest.source_hash_format, node: process.version,
  platform: `${process.platform}-${process.arch}`, scope: "bounded TLA+ safety model and selected actual-code scenarios; no refinement proof",
  source_locations: {}, models: [], baseline: [], mutations: [], baseline_after: [], source_unchanged: false };
let modelSnapshot;

async function command(file, args, options = {}) {
  try {
    const result = await execute(file, args, { cwd: runtime, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function checkSources() {
  assert.equal(manifest.source_hash_format, "sha256-utf8-lf");
  for (const [file, expected] of Object.entries(manifest.sources)) {
    assert.match(expected, /^[a-f0-9]{64}$/u, `source pin ${file}`);
    const bytes = await readFile(path.join(runtime, file));
    const rawHash = sha256(bytes);
    if (report.source_raw_sha256?.[file]) assert.equal(rawHash, report.source_raw_sha256[file], "SOURCE_CHANGED_DURING_RUN");
    (report.source_raw_sha256 ??= {})[file] = rawHash;
    assert.equal(sha256(bytes.toString("utf8").replaceAll("\r\n", "\n")), expected,
      `SOURCE_MAPPING_STALE: review model/cases against ${file} before updating the sync record`);
  }
  for (const [rule, definition] of Object.entries(manifest.rules)) {
    const source = await readSource(path.join(runtime, definition.source));
    assert.equal(source.split(definition.anchor).length, 2, `unique source anchor for ${rule}`);
    report.source_locations[rule] = { file: `plugins/skillping-runtime/${definition.source}`,
      line: source.slice(0, source.indexOf(definition.anchor)).split("\n").length,
      source_sha256: manifest.sources[definition.source], promise: definition.promise };
  }
}

async function tools() {
  assert.equal(process.platform, "win32", "Pinned portable JVM bootstrap currently targets Windows x64");
  assert.equal(process.arch, "x64", "Pinned portable JVM bootstrap currently targets Windows x64");
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node 24+ required");
  const cache = path.join(repository, ".scratch", "formal-tools");
  await mkdir(cache, { recursive: true });
  for (const tool of Object.values(manifest.tools)) {
    assert.match(tool.sha256, /^[a-f0-9]{64}$/u, "complete tool checksum");
    assert.ok(new URL(tool.url).origin === "https://github.com", "fixed official release URL");
    const destination = path.join(cache, tool.filename);
    if (!await exists(destination)) {
      console.log(`Downloading pinned ${tool.filename}`);
      const response = await fetch(tool.url);
      assert.ok(response.ok, `${tool.filename}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(sha256(bytes), tool.sha256, `${tool.filename}: checksum before write/execution`);
      try { await writeFile(destination, bytes, { flag: "wx" }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    assert.equal(sha256(await readFile(destination)), tool.sha256, `${tool.filename}: cached checksum`);
  }
  const java = path.join(cache, manifest.tools.java.executable);
  if (!await exists(java)) {
    const extraction = path.join(cache, "jre");
    await mkdir(extraction, { recursive: true });
    const expanded = await command("tar.exe", ["-xf", path.join(cache, manifest.tools.java.filename), "-C", extraction]);
    assert.equal(expanded.code, 0, `verified JVM extraction: ${expanded.stderr}`);
  }
  const version = await command(java, ["-version"]);
  assert.equal(version.code, 0, "pinned JVM starts");
  assert.ok((version.stdout + version.stderr).includes(manifest.tools.java.version), "pinned JVM version");
  report.tools = { java: version.stderr.trim(), tlc: manifest.tools.tlc.version,
    java_archive_sha256: manifest.tools.java.sha256, tlc_sha256: manifest.tools.tlc.sha256,
    typescript: JSON.parse(await readFile(path.join(runtime, "node_modules/typescript/package.json"), "utf8")).version };
  return { java, jar: path.join(cache, manifest.tools.tlc.filename) };
}

async function compile(label, mutation) {
  const buildRoot = path.join(runRoot, label);
  await mkdir(buildRoot);
  await cp(path.join(runtime, "src"), path.join(buildRoot, "src"), { recursive: true });
  await cp(path.join(runtime, "tsconfig.json"), path.join(buildRoot, "tsconfig.json"));
  if (mutation) {
    const file = path.join(buildRoot, mutation.source);
    const original = await readSource(file);
    assert.equal(original.split(mutation.before).length, 2, `exactly one mutation anchor: ${mutation.id}`);
    const changed = original.replace(mutation.before, mutation.after);
    await writeFile(file, changed);
    await writeFile(path.join(buildRoot, "mutation.json"), JSON.stringify({ ...mutation,
      before_sha256: sha256(original), after_sha256: sha256(changed), oracle_changed: false }, null, 2) + "\n");
  }
  const tsc = path.join(runtime, "node_modules/typescript/bin/tsc");
  const compiled = await command(process.execPath, [tsc, "-p", path.join(buildRoot, "tsconfig.json")]);
  await writeFile(path.join(buildRoot, "compile.log"), compiled.stdout + compiled.stderr);
  assert.equal(compiled.code, 0, `INCOMPLETE: TypeScript compile failed for ${label}; not a mutant kill\n${compiled.stdout}${compiled.stderr}`);
  const dist = await realpath(path.join(buildRoot, "dist"));
  for (const entry of await readdir(dist, { recursive: true })) {
    if (!entry.endsWith(".js")) continue;
    const file = path.join(dist, entry);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])(\.[^"']+)\1/gu)) {
      const dependency = await realpath(path.resolve(path.dirname(file), match[2]));
      assert.ok(!path.relative(dist, dependency).startsWith(".."), `copied import escaped sandbox: ${entry}`);
    }
  }
  return buildRoot;
}

async function scenario(buildRoot, name, phase) {
  const result = await command(process.execPath, [path.join(here, "real-code.mjs"), buildRoot, name], { timeout: 60_000 });
  const filename = path.join(buildRoot, `${phase}-${name}.json`);
  let observation;
  try { observation = JSON.parse(result.stdout.trim()); }
  catch { throw new Error(`INCOMPLETE: ${name} returned no structured observation\n${result.stdout}\n${result.stderr}`); }
  assert.ok(["pass", "invariant-failed", "incomplete"].includes(observation.kind), "known scenario result");
  assert.equal(observation.scenario, name, "scenario identity");
  await writeFile(filename, JSON.stringify({ ...observation, process_exit: result.code, stderr: result.stderr }, null, 2) + "\n");
  return { ...observation, process_exit: result.code, artifact: filename,
    replay: `rtk proxy node plugins/skillping-runtime/verification/clear-data/real-code.mjs "${buildRoot}" ${name}` };
}

async function checkModel(toolchain, label, fault, expectedRule) {
  if (!modelSnapshot) {
    const source = await readFile(path.join(here, "ClearData.tla"));
    modelSnapshot = path.join(runRoot, "ClearData.tla");
    await writeFile(modelSnapshot, source);
    report.model_sha256 = sha256(source);
  }
  const directory = path.join(runRoot, `model-${label}`);
  await mkdir(directory);
  const cfg = path.join(directory, "ClearData.cfg");
  await writeFile(cfg, `CONSTANTS\n  Processes = {p1, p2}\n  MaxClears = 2\n  Fault = "${fault}"\nSPECIFICATION Spec\nINVARIANTS\n  ${Object.keys(manifest.rules).join("\n  ")}\nSYMMETRY ProcessSymmetry\nCHECK_DEADLOCK FALSE\n`);
  console.log(`TLC ${label}`);
  const result = await command(toolchain.java, ["-XX:+UseParallelGC", "-Xmx1g", `-DTLA-Library=${directory.replaceAll("\\", "/")}`, "-cp", toolchain.jar, "tlc2.TLC", "-workers", "1",
    "-config", path.basename(cfg), "-metadir", path.join(directory, "states"), modelSnapshot]);
  const log = path.join(directory, "trace.txt");
  const output = result.stdout + result.stderr;
  await writeFile(log, output);
  const count = output.match(/([\d,]+) states generated, ([\d,]+) distinct states found/u);
  const counts = count ? { generated: Number(count[1].replaceAll(",", "")), distinct: Number(count[2].replaceAll(",", "")) } : {};
  const violated = output.match(/Invariant (\w+) is violated/u)?.[1];
  const passed = result.code === 0 && /Model checking completed\. No error has been found/u.test(output) && counts.distinct > 0;
  const expectedFailure = result.code !== 0 && violated === expectedRule;
  const record = { label, fault, kind: expectedRule ? "model-counterexample" : "model-baseline", process_exit: result.code,
    ...counts, violated: violated ?? null, passed: expectedRule ? expectedFailure : passed, artifact: log,
    bounds: { processes: 2, sessions: 2, max_clears: 2, generations: [0, 1, 2] },
    source: expectedRule ? report.source_locations[expectedRule] : report.source_locations };
  report.models.push(record);
  assert.ok(record.passed, `INCOMPLETE: unexpected TLC outcome for ${label}; see ${log}`);
  console.log(`${label}: ${expectedRule ? `caught ${violated}` : `${counts.distinct} distinct states, all invariants hold`}`);
}

try {
  await checkSources();
  report.oracle_sha256 = sha256(await readFile(path.join(here, "real-code.mjs")));
  const toolchain = await tools();
  const baseline = await compile("baseline");
  for (const name of cases) {
    const result = await scenario(baseline, name, "before");
    report.baseline.push(result);
    assert.ok(result.kind === "pass" && result.process_exit === 0, `Baseline ${name} failed: ${result.artifact}`);
    console.log(`Actual code: ${name} passed`);
  }
  await checkModel(toolchain, "baseline", "none");
  for (const mutation of manifest.mutations) {
    assert.ok(Object.hasOwn(manifest.rules, mutation.rule), "known mutation rule");
    await checkModel(toolchain, mutation.id, mutation.model_fault, mutation.rule);
    const copy = await compile(mutation.id, mutation);
    const result = await scenario(copy, manifest.rules[mutation.rule].scenario, "mutant");
    const killed = result.kind === "invariant-failed" && result.rule === mutation.rule && result.process_exit === 1;
    report.mutations.push({ id: mutation.id, rule: mutation.rule, compiled: true, killed, result, source: report.source_locations[mutation.rule],
      patch: path.join(copy, "mutation.json") });
    assert.ok(killed, `INCOMPLETE: ${mutation.id} survived or failed for another reason: ${result.artifact}`);
    console.log(`Actual source ${mutation.id}: caught ${result.rule} after successful TypeScript compilation`);
  }
  await checkModel(toolchain, "restored-baseline", "none");
  for (const name of cases) {
    const result = await scenario(baseline, name, "after");
    report.baseline_after.push(result);
    assert.ok(result.kind === "pass" && result.process_exit === 0, `Final clean ${name} failed: ${result.artifact}`);
  }
  await checkSources();
  assert.equal(sha256(await readFile(path.join(here, "real-code.mjs"))), report.oracle_sha256, "ORACLE_CHANGED_DURING_RUN");
  assert.equal(sha256(await readFile(path.join(here, "ClearData.tla"))), report.model_sha256, "MODEL_CHANGED_DURING_RUN");
  report.source_unchanged = true;
  report.status = "pass";
} catch (error) {
  report.status = [...report.baseline, ...report.baseline_after].some(result => result.kind === "invariant-failed") ? "code-finding"
    : report.models.some(result => result.fault === "none" && result.violated) ? "model-finding" : "incomplete";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  await writeFile(path.join(runRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Verification ${report.status}: ${path.join(runRoot, "report.json")}`);
  if (report.error) console.error(report.error);
}
