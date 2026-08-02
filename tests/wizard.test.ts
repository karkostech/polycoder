import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  buildMockConfig,
  buildTemplateConfig,
  runInitWizard,
  AskFn,
} from "../src/wizard.js";
import { MODELS } from "../src/models.js";
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

// The wizard prefers real env vars over asking — tests must run with a clean slate.
const KEY_VARS = MODELS.map((m) => m.apiKeyEnv);
const savedEnv: Record<string, string | undefined> = {};
before(() => {
  for (const v of KEY_VARS) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
});
after(() => {
  for (const v of KEY_VARS) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
});

test("wizard: single mode with defaults — Enter-Enter-key flow", async () => {
  const { ask, leftovers } = scripted([
    "Build a blog platform", // task
    "", // strategy: default = one model for everything
    "", // model: default = GPT
    "sk-test-12345", // OPENAI_API_KEY — the ONLY thing you ever type
  ]);
  const res = await runInitWizard({ ask, userCfg: emptyUserCfg, projectName: "blog" });

  assert.equal(res.cfg.mode, "single");
  assert.equal(res.cfg.defaultProvider, "openai");
  assert.equal(res.cfg.defaultModel, "gpt-5.5");
  assert.equal(res.cfg.task, "Build a blog platform");
  assert.equal(res.cfg.roles.length, 3);
  assert.ok(res.cfg.roles.every((r) => r.model === undefined));
  assert.deepEqual(res.cfg.roles.map((r) => r.name), ["frontend", "backend", "database"]);
  assert.equal(res.cfg.providers.length, 1);
  const p = res.cfg.providers[0]!;
  assert.equal(p.name, "openai");
  assert.equal(p.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(p.apiStyle, "openai");
  assert.equal(p.baseUrl, "https://api.openai.com/v1");
  assert.equal(p.maxTokensParam, "max_completion_tokens");
  assert.equal(p.maxOutput, 32_768);
  assert.deepEqual(res.env, { OPENAI_API_KEY: "sk-test-12345" });
  assert.deepEqual(leftovers(), [], "wizard should consume exactly the scripted answers");
});

test("wizard: multi mode assigns a different catalog model per role", async () => {
  const { ask, leftovers } = scripted([
    "Build a shop", // task
    "2", // strategy: different model per role
    "2", "sk-ant-2", // frontend → Claude + key
    "1", "sk-openai-1", // backend → GPT + key
    "6", "sk-ds-3", // database → DeepSeek + key
    "1", // integrator → GPT (key already collected — no question)
  ]);
  const res = await runInitWizard({ ask, userCfg: emptyUserCfg, projectName: "shop" });

  assert.equal(res.cfg.mode, "multi");
  const byRole = Object.fromEntries(res.cfg.roles.map((r) => [r.name, r]));
  assert.deepEqual([byRole.frontend!.model, byRole.frontend!.provider], ["claude-sonnet-5", "anthropic"]);
  assert.deepEqual([byRole.backend!.model, byRole.backend!.provider], ["gpt-5.5", "openai"]);
  assert.deepEqual([byRole.database!.model, byRole.database!.provider], ["deepseek-v4-pro", "deepseek"]);
  assert.deepEqual([res.cfg.integrator.model, res.cfg.integrator.provider], ["gpt-5.5", "openai"]);
  assert.equal(res.cfg.providers.length, 3);
  const anthropic = res.cfg.providers.find((p) => p.name === "anthropic")!;
  assert.equal(anthropic.apiStyle, "anthropic");
  assert.equal(anthropic.maxTokensParam, undefined, "Anthropic ignores the openai cap-param setting");
  assert.deepEqual(Object.keys(res.env).sort(), ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"]);
  assert.deepEqual(leftovers(), []);
});

test("wizard: key from global setup is reused — no question, NOT copied to .env", async () => {
  const userCfg: UserConfig = {
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
    providers: { openai: { apiKeyEnv: "OPENAI_API_KEY", apiKey: "sk-global-9", model: "gpt-5.5" } },
  };
  const { ask, leftovers } = scripted([
    "Build a notes app", // task
    "", // strategy: single
    "", // model: GPT (global default)
    // ← no API key question expected
  ]);
  const res = await runInitWizard({ ask, userCfg, projectName: "notes" });

  assert.deepEqual(res.env, {}, "a globally stored key must NOT be duplicated into the project .env");
  assert.equal(res.reused.OPENAI_API_KEY, maskKey("sk-global-9"));
  assert.deepEqual(leftovers(), [], "wizard must not ask for the key when it is known");
});

test("model catalog: exactly the 8 advertised families, sane wiring", () => {
  assert.deepEqual(
    MODELS.map((m) => m.label),
    ["GPT", "Claude", "Gemini", "Grok", "Kimi", "DeepSeek", "Qwen", "GLM"],
  );
  assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length, "ids unique");
  assert.equal(new Set(MODELS.map((m) => m.apiKeyEnv)).size, MODELS.length, "env vars unique");
  for (const m of MODELS) {
    assert.ok(m.model.length > 0, `${m.id} has a fixed model id`);
    assert.ok(m.baseUrl.startsWith("https://"), `${m.id} baseUrl is HTTPS`);
    assert.ok(m.maxOutput >= 8_192, `${m.id} has a usable output cap`);
    if (m.id === "anthropic") {
      assert.equal(m.apiStyle, "anthropic");
    } else {
      assert.equal(m.apiStyle, "openai");
      assert.equal(
        m.maxTokensParam,
        m.id === "openai" ? "max_completion_tokens" : "max_tokens",
        `${m.id} cap param`,
      );
    }
  }
});

test("template + mock configs are valid shapes for non-interactive use", () => {
  const single = buildTemplateConfig("single", "x");
  assert.equal(single.defaultProvider, "openai");
  assert.equal(single.defaultModel, "gpt-5.5");
  assert.equal(single.roles.length, 3);
  assert.ok(single.roles.every((r) => r.model === undefined));

  const multi = buildTemplateConfig("multi", "x");
  assert.deepEqual(multi.roles.map((r) => r.provider), ["openai", "anthropic", "moonshot"]);
  assert.deepEqual(multi.roles.map((r) => r.model), ["gpt-5.5", "claude-sonnet-5", "kimi-k2.7-code"]);
  assert.deepEqual(multi.integrator, { model: "gpt-5.5", provider: "openai" });

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
