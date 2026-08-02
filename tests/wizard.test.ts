import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMockConfig,
  buildTemplateConfig,
  runInitWizard,
  AskFn,
} from "../src/wizard.js";
import { UserConfig, maskKey, applyUserKeysToEnv } from "../src/userconfig.js";

/** An AskFn that plays back scripted answers and fails on any extra question. */
function scripted(answers: string[]): { ask: AskFn; leftovers: () => string[] } {
  const queue = [...answers];
  return {
    ask: async (q: string) => {
      if (queue.length === 0) throw new Error(`wizard asked an unexpected question: ${q}`);
      return queue.shift()!;
    },
    leftovers: () => queue,
  };
}

const emptyUserCfg: UserConfig = { providers: {} };

test("wizard: single mode with defaults — Enter-Enter-Enter flow", async () => {
  const { ask, leftovers } = scripted([
    "Build a blog platform", // task
    "", // strategy: default = one model for everything
    "", // provider: default = openai
    "", // model: default = gpt-5
    "sk-test-12345", // OPENAI_API_KEY
  ]);
  const res = await runInitWizard({ ask, userCfg: emptyUserCfg, projectName: "blog" });

  assert.equal(res.cfg.mode, "single");
  assert.equal(res.cfg.defaultProvider, "openai");
  assert.equal(res.cfg.defaultModel, "gpt-5");
  assert.equal(res.cfg.task, "Build a blog platform");
  assert.equal(res.cfg.roles.length, 3);
  assert.ok(res.cfg.roles.every((r) => r.model === undefined));
  assert.deepEqual(res.cfg.roles.map((r) => r.name), ["frontend", "backend", "database"]);
  assert.equal(res.cfg.providers.length, 1);
  assert.equal(res.cfg.providers[0]!.apiKeyEnv, "OPENAI_API_KEY");
  assert.deepEqual(res.env, { OPENAI_API_KEY: "sk-test-12345" });
  assert.deepEqual(leftovers(), [], "wizard should consume exactly the scripted answers");
});

test("wizard: multi mode assigns a different model per role", async () => {
  const { ask, leftovers } = scripted([
    "Build a shop", // task
    "2", // strategy: different model per role
    // frontend → openai / gpt-5
    "", "", "sk-openai-1",
    // backend → anthropic / claude-sonnet-4-5
    "2", "", "sk-ant-2",
    // database → moonshot / kimi-k2
    "3", "", "sk-kimi-3",
    // integrator → openai / gpt-5 (key already collected — no question)
    "", "",
  ]);
  const res = await runInitWizard({ ask, userCfg: emptyUserCfg, projectName: "shop" });

  assert.equal(res.cfg.mode, "multi");
  const byRole = Object.fromEntries(res.cfg.roles.map((r) => [r.name, r]));
  assert.deepEqual([byRole.frontend!.model, byRole.frontend!.provider], ["gpt-5", "openai"]);
  assert.deepEqual([byRole.backend!.model, byRole.backend!.provider], ["claude-sonnet-4-5", "anthropic"]);
  assert.deepEqual([byRole.database!.model, byRole.database!.provider], ["kimi-k2", "moonshot"]);
  assert.deepEqual([res.cfg.integrator.model, res.cfg.integrator.provider], ["gpt-5", "openai"]);
  assert.equal(res.cfg.providers.length, 3);
  assert.deepEqual(Object.keys(res.env).sort(), ["ANTHROPIC_API_KEY", "MOONSHOT_API_KEY", "OPENAI_API_KEY"]);
  assert.deepEqual(leftovers(), []);
});

test("wizard: reuses API key from global user config — no key question", async () => {
  const userCfg: UserConfig = {
    defaultProvider: "openai",
    defaultModel: "gpt-5",
    providers: { openai: { apiKeyEnv: "OPENAI_API_KEY", apiKey: "sk-global-9", model: "gpt-5" } },
  };
  const { ask, leftovers } = scripted([
    "Build a notes app", // task
    "", // strategy: single
    "", // provider: openai (global default)
    "", // model: gpt-5 (from global config)
    // ← no API key question expected
  ]);
  const res = await runInitWizard({ ask, userCfg, projectName: "notes" });

  assert.equal(res.env.OPENAI_API_KEY, "sk-global-9", "key should come from the global config into .env");
  assert.ok(res.reused.OPENAI_API_KEY, "reused map should mention the key");
  assert.deepEqual(leftovers(), [], "wizard must not ask for the key when it is known");
});

test("template + mock configs are valid shapes for non-interactive use", () => {
  const single = buildTemplateConfig("single", "x");
  assert.equal(single.defaultModel, "gpt-5");
  assert.equal(single.roles.length, 3);
  assert.ok(single.roles.every((r) => r.model === undefined));

  const multi = buildTemplateConfig("multi", "x");
  assert.deepEqual(multi.roles.map((r) => r.provider), ["openai", "anthropic", "moonshot"]);
  assert.deepEqual(multi.integrator, { model: "gpt-5", provider: "openai" });

  const mock = buildMockConfig("x");
  assert.equal(mock.providers[0]!.apiStyle, "mock");
  assert.ok(mock.roles.every((r) => r.provider === "mock"));
});

test("userconfig helpers: maskKey + applyUserKeysToEnv never overrides", () => {
  assert.equal(maskKey("sk-abcdefgh123456"), "sk-…3456");
  assert.equal(maskKey("short"), "…");

  delete process.env.CHALKCODE_TEST_KEY;
  applyUserKeysToEnv({
    providers: { t: { apiKeyEnv: "CHALKCODE_TEST_KEY", apiKey: "from-global" } },
  });
  assert.equal(process.env.CHALKCODE_TEST_KEY, "from-global");

  process.env.CHALKCODE_TEST_KEY = "real-env";
  applyUserKeysToEnv({
    providers: { t: { apiKeyEnv: "CHALKCODE_TEST_KEY", apiKey: "from-global" } },
  });
  assert.equal(process.env.CHALKCODE_TEST_KEY, "real-env", "must never override a real env var");
  delete process.env.CHALKCODE_TEST_KEY;
});
