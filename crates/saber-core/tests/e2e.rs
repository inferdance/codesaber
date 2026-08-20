//! Offline E2E (T5 acceptance): a MockProvider scripts a full coding task
//! on a real temporary git repository — read the file, edit it, run the
//! test, deliver the final answer. Asserts the complete event sequence and
//! the durable session log.
//!
//! Fault matrix companions: length-refusal, doom-loop, steering, and
//! crash-recovery boundaries are covered in `fault_matrix.rs`.

use saber_core::session::{SessionError, SessionLog, recover};
use saber_core::{Engine, TurnInput, TurnOutcome};
use saber_protocol::{SessionEvent, Usage};
use saber_provider::{
    ChatRequest, FinishReason, Provider, ProviderError, ProviderEvent, ProviderStream,
};
use saber_tools::bash::DirectExecutor;
use saber_tools::{Registry, ToolContext, builtin_tools};
use std::path::Path;
use std::sync::Arc;

/// Scripted provider: each `stream()` call pops the next scripted step
/// (per-instance counter — parallel tests stay isolated).
struct ScriptedProvider {
    steps: Vec<Vec<ProviderEvent>>,
    next: std::sync::atomic::AtomicUsize,
}

impl ScriptedProvider {
    fn new(steps: Vec<Vec<ProviderEvent>>) -> Self {
        Self {
            steps,
            next: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

impl Provider for ScriptedProvider {
    fn name(&self) -> &str {
        "scripted"
    }

    fn stream(
        &self,
        _request: ChatRequest,
    ) -> futures::future::BoxFuture<'static, Result<ProviderStream, ProviderError>> {
        let index = self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let events = self.steps.get(index).cloned().unwrap_or_else(|| {
            vec![ProviderEvent::Finish {
                reason: FinishReason::Stop,
                usage: Usage::default(),
            }]
        });
        Box::pin(futures::future::ready(Ok(
            Box::pin(futures::stream::iter(events)) as saber_provider::ProviderStream,
        )))
    }
}

fn tool_call(id: &str, name: &str, _args: serde_json::Value) -> ProviderEvent {
    ProviderEvent::ToolCallStart {
        id: id.into(),
        name: name.into(),
    }
}

fn args_delta(delta: &str) -> ProviderEvent {
    ProviderEvent::ToolCallDelta {
        id: "call-1".into(),
        arguments_delta: delta.into(),
    }
}

fn finish_tool_calls() -> ProviderEvent {
    ProviderEvent::Finish {
        reason: FinishReason::ToolCalls,
        usage: Usage {
            input_tokens: 100,
            output_tokens: 25,
            cost_usd: 0.001,
            ..Usage::default()
        },
    }
}

fn finish_stop() -> ProviderEvent {
    ProviderEvent::Finish {
        reason: FinishReason::Stop,
        usage: Usage {
            input_tokens: 120,
            output_tokens: 30,
            cost_usd: 0.002,
            ..Usage::default()
        },
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    engine_events: std::sync::Arc<std::sync::Mutex<Vec<saber_protocol::EventMsg>>>,
}

async fn engine_with(steps: Vec<Vec<ProviderEvent>>) -> (Fixture, Engine) {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    // A real workspace with a runnable test.
    std::fs::write(
        temp.path().join("greet.js"),
        "function greet(name) {\n  return 'hello ' + name;\n}\nmodule.exports = { greet };\n",
    )
    .unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(
        temp.path().join("greet.test.js"),
        "const { greet } = require('./greet');\nconst assert = require('assert');\nassert.strictEqual(greet('saber'), 'hello saber!');\nconsole.log('TEST-OK');\n",
    )
    .unwrap_or_else(|e| panic!("{e}"));

    let session = Arc::new(
        SessionLog::create(
            &temp.path().join(".saber").join("sessions"),
            "e2e-1",
            SessionEvent::SessionMeta {
                protocol_version: "0.1.0".into(),
                engine_version: "0.1.0".into(),
                cwd: temp.path().display().to_string(),
                model: Some("scripted".into()),
            },
        )
        .unwrap_or_else(|e| panic!("{e}")),
    );
    let tool_context = Arc::new(
        ToolContext::new("e2e-1", temp.path(), &temp.path().join(".saber"))
            .unwrap_or_else(|e| panic!("{e}")),
    );
    let mut registry = Registry::new();
    for tool in builtin_tools(Arc::new(DirectExecutor)) {
        registry.register(tool);
    }

    let engine_events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink_events = engine_events.clone();
    let mut engine = Engine::new(
        Arc::new(ScriptedProvider::new(steps)),
        registry,
        session,
        tool_context,
        "scripted-model",
    );
    engine.set_event_sink(move |event| {
        if let Ok(mut events) = sink_events.lock() {
            events.push(event.msg);
        }
    });
    (
        Fixture {
            _temp: temp,
            engine_events,
        },
        engine,
    )
}

#[tokio::test]
async fn full_read_edit_test_final_flow() -> Result<(), Box<dyn std::error::Error>> {
    let (fixture, mut engine) = engine_with(vec![
        // Step 1: read the source file.
        vec![
            tool_call("call-1", "read", serde_json::json!({"path": "greet.js"})),
            args_delta("{\"path\": \"greet.js\"}"),
            finish_tool_calls(),
        ],
        // Step 2: edit it (add an exclamation).
        vec![
            tool_call("call-1", "edit", serde_json::json!({})),
            args_delta("{\"path\": \"greet.js\", \"old_string\": \"return 'hello ' + name;\", \"new_string\": \"return 'hello ' + name + '!';\"}"),
            finish_tool_calls(),
        ],
        // Step 3: run the test (must actually pass after the edit).
        vec![
            tool_call("call-1", "bash", serde_json::json!({})),
            args_delta("{\"command\": \"node greet.test.js\"}"),
            finish_tool_calls(),
        ],
        // Step 4: final answer.
        vec![
            ProviderEvent::TextDelta {
                text_delta: "Done: greet now appends '!' and the test passes.".into(),
            },
            finish_stop(),
        ],
    ])
    .await;

    let (answer, outcome) = engine
        .run_turn(TurnInput {
            user_message: "Make greet more enthusiastic and verify.".into(),
            system: Some("be terse".into()),
        })
        .await?;
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(answer.contains("the test passes"), "{answer}");

    // Workspace mutated as intended.
    let source = std::fs::read_to_string(
        Path::new(engine.session.path())
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
            .unwrap_or_default()
            .join("greet.js"),
    )
    .unwrap_or_default();
    assert!(
        source.contains("name + '!'"),
        "edit must land on disk: {source}"
    );

    // Durable log: meta + user + 4×(assistant + intent + result) + final.
    let recovered = recover(engine.session.path())?;
    assert!(recovered.unfinished_tool_calls.is_empty());
    let tool_intents = recovered
        .events
        .iter()
        .filter(|e| matches!(e.event, SessionEvent::ToolCall { .. }))
        .count();
    assert_eq!(tool_intents, 3);

    // Event sequence includes the full lifecycle.
    let events = fixture
        .engine_events
        .lock()
        .map(|e| e.clone())
        .unwrap_or_default();
    let has = |predicate: &dyn Fn(&saber_protocol::EventMsg) -> bool| events.iter().any(predicate);
    assert!(has(&|e| matches!(
        e,
        saber_protocol::EventMsg::TurnStarted { .. }
    )));
    assert!(has(
        &|e| matches!(e, saber_protocol::EventMsg::ToolStarted { name, .. } if name == "read")
    ));
    assert!(has(
        &|e| matches!(e, saber_protocol::EventMsg::ToolStarted { name, .. } if name == "edit")
    ));
    assert!(has(
        &|e| matches!(e, saber_protocol::EventMsg::ToolStarted { name, .. } if name == "bash")
    ));
    assert!(has(
        &|e| matches!(e, saber_protocol::EventMsg::StepFinished { usage, .. } if usage.cost_usd > 0.0)
    ));
    assert!(has(
        &|e| matches!(e, saber_protocol::EventMsg::TurnComplete { reason, .. } if matches!(reason, saber_protocol::TurnCompleteReason::Done))
    ));

    // Usage accounting accumulated across steps.
    let usage = engine.usage_total();
    assert_eq!(usage.input_tokens, 420);
    Ok(())
}

#[tokio::test]
async fn provider_failure_terminates_turn_cleanly() {
    let (fixture, mut engine) = engine_with(vec![vec![ProviderEvent::Error {
        message: "rate limited".into(),
        retryable: saber_provider::RetryKind::Fatal,
    }]])
    .await;
    let (_text, outcome) = engine
        .run_turn(TurnInput {
            user_message: "hi".into(),
            system: None,
        })
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(matches!(outcome, TurnOutcome::ProviderFailure(m) if m.contains("provider error")));
    let events = fixture
        .engine_events
        .lock()
        .map(|e| e.clone())
        .unwrap_or_default();
    assert!(
        events
            .iter()
            .any(|e| matches!(e, saber_protocol::EventMsg::Error { .. }))
    );
}

#[tokio::test]
async fn session_log_torn_tail_recovery_in_e2e_layout() -> Result<(), SessionError> {
    // The dedicated session tests cover recovery; this companion verifies
    // the E2E directory layout keeps it working end-to-end.
    let temp = tempfile::tempdir().map_err(SessionError::Io)?;
    let sessions = temp.path().join(".saber").join("sessions");
    let log = SessionLog::create(
        &sessions,
        "e2e-recover",
        SessionEvent::SessionMeta {
            protocol_version: "0.1.0".into(),
            engine_version: "0.1.0".into(),
            cwd: "/tmp".into(),
            model: None,
        },
    )?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().append(true).open(log.path())?;
    file.write_all(b"{\"torn")?;
    let recovered = recover(log.path())?;
    assert_eq!(recovered.events.len(), 1);
    Ok(())
}
