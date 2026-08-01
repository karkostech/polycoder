/**
 * PolyCoder — core shared types.
 */

export type StrategyMode = "single" | "multi";

export type ApiStyle = "openai" | "anthropic" | "mock";

export interface ProviderConfig {
  /** Logical name referenced from roles / defaults, e.g. "openai". */
  name: string;
  /** API style: openai-compatible chat completions, anthropic messages, or offline mock. */
  apiStyle: ApiStyle;
  /** Base URL, e.g. "https://api.openai.com/v1". Empty for mock. */
  baseUrl: string;
  /** Name of the environment variable holding the API key. Ignored for mock. */
  apiKeyEnv?: string;
}

export interface RoleConfig {
  /** Short role id, e.g. "frontend". Used for branch + journal names. */
  name: string;
  /** Human description of what the role owns. */
  description: string;
  /** Path prefixes this role is allowed to write, e.g. ["src/web/", "public/"]. Empty = anywhere. */
  scope: string[];
  /** Model id. Required in "multi" mode; ignored in "single" mode. */
  model?: string;
  /** Provider name (must exist in providers[]). */
  provider?: string;
}

export interface IntegratorConfig {
  /** Model for the integration pass. Defaults to the single-mode model or the first role model. */
  model?: string;
  provider?: string;
  /** Extra instructions appended to the integrator system prompt. */
  promptExtra?: string;
}

export interface BudgetConfig {
  /** Hard cap of total tokens (input+output) per role agent. 0/undefined = unlimited. */
  maxTokensPerRole?: number;
  /** Hard cap of total tokens for the whole run. */
  maxTotalTokens?: number;
  /** Hard cap of estimated USD cost for the whole run (uses config pricing if provided). */
  maxCostUsd?: number;
  /** Optional per-model pricing in USD per 1M tokens: { "gpt-x": { input: 1.0, output: 4.0 } }. */
  pricing?: Record<string, { input: number; output: number }>;
}

export interface ProjectConfig {
  projectName: string;
  mode: StrategyMode;
  /** Model used for everything in "single" mode. */
  defaultModel?: string;
  /** Provider used for everything in "single" mode. */
  defaultProvider?: string;
  providers: ProviderConfig[];
  roles: RoleConfig[];
  integrator: IntegratorConfig;
  budgets: BudgetConfig;
  /** Max number of role agents running in parallel. Default 3. */
  concurrency: number;
  /** The build task given to the agents. */
  task: string;
}

/** A message in the provider-neutral chat format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  usage: Usage;
}

/** File operations emitted by an agent, validated then applied to a worktree. */
export type FileOp =
  | { type: "write"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "note"; text: string }
  | { type: "contract"; name: string; content: string };

export interface AgentOutput {
  summary: string;
  ops: FileOp[];
}

export interface RoleRunResult {
  role: RoleConfig;
  model: string;
  provider: string;
  branch: string;
  worktree: string;
  summary: string;
  filesChanged: string[];
  notes: string[];
  usage: Usage;
  costUsd: number;
  durationMs: number;
  error?: string;
}

export interface IntegratorResult {
  model: string;
  provider: string;
  summary: string;
  mergeConflictsResolved: string[];
  filesChanged: string[];
  usage: Usage;
  costUsd: number;
  durationMs: number;
  error?: string;
}

export interface RunResult {
  projectName: string;
  task: string;
  mode: StrategyMode;
  startedAt: string;
  durationMs: number;
  roles: RoleRunResult[];
  integrator: IntegratorResult | null;
  totalUsage: Usage;
  totalCostUsd: number;
  reportPath: string;
  success: boolean;
}
