import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const NOW = 1_792_454_400_000;
const controls = async () => ({ detectionEnabled: true, recommendationEnabled: false });
const prototype = { core_goal: "Implement an approved change and verify the resulting program",
  input_roles: ["Approved design", "Runnable code"], output: "Verified program",
  essential_steps: ["Inspect dependencies", "Implement changes", "Verify behavior"], variable_slots: [], scope: "global" };

function check(rule, condition, message) {
  if (condition) return;
  const error = new Error(`${rule}: ${message}`);
  error.rule = rule;
  throw error;
}

async function fixture(buildRoot, events, count = 7) {
  const { openStorage } = await import(pathToFileURL(path.join(buildRoot, "dist", "storage.js")));
  const root = await mkdtemp(path.join(tmpdir(), "skillping-matching-"));
  const filename = path.join(root, "scout.sqlite");
  const store = await openStorage({ filename, now: () => NOW });
  const db = new DatabaseSync(filename);
  for (let i = 0; i < count; i++) db.prepare(`INSERT INTO workflows
    (scope_kind,scope_value,state,prototype_json,prototype_version,representatives_json,last_seen_at,suppression,created_at,updated_at)
    VALUES('global',NULL,'confirmed',?,3,'[]',?,'none',?,?)`).run(JSON.stringify(prototype), NOW, NOW, NOW);
  const value = { codex_task_id: "matching-task", turn_id: "matching-turn", message_id: "", source: "realtime",
    occurred_at: NOW, expires_at: NOW + 30 * 86_400_000, workspace_path: "E:/fixture/workspace",
    prompt: "Please carry out the supplied independent operation with its requested checks.", recommendation_enabled: false,
    observations: [{ relation: "new", confidence: "high", fingerprint: prototype,
      capabilities: [{ ...prototype, confidence: "high" }] }] };
  const edges = () => db.prepare("SELECT workflow_id,episode_id FROM episode_workflows ORDER BY workflow_id,episode_id").all();
  const log = action => events.push({ action, edges: edges() });
  const start = async outcome => {
    const plan = await store.prepareDecisionMatch(value, controls);
    check("FIXTURE", !!plan, "prepared current realtime decision protocol");
    return { plan, result: await store.finalizeDecisionMatch(plan.token, outcome, controls) };
  };
  const page = async (packet, id) => {
    const request = packet.requests[0];
    const context = { review_set_id: packet.review_set_id, request_id: request.request_id };
    let current = await store.getReviewEvidence({ ...context, workflow_id: id }, controls);
    check("FIXTURE", current.status === "ok", "selected frozen detail is readable");
    while (current.has_more) {
      current = await store.getReviewEvidence({ ...context, workflow_id: id, cursor: current.next_cursor }, controls);
      check("FIXTURE", current.status === "ok", "selected remaining evidence is readable");
    }
  };
  const reply = (packet, winner) => ({ phase: "review", schema_version: 3,
    session_id: value.codex_task_id, turn_id: value.turn_id, review_set_id: packet.review_set_id,
    decisions: [{ request_id: packet.requests[0].request_id, kind: "capability",
      review_reason: packet.requests[0].review_reason, verdict: winner ? "same" : "different",
      ...(winner ? { selected_workflow_id: winner } : {}) }] });
  const finish = async () => {
    store.close();
    db.close();
    check("FIXTURE", path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith("skillping-matching-"), "isolated data directory");
    await rm(root, { recursive: true, force: true });
  };
  return { store, db, edges, log, start, page, reply, finish };
}

export const scenarioNames = ["catalog-coverage", "single-attribution", "main-complete-once", "early-association", "whole-snapshot"];

export async function runScenario(buildRoot, name) {
  const events = [];
  let data;
  try {
    check("FIXTURE", scenarioNames.includes(name), "known matching scenario");
    data = await fixture(buildRoot, events);
    if (name === "catalog-coverage") {
      const plan = await data.store.prepareDecisionMatch({ codex_task_id: "coverage-task", turn_id: "coverage-turn", message_id: "",
        source: "realtime", occurred_at: NOW, expires_at: NOW + 86_400_000, prompt: "Apply the requested operation independently.",
        observations: [{ relation: "new", fingerprint: prototype, capabilities: [{ ...prototype, confidence: "high" }] }] }, controls);
      check("SCAN_COVERAGE", plan?.candidates.length === 7 && new Set(plan.candidates.map(candidate => candidate.workflow_id)).size === 7,
        "all seven eligible identities are frozen once");
      check("SCAN_COMPLETE", data.edges().length === 0 && data.db.prepare("SELECT COUNT(*) AS n FROM prompts").get().n === 0,
        "preparation remains read-only");
      data.log("prepare all seven");
    } else if (name === "single-attribution") {
      let rejected = false;
      try { await data.start({ source: "decision_model", matchedWorkflowIds: [1, 2] }); }
      catch { rejected = true; }
      check("SINGLE_ATTRIBUTION", rejected && data.edges().length === 0, "multiple selected IDs are rejected before any association");
      data.log("reject multiple IDs");
    } else {
      const started = await data.start({ source: "main_model_fallback" });
      let packet = started.result?.review?.payload;
      check("FIXTURE", packet?.status === "review_required", "main fallback starts review");
      const winner = name === "main-complete-once" ? 7 : 1;
      let replies = 0;
      const seen = new Set();
      while (packet?.status === "review_required" && packet.requests[0].scan?.phase === "scan") {
        const request = packet.requests[0];
        check("SCAN_COVERAGE", request.catalog.items.length <= 5, "bounded active candidate batch");
        for (const candidate of request.catalog.items) seen.add(candidate.workflow_id);
        const selected = request.catalog.items.some(candidate => candidate.workflow_id === winner) ? winner
          : name === "main-complete-once" ? request.catalog.items[0].workflow_id : 1;
        await data.page(packet, selected);
        const submitted = data.reply(packet, selected);
        const next = await data.store.resolveReview(submitted, controls);
        replies++;
        check("SCAN_COMPLETE", data.edges().length === 0, "intermediate batch never creates a contribution");
        if (name === "early-association") {
          check("SCAN_COMPLETE", next?.status === "review_required", "first batch advances without committing");
          data.log("one provisional batch with no association");
          break;
        }
        check("FIXTURE", next?.status === "review_required", "valid scan advances to another packet");
        const replay = await data.store.resolveReview(submitted, controls);
        check("COMMIT_ONCE", replay === false && data.edges().length === 0, "replayed old packet does not advance or commit");
        packet = next;
        check("FIXTURE", replies <= 4, "finite concrete scan");
      }
      if (name !== "early-association") {
        check("SCAN_COVERAGE", seen.size === 7 && packet.requests[0].scan?.phase === "final", "full traversal precedes final evidence");
        await data.page(packet, winner);
        if (name === "whole-snapshot") data.db.prepare("UPDATE workflows SET prototype_version=1 WHERE id=2").run();
        const submitted = data.reply(packet, winner);
        const result = await data.store.resolveReview(submitted, controls);
        if (name === "whole-snapshot") {
          check("FROZEN_COMMIT", result === "stale" && data.edges().length === 0, "nonwinner snapshot change prevents final commit");
          data.log("nonwinner change rejected");
        } else {
          check("SINGLE_ATTRIBUTION", result === true && data.edges().length === 1 && data.edges()[0].workflow_id === winner,
            "seventh candidate is the sole final attribution");
          const replay = await data.store.resolveReview(submitted, controls);
          check("COMMIT_ONCE", replay === false && data.edges().length === 1, "duplicate final writes no additional contribution");
          data.log("final winner seven committed once");
        }
      }
    }
    return { kind: "pass", scenario: name, events };
  } catch (error) {
    return { kind: error.rule && error.rule !== "FIXTURE" ? "invariant-failed" : "incomplete",
      scenario: name, rule: error.rule ?? null, message: error.message, stack: error.stack, events };
  } finally { await data?.finish(); }
}

if (process.argv[1] === import.meta.filename) {
  const result = await runScenario(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result));
  process.exitCode = result.kind === "pass" ? 0 : 1;
}
