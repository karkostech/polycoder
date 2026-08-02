/**
 * Thin async wrapper over the git CLI. Uses execFile (no shell) — safe args.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "./fsutil.js";

const execFileP = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  /** Process exit code — 0 on success. */
  code: number;
}

export async function git(args: string[], cwd: string, opts?: { allowFail?: boolean }): Promise<GitRunResult> {
  try {
    const { stdout, stderr } = await execFileP("git", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string; code?: number };
    const stderr = e.stderr?.toString() ?? e.message ?? "unknown git error";
    if (opts?.allowFail) {
      return { stdout: e.stdout?.toString() ?? "", stderr, code: typeof e.code === "number" ? e.code : 1 };
    }
    throw new GitError(`git ${args.join(" ")} failed: ${stderr.trim()}`, stderr);
  }
}

export async function isGitInstalled(): Promise<boolean> {
  try {
    await execFileP("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function isInsideRepo(cwd: string): Promise<boolean> {
  const r = await git(["rev-parse", "--is-inside-work-tree"], cwd, { allowFail: true });
  return r.stdout.trim() === "true";
}

/** Initialize a repo with an initial empty commit if needed. Returns the base branch. */
export async function ensureRepo(cwd: string): Promise<string> {
  if (!(await isInsideRepo(cwd))) {
    await git(["init", "-b", "main"], cwd);
  }
  // Keep chalkcode's internal worktrees out of commits, even when the project
  // has no .gitignore entry for them. Uses the repo-local exclude file so the
  // user's own .gitignore is never touched. Without this, `git add -A` records
  // the live worktrees as gitlink entries.
  const gitDirRaw = (await git(["rev-parse", "--git-dir"], cwd)).stdout.trim();
  const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.join(cwd, gitDirRaw);
  const excludePath = path.join(gitDir, "info", "exclude");
  const excludeLine = ".agents/worktrees/";
  try {
    const existing = await fs.readFile(excludePath, "utf8").catch(() => "");
    if (!existing.split("\n").some((l) => l.trim() === excludeLine)) {
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      await fs.appendFile(excludePath, `\n# chalkcode internals\n${excludeLine}\n`, "utf8");
    }
  } catch {
    // Non-fatal: worst case the worktree gitlinks get committed.
  }
  // Ensure an initial commit exists so branches/worktrees can be created.
  const hasCommit = await git(["rev-parse", "--verify", "HEAD"], cwd, { allowFail: true });
  if (!hasCommit.stdout.trim()) {
    await git(["add", "-A"], cwd);
    await git(
      ["-c", "user.name=chalkcode", "-c", "user.email=chalkcode@local", "commit", "--allow-empty", "-m", "chore: initial commit"],
      cwd,
    );
  }
  const branch = await git(["branch", "--show-current"], cwd);
  return branch.stdout.trim() || "main";
}

export async function currentHead(cwd: string): Promise<string> {
  const r = await git(["rev-parse", "HEAD"], cwd);
  return r.stdout.trim();
}

/** Create (or reuse) a worktree on branch `branch` at `dir`, based on `baseRef`. */
export async function addWorktree(cwd: string, dir: string, branch: string, baseRef: string): Promise<void> {
  if (await pathExists(dir)) {
    // Reuse existing worktree — make sure the branch is checked out there.
    await git(["checkout", branch], dir, { allowFail: true });
    return;
  }
  const branchExists = await git(["rev-parse", "--verify", `refs/heads/${branch}`], cwd, { allowFail: true });
  if (branchExists.stdout.trim()) {
    await git(["worktree", "add", dir, branch], cwd);
  } else {
    await git(["worktree", "add", "-b", branch, dir, baseRef], cwd);
  }
}

export async function removeWorktree(cwd: string, dir: string, branch: string, opts?: { deleteBranch?: boolean }): Promise<void> {
  await git(["worktree", "remove", "--force", dir], cwd, { allowFail: true });
  if (opts?.deleteBranch) {
    await git(["branch", "-D", branch], cwd, { allowFail: true });
  }
}

/** Stage everything and commit if there are changes. Returns true when a commit was created. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(["add", "-A"], cwd);
  const status = await git(["status", "--porcelain"], cwd);
  if (!status.stdout.trim()) return false;
  await git(["-c", "user.name=chalkcode", "-c", "user.email=chalkcode@local", "commit", "-m", message], cwd);
  return true;
}

export interface MergeOutcome {
  ok: boolean;
  conflictedFiles: string[];
}

/** Merge `branch` into the current branch of `cwd`. Never auto-commits conflicted state. */
export async function mergeBranch(cwd: string, branch: string): Promise<MergeOutcome> {
  // Identity flags: `git merge --no-commit` still validates the committer
  // ident on several git versions and dies without one (e.g. fresh CI runners
  // with no global git config). Never rely on ambient git config.
  const r = await git(
    ["-c", "user.name=chalkcode", "-c", "user.email=chalkcode@local", "merge", "--no-ff", "--no-commit", branch],
    cwd,
    { allowFail: true },
  );
  const conflicts = await conflictedFiles(cwd);
  if (conflicts.length > 0) {
    return { ok: false, conflictedFiles: conflicts };
  }
  const stderr = (r.stderr ?? "").toLowerCase();
  if (stderr.includes("conflict")) {
    return { ok: false, conflictedFiles: conflicts };
  }
  // A non-zero exit without conflicts is a hard failure (bad ref, missing
  // ident, unrelated histories…) — never mask it as a clean merge.
  if (r.code !== 0) {
    throw new GitError(`git merge ${branch} failed: ${r.stderr.trim()}`, r.stderr);
  }
  return { ok: true, conflictedFiles: [] };
}

export async function conflictedFiles(cwd: string): Promise<string[]> {
  const r = await git(["diff", "--name-only", "--diff-filter=U"], cwd, { allowFail: true });
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function abortMerge(cwd: string): Promise<void> {
  await git(["merge", "--abort"], cwd, { allowFail: true });
}

export async function listChangedFiles(cwd: string, baseRef: string, headRef: string): Promise<string[]> {
  const r = await git(["diff", "--name-only", `${baseRef}..${headRef}`], cwd, { allowFail: true });
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function diffStat(cwd: string, baseRef: string, headRef: string): Promise<string> {
  const r = await git(["diff", "--stat", `${baseRef}..${headRef}`], cwd, { allowFail: true });
  return r.stdout.trim();
}

/** Read a file as of a ref (for conflict resolution context). */
export async function showFile(cwd: string, ref: string, file: string): Promise<string> {
  const r = await git(["show", `${ref}:${file.replace(/\\/g, "/")}`], cwd, { allowFail: true });
  return r.stdout;
}

export function worktreeDirFor(projectRoot: string, role: string): string {
  return path.join(projectRoot, ".agents", "worktrees", role);
}

export function branchFor(role: string, runId: string): string {
  return `agent/${role}/${runId}`;
}
