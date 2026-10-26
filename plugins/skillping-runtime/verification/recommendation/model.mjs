import assert from "node:assert/strict";

export const modelBounds = { workflows: 2, taskTurnIdentities: 2, requestsPerWorkflow: 1,
  ageClasses: ["fresh", "expired"], outcomes: ["unavailable", "completed", "baseline"],
  evidenceAndEligibility: "eligible or invalidated", frozenPrototype: "same or changed", controls: "enabled or disabled" };

const initial = () => ({ enabled: true, turnClaims: [0, 0], workflows: Array.from({ length: 2 }, () => ({
  phase: "pending", turn: null, expired: false, evidence: true, frozen: true,
  receipt: null, cooldown: false, silence: false, writes: 0,
  eligibleAtCommit: null, freshAtCommit: null, frozenAtCommit: null
})) });

function violated(state) {
  if (state.turnClaims.some(count => count > 1)) return "ONE_CLAIM_PER_TURN";
  for (const item of state.workflows) {
    if (item.writes && !item.eligibleAtCommit) return "FINAL_ELIGIBILITY";
    if (item.writes && !item.frozenAtCommit) return "FINAL_ELIGIBILITY";
    if (item.writes && !item.freshAtCommit) return "WEB_EXPIRY";
    if (item.receipt === "baseline" && !item.silence) return "BASELINE_SILENCE";
    if (item.writes > 1 || (item.phase === "dispatched") !== (item.receipt !== null)) return "COMPLETION_ATOMICITY";
    if (item.receipt === "completed" && (!item.cooldown || item.silence)) return "COMPLETION_ATOMICITY";
    if (item.receipt === "baseline" && item.cooldown) return "COMPLETION_ATOMICITY";
    if (["failed", "cancelled"].includes(item.phase) && (item.receipt || item.cooldown || item.silence)) return "COMPLETION_ATOMICITY";
  }
  return null;
}

function successors(state, fault) {
  const result = [];
  const change = (action, apply) => {
    const next = structuredClone(state);
    apply(next);
    result.push({ action, state: next });
  };
  change(state.enabled ? "Disable" : "Enable", next => { next.enabled = !next.enabled; });
  for (let w = 0; w < 2; w++) {
    const item = state.workflows[w];
    if (item.evidence) change(`InvalidateEvidence(${w})`, next => { next.workflows[w].evidence = false; });
    if (item.frozen) change(`ChangePrototype(${w})`, next => { next.workflows[w].frozen = false; });
    if (item.phase === "pending" && state.enabled && item.evidence) for (let turn = 0; turn < 2; turn++) {
      if (state.turnClaims[turn] && fault !== "turn-receipt") continue;
      change(`Claim(${w},${turn})`, next => {
        next.turnClaims[turn]++;
        next.workflows[w].phase = "dispatching";
        next.workflows[w].turn = turn;
        next.workflows[w].frozen = true;
      });
    }
    if (item.phase !== "dispatching") continue;
    if (!item.expired) change(`Expire(${w})`, next => { next.workflows[w].expired = true; });
    change(`Stop(${w})`, next => { next.workflows[w].phase = "failed"; });
    for (const outcome of ["unavailable", "completed", "baseline"]) change(`Finish(${w},${outcome})`, next => {
      const current = next.workflows[w];
      if ((current.expired && fault !== "expiry") || outcome === "unavailable") { current.phase = "failed"; return; }
      if (!next.enabled || (!current.evidence && fault !== "evidence") || (!current.frozen && fault !== "prototype")) {
        current.phase = "cancelled";
        return;
      }
      current.phase = "dispatched";
      current.receipt = outcome;
      current.writes++;
      current.eligibleAtCommit = next.enabled && current.evidence;
      current.frozenAtCommit = current.frozen;
      current.freshAtCommit = !current.expired;
      current.cooldown = outcome === "completed" && fault !== "cooldown";
      current.silence = outcome === "baseline" && fault !== "silence";
    });
  }
  return result;
}

export function explore(fault = "none") {
  const first = initial();
  const key = state => JSON.stringify(state);
  const nodes = [{ state: first, parent: -1, action: "Init" }];
  const seen = new Set([key(first)]);
  let transitions = 0;
  for (let position = 0; position < nodes.length; position++) {
    const current = nodes[position];
    const rule = violated(current.state);
    if (rule) {
      const trace = [];
      for (let i = position; i >= 0; i = nodes[i].parent) trace.push({ action: nodes[i].action, state: nodes[i].state });
      return { kind: "model-counterexample", fault, exhausted: false, rule, states: seen.size, transitions, trace: trace.reverse() };
    }
    for (const next of successors(current.state, fault)) {
      transitions++;
      const identity = key(next.state);
      if (seen.has(identity)) continue;
      seen.add(identity);
      nodes.push({ ...next, parent: position });
    }
  }
  return { kind: "model-baseline", fault, exhausted: true, rule: null, states: seen.size, transitions };
}

export function verifyModel() {
  const results = [explore()];
  assert.equal(results[0].exhausted, true, "bounded baseline must exhaust the queue");
  for (const [fault, rule] of Object.entries({ "turn-receipt": "ONE_CLAIM_PER_TURN", evidence: "FINAL_ELIGIBILITY",
    prototype: "FINAL_ELIGIBILITY", expiry: "WEB_EXPIRY", cooldown: "COMPLETION_ATOMICITY", silence: "BASELINE_SILENCE" })) {
    const result = explore(fault);
    assert.equal(result.rule, rule, `model fault ${fault} must violate its designated rule`);
    assert.ok(result.trace.length > 1);
    results.push(result);
  }
  return results;
}

if (process.argv[1] === import.meta.filename) console.log(JSON.stringify(verifyModel()));
