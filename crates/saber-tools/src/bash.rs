//! `bash`: command execution behind an executor seam. M0 ships
//! [`DirectExecutor`] (env allowlist + process-group kill); T4b's Seatbelt
//! executor plugs into the same trait without touching tool code.

use crate::ToolContext;
use crate::truncation::{TruncationConfig, spill_full_output, truncate_output};
use futures::future::BoxFuture;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Duration;

pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
/// Env vars passed to subprocesses; engine-held secrets never ride along.
pub const CHILD_ENV_ALLOWLIST: [&str; 4] = ["PATH", "HOME", "LANG", "TMPDIR"];

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct BashParams {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// Execution seam: T4b implements this with Seatbelt confinement.
pub trait BashExecutor: Send + Sync {
    fn execute(
        &self,
        command: &str,
        cwd: &std::path::Path,
        timeout: Duration,
    ) -> BoxFuture<'static, Result<BashOutput, String>>;
}

#[derive(Debug, Clone)]
pub struct BashOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

/// M0 executor: direct execution with env scrubbing and process-group
/// timeout kill (grandchildren included via kill -9 -pgid).
#[derive(Debug, Default, Clone, Copy)]
pub struct DirectExecutor;

impl BashExecutor for DirectExecutor {
    fn execute(
        &self,
        command: &str,
        cwd: &std::path::Path,
        timeout: Duration,
    ) -> BoxFuture<'static, Result<BashOutput, String>> {
        let command = command.to_owned();
        let cwd = cwd.to_owned();
        Box::pin(async move {
            let mut cmd = tokio::process::Command::new("/bin/bash");
            cmd.arg("-c").arg(&command).current_dir(&cwd);
            // Scrub everything, then pass through only the allowlist —
            // engine-held secrets must never reach subprocesses.
            cmd.env_clear();
            for var in CHILD_ENV_ALLOWLIST {
                if let Ok(value) = std::env::var(var) {
                    cmd.env(var, value);
                }
            }
            cmd.stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            // New process group so timeout kill reaps grandchildren.
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                cmd.as_std_mut().process_group(0);
            }
            let child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
            let pid = child.id();
            let output_fut = child.wait_with_output();
            match tokio::time::timeout(timeout, output_fut).await {
                Ok(Ok(output)) => Ok(BashOutput {
                    stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                    exit_code: output.status.code(),
                    timed_out: false,
                }),
                Ok(Err(e)) => Err(format!("wait: {e}")),
                Err(_) => {
                    kill_process_group(pid);
                    Ok(BashOutput {
                        stdout: String::new(),
                        stderr: format!(
                            "command timed out after {}ms and the process group was killed",
                            timeout.as_millis()
                        ),
                        exit_code: None,
                        timed_out: true,
                    })
                }
            }
        })
    }
}

fn kill_process_group(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    // /bin/kill -9 -<pgid>: no unsafe, reaps the whole tree.
    let _ = std::process::Command::new("/bin/kill")
        .arg("-9")
        .arg(format!("-{pid}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub async fn run_bash(
    ctx: &ToolContext,
    executor: &dyn BashExecutor,
    params: BashParams,
) -> (String, bool) {
    match run_bash_inner(ctx, executor, params).await {
        Ok(output) => (output, false),
        Err(e) => (format!("bash failed: {e}"), true),
    }
}

async fn run_bash_inner(
    ctx: &ToolContext,
    executor: &dyn BashExecutor,
    params: BashParams,
) -> Result<String, String> {
    let timeout_ms = params
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(MAX_TIMEOUT_MS);
    let output = executor
        .execute(&params.command, &ctx.cwd, Duration::from_millis(timeout_ms))
        .await?;

    let mut combined = String::new();
    if !output.stdout.trim().is_empty() {
        combined.push_str(&output.stdout);
        if !combined.ends_with('\n') {
            combined.push('\n');
        }
    }
    if !output.stderr.trim().is_empty() {
        combined.push_str("[stderr]\n");
        combined.push_str(&output.stderr);
        if !combined.ends_with('\n') {
            combined.push('\n');
        }
    }
    if combined.is_empty() {
        combined.push_str("(no output)\n");
    }
    combined.push_str(&format!(
        "\n[exit code: {}]",
        match output.exit_code {
            Some(code) => code.to_string(),
            None if output.timed_out => "timeout".to_owned(),
            None => "signal".to_owned(),
        }
    ));

    let truncated = truncate_output(&combined, &TruncationConfig::default());
    if truncated.was_truncated {
        if let Ok(spill) = spill_full_output(&ctx.data_dir, &ctx.session_id, "bash", &combined) {
            return Ok(format!(
                "{}\n\n[output truncated ({} bytes original); full output at {}]",
                truncated.content,
                truncated.original_len,
                spill.display()
            ));
        }
    }
    Ok(truncated.content)
}

#[allow(dead_code)]
pub(crate) fn default_executor() -> std::sync::Arc<dyn BashExecutor> {
    std::sync::Arc::new(DirectExecutor)
}
