//! Seatbelt sandbox integration tests (macOS-only — `sandbox-exec` does
//! not exist elsewhere; CI runs these on a macos-latest job).
//!
//! Negative (must block): writes outside roots, all network, secret reads
//! (~/.ssh, workspace .env). Positive (must pass): real Rust/Node/Python
//! one-liners so the sandbox is "safe AND usable", not just safe.

#![cfg(target_os = "macos")]

use saber_sandbox::{DENIAL_MARKER, SeatbeltExecutor, debug_run};
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

async fn run_at(workspace: &std::path::Path, command: &str) -> saber_tools::bash::BashOutput {
    let env = BashEnv {
        cwd: workspace.to_owned(),
        data_dir: workspace.join(".saber"),
        session_id: "s-sb-test".to_owned(),
    };
    SeatbeltExecutor
        .execute(&env, command, Duration::from_secs(60))
        .await
        .unwrap_or_else(|e| panic!("{e}"))
}

async fn run(temp: &tempfile::TempDir, command: &str) -> saber_tools::bash::BashOutput {
    run_at(temp.path(), command).await
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

#[tokio::test]
async fn nested_pem_and_prefixed_env_are_denied() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    std::fs::create_dir_all(temp.path().join("certs")).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(temp.path().join("certs/server.pem"), "KEY").unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(temp.path().join("prod.env"), "TOKEN=1").unwrap_or_else(|e| panic!("{e}"));
    let out = run(&temp, "cat certs/server.pem prod.env").await;
    assert!(denied(&out), "expected secret denial: {}", out.render());
    assert!(!out.stdout.head.contains("KEY"));
    assert!(!out.stdout.head.contains("TOKEN=1"));
}

#[tokio::test]
async fn special_char_workspace_names_still_deny_secrets() {
    // `+`, brackets, parens are legal path chars and regex metacharacters.
    let base = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let weird = base.path().join("a+b[c](d)");
    std::fs::create_dir_all(&weird).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(weird.join(".env"), "SECRET=1").unwrap_or_else(|e| panic!("{e}"));
    let out = run_at(&weird, "cat .env").await;
    assert!(
        denied(&out),
        "denial must survive special chars: {}",
        out.render()
    );
    assert!(!out.stdout.head.contains("SECRET=1"));
}

#[tokio::test]
async fn system_tmp_write_is_denied() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let out = run(
        &temp,
        "touch /private/tmp/saber-escape-test 2>/dev/null; echo rc=$?",
    )
    .await;
    // The touch itself must fail (denied) even if the message lands in stdout.
    assert!(
        denied(&out) || !out.stdout.head.contains("rc=0"),
        "system /tmp must not be writable: {}",
        out.render()
    );
    assert!(
        !std::path::Path::new("/private/tmp/saber-escape-test").exists(),
        "escape file must not exist"
    );
}

#[tokio::test]
async fn tools_using_tmpdir_still_work() {
    // TMPDIR is redirected into the data dir; toolchains must keep working.
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let script = "echo data > \"$TMPDIR/saber-tmp-check\" && cat \"$TMPDIR/saber-tmp-check\"";
    let out = run(&temp, script).await;
    assert_eq!(
        out.exit_code,
        Some(0),
        "TMPDIR writes must pass: {}",
        out.render()
    );
    assert!(out.stdout.head.contains("data"), "{}", out.stdout.head);
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
async fn python_unittest_runner_works() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(
        temp.path().join("test_math.py"),
        "import unittest\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(1 + 1, 2)\n",
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let out = run(&temp, "python3 -m unittest test_math -v").await;
    let rendered = out.render();
    assert_eq!(out.exit_code, Some(0), "{rendered}");
    // unittest writes progress to stderr.
    assert!(
        rendered.contains("Ran 1 test") || rendered.contains("OK"),
        "unittest output missing: {rendered}"
    );
}

#[tokio::test]
async fn node_test_runner_works() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(
        temp.path().join("math.test.js"),
        "const test = require('node:test');\nconst assert = require('node:assert');\ntest('adds', () => { assert.strictEqual(1 + 1, 2); });\n",
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let out = run(&temp, "node --test").await;
    assert_eq!(out.exit_code, Some(0), "{}", out.render());
    assert!(
        out.stdout.head.contains("pass 1")
            || out.stdout.head.contains("1 passing")
            || out.stdout.head.contains("# pass 1"),
        "{}",
        out.stdout.head
    );
}

#[tokio::test]
async fn rust_cargo_test_works_offline() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(
        temp.path().join("Cargo.toml"),
        "[package]\nname = \"sbtest\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap_or_else(|e| panic!("{e}"));
    std::fs::create_dir_all(temp.path().join("src")).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(
        temp.path().join("src/lib.rs"),
        "pub fn add(a: i32, b: i32) -> i32 { a + b }\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() { assert_eq!(super::add(1, 1), 2); }\n}\n",
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let out = run(&temp, "cargo test --offline -q").await;
    let rendered = out.render();
    assert_eq!(out.exit_code, Some(0), "cargo test must pass: {rendered}");
    assert!(rendered.contains("test result: ok"), "{rendered}");
}

#[tokio::test]
async fn pty_allocation_works() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    // `script` needs a pty via /dev/ptmx.
    let out = run(&temp, "script -q /dev/null echo pty-ok").await;
    assert_eq!(
        out.exit_code,
        Some(0),
        "pty commands must pass: {}",
        out.render()
    );
    assert!(out.render().contains("pty-ok"), "{}", out.render());
}

#[tokio::test]
async fn git_directory_writes_are_denied() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    std::fs::create_dir_all(temp.path().join(".git")).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(temp.path().join(".git/HEAD"), "ref: refs/heads/main")
        .unwrap_or_else(|e| panic!("{e}"));
    let out = run(&temp, "echo hacked > .git/HEAD").await;
    assert!(denied(&out), ".git must be read-only: {}", out.render());
    assert_eq!(
        std::fs::read_to_string(temp.path().join(".git/HEAD")).unwrap_or_default(),
        "ref: refs/heads/main",
        "git history must be intact"
    );
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
