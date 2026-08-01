# PolyCoder

[![CI](https://github.com/karkostech/polycoder/actions/workflows/ci.yml/badge.svg)](https://github.com/karkostech/polycoder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org)
[![Zero runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-blue)](package.json)

**Multi-model AI coding orchestrator.** One task goes in — a team of AI agents builds it in parallel, each in its own git worktree, coordinating through a shared markdown blackboard instead of reading each other's code. An integrator model merges and wires everything. You get working code on your branch plus a full build report.

```
task ──► ┌─────────────┐   plan     ┌──────────────────────────────┐
         │ orchestrator│ ─────────► │  .agents/ blackboard         │
         └──────┬──────┘            │  contracts + journals (.md)  │
                │                   └───────────▲──────────────────┘
                │ build (parallel worktrees)    │ read/write
       ┌────────┼────────┐                      │
       ▼        ▼        ▼                      │
   ┌───────┐┌───────┐┌───────┐                  │
   │front- ││back-  ││data-  │──────────────────┘
   │ end   ││ end   ││ base  │  (GPT-x)  (Claude)  (Kimi)
   └───┬───┘└───┬───┘└───┬───┘
       └───┬────┴────┬───┘
           ▼         ▼
        ┌──────────────────┐    ┌─────────────┐
        │ integrator model │ ─► │ run report  │
        │ merge + wire up  │    │ .agents/…   │
        └──────────────────┘    └─────────────┘
```

## Why PolyCoder exists

Coding agents today are soloists: one model, one context window, one long sequential session. Real projects aren't like that — they're frontend **and** backend **and** database **and** glue, and no single model is best at all of it. Running several agents naively makes things worse: they trip over each other's files, burn tokens reading each other's code, and nobody puts the pieces together at the end.

PolyCoder was built around four observations:

- **Different models are good at different things.** One model might write the cleanest UI, another the most careful backend logic, a third the tightest SQL. PolyCoder lets you assign each domain to its strongest model — or run everything on one model, still fanned out into parallel agents.
- **Agents shouldn't read each other's code.** Reading another agent's half-finished code is how you get wrong assumptions and a melting context window. Instead, every agent publishes a short journal and precise **interface contracts** to a shared markdown blackboard (`.agents/`). Agents coordinate through documents, not through code archaeology — massively fewer tokens, far less confusion.
- **Parallel work needs isolation.** Each agent gets its own `git worktree` and branch. Nobody blocks anybody, nothing is half-overwritten, and merging happens exactly once — at the end, under control of the integrator.
- **You should know what happened.** "The AI did stuff" is not an acceptable outcome. Every run ends with a detailed markdown report: which agent did what, which files changed, how many tokens were spent, what it cost, and what the integrator fixed.

The goal: a build that is **faster** (parallel instead of sequential), **cheaper** (blackboard instead of cross-reading), and **more reliable** (contracts + integration pass + report) than one long agent session — with a UI you can actually follow.

## Install

**Prerequisites:** [Node.js ≥ 20](https://nodejs.org) and [git](https://git-scm.com). PolyCoder has **zero runtime dependencies** — nothing else to install.

```sh
git clone https://github.com/karkostech/polycoder.git
cd polycoder
npm install
npm run build
npm link
```

The last command, `npm link`, puts the `polycoder` command on your PATH. Type it **exactly as shown — with no arguments**:

> ⚠️ **Do not run `npm link polycoder` or `npm install -g polycoder`.** The name `polycoder` on the npm registry belongs to a different, unrelated package — installing it will fail (and it is not this project). PolyCoder is installed **from source** (this repo), not from npm.

Verify the installation:

```sh
polycoder --version
polycoder --help
```

> **Windows note:** works in PowerShell, CMD and Git Bash. **Don't want `npm link`?** Run it as `node dist/src/cli.js <command>` from the repo directory instead.
>
> **Uninstall:** `npm unlink -g polycoder` (or `npm rm -g polycoder`), then delete the clone.

## Quick start (offline demo, no API keys)

Try the full pipeline without spending a cent — the deterministic mock provider runs the *entire real flow* (plan → parallel build → merge → integrate → report):

```sh
mkdir my-app && cd my-app
polycoder init --demo
polycoder run
```

You get a working todo app — boot it with `npm start` and open http://localhost:3000. Then inspect `.agents/` to see the contracts, journals and the run report.

## Usage

### 1. Initialize a project

```sh
polycoder init                    # template config, "multi" strategy
polycoder init --mode single      # template config, one model for everything
polycoder init --demo             # offline mock config (no keys needed)
polycoder init --task "Build …"   # pre-fill the task
```

This creates:

| File | Purpose |
|---|---|
| `agents.config.json` | strategy, providers, roles, scopes, budgets, task |
| `.env.example` | which API keys to provide — copy to `.env` and fill in |

### 2. Add API keys

```sh
cp .env.example .env
# edit .env: OPENAI_API_KEY=…  ANTHROPIC_API_KEY=…  MOONSHOT_API_KEY=…
```

Keys live only in `.env` / your environment — never in the config file, never committed (`.env` is gitignored).

### 3. Choose strategy, models and roles in `agents.config.json`

**Strategy 1 — one model for everything** (still parallel: one agent per role, same API):

```json
{
  "mode": "single",
  "defaultModel": "gpt-5",
  "defaultProvider": "openai",
  "roles": [
    { "name": "frontend", "description": "Owns the UI under web/", "scope": ["web/"] },
    { "name": "backend",  "description": "Owns the API under server/", "scope": ["server/"] }
  ]
}
```

**Strategy 2 — different model per role:**

```json
{
  "mode": "multi",
  "roles": [
    { "name": "frontend", "scope": ["web/"],    "description": "…", "model": "gpt-5",            "provider": "openai" },
    { "name": "backend",  "scope": ["server/"], "description": "…", "model": "claude-sonnet-4-5","provider": "anthropic" },
    { "name": "database", "scope": ["db/"],     "description": "…", "model": "kimi-k2",          "provider": "moonshot" }
  ],
  "integrator": { "model": "gpt-5", "provider": "openai" }
}
```

Key config fields:

- `providers[]` — any **OpenAI-compatible** API (`apiStyle: "openai"` + `baseUrl`), **Anthropic** (`apiStyle: "anthropic"`), or the offline `mock`. `apiKeyEnv` names the env var with the key.
- `roles[].scope` — path prefixes the role may write; ops outside the scope are automatically rejected.
- `concurrency` — how many agents run at once (default 3).
- `budgets` — hard caps that stop runaway spending (see below).
- `integrator` — the model that merges and wires everything (defaults sensibly).

### 4. Validate, run, inspect

```sh
polycoder doctor      # checks git, config, API keys — fix what it flags
polycoder run         # plan → parallel build → integrate → land on your branch
polycoder report      # print the latest run report
```

`run` flags:

- `--keep-worktrees` — keep agent worktrees + branches for debugging (they're cleaned up by default)
- `--no-color` — plain output (CI-friendly)

### Budgets — no runaway bills

```json
"budgets": {
  "maxTokensPerRole": 400000,
  "maxTotalTokens": 2000000,
  "maxCostUsd": 5,
  "pricing": { "gpt-5": { "input": 1.25, "output": 10 } }
}
```

Crossing any cap stops the affected agent cleanly and is recorded in the report.

## What lands in your repo

| Path | What |
|---|---|
| your code | merged result, committed to your branch |
| `.agents/contracts/*.md` | interface contracts the agents agreed on |
| `.agents/status/<role>.md` | per-agent journals (plan → done/failed) |
| `.agents/report-<run>.md` | the full run report |
| `agent/*`, `integration/*` branches | deleted after a successful run (`--keep-worktrees` to keep) |

## How agents talk to the orchestrator

Models never touch the filesystem directly. They return one JSON object:

```json
{
  "summary": "what was done",
  "ops": [
    { "type": "write",    "path": "web/app.js", "content": "…" },
    { "type": "delete",   "path": "old.js" },
    { "type": "note",     "text": "for the other agents" },
    { "type": "contract", "name": "api", "content": "…" }
  ]
}
```

PolyCoder validates every op (paths are confined to the project and to the role's `scope`, traversal is blocked), applies them to the role's worktree, and publishes notes/contracts to the blackboard.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing API keys: …` | add them to `.env` or the environment, or use `apiStyle: "mock"` |
| `git … failed` in `doctor` | install git / make sure it's on `PATH` |
| run fails mid-way | read `.agents/status/<role>.md` — each agent journals its own failure; then rerun with `--keep-worktrees` to inspect branches |
| 429 / rate limit from a provider | automatic backoff retries are built in; if persistent, lower `concurrency` |
| want to undo a run | the result is one commit on your branch: `git reset --hard HEAD~1` (worktrees/branches of the run are isolated) |

## Development

```sh
npm run build
npm test
npm run cli -- --help
```

`npm run build` compiles TypeScript to `dist/`; `npm test` builds and runs the 27 unit/e2e tests (node:test, fully offline).

## License

MIT
