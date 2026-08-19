//! Sandbox layer (M0-T4b): macOS Seatbelt enforcement for tool subprocesses.
//!
//! M0 profile `workspace-write-lite` (spec §3.4):
//! - `(deny default)` baseline; allow process-exec/fork, sysctl-read
//!   (incl. `hw.optional.arm.*`), PTY, cfprefs.
//! - Writable roots: canonicalized cwd + `~/.codesaber/` (note
//!   `/var` -> `/private/var` canonicalization; exclusions use
//!   `require-not (literal)` + `(subpath)` pairs).
//! - Read-side denies: `~/.ssh` subpath and `**/.env` globs — TCC does not
//!   protect us because subprocesses inherit the terminal's grants.
//! - No network allows at all in M0: LLM calls happen in the engine
//!   process, outside the sandbox.
//! - Child env allowlist: PATH, HOME, LANG, TMPDIR only.
//!
//! The engine itself is NOT sandboxed (it must reach LLM APIs); write/edit
//! are bounded by the engine-level path policy in saber-tools instead.

/// Env vars passed through to sandboxed subprocesses (everything else is
/// stripped, including engine-held API keys).
pub const CHILD_ENV_ALLOWLIST: [&str; 4] = ["PATH", "HOME", "LANG", "TMPDIR"];

#[cfg(test)]
mod tests {
    #[test]
    fn child_env_allowlist_never_contains_secrets() {
        let allowlist = super::CHILD_ENV_ALLOWLIST;
        assert!(!allowlist.iter().any(|v| v.starts_with("SABER_")));
        assert_eq!(allowlist.len(), 4);
    }
}
