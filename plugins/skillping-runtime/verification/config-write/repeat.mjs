import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(new URL("../../", import.meta.url));
const repetitions = Number(process.argv[2] ?? 25);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 200, "repetitions must be 1..200");
const work = path.join(runtime, "verification/config-write/.work", new Date().toISOString().replaceAll(":", "-"));
await mkdir(work, { recursive: true });
const results = [];
for (let index = 0; index < repetitions; index++) {
  const result = spawnSync(process.execPath, ["--test", "--test-name-pattern=^independent processes preserve both streams of configuration updates$", "scripts/check-architecture.mjs"],
    { cwd: runtime, encoding: "utf8", timeout: 30_000, windowsHide: true });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const sample = { index: index + 1, status: result.status, signal: result.signal, error: result.error?.message ?? null,
    passed: result.status === 0 && /(?:pass 1|# pass 1)/.test(output) };
  results.push(sample);
  await writeFile(path.join(work, `${index + 1}.txt`), output);
  process.stdout.write(`sample ${index + 1}/${repetitions}: ${sample.passed ? "pass" : "FAIL"}\n`);
}
const report = { node: process.version, platform: process.platform, repetitions, passed: results.filter(result => result.passed).length,
  method: "Sequential fresh node --test processes; each runs the original two-child, six-updates-per-stream fixture with new temporary data.", results };
await writeFile(path.join(work, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${path.join(work, "report.json")}\n`);
assert.equal(report.passed, repetitions, "all original concurrent-update samples must pass");
