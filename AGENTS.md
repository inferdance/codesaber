# CodeSaber Agent Instructions

## Project Overview

CodeSaber is a TypeScript coding agent with a web-first frontend (zcode
model). Built on Effect-TS with Bun/Node, distributed via npm.

## Architecture

- `packages/core` — Effect Layer runtime, Zod schemas, path policy, edit
  engine, session WAL, agent loop
- `packages/ai` — LLM providers (OpenAI-compatible + Anthropic), SSE parser
- `packages/server` — Fastify + WebSocket (web UI serves from here)
- `packages/cli` — `saber` binary (headless exec, doctor)
- `packages/sandbox` — macOS Seatbelt confinement

## Engineering Standards

- **TypeScript strict mode** — no `any` unless explicitly justified
- **Zod schemas for all tool parameters** — runtime validation, bad
  parameters are rejected (never silently coerced to null)
- **Effect Layer for dependency injection** — test with `Layer.succeed`
- **Path safety**: use `path.relative` for boundary checks (NOT `startsWith`)
- **ESM only**: `.js` import specifiers, no `require()`
- **Vitest** for testing — all tests in `src/__tests__/`
- **pnpm** for workspace management

## Key Invariants

1. **WAL**: Tool side effects preceded by durable `tool_call` intent (fsync).
   A failed intent write blocks execution.
2. **Path policy**: All file access through unified policy (read deny
   secrets, write allowlist workspace+data-dir). Use `path.relative`.
3. **Errors in streams**: Provider errors become terminal stream events.
4. **Session = JSONL**: Append-only event log, recovery identifies
   intent-without-result as unfinished.

## Testing

Run all tests: `pnpm test`
Format: `pnpm lint`
Build: `pnpm build`

## Commit Style

`type(scope): description` — e.g., `feat(t4): path policy with relative check`
