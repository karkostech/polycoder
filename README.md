# ChalkCode

[![CI](https://github.com/karol-kosciolek/chalkcode/actions/workflows/ci.yml/badge.svg)](https://github.com/karol-kosciolek/chalkcode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org)
[![Zero runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-blue)](package.json)

**Multi-model AI coding orchestrator.** One task goes in — a team of AI agents builds it in parallel, each in its own git worktree, coordinating through a shared markdown blackboard instead of reading each other's code. An integrator model merges and wires everything. You get working code on your branch plus a full build report.

## Why ChalkCode

Coding agents today are soloists: one model, one context window, one long sequential session. Real projects are frontend **and** backend **and** database **and** glue — and no single model is best at all of it. ChalkCode fans the work out to parallel agents (each in an isolated `git worktree`), lets them coordinate through short contracts on a shared blackboard (`.agents/`) instead of burning tokens on reading each other's code, and finishes with an integrator pass plus a detailed report. Faster, cheaper, more reliable — and you always know exactly what happened.

## Install

**Prerequisites:** [Node.js ≥ 20](https://nodejs.org) and [git](https://git-scm.com). Zero runtime dependencies.

```sh
git clone https://github.com/karol-kosciolek/chalkcode.git
cd chalkcode
npm install
npm run build
npm link
```

> ⚠️ The last command is plain `npm link` — **no arguments**. (`npm link chalkcode` would try to fetch from the npm registry; ChalkCode is installed from source.)

> **Uninstall:** `npm unlink -g chalkcode`, then delete the clone.

## Use it — 3 steps

**1. Once — store your defaults (optional but recommended):**

```sh
chalkcode setup
```

Pick your default provider (OpenAI / Anthropic / Moonshot / custom), default model, paste your API key once. Saved to `~/.chalkcode/config.json` — every next project pre-fills from here.

**2. In your project folder — create the project:**

```sh
mkdir my-app && cd my-app
chalkcode init
```

The wizard asks: what to build → **1** one model for everything or **2** a different model per role (frontend / backend / database / integrator). Every question has a default, so Enter-Enter-Enter works; missing API keys are asked for right there and written to `.env` (gitignored).

**3. Build:**

```sh
chalkcode run
```

Agents work in parallel, the integrator wires everything, and the result lands as **one commit** on your branch (undo anytime with `git reset --hard HEAD~1`). See what happened:

```sh
chalkcode report
```

That's it. No config to hand-edit unless you want to.

## What the wizard creates

| File | Purpose |
|---|---|
| `agents.config.json` | strategy, providers, roles, scopes, budgets, task |
| `.env` | your API keys (gitignored) |
| `.env.example` | which keys are needed, for teammates |

Key config fields you can tweak later:

- `roles[].scope` — path prefixes a role may write; ops outside are automatically rejected
- `concurrency` — how many agents run at once (default 3)
- `budgets` — hard caps on tokens/cost (`maxTokensPerRole`, `maxTotalTokens`, `maxCostUsd`) that stop runaway bills
- `integrator` — the model that merges and wires everything

`chalkcode doctor` checks git, config and API keys anytime. Non-interactive shells (scripts, CI) can skip the wizard: `chalkcode init --mode multi --task "Build …"`.

## Safety rails

- Refuses to run on a dirty working tree — your uncommitted work can never be swept into a run
- Self-heals stale worktrees after crashed runs; old blackboards are archived, never leak into new prompts
- Models never touch the filesystem directly — every file op is validated (project-confined, scope-confined, traversal blocked)
- Budgets stop runaway spending; retry/backoff handles rate limits

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing API keys: …` | paste them into `.env`, run `chalkcode setup`, or export the env var |
| run fails mid-way | read `.agents/status/<role>.md` — each agent journals its own failure; rerun with `--keep-worktrees` to inspect branches |
| 429 / rate limit | automatic backoff is built in; if persistent, lower `concurrency` |
| undo a run | `git reset --hard HEAD~1` — the result is exactly one commit |

## Development

```sh
npm run build
npm test   # 34 unit/e2e tests, node:test, fully offline
```

## License

MIT
