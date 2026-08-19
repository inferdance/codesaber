//! Tool system (M0-T4): tool contracts, registry, scheduler, and the six
//! built-in tools (bash / read / write / edit / grep / glob).
//!
//! Contract highlights (spec §3.2):
//! - `ToolDefinition` declares `concurrency_safe`, `timeout_ms`,
//!   `permission_rule`, and optional TUI `render` alongside the executable.
//! - The scheduler parallelizes read-class tools and serializes writers via
//!   resource conflict detection.
//! - Output governance is three-layer: head/tail truncation, full output
//!   spilled to `~/.codesaber/truncations/` for read-back, prompt-side
//!   guidance.
//! - File writes (write/edit) are enforced by the engine-level write-path
//!   policy: canonicalized targets must stay under cwd or the saber data
//!   directory.

/// Number of built-in tools planned for M0.
pub const M0_TOOL_COUNT: usize = 6;

#[cfg(test)]
mod tests {
    #[test]
    fn m0_has_six_builtin_tools() {
        assert_eq!(super::M0_TOOL_COUNT, 6);
    }
}
