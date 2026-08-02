/**
 * User-level defaults (~/.chalkcode/config.json) — written once by
 * `chalkcode setup`, read by `init` (to pre-fill the wizard) and `run`
 * (as a fallback source of API keys). Project .env always wins.
 *
 * Shape:
 * {
 *   "defaultProvider": "openai",
 *   "defaultModel": "gpt-5",
 *   "providers": {
 *     "openai": { "apiKeyEnv": "OPENAI_API_KEY", "apiKey": "sk-..." }
 *   }
 * }
 */
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

export interface UserProviderEntry {
  /** Env var name the project config references, e.g. OPENAI_API_KEY. */
  apiKeyEnv: string;
  /** The actual key, stored locally. Never leaves the machine. */
  apiKey: string;
  /** Last used model for this provider (pre-fills the wizard). */
  model?: string;
}

export interface UserConfig {
  defaultProvider?: string;
  defaultModel?: string;
  providers: Record<string, UserProviderEntry>;
}

export function userConfigPath(): string {
  return path.join(os.homedir(), ".chalkcode", "config.json");
}

export async function loadUserConfig(): Promise<UserConfig> {
  try {
    const raw = await fs.readFile(userConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { providers: {} };
    return {
      defaultProvider: typeof parsed.defaultProvider === "string" ? parsed.defaultProvider : undefined,
      defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : undefined,
      providers: typeof parsed.providers === "object" && parsed.providers !== null ? parsed.providers : {},
    };
  } catch {
    return { providers: {} };
  }
}

export async function saveUserConfig(cfg: UserConfig): Promise<void> {
  const file = userConfigPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

/**
 * Apply globally stored API keys to process.env — but NEVER override a real
 * env var or one already loaded from the project .env.
 */
export function applyUserKeysToEnv(userCfg: UserConfig): void {
  for (const entry of Object.values(userCfg.providers)) {
    if (entry.apiKeyEnv && entry.apiKey && process.env[entry.apiKeyEnv] === undefined) {
      process.env[entry.apiKeyEnv] = entry.apiKey;
    }
  }
}

/** Mask a key for display: keep first 3 + last 4 chars. */
export function maskKey(key: string): string {
  if (key.length <= 10) return "…";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
