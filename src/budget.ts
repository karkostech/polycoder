/**
 * Token / cost budget enforcement.
 */
import { BudgetConfig, Usage } from "./types.js";

export class BudgetExceededError extends Error {
  constructor(
    public readonly kind: "role-tokens" | "total-tokens" | "cost",
    message: string,
  ) {
    super(message);
  }
}

export function priceOf(cfg: BudgetConfig, model: string, usage: Usage): number {
  const p = cfg.pricing?.[model];
  if (!p) return 0;
  return (usage.inputTokens / 1_000_000) * p.input + (usage.outputTokens / 1_000_000) * p.output;
}

export class BudgetTracker {
  private total: Usage = { inputTokens: 0, outputTokens: 0 };
  private totalCost = 0;

  constructor(private readonly cfg: BudgetConfig) {}

  /** Record usage for a model call. Throws BudgetExceededError when a cap is crossed. */
  record(model: string, usage: Usage, roleUsageTotal?: Usage): void {
    const nextTotal: Usage = {
      inputTokens: this.total.inputTokens + usage.inputTokens,
      outputTokens: this.total.outputTokens + usage.outputTokens,
    };
    const nextCost = this.totalCost + priceOf(this.cfg, model, usage);

    if (this.cfg.maxTotalTokens && nextTotal.inputTokens + nextTotal.outputTokens > this.cfg.maxTotalTokens) {
      throw new BudgetExceededError(
        "total-tokens",
        `Total token budget exceeded (${nextTotal.inputTokens + nextTotal.outputTokens} > ${this.cfg.maxTotalTokens}).`,
      );
    }
    if (
      roleUsageTotal &&
      this.cfg.maxTokensPerRole &&
      roleUsageTotal.inputTokens + roleUsageTotal.outputTokens > this.cfg.maxTokensPerRole
    ) {
      throw new BudgetExceededError(
        "role-tokens",
        `Per-role token budget exceeded (${roleUsageTotal.inputTokens + roleUsageTotal.outputTokens} > ${this.cfg.maxTokensPerRole}).`,
      );
    }
    if (this.cfg.maxCostUsd && nextCost > this.cfg.maxCostUsd) {
      throw new BudgetExceededError(
        "cost",
        `Cost budget exceeded ($${nextCost.toFixed(4)} > $${this.cfg.maxCostUsd.toFixed(4)}).`,
      );
    }

    this.total = nextTotal;
    this.totalCost = nextCost;
  }

  get totals(): { usage: Usage; costUsd: number } {
    return { usage: { ...this.total }, costUsd: this.totalCost };
  }
}

/** Tiny concurrency limiter (p-limit style, zero deps). */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    const run = queue.shift();
    if (run) run();
  };
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}
