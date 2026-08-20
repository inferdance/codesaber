//! Seatbelt sandbox integration tests (macOS-only — `sandbox-exec` does
//! not exist elsewhere; CI runs these on a macos-latest job).
//!
//! Negative (must block): writes outside roots, all network, secret reads
//! (~/.ssh, workspace .env). Positive (must pass): real Rust/Node/Python
//! one-liners so the sandbox is "safe AND usable", not just safe.

#![cfg(target_os = "macos")]

use saber_sandbox::{DENIAL_MARKER, SandboxConfig, SeatbeltExecutor, debug_run};
use saber_tools::bash::{BashEnv, BashExecutor};
use std::path::PathBuf;
use std::time::Duration;

fn env_for(temp: &tempfile::TempDir) -> BashEnv {
    BashEnv {
        cwd: temp.path().to_owned(),
        data_dir: temp.path().join(".saber"),
        session_id: "s-sb-test".to_owned(),
    }
}

async fn run(temp: &tempfile::TempDir, command: &str) -> saber_tools::bash::BashOutput {
    let executor = SeatbeltExecutor::new(SandboxConfig {
        extra_writable_roots: Vec::new(),
    });
    executor
        .execute(&env_for(temp), command, Duration::from_secs(60))
        .await
        .unwrap_or_else(|e| panic!("{e}"))
}

fn denied(output: &saber_tools::bash::BashOutput) -> bool {
    output.stderr.head.contains(DENIAL_MARKER) || output.stderr.tail.contains(DENIAL_MARKER)
}

// --- Boundary tests (must block) --------------------------------------

#[tokio::test]
async fn write_outside_workspace_is_denied() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let target = home.join("saber-sandbox-test-outside.txt");
    let out = run(&temp, &format!("touch {}", target.display())).await;
    assert!(denied(&out), "expected denial, got: {}", out.render());
    assert!(!target.exists(), "file must not be created outside");
}

#[tokio::test]
async fn network_access_is_denied() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let out = run(
        &temp,
        "curl --max-time 5 -sS https://example.com >/dev/null && echo NET-OK",
    )
    .await;
    assert!(
        denied(&out),
        "expected network denial, got: {}",
        out.render()
    );
    assert!(!out.stdout.head.contains("NET-OK"));
}

#[tokio::test]
async fn ssh_directory_read_is_denied() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    // Only meaningful when ~/.ssh exists with content; otherwise the read
    // fails anyway (ENOENT) and the denial annotation still fires on EPERM.
    let config = home.join(".ssh/config");
    if config.exists() {
        let out = run(&temp, &format!("cat {}", config.display())).await;
        assert!(
            denied(&out),
            "expected secret-read denial: {}",
            out.render()
        );
    }
}

#[tokio::test]
async fn workspace_env_file_read_is_denied() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(temp.path().join(".env"), "SECRET=1").unwrap_or_else(|e| panic!("{e}"));
    let out = run(&temp, "cat .env").await;
    assert!(denied(&out), "expected .env denial: {}", out.render());
    assert!(!out.stdout.head.contains("SECRET=1"));
}

#[tokio::test]
async fn env_holds_no_engine_secrets() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let out = run(&temp, "env | cut -d= -f1 | sort | tr '\\n' ' '").await;
    for name in out.stdout.head.split_whitespace() {
        assert!(
            [
                "PATH",
                "HOME",
                "LANG",
                "TMPDIR",
                "PWD",
                "OLDPWD",
                "SHLVL",
                "_",
                "BASH_VERS"
            ]
            .iter()
            .any(|a| name.starts_with(a)),
            "leaked env var {name:?}: {}",
            out.stdout.head
        );
    }
}

// --- Positive pass-through (must work) ---------------------------------

#[tokio::test]
async fn plain_commands_and_workspace_writes_work() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let out = run(
        &temp,
        "echo hello && mkdir -p sub && echo x > sub/f.txt && cat sub/f.txt",
    )
    .await;
    assert_eq!(out.exit_code, Some(0), "{}", out.render());
    assert!(out.stdout.head.contains("hello"));
    assert!(out.stdout.head.contains('x'));
}

#[tokio::test]
async fn python_one_liner_works() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let out = run(&temp, "python3 -c 'print(6*7)'").await;
    assert_eq!(out.exit_code, Some(0), "{}", out.render());
    assert!(out.stdout.head.contains("42"), "{}", out.stdout.head);
}

#[tokio::test]
async fn node_one_liner_works() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let out = run(&temp, "node -e 'console.log(6*7)'").await;
    assert_eq!(out.exit_code, Some(0), "{}", out.render());
    assert!(out.stdout.head.contains("42"), "{}", out.stdout.head);
}

#[tokio::test]
async fn rust_cargo_build_works_offline() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let out = run(
        &temp,
        "cargo init --name sbtest -q . && cargo build --offline -q",
    )
    .await;
    assert_eq!(
        out.exit_code,
        Some(0),
        "rust build must pass: {}",
        out.render()
    );
    assert!(temp.path().join("target/debug/sbtest").exists());
}

// --- Debug helper --------------------------------------------------------

#[tokio::test]
async fn debug_run_reports_denials() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (out, denied_flag) = debug_run(temp.path(), &temp.path().join(".saber"), "ls /")
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(
        !denied_flag,
        "plain ls must not be denied: {}",
        out.render()
    );
    let (_out, denied_flag) = debug_run(
        temp.path(),
        &temp.path().join(".saber"),
        "cat /etc/synthetic.conf 2>/dev/null; touch /saber-root-test",
    )
    .await
    .unwrap_or_else(|e| panic!("{e}"));
    assert!(denied_flag, "root write must be flagged as denied");
}
