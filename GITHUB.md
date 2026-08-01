# GitHub publication checklist

Metadata to paste into the repo settings once `polycoder` is pushed to GitHub.

## Suggested repo name
`polycoder`

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
- [x] `README.md` with badges, quick start, architecture diagram
- [x] CI on GitHub Actions: `.github/workflows/ci.yml` — build + 27 tests + offline CLI smoke test, matrix Node 20/22/24 × ubuntu/windows/macos
- [x] `.gitignore` (node_modules, dist, .env, .agents)
- [x] `package.json` with keywords, license, engines, bin

## Recommended next settings
- Protect `main`: require the CI check to pass before merging.
- Add a screenshot of `polycoder run` output as the social preview image.
- First release: tag `v0.1.0`, attach the demo report as release notes material.
