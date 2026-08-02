#!/usr/bin/env node
/**
 * ChalkCode CLI — multi-model AI coding orchestrator.
 *
 *   chalkcode setup      once: pick model(s) from the list + paste API keys (global)
 *   chalkcode init       interactive wizard → agents.config.json + .env
 *   chalkcode run        plan → parallel build → integrate → report
 *   chalkcode doctor     check git / config / API keys
 *   chalkcode report     print the latest run report
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import {
  CONFIG_FILE,
  ConfigError,
  loadConfig,
  loadEnvFile,
  missingApiKeys,
} from "./config.js";
import { fmt, log, setColor } from "./logger.js";
import { MODELS } from "./models.js";
import { registerMockResponder } from "./mock.js";
import { orchestrate } from "./orchestrator.js";
import { isGitInstalled, isInsideRepo } from "./git.js";
import { pathExists, readTextFile, writeJsonFile, writeTextFile } from "./fsutil.js";
import { ProjectConfig } from "./types.js";
import { buildMockConfig, buildTemplateConfig, runInitWizard, pickModel, AskFn, WizardResult } from "./wizard.js";
import { applyUserKeysToEnv, loadUserConfig, maskKey, saveUserConfig, userConfigPath } from "./userconfig.js";

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

const ENV_EXAMPLE = `# ChalkCode API keys — one per model family you use.
# This file is gitignored. Never commit real keys.
# Tip: "chalkcode setup" stores keys globally so you paste them only once.
OPENAI_API_KEY=        # GPT
ANTHROPIC_API_KEY=     # Claude
GEMINI_API_KEY=        # Gemini
XAI_API_KEY=           # Grok
MOONSHOT_API_KEY=      # Kimi
DEEPSEEK_API_KEY=      # DeepSeek
DASHSCOPE_API_KEY=     # Qwen
GLM_API_KEY=           # GLM
`;

/** "Claude · claude-sonnet-5" for summary panels; falls back to the raw model id. */
function modelLabel(providerName: string, model: string): string {
  const fam = MODELS.find((m) => m.id === providerName);
  return fam ? `${fmt.bold(fam.label)} ${fmt.gray(`· ${model}`)}` : model;
}

/** Interactive question helper (readline). Returns a fn compatible with AskFn. */
function makeAsk(): { ask: AskFn; close: () => void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return { ask: (q) => rl.question(q), close: () => rl.close() };
}

/** Merge keys into the project .env without duplicating or clobbering. */
async function writeEnvFile(cwd: string, keys: Record<string, string>): Promise<void> {
  const envPath = path.join(cwd, ".env");
  const existing = (await pathExists(envPath)) ? await readTextFile(envPath) : "";
  const lines = Object.entries(keys)
    .filter(([k]) => !new RegExp(`^${k}=`, "m").test(existing))
    .map(([k, v]) => `${k}=${v}`);
  if (lines.length === 0) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  await fs.appendFile(envPath, `${existing ? prefix : ""}${lines.join("\n")}\n`, "utf8");
}

async function writeGitignore(cwd: string): Promise<void> {
  const gitignore = path.join(cwd, ".gitignore");
  const ignoreLines = [".agents/worktrees/", ".env"];
  if (await pathExists(gitignore)) {
    const existing = await readTextFile(gitignore);
    const toAdd = ignoreLines.filter((l) => !existing.includes(l));
    if (toAdd.length > 0) await fs.appendFile(gitignore, "\n" + toAdd.join("\n") + "\n", "utf8");
  } else {
    await writeTextFile(gitignore, ignoreLines.join("\n") + "\n");
  }
}

/** Persist a finished wizard/template result: config + .env + .env.example + .gitignore. */
async function writeProjectFiles(cwd: string, cfg: ProjectConfig, keys: Record<string, string>): Promise<void> {
  await writeJsonFile(path.join(cwd, CONFIG_FILE), cfg);
  await writeEnvFile(cwd, keys);
  await writeTextFile(path.join(cwd, ".env.example"), ENV_EXAMPLE);
  await writeGitignore(cwd);
}

async function cmdInit(flags: Map<string, string | boolean>, cwd: string): Promise<number> {
  const target = path.join(cwd, CONFIG_FILE);
  if (await pathExists(target)) {
    log.error(`${CONFIG_FILE} already exists — delete it first if you want to re-init.`);
    return 1;
  }

  const task = typeof flags.get("task") === "string" ? (flags.get("task") as string) : undefined;
  const projectName = path.basename(cwd);

  // Hidden, CI/tests-only: `init --mock` (legacy alias: `--demo`). Not in --help.
  if (flags.has("mock") || flags.has("demo")) {
    await writeProjectFiles(cwd, buildMockConfig(projectName, task), {});
    log.ok(`Created ${CONFIG_FILE} (mock provider — internal test/CI path).`);
    return 0;
  }

  // Non-interactive: flags given or no TTY → template config, user edits keys after.
  const modeFlag = flags.get("mode");
  if (modeFlag || task || !process.stdin.isTTY) {
    const mode = modeFlag === "single" ? "single" : "multi";
    await writeProjectFiles(cwd, buildTemplateConfig(mode, projectName, task), {});
    log.ok(`Created ${CONFIG_FILE} (${mode} mode) and .env.example.`);
    log.dim("Next: put your API keys in .env (or run " + fmt.bold("chalkcode setup") + "), then " + fmt.bold("chalkcode run"));
    return 0;
  }

  // Interactive wizard — the default path.
  const { ask, close } = makeAsk();
  try {
    const userCfg = await loadUserConfig();
    log.section("New ChalkCode project");
    const result = await runInitWizard({ ask, print: (m) => console.log(m), userCfg, projectName });
    await writeProjectFiles(cwd, result.cfg, result.env);
    printProjectReady(result);
    if (Object.keys(result.reused).length === 0 && Object.keys(result.env).length > 0) {
      log.dim(`tip: run ${fmt.bold("chalkcode setup")} once to store keys globally for every project`);
    }
    return 0;
  } finally {
    close();
  }
}

/** The "Project ready" summary panel shown after a wizard run. */
function printProjectReady(result: WizardResult, footer = "next: chalkcode run"): void {
  const cfg = result.cfg;
  const rows: Array<[string, string]> = [
    ["mode", cfg.mode === "single" ? "one model for everything" : "one model per role"],
  ];
  if (cfg.mode === "single") {
    rows.push(["model", modelLabel(cfg.defaultProvider ?? "", cfg.defaultModel ?? "")]);
  } else {
    for (const r of cfg.roles) {
      rows.push([r.name, modelLabel(r.provider ?? cfg.defaultProvider ?? "", r.model ?? cfg.defaultModel ?? "")]);
    }
    if (cfg.integrator.model) {
      rows.push(["integrator", modelLabel(cfg.integrator.provider ?? "", cfg.integrator.model)]);
    }
  }
  const pasted = Object.keys(result.env).length;
  const reusedN = Object.keys(result.reused).length;
  const keyBits: string[] = [];
  if (pasted > 0) keyBits.push(`${pasted} pasted → .env (gitignored)`);
  if (reusedN > 0) keyBits.push(`${reusedN} reused from env/global setup`);
  rows.push(["keys", keyBits.join(" · ") || "none"]);
  rows.push(["files", `${CONFIG_FILE} · .env.example${pasted ? " · .env" : ""}`]);
  log.panel("Project ready", rows, footer);
}

async function cmdSetup(): Promise<number> {
  if (!process.stdin.isTTY) {
    log.error("setup is interactive — run it in a terminal.");
    return 1;
  }
  const { ask, close } = makeAsk();
  try {
    const userCfg = await loadUserConfig();
    log.section("ChalkCode setup");
    log.dim(`Stored in ${userConfigPath()} — every project reuses these keys, so you paste each key only once.`);

    for (;;) {
      const fam = await pickModel(
        { ask, print: (m) => console.log(m) },
        "Pick a model:",
        userCfg.defaultProvider ?? "openai",
      );

      const envVar = fam.apiKeyEnv;
      let apiKey = userCfg.providers[fam.id]?.apiKey ?? "";
      if (process.env[envVar]) {
        log.dim(`  ${envVar} found in your environment (${maskKey(process.env[envVar]!)}) — using it`);
        apiKey = process.env[envVar]!;
      } else {
        const k = (await ask(`${fmt.cyan("›")} paste ${envVar}${apiKey ? ` [keep ${maskKey(apiKey)}]` : ""}: `)).trim();
        if (k) apiKey = k;
        if (!apiKey) {
          log.error("no API key given — nothing saved.");
          return 1;
        }
      }

      userCfg.providers[fam.id] = { apiKeyEnv: envVar, apiKey, model: fam.model };
      userCfg.defaultProvider = fam.id;
      userCfg.defaultModel = fam.model;
      await saveUserConfig(userCfg);
      log.ok(`Saved — ${fmt.bold(fam.label)} (${fam.model}) is now your default and its key works in every project.`);

      const more = (await ask(`${fmt.cyan("›")} store a key for another model too? [y/N]: `)).trim().toLowerCase();
      if (more !== "y" && more !== "yes") break;
    }
    log.dim(`Done. In any project folder: ${fmt.bold("chalkcode run")} — that's it.`);
    return 0;
  } finally {
    close();
  }
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

  const userCfg = await loadUserConfig();
  if (Object.keys(userCfg.providers).length > 0) {
    log.ok(`global setup found (${userConfigPath()}) — default: ${userCfg.defaultProvider}/${userCfg.defaultModel}`);
  } else {
    log.dim("no global setup yet (optional): run chalkcode setup to store defaults + keys once");
  }

  if (!(await pathExists(path.join(cwd, CONFIG_FILE)))) {
    log.error(`no ${CONFIG_FILE} found — run "chalkcode init".`);
    return 1;
  }

  let cfg;
  try {
    await loadEnvFile(cwd);
    applyUserKeysToEnv(userCfg);
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
  applyUserKeysToEnv(await loadUserConfig());

  let cfg;
  try {
    cfg = await loadConfig(cwd);
  } catch (err) {
    // Plug & play: no config in an interactive terminal → run the wizard inline.
    if (err instanceof ConfigError && !(await pathExists(path.join(cwd, CONFIG_FILE))) && process.stdin.isTTY) {
      log.dim(`no ${CONFIG_FILE} here — let's create one.`);
      const { ask, close } = makeAsk();
      try {
        const result = await runInitWizard({
          ask,
          print: (m) => console.log(m),
          userCfg: await loadUserConfig(),
          projectName: path.basename(cwd),
        });
        await writeProjectFiles(cwd, result.cfg, result.env);
        printProjectReady(result, "starting the run…");
        for (const [k, v] of Object.entries(result.env)) process.env[k] ??= v;
        cfg = result.cfg;
      } finally {
        close();
      }
    } else {
      log.error((err as Error).message);
      return 1;
    }
  }

  if (cfg.providers.some((p) => p.apiStyle === "mock")) {
    registerMockResponder();
    log.dim("mock provider active — running fully offline");
  }

  const missing = missingApiKeys(cfg);
  if (missing.length > 0) {
    log.error(`Missing API keys: ${missing.join(", ")}`);
    log.dim("Add them to .env, run chalkcode setup, or export them in your environment.");
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

Get started (2 steps):
  chalkcode setup     once: pick a model from the list + paste its API key
                      GPT · Claude · Gemini · Grok · Kimi · DeepSeek · Qwen · GLM
  chalkcode run       in your project folder — answer 2 questions, agents build

More:
  chalkcode init      re-configure the current project (same simple questions)
  chalkcode doctor    check git / config / API keys
  chalkcode report    print the latest run report
  chalkcode --version

Flags:
  --task "…"          pre-fill the task (non-interactive init)
  --mode single|multi non-interactive init with template defaults
  --keep-worktrees    keep agent worktrees+branches for debugging
  --no-color          disable ANSI colors
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
    case "setup":
      return cmdSetup();
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
