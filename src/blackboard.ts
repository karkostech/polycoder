/**
 * The Blackboard — `.agents/` directory shared by all agents.
 *
 * Layout:
 *   .agents/
 *     status/<role>.md     — append-only journal of each agent (what/why/next)
 *     contracts/<name>.md  — interface contracts between roles (API shapes, types)
 *     report-<stamp>.md    — final run report
 *
 * Agents read contracts + other agents' journals instead of reading each
 * other's code — that is the token-saving core of PolyCoder.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { ensureDir, pathExists, readTextFile, writeTextFile } from "./fsutil.js";

export const BOARD_DIR = ".agents";
const STATUS_DIR = "status";
const CONTRACTS_DIR = "contracts";
const MAX_JOURNAL_CHARS_PER_ROLE = 4000;
const MAX_CONTRACT_CHARS = 8000;

export class Blackboard {
  readonly root: string;

  constructor(projectRoot: string) {
    this.root = path.join(projectRoot, BOARD_DIR);
  }

  async init(): Promise<void> {
    await ensureDir(path.join(this.root, STATUS_DIR));
    await ensureDir(path.join(this.root, CONTRACTS_DIR));
  }

  statusPath(role: string): string {
    return path.join(this.root, STATUS_DIR, `${role}.md`);
  }

  contractPath(name: string): string {
    const safe = name.replace(/[^a-z0-9-_]/gi, "-").toLowerCase();
    return path.join(this.root, CONTRACTS_DIR, `${safe}.md`);
  }

  /** Append a timestamped journal entry for a role. */
  async appendStatus(role: string, text: string): Promise<void> {
    await this.init();
    const file = this.statusPath(role);
    const stamp = new Date().toISOString();
    const entry = `\n## ${stamp}\n\n${text.trim()}\n`;
    if (await pathExists(file)) {
      await fs.appendFile(file, entry, "utf8");
    } else {
      await writeTextFile(file, `# Journal: ${role}\n${entry}`);
    }
  }

  /** Write (replace) a contract document. */
  async writeContract(name: string, content: string): Promise<void> {
    await this.init();
    await writeTextFile(this.contractPath(name), content.trim() + "\n");
  }

  async listContracts(): Promise<string[]> {
    const dir = path.join(this.root, CONTRACTS_DIR);
    if (!(await pathExists(dir))) return [];
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
  }

  async readContract(name: string): Promise<string | undefined> {
    const file = this.contractPath(name);
    if (!(await pathExists(file))) return undefined;
    return readTextFile(file);
  }

  private async readTail(file: string, maxChars: number): Promise<string> {
    const full = await readTextFile(file);
    if (full.length <= maxChars) return full;
    return "…(earlier entries truncated)…\n" + full.slice(full.length - maxChars);
  }

  /**
   * Build the shared context block for an agent prompt:
   * all contracts + journals of OTHER roles (truncated, newest last).
   */
  async contextFor(currentRole: string): Promise<string> {
    await this.init();
    const parts: string[] = [];

    const contracts = await this.listContracts();
    for (const name of contracts) {
      const content = await this.readContract(name);
      if (content) {
        const trimmed =
          content.length > MAX_CONTRACT_CHARS
            ? content.slice(0, MAX_CONTRACT_CHARS) + "\n…(contract truncated)…"
            : content;
        parts.push(`### Contract: ${name}\n\n${trimmed}`);
      }
    }

    const statusDir = path.join(this.root, STATUS_DIR);
    if (await pathExists(statusDir)) {
      const files = (await fs.readdir(statusDir)).filter((f) => f.endsWith(".md"));
      for (const f of files.sort()) {
        const role = f.replace(/\.md$/, "");
        if (role === currentRole) continue;
        const tail = await this.readTail(path.join(statusDir, f), MAX_JOURNAL_CHARS_PER_ROLE);
        if (tail.trim()) parts.push(`### Journal of agent "${role}"\n\n${tail.trim()}`);
      }
    }

    if (parts.length === 0) {
      return "(The blackboard is empty — you are the first agent to run. If you define interfaces other roles need, emit them as contract ops.)";
    }
    return parts.join("\n\n---\n\n");
  }
}
