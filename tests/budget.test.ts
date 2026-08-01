import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetExceededError, BudgetTracker, createLimiter, priceOf } from "../src/budget.js";

test("priceOf computes USD from per-1M pricing", () => {
  const cost = priceOf({ pricing: { m: { input: 2, output: 10 } } }, "m", {
    inputTokens: 500_000,
    outputTokens: 100_000,
  });
  assert.equal(cost, 1 + 1);
});

test("priceOf returns 0 for unknown models", () => {
  assert.equal(priceOf({}, "nope", { inputTokens: 1, outputTokens: 1 }), 0);
});

test("BudgetTracker enforces total token cap", () => {
  const t = new BudgetTracker({ maxTotalTokens: 100 });
  t.record("m", { inputTokens: 40, outputTokens: 40 });
  assert.throws(() => t.record("m", { inputTokens: 10, outputTokens: 20 }), BudgetExceededError);
});

test("BudgetTracker enforces per-role cap", () => {
  const t = new BudgetTracker({ maxTokensPerRole: 50 });
  assert.throws(
    () => t.record("m", { inputTokens: 30, outputTokens: 30 }, { inputTokens: 30, outputTokens: 30 }),
    /per-role/i,
  );
});

test("BudgetTracker enforces cost cap", () => {
  const t = new BudgetTracker({ maxCostUsd: 0.5, pricing: { m: { input: 1, output: 1 } } });
  t.record("m", { inputTokens: 100_000, outputTokens: 100_000 }); // $0.20
  assert.throws(() => t.record("m", { inputTokens: 400_000, outputTokens: 0 }), /cost/i);
});

test("createLimiter never exceeds the concurrency ceiling", async () => {
  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;
  const job = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
  };
  await Promise.all(Array.from({ length: 8 }, () => limit(job)));
  assert.equal(peak, 2);
});
