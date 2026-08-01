/**
 * Role agent runner — one agent = one role = one git worktree = one branch.
 *
 * Two-phase protocol:
 *  1. PLAN    — the agent declares contracts + a short plan note on the blackboard
 *               (cheap call, lets parallel agents see each other's interfaces
 *               without reading code)
 *  2. BUILD   — the agent reads the full blackboard and implements its part
 */
import { Blackboard } from "./blackboard.js";
import { BudgetTracker, priceOf } from "./budget.js";
import { resolveRoleModel } from "./config.js";
import { OUTPUT_PROTOCOL, applyOps, parseAgentOutput } from "./fileops.js";
import { addWorktree, branchFor, commitAll, worktreeDirFor } from "./git.js";
import { chat, ChatOptions } from "./provider.js";
import { buildRoleSystemPrompt, buildRoleUserPrompt } from "./prompts.js";
import { ProjectConfig, RoleConfig, RoleRunResult, Usage } from "./types.js";

export interface AgentContext {
  projectRoot: string;
  runId: string;
  baseRef: string;
  board: Blackboard;
  budget: BudgetTracker;
  chatOptions?: ChatOptions;
  onEvent?: (msg: string) => void;
}

const PLAN_PROTOCOL = `This is the PLANNING phase. Do NOT write code yet.
Answer with exactly one JSON object:
{
  "summary": "2-4 sentences: your implementation plan",
  "ops": [
    { "type": "contract", "name": "api", "content": "markdown contract of every interface YOU will expose to other roles (endpoints, request/response shapes, types, file paths)" },
    { "type": "note", "text": "short note to the other parallel agents: what you will build and what you expect from them" }
  ]
}
Rules: no "write"/"delete" ops in this phase. Define contracts precisely — other agents will code against them without seeing your code.`;

export async function runPlanPhase(
  cfg: ProjectConfig,
  role: RoleConfig,
  ctx: AgentContext,
): Promise<{ usage: Usage; costUsd: number }> {
  const { model, provider } = resolveRoleModel(cfg, role);
  const system = buildRoleSystemPrompt(cfg, role, model) + "\n\n" + PLAN_PROTOCOL;
  const boardContext = await ctx.board.contextFor(role.name);
  const user = `# Project\n${cfg.projectName}\n\n# Task (you own: ${role.name})\n${cfg.task}\n\n# Shared blackboard\n${boardContext}\n\nProduce the planning JSON now.`;

  const res = await chat(provider, model, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], ctx.chatOptions ?? {});

  ctx.budget.record(model, res.usage);
  const cost = priceOf(cfg.budgets, model, res.usage);

  let planNote = "(planning produced no structured output)";
  try {
    const out = parseAgentOutput(res.text);
    planNote = out.summary;
    for (const op of out.ops) {
      if (op.type === "contract") {
        await ctx.board.writeContract(op.name, `# Contract: ${op.name}\n\n_Author: ${role.name} agent_\n\n${op.content}`);
      } else if (op.type === "note") {
        await ctx.board.appendStatus(role.name, `**PLAN note:** ${op.text}`);
      }
    }
  } catch {
    // Planning is best-effort: keep the raw text as a journal note.
    planNote = res.text.slice(0, 600);
  }
  await ctx.board.appendStatus(role.name, `**PLAN:** ${planNote}`);
  ctx.onEvent?.(`[${role.name}] plan ready (${res.usage.inputTokens}+${res.usage.outputTokens} tokens)`);
  return { usage: res.usage, costUsd: cost };
}

export async function runBuildPhase(
  cfg: ProjectConfig,
  role: RoleConfig,
  ctx: AgentContext,
): Promise<RoleRunResult> {
  const started = Date.now();
  const { model, provider } = resolveRoleModel(cfg, role);
  const branch = branchFor(role.name, ctx.runId);
  const worktree = worktreeDirFor(ctx.projectRoot, role.name);
  const result: RoleRunResult = {
    role,
    model,
    provider: provider.name,
    branch,
    worktree,
    summary: "",
    filesChanged: [],
    notes: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    durationMs: 0,
  };

  const roleUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  try {
    await addWorktree(ctx.projectRoot, worktree, branch, ctx.baseRef);
    ctx.onEvent?.(`[${role.name}] worktree ready on branch ${branch}`);

    const system = buildRoleSystemPrompt(cfg, role, model);
    const boardContext = await ctx.board.contextFor(role.name);
    const user = buildRoleUserPrompt(cfg, role, boardContext);

    const res = await chat(provider, model, [
      { role: "system", content: system },
      { role: "user", content: user },
    ], ctx.chatOptions ?? {});

    roleUsage.inputTokens += res.usage.inputTokens;
    roleUsage.outputTokens += res.usage.outputTokens;
    result.usage = { ...roleUsage };
    result.costUsd += priceOf(cfg.budgets, model, res.usage);
    ctx.budget.record(model, res.usage, roleUsage);

    const out = parseAgentOutput(res.text);
    result.summary = out.summary;

    const applied = await applyOps(worktree, out.ops, role.scope);
    result.filesChanged = applied.filesChanged;
    result.notes = applied.notes;

    for (const c of applied.contracts) {
      await ctx.board.writeContract(c.name, `# Contract: ${c.name}\n\n_Author: ${role.name} agent_\n\n${c.content}`);
    }

    const journalLines: string[] = [`**DONE:** ${out.summary}`];
    if (applied.filesChanged.length > 0) {
      journalLines.push(`**Files:** ${applied.filesChanged.join(", ")}`);
    }
    for (const n of applied.notes) journalLines.push(`**Note:** ${n}`);
    for (const s of applied.skipped) journalLines.push(`**Skipped ${s.path}:** ${s.reason}`);
    await ctx.board.appendStatus(role.name, journalLines.join("\n"));

    const committed = await commitAll(worktree, `feat(${role.name}): ${out.summary.slice(0, 60)}`);
    ctx.onEvent?.(
      `[${role.name}] build done — ${applied.filesChanged.length} files${committed ? ", committed" : ", no changes"}`,
    );
  } catch (err) {
    result.error = (err as Error).message;
    await ctx.board.appendStatus(role.name, `**FAILED:** ${result.error}`).catch(() => {});
    ctx.onEvent?.(`[${role.name}] FAILED: ${result.error}`);
  } finally {
    result.durationMs = Date.now() - started;
  }
  return result;
}

export { OUTPUT_PROTOCOL };
