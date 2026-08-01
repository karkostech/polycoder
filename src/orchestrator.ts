/**
 * The Orchestrator — runs the whole pipeline:
 *   plan (parallel) → build (parallel, worktrees) → integrate → report → land on base branch
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { runBuildPhase, runPlanPhase, AgentContext } from "./agent.js";
import { Blackboard } from "./blackboard.js";
import { BudgetTracker, createLimiter } from "./budget.js";
import { runIntegrator } from "./integrator.js";
import { ensureRepo, currentHead, mergeBranch, commitAll, removeWorktree, abortMerge } from "./git.js";
import { writeReport } from "./report.js";
import { nowStamp } from "./fsutil.js";
import { ProjectConfig, RunResult, Usage } from "./types.js";

export interface OrchestratorOptions {
  projectRoot: string;
  onEvent?: (msg: string) => void;
  /** Keep agent worktrees on disk after the run (debugging). Default false. */
  keepWorktrees?: boolean;
}

export async function orchestrate(cfg: ProjectConfig, opts: OrchestratorOptions): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const runId = nowStamp();
  const emit = opts.onEvent ?? (() => {});
  const board = new Blackboard(opts.projectRoot);
  const budget = new BudgetTracker(cfg.budgets);

  const usageZero: Usage = { inputTokens: 0, outputTokens: 0 };
  const run: RunResult = {
    projectName: cfg.projectName,
    task: cfg.task,
    mode: cfg.mode,
    startedAt,
    durationMs: 0,
    roles: [],
    integrator: null,
    totalUsage: usageZero,
    totalCostUsd: 0,
    reportPath: "",
    success: false,
  };

  await board.init();
  await board.appendStatus("orchestrator", `**RUN ${runId}** — task: ${cfg.task.slice(0, 200)} (mode: ${cfg.mode}, roles: ${cfg.roles.map((r) => r.name).join(", ")})`);

  const baseBranch = await ensureRepo(opts.projectRoot);
  const baseRef = await currentHead(opts.projectRoot);
  emit(`repo ready on "${baseBranch}" @ ${baseRef.slice(0, 8)}`);

  const ctx: AgentContext = {
    projectRoot: opts.projectRoot,
    runId,
    baseRef,
    board,
    budget,
    onEvent: emit,
  };

  // ── Phase 1: PLAN (parallel, cheap) ──────────────────────────────────────
  emit(`phase 1/3 — planning (${cfg.roles.length} roles, concurrency ${cfg.concurrency})`);
  const limit = createLimiter(cfg.concurrency);
  await Promise.all(
    cfg.roles.map((role) =>
      limit(async () => {
        try {
          await runPlanPhase(cfg, role, ctx);
        } catch (err) {
          emit(`[${role.name}] planning failed (continuing): ${(err as Error).message}`);
          await board.appendStatus(role.name, `**PLAN FAILED:** ${(err as Error).message}`);
        }
      }),
    ),
  );

  // ── Phase 2: BUILD (parallel, one worktree per role) ─────────────────────
  emit(`phase 2/3 — building (${cfg.roles.length} roles in parallel worktrees)`);
  run.roles = await Promise.all(
    cfg.roles.map((role) => limit(() => runBuildPhase(cfg, role, ctx))),
  );

  const successful = run.roles.filter((r) => !r.error);
  if (successful.length === 0) {
    emit("no role produced output — skipping integration");
    run.durationMs = Date.now() - started;
    run.totalUsage = budget.totals.usage;
    run.totalCostUsd = budget.totals.costUsd;
    run.reportPath = await writeReport(opts.projectRoot, run, runId);
    return run;
  }

  // ── Phase 3: INTEGRATE ────────────────────────────────────────────────────
  emit("phase 3/3 — integration pass");
  const integrationBranch = `integration/${runId}`;
  const integrationWorktree = path.join(opts.projectRoot, ".agents", "worktrees", "integration");
  run.integrator = await runIntegrator(cfg, run.roles, {
    projectRoot: opts.projectRoot,
    integrationWorktree,
    integrationBranch,
    baseRef,
    board,
    budget,
    onEvent: emit,
  });

  // ── Land the result on the base branch ────────────────────────────────────
  if (!run.integrator.error) {
    const outcome = await mergeBranch(opts.projectRoot, integrationBranch);
    if (outcome.ok) {
      await commitAll(opts.projectRoot, `polycoder run ${runId}: ${cfg.task.slice(0, 60)}`);
      run.success = true;
      emit(`result landed on "${baseBranch}"`);
    } else {
      emit(`WARNING: landing merge on "${baseBranch}" conflicted — result stays on branch ${integrationBranch}`);
      await abortMerge(opts.projectRoot);
      run.success = false;
    }
  }

  // ── Cleanup + report ──────────────────────────────────────────────────────
  if (!opts.keepWorktrees) {
    for (const r of run.roles) {
      await removeWorktree(opts.projectRoot, r.worktree, r.branch, { deleteBranch: true });
    }
    await removeWorktree(opts.projectRoot, integrationWorktree, integrationBranch, {
      deleteBranch: run.success,
    });
    // Remove the now-empty worktrees parent dir (git leaves it behind).
    await fs
      .rm(path.join(opts.projectRoot, ".agents", "worktrees"), { recursive: true, force: true })
      .catch(() => {});
  }

  run.durationMs = Date.now() - started;
  run.totalUsage = budget.totals.usage;
  run.totalCostUsd = budget.totals.costUsd;
  run.reportPath = await writeReport(opts.projectRoot, run, runId);
  await board.appendStatus(
    "orchestrator",
    `**RUN ${runId} FINISHED** — success: ${run.success}, tokens: ${run.totalUsage.inputTokens}+${run.totalUsage.outputTokens}, cost: $${run.totalCostUsd.toFixed(4)}, duration: ${run.durationMs} ms. Report: ${run.reportPath}`,
  );
  return run;
}
