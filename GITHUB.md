# GitHub publication checklist

Metadata to paste into the repo settings once `chalkcode` is pushed to GitHub.

## Suggested repo name
`chalkcode`

## Description (GitHub "About")
> Multi-model AI coding orchestrator — parallel CLI agents in git worktrees, a shared markdown blackboard instead of cross-reading code, an integrator pass, and a full build report. Zero runtime deps. MIT.

## Topics
```
ai-agents, llm, multi-agent, code-generation, cli, orchestrator,
git-worktree, openai, anthropic, claude, gpt, kimi, developer-tools,
typescript, nodejs, ai-coding, agentic-workflow
```

## Included in this repo
- [x] MIT `LICENSE`
- [x] `README.md` with badges, 3-step quick start, config reference
- [x] CI on GitHub Actions: `.github/workflows/ci.yml` — build + 34 tests + offline CLI smoke test, matrix Node 20/22/24 × ubuntu/windows/macos
- [x] `.gitignore` (node_modules, dist, .env, .agents)
- [x] `package.json` with keywords, license, engines, bin

## Recommended next settings
- Protect `main`: require the CI check to pass before merging.
- Add a screenshot of `chalkcode run` output as the social preview image.
- [x] First release: `v0.1.0` published (2026-08-02). Next: `v0.2.0` — interactive setup wizard.
