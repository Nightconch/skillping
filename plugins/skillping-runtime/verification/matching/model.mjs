import assert from "node:assert/strict";

export const modelBounds = {
  candidates: 3, batchSize: 2, matchingScoreClasses: [0, 1, 2], matchingThreshold: 2,
  payloadAllowance: 4, finalWrites: 2, replayedReplies: 1,
  externalChanges: "at most one of generation, revision, candidate set, prototype, evidence, disable, cancel, expiry, payload",
  semanticJudgments: "any active candidate, different, uncertain; no semantic oracle"
};

const changes = ["generation", "revision", "catalog", "prototype", "evidence", "disabled", "cancelled", "expired", "payload"];
const first = source => ({
  source, phase: source === "sqwish" ? "numeric" : "main", offset: 0, seen: [0, 0, 0],
  scores: [null, null, null], top: [], winner: 0, spent: 0, change: null,
  finalEvidence: false, lastBatch: [], packet: 0, writes: 0, associations: 0, committed: null
});
const ordered = scores => scores.flatMap((score, index) => score === null ? [] : [{ id: index + 1, score }])
  .sort((a, b) => b.score - a.score || a.id - b.id).slice(0, 2);
const signature = value => JSON.stringify(value);
const fresh = (state, fault) => (state.change === null || fault === `fence-${state.change}`) &&
  (state.spent <= modelBounds.payloadAllowance || fault === "fence-payload");

function violation(state) {
  if (state.seen.some(count => count > 1)) return "SCAN_COVERAGE";
  if (state.offset === modelBounds.candidates && state.seen.some(count => count !== 1)) return "SCAN_COVERAGE";
  if (state.source === "main" && state.scores.some(score => score !== null)) return "FALLBACK_RESTART";
  if (state.source === "sqwish" && signature(state.top) !== signature(ordered(state.scores))) return "NUMERIC_TOP_TWO";
  if (!state.writes) return null;
  if (state.writes > 1) return "COMMIT_ONCE";
  if (state.associations > 1) return "SINGLE_ATTRIBUTION";
  if (!state.committed.complete) return "SCAN_COMPLETE";
  if (!state.committed.fresh) return "FROZEN_COMMIT";
  if (!state.committed.budget) return "SCAN_BUDGET";
  if (state.winner && !state.committed.evidence) return "FINAL_EVIDENCE";
  if (state.source === "sqwish" && state.winner && !state.scores.some(score => score >= modelBounds.matchingThreshold)) return "NUMERIC_THRESHOLD";
  if (state.committed.numericZero && state.scores.some(score => score >= modelBounds.matchingThreshold)) return "NUMERIC_THRESHOLD";
  return null;
}

function successors(state, fault) {
  const result = [];
  const add = (action, apply) => {
    const next = structuredClone(state);
    apply(next);
    result.push({ action, state: next });
  };
  if (!["committed", "stopped"].includes(state.phase) && state.change === null) {
    for (const change of changes) add(`Change(${change})`, next => { next.change = change; });
  }
  if (state.phase === "committed") {
    add("RepeatFinal", next => { if (fault === "duplicate-final") next.writes++; });
    return result;
  }
  if (state.phase === "stopped") return result;
  if (state.spent > modelBounds.payloadAllowance || state.change === "payload") {
    add("BudgetStop", next => { next.phase = "stopped"; });
    if (fault !== "fence-payload") return result;
  }
  if (state.phase === "numeric") {
    const batch = [1, 2, 3].slice(state.offset, state.offset + modelBounds.batchSize);
    const choices = batch.length === 2
      ? modelBounds.matchingScoreClasses.flatMap(a => modelBounds.matchingScoreClasses.map(b => [a, b]))
      : modelBounds.matchingScoreClasses.map(score => [score]);
    for (const scores of choices) add(`Score(${batch.join(",")};${scores.join(",")})`, next => {
      next.spent++;
      for (const [index, id] of batch.entries()) {
        if (fault === "candidate-truncation" && id === modelBounds.candidates) continue;
        next.seen[id - 1]++;
        next.scores[id - 1] = scores[index];
      }
      next.offset += batch.length;
      next.top = ordered(next.scores);
      if (fault === "wrong-top-two") next.top.reverse();
      next.winner = next.top[0]?.score >= modelBounds.matchingThreshold ? next.top[0].id : 0;
      if (fault === "force-positive") next.winner = next.top[0]?.id ?? 0;
      if (next.offset === modelBounds.candidates || fault === "early-complete") {
        next.phase = next.winner ? "evidence" : "ready";
      }
    });
    add("FailedBatchRestartMain", next => {
      next.source = "main";
      next.phase = "main";
      next.offset = 0;
      next.seen = [0, 0, 0];
      next.winner = 0;
      next.top = [];
      if (fault !== "partial-fallback") next.scores = [null, null, null];
    });
  }
  if (state.phase === "main") {
    const capacity = modelBounds.batchSize - Number(state.winner !== 0);
    const batch = [1, 2, 3].slice(state.offset, state.offset + capacity);
    const active = [...(state.winner ? [state.winner] : []), ...batch];
    for (const winner of [0, ...active]) add(`Review(${active.join(",")};${winner ? `same=${winner}` : "different"})`, next => {
      next.spent++;
      for (const id of batch) next.seen[id - 1]++;
      next.offset += batch.length;
      next.winner = winner;
      next.lastBatch = batch;
      next.packet++;
      if (next.offset === modelBounds.candidates || fault === "early-complete") {
        next.phase = winner ? "evidence" : "ready";
      }
    });
    add("ReviewUncertain", next => { next.phase = "stopped"; });
    if (state.lastBatch.length) add("RepeatOldBatchReply", next => {
      if (fault === "replay-batch") for (const id of next.lastBatch) next.seen[id - 1]++;
    });
  }
  if (state.phase === "evidence") {
    if (!state.finalEvidence) add("ReadFinalEvidence", next => { next.finalEvidence = true; next.spent++; });
    if (state.finalEvidence || fault === "missing-evidence") add("ConfirmWinner", next => { next.phase = "ready"; });
    add("FinalUncertain", next => { next.phase = "stopped"; });
  }
  if (state.phase === "ready") add("Commit", next => {
    if (!fresh(next, fault)) { next.phase = "stopped"; return; }
    next.writes++;
    next.associations = next.winner && fault === "multiple-attribution" ? 2 : 1;
    next.phase = "committed";
    next.committed = {
      complete: next.offset === modelBounds.candidates && next.seen.every(count => count === 1),
      fresh: next.change === null || ["expired", "payload"].includes(next.change),
      budget: !["expired", "payload"].includes(next.change) && next.spent <= modelBounds.payloadAllowance,
      evidence: next.finalEvidence,
      numericZero: next.source === "sqwish" && !next.winner
    };
  });
  return result;
}

export function explore(fault = "none") {
  const nodes = ["sqwish", "main"].map(source => ({ state: first(source), parent: -1, action: `Init(${source})` }));
  const seen = new Set(nodes.map(node => signature(node.state)));
  let transitions = 0;
  for (let position = 0; position < nodes.length; position++) {
    const current = nodes[position];
    const rule = violation(current.state);
    if (rule) {
      const trace = [];
      for (let i = position; i >= 0; i = nodes[i].parent) trace.push({ action: nodes[i].action, state: nodes[i].state });
      return { kind: "model-counterexample", fault, rule, exhausted: false, states: seen.size, transitions, trace: trace.reverse() };
    }
    for (const next of successors(current.state, fault)) {
      transitions++;
      const key = signature(next.state);
      if (seen.has(key)) continue;
      seen.add(key);
      nodes.push({ ...next, parent: position });
    }
  }
  return { kind: "model-baseline", fault, rule: null, exhausted: true, states: seen.size, transitions };
}

export function verifyModel() {
  const baseline = explore();
  assert.equal(baseline.exhausted, true, "clean bounded matching model exhausts all states");
  const expected = {
    "early-complete": "SCAN_COMPLETE", "candidate-truncation": "SCAN_COVERAGE", "multiple-attribution": "SINGLE_ATTRIBUTION",
    "duplicate-final": "COMMIT_ONCE", "replay-batch": "SCAN_COVERAGE",
    "partial-fallback": "FALLBACK_RESTART", "wrong-top-two": "NUMERIC_TOP_TWO",
    "force-positive": "NUMERIC_THRESHOLD",
    "missing-evidence": "FINAL_EVIDENCE",
    ...Object.fromEntries(changes.map(change => [`fence-${change}`, ["expired", "payload"].includes(change) ? "SCAN_BUDGET" : "FROZEN_COMMIT"]))
  };
  const faults = Object.entries(expected).map(([fault, rule]) => {
    const counterexample = explore(fault);
    assert.equal(counterexample.rule, rule, `${fault} must fail ${rule}`);
    assert.ok(counterexample.trace.length > 1, `${fault} has an executable abstract trace`);
    return counterexample;
  });
  return [baseline, ...faults];
}

if (process.argv[1] === import.meta.filename) console.log(JSON.stringify(verifyModel()));
