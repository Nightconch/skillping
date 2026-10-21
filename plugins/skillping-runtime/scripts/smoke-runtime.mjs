import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = await mkdtemp(path.join(tmpdir(), "skillping-smoke-"));
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath,
  args: [path.join(pluginRoot, "dist/mcp/server.bundle.js")],
  env: { PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: root }, stderr: "pipe" });
const client = new Client({ name: "skillping-local-smoke", version: "1.0.0" });
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
};
try {
  await client.connect(transport);
  const runtimeManifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8"));
  const skillManifest = JSON.parse(await readFile(path.join(pluginRoot, "../skillping/.codex-plugin/plugin.json"), "utf8"));
  assert.match(runtimeManifest.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(skillManifest.version, runtimeManifest.version);
  assert.deepEqual(client.getServerVersion(), { name: "skillping-runtime", version: runtimeManifest.version });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [
    "claim_dispatch", "control", "finish_recommendation", "get_review_evidence", "observe_turn", "stage_prompt"
  ]);
  const staged = await call("stage_prompt", { session_id: "smoke-task", turn_id: "smoke-turn",
    prompt: "Create a reusable validation procedure and verify its boundary cases.", cwd: pluginRoot, model: "local-smoke" });
  assert.equal(staged.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.ok(staged.hookSpecificOutput.additionalContext.includes('turn_id="smoke-turn"'));
  assert.deepEqual(await call("observe_turn", { phase: "extract", schema_version: 2,
    session_id: "smoke-task", turn_id: "smoke-turn", disposition: "analyze", items: [] }),
  { status: "invalid", code: "INVALID_INPUT", retry_allowed: true });
  assert.deepEqual(await call("observe_turn", { phase: "extract", schema_version: 6,
    session_id: "smoke-task", turn_id: "smoke-turn", disposition: "skip", items: [] }), { status: "accepted", disposition: "skip" });
  const config = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"));
  assert.equal(Object.hasOwn(config, "versions"), false);
  assert.equal(config.decision_model.enabled, false);
  assert.equal(config.decision_model.allow_external, false);
  assert.equal(config.decision_model.api_key, "");
  assert.equal(config.decision_model.existence, null);
  assert.equal(config.decision_model.matching, null);
  assert.equal(config.decision_model.precheck_timeout_ms, 5000);
  const hooks = JSON.parse(await readFile(path.join(pluginRoot, "../skillping/hooks/hooks.json"), "utf8"));
  assert.ok(hooks.hooks.UserPromptSubmit[0].hooks[0].timeout * 1000 > config.decision_model.precheck_timeout_ms);
  await call("control", { command: "disable_detection" });
  assert.deepEqual(await call("stage_prompt", { session_id: "smoke-task", turn_id: "disabled-turn",
    prompt: "Build a reusable workflow.", cwd: pluginRoot, model: "local-smoke" }), {});
  console.log(`MCP bundle smoke passed. Numeric release ${runtimeManifest.version}, matching plugin versions, retired transport rejection, v6 recovery, controls and disabled decision defaults verified.`);
} finally {
  await client.close();
  await transport.close();
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith("skillping-smoke-"));
  await rm(root, { recursive: true, force: true });
}
