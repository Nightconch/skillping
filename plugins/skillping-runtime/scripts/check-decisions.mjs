import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  DECISION_MAX_BODY_BYTES,
  decideQuestions,
} from "../dist/decisions.js";

const questions = [{ id: "work", criteria: "Contains reusable work." }];
const input = (items = questions, content = "Perform the requested work.") => ({ content, questions: items });
const reply = (answers = { work: { type: "noul", noul: 0.8 } }, overrides = {}) => new Response(JSON.stringify({
  model: "kettei-fat",
  version: "2026-10-20",
  id: "req_abc-123",
  answers,
  usage: { input_tokens: 21, output_tokens: 0, tokenizer: { name: "fixture", revision: "1" } },
  timing_ms: { render: 1, score: 12, load: 0 },
  ...overrides,
}), { headers: { "content-type": "application/json" } });

const options = (fetch) => ({ enabled: true, model: "kettei-fat", apiKey: "test-only-key", timeoutMs: 500, fetch });
const reason = (output, expected) => {
  assert.ok(output.answers.length > 0);
  assert.ok(output.answers.every((answer) => answer.status === "unjudged" && answer.reason === expected));
};

test("empty inputs, disabled decisions and absent credentials never call fetch", async () => {
  const never = async () => { assert.fail("fetch must not run"); };
  const empty = await decideQuestions(input([]), options(never));
  assert.deepEqual(empty, { provider: "sqwish", requestedModel: "kettei-fat", actualModel: null, answers: [] });
  reason(await decideQuestions(input(), { ...options(never), enabled: false }), "disabled");
  reason(await decideQuestions(input(), { ...options(never), apiKey: undefined }), "no_credential");
});

test("one question uses the fixed endpoint, explicit model, criteria and bearer credential", async () => {
  let calls = 0;
  const output = await decideQuestions(input(), options(async (url, init) => {
    calls += 1;
    assert.equal(url, "https://api.sqwish.ai/v1/systemone");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-only-key");
    assert.equal(new Headers(init.headers).get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(init.body), {
      model: "kettei-fat",
      state: "Perform the requested work.",
      questions: { work: { type: "noul", instructions: "Contains reusable work." } },
    });
    return reply();
  }));
  assert.equal(calls, 1);
  assert.deepEqual(output, {
    provider: "sqwish", requestedModel: "kettei-fat", actualModel: "kettei-fat",
    modelVersion: "2026-10-20", requestId: "req_abc-123",
    answers: [{ id: "work", status: "judged", yesProbability: 0.8 }],
  });
});

test("multiple independent probabilities include both endpoints and preserve input order", async () => {
  const items = [
    { id: "zero", criteria: "A." },
    { id: "one", criteria: "B." },
    { id: "low", criteria: "C." },
  ];
  const output = await decideQuestions(input(items), options(async () => reply({
    one: { type: "noul", noul: 1 },
    low: { type: "noul", noul: 0.01 },
    zero: { type: "noul", noul: 0 },
  })));
  assert.deepEqual(output.answers, [
    { id: "zero", status: "judged", yesProbability: 0 },
    { id: "one", status: "judged", yesProbability: 1 },
    { id: "low", status: "judged", yesProbability: 0.01 },
  ]);
});

test("duplicate IDs are rejected before sending", async () => {
  const output = await decideQuestions(input([questions[0], questions[0]]), options(async () => assert.fail("fetch must not run")));
  reason(output, "invalid");
  assert.equal(output.answers.length, 2);
});

test("five questions are accepted and a sixth is rejected without a request", async () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, criteria: "Independent criterion." }));
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return reply(Object.fromEntries(five.map(({ id }) => [id, { type: "noul", noul: 0.3 }])));
  };
  assert.equal((await decideQuestions(input(five), options(fetch))).answers.filter((answer) => answer.status === "judged").length, 5);
  reason(await decideQuestions(input([...five, { id: "q5", criteria: "Sixth." }]), options(fetch)), "limit");
  assert.equal(calls, 1);
});

test("the complete UTF-8 JSON body is bounded and never truncated", async () => {
  const small = { model: "kettei-fat", state: "", questions: { work: { type: "noul", instructions: questions[0].criteria } } };
  const overhead = Buffer.byteLength(JSON.stringify(small));
  const content = "x".repeat(DECISION_MAX_BODY_BYTES - overhead);
  let calls = 0;
  const fetch = async (_url, init) => {
    calls += 1;
    assert.equal(Buffer.byteLength(init.body), DECISION_MAX_BODY_BYTES);
    assert.equal(JSON.parse(init.body).state, content);
    return reply();
  };
  assert.equal((await decideQuestions(input(questions, content), options(fetch))).answers[0].status, "judged");
  reason(await decideQuestions(input(questions, `${content}x`), options(fetch)), "limit");
  reason(await decideQuestions(input([{ id: "work", criteria: "中".repeat(DECISION_MAX_BODY_BYTES / 2) }]), options(fetch)), "limit");
  reason(await decideQuestions(input(questions, "中".repeat(DECISION_MAX_BODY_BYTES / 2)), options(fetch)), "limit");
  assert.equal(calls, 1);
});

test("malformed, coerced, non-finite and out-of-range probabilities are never judged", async (t) => {
  const malformed = ["0.7", null, true, {}, [], -0.01, 1.01];
  for (const noul of malformed) {
    await t.test(JSON.stringify(noul), async () => reason(await decideQuestions(input(), options(async () => reply({ work: { type: "noul", noul } }))), "invalid"));
  }
  for (const numeral of ["1e999", "-1e999", "NaN", "Infinity", "-Infinity"]) {
    await t.test(numeral, async () => reason(await decideQuestions(input(), options(async () => new Response(`{"model":"kettei-fat","answers":{"work":{"type":"noul","noul":${numeral}}}}`))), "invalid"));
  }
  for (const answer of [{ noul: 0.8 }, { type: "choice", noul: 0.8 }, { type: "noul" }, null, false, 0.8]) {
    await t.test(`answer ${JSON.stringify(answer)}`, async () => reason(await decideQuestions(input(), options(async () => reply({ work: answer }))), "invalid"));
  }
});

test("partial valid answers remain diagnostic while missing and defensive refusal answers stay unjudged", async () => {
  const items = [
    { id: "work", criteria: "A." },
    { id: "missing", criteria: "B." },
    { id: "refused", criteria: "C." },
    { id: "invalid", criteria: "D." },
  ];
  const output = await decideQuestions(input(items), options(async () => reply({
    work: { type: "noul", noul: 0.8 },
    refused: { type: "refusal" },
    invalid: { type: "score", score: 0.8 },
  })));
  assert.deepEqual(output.answers, [
    { id: "work", status: "judged", yesProbability: 0.8 },
    { id: "missing", status: "unjudged", reason: "missing" },
    { id: "refused", status: "unjudged", reason: "refusal" },
    { id: "invalid", status: "unjudged", reason: "invalid" },
  ]);
});

test("unexpected IDs and malformed answer containers invalidate the whole formal result", async (t) => {
  for (const answers of [
    { work: { type: "noul", noul: 0.8 }, unexpected: { type: "noul", noul: 0.2 } },
    { work: { type: "noul", noul: 0.8 }, "": { type: "noul", noul: 0.2 } },
    Object.fromEntries([["work", { type: "noul", noul: 0.8 }], ["__proto__", { type: "noul", noul: 0.2 }]]),
    [], null, "answers",
  ]) {
    await t.test(JSON.stringify(answers), async () => reason(await decideQuestions(input(), options(async () => reply(answers))), "invalid"));
  }
});

test("actual model is required, validated and never substituted from the request", async (t) => {
  for (const model of [undefined, null, 42, "", "jev", "kettei-lite", "kettei-fat\nprivate"]) {
    await t.test(String(model), async () => {
      const output = await decideQuestions(input(), options(async () => reply(undefined, { model })));
      reason(output, "invalid");
      assert.equal(output.requestedModel, "kettei-fat");
      assert.equal(output.actualModel, ["jev", "kettei-lite"].includes(model) ? model : null);
    });
  }
});

test("optional diagnostic metadata cannot invalidate business answers and safe metadata is bounded", async () => {
  const omitted = await decideQuestions(input(), options(async () => reply(undefined, { version: undefined, id: undefined })));
  assert.equal(omitted.answers[0].status, "judged");
  assert.equal("modelVersion" in omitted, false);
  assert.equal("requestId" in omitted, false);
  for (const overrides of [{ version: 2 }, { id: 2 }]) {
    const output = await decideQuestions(input(), options(async () => reply(undefined, overrides)));
    assert.equal(output.actualModel, "kettei-fat");
    assert.equal(output.answers[0].status, "judged");
    assert.equal("version" in overrides ? "modelVersion" in output : "requestId" in output, false);
  }
  for (const overrides of [{ version: null, id: {} }, { version: [], id: false }]) {
    const output = await decideQuestions(input(), options(async () => reply(undefined, overrides)));
    assert.equal(output.answers[0].status, "judged");
    assert.equal("modelVersion" in output, false);
    assert.equal("requestId" in output, false);
  }
  const unsafe = await decideQuestions(input(), options(async () => reply(undefined, { version: "x".repeat(129), id: "secret\ntext" })));
  assert.equal("modelVersion" in unsafe, false);
  assert.equal("requestId" in unsafe, false);
  assert.equal(JSON.stringify(unsafe).includes("secret"), false);
});

test("HTTP and network failures perform no retry and expose no provider error details", async () => {
  for (const failed of [async () => new Response("private vendor error", { status: 429 }), async () => { throw new Error("private network detail"); }]) {
    let calls = 0;
    const output = await decideQuestions(input(), options(async () => { calls += 1; return failed(); }));
    reason(output, "request_failed");
    assert.equal(calls, 1);
    assert.equal(output.actualModel, null);
    assert.equal(JSON.stringify(output).includes("private"), false);
  }
});

test("invalid JSON and missing envelopes are invalid responses", async () => {
  for (const body of ["not JSON", "null", "[]", '{}', '{"model":"kettei-fat"}']) {
    reason(await decideQuestions(input(), options(async () => new Response(body))), "invalid");
  }
});

test("deadline includes body reading even when the response stream ignores abort", async () => {
  let capturedSignal;
  const pendingBody = new ReadableStream({ start() {} });
  const pending = decideQuestions(input(), {
    ...options(async (_url, init) => { capturedSignal = init.signal; return new Response(pendingBody); }),
    timeoutMs: 15,
  });
  const output = await Promise.race([pending, delay(300).then(() => { assert.fail("body deadline did not return"); })]);
  reason(output, "timeout");
  assert.equal(capturedSignal.aborted, true);
});

test("caller abort completes even when fetch ignores its signal", async () => {
  const controller = new AbortController();
  let capturedSignal;
  const pending = decideQuestions(input(), {
    ...options(async (_url, init) => { capturedSignal = init.signal; return new Promise(() => {}); }),
    signal: controller.signal,
  });
  controller.abort(new Error("private caller reason"));
  const output = await Promise.race([pending, delay(300).then(() => { assert.fail("caller abort did not return"); })]);
  reason(output, "request_failed");
  assert.equal(capturedSignal.aborted, true);
  assert.equal(JSON.stringify(output).includes("private"), false);
});

test("already aborted callers never send a request", async () => {
  const controller = new AbortController();
  controller.abort();
  reason(await decideQuestions(input(), { ...options(async () => assert.fail("fetch must not run")), signal: controller.signal }), "request_failed");
});

test("a fetch that resolves after cancellation has its response cancelled without reading it", async () => {
  const release = Promise.withResolvers();
  let cancelled = false;
  let streamController;
  const body = new ReadableStream({ start(controller) { streamController = controller; }, cancel() { cancelled = true; } });
  const output = await decideQuestions(input(), { ...options(async () => { await release.promise; return new Response(body); }), timeoutMs: 10 });
  reason(output, "timeout");
  release.resolve();
  await delay(10);
  try { assert.equal(cancelled, true); } finally { if (!cancelled) streamController.close(); }
});

test("unbounded or invalid timeout settings do not send requests", async () => {
  for (const timeoutMs of [0, -1, 0.5, Infinity, NaN, 2_147_483_648]) {
    reason(await decideQuestions(input(), { ...options(async () => assert.fail("fetch must not run")), timeoutMs }), "invalid");
  }
});

test("oversized response bodies are rejected before parsing", async () => {
  reason(await decideQuestions(input(), options(async () => reply(undefined, { usage: "x".repeat(65_536) }))), "limit");
});

test("streaming byte limits stop an oversized body before buffering or waiting for its end", async () => {
  let cancelled = false;
  let chunks = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (chunks++ < 3) { await delay(1); controller.enqueue(new Uint8Array(32 * 1024)); }
      else await new Promise(() => {});
    },
    cancel() { cancelled = true; },
  });
  const output = await decideQuestions(input(), { ...options(async () => new Response(body)), timeoutMs: 100 });
  reason(output, "limit");
  assert.equal(cancelled, true);
});
