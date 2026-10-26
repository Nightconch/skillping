import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execute = promisify(execFile);
const here = import.meta.dirname;
const runtime = path.resolve(here, "../..");
const manifest = JSON.parse(await readFile(path.join(here, "verification.json"), "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const oracle = path.join(runtime, "scripts/check-counting-rules.mjs");
await mkdir(path.join(here, ".work"), { recursive: true });
const runRoot = await mkdtemp(path.join(here, ".work", "run-"));
const report = { started: new Date().toISOString(), sync_commit: manifest.sync_commit, node: process.version,
  scope: "finite threshold matrix and concrete SQLite/engine checks; no formal refinement proof",
  source_locations: {}, baseline: [], mutations: [], source_unchanged: false };

async function command(args, env = {}) {
  try {
    const result = await execute(process.execPath, args, { cwd: runtime, windowsHide: true, timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...env } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function checkSources() {
  for (const [file, expected] of Object.entries(manifest.sources)) assert.equal(sha256(await readFile(path.join(runtime, file))), expected,
    `SOURCE_MAPPING_STALE: review counting rules/cases against ${file} before updating the sync record`);
}

async function compile(label, mutation) {
  const build = path.join(runRoot, label);
  await mkdir(build);
  await cp(path.join(runtime, "src"), path.join(build, "src"), { recursive: true });
  await cp(path.join(runtime, "tsconfig.json"), path.join(build, "tsconfig.json"));
  if (mutation) {
    const file = path.join(build, mutation.source);
    const original = await readFile(file, "utf8");
    assert.equal(original.split(mutation.before).length, 2, `unique mutation anchor ${mutation.id}`);
    const changed = original.replace(mutation.before, mutation.after);
    await writeFile(file, changed);
    await writeFile(path.join(build, "mutation.json"), JSON.stringify({ ...mutation,
      before_sha256: sha256(original), after_sha256: sha256(changed), oracle_changed: false }, null, 2) + "\n");
  }
  const result = await command([path.join(runtime, "node_modules/typescript/bin/tsc"), "-p", path.join(build, "tsconfig.json")]);
  await writeFile(path.join(build, "compile.log"), result.stdout + result.stderr);
  assert.equal(result.code, 0, `INCOMPLETE: ${label} did not compile; not a detected source error`);
  return build;
}

async function check(build, phase, mutation) {
  const args = ["--test", "--test-reporter=tap", ...(mutation ? [`--test-name-pattern=${mutation.test}`] : []), oracle];
  const result = await command(args, { SKILLPING_COUNTING_DIST: path.join(build, "dist") });
  const log = path.join(build, `${phase}.tap`);
  await writeFile(log, result.stdout + result.stderr);
  const assertion = result.stdout.match(/error: (?:["']|\|-\r?\n\s*)(COUNT_[A-Z_]+):/u)?.[1] ?? null;
  const observation = { process_exit: result.code, assertion, artifact: log,
    replay: `rtk proxy powershell -NoProfile -Command '$env:SKILLPING_COUNTING_DIST="${path.join(build, "dist")}"; & "${process.execPath}" --test --test-reporter=tap ${mutation ? `"--test-name-pattern=${mutation.test}" ` : ""}"${oracle}"'` };
  if (mutation) {
    const killed = result.code === 1 && assertion === mutation.rule && /code: 'ERR_ASSERTION'/u.test(result.stdout);
    report.mutations.push({ id: mutation.id, rule: mutation.rule, compiled: true, killed,
      ...observation, source: report.source_locations[mutation.id], patch: path.join(build, "mutation.json") });
    assert.ok(killed, `INCOMPLETE: ${mutation.id} survived or failed for another reason; see ${log}`);
    console.log(`${mutation.id}: compiled, caught ${assertion}`);
  } else {
    report.baseline.push({ phase, ...observation });
    if (result.code !== 0) throw new Error(`${assertion && /code: 'ERR_ASSERTION'/u.test(result.stdout) ? "CODE_FINDING" : "INCOMPLETE"}: clean counting baseline failed; see ${log}`);
    assert.match(result.stdout, /# fail 0/u, "completed test runner");
    console.log(`Counting ${phase}: all checks passed`);
  }
}

try {
  await checkSources();
  report.oracle_sha256 = sha256(await readFile(oracle));
  for (const mutation of manifest.mutations) {
    const source = await readFile(path.join(runtime, mutation.source), "utf8");
    assert.equal(source.split(mutation.before).length, 2, `unique source mapping ${mutation.id}`);
    report.source_locations[mutation.id] = { file: `plugins/skillping-runtime/${mutation.source}`,
      line: source.slice(0, source.indexOf(mutation.before)).split("\n").length,
      source_sha256: manifest.sources[mutation.source] };
  }
  const baseline = await compile("baseline");
  await check(baseline, "before");
  for (const mutation of manifest.mutations) await check(await compile(mutation.id, mutation), "mutant", mutation);
  await check(baseline, "after");
  await checkSources();
  assert.equal(sha256(await readFile(oracle)), report.oracle_sha256, "ORACLE_CHANGED_DURING_RUN");
  report.source_unchanged = true;
  report.status = "pass";
} catch (error) {
  report.status = error.message.startsWith("CODE_FINDING:") ? "code-finding" : "incomplete";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  await writeFile(path.join(runRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Counting verification ${report.status}: ${path.join(runRoot, "report.json")}`);
  if (report.error) console.error(report.error);
}
