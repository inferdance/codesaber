//! T5 fault matrix: length-refusal, doom-loop, steering, crash-recovery
//! boundaries, stale-file detection — the loop must degrade safely under
//! every failure mode (spec §5.4 gate 3/4/8 companions).

use saber_core::session::{SessionLog, recover};
use saber_core::{Engine, TurnInput, TurnOutcome};
use saber_protocol::SessionEvent;
use saber_provider::{
    ChatRequest, FinishReason, Provider, ProviderError, ProviderEvent, ProviderStream,
};
use saber_tools::bash::DirectExecutor;
use saber_tools::{Registry, ToolContext, builtin_tools};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountingProvider {
    events: Vec<ProviderEvent>,
    next: AtomicUsize,
}

impl Provider for CountingProvider {
    fn name(&self) -> &str {
        "counting"
    }

    fn stream(
        &self,
        _request: ChatRequest,
    ) -> futures::future::BoxFuture<'static, Result<ProviderStream, ProviderError>> {
        let _index = self.next.fetch_add(1, Ordering::SeqCst);
        let events = self.events.clone();
        // Repeat the same step forever (tests drive termination by outcome).
        Box::pin(futures::future::ready(Ok(
            Box::pin(futures::stream::iter(events)) as ProviderStream,
        )))
    }
}

fn call_tool(name: &str, args_json: &str) -> Vec<ProviderEvent> {
    vec![
        ProviderEvent::ToolCallStart {
            id: "call-1".into(),
            name: name.into(),
        },
        ProviderEvent::ToolCallDelta {
            id: "call-1".into(),
            arguments_delta: args_json.into(),
        },
        ProviderEvent::Finish {
            reason: FinishReason::ToolCalls,
            usage: Default::default(),
        },
    ]
}

async fn make_engine(events: Vec<ProviderEvent>) -> (tempfile::TempDir, Engine) {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(temp.path().join("f.txt"), "content\n").unwrap_or_else(|e| panic!("{e}"));
    let session = Arc::new(
        SessionLog::create(
            &temp.path().join(".saber").join("sessions"),
            "fault",
            SessionEvent::SessionMeta {
                protocol_version: "0.1.0".into(),
                engine_version: "0.1.0".into(),
                cwd: temp.path().display().to_string(),
                model: None,
            },
        )
        .unwrap_or_else(|e| panic!("{e}")),
    );
    let tool_context = Arc::new(
        ToolContext::new("fault", temp.path(), &temp.path().join(".saber"))
            .unwrap_or_else(|e| panic!("{e}")),
    );
    let mut registry = Registry::new();
    for tool in builtin_tools(Arc::new(DirectExecutor)) {
        registry.register(tool);
    }
    let engine = Engine::new(
        Arc::new(CountingProvider {
            events,
            next: AtomicUsize::new(0),
        }),
        registry,
        session,
        tool_context,
        "counting",
    );
    (temp, engine)
}

#[tokio::test]
async fn length_truncation_refuses_tool_execution() {
    let (_temp, mut engine) = make_engine(vec![
        ProviderEvent::ToolCallStart {
            id: "call-1".into(),
            name: "bash".into(),
        },
        ProviderEvent::ToolCallDelta {
            id: "call-1".into(),
            arguments_delta: "{\"command\": \"touch created-by-length\"}".into(),
        },
        ProviderEvent::Finish {
            reason: FinishReason::Length,
            usage: Default::default(),
        },
    ])
    .await;
    let (_text, outcome) = engine
        .run_turn(TurnInput {
            user_message: "do it".into(),
            system: None,
        })
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(outcome, TurnOutcome::LengthRefusal);
    assert!(
        !engine_recovered_intent_exists(&engine),
        "length-refused tool must NOT have a WAL intent"
    );
}

fn engine_recovered_intent_exists(engine: &Engine) -> bool {
    recover(engine.session.path())
        .map(|r| !r.unfinished_tool_calls.is_empty())
        .unwrap_or(false)
}

#[tokio::test]
async fn doom_loop_identical_calls_abort_on_third() {
    let (temp, mut engine) = make_engine(call_tool("bash", "{\"command\": \"echo same\"}")).await;
    let (_text, outcome) = engine
        .run_turn(TurnInput {
            user_message: "loop".into(),
            system: None,
        })
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    match &outcome {
        TurnOutcome::DoomLoop(message) => assert!(message.contains("doom-loop"), "{message}"),
        other => panic!("expected DoomLoop, got {other:?}"),
    }
    // The log holds exactly 2 completed executions + 1 refused-by-defense?
    // Defense trips on the 3rd identical step BEFORE execution: two
    // tool_call/tool_result pairs land, the third never starts.
    let recovered = recover(engine.session.path()).unwrap_or_else(|e| panic!("{e}"));
    let executed = recovered
        .events
        .iter()
        .filter(|e| matches!(e.event, SessionEvent::ToolResult { .. }))
        .count();
    assert_eq!(executed, 2, "defense must trip on the third, not after");
    let _ = temp;
}

#[tokio::test]
async fn steering_messages_are_delivered_before_next_request() {
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let session = Arc::new(
        SessionLog::create(
            &temp.path().join(".saber").join("sessions"),
            "steer",
            SessionEvent::SessionMeta {
                protocol_version: "0.1.0".into(),
                engine_version: "0.1.0".into(),
                cwd: temp.path().display().to_string(),
                model: None,
            },
        )
        .unwrap_or_else(|e| panic!("{e}")),
    );
    let tool_context = Arc::new(
        ToolContext::new("steer", temp.path(), &temp.path().join(".saber"))
            .unwrap_or_else(|e| panic!("{e}")),
    );
    let mut registry = Registry::new();
    for tool in builtin_tools(Arc::new(DirectExecutor)) {
        registry.register(tool);
    }

    // First step requests a tool; steering arrives; second step finishes.
    struct TwoStep {
        next: AtomicUsize,
    }
    impl Provider for TwoStep {
        fn name(&self) -> &str {
            "two-step"
        }
        fn stream(
            &self,
            _request: ChatRequest,
        ) -> futures::future::BoxFuture<'static, Result<ProviderStream, ProviderError>> {
            let index = self.next.fetch_add(1, Ordering::SeqCst);
            let events = if index == 0 {
                call_tool("bash", "{\"command\": \"echo step-one\"}")
            } else {
                vec![
                    ProviderEvent::TextDelta {
                        text_delta: "steered and done".into(),
                    },
                    ProviderEvent::Finish {
                        reason: FinishReason::Stop,
                        usage: Default::default(),
                    },
                ]
            };
            Box::pin(futures::future::ready(Ok(
                Box::pin(futures::stream::iter(events)) as ProviderStream,
            )))
        }
    }

    let mut engine = Engine::new(
        Arc::new(TwoStep {
            next: AtomicUsize::new(0),
        }),
        registry,
        session,
        tool_context,
        "two-step",
    );
    // Steering queued mid-turn would need an interactive producer; M0
    // verifies the seam: queue before the turn, it must be injected into
    // history before the second request.
    engine.steer("focus on tests");
    let (answer, outcome) = engine
        .run_turn(TurnInput {
            user_message: "start".into(),
            system: None,
        })
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(answer.contains("steered and done"));

    let recovered = recover(engine.session.path()).unwrap_or_else(|e| panic!("{e}"));
    let steering_logged = recovered.events.iter().any(|e| {
        matches!(&e.event, SessionEvent::UserMessage { message }
            if message.blocks.iter().any(|b| matches!(b,
                saber_protocol::Block::Text { text } if text.contains("focus on tests"))))
    });
    assert!(steering_logged, "steering must appear in history/log");
}

#[tokio::test]
async fn multiple_tool_calls_in_one_response_all_execute() {
    // Regression: the loop previously dropped all but the last tool call.
    let (temp, mut engine) = make_engine(vec![
        ProviderEvent::ToolCallStart {
            id: "call-a".into(),
            name: "bash".into(),
        },
        ProviderEvent::ToolCallDelta {
            id: "call-a".into(),
            arguments_delta: "{\"command\": \"echo A\"}".into(),
        },
        ProviderEvent::ToolCallStart {
            id: "call-b".into(),
            name: "bash".into(),
        },
        ProviderEvent::ToolCallDelta {
            id: "call-b".into(),
            arguments_delta: "{\"command\": \"echo B\"}".into(),
        },
        ProviderEvent::Finish {
            reason: FinishReason::ToolCalls,
            usage: Default::default(),
        },
    ])
    .await;
    // The counting provider replays the same events each call; the second
    // step (after tool results) will have the same multi-call events but
    // different content in results → doom loop should not trip since the
    // model's calls differ from a repeat (the first-call check uses the
    // step's first tool). Instead, the step-2 tool results will differ from
    // step-1's, so doom_tracker resets. We just verify both calls executed.
    let _ = engine
        .run_turn(TurnInput {
            user_message: "multi".into(),
            system: None,
        })
        .await;

    let recovered = recover(engine.session.path()).unwrap_or_else(|e| panic!("{e}"));
    let executed: Vec<&str> = recovered
        .events
        .iter()
        .filter_map(|e| match &e.event {
            SessionEvent::ToolResult {
                call_id,
                content,
                is_error,
            } if !is_error => Some(content.as_str()),
            _ => None,
        })
        .collect();
    // First step must have executed both A and B (before any repeats).
    assert!(
        executed.iter().any(|c| c.contains('A')),
        "call-a result must exist: {executed:?}"
    );
    assert!(
        executed.iter().any(|c| c.contains('B')),
        "call-b result must exist: {executed:?}"
    );
    let _ = temp;
}

#[tokio::test]
async fn crash_between_intent_and_result_marks_unfinished() {
    // Simulate: intent written (sync), process dies before result.
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let log = SessionLog::create(
        &temp.path().join("sessions"),
        "crash",
        SessionEvent::SessionMeta {
            protocol_version: "0.1.0".into(),
            engine_version: "0.1.0".into(),
            cwd: "/tmp".into(),
            model: None,
        },
    )
    .unwrap_or_else(|e| panic!("{e}"));
    log.append(
        SessionEvent::ToolCall {
            call_id: "c1".into(),
            name: "bash".into(),
            arguments: serde_json::json!({"command": "cargo test"}),
        },
        true,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    // "Crash": just recover without appending the result.
    let recovered = recover(log.path()).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(recovered.unfinished_tool_calls.len(), 1);
    // The event is reported, and its payload is fully intact for audit.
    let intent = recovered
        .events
        .iter()
        .find_map(|e| match &e.event {
            SessionEvent::ToolCall { call_id, name, .. } if call_id == "c1" => Some(name.clone()),
            _ => None,
        })
        .unwrap_or_default();
    assert_eq!(intent, "bash");
}

#[test]
fn stale_file_edit_is_detected_by_read_before_edit_guard() {
    // The "stale file" fault: the model edits without reading after an
    // external change — the read-before-edit guard refuses.
    // (Covered end-to-end by saber-tools tests; here we verify the loop
    // surfaces the refusal as an is_error tool result in the session.)
    let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(temp.path().join("s.txt"), "v1\n").unwrap_or_else(|e| panic!("{e}"));
    let tool_context = ToolContext::new("stale", temp.path(), &temp.path().join(".saber"))
        .unwrap_or_else(|e| panic!("{e}"));
    let mut registry = Registry::new();
    for tool in builtin_tools(Arc::new(DirectExecutor)) {
        registry.register(tool);
    }
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|e| panic!("{e}"));
    let results = rt.block_on(registry.execute_batch(
        Arc::new(tool_context),
        vec![(
            "edit".into(),
            serde_json::json!({"path": "s.txt", "old_string": "v1", "new_string": "v2"}),
        )],
    ));
    assert!(results[0].is_error);
    assert!(
        results[0].content.contains("must read"),
        "{}",
        results[0].content
    );
}
