import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { runScenario, scenarioNames } from "../verification/recommendation/real-code.mjs";
import { verifyModel } from "../verification/recommendation/model.mjs";

test("bounded web recommendation model exhausts states and detects its faulty transitions", () => {
  assert.equal(verifyModel()[0].exhausted, true);
});

test("recommendation fixture failures stay infrastructure errors", async () => {
  const result = await runScenario(path.resolve(import.meta.dirname, ".."), "unknown-scenario");
  assert.equal(result.kind, "incomplete");
  assert.equal(result.rule, null);
});

for (const name of scenarioNames) test(`current web recommendation ${name}`, async () => {
  const result = await runScenario(path.resolve(import.meta.dirname, ".."), name);
  assert.equal(result.kind, "pass", JSON.stringify(result));
});
