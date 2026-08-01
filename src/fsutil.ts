/**
 * Small filesystem helpers.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJsonFile<T>(file: string): Promise<T> {
  const raw = await fs.readFile(file, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
}

export async function writeJsonFile(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Write a file, creating parent directories. */
export async function writeTextFile(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, content, "utf8");
}

export async function readTextFile(file: string): Promise<string> {
  return fs.readFile(file, "utf8");
}

/**
 * Parse a simple dotenv-style file (KEY=value lines, # comments, optional quotes).
 * Returns an object; does NOT touch process.env.
 */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

/**
 * Resolve a (possibly relative) path inside a base directory and guarantee
 * the result stays inside that base. Throws on traversal attempts.
 */
export function resolveInside(base: string, rel: string): string {
  const normalized = rel.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Absolute paths are not allowed: "${rel}"`);
  }
  const resolved = path.resolve(base, normalized);
  const baseResolved = path.resolve(base);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    throw new Error(`Path escapes the project directory: "${rel}"`);
  }
  return resolved;
}

export function nowStamp(): string {
  // 2026-08-01T18-05-30 — filesystem friendly
  return new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}
