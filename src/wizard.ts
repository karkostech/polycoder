/**
 * Interactive setup wizard — the "plug & play" core of ChalkCode.
 *
 * `runInitWizard` asks a handful of questions (all with sane defaults, so
 * Enter-Enter-Enter works) and produces a ready-to-run ProjectConfig plus
 * the API keys to persist. The `ask` function is injectable so tests can
 * script the answers.
 *
 * Non-interactive fallbacks (CI, scripts): `buildTemplateConfig`.
 * `buildMockConfig` exists ONLY for tests and the CI smoke test — it is not
 * advertised anywhere user-facing.
 */
import { ProjectConfig, ProviderConfig } from "./types.js";
import { UserConfig, maskKey } from "./userconfig.js";

export type AskFn = (question: string) => Promise<string>;
export type PrintFn = (msg: string) => void;

export interface ProviderPreset {
  name: string;
  label: string;
  apiStyle: "openai" | "anthropic";
  baseUrl: string;
  apiKeyEnv: string;
  defaultModel: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    name: "openai",
    label: "OpenAI (GPT)",
    apiStyle: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-5",
  },
  {
    name: "anthropic",
    label: "Anthropic (Claude)",
    apiStyle: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-5",
  },
  {
    name: "moonshot",
    label: "Moonshot (Kimi)",
    apiStyle: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k2",
  },
];

const DEFAULT_ROLE_SCOPES: Array<{ name: string; description: string; scope: string[] }> = [
  { name: "frontend", description: "Owns the web UI — everything under web/.", scope: ["web/"] },
  { name: "backend", description: "Owns the HTTP API server — everything under server/.", scope: ["server/"] },
  { name: "database", description: "Owns persistence — everything under db/.", scope: ["db/"] },
];

export interface WizardResult {
  cfg: ProjectConfig;
  /** API keys collected during the wizard (env var name → key), to persist in .env. */
  env: Record<string, string>;
  /** Keys reused from env/global config (env var name → masked key) — for display only. */
  reused: Record<string, string>;
}

interface WizardDeps {
  ask: AskFn;
  print?: PrintFn;
  userCfg: UserConfig;
  /** Project name suggestion (defaults to the directory name). */
  projectName: string;
}

function providerPreset(name: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.name === name);
}

/** Ask a question with a default shown in brackets; empty answer = default. */
async function askDefault(ask: AskFn, question: string, def: string): Promise<string> {
  const a = (await ask(`${question} [${def}]: `)).trim();
  return a === "" ? def : a;
}

/** Ask a multiple-choice question; empty answer = default index. */
async function askChoice(
  ask: AskFn,
  print: PrintFn,
  question: string,
  options: string[],
  defIdx: number,
): Promise<number> {
  print(question);
  options.forEach((o, i) => print(`  ${i + 1}) ${o}${i === defIdx ? "  (default)" : ""}`));
  for (;;) {
    const a = (await ask(`choose 1-${options.length} [${defIdx + 1}]: `)).trim();
    if (a === "") return defIdx;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
    print(`  please enter a number 1-${options.length}`);
  }
}

/**
 * Resolve a provider for one purpose (single-mode default, a role, the
 * integrator). Returns the ProviderConfig, the chosen model, and possibly a
 * newly collected API key. Reuses: (1) key already collected in this wizard,
 * (2) key from the real environment, (3) key from the global user config.
 */
async function pickProviderAndModel(
  deps: WizardDeps,
  label: string,
  defaultProviderName: string,
  collectedEnv: Record<string, string>,
  reused: Record<string, string>,
): Promise<{ provider: ProviderConfig; model: string }> {
  const { ask, userCfg } = deps;
  const print = deps.print ?? (() => {});

  // Build the choice list: presets (with the default first if it differs) + custom.
  const names = PROVIDER_PRESETS.map((p) => p.name);
  const defPresetIdx = Math.max(0, names.indexOf(defaultProviderName));
  const idx = await askChoice(
    ask,
    print,
    `${label} — provider:`,
    [...PROVIDER_PRESETS.map((p) => p.label), "custom (any OpenAI-compatible API)"],
    defPresetIdx,
  );

  let provider: ProviderConfig;
  let defaultModel: string;
  if (idx < PROVIDER_PRESETS.length) {
    const preset = PROVIDER_PRESETS[idx]!;
    provider = { name: preset.name, apiStyle: preset.apiStyle, baseUrl: preset.baseUrl, apiKeyEnv: preset.apiKeyEnv };
    defaultModel = userCfg.providers[preset.name]?.model ?? preset.defaultModel;
  } else {
    const name = await askDefault(ask, "  provider name (short id, e.g. groq)", "custom");
    const baseUrl = await askDefault(ask, "  base URL", "https://api.example.com/v1");
    const apiKeyEnv = (await askDefault(ask, "  env var for the API key", `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`));
    provider = { name, apiStyle: "openai", baseUrl, apiKeyEnv };
    defaultModel = "model-id";
  }

  const model = await askDefault(ask, `${label} — model`, defaultModel);

  // API key resolution, in priority order.
  const envVar = provider.apiKeyEnv!;
  if (collectedEnv[envVar]) {
    // already typed in this wizard for another role — silently reuse
  } else if (process.env[envVar]) {
    reused[envVar] = maskKey(process.env[envVar]!);
  } else if (userCfg.providers[provider.name]?.apiKey) {
    collectedEnv[envVar] = userCfg.providers[provider.name]!.apiKey;
    reused[envVar] = maskKey(collectedEnv[envVar]!);
  } else {
    let key = "";
    for (;;) {
      key = (await ask(`${label} — API key (${envVar}, stored in .env, never committed): `)).trim();
      if (key) break;
      print("  a key is required for this provider (or press Ctrl+C and set the env var yourself)");
    }
    collectedEnv[envVar] = key;
  }
  return { provider, model };
}

/** The full interactive init wizard. */
export async function runInitWizard(deps: WizardDeps): Promise<WizardResult> {
  const { ask, userCfg } = deps;
  const print = deps.print ?? (() => {});
  const collectedEnv: Record<string, string> = {};
  const reused: Record<string, string> = {};

  const task = await (async () => {
    for (;;) {
      const t = (await ask("What should the agents build? ")).trim();
      if (t) return t;
      print("  describe the task in one or two sentences — this is what the agents implement.");
    }
  })();

  const strategyIdx = await askChoice(
    ask,
    print,
    "Which models should build it?",
    [
      "one model for everything (still parallel — one agent per role)",
      "different model per role (frontend / backend / database / integrator)",
    ],
    0,
  );
  const mode = strategyIdx === 0 ? "single" : "multi";

  const defProvider = userCfg.defaultProvider ?? "openai";
  const providers = new Map<string, ProviderConfig>();
  const addProvider = (p: ProviderConfig) => providers.set(p.name, p);

  const cfg: ProjectConfig = {
    projectName: deps.projectName,
    mode,
    providers: [],
    roles: [],
    integrator: {},
    budgets: { maxTokensPerRole: 400_000, maxTotalTokens: 2_000_000, pricing: {} },
    concurrency: 3,
    task,
  };

  if (mode === "single") {
    const { provider, model } = await pickProviderAndModel(deps, "default model", defProvider, collectedEnv, reused);
    addProvider(provider);
    cfg.defaultProvider = provider.name;
    cfg.defaultModel = model;
    cfg.roles = DEFAULT_ROLE_SCOPES.map((r) => ({ ...r }));
  } else {
    for (const roleDef of DEFAULT_ROLE_SCOPES) {
      const { provider, model } = await pickProviderAndModel(deps, roleDef.name, defProvider, collectedEnv, reused);
      addProvider(provider);
      cfg.roles.push({ ...roleDef, model, provider: provider.name });
    }
    const integ = await pickProviderAndModel(deps, "integrator (merges + wires everything)", defProvider, collectedEnv, reused);
    addProvider(integ.provider);
    cfg.integrator = { model: integ.model, provider: integ.provider.name };
  }
  cfg.providers = [...providers.values()];
  return { cfg, env: collectedEnv, reused };
}

/** Non-interactive init (scripts, CI, `--mode` + `--task` flags). */
export function buildTemplateConfig(mode: "single" | "multi", projectName: string, task?: string): ProjectConfig {
  const base: ProjectConfig = {
    projectName,
    mode,
    providers: PROVIDER_PRESETS.map((p) => ({
      name: p.name,
      apiStyle: p.apiStyle,
      baseUrl: p.baseUrl,
      apiKeyEnv: p.apiKeyEnv,
    })),
    roles: [],
    integrator: {},
    budgets: { maxTokensPerRole: 400_000, maxTotalTokens: 2_000_000, pricing: {} },
    concurrency: 3,
    task: task ?? "Describe what you want the agents to build.",
  };
  if (mode === "single") {
    base.defaultProvider = "openai";
    base.defaultModel = "gpt-5";
    base.roles = DEFAULT_ROLE_SCOPES.map((r) => ({ ...r }));
  } else {
    base.roles = DEFAULT_ROLE_SCOPES.map((r, i) => ({
      ...r,
      model: PROVIDER_PRESETS[i]!.defaultModel,
      provider: PROVIDER_PRESETS[i]!.name,
    }));
    base.integrator = { model: "gpt-5", provider: "openai" };
  }
  return base;
}

/**
 * Mock-provider config — used ONLY by tests and the CI smoke test
 * (`init --mock`, and the legacy hidden alias `init --demo`). Not documented
 * in --help or README: there is no user-facing "demo mode" anymore.
 */
export function buildMockConfig(projectName: string, task?: string): ProjectConfig {
  return {
    projectName,
    mode: "multi",
    providers: [{ name: "mock", apiStyle: "mock", baseUrl: "" }],
    roles: DEFAULT_ROLE_SCOPES.map((r, i) => ({
      ...r,
      model: `mock-${["frontend", "backend", "db"][i]}`,
      provider: "mock",
    })),
    integrator: { model: "mock-integrator", provider: "mock" },
    budgets: { maxTotalTokens: 1_000_000 },
    concurrency: 3,
    task:
      task ??
      "Build a minimal but working todo web app: a web UI to list/add/toggle items, an HTTP JSON API, and a persistence layer. Vanilla stack, zero npm dependencies.",
  };
}
