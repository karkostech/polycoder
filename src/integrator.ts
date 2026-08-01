/**
 * The Integrator — merges all role branches into an integration worktree,
 * resolves conflicts with the model if needed, then runs a final
 * cross-wiring pass and commits the result.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { Blackboard } from "./blackboard.js";
import { BudgetTracker, priceOf } from "./budget.js";
import { resolveIntegratorModel } from "./config.js";
import { applyOps, parseAgentOutput } from "./fileops.js";
import {
  abortMerge,
  addWorktree,
  commitAll,
  conflictedFiles,
  listChangedFiles,
  mergeBranch,
} from "./git.js";
import { chat, ChatOptions } from "./provider.js";
import {
  buildConflictResolutionPrompt,
  buildIntegratorSystemPrompt,
  buildIntegratorUserPrompt,
} from "./prompts.js";
import { IntegratorResult, ProjectConfig, RoleRunResult, Usage } from "./types.js";

const MAX_KEY_FILE_CHARS = 6000;
const MAX_KEY_FILES = 12;

export interface IntegratorContext {
  projectRoot: string;
  integrationWorktree: string;
  integrationBranch: string;
  baseRef: string;
  board: Blackboard;
  budget: BudgetTracker;
  chatOptions?: ChatOptions;
  onEvent?: (msg: string) => void;
}

async function readIfSmall(absPath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile() || stat.size > MAX_KEY_FILE_CHARS * 2) return undefined;
    const text = await fs.readFile(absPath, "utf8");
    return text.length > MAX_KEY_FILE_CHARS ? text.slice(0, MAX_KEY_FILE_CHARS) + "\n…(truncated)…" : text;
  } catch {
    return undefined;
  }
}

const KEY_FILE_PATTERNS = [
  /package\.json$/,
  /tsconfig.*\.json$/,
  /index\.(html|js|ts|tsx|jsx)$/,
  /main\.(js|ts|tsx|jsx)$/,
  /server\.(js|ts)$/,
  /app\.(js|ts|tsx|jsx)$/i,
  /readme\.md$/i,
  /\.env\.example$/,
  /schema\.(sql|prisma)$/,
];

export async function runIntegrator(
  cfg: ProjectConfig,
  roleResults: RoleRunResult[],
  ctx: IntegratorContext,
): Promise<IntegratorResult> {
  const started = Date.now();
  const { model, provider } = resolveIntegratorModel(cfg);
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const result: IntegratorResult = {
    model,
    provider: provider.name,
    summary: "",
    mergeConflictsResolved: [],
    filesChanged: [],
    usage,
    costUsd: 0,
    durationMs: 0,
  };

  const recordUsage = (u: Usage) => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    result.costUsd += priceOf(cfg.budgets, model, u);
    ctx.budget.record(model, u);
  };

  try {
    // 1. Integration worktree on a fresh branch from base.
    await addWorktree(ctx.projectRoot, ctx.integrationWorktree, ctx.integrationBranch, ctx.baseRef);
    ctx.onEvent?.(`[integrator] worktree ready on branch ${ctx.integrationBranch}`);

    // 2. Merge every successful role branch.
    const successful = roleResults.filter((r) => !r.error);
    for (const r of successful) {
      const outcome = await mergeBranch(ctx.integrationWorktree, r.branch);
      if (!outcome.ok) {
        ctx.onEvent?.(
          `[integrator] merge of ${r.branch} produced ${outcome.conflictedFiles.length} conflict(s) — asking the model to resolve`,
        );
        const conflicts = [];
        for (const file of outcome.conflictedFiles) {
          const content = await readIfSmall(path.join(ctx.integrationWorktree, file));
          if (content !== undefined) conflicts.push({ path: file, content });
        }
        const boardContext = await ctx.board.contextFor("integrator");
        const res = await chat(provider, model, [
          { role: "system", content: buildIntegratorSystemPrompt(cfg, model, cfg.integrator.promptExtra) },
          { role: "user", content: buildConflictResolutionPrompt(cfg, conflicts, boardContext) },
        ], ctx.chatOptions ?? {});
        recordUsage(res.usage);

        const out = parseAgentOutput(res.text);
        const applied = await applyOps(ctx.integrationWorktree, out.ops, []); // integrator: no scope limit
        result.mergeConflictsResolved.push(...outcome.conflictedFiles);
        result.filesChanged.push(...applied.filesChanged);
        // Clear merge state: stage resolved files.
        await commitAll(ctx.integrationWorktree, `merge(${r.role.name}): resolve conflicts`);
      } else {
        await commitAll(ctx.integrationWorktree, `merge(${r.role.name}): integrate branch ${r.branch}`);
        ctx.onEvent?.(`[integrator] merged ${r.branch} cleanly`);
      }
    }

    // 3. Gather merged tree state for the final pass.
    const changed = await listChangedFiles(ctx.integrationWorktree, ctx.baseRef, "HEAD");
    const keySections: string[] = [];
    let readCount = 0;
    for (const file of changed) {
      if (readCount >= MAX_KEY_FILES) break;
      if (!KEY_FILE_PATTERNS.some((re) => re.test(file))) continue;
      const content = await readIfSmall(path.join(ctx.integrationWorktree, file));
      if (content !== undefined) {
        keySections.push(`## ${file}\n\`\`\`\n${content}\n\`\`\``);
        readCount++;
      }
    }

    // Any unresolved conflicts left? (should not be, but be safe)
    const leftover = await conflictedFiles(ctx.integrationWorktree);
    const conflictsSection =
      leftover.length > 0
        ? `# WARNING: unresolved conflict markers remain in: ${leftover.join(", ")} — fix them now with write ops.`
        : "";

    // 4. Final integration pass.
    const boardContext = await ctx.board.contextFor("integrator");
    const res = await chat(provider, model, [
      { role: "system", content: buildIntegratorSystemPrompt(cfg, model, cfg.integrator.promptExtra) },
      {
        role: "user",
        content: buildIntegratorUserPrompt(
          cfg,
          boardContext,
          changed.map((f) => `- ${f}`).join("\n"),
          keySections.join("\n\n"),
          conflictsSection,
        ),
      },
    ], ctx.chatOptions ?? {});
    recordUsage(res.usage);

    const out = parseAgentOutput(res.text);
    result.summary = out.summary;
    const applied = await applyOps(ctx.integrationWorktree, out.ops, []);
    result.filesChanged.push(...applied.filesChanged.filter((f) => !result.filesChanged.includes(f)));

    await ctx.board.appendStatus("integrator", `**INTEGRATION:** ${out.summary}`);
    await commitAll(ctx.integrationWorktree, `integrator: ${out.summary.slice(0, 60)}`);
    ctx.onEvent?.(`[integrator] integration pass done — ${result.filesChanged.length} files touched`);
  } catch (err) {
    result.error = (err as Error).message;
    await abortMerge(ctx.integrationWorktree).catch(() => {});
    await ctx.board.appendStatus("integrator", `**FAILED:** ${result.error}`).catch(() => {});
    ctx.onEvent?.(`[integrator] FAILED: ${result.error}`);
  } finally {
    result.durationMs = Date.now() - started;
  }
  return result;
}
