import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32", "this check requires native Windows sharing semantics");
const runtime = fileURLToPath(new URL("../../", import.meta.url));
const workRoot = path.join(runtime, "verification/config-write/.work");
await mkdir(workRoot, { recursive: true });
const work = await mkdtemp(path.join(workRoot, "red-green-"));
const sourceFile = path.join(runtime, "src/config.ts");
const source = await readFile(sourceFile, "utf8");
const hash = text => createHash("sha256").update(text).digest("hex");
const before = `    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporaryPath, filePath);
        break;
      } catch (error) {
        // Windows handles can briefly deny replacement even while writers are serialized.
        if (process.platform !== "win32" || attempt >= 5 || !(error instanceof Error) || !("code" in error) ||
          (error.code !== "EPERM" && error.code !== "EACCES" && error.code !== "EBUSY")) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }`;
const after = "    await rename(temporaryPath, filePath);";
assert.equal(source.split(before).length, 2, "retry source mapping must match exactly once");
const name = "atomic replacement survives a native independent-process Windows sharing denial";
const report = { node: process.version, source_sha256: hash(source), mutation: { id: "M_NO_RENAME_RETRY", source: "src/config.ts", before, after,
  line: source.slice(0, source.indexOf(before)).split("\n").length }, variants: [] };
for (const variant of ["clean-before", "without-retry", "clean-after"]) {
  const directory = path.join(work, variant);
  await mkdir(directory);
  await cp(path.join(runtime, "src"), path.join(directory, "src"), { recursive: true });
  await mkdir(path.join(directory, "scripts"));
  await cp(path.join(runtime, "scripts/check-architecture.mjs"), path.join(directory, "scripts/check-architecture.mjs"));
  await cp(path.join(runtime, "tsconfig.json"), path.join(directory, "tsconfig.json"));
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  await symlink(path.join(runtime, "node_modules"), path.join(directory, "node_modules"), "junction");
  const variantSource = variant === "without-retry" ? source.replace(before, after) : source;
  await writeFile(path.join(directory, "src/config.ts"), variantSource);
  const compile = spawnSync(process.execPath, [path.join(runtime, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    { cwd: directory, encoding: "utf8", timeout: 30_000, windowsHide: true });
  assert.equal(compile.status, 0, `infrastructure: ${variant} must compile first: ${compile.stderr}${compile.stdout}`);
  const result = spawnSync(process.execPath, ["--test", `--test-name-pattern=^${name}$`, "scripts/check-architecture.mjs"],
    { cwd: directory, encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(result.error, undefined, "infrastructure: native test must complete without process errors");
  const output = `${result.stdout}${result.stderr}`;
  await writeFile(path.join(directory, "result.txt"), output);
  if (variant === "without-retry") {
    assert.equal(result.status, 1, "removed retry must fail behavior");
    assert.match(output, new RegExp(`✖ ${name}`));
    assert.match(output, /CONFIG_WRITE_FAILED/);
    assert.match(output, /EPERM: operation not permitted, rename/);
    assert.match(output, /fail 1/);
  } else {
    assert.equal(result.status, 0, `clean native behavior must pass: ${output}`);
    assert.match(output, /pass 1/);
  }
  report.variants.push({ variant, compiled: true, test_exit: result.status, source_sha256: hash(variantSource), output: path.join(directory, "result.txt") });
}
assert.equal(hash(await readFile(sourceFile, "utf8")), report.source_sha256, "production source must remain unchanged");
report.source_unchanged = true;
report.status = "pass";
await writeFile(path.join(work, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${path.join(work, "report.json")}\n`);
