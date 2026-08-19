//! Wire protocol shared between the saber engine and every frontend
//! (TUI, macOS App, headless `saber exec`).
//!
//! This crate is the single source of truth: JSON Schema artifacts for
//! Swift/TS code generation are derived from these types (M0-T2), and the
//! session JSONL event schema lives here as well.
//!
//! Transport contract (spec §2.2): one bidirectional JSON-RPC 2.0 connection
//! over a Unix domain socket. Events are JSON-RPC notifications carrying a
//! monotonic sequence number; framing is newline-delimited JSON — no SSE.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

/// Version of the saber engine<->frontend protocol (semver).
///
/// Frozen as `1.0.0` at M2; until then breaking changes stay within 0.x.
pub const PROTOCOL_VERSION: &str = "0.1.0";

#[cfg(test)]
mod tests {
    #[test]
    fn protocol_version_is_semver_like() {
        let parts: Vec<&str> = super::PROTOCOL_VERSION.split('.').collect();
        assert_eq!(parts.len(), 3, "protocol version must be semver");
        assert!(
            parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit())),
            "protocol version components must be numeric until 1.0.0 freeze"
        );
    }
}
