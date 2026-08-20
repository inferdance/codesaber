//! Minimal macOS Seatbelt sandbox (M0-T4b): the `workspace-write-lite`
//! profile wraps bash behind the [`BashExecutor`] seam so tool code never
//! changes when swapping confinement on.
//!
//! Profile shape (codex `.sbpl` lineage, simplified for M0):
//! - `(deny default)` baseline; **no network allow anywhere** (M0 is
//!   fully offline — LLM calls live in the engine process, outside).
//! - Reads: everything, except secret homes (`~/.ssh`, `~/.aws`,
//!   `~/.gnupg`, `~/.kube`) and workspace secret globs (`.env*`, `*.pem`,
//!   `id_rsa*`) — TCC does not protect us, so the policy does.
//! - Writes: canonicalized workspace + saber data dir + system temp roots
//!   + `/dev/null`.
//! - Process exec/fork, sysctl-read, mach-lookup, and self-signals stay
//!   available so real toolchains keep working.
//!
//! Denials are detected (stderr fingerprints) and surfaced as a
//! **structured note** so the model learns the boundary instead of
//! retrying blindly; the tool layer counts repeat fingerprints.

use futures::future::BoxFuture;
use saber_tools::bash::{
    BashEnv, BashExecutor, BashOutput, SANDBOX_DENIAL_MARKER, run_with_governance,
};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DENIAL_MARKER: &str = SANDBOX_DENIAL_MARKER;
const DEFAULT_TIMEOUT_MS: u64 = 120_000;

/// Configuration for one sandboxed execution context.
#[derive(Debug, Clone)]
pub struct SandboxConfig {
    /// Writable roots beyond the workspace and data dir (e.g. TMPDIR).
    pub extra_writable_roots: Vec<PathBuf>,
}

/// Builds the M0 `workspace-write-lite` profile.
pub fn build_profile(cwd: &Path, data_dir: &Path, home: &Path) -> Result<String, String> {
    let cwd = canonical_or_err(cwd)?;
    let data_dir = std::fs::create_dir_all(data_dir)
        .and_then(|_| data_dir.canonicalize())
        .map_err(|e| format!("data dir: {e}"))?;

    let session_tmp = data_dir.join("tmp");
    std::fs::create_dir_all(&session_tmp).map_err(|e| format!("session tmp dir: {e}"))?;
    let mut writable = vec![cwd.clone(), data_dir.clone()];
    writable.push(PathBuf::from("/dev/null"));

    let mut denies = Vec::new();
    for dir in [".ssh", ".aws", ".gnupg", ".kube"] {
        let secret = home.join(dir);
        if secret.exists() {
            if let Ok(canon) = secret.canonicalize() {
                denies.push(format!(
                    "(deny file-read* (subpath {}))",
                    sbpl_string(&canon)
                ));
            }
        }
        denies.push(format!(
            "(deny file-read* (subpath {}))",
            sbpl_string(&secret)
        ));
    }
    // Workspace secret globs: <cwd>/**.env*, <cwd>/**.pem, <cwd>/**id_rsa*
    for pattern in [r"[^/]*\.env[^/]*$", r"[^/]*\.pem$", r"[^/]*id_rsa[^/]*$"] {
        denies.push(format!(
            "(deny file-read* (regex #\"^{}/{}{}\"))",
            regex_escape(&cwd.display().to_string()),
            regex_escape_segments(),
            pattern
        ));
    }

    let allows: Vec<String> = writable
        .iter()
        .map(|root| format!("(allow file-write* (subpath {}))", sbpl_string(root)))
        .collect();

    Ok(format!(
        "(version 1)\n\
         (deny default)\n\
         (allow process*)\n\
         (allow sysctl-read)\n\
         (allow file-read*)\n\
         (allow file-map-executable)\n\
         (allow mach-lookup)\n\
         (allow signal (target self))\n\
         {}\n\
         {}\n",
        allows.join("\n"),
        denies.join("\n")
    ))
}

fn canonical_or_err(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|e| format!("workspace root {}: {e}", path.display()))
}

fn sbpl_string(path: &Path) -> String {
    let text = path.display().to_string();
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

fn regex_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '/' {
            out.push(ch);
        } else {
            out.push('\\');
            out.push(ch);
        }
    }
    out
}

fn regex_escape_segments() -> String {
    // any path segments before the file name
    "([^/]+/)*".to_owned()
}

/// Detects sandbox-denial fingerprints in command output.
fn looks_like_denial(output: &BashOutput) -> bool {
    let haystacks = [
        &output.stderr.head,
        &output.stderr.tail,
        &output.stdout.head,
    ];
    haystacks.iter().any(|text| {
        text.contains("Operation not permitted")
            || text.contains("Permission denied")
            || text.contains("Sandbox denial")
            // DNS/connect failures are how denied networking surfaces.
            || text.contains("Could not resolve host")
            || text.contains("Temporary failure in name resolution")
            || text.contains("Network is unreachable")
    })
}

/// Appends the structured denial note so the model can adapt.
fn annotate_denial(output: &mut BashOutput, cwd: &Path, data_dir: &Path) {
    let note = format!(
        "\n{DENIAL_MARKER} the sandbox blocked part of this command. \
         Writable paths: {} and {}; reads of secret files (~/.ssh, ~/.aws, \
         ~/.gnupg, ~/.kube, .env, *.pem, id_rsa) are denied; ALL network \
         access is disabled in this mode. Adjust the command to stay within \
         these boundaries instead of retrying the same approach.",
        cwd.display(),
        data_dir.display()
    );
    output.stderr.head.push_str(&note);
}

/// Seatbelt-wrapped bash executor (production wiring for M0+).
#[derive(Debug, Clone)]
pub struct SeatbeltExecutor {
    config: SandboxConfig,
}

impl SeatbeltExecutor {
    pub fn new(config: SandboxConfig) -> Self {
        Self { config }
    }
}

impl Default for SeatbeltExecutor {
    fn default() -> Self {
        Self::new(SandboxConfig {
            extra_writable_roots: Vec::new(),
        })
    }
}

impl BashExecutor for SeatbeltExecutor {
    fn execute(
        &self,
        env: &BashEnv,
        command: &str,
        timeout: Duration,
    ) -> BoxFuture<'static, Result<BashOutput, String>> {
        let env = env.clone();
        let command = command.to_owned();
        let extra_roots = self.config.extra_writable_roots.clone();
        Box::pin(async move {
            let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
            let mut profile = build_profile(&env.cwd, &env.data_dir, &home)?;
            for root in &extra_roots {
                if let Ok(canon) = root.canonicalize() {
                    profile.push_str(&format!(
                        "(allow file-write* (subpath {}))\n",
                        sbpl_string(&canon)
                    ));
                }
            }
            let argv = vec![
                "/usr/bin/sandbox-exec".to_owned(),
                "-p".to_owned(),
                profile,
                "--".to_owned(),
                "/bin/bash".to_owned(),
                "-c".to_owned(),
                command,
            ];
            let session_tmp = env.data_dir.join("tmp");
            std::fs::create_dir_all(&session_tmp).map_err(|e| format!("session tmp dir: {e}"))?;
            let env_overrides = vec![("TMPDIR".to_owned(), session_tmp.display().to_string())];
            let mut output =
                run_with_governance(&argv, &env, timeout, "bash", &env_overrides).await?;
            if looks_like_denial(&output) {
                annotate_denial(&mut output, &env.cwd, &env.data_dir);
            }
            Ok(output)
        })
    }
}

/// Core of the future `saber debug sandbox -- <cmd>` command (T6 wires the
/// CLI): runs a command under the profile and returns the raw output plus
/// whether a denial fired.
pub async fn debug_run(
    cwd: &Path,
    data_dir: &Path,
    command: &str,
) -> Result<(BashOutput, bool), String> {
    let env = BashEnv {
        cwd: cwd.to_owned(),
        data_dir: data_dir.to_owned(),
        session_id: "debug".to_owned(),
    };
    let executor = SeatbeltExecutor::default();
    let output = executor
        .execute(&env, command, Duration::from_millis(DEFAULT_TIMEOUT_MS))
        .await?;
    let denied = output.stderr.head.contains(DENIAL_MARKER);
    Ok((output, denied))
}
