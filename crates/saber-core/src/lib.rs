//! Engine core (M0-T5): session management, the turn/step agent loop,
//! context management, and system prompt assembly.
//!
//! Session persistence follows event sourcing with WAL semantics
//! (spec §4.5): before a tool side effect runs, a `tool_call` intent is
//! durably appended to the session JSONL; the `tool_result` is appended
//! after the side effect completes. Recovery treats "intent without
//! result" as an unfinished call instead of replaying it.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

/// Engine build identity exposed to frontends for version handshakes.
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    #[test]
    fn engine_version_is_semver_like() {
        let parts: Vec<&str> = super::ENGINE_VERSION.split('.').collect();
        assert_eq!(parts.len(), 3);
    }
}
