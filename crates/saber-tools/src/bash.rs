//! `bash`: command execution behind an executor seam with bounded memory.
//! M0 ships [`DirectExecutor`] (env scrubbing + process-group kill);
//! T4b's Seatbelt executor plugs into the same trait without touching tool
//! code.
//!
//! Output governance is streaming-first: stdout/stderr flow through 256 KiB
//! head/tail windows while the full bytes spill straight to disk — a
//! build-log firehose can never OOM the engine.

use crate::ToolContext;
use futures::future::BoxFuture;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
/// Env vars passed to subprocesses; engine-held secrets never ride along.
pub const CHILD_ENV_ALLOWLIST: [&str; 4] = ["PATH", "HOME", "LANG", "TMPDIR"];
/// Per-stream in-memory window (head and tail each).
const STREAM_WINDOW_BYTES: usize = 256 * 1024;

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

/// Bounded view of one output stream.
#[derive(Debug, Clone, Default)]
pub struct HeadTail {
    pub head: String,
    pub tail: String,
    pub total_bytes: u64,
    /// Present when the stream overflowed the window; holds the full bytes.
    pub spill_path: Option<PathBuf>,
}

impl HeadTail {
    fn truncated(&self) -> bool {
        self.spill_path.is_some()
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
            if let Some(path) = &self.spill_path {
                out.push_str(&format!(
                    "…[{omitted} bytes omitted; full {label} at {}]…\n",
                    path.display()
                ));
            }
            out.push_str(self.tail.trim_end());
            out.push('\n');
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

/// Streams one pipe into a bounded window plus a spill file.
async fn collect_stream<R, W>(mut reader: R, mut spill: W) -> (HeadTail, std::io::Result<()>)
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    let mut head = Vec::new();
    let mut tail: std::collections::VecDeque<u8> = std::collections::VecDeque::new();
    let mut tail_bytes = 0usize;
    let mut total = 0u64;
    let mut overflow = false;
    let mut buffer = vec![0u8; 16 * 1024];
    let mut io_result = Ok(());
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(n) => {
                let chunk = &buffer[..n];
                if let Err(e) = spill.write_all(chunk).await {
                    io_result = Err(e);
                    break;
                }
                total += n as u64;
                if head.len() < STREAM_WINDOW_BYTES {
                    let take = (STREAM_WINDOW_BYTES - head.len()).min(n);
                    head.extend_from_slice(&chunk[..take]);
                }
                if head.len() == STREAM_WINDOW_BYTES {
                    overflow = true;
                }
                if overflow {
                    for &byte in chunk {
                        if tail_bytes >= STREAM_WINDOW_BYTES {
                            tail.pop_front();
                            tail_bytes -= 1;
                        }
                        tail.push_back(byte);
                        tail_bytes += 1;
                    }
                }
            }
            Err(e) => {
                io_result = Err(e);
                break;
            }
        }
    }
    let _ = spill.flush().await;
    let head_str = String::from_utf8_lossy(&head).into_owned();
    let tail_str = String::from_utf8_lossy(tail.make_contiguous()).into_owned();
    (
        HeadTail {
            head: head_str,
            tail: tail_str,
            total_bytes: total,
            spill_path: None, // caller attaches it when keeping the file
        },
        io_result,
    )
}

/// Collects one pipe (stdout or stderr) into a bounded window plus spill.
async fn collect_into<R>(pipe: Option<R>, path: PathBuf) -> (HeadTail, Option<PathBuf>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let (Some(pipe), Ok(file)) = (pipe, tokio::fs::File::create(&path).await) else {
        return (HeadTail::default(), None);
    };
    let (mut view, io) = collect_stream(pipe, file).await;
    if io.is_err() {
        let _ = tokio::fs::remove_file(&path).await;
        return (view, None);
    }
    if view.total_bytes as usize > view.head.len() + view.tail.len() {
        view.spill_path = Some(path.clone());
    }
    (view, Some(path))
}

/// M0 executor: direct execution with env scrubbing and process-group
/// timeout kill. See the trait docs — production must wire Seatbelt (T4b).
#[derive(Debug, Default, Clone, Copy)]
pub struct DirectExecutor;

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
            let mut cmd = tokio::process::Command::new("/bin/bash");
            cmd.arg("-c").arg(&command).current_dir(&env.cwd);
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
            let mut child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
            let pid = child.id();
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            let millis = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let spill_dir = env.data_dir.join("truncations").join(&env.session_id);
            std::fs::create_dir_all(&spill_dir).map_err(|e| format!("spill dir: {e}"))?;
            let stdout_spill = spill_dir.join(format!("{millis}-bash-stdout.log"));
            let stderr_spill = spill_dir.join(format!("{millis}-bash-stderr.log"));

            let out_task = tokio::spawn(collect_into(stdout, stdout_spill));
            let err_task = tokio::spawn(collect_into(stderr, stderr_spill));

            let (exit_code, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
                Ok(status) => (status.map(|s| s.code()).unwrap_or(None), false),
                Err(_) => {
                    // Belt and braces: direct SIGKILL unblocks wait() on
                    // every unix; the group kill then reaps grandchildren
                    // (best-effort — the fault matrix owns verifying it).
                    eprintln!("[saber-bash-dbg] timeout fired, pid={pid:?}");
                    let kill_result = child.start_kill();
                    eprintln!("[saber-bash-dbg] start_kill={kill_result:?}");
                    kill_process_group(pid).await;
                    eprintln!("[saber-bash-dbg] group kill done");
                    let status = child.wait().await;
                    eprintln!("[saber-bash-dbg] second wait={status:?}");
                    (status.map(|s| s.code()).unwrap_or(None), true)
                }
            };

            let (mut stdout_view, stdout_spill_path) = out_task
                .await
                .map_err(|e| format!("stdout collector: {e}"))?;
            let (mut stderr_view, stderr_spill_path) = err_task
                .await
                .map_err(|e| format!("stderr collector: {e}"))?;
            // Drop spill files for streams that stayed inside the window.
            let stdout_kept = stdout_view.truncated();
            let stderr_kept = stderr_view.truncated();
            if !stdout_kept {
                if let Some(path) = &stdout_spill_path {
                    let _ = tokio::fs::remove_file(path).await;
                }
                stdout_view.spill_path = None;
            }
            if !stderr_kept {
                if let Some(path) = &stderr_spill_path {
                    let _ = tokio::fs::remove_file(path).await;
                }
                stderr_view.spill_path = None;
            }

            Ok(BashOutput {
                stdout: stdout_view,
                stderr: stderr_view,
                exit_code,
                timed_out,
            })
        })
    }
}

async fn kill_process_group(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    // /bin/kill -9 -<pgid>: no unsafe, reaps the whole tree. Bounded so a
    // broken kill binary can never stall the timeout path.
    let group_kill = tokio::process::Command::new("/bin/kill")
        .arg("-9")
        .arg(format!("-{pid}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = tokio::time::timeout(Duration::from_secs(2), group_kill).await;
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
        Ok(output) => (output.render(), false),
        Err(e) => (format!("bash failed: {e}"), true),
    }
}
