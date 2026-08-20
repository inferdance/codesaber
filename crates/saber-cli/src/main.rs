//! The `saber` binary: headless exec, sandbox debug, doctor, and session
//! resume frontends over the shared engine.
//!
//! M0 delivers `saber exec -p "..." [--json] [--model M]` — the CI/Harbor/
//! scripting entry point — plus `saber debug sandbox` and `saber doctor`.

use saber_core::session::SessionLog;
use saber_core::{Engine, TurnInput, TurnOutcome, assemble_system_prompt};
use saber_protocol::{Event, SessionEvent};
use saber_provider::Provider;
use saber_provider::anthropic::AnthropicConfig;
use saber_provider::openai::OpenAiCompatConfig;
use saber_tools::bash::DirectExecutor;
use saber_tools::{Registry, ToolContext, builtin_tools};
use std::path::PathBuf;
use std::sync::Arc;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    match args.first().map(String::as_str) {
        Some("exec") => run_exec(&args[1..]),
        Some("debug") => run_debug(&args[1..]),
        Some("doctor") | Some("--doctor") => run_doctor(),
        Some("--version") | Some("-V") => {
            println!(
                "saber {} (engine {}, protocol {})",
                env!("CARGO_PKG_VERSION"),
                saber_core::ENGINE_VERSION,
                saber_protocol::PROTOCOL_VERSION
            );
            Ok(())
        }
        Some("--help") | Some("-h") | None => {
            print_help();
            Ok(())
        }
        Some(other) => {
            eprintln!("unknown subcommand: {other}");
            print_help();
            std::process::exit(2);
        }
    }
}

fn print_help() {
    println!(
        "saber — an AI coding agent

USAGE:
    saber exec -p <prompt> [--json] [--model <model>] [--timeout <sec>]
    saber debug sandbox -- <command>
    saber doctor
    saber --version

OPTIONS:
    -p <prompt>       The task prompt (required for exec)
    --json            Output engine events as JSONL on stdout
    --model <model>   Model override (default: provider default)
    --timeout <sec>   Turn timeout in seconds (default: 600)"
    );
}

// ============================================================
// saber exec
// ============================================================

fn run_exec(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let mut prompt: Option<String> = None;
    let mut json_mode = false;
    let mut model_override: Option<String> = None;
    let mut timeout_secs: u64 = 600;

    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-p" | "--prompt" => {
                prompt = iter.next().cloned();
            }
            "--json" => json_mode = true,
            "--model" => {
                model_override = iter.next().cloned();
            }
            "--timeout" => {
                timeout_secs = iter.next().and_then(|s| s.parse().ok()).unwrap_or(600);
            }
            _ => {}
        }
    }

    let Some(prompt) = prompt else {
        eprintln!("error: -p <prompt> is required for exec");
        std::process::exit(2);
    };

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async_move_exec(
        prompt,
        json_mode,
        model_override,
        timeout_secs,
    ))
}

async fn async_move_exec(
    prompt: String,
    json_mode: bool,
    model_override: Option<String>,
    timeout_secs: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let data_dir = dirs_data_dir(&cwd);

    // Provider selection: env-driven, M0-simple.
    let (provider, model): (Arc<dyn Provider>, String) = if let Ok(key) =
        std::env::var("ANTHROPIC_API_KEY")
    {
        let config = AnthropicConfig {
            base_url: "https://api.anthropic.com".into(),
            api_key: key,
            default_model: "claude-sonnet-4-5-20250929".into(),
            request_timeout: None,
            pricing: None,
        };
        (
            Arc::new(saber_provider::anthropic::AnthropicProvider::new(config)?),
            model_override.unwrap_or_else(|| "claude-sonnet-4-5-20250929".to_owned()),
        )
    } else if let Ok(key) = env_var(&["SABER_OPENAI_KEY", "OPENAI_API_KEY"]) {
        let config = OpenAiCompatConfig {
            name: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            api_key: key,
            default_model: "gpt-4o".into(),
            request_timeout: None,
            pricing: None,
        };
        (
            Arc::new(saber_provider::openai::OpenAiCompatProvider::new(config)?),
            model_override.unwrap_or_else(|| "gpt-4o".to_owned()),
        )
    } else if let Ok((key, base)) = deepseek_config() {
        let config = OpenAiCompatConfig {
            name: "deepseek".into(),
            base_url: base,
            api_key: key,
            default_model: "deepseek-chat".into(),
            request_timeout: None,
            pricing: None,
        };
        (
            Arc::new(saber_provider::openai::OpenAiCompatProvider::new(config)?),
            model_override.unwrap_or_else(|| "deepseek-chat".to_owned()),
        )
    } else {
        eprintln!(
            "error: no API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or DEEPSEEK_API_KEY"
        );
        std::process::exit(1);
    };

    // Session: new per exec invocation (M0).
    let session_id = format!(
        "exec-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let session = Arc::new(SessionLog::create(
        &data_dir.join("sessions"),
        &session_id,
        SessionEvent::SessionMeta {
            protocol_version: saber_protocol::PROTOCOL_VERSION.to_owned(),
            engine_version: saber_core::ENGINE_VERSION.to_owned(),
            cwd: cwd.display().to_string(),
            model: Some(model.clone()),
        },
    )?);

    // Tools: M0 uses the direct executor (no sandbox in exec mode for now;
    // T4b's Seatbelt executor is wired when the sandbox subcommand is
    // explicitly requested — see `saber debug sandbox`).
    let tool_context = Arc::new(ToolContext::new(session_id.clone(), &cwd, &data_dir)?);
    let mut registry = Registry::new();
    for tool in builtin_tools(Arc::new(DirectExecutor)) {
        registry.register(tool);
    }

    // Prompt assembly (pi-style minimal).
    let tools: Vec<(String, String)> = registry
        .schema_for_prompt()
        .into_iter()
        .map(|(name, desc, _)| (name.to_owned(), desc.to_owned()))
        .collect();
    let identity = "You are saber, a coding agent. Be direct and precise. Read before editing. Run tests to verify changes.";
    let branch = git_branch(&cwd);
    let agents = agents_md(&cwd);
    let system =
        assemble_system_prompt(identity, &cwd, branch.as_deref(), agents.as_deref(), &tools);

    let mut engine = Engine::new(provider, registry, session, tool_context, model);
    if json_mode {
        engine.set_event_sink(|event: Event| {
            if let Ok(json) = serde_json::to_string(&event) {
                println!("{json}");
            }
        });
    }

    let timeout = std::time::Duration::from_secs(timeout_secs);
    let result = tokio::time::timeout(
        timeout,
        engine.run_turn(TurnInput {
            user_message: prompt.clone(),
            system: Some(system),
        }),
    )
    .await;

    match result {
        Ok(Ok((answer, outcome))) => {
            if !json_mode {
                println!("{answer}");
                if let TurnOutcome::ProviderFailure(msg) = &outcome {
                    eprintln!("provider error: {msg}");
                    std::process::exit(1);
                }
                if let TurnOutcome::DoomLoop(msg) = &outcome {
                    eprintln!("doom loop: {msg}");
                    std::process::exit(1);
                }
                if outcome == TurnOutcome::LengthRefusal {
                    eprintln!("response truncated; tool calls refused");
                    std::process::exit(1);
                }
            }
            let usage = engine.usage_total();
            eprintln!(
                "[tokens: in={}, out={}, cost=${:.4}, session: {}]",
                usage.input_tokens, usage.output_tokens, usage.cost_usd, session_id
            );
            Ok(())
        }
        Ok(Err(e)) => {
            eprintln!("engine error: {e}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("turn timed out after {timeout_secs}s");
            std::process::exit(124);
        }
    }
}

fn env_var(names: &[&str]) -> Result<String, std::env::VarError> {
    for name in names {
        if let Ok(value) = std::env::var(name) {
            return Ok(value);
        }
    }
    Err(std::env::VarError::NotPresent)
}

fn deepseek_config() -> Result<(String, String), std::env::VarError> {
    let key = env_var(&["SABER_DEEPSEEK_KEY", "DEEPSEEK_API_KEY"])?;
    let base = env_var(&["SABER_DEEPSEEK_BASE_URL", "DEEPSEEK_BASE_URL"])
        .unwrap_or_else(|_| "https://api.deepseek.com/v1".to_owned());
    Ok((key, base))
}

fn dirs_data_dir(cwd: &std::path::Path) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_owned());
    let dir = PathBuf::from(home).join(".codesaber");
    let _ = std::fs::create_dir_all(&dir);
    let _ = cwd;
    dir
}

fn git_branch(cwd: &std::path::Path) -> Option<String> {
    let head = std::fs::read_to_string(cwd.join(".git/HEAD")).ok()?;
    head.trim()
        .strip_prefix("ref: refs/heads/")
        .map(|s| s.to_owned())
}

/// Collects AGENTS.md/CLAUDE.md along the ancestor chain (root → cwd),
/// concatenating all found files. AGENTS.md takes precedence per directory.
fn agents_md(cwd: &std::path::Path) -> Option<String> {
    let mut chain: Vec<std::path::PathBuf> = Vec::new();
    let mut current = Some(cwd.to_path_buf());
    while let Some(dir) = current {
        chain.push(dir.clone());
        current = dir.parent().map(|p| p.to_path_buf());
    }
    chain.reverse(); // root first

    let mut collected = Vec::new();
    for dir in chain {
        for name in ["AGENTS.md", "CLAUDE.md"] {
            if let Ok(content) = std::fs::read_to_string(dir.join(name)) {
                if !content.trim().is_empty() {
                    collected.push(content);
                    break; // AGENTS.md wins per directory
                }
            }
        }
    }
    if collected.is_empty() {
        None
    } else {
        Some(collected.join("\n\n"))
    }
}

// ============================================================
// saber debug sandbox
// ============================================================

fn run_debug(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match args.first().map(String::as_str) {
        Some("sandbox") => {
            let command = args[1..].to_vec();
            if command.first().map(String::as_str) == Some("--") {
                let cmd = command[1..].join(" ");
                run_sandbox_debug(&cmd)
            } else {
                eprintln!("usage: saber debug sandbox -- <command>");
                std::process::exit(2);
            }
        }
        _ => {
            eprintln!("unknown debug subcommand");
            std::process::exit(2);
        }
    }
}

fn run_sandbox_debug(command: &str) -> Result<(), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let data_dir = dirs_data_dir(&cwd);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let (output, denied) =
        rt.block_on(async { saber_sandbox::debug_run(&cwd, &data_dir, command).await })?;
    println!("{}", output.render());
    if denied {
        eprintln!("\n[saber] sandbox denial detected");
    }
    Ok(())
}

// ============================================================
// saber doctor
// ============================================================

fn run_doctor() -> Result<(), Box<dyn std::error::Error>> {
    println!("saber {} — doctor", env!("CARGO_PKG_VERSION"));
    println!();

    // Config sources
    println!("Configuration:");
    for key in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"] {
        let status = if std::env::var(key).is_ok() {
            "✓ present"
        } else {
            "  not set"
        };
        println!("  {key}: {status}");
    }
    println!();

    // Working directory
    let cwd = std::env::current_dir()?;
    println!("Environment:");
    println!("  cwd: {}", cwd.display());
    if let Some(branch) = git_branch(&cwd) {
        println!("  git branch: {branch}");
    } else {
        println!("  git: (not a repository)");
    }
    if agents_md(&cwd).is_some() {
        println!("  AGENTS.md: found");
    } else {
        println!("  AGENTS.md: not found");
    }
    println!();

    // Data dir
    let data_dir = dirs_data_dir(&cwd);
    println!("Data:");
    println!("  data dir: {}", data_dir.display());
    let sessions = data_dir.join("sessions");
    let session_count = std::fs::read_dir(&sessions)
        .map(|entries| entries.filter_map(|e| e.ok()).count())
        .unwrap_or(0);
    println!("  sessions: {session_count}");
    println!();

    // Sandbox availability (macOS-only)
    #[cfg(target_os = "macos")]
    {
        println!("Sandbox:");
        if std::path::Path::new("/usr/bin/sandbox-exec").exists() {
            println!("  sandbox-exec: ✓ available");
        } else {
            println!("  sandbox-exec: NOT FOUND (expected on macOS)");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        println!("Sandbox: (not available on this platform)");
    }

    Ok(())
}
