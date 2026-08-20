//! `bash`: command execution behind an executor seam with bounded memory.
//! M0 ships [`DirectExecutor`] (env scrubbing + process-group kill);
//! T4b's Seatbelt executor plugs into the same trait without touching tool
//! code.
//!
//! Output governance is streaming-first: stdout/stderr flow through
//! non-overlapping 256 KiB head/tail windows while the full bytes spill
//! straight to disk — a build-log firehose can never OOM the engine, and
//! orphaned grandchildren holding pipes can never stall the result.
//!
//! Lifecycle invariants (review-hardened):
//! - Spill directory and files are initialized **before** spawn — no
//!   post-spawn setup error can leave a running child behind.
//! - One deadline governs the run: child wait vs. timeout; after the kill
//!   path, collectors get a short grace window and then are abandoned.
//! - Collectors publish streaming snapshots into shared drafts, so an
//!   abandoned collector still yields everything it observed.

use crate::ToolContext;
use futures::future::BoxFuture;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
/// Env vars passed to subprocesses; engine-held secrets never ride along.
pub const CHILD_ENV_ALLOWLIST: [&str; 4] = ["PATH", "HOME", "LANG", "TMPDIR"];
/// Per-stream in-memory window (head and tail each, non-overlapping).
const STREAM_WINDOW_BYTES: usize = 256 * 1024;
/// Grace window for collectors after the child exits or is killed.
const COLLECTOR_GRACE: Duration = Duration::from_secs(2);

/// Contract marker executors emit when the sandbox denied part of a
/// command (structured rejection note). The tool layer counts repeat
/// fingerprints and escalates guidance instead of letting the model
/// retry the same doomed approach.
pub const SANDBOX_DENIAL_MARKER: &str = "[saber-sandbox: denied]";

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct BashParams {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// Execution environment the executor needs beyond the command itself.
#[derive(Debug, Clone)]
pub struct BashEnv {
    pub cwd: PathBuf,
    pub data_dir: PathBuf,
    pub session_id: String,
}

/// Sanitized spill directory for a session — never leaves the data dir,
/// regardless of what the session id contains.
pub fn spill_dir_for(data_dir: &std::path::Path, session_id: &str) -> PathBuf {
    data_dir
        .join("truncations")
        .join(crate::truncation::sanitize(session_id))
}

/// Bounded view of one output stream.
#[derive(Debug, Clone, Default)]
pub struct HeadTail {
    pub head: String,
    pub tail: String,
    pub total_bytes: u64,
    /// Present when the stream overflowed the head window AND spilling
    /// succeeded; holds the full bytes.
    pub spill_path: Option<PathBuf>,
    /// The stream overflowed but the spill file could not be written.
    pub spill_failed: bool,
}

impl HeadTail {
    pub fn truncated(&self) -> bool {
        self.total_bytes as usize > self.head.len()
    }

    fn render(&self, label: &str) -> String {
        let mut out = String::new();
        if self.total_bytes == 0 {
            return out;
        }
        out.push_str(&format!("[{label}]\n"));
        out.push_str(self.head.trim_end());
        out.push('\n');
        if self.truncated() {
            let omitted = self
                .total_bytes
                .saturating_sub((self.head.len() + self.tail.len()) as u64);
            match (&self.spill_path, self.spill_failed) {
                (Some(path), _) => out.push_str(&format!(
                    "…[{omitted} bytes omitted; full {label} at {}]…\n",
                    path.display()
                )),
                (None, true) => out.push_str(&format!(
                    "…[{omitted} bytes omitted; full-output spill FAILED — tail window only]…\n"
                )),
                (None, false) => {}
            }
            if !self.tail.is_empty() {
                out.push_str(self.tail.trim_end());
                out.push('\n');
            }
        }
        out
    }
}

#[derive(Debug, Clone)]
pub struct BashOutput {
    pub stdout: HeadTail,
    pub stderr: HeadTail,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

impl BashOutput {
    pub fn render(&self) -> String {
        let mut combined = String::new();
        combined.push_str(&self.stdout.render("stdout"));
        combined.push_str(&self.stderr.render("stderr"));
        if combined.is_empty() {
            combined.push_str("(no output)\n");
        }
        combined.push_str(&format!(
            "\n[exit code: {}]",
            match self.exit_code {
                Some(code) => code.to_string(),
                None if self.timed_out => "timeout".to_owned(),
                None => "signal".to_owned(),
            }
        ));
        combined
    }
}

/// Execution seam: T4b implements this with Seatbelt confinement.
///
/// ## Production wiring warning
///
/// [`DirectExecutor`] performs **no confinement** — it scrubs the child
/// environment and kills process groups, but any command runs with full
/// host authority. Production binaries must construct the bash tool with
/// the Seatbelt executor (T4b); `DirectExecutor` exists for tests and as
/// the reference implementation of the trait contract.
pub trait BashExecutor: Send + Sync {
    fn execute(
        &self,
        env: &BashEnv,
        command: &str,
        timeout: Duration,
    ) -> BoxFuture<'static, Result<BashOutput, String>>;
}

/// Streaming per-stream state shared between the collector task and the
/// coordinator (so an abandoned collector still yields its observations).
#[derive(Default)]
struct Draft {
    head: Vec<u8>,
    ring: std::collections::VecDeque<u8>,
    total: u64,
    spill_ok: bool,
}

impl Draft {
    fn view(&self, spill_path: Option<&PathBuf>) -> HeadTail {
        let truncated = self.total as usize > self.head.len();
        // Ring holds the last TAIL bytes; render only the part that starts
        // after the head window so head/tail never overlap.
        let ring_start = self.total.saturating_sub(self.ring.len() as u64);
        let skip = (self.head.len() as u64).saturating_sub(ring_start);
        let tail_bytes: Vec<u8> = self.ring.iter().skip(skip as usize).copied().collect();
        HeadTail {
            head: String::from_utf8_lossy(&self.head).into_owned(),
            tail: String::from_utf8_lossy(&tail_bytes).into_owned(),
            total_bytes: self.total,
            spill_path: if truncated && self.spill_ok {
                spill_path.cloned()
            } else {
                None
            },
            spill_failed: truncated && !self.spill_ok,
        }
    }
}

/// Collects one pipe into the shared draft, spilling full bytes to disk.
/// A spill write failure degrades (window-only) but never stops draining,
/// so the child can never die of SIGPIPE on our account.
async fn collect<R>(mut reader: R, mut spill: Option<tokio::fs::File>, draft: &Mutex<Draft>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        let n = match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let chunk = &buffer[..n];
        if let Some(file) = spill.as_mut() {
            if file.write_all(chunk).await.is_err() {
                // Spill degraded: drop the handle, keep draining to the
                // in-memory windows.
                if let Some(mut file) = spill.take() {
                    let _ = file.flush().await;
                }
                if let Ok(mut draft) = draft.lock() {
                    draft.spill_ok = false;
                }
            }
        }
        if let Ok(mut draft) = draft.lock() {
            draft.total += n as u64;
            if draft.head.len() < STREAM_WINDOW_BYTES {
                let take = (STREAM_WINDOW_BYTES - draft.head.len()).min(n);
                draft.head.extend_from_slice(&chunk[..take]);
            }
            for &byte in chunk {
                if draft.ring.len() >= STREAM_WINDOW_BYTES {
                    draft.ring.pop_front();
                }
                draft.ring.push_back(byte);
            }
        }
    }
    if let Some(mut file) = spill {
        let _ = file.flush().await;
    }
}

/// M0 executor: direct execution with env scrubbing and process-group
/// timeout kill. See the trait docs — production must wire Seatbelt (T4b).
#[derive(Debug, Default, Clone, Copy)]
pub struct DirectExecutor;

/// Governance runner shared by every executor: env scrubbing, spill setup
/// before spawn, process groups, bounded streaming collection, and the
/// single-deadline kill path. Executors only decide the argv (direct bash,
/// Seatbelt-wrapped, future backends).
pub async fn run_with_governance(
    argv: &[String],
    env: &BashEnv,
    timeout: Duration,
    tool_label: &str,
    env_overrides: &[(String, String)],
) -> Result<BashOutput, String> {
    // Spill initialization happens BEFORE spawn: no post-spawn setup
    // failure can orphan a running child.
    let spill_dir = spill_dir_for(&env.data_dir, &env.session_id);
    std::fs::create_dir_all(&spill_dir).map_err(|e| format!("spill dir: {e}"))?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stdout_spill_path = spill_dir.join(format!("{millis}-{tool_label}-stdout.log"));
    let stderr_spill_path = spill_dir.join(format!("{millis}-{tool_label}-stderr.log"));
    // Pre-open both files; failure degrades to window-only mode instead of
    // aborting (the command still runs and reports).
    let stdout_spill_file = tokio::fs::File::create(&stdout_spill_path).await.ok();
    let stderr_spill_file = tokio::fs::File::create(&stderr_spill_path).await.ok();

    let mut cmd = tokio::process::Command::new(&argv[0]);
    cmd.args(&argv[1..]).current_dir(&env.cwd);
    // Scrub everything, then pass through only the allowlist — engine-held
    // secrets must never reach subprocesses.
    cmd.env_clear();
    for var in CHILD_ENV_ALLOWLIST {
        if let Ok(value) = std::env::var(var) {
            cmd.env(var, value);
        }
    }
    for (key, value) in env_overrides {
        cmd.env(key, value);
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
    let child = cmd.spawn().map_err(|e| format!("spawn {}: {e}", argv[0]))?;
    run_child_to_output(
        child,
        env,
        timeout,
        stdout_spill_path,
        stderr_spill_path,
        stdout_spill_file,
        stderr_spill_file,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_child_to_output(
    mut child: tokio::process::Child,
    env: &BashEnv,
    timeout: Duration,
    stdout_spill_path: PathBuf,
    stderr_spill_path: PathBuf,
    stdout_spill_file: Option<tokio::fs::File>,
    stderr_spill_file: Option<tokio::fs::File>,
) -> Result<BashOutput, String> {
    let _ = &env;
    {
        {
            let pid = child.id();
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            let stdout_draft = Arc::new(Mutex::new(Draft {
                spill_ok: stdout_spill_file.is_some(),
                ..Draft::default()
            }));
            let stderr_draft = Arc::new(Mutex::new(Draft {
                spill_ok: stderr_spill_file.is_some(),
                ..Draft::default()
            }));
            let out_task = tokio::spawn({
                let draft = stdout_draft.clone();
                async move {
                    if let Some(pipe) = stdout {
                        collect(pipe, stdout_spill_file, &draft).await;
                    }
                }
            });
            let err_task = tokio::spawn({
                let draft = stderr_draft.clone();
                async move {
                    if let Some(pipe) = stderr {
                        collect(pipe, stderr_spill_file, &draft).await;
                    }
                }
            });

            // One deadline: normal exit vs. timeout (kill path).
            let (exit_code, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
                Ok(status) => (status.map(|s| s.code()).unwrap_or(None), false),
                Err(_) => {
                    // Direct SIGKILL unblocks wait(); the group kill then
                    // reaps grandchildren (best-effort).
                    let _ = child.start_kill();
                    kill_process_group(pid).await;
                    let status = child.wait().await;
                    (status.map(|s| s.code()).unwrap_or(None), true)
                }
            };

            // Collectors get a grace window (pipes close after exit/kill);
            // orphans holding pipes past the window are abandoned — the
            // drafts already hold everything observed.
            let _ = tokio::time::timeout(COLLECTOR_GRACE, async {
                let _ = out_task.await;
                let _ = err_task.await;
            })
            .await;

            let stdout_view = stdout_draft
                .lock()
                .map(|draft| draft.view(Some(&stdout_spill_path)))
                .map_err(|e| format!("stdout draft: {e}"))?;
            let stderr_view = stderr_draft
                .lock()
                .map(|draft| draft.view(Some(&stderr_spill_path)))
                .map_err(|e| format!("stderr draft: {e}"))?;
            // Delete spill files that carry nothing the windows lack.
            if !stdout_view.truncated() || stdout_view.spill_failed {
                let _ = tokio::fs::remove_file(&stdout_spill_path).await;
            }
            if !stderr_view.truncated() || stderr_view.spill_failed {
                let _ = tokio::fs::remove_file(&stderr_spill_path).await;
            }

            Ok(BashOutput {
                stdout: stdout_view,
                stderr: stderr_view,
                exit_code,
                timed_out,
            })
        }
    }
}

impl BashExecutor for DirectExecutor {
    fn execute(
        &self,
        env: &BashEnv,
        command: &str,
        timeout: Duration,
    ) -> BoxFuture<'static, Result<BashOutput, String>> {
        let env = env.clone();
        let command = command.to_owned();
        Box::pin(async move {
            let argv = vec!["/bin/bash".to_owned(), "-c".to_owned(), command.clone()];
            run_with_governance(&argv, &env, timeout, "bash", &[]).await
        })
    }
}

async fn kill_process_group(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    // /bin/kill -9 -- -<pgid>: no unsafe, reaps the whole tree. The `--`
    // keeps every kill flavor from misparsing the negative pid; bounded so
    // a broken kill binary can never stall the timeout path.
    let group_kill = tokio::process::Command::new("/bin/kill")
        .arg("-9")
        .arg("--")
        .arg(format!("-{pid}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match tokio::time::timeout(Duration::from_secs(2), group_kill).await {
        Ok(Ok(status)) if status.success() => {}
        outcome => {
            eprintln!("[saber-bash] group kill did not confirm success: {outcome:?}");
        }
    }
}

pub async fn run_bash(
    ctx: &ToolContext,
    executor: &dyn BashExecutor,
    params: BashParams,
) -> (String, bool) {
    let timeout_ms = params
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(MAX_TIMEOUT_MS);
    let bash_env = BashEnv {
        cwd: ctx.cwd.clone(),
        data_dir: ctx.data_dir.clone(),
        session_id: ctx.session_id.clone(),
    };
    match executor
        .execute(
            &bash_env,
            &params.command,
            Duration::from_millis(timeout_ms),
        )
        .await
    {
        Ok(output) => {
            let mut rendered = output.render();
            if rendered.contains(SANDBOX_DENIAL_MARKER) {
                // Whitespace-normalized fingerprint so trivial reformatting
                // of the same doomed command still counts as a repeat.
                let fingerprint = params
                    .command
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                let repeats = ctx.record_sandbox_denial(&fingerprint);
                if repeats >= 2 {
                    rendered.push_str(&format!(
                        "\n[saber] the SAME sandbox boundary denied this command {repeats} \
                         times in a row — stop retrying variations of it. The boundary is \
                         intentional: write only inside the workspace, treat secrets as \
                         unreadable, and expect no network. Ask the user when the task \
                         truly needs more."
                    ));
                    // Hard stop: a repeated identical denial returns as an
                    // error so the loop treats it as a failed tool call.
                    return (rendered, true);
                }
                (rendered, false)
            } else {
                ctx.reset_denials();
                (rendered, false)
            }
        }
        Err(e) => (format!("bash failed: {e}"), true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spill_dir_stays_inside_data_dir_for_hostile_session_ids() {
        let data = std::path::Path::new("/tmp/saber-data");
        let dir = spill_dir_for(data, "../../etc");
        assert!(dir.starts_with(data.join("truncations")), "{dir:?}");
        let dir = spill_dir_for(data, "C:\\absolute");
        assert!(dir.starts_with(data.join("truncations")), "{dir:?}");
    }

    #[tokio::test]
    async fn oversized_output_keeps_tail_and_spills_full() {
        let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let env = BashEnv {
            cwd: temp.path().to_owned(),
            data_dir: temp.path().join(".saber"),
            session_id: "s-tail".into(),
        };
        // ~356 KiB of distinct lines — well past the 256 KiB window.
        let out = DirectExecutor
            .execute(&env, "seq 1 60000", Duration::from_secs(30))
            .await
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(out.stdout.truncated(), "must be truncated");
        assert!(out.stdout.head.contains("1\n"), "head holds the start");
        assert!(
            out.stdout.tail.contains("60000"),
            "tail must survive — it was silently dropped before this fix"
        );
        let spill = out
            .stdout
            .spill_path
            .clone()
            .unwrap_or_else(|| panic!("spill must exist: {:?}", out.stdout));
        let full = std::fs::read_to_string(&spill).unwrap_or_else(|e| panic!("{e}"));
        assert!(full.starts_with("1\n2\n"));
        assert!(full.trim_end().ends_with("60000"));
    }

    #[tokio::test]
    async fn backgrounded_orphan_does_not_stall_or_swallow_output() {
        let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let env = BashEnv {
            cwd: temp.path().to_owned(),
            data_dir: temp.path().join(".saber"),
            session_id: "s-orphan".into(),
        };
        let started = std::time::Instant::now();
        let out = DirectExecutor
            .execute(&env, "echo visible; sleep 8 &", Duration::from_secs(30))
            .await
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(
            started.elapsed() < Duration::from_secs(6),
            "orphan must not stall the result: {:?}",
            started.elapsed()
        );
        assert_eq!(out.exit_code, Some(0));
        assert!(
            out.stdout.head.contains("visible"),
            "observed output must survive: {:?}",
            out.stdout.head
        );
    }
}
