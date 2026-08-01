#!/usr/bin/env node
/**
 * Cross-platform, cross-Node test runner.
 * `node --test "glob"` only supports globs on Node >= 21 and behaves
 * differently across shells (sh vs cmd.exe). This enumerates the compiled
 * test files explicitly and passes them as plain paths — works everywhere.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const testsDir = path.join("dist", "tests");
const files = readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => path.join(testsDir, f));

if (files.length === 0) {
  console.error(`no compiled tests found in ${testsDir} — run "npm run build" first`);
  process.exit(1);
}

console.log(`running ${files.length} test files:\n  ${files.join("\n  ")}`);
const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(res.status ?? 1);
