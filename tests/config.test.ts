import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, ConfigError, resolveRoleModel, resolveIntegratorModel } from "../src/config.js";
import { ProjectConfig } from "../src/types.js";

function baseMulti(): unknown {
  return {
    projectName: "x",
    mode: "multi",
    providers: [{ name: "mock", apiStyle: "mock", baseUrl: "" }],
    roles: [
      { name: "a", description: "role a", scope: ["a/"], model: "m1", provider: "mock" },
      { name: "b", description: "role b", scope: ["b/"], model: "m2", provider: "mock" },
    ],
    integrator: {},
    budgets: {},
    concurrency: 2,
    task: "build something",
  };
}

test("valid multi config passes", () => {
  const cfg = validateConfig(baseMulti());
  assert.equal(cfg.mode, "multi");
  assert.equal(cfg.roles.length, 2);
  assert.equal(cfg.concurrency, 2);
});

test("single mode requires defaultModel and defaultProvider", () => {
  assert.throws(
    () =>
      validateConfig({
        projectName: "x",
        mode: "single",
        providers: [{ name: "mock", apiStyle: "mock", baseUrl: "" }],
        roles: [{ name: "a", description: "a", scope: [] }],
        task: "t",
      }),
    ConfigError,
  );
});

test("single mode resolves every role to the default model", () => {
  const cfg = validateConfig({
    projectName: "x",
    mode: "single",
    defaultModel: "gpt-x",
    defaultProvider: "mock",
    providers: [{ name: "mock", apiStyle: "mock", baseUrl: "" }],
    roles: [{ name: "a", description: "a", scope: [], model: "ignored", provider: "ignored" }],
    integrator: {},
    task: "t",
  }) as ProjectConfig;
  const { model, provider } = resolveRoleModel(cfg, cfg.roles[0]!);
  assert.equal(model, "gpt-x");
  assert.equal(provider.name, "mock");
});

test("multi mode requires model+provider per role", () => {
  const raw = baseMulti() as Record<string, unknown>;
  (raw.roles as Array<Record<string, unknown>>)[0] = { name: "a", description: "a", scope: [] };
  assert.throws(() => validateConfig(raw), /requires "model"/);
});

test("unknown provider reference is rejected", () => {
  const raw = baseMulti() as Record<string, unknown>;
  (raw.roles as Array<Record<string, unknown>>)[0]!.provider = "nope";
  assert.throws(() => validateConfig(raw), /unknown provider/i);
});

test("duplicate role names are rejected", () => {
  const raw = baseMulti() as Record<string, unknown>;
  (raw.roles as Array<Record<string, unknown>>)[1]!.name = "a";
  assert.throws(() => validateConfig(raw), /unique/i);
});

test("bad apiStyle is rejected", () => {
  const raw = baseMulti() as Record<string, unknown>;
  (raw.providers as Array<Record<string, unknown>>)[0]!.apiStyle = "weird";
  assert.throws(() => validateConfig(raw), /apiStyle/);
});

test("invalid role name (branch-unsafe) is rejected", () => {
  const raw = baseMulti() as Record<string, unknown>;
  (raw.roles as Array<Record<string, unknown>>)[0]!.name = "bad name!";
  assert.throws(() => validateConfig(raw), /invalid/i);
});

test("integrator falls back to first role model in multi mode", () => {
  const cfg = validateConfig(baseMulti()) as ProjectConfig;
  const { model, provider } = resolveIntegratorModel(cfg);
  assert.equal(model, "m1");
  assert.equal(provider.name, "mock");
});

test("budgets validate numbers and pricing", () => {
  const raw = baseMulti() as Record<string, unknown>;
  raw.budgets = { maxTotalTokens: 100, pricing: { m1: { input: 1, output: 2 } } };
  const cfg = validateConfig(raw);
  assert.equal(cfg.budgets.maxTotalTokens, 100);
  assert.equal(cfg.budgets.pricing?.m1?.output, 2);
});
