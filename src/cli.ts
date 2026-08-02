#!/usr/bin/env node
/**
 * ChalkCode CLI — multi-model AI coding orchestrator.
 *
 * Commands:
 *   chalkcode init [--demo] [--mode single|multi] [--task "..."]
 *   chalkcode run [--keep-worktrees] [--no-color]
 *   chalkcode doctor
 *   chalkcode report
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONFIG_FILE,
  ConfigError,
  loadConfig,
  loadEnvFile,
  missingApiKeys,
} from "./config.js";
import { fmt, log, setColor } from "./logger.js";
import { registerMockResponder } from "./mock.js";
import { orchestrate } from "./orchestrator.js";
import { isGitInstalled, isInsideRepo } from "./git.js";
import { pathExists, readTextFile, writeJsonFile, writeTextFile } from "./fsutil.js";
import { ProjectConfig } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function version(): Promise<string> {
  // Compiled layout: dist/src/cli.js → package.json is two levels up.
  try {
    const pkg = JSON.parse(await readTextFile(path.join(__dirname, "..", "..", "package.json")));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface ParsedArgs {
  command: string | undefined;
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        flags.set(a.slice(2), argv[++i]!);
      } else {
        flags.set(a.slice(2), true);
      }
    } else if (!command) {
      command = a;
    }
  }
  return { command, flags };
}

function demoConfig(task?: string): ProjectConfig {
  return {
    projectName: "chalkcode-demo",
    mode: "multi",
    providers: [{ name: "mock", apiStyle: "mock", baseUrl: "" }],
    roles: [
      {
        name: "frontend",
        description: "Owns the web UI — everything under web/.",
        scope: ["web/"],
        model: "mock-frontend",
        provider: "mock",
      },
      {
        name: "backend",
        description: "Owns the HTTP API server — everything under server/.",
        scope: ["server/"],
        model: "mock-backend",
        provider: "mock",
      },
      {
        name: "database",
        description: "Owns persistence — everything under db/.",
        scope: ["db/"],
        model: "mock-db",
        provider: "mock",
      },
    ],
    integrator: { model: "mock-integrator", provider: "mock" },
    budgets: { maxTotalTokens: 1_000_000 },
    concurrency: 3,
    task:
      task ??
      "Build a minimal but working todo web app: a web UI to list/add/toggle items, an HTTP JSON API, and a persistence layer. Vanilla stack, zero npm dependencies.",
  };
}

function templateConfig(mode: "single" | "multi", task?: string): ProjectConfig {
  const base: ProjectConfig = {
    projectName: "my-project",
    mode,
    providers: [
      {
        name: "openai",
        apiStyle: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      {
        name: "anthropic",
        apiStyle: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
      {
        name: "moonshot",
        apiStyle: "openai",
        baseUrl: "https://api.moonshot.ai/v1",
        apiKeyEnv: "MOONSHOT_API_KEY",
      },
    ],
    roles: [],
    integrator: {},
    budgets: {
      maxTokensPerRole: 400_000,
      maxTotalTokens: 2_000_000,
      pricing: {},
    },
    concurrency: 3,
    task: task ?? "Describe what you want the agents to build.",
  };

  if (mode === "single") {
    base.defaultProvider = "openai";
    base.defaultModel = "gpt-5";
    base.roles = [
      { name: "frontend", description: "Owns the web UI under web/.", scope: ["web/"] },
      { name: "backend", description: "Owns the API server under server/.", scope: ["server/"] },
      { name: "database", description: "Owns persistence under db/.", scope: ["db/"] },
    ];
  } else {
    base.roles = [
      {
        name: "frontend",
        description: "Owns the web UI under web/.",
        scope: ["web/"],
        model: "gpt-5",
        provider: "openai",
      },
      {
        name: "backend",
        description: "Owns the API server under server/.",
        scope: ["server/"],
        model: "claude-sonnet-4-5",
        provider: "anthropic",
      },
      {
        name: "database",
        description: "Owns persistence under db/.",
        scope: ["db/"],
        model: "kimi-k2",
        provider: "moonshot",
      },
    ];
    base.integrator = { model: "gpt-5", provider: "openai" };
  }
  return base;
}

const ENV_EXAMPLE = `# ChalkCode API keys — one per provider you use.
# This file is gitignored. Never commit real keys.
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
MOONSHOT_API_KEY=
`;

async function cmdInit(flags: Map<string, string | boolean>, cwd: string): Promise<number> {
  const target = path.join(cwd, CONFIG_FILE);
  if (await pathExists(target)) {
    log.error(`${CONFIG_FILE} already exists — delete it first if you want to re-init.`);
    return 1;
  }

  const demo = flags.has("demo");
  const mode = (flags.get("mode") === "single" ? "single" : "multi") as "single" | "multi";
  const task = typeof flags.get("task") === "string" ? (flags.get("task") as string) : undefined;
  const cfg = demo ? demoConfig(task) : templateConfig(mode, task);

  await writeJsonFile(target, cfg);
  await writeTextFile(path.join(cwd, ".env.example"), ENV_EXAMPLE);

  const gitignore = path.join(cwd, ".gitignore");
  const ignoreLines = [".agents/worktrees/", ".env"];
  if (await pathExists(gitignore)) {
    const existing = await readTextFile(gitignore);
    const toAdd = ignoreLines.filter((l) => !existing.includes(l));
    if (toAdd.length > 0) await fs.appendFile(gitignore, "\n" + toAdd.join("\n") + "\n", "utf8");
  } else {
    await writeTextFile(gitignore, ignoreLines.join("\n") + "\n");
  }

  if (demo) {
    log.ok(`Created ${CONFIG_FILE} (demo mode — offline mock provider, no API keys needed).`);
    log.dim("Run it with:  chalkcode run");
  } else {
    log.ok(`Created ${CONFIG_FILE} (${mode} mode) and .env.example.`);
    log.dim("Next steps:");
    log.dim("  1. Copy .env.example to .env and fill in your API keys");
    log.dim(`  2. Edit ${CONFIG_FILE}: models, roles, scopes, task`);
    log.dim("  3. chalkcode run");
  }
  return 0;
}

async function cmdDoctor(cwd: string): Promise<number> {
  log.section("ChalkCode doctor");
  let problems = 0;

  if (await isGitInstalled()) {
    log.ok("git is installed");
  } else {
    log.error("git is NOT installed or not on PATH — ChalkCode needs it for worktrees.");
    problems++;
  }

  if (await isInsideRepo(cwd)) {
    log.ok("current directory is a git repository");
  } else {
    log.warn("current directory is not a git repository yet — one will be created on first run.");
  }

  if (!(await pathExists(path.join(cwd, CONFIG_FILE)))) {
    log.error(`no ${CONFIG_FILE} found — run "chalkcode init".`);
    return 1;
  }

  let cfg;
  try {
    await loadEnvFile(cwd);
    cfg = await loadConfig(cwd);
    log.ok(`${CONFIG_FILE} is valid (mode: ${cfg.mode}, roles: ${cfg.roles.map((r) => r.name).join(", ")})`);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(`config invalid: ${err.message}`);
    } else {
      log.error(`config unreadable: ${(err as Error).message}`);
    }
    return 1;
  }

  const missing = missingApiKeys(cfg);
  if (missing.length === 0) {
    log.ok("all required API keys are present in the environment");
  } else {
    for (const m of missing) log.warn(`missing API key for provider: ${m}`);
    problems++;
  }

  for (const p of cfg.providers) {
    log.dim(`provider ${p.name}: style=${p.apiStyle}${p.baseUrl ? ` base=${p.baseUrl}` : ""}`);
    if (p.baseUrl && !p.baseUrl.startsWith("https://")) {
      log.warn(`provider ${p.name}: baseUrl is not HTTPS — API keys would be sent unencrypted.`);
    }
  }

  if (problems > 0) {
    log.warn(`${problems} problem(s) found.`);
    return 1;
  }
  log.ok("everything looks ready — run: chalkcode run");
  return 0;
}

async function cmdRun(flags: Map<string, string | boolean>, cwd: string): Promise<number> {
  await loadEnvFile(cwd);

  let cfg;
  try {
    cfg = await loadConfig(cwd);
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }

  if (cfg.providers.some((p) => p.apiStyle === "mock")) {
    registerMockResponder();
    log.dim("mock provider active — running fully offline");
  }

  const missing = missingApiKeys(cfg);
  if (missing.length > 0) {
    log.error(`Missing API keys: ${missing.join(", ")}`);
    log.dim("Add them to .env or your environment, or use apiStyle \"mock\" for an offline demo.");
    return 1;
  }

  log.banner(`ChalkCode — ${cfg.projectName}`);
  log.dim(`task: ${cfg.task.slice(0, 120)}${cfg.task.length > 120 ? "…" : ""}`);
  log.dim(`mode: ${cfg.mode} · roles: ${cfg.roles.map((r) => r.name).join(", ")} · concurrency: ${cfg.concurrency}`);

  const started = Date.now();
  const result = await orchestrate(cfg, {
    projectRoot: cwd,
    keepWorktrees: flags.has("keep-worktrees"),
    onEvent: (msg) => log.step(msg),
  });

  log.section("Run summary");
  for (const r of result.roles) {
    if (r.error) {
      log.error(`${fmt.bold(r.role.name)} (${r.model}) — failed: ${r.error}`);
    } else {
      log.ok(
        `${fmt.bold(r.role.name)} (${r.model}) — ${r.filesChanged.length} files, ${(r.usage.inputTokens + r.usage.outputTokens).toLocaleString()} tokens`,
      );
    }
  }
  if (result.integrator) {
    const i = result.integrator;
    if (i.error) {
      log.error(`integrator (${i.model}) — failed: ${i.error}`);
    } else {
      log.ok(
        `integrator (${i.model}) — ${i.filesChanged.length} files touched${i.mergeConflictsResolved.length ? `, ${i.mergeConflictsResolved.length} conflicts resolved` : ""}`,
      );
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const tokens = (result.totalUsage.inputTokens + result.totalUsage.outputTokens).toLocaleString();
  const cost = result.totalCostUsd > 0 ? ` · ~$${result.totalCostUsd.toFixed(4)}` : "";
  log.dim(`total: ${tokens} tokens${cost} · ${secs}s`);
  log.info(`full report: ${result.reportPath}`);

  if (!result.success) {
    log.error("run did not complete successfully — see the report and .agents/status/ journals.");
    return 1;
  }
  log.ok(fmt.green("done — result committed to your repository."));
  return 0;
}

async function cmdReport(cwd: string): Promise<number> {
  const dir = path.join(cwd, ".agents");
  if (!(await pathExists(dir))) {
    log.error("no .agents directory — nothing has run yet.");
    return 1;
  }
  const files = (await fs.readdir(dir)).filter((f) => f.startsWith("report-") && f.endsWith(".md")).sort();
  const latest = files[files.length - 1];
  if (!latest) {
    log.error("no report found — run something first.");
    return 1;
  }
  console.log(await readTextFile(path.join(dir, latest)));
  return 0;
}

function printHelp(): void {
  console.log(`chalkcode — multi-model AI coding orchestrator

Usage:
  chalkcode init [--demo] [--mode single|multi] [--task "what to build"]
  chalkcode run [--keep-worktrees]
  chalkcode doctor
  chalkcode report
  chalkcode --help | --version

How it works:
  1. init writes agents.config.json (strategy: one model for everything,
     or different models per role) and .env.example for your API keys.
  2. run executes three phases:
     plan     — each role declares interface contracts on a shared
                markdown blackboard (.agents/) so agents never have to
                read each other's code
     build    — roles work in PARALLEL, each in its own git worktree
     integrate — one model merges everything, resolves conflicts, wires
                the parts together and you get a full markdown report.

Flags:
  --demo             offline mock provider — no API keys needed
  --keep-worktrees   keep agent worktrees+branches for debugging
  --no-color         disable ANSI colors
`);
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("no-color")) setColor(false);
  const cwd = process.cwd();

  // `--version` / `--help` arrive as flags, not commands (see parseArgs) —
  // handle them before the switch or they fall through to the help text.
  if (command === undefined && flags.has("version")) {
    console.log(await version());
    return 0;
  }
  if (command === undefined && flags.has("help")) {
    printHelp();
    return 0;
  }

  switch (command) {
    case "init":
      return cmdInit(flags, cwd);
    case "run":
      return cmdRun(flags, cwd);
    case "doctor":
      return cmdDoctor(cwd);
    case "report":
      return cmdReport(cwd);
    case "--version":
    case "version":
      console.log(await version());
      return 0;
    case undefined:
    case "--help":
    case "help":
      printHelp();
      return command === undefined ? 1 : 0;
    default:
      log.error(`unknown command "${command}"`);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
