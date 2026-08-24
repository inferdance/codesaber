# CodeSaber Agent Instructions

## Project Overview

CodeSaber is a TypeScript coding agent built from scratch (0→1), ESM-only on
Node, distributed via npm. Positioned as a same-engine multi-frontend agent:
one core, three frontends (web / TUI / headless CLI).

## Architecture

- `packages/core` — agent loop (turn/step engine), tools (bash/read/write/edit/
  grep/glob), path policy, session WAL, unified event model (`events.ts` is the
  single vocabulary for engine events, session payloads, and the wire)
- `packages/ai` — LLM providers (OpenAI-compatible + Anthropic), SSE parser,
  retry, cost estimates
- `packages/server` — Fastify + WebSocket (web UI serves from here) — M1
- `packages/cli` — `saber` binary (headless exec, doctor)
- `packages/sandbox` — macOS Seatbelt confinement — M2 (skeleton only)

## Engineering Standards

- **TypeScript strict mode** — no `any` unless explicitly justified; no
  non-null `!` assertions when a type guard or discriminated union fits
- **Zod schemas for all tool parameters** — runtime validation, bad
  parameters are rejected (never silently coerced to null). Tool parameter
  JSON Schema is derived from the Zod schema (`tools/schema.ts`), never
  hand-written twice
- **Dependency injection via constructor/options** — plain classes; Effect
  Layer was evaluated and dropped (see plan amendments). Test seams come from
  passing fakes (e.g. `createMockProvider`)
- **Path safety**: use `path.relative` for boundary checks (NOT `startsWith`)
- **ESM only**: `.js` import specifiers, no `require()`
- **Vitest** for testing — all tests in `src/__tests__/`; tests are
  typechecked (`tsconfig.tests.json` runs in `pnpm lint`)
- **pnpm** for workspace management

## Key Invariants

1. **WAL**: Tool side effects preceded by durable `tool_call` intent (fsync).
   A failed intent write blocks execution.
2. **Path policy**: All file access through unified policy (read deny
   secrets, write allowlist workspace+data-dir). Search tools enforce it
   per-file, before reading. Use `path.relative`.
3. **Errors in streams**: Provider errors become terminal stream events.
4. **Session = JSONL**: Append-only event log; the payload vocabulary is the
   discriminated union in `core/src/events.ts` (engine, log, and wire share
   it). Recovery identifies intent-without-result as unfinished and degrades
   on mid-file corruption instead of throwing.

## Testing

Run all tests: `pnpm test`
Typecheck (incl. tests): `pnpm lint`
Build: `pnpm build`

## Commit Style

`type(scope): description` — e.g., `feat(t4): path policy with relative check`
