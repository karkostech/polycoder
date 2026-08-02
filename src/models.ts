/**
 * The ChalkCode model catalog — the fixed list of 8 model families the
 * wizard offers. Pick from the list, paste the API key, done. No custom
 * providers, no model-id typing, no base-URL questions.
 *
 * Defaults are reviewed against current provider docs (Aug 2026). Power
 * users can still hand-edit agents.config.json afterwards — the wizard is
 * a convenience layer, not a restriction.
 */

export interface ModelFamily {
  /** Provider id stored in agents.config.json ("openai", "anthropic", …). */
  id: string;
  /** Short display label ("GPT", "Claude", …). */
  label: string;
  /** Vendor shown next to the label ("OpenAI", "Anthropic", …). */
  vendor: string;
  apiStyle: "openai" | "anthropic";
  baseUrl: string;
  apiKeyEnv: string;
  /** The model id used for this family — fixed, never asked. */
  model: string;
  /**
   * OpenAI-style APIs disagree on the cap parameter: OpenAI's GPT-5 line
   * REJECTS `max_tokens` (needs `max_completion_tokens`), while most
   * OpenAI-compatible providers (Gemini, xAI, Moonshot, DeepSeek,
   * DashScope, Z.ai) speak classic `max_tokens`. Anthropic ignores this.
   */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** Per-call output cap for build/integrate calls (continuations handle the rest). */
  maxOutput: number;
}

export const MODELS: ModelFamily[] = [
  {
    id: "openai",
    label: "GPT",
    vendor: "OpenAI",
    apiStyle: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    model: "gpt-5.5",
    maxTokensParam: "max_completion_tokens",
    maxOutput: 32_768,
  },
  {
    id: "anthropic",
    label: "Claude",
    vendor: "Anthropic",
    apiStyle: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-5",
    maxOutput: 32_768,
  },
  {
    id: "gemini",
    label: "Gemini",
    vendor: "Google",
    apiStyle: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    model: "gemini-3.5-flash",
    maxTokensParam: "max_tokens",
    maxOutput: 32_768,
  },
  {
    id: "grok",
    label: "Grok",
    vendor: "xAI",
    apiStyle: "openai",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    // grok-4.5 is not available to EU API users; grok-4.3 works everywhere.
    model: "grok-4.3",
    maxTokensParam: "max_tokens",
    maxOutput: 32_768,
  },
  {
    id: "moonshot",
    label: "Kimi",
    vendor: "Moonshot",
    apiStyle: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    model: "kimi-k2.7-code",
    maxTokensParam: "max_tokens",
    maxOutput: 16_384,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    vendor: "DeepSeek",
    apiStyle: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    // deepseek-chat / deepseek-reasoner were retired 2026-07-24.
    model: "deepseek-v4-pro",
    maxTokensParam: "max_tokens",
    maxOutput: 32_768,
  },
  {
    id: "qwen",
    label: "Qwen",
    vendor: "Alibaba",
    apiStyle: "openai",
    // International endpoint — the China endpoint 401s on non-CN accounts.
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    model: "qwen3-coder-plus",
    maxTokensParam: "max_tokens",
    maxOutput: 32_768,
  },
  {
    id: "glm",
    label: "GLM",
    vendor: "Z.ai",
    apiStyle: "openai",
    // International endpoint (open.bigmodel.cn is the China one).
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "GLM_API_KEY",
    model: "glm-4.7",
    maxTokensParam: "max_tokens",
    maxOutput: 32_768,
  },
];

export function modelFamily(id: string): ModelFamily | undefined {
  return MODELS.find((m) => m.id === id);
}
