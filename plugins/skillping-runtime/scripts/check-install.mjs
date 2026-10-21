import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { configureDecisionModel } from "../dist/config.js";

const workspace = path.resolve(import.meta.dirname, "../../..");
const runtime = path.resolve(import.meta.dirname, "..");
const KEY = "fixture-install-key-\u00e9";

test("install entry configures the real Runtime and preserves existing data", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "skillping-install-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("skillping-install-"));
    await rm(root, { recursive: true, force: true });
  });
  const pluginRoot = path.join(root, "Runtime with spaces");
  const bundle = path.join(pluginRoot, "dist/mcp/server.bundle.js");
  await mkdir(path.dirname(bundle), { recursive: true });
  await cp(path.join(runtime, "plugin.json"), path.join(pluginRoot, "plugin.json"));
  await build({ entryPoints: [path.join(runtime, "dist/mcp/server.js")], outfile: bundle,
    bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
  const configure = (dataDir, key, args = ["--configure-key"]) => {
    const result = spawnSync(process.execPath, [bundle, ...args], {
      env: { ...process.env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: dataDir }, input: key, encoding: "utf8", timeout: 15_000
    });
    assert.equal(result.error, undefined);
    assert.ok(!(result.stdout + result.stderr).includes(KEY));
    return result;
  };
  const directory = async name => {
    const dir = path.join(root, name);
    await mkdir(dir);
    return dir;
  };
  const readConfig = async dir => JSON.parse(await readFile(path.join(dir, "config.json"), "utf8"));

  await t.test("blank input skips initialization", async () => {
    const dir = await directory("blank");
    for (const key of ["", " \r\n\t"]) {
      const result = configure(dir, key);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), "SKILLPING_KEY_SKIPPED");
      assert.deepEqual(await readdir(dir), []);
    }
    await configureDecisionModel(path.join(root, "absent"), "  ");
    assert.ok(!(await readdir(root)).includes("absent"));
  });

  await t.test("fresh setup, rotation, idempotence and tuned values", async () => {
    const dir = await directory("configured");
    assert.equal(configure(dir, ` ${KEY}\r\n`).status, 0);
    let config = await readConfig(dir);
    assert.deepEqual(config.decision_model, { enabled: true, allow_external: true, provider: "sqwish",
      model: "kettei-fat", api_key: KEY, precheck_timeout_ms: 5000, match_timeout_ms: 5000,
      existence: { threshold: 0.5 }, matching: { threshold: 0.5 } });
    assert.equal(config.decision_revision, 1);
    assert.ok(!(await readdir(dir)).includes("scout.sqlite"));
    assert.ok(!(await readdir(dir)).includes("key.dpapi"));
    config.recommendation_pace = "cautious";
    config.detection_enabled = false;
    config.unrelated_setting = { retained: true };
    Object.assign(config.decision_model, { precheck_timeout_ms: 2200, match_timeout_ms: 8700,
      existence: { threshold: 0.72 }, matching: null });
    await writeFile(path.join(dir, "config.json"), JSON.stringify(config));
    await writeFile(path.join(dir, "scout.sqlite"), "existing-records");
    await writeFile(path.join(dir, "key.dpapi"), "existing-data-key");
    assert.equal(configure(dir, `${KEY}-rotated`).status, 0);
    const rotated = await readConfig(dir);
    assert.deepEqual(rotated, { ...config, decision_revision: 2,
      decision_model: { ...config.decision_model, api_key: `${KEY}-rotated`, matching: { threshold: 0.5 } } });
    const bytes = await readFile(path.join(dir, "config.json"), "utf8");
    assert.equal(configure(dir, `${KEY}-rotated`).status, 0);
    assert.equal(await readFile(path.join(dir, "config.json"), "utf8"), bytes);
    assert.equal(configure(dir, " \t ").status, 0);
    assert.equal(await readFile(path.join(dir, "config.json"), "utf8"), bytes);
    assert.equal(await readFile(path.join(dir, "scout.sqlite"), "utf8"), "existing-records");
    assert.equal(await readFile(path.join(dir, "key.dpapi"), "utf8"), "existing-data-key");
    for (const file of await readdir(dir)) if (file !== "config.json") {
      assert.ok(!(await readFile(path.join(dir, file))).includes(Buffer.from(KEY)));
    }
  });

  await t.test("invalid config, unknown args and oversized input fail without secrets", async () => {
    const dir = await directory("invalid");
    const original = `{"secret":"${KEY}",invalid`;
    await writeFile(path.join(dir, "config.json"), original);
    const failed = configure(dir, KEY);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /CONFIGURE_FAILED/);
    assert.equal(await readFile(path.join(dir, "config.json"), "utf8"), original);
    const unknown = configure(dir, "", ["--configure-key", KEY]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /INVALID_ARGUMENTS/);
    const oversizedDir = await directory("oversized");
    assert.equal(configure(oversizedDir, "x".repeat(65_537)).status, 1);
    assert.deepEqual(await readdir(oversizedDir), []);
  });

  await t.test("PowerShell installation entry uses masked input and fixed bundled writer", {
    skip: process.platform !== "win32" ? "Windows PowerShell installer" : false
  }, async t => {
    const localRoot = await directory("local source with spaces");
    const installer = path.join(localRoot, "install.ps1");
    await cp(path.join(workspace, "install.ps1"), installer);
    await mkdir(path.join(localRoot, ".agents/plugins"), { recursive: true });
    await writeFile(path.join(localRoot, ".agents/plugins/marketplace.json"), "{}");
    for (const scenario of ["local", "downloaded", "blank", "whitespace", "native-failure", "runtime-failure", "plugin-failure", "descriptor-mismatch", "child-failure"]) {
      await t.test(scenario, async () => {
        const dir = await directory(`ps-${scenario}`);
        const descriptor = { name: "skillping", enabled: true, transport: { type: "stdio", command: "node",
          args: [scenario === "descriptor-mismatch" ? path.join(pluginRoot, "wrong.js") : bundle],
          cwd: pluginRoot, env: { PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: dir } } };
        if (scenario === "child-failure") await writeFile(path.join(dir, "config.json"), "invalid-original");
        let keptConfig;
        if (scenario === "whitespace") {
          assert.equal(configure(dir, `${KEY}-kept`).status, 0);
          keptConfig = await readFile(path.join(dir, "config.json"), "utf8");
        }
        const key = scenario === "blank" ? "" : scenario === "whitespace" ? "   " : KEY;
        const quote = value => `'${value.replaceAll("'", "''")}'`;
        const log = path.join(dir, "calls.jsonl");
        const wrapper = path.join(dir, "drive.ps1");
        await writeFile(wrapper, `\uFEFF
$ErrorActionPreference = 'Stop'
$marketplace = 'caller-scope'
function codex {
    Add-Content -LiteralPath ${quote(log)} -Value (ConvertTo-Json -Compress -InputObject @($args))
    $global:LASTEXITCODE = 0
    if (${quote(scenario)} -eq 'native-failure' -and $args[0] -eq 'plugin') { $global:LASTEXITCODE = 7; return }
    if (${quote(scenario)} -eq 'runtime-failure' -and $args[2] -eq 'skillping-runtime@skillping') { $global:LASTEXITCODE = 7; return }
    if (${quote(scenario)} -eq 'plugin-failure' -and $args[2] -eq 'skillping@skillping') { $global:LASTEXITCODE = 7; return }
    if ($args[0] -eq 'mcp') { ${quote(JSON.stringify(descriptor))} }
}
function Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    if (-not $AsSecureString) { throw 'INPUT_NOT_MASKED' }
    $secure = New-Object Security.SecureString
    foreach ($character in ${quote(key)}.ToCharArray()) { $secure.AppendChar($character) }
    $secure
}
try {
    ${scenario === "downloaded" ? `Invoke-Expression ([IO.File]::ReadAllText(${quote(installer)}))` : `& ${quote(installer)}`}
    if ($marketplace -ne 'caller-scope') { throw 'SCOPE_LEAKED' }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`);
        const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper], {
          encoding: "utf8", timeout: 45_000, cwd: localRoot
        });
        assert.equal(result.error, undefined);
        assert.ok(!(result.stdout + result.stderr).includes(KEY));
        const calls = (await readFile(log, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
        assert.ok(!JSON.stringify(calls).includes(KEY));
        const failed = ["native-failure", "runtime-failure", "plugin-failure", "descriptor-mismatch", "child-failure"].includes(scenario);
        assert.equal(result.status, failed ? 1 : 0, result.stdout + result.stderr);
        assert.deepEqual(calls[0], ["plugin", "marketplace", "add", scenario === "downloaded" ? "Nightconch/skillping" : localRoot]);
        if (scenario === "native-failure") {
          assert.equal(calls.length, 1);
          assert.ok(!result.stdout.includes("Sqwish API Key"));
        } else if (scenario === "runtime-failure" || scenario === "plugin-failure") {
          assert.equal(calls.length, scenario === "runtime-failure" ? 2 : 3);
          assert.ok(!result.stdout.includes("Sqwish API Key"));
        } else {
          assert.deepEqual(calls[1], ["plugin", "add", "skillping-runtime@skillping"]);
          assert.deepEqual(calls[2], ["plugin", "add", "skillping@skillping"]);
          assert.equal(calls.length, ["blank", "whitespace"].includes(scenario) ? 3 : 4);
        }
        if (failed) {
          assert.ok(!result.stdout.includes("Key saved"));
          assert.ok(!result.stdout.includes("SkillPing installed."));
        } else if (["blank", "whitespace"].includes(scenario)) {
          if (scenario === "whitespace") assert.equal(await readFile(path.join(dir, "config.json"), "utf8"), keptConfig);
          else assert.ok(!(await readdir(dir)).includes("config.json"));
          assert.match(result.stdout, /setup skipped/);
        } else {
          assert.equal((await readConfig(dir)).decision_model.api_key, KEY);
          assert.match(result.stdout, /Key saved/);
        }
        if (scenario === "child-failure") assert.equal(await readFile(path.join(dir, "config.json"), "utf8"), "invalid-original");
      });
    }
  });
});
