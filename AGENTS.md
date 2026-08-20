# CodeSaber Agent Instructions

## Project Overview

CodeSaber is a Rust coding agent (single binary `saber`) with a macOS-native
App frontend (planned). The engine is minimal-by-design (pi-style): the
harness stays small and product opinions live in replaceable upper layers.

## Architecture

- `crates/saber-protocol` — Wire protocol types (single source of truth for
  Rust/Swift/TS via JSON Schema artifacts)
- `crates/saber-provider` — Model access (OpenAI-compatible + Anthropic
  adapters, self-built SSE parser, retry, failover)
- `crates/saber-tools` — Tool contracts, unified path policy, registry,
  scheduler, six built-in tools (bash/read/write/edit/grep/glob)
- `crates/saber-sandbox` — macOS Seatbelt confinement (workspace-write-lite
  profile, secret reads denied, all network denied)
- `crates/saber-core` — Session manager (event-sourced JSONL with WAL
  semantics), turn/step agent loop, prompt assembly
- `crates/saber-cli` — The `saber` binary (headless exec, debug sandbox,
  doctor)

## Engineering Standards

- **unsafe_code = deny** across the workspace
- **clippy all/unwrap_used/expect_used = deny** — use `?`, `if let`, or
  early returns
- **cargo-shear** enforces that every declared dependency is used
- **cargo-deny** gates licenses (Apache-2.0 compatible) and advisories
- **insta** snapshot tests lock protocol schemas
- **nightly CI** catches new advisories

## Key Invariants

1. **WAL**: Tool side effects are preceded by a durable `tool_call` intent
   in the session log. A failed intent write blocks execution.
2. **Path policy**: All file access goes through the unified path policy
   (read deny secrets, write allowlist workspace+data-dir). No tool may
   bypass it.
3. **Errors in streams**: Provider errors are encoded as terminal stream
   events — nothing across the provider boundary panics.
4. **Session = JSONL**: Append-only event log is the single source of
   truth. Recovery identifies intent-without-result as unfinished.

## Testing

Run all tests: `cargo test --workspace`
Run macOS sandbox tests: `cargo test -p saber-sandbox`
Format: `cargo fmt --all --check`
Lint: `cargo clippy --workspace --all-targets -- -D warnings`

## Commit Style

`type(scope): description` — e.g., `feat(t4): saber-tools six-tool set`,
`fix(t5): WAL intent write failure blocks execution`
