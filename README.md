<div align="center">

# ⚔️ CodeSaber

**Cut through code.**

A coding agent built from scratch — 0 to 1, exploring the ceiling of what an agent harness can do.

从 0 到 1 搭建 coding agent,探索上限。

</div>

---

## Status

**M0 (core) — in progress.** The engine loop, tools, and safety rails are landing now.

| Milestone | Scope | State |
|---|---|---|
| M0 | core: engine loop, tools (bash/read/write/edit/grep/glob), path policy, WAL session, providers | 🚧 active |
| M1 | same engine, three frontends: web (Fastify+WS+React), TUI (ink), headless CLI | planned |
| M2 | frontier: auto-compact, subagents, code mode | exploring |

Design docs live in [`docs/superpowers/`](docs/superpowers/); deep research on codex/dsh/pi/kimi/opencode in [`docs/research/`](docs/research/).

## Quick start (dev)

```bash
git clone https://github.com/inferdance/codesaber.git
cd codesaber
pnpm install

export ANTHROPIC_API_KEY=...      # or OPENAI_API_KEY
pnpm saber exec -p "read README.md and summarize it"
pnpm test                         # vitest across packages
pnpm saber doctor                 # health check
```

Works with any Anthropic/OpenAI-compatible endpoint via `SABER_BASE_URL`
(e.g. GLM's anthropic-compatible API, DeepSeek's openai-compatible API):

```bash
export SABER_BASE_URL=https://open.bigmodel.cn/api/anthropic
export SABER_ANTHROPIC_KEY=...
pnpm saber exec -p "..." --model glm-5.3
```

## Architecture

TypeScript native, ESM-only, pnpm workspace:

- `packages/core` — engine loop (turn/step state machine), tools with Zod-validated
  params, path policy (`path.relative` boundary checks, secret deny list),
  event-sourced sessions (append-only JSONL, fsync'd tool intents)
- `packages/ai` — LLM providers (OpenAI-compatible, Anthropic), hand-written SSE
  parser, retry with backoff; provider errors become terminal stream events
- `packages/cli` — `saber exec` headless runner, `saber doctor`
- `packages/server` / `packages/web` / `packages/tui` — M1: one engine, three frontends

Key invariants (tested):

1. **WAL** — every tool side effect is preceded by a durable `tool_call` intent
   (fsync). A failed intent write blocks execution.
2. **Path safety** — all file access goes through one policy: reads deny secrets,
   writes confined to workspace + data dir, boundaries checked with `path.relative`.
3. **Errors are events** — provider failures surface as terminal stream events,
   never thrown past the loop.
4. **Session = JSONL** — recovery identifies intent-without-result as unfinished.

## License

Apache License 2.0
