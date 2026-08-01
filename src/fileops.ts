/**
 * Parsing, validating and applying the structured agent output.
 *
 * Agents must answer with ONE JSON object:
 * {
 *   "summary": "what was done and why",
 *   "ops": [
 *     { "type": "write",    "path": "src/web/App.tsx", "content": "..." },
 *     { "type": "delete",   "path": "src/old.ts" },
 *     { "type": "note",     "text": "journal note for other agents" },
 *     { "type": "contract", "name": "api", "content": "# API contract..." }
 *   ]
 * }
 *
 * The parser is tolerant: it finds the first balanced {...} block even when
 * the model wraps it in ```json fences or adds prose around it.
 */
import { promises as fs } from "node:fs";
import { AgentOutput, FileOp } from "./types.js";
import { resolveInside } from "./fsutil.js";

export class FileOpError extends Error {}

/** Extract the first balanced JSON object from arbitrary text. */
export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) throw new FileOpError("Agent output contains no JSON object.");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new FileOpError("Agent output JSON is unbalanced (missing closing brace).");
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function validateOp(raw: unknown, idx: number): FileOp {
  if (typeof raw !== "object" || raw === null) {
    throw new FileOpError(`ops[${idx}] must be an object.`);
  }
  const o = raw as Record<string, unknown>;
  const type = o.type;
  if (type === "write") {
    if (typeof o.path !== "string" || typeof o.content !== "string") {
      throw new FileOpError(`ops[${idx}] (write) needs string "path" and "content".`);
    }
    return { type, path: normalizePath(o.path), content: o.content };
  }
  if (type === "delete") {
    if (typeof o.path !== "string") {
      throw new FileOpError(`ops[${idx}] (delete) needs string "path".`);
    }
    return { type, path: normalizePath(o.path) };
  }
  if (type === "note") {
    if (typeof o.text !== "string") {
      throw new FileOpError(`ops[${idx}] (note) needs string "text".`);
    }
    return { type, text: o.text };
  }
  if (type === "contract") {
    if (typeof o.name !== "string" || typeof o.content !== "string") {
      throw new FileOpError(`ops[${idx}] (contract) needs string "name" and "content".`);
    }
    return { type, name: o.name, content: o.content };
  }
  throw new FileOpError(`ops[${idx}] has unknown type "${String(type)}".`);
}

export function parseAgentOutput(text: string): AgentOutput {
  const jsonText = extractJsonObject(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new FileOpError(`Agent output JSON does not parse: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new FileOpError("Agent output JSON must be an object.");
  }
  const root = parsed as Record<string, unknown>;
  const summary = typeof root.summary === "string" ? root.summary : "(no summary provided)";
  if (!Array.isArray(root.ops)) {
    throw new FileOpError(`Agent output must contain an "ops" array.`);
  }
  const ops = root.ops.map(validateOp);
  return { summary, ops };
}

/** True when `filePath` is inside one of the scope prefixes. Empty scope = everything allowed. */
export function pathAllowedByScope(filePath: string, scope: string[]): boolean {
  if (scope.length === 0) return true;
  const p = normalizePath(filePath);
  return scope.some((prefix) => {
    const norm = normalizePath(prefix).replace(/\/+$/, "");
    return p === norm || p.startsWith(norm + "/");
  });
}

export interface ApplyResult {
  filesChanged: string[];
  notes: string[];
  contracts: Array<{ name: string; content: string }>;
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Apply ops to a working directory.
 * - paths are confined to `workdir` (traversal-safe)
 * - when `scope` is non-empty, write/delete outside the scope are skipped (not fatal)
 */
export async function applyOps(
  workdir: string,
  ops: FileOp[],
  scope: string[],
): Promise<ApplyResult> {
  const result: ApplyResult = { filesChanged: [], notes: [], contracts: [], skipped: [] };

  for (const op of ops) {
    if (op.type === "note") {
      result.notes.push(op.text);
      continue;
    }
    if (op.type === "contract") {
      result.contracts.push({ name: op.name, content: op.content });
      continue;
    }

    if (!pathAllowedByScope(op.path, scope)) {
      result.skipped.push({ path: op.path, reason: `outside role scope (${scope.join(", ")})` });
      continue;
    }

    let abs: string;
    try {
      abs = resolveInside(workdir, op.path);
    } catch (err) {
      result.skipped.push({ path: op.path, reason: (err as Error).message });
      continue;
    }

    if (op.type === "write") {
      const dir = abs.slice(0, abs.lastIndexOf("/"));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(abs, op.content, "utf8");
      result.filesChanged.push(op.path);
    } else if (op.type === "delete") {
      try {
        await fs.rm(abs, { force: true });
        result.filesChanged.push(op.path);
      } catch {
        result.skipped.push({ path: op.path, reason: "delete failed" });
      }
    }
  }
  return result;
}

/** The output protocol description injected into every agent prompt. */
export const OUTPUT_PROTOCOL = `You MUST answer with exactly one JSON object (no prose before or after, no markdown fences):

{
  "summary": "2-5 sentences: what you did, what is done, what remains and what other agents must know",
  "ops": [
    { "type": "write", "path": "relative/path.ext", "content": "full file content" },
    { "type": "delete", "path": "relative/path.ext" },
    { "type": "note", "text": "short status note for the other agents working in parallel" },
    { "type": "contract", "name": "api", "content": "markdown document defining an interface contract (endpoints, types, shapes) that other roles must follow" }
  ]
}

Rules:
- "write" always contains the COMPLETE file content, never a diff or a fragment.
- Paths are always relative to the project root, forward slashes, never start with "../".
- Emit a "contract" op whenever you create an interface another role consumes (API endpoints, shared types, DB schema).
- Emit at least one "note" op summarizing your final state for the other agents.`;
