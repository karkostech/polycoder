/**
 * Interactive setup wizard — the "plug & play" core of ChalkCode.
 *
 * The flow is deliberately minimal: pick a model from the fixed catalog of
 * 8 families (src/models.ts), paste its API key, done. No custom providers,
 * no base URLs, no model-id typing — those were the #1 way to get stuck.
 * Everything else (providers, budgets, scopes) is derived from the catalog.
 *
 * `ask` is injectable so tests can script the answers.
 *
 * Non-interactive fallbacks (CI, scripts): `buildTemplateConfig`.
 * `buildMockConfig` exists ONLY for tests and the CI smoke test — it is not
 * advertised anywhere user-facing.
 */
import { fmt } from "./logger.js";
import { MODELS, ModelFamily } from "./models.js";
import { ProjectConfig, ProviderConfig } from "./types.js";
import { UserConfig, maskKey } from "./userconfig.js";

export type AskFn = (question: string) => Promise<string>;
export type PrintFn = (msg: string) => void;

export interface WizardResult {
  cfg: ProjectConfig;
  /** API keys pasted during the wizard (env var name → key), to persist in .env. */
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

const DEFAULT_ROLE_SCOPES: Array<{ name: string; description: string; scope: string[] }> = [
  { name: "frontend", description: "Owns the web UI — everything under web/.", scope: ["web/"] },
  { name: "backend", description: "Owns the HTTP API server — everything under server/.", scope: ["server/"] },
  { name: "database", description: "Owns persistence — everything under db/.", scope: ["db/"] },
];

/** Ask a multiple-choice question; empty answer = default index. */
async function askChoice(
  ask: AskFn,
  print: PrintFn,
  optionCount: number,
  defIdx: number,
): Promise<number> {
  for (;;) {
    const a = (await ask(`${fmt.cyan("›")} choose 1-${optionCount} [${defIdx + 1}]: `)).trim();
    if (a === "") return defIdx;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= optionCount) return n - 1;
    print(fmt.yellow(`  please enter a number 1-${optionCount}`));
  }
}

/** Print the 8-family model list with aligned columns. */
function printModelList(print: PrintFn, defIdx: number): void {
  MODELS.forEach((m, i) => {
    const num = fmt.cyan(`  ${i + 1})`);
    const label = fmt.bold(m.label.padEnd(9));
    const detail = fmt.gray(`${m.model} · ${m.vendor}${i === defIdx ? "   (default)" : ""}`);
    print(`${num} ${label} ${detail}`);
  });
}

/**
 * The only question that matters: which model family. Returns the chosen
 * family from the fixed catalog — there is no "custom" escape hatch.
 */
export async function pickModel(
  deps: { ask: AskFn; print?: PrintFn },
  label: string,
  defaultId: string,
): Promise<ModelFamily> {
  const { ask } = deps;
  const print = deps.print ?? (() => {});
  const defIdx = Math.max(0, MODELS.findIndex((m) => m.id === defaultId));
  print(fmt.bold(label));
  printModelList(print, defIdx);
  const idx = await askChoice(ask, print, MODELS.length, defIdx);
  const fam = MODELS[idx]!;
  print(`${fmt.green("✔")} ${fmt.bold(fam.label)} ${fmt.gray(`· ${fam.model}`)}`);
  return fam;
}

/**
 * Resolve the API key for a family, in priority order:
 *   1. already pasted in this wizard (another role uses the same family)
 *   2. present in the real environment
 *   3. stored in the global ~/.chalkcode config (used at runtime — NOT
 *      duplicated into the project .env)
 *   4. otherwise: ask — paste the key, nothing else.
 */
async function ensureKey(
  deps: WizardDeps,
  fam: ModelFamily,
  collectedEnv: Record<string, string>,
  reused: Record<string, string>,
): Promise<void> {
  const { ask, userCfg } = deps;
  const print = deps.print ?? (() => {});
  const envVar = fam.apiKeyEnv;

  if (collectedEnv[envVar]) return;
  if (process.env[envVar]) {
    reused[envVar] = maskKey(process.env[envVar]!);
    print(fmt.gray(`  key: ${envVar} found in your environment (${reused[envVar]})`));
    return;
  }
  const globalEntry = userCfg.providers[fam.id];
  if (globalEntry?.apiKey) {
    reused[envVar] = maskKey(globalEntry.apiKey);
    print(fmt.gray(`  key: ${envVar} reused from global setup (${reused[envVar]})`));
    return;
  }
  for (;;) {
    const key = (await ask(`${fmt.cyan("›")} paste ${envVar} (stored in .env, never committed): `)).trim();
    if (key) {
      collectedEnv[envVar] = key;
      return;
    }
    print(fmt.yellow("  a key is required (or press Ctrl+C and set the env var yourself)"));
  }
}

function providerOf(fam: ModelFamily): ProviderConfig {
  const p: ProviderConfig = {
    name: fam.id,
    apiStyle: fam.apiStyle,
    baseUrl: fam.baseUrl,
    apiKeyEnv: fam.apiKeyEnv,
    maxOutput: fam.maxOutput,
  };
  if (fam.maxTokensParam) p.maxTokensParam = fam.maxTokensParam;
  return p;
}

/** The full interactive init wizard. */
export async function runInitWizard(deps: WizardDeps): Promise<WizardResult> {
  const { ask, userCfg } = deps;
  const print = deps.print ?? (() => {});
  const collectedEnv: Record<string, string> = {};
  const reused: Record<string, string> = {};

  const task = await (async () => {
    for (;;) {
      const t = (await ask(`${fmt.cyan("›")} what should the agents build? `)).trim();
      if (t) return t;
      print(fmt.yellow("  describe the task in one or two sentences — this is what the agents implement."));
    }
  })();

  print(fmt.bold("Which models should build it?"));
  print(`  ${fmt.cyan("1)")} one model for everything ${fmt.gray("— still parallel, one agent per role (default)")}`);
  print(`  ${fmt.cyan("2)")} different model per role ${fmt.gray("— frontend / backend / database / integrator")}`);
  const strategyIdx = await askChoice(ask, print, 2, 0);
  const mode = strategyIdx === 0 ? "single" : "multi";

  const providers = new Map<string, ProviderConfig>();
  const addProvider = (fam: ModelFamily) => {
    if (!providers.has(fam.id)) providers.set(fam.id, providerOf(fam));
  };

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

  let lastId = userCfg.defaultProvider ?? "openai";
  if (mode === "single") {
    const fam = await pickModel(deps, "Pick a model — it builds everything:", lastId);
    await ensureKey(deps, fam, collectedEnv, reused);
    addProvider(fam);
    cfg.defaultProvider = fam.id;
    cfg.defaultModel = fam.model;
    cfg.roles = DEFAULT_ROLE_SCOPES.map((r) => ({ ...r }));
  } else {
    for (const roleDef of DEFAULT_ROLE_SCOPES) {
      const fam = await pickModel(deps, `Pick a model — ${roleDef.name} (${roleDef.scope[0]}):`, lastId);
      await ensureKey(deps, fam, collectedEnv, reused);
      addProvider(fam);
      cfg.roles.push({ ...roleDef, model: fam.model, provider: fam.id });
      lastId = fam.id;
    }
    const fam = await pickModel(deps, "Pick a model — integrator (merges + wires everything):", lastId);
    await ensureKey(deps, fam, collectedEnv, reused);
    addProvider(fam);
    cfg.integrator = { model: fam.model, provider: fam.id };
  }
  cfg.providers = [...providers.values()];
  return { cfg, env: collectedEnv, reused };
}

/** Non-interactive init (scripts, CI, `--mode` + `--task` flags). */
export function buildTemplateConfig(mode: "single" | "multi", projectName: string, task?: string): ProjectConfig {
  const byId = (id: string) => providerOf(MODELS.find((m) => m.id === id)!);
  const base: ProjectConfig = {
    projectName,
    mode,
    providers: [byId("openai"), byId("anthropic"), byId("moonshot")],
    roles: [],
    integrator: {},
    budgets: { maxTokensPerRole: 400_000, maxTotalTokens: 2_000_000, pricing: {} },
    concurrency: 3,
    task: task ?? "Describe what you want the agents to build.",
  };
  if (mode === "single") {
    base.defaultProvider = "openai";
    base.defaultModel = MODELS[0]!.model;
    base.roles = DEFAULT_ROLE_SCOPES.map((r) => ({ ...r }));
  } else {
    const picks = ["openai", "anthropic", "moonshot"];
    base.roles = DEFAULT_ROLE_SCOPES.map((r, i) => {
      const fam = MODELS.find((m) => m.id === picks[i])!;
      return { ...r, model: fam.model, provider: fam.id };
    });
    base.integrator = { model: MODELS[0]!.model, provider: "openai" };
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
