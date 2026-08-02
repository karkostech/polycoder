/**
 * Loading + validating agents.config.json.
 * Manual validation (no deps) with precise, actionable error messages.
 */
import path from "node:path";
import {
  BudgetConfig,
  IntegratorConfig,
  ProjectConfig,
  ProviderConfig,
  RoleConfig,
} from "./types.js";
import { pathExists, parseDotenv, readJsonFile, readTextFile } from "./fsutil.js";

export const CONFIG_FILE = "agents.config.json";
export const ENV_FILE = ".env";

export class ConfigError extends Error {}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, field: string, opts?: { optional?: boolean }): string {
  if (v === undefined || v === null) {
    if (opts?.optional) return "";
    throw new ConfigError(`Missing required string field "${field}".`);
  }
  if (typeof v !== "string" || v.trim() === "") {
    throw new ConfigError(`Field "${field}" must be a non-empty string.`);
  }
  return v.trim();
}

function num(v: unknown, field: string, opts?: { optional?: boolean; min?: number }): number | undefined {
  if (v === undefined || v === null) {
    if (opts?.optional) return undefined;
    throw new ConfigError(`Missing required number field "${field}".`);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConfigError(`Field "${field}" must be a finite number.`);
  }
  if (opts?.min !== undefined && v < opts.min) {
    throw new ConfigError(`Field "${field}" must be >= ${opts.min}.`);
  }
  return v;
}

function strArr(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ConfigError(`Field "${field}" must be an array of strings.`);
  }
  return v as string[];
}

function validateProvider(v: unknown, idx: number): ProviderConfig {
  if (!isObj(v)) throw new ConfigError(`providers[${idx}] must be an object.`);
  const name = str(v.name, `providers[${idx}].name`);
  const apiStyleRaw = str(v.apiStyle, `providers[${idx}].apiStyle`);
  if (apiStyleRaw !== "openai" && apiStyleRaw !== "anthropic" && apiStyleRaw !== "mock") {
    throw new ConfigError(
      `providers[${idx}].apiStyle must be "openai", "anthropic" or "mock" (got "${apiStyleRaw}").`,
    );
  }
  const baseUrl = apiStyleRaw === "mock" ? "" : str(v.baseUrl, `providers[${idx}].baseUrl`);
  const apiKeyEnv =
    apiStyleRaw === "mock" ? undefined : str(v.apiKeyEnv, `providers[${idx}].apiKeyEnv`);
  const out: ProviderConfig = { name, apiStyle: apiStyleRaw, baseUrl, apiKeyEnv };
  if (v.maxTokensParam !== undefined) {
    if (v.maxTokensParam !== "max_tokens" && v.maxTokensParam !== "max_completion_tokens") {
      throw new ConfigError(
        `providers[${idx}].maxTokensParam must be "max_tokens" or "max_completion_tokens".`,
      );
    }
    out.maxTokensParam = v.maxTokensParam;
  }
  const maxOutput = num(v.maxOutput, `providers[${idx}].maxOutput`, { optional: true, min: 1 });
  if (maxOutput !== undefined) out.maxOutput = maxOutput;
  return out;
}

function validateRole(v: unknown, idx: number): RoleConfig {
  if (!isObj(v)) throw new ConfigError(`roles[${idx}] must be an object.`);
  const name = str(v.name, `roles[${idx}].name`);
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) {
    throw new ConfigError(
      `roles[${idx}].name "${name}" is invalid — use letters, digits, dash, underscore (it becomes a git branch name).`,
    );
  }
  return {
    name,
    description: str(v.description, `roles[${idx}].description`),
    scope: strArr(v.scope, `roles[${idx}].scope`).map((s) => s.replace(/\\/g, "/")),
    model: v.model === undefined ? undefined : str(v.model, `roles[${idx}].model`),
    provider: v.provider === undefined ? undefined : str(v.provider, `roles[${idx}].provider`),
  };
}

function validateIntegrator(v: unknown): IntegratorConfig {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new ConfigError(`integrator must be an object.`);
  return {
    model: v.model === undefined ? undefined : str(v.model, `integrator.model`),
    provider: v.provider === undefined ? undefined : str(v.provider, `integrator.provider`),
    promptExtra:
      v.promptExtra === undefined ? undefined : str(v.promptExtra, `integrator.promptExtra`),
  };
}

function validateBudgets(v: unknown): BudgetConfig {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new ConfigError(`budgets must be an object.`);
  const pricing: BudgetConfig["pricing"] = {};
  if (v.pricing !== undefined) {
    if (!isObj(v.pricing)) throw new ConfigError(`budgets.pricing must be an object.`);
    for (const [model, p] of Object.entries(v.pricing)) {
      if (!isObj(p)) throw new ConfigError(`budgets.pricing["${model}"] must be an object.`);
      pricing[model] = {
        input: num(p.input, `budgets.pricing["${model}"].input`, { min: 0 })!,
        output: num(p.output, `budgets.pricing["${model}"].output`, { min: 0 })!,
      };
    }
  }
  return {
    maxTokensPerRole: num(v.maxTokensPerRole, "budgets.maxTokensPerRole", { optional: true, min: 1 }),
    maxTotalTokens: num(v.maxTotalTokens, "budgets.maxTotalTokens", { optional: true, min: 1 }),
    maxCostUsd: num(v.maxCostUsd, "budgets.maxCostUsd", { optional: true, min: 0 }),
    pricing,
  };
}

export function validateConfig(raw: unknown): ProjectConfig {
  if (!isObj(raw)) throw new ConfigError("Config root must be an object.");

  const projectName = str(raw.projectName, "projectName");
  const modeRaw = str(raw.mode, "mode");
  if (modeRaw !== "single" && modeRaw !== "multi") {
    throw new ConfigError(`mode must be "single" or "multi" (got "${modeRaw}").`);
  }

  if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
    throw new ConfigError("providers must be a non-empty array.");
  }
  const providers = raw.providers.map(validateProvider);
  const providerNames = new Set(providers.map((p) => p.name));
  if (providerNames.size !== providers.length) {
    throw new ConfigError("Provider names must be unique.");
  }

  if (!Array.isArray(raw.roles) || raw.roles.length === 0) {
    throw new ConfigError("roles must be a non-empty array.");
  }
  const roles = raw.roles.map(validateRole);
  const roleNames = new Set(roles.map((r) => r.name));
  if (roleNames.size !== roles.length) {
    throw new ConfigError("Role names must be unique.");
  }

  const cfg: ProjectConfig = {
    projectName,
    mode: modeRaw,
    defaultModel: raw.defaultModel === undefined ? undefined : str(raw.defaultModel, "defaultModel"),
    defaultProvider:
      raw.defaultProvider === undefined ? undefined : str(raw.defaultProvider, "defaultProvider"),
    providers,
    roles,
    integrator: validateIntegrator(raw.integrator),
    budgets: validateBudgets(raw.budgets),
    concurrency: num(raw.concurrency, "concurrency", { optional: true, min: 1 }) ?? 3,
    task: str(raw.task, "task"),
  };

  // Cross-field validation per mode.
  const providerExists = (name: string | undefined, field: string) => {
    if (!name) return;
    if (!providerNames.has(name)) {
      throw new ConfigError(`${field} references unknown provider "${name}".`);
    }
  };

  if (cfg.mode === "single") {
    if (!cfg.defaultModel) {
      throw new ConfigError(`mode "single" requires "defaultModel".`);
    }
    if (!cfg.defaultProvider) {
      throw new ConfigError(`mode "single" requires "defaultProvider".`);
    }
    providerExists(cfg.defaultProvider, "defaultProvider");
  } else {
    for (const r of cfg.roles) {
      if (!r.model) throw new ConfigError(`mode "multi": role "${r.name}" requires "model".`);
      if (!r.provider) throw new ConfigError(`mode "multi": role "${r.name}" requires "provider".`);
      providerExists(r.provider, `roles["${r.name}"].provider`);
    }
  }

  providerExists(cfg.integrator.provider, "integrator.provider");
  if (cfg.integrator.provider === undefined && cfg.mode === "single") {
    // inherits defaultProvider — fine
  }
  return cfg;
}

/** Resolve which model/provider a role uses, honoring the strategy mode. */
export function resolveRoleModel(
  cfg: ProjectConfig,
  role: RoleConfig,
): { model: string; provider: ProviderConfig } {
  const model = cfg.mode === "single" ? cfg.defaultModel! : role.model!;
  const providerName = cfg.mode === "single" ? cfg.defaultProvider! : role.provider!;
  const provider = cfg.providers.find((p) => p.name === providerName);
  if (!provider) throw new ConfigError(`Unknown provider "${providerName}" for role "${role.name}".`);
  return { model, provider };
}

/** Resolve the integrator's model/provider with sensible fallbacks. */
export function resolveIntegratorModel(
  cfg: ProjectConfig,
): { model: string; provider: ProviderConfig } {
  if (cfg.integrator.model && cfg.integrator.provider) {
    const provider = cfg.providers.find((p) => p.name === cfg.integrator.provider);
    if (!provider) throw new ConfigError(`Unknown integrator provider "${cfg.integrator.provider}".`);
    return { model: cfg.integrator.model, provider };
  }
  if (cfg.mode === "single") {
    const provider = cfg.providers.find((p) => p.name === cfg.defaultProvider)!;
    return { model: cfg.defaultModel!, provider };
  }
  const first = cfg.roles[0]!;
  return resolveRoleModel(cfg, first);
}

/** Load .env (if present) into process.env without overriding real env vars. */
export async function loadEnvFile(cwd: string): Promise<void> {
  const envPath = path.join(cwd, ENV_FILE);
  if (!(await pathExists(envPath))) return;
  const vars = parseDotenv(await readTextFile(envPath));
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export async function loadConfig(cwd: string): Promise<ProjectConfig> {
  const file = path.join(cwd, CONFIG_FILE);
  if (!(await pathExists(file))) {
    throw new ConfigError(
      `No ${CONFIG_FILE} found in ${cwd}.\nRun "chalkcode init" to create one.`,
    );
  }
  return validateConfig(await readJsonFile(file));
}

/** Verify that every provider that needs an API key actually has one in env. */
export function missingApiKeys(cfg: ProjectConfig): string[] {
  const missing: string[] = [];
  for (const p of cfg.providers) {
    if (p.apiStyle === "mock") continue;
    if (!p.apiKeyEnv || !process.env[p.apiKeyEnv]) {
      missing.push(`${p.name} (env var ${p.apiKeyEnv ?? "?"})`);
    }
  }
  return missing;
}
