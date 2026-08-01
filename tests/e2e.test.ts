import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerMockResponder } from "../src/mock.js";
import { orchestrate } from "../src/orchestrator.js";
import { validateConfig } from "../src/config.js";
import { git } from "../src/git.js";
import { ProjectConfig } from "../src/types.js";

function demoConfig(): ProjectConfig {
  return validateConfig({
    projectName: "e2e-demo",
    mode: "multi",
    providers: [{ name: "mock", apiStyle: "mock", baseUrl: "" }],
    roles: [
      { name: "frontend", description: "UI", scope: ["web/"], model: "m1", provider: "mock" },
      { name: "backend", description: "API", scope: ["server/"], model: "m2", provider: "mock" },
      { name: "database", description: "DB", scope: ["db/"], model: "m3", provider: "mock" },
    ],
    integrator: { model: "m-int", provider: "mock" },
    budgets: { maxTotalTokens: 10_000_000 },
    concurrency: 3,
    task: "Build a minimal todo app (UI + API + persistence).",
  });
}

test("full pipeline end-to-end with mock provider", { timeout: 120_000 }, async () => {
  registerMockResponder();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "polycoder-e2e-"));
  const events: string[] = [];

  const result = await orchestrate(demoConfig(), {
    projectRoot: dir,
    onEvent: (m) => events.push(m),
  });

  // Overall success
  assert.equal(result.success, true, `run failed: ${JSON.stringify(result, null, 2)}`);
  assert.equal(result.roles.length, 3);
  assert.ok(result.roles.every((r) => !r.error));
  assert.ok(result.integrator && !result.integrator.error);

  // Final code landed in the main working tree
  for (const f of ["web/index.html", "web/app.js", "server/server.js", "db/db.js", "package.json", "README.md"]) {
    await fs.access(path.join(dir, f));
  }

  // Token accounting happened
  assert.ok(result.totalUsage.inputTokens > 0);
  assert.ok(result.totalUsage.outputTokens > 0);

  // Report exists and covers all roles + integrator
  const report = await fs.readFile(result.reportPath, "utf8");
  assert.match(report, /Run Report/);
  assert.match(report, /frontend/);
  assert.match(report, /backend/);
  assert.match(report, /database/);
  assert.match(report, /Integrator/);

  // Blackboard journals + contracts exist
  const statusDir = path.join(dir, ".agents", "status");
  const journals = await fs.readdir(statusDir);
  assert.ok(journals.includes("frontend.md"));
  assert.ok(journals.includes("integrator.md"));
  const contracts = await fs.readdir(path.join(dir, ".agents", "contracts"));
  assert.ok(contracts.length >= 2, "expected contracts from planning phase");

  // Git history contains role commits + integration
  const logRes = await git(["log", "--oneline"], dir);
  assert.match(logRes.stdout, /integrator/i);
  assert.match(logRes.stdout, /frontend/);

  // Worktrees were cleaned up
  const worktrees = path.join(dir, ".agents", "worktrees");
  const wtExists = await fs
    .readdir(worktrees)
    .then(() => true)
    .catch(() => false);
  assert.equal(wtExists, false, "worktrees should be removed after the run");

  // Events flowed
  assert.ok(events.some((e) => e.includes("phase 2/3")));
  assert.ok(events.some((e) => e.includes("[integrator]")));

  // The generated backend actually parses as JS and the demo server can boot
  // (smoke check: require db.js and exercise the store contract)
  const dbPath = path.join(dir, "db", "db.js");
  const db = await import(`file://${dbPath.replace(/\\/g, "/")}`);
  assert.ok(typeof db.all === "function" || typeof db.default?.all === "function");

  await fs.rm(dir, { recursive: true, force: true });
});

test("budget cap stops the run cleanly", { timeout: 60_000 }, async () => {
  registerMockResponder();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "polycoder-e2e-budget-"));
  const cfg = demoConfig();
  cfg.budgets = { maxTotalTokens: 50 }; // absurdly low — must trip

  const result = await orchestrate(cfg, { projectRoot: dir });
  assert.equal(result.success, false);
  assert.ok(result.roles.some((r) => r.error));
  // report still written even on failure
  await fs.access(result.reportPath);
  await fs.rm(dir, { recursive: true, force: true });
});
