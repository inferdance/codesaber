//! Turn/step agent loop (M0-T5): drives model ↔ tool cycles with the three
//! hard defenses from the spec:
//!
//! 1. **length 截断拒执行** — a `FinishReason::Length` response refuses to
//!    execute any tool calls from that step (pi defense: truncated JSON
//!    arguments must never produce half-applied side effects).
//! 2. **doom-loop 防护** — the same tool with identical arguments three
//!    times in a row forces a terminal error (opencode defense).
//! 3. **WAL** — every tool side effect is preceded by a durable
//!    `tool_call` intent in the session log.
//!
//! M0 runs headless: no steering producers, no stop hooks — the seams
//! (steering queue) exist and are exercised by tests.

pub mod session;

/// Engine build identity exposed to frontends for version handshakes.
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

use saber_protocol::{Block, Event, EventMsg, Message, Role, SessionEvent, Usage};
use saber_provider::retry::RetryPolicy;
use saber_provider::retry::stream_with_retry;
use saber_provider::{ChatRequest, FinishReason, Provider, ProviderEvent, ToolSchema};
use saber_tools::{Registry, ToolContext, ToolResult};
use session::SessionLog;
use std::collections::VecDeque;
use std::sync::Arc;

/// Cap before the loop forces a wrap-up (defensive; models rarely hit it).
const MAX_STEPS: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum LoopError {
    #[error("session: {0}")]
    Session(#[from] session::SessionError),
    #[error("provider: {0}")]
    Provider(#[from] saber_provider::ProviderError),
}

/// How a turn ended.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnOutcome {
    /// Model produced a final answer with no pending tool calls.
    Done,
    /// Doom-loop defense tripped: identical tool call repeated.
    DoomLoop(String),
    /// Length-truncated response carried tool calls — refused.
    LengthRefusal,
    /// Step budget exhausted.
    MaxSteps,
    /// Provider failed terminally (all retries exhausted).
    ProviderFailure(String),
}

/// Inputs for one headless turn.
pub struct TurnInput {
    pub user_message: String,
    pub system: Option<String>,
}

/// The agent engine for M0: provider + tools + session + optional event
/// sink (frontends subscribe through the sink; tests use it for asserts).
pub struct Engine {
    pub provider: Arc<dyn Provider>,
    pub registry: Registry,
    pub session: Arc<SessionLog>,
    pub tool_context: Arc<ToolContext>,
    pub model: String,
    event_sink: Option<Box<dyn FnMut(Event) + Send>>,
    steering: VecDeque<String>,
    history: Vec<Message>,
    usage_total: Usage,
}

impl Engine {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        provider: Arc<dyn Provider>,
        registry: Registry,
        session: Arc<SessionLog>,
        tool_context: Arc<ToolContext>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            provider,
            registry,
            session,
            tool_context,
            model: model.into(),
            event_sink: None,
            steering: VecDeque::new(),
            history: Vec::new(),
            usage_total: Usage::default(),
        }
    }

    pub fn set_event_sink(&mut self, sink: impl FnMut(Event) + Send + 'static) {
        self.event_sink = Some(Box::new(sink));
    }

    /// Queues a steering message (delivered before the next model request).
    /// M0 has no interactive producer; tests exercise the seam.
    pub fn steer(&mut self, message: impl Into<String>) {
        self.steering.push_back(message.into());
    }

    pub fn usage_total(&self) -> Usage {
        self.usage_total
    }

    fn emit(&mut self, msg: EventMsg) {
        let seq = self.session.next_seq();
        if let Some(sink) = self.event_sink.as_mut() {
            sink(Event {
                seq,
                session_id: self.session.session_id().to_owned(),
                msg,
            });
        }
    }

    /// Runs one turn to completion and returns the final assistant text.
    pub async fn run_turn(&mut self, input: TurnInput) -> Result<(String, TurnOutcome), LoopError> {
        let turn_id = format!("t-{}", self.session.next_seq());
        self.emit(EventMsg::TurnStarted {
            turn_id: turn_id.clone(),
        });

        let user_message = Message {
            role: Role::User,
            blocks: vec![Block::Text {
                text: input.user_message.clone(),
            }],
        };
        self.session.append(
            SessionEvent::UserMessage {
                message: user_message.clone(),
            },
            false,
        )?;
        self.history.push(user_message);

        let mut last_text = String::new();
        let mut outcome = TurnOutcome::Done;
        let mut doom_tracker: Option<(String, serde_json::Value, u32)> = None;

        for step in 0..MAX_STEPS {
            let step_id = format!("{turn_id}-s{step}");
            self.emit(EventMsg::StepStarted {
                turn_id: turn_id.clone(),
                step_id: step_id.clone(),
            });

            while let Some(message) = self.steering.pop_front() {
                let steer = Message {
                    role: Role::User,
                    blocks: vec![Block::Text { text: message }],
                };
                let _ = self.session.append(
                    SessionEvent::UserMessage {
                        message: steer.clone(),
                    },
                    false,
                );
                self.history.push(steer);
            }

            let request = ChatRequest {
                model: self.model.clone(),
                system: input.system.clone(),
                messages: self.history.clone(),
                tools: self.tools_schema(),
                ..ChatRequest::default()
            };

            let stream =
                stream_with_retry(self.provider.clone(), request, &RetryPolicy::default()).await;

            let mut text = String::new();
            let mut thinking = String::new();
            let mut tool_calls: Vec<(String, String, serde_json::Value)> = Vec::new();
            // Per-call-id accumulation: a single response may carry many
            // tool calls, and none of them may be silently dropped.
            let mut active_calls: std::collections::BTreeMap<String, (String, String)> =
                std::collections::BTreeMap::new();
            let mut call_order: Vec<String> = Vec::new();
            let mut finish_reason = FinishReason::Stop;
            let mut step_usage = Usage::default();

            use futures::StreamExt;
            let mut stream = stream;
            let mut provider_error: Option<String> = None;
            while let Some(event) = stream.next().await {
                match event {
                    ProviderEvent::TextDelta { text_delta } => {
                        text.push_str(&text_delta);
                        self.emit(EventMsg::AssistantDelta {
                            turn_id: turn_id.clone(),
                            step_id: step_id.clone(),
                            delta: saber_protocol::AssistantDelta::Text { text_delta },
                        });
                    }
                    ProviderEvent::ThinkingDelta { text_delta, .. } => {
                        thinking.push_str(&text_delta);
                    }
                    ProviderEvent::ToolCallStart { id, name } => {
                        if !active_calls.contains_key(&id) {
                            call_order.push(id.clone());
                        }
                        active_calls
                            .entry(id)
                            .or_insert_with(|| (name, String::new()));
                    }
                    ProviderEvent::ToolCallDelta {
                        id,
                        arguments_delta,
                    } => {
                        if let Some((_, args)) = active_calls.get_mut(&id) {
                            args.push_str(&arguments_delta);
                        }
                    }
                    ProviderEvent::Finish { reason, usage } => {
                        finish_reason = reason;
                        step_usage = usage;
                    }
                    ProviderEvent::Error { message, retryable } => {
                        provider_error = Some(format!("provider error ({retryable:?}): {message}"));
                        break;
                    }
                }
            }

            if let Some(message) = provider_error {
                self.emit(EventMsg::Error {
                    message: message.clone(),
                    recoverable: false,
                });
                self.emit(EventMsg::TurnComplete {
                    turn_id: turn_id.clone(),
                    reason: saber_protocol::TurnCompleteReason::AbortedByUser,
                });
                return Ok((text, TurnOutcome::ProviderFailure(message)));
            }

            for id in call_order {
                if let Some((name, args)) = active_calls.remove(&id) {
                    let parsed = serde_json::from_str(&args).unwrap_or(serde_json::Value::Null);
                    tool_calls.push((id, name, parsed));
                }
            }

            self.usage_total.input_tokens += step_usage.input_tokens;
            self.usage_total.output_tokens += step_usage.output_tokens;
            self.usage_total.cost_usd += step_usage.cost_usd;
            self.emit(EventMsg::StepFinished {
                turn_id: turn_id.clone(),
                step_id: step_id.clone(),
                usage: step_usage,
            });

            let mut blocks = Vec::new();
            if !thinking.is_empty() {
                blocks.push(Block::Thinking {
                    text: thinking,
                    signature: None,
                });
            }
            if !text.is_empty() {
                blocks.push(Block::Text { text: text.clone() });
            }
            for (id, name, arguments) in &tool_calls {
                blocks.push(Block::ToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    arguments: arguments.clone(),
                });
            }
            if !blocks.is_empty() {
                let message = Message {
                    role: Role::Assistant,
                    blocks,
                };
                self.session.append(
                    SessionEvent::AssistantMessage {
                        message: message.clone(),
                        usage: step_usage,
                    },
                    false,
                )?;
                self.history.push(message);
            }

            if tool_calls.is_empty() {
                last_text = text;
                outcome = TurnOutcome::Done;
                break;
            }

            // Defense 1: length truncation refuses tool execution.
            if finish_reason == FinishReason::Length {
                self.emit(EventMsg::Error {
                    message: "response truncated at token limit; refusing to execute \
                              possibly-malformed tool calls"
                        .into(),
                    recoverable: true,
                });
                self.emit(EventMsg::TurnComplete {
                    turn_id: turn_id.clone(),
                    reason: saber_protocol::TurnCompleteReason::AbortedByUser,
                });
                return Ok((text, TurnOutcome::LengthRefusal));
            }

            last_text = text;

            // Defense 2: doom-loop detection — any tool call identical to
            // the previous step's first call counts toward the streak.
            let doom_key = {
                let (name, args) = (&tool_calls[0].1, &tool_calls[0].2);
                (name.clone(), args.clone())
            };
            let doomed = match doom_tracker.as_ref() {
                Some((prev_name, prev_args, count))
                    if *prev_name == doom_key.0 && *prev_args == doom_key.1 =>
                {
                    let new_count = count + 1;
                    doom_tracker = Some((doom_key.0.clone(), doom_key.1.clone(), new_count));
                    new_count >= 3
                }
                _ => {
                    doom_tracker = Some((doom_key.0.clone(), doom_key.1.clone(), 1));
                    false
                }
            };
            if doomed {
                let message = format!(
                    "tool `{}` called with identical arguments 3 times in a row \
                     (doom-loop defense); turn aborted",
                    doom_key.0
                );
                self.emit(EventMsg::Error {
                    message: message.clone(),
                    recoverable: false,
                });
                self.emit(EventMsg::TurnComplete {
                    turn_id: turn_id.clone(),
                    reason: saber_protocol::TurnCompleteReason::AbortedByUser,
                });
                return Ok((last_text, TurnOutcome::DoomLoop(message)));
            }

            let results = self.execute_tools(&turn_id, &step_id, tool_calls).await;

            let mut result_blocks = Vec::new();
            for (call_id, result) in results {
                result_blocks.push(Block::ToolResult {
                    call_id,
                    content: result.content,
                    is_error: result.is_error,
                });
            }
            if !result_blocks.is_empty() {
                let message = Message {
                    role: Role::User,
                    blocks: result_blocks,
                };
                self.session.append(
                    SessionEvent::UserMessage {
                        message: message.clone(),
                    },
                    false,
                )?;
                self.history.push(message);
            }

            if step + 1 == MAX_STEPS {
                outcome = TurnOutcome::MaxSteps;
            }
        }

        self.emit(EventMsg::TokenCount {
            context_tokens: self.usage_total.input_tokens + self.usage_total.output_tokens,
            context_window: 0,
        });
        self.emit(EventMsg::TurnComplete {
            turn_id,
            reason: match outcome {
                TurnOutcome::Done => saber_protocol::TurnCompleteReason::Done,
                TurnOutcome::MaxSteps => saber_protocol::TurnCompleteReason::MaxStepsReached,
                _ => saber_protocol::TurnCompleteReason::AbortedByUser,
            },
        });
        Ok((last_text, outcome))
    }

    async fn execute_tools(
        &mut self,
        turn_id: &str,
        step_id: &str,
        calls: Vec<(String, String, serde_json::Value)>,
    ) -> Vec<(String, ToolResult)> {
        let mut results = Vec::with_capacity(calls.len());
        for (call_id, name, arguments) in calls {
            // WAL intent: durable BEFORE the side effect. A failed write
            // (ENOSPC/EIO/sync) MUST block execution — the whole point of
            // the WAL is that every side effect has a recoverable intent.
            if let Err(e) = self.session.append(
                SessionEvent::ToolCall {
                    call_id: call_id.clone(),
                    name: name.clone(),
                    arguments: arguments.clone(),
                },
                true,
            ) {
                results.push((
                    call_id,
                    ToolResult::error(format!(
                        "WAL intent write failed; execution blocked for safety: {e}"
                    )),
                ));
                continue;
            }
            self.emit(EventMsg::ToolStarted {
                turn_id: turn_id.to_owned(),
                step_id: step_id.to_owned(),
                call_id: call_id.clone(),
                name: name.clone(),
            });
            let result = self
                .registry
                .execute_batch(self.tool_context.clone(), vec![(name, arguments)])
                .await
                .pop()
                .unwrap_or(ToolResult::error("no result".into()));
            if let Err(e) = self.session.append(
                SessionEvent::ToolResult {
                    call_id: call_id.clone(),
                    content: result.content.clone(),
                    is_error: result.is_error,
                },
                false,
            ) {
                // Result write failure is surfaced but does not block the
                // response — the side effect already happened.
                self.emit(EventMsg::Error {
                    message: format!("session result write failed: {e}"),
                    recoverable: true,
                });
            }
            self.emit(EventMsg::ToolCompleted {
                call_id: call_id.clone(),
                is_error: result.is_error,
                error_detail: result
                    .is_error
                    .then(|| result.content.chars().take(500).collect::<String>()),
            });
            results.push((call_id, result));
        }
        results
    }

    fn tools_schema(&self) -> Vec<ToolSchema> {
        self.registry
            .schema_for_prompt()
            .into_iter()
            .map(|(name, description, parameters)| ToolSchema {
                name: name.to_owned(),
                description: description.to_owned(),
                parameters: parameters.clone(),
            })
            .collect()
    }
}

/// Prompt assembly v1: static identity, environment block, tool section,
/// and AGENTS.md (pi-style minimalism — tool rules live in tool
/// descriptions, the harness prompt stays tiny).
pub fn assemble_system_prompt(
    identity: &str,
    cwd: &std::path::Path,
    git_branch: Option<&str>,
    agents_md: Option<&str>,
    tools: &[(String, String)],
) -> String {
    let mut prompt = String::new();
    prompt.push_str(identity);
    prompt.push_str("\n\n# Environment\n");
    prompt.push_str(&format!("- Working directory: {}\n", cwd.display()));
    if let Some(branch) = git_branch {
        prompt.push_str(&format!("- Git branch: {branch}\n"));
    }
    prompt.push_str(&format!(
        "- Platform: {}\n- Date: {}\n",
        std::env::consts::OS,
        today()
    ));
    if let Some(agents) = agents_md {
        prompt.push_str("\n# Project instructions (AGENTS.md)\n");
        prompt.push_str(agents);
        prompt.push('\n');
    }
    if !tools.is_empty() {
        prompt.push_str("\n# Available tools\n");
        for (name, description) in tools {
            prompt.push_str(&format!("- {name}: {description}\n"));
        }
    }
    prompt
}

/// std-only date rendering (no chrono dependency for one string).
fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_renders_civil_format() {
        let date = today();
        let parts: Vec<&str> = date.split('-').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].len(), 4);
        let month: u32 = parts[1].parse().unwrap_or(0);
        assert((1..=12).contains(&month));
    }

    fn assert(b: bool) {
        assert!(b);
    }

    #[test]
    fn system_prompt_has_all_sections() {
        let tools = vec![("bash".to_owned(), "runs commands".to_owned())];
        let prompt = assemble_system_prompt(
            "You are saber.",
            std::path::Path::new("/tmp/ws"),
            Some("main"),
            Some("be terse"),
            &tools,
        );
        assert(prompt.contains("You are saber."));
        assert(prompt.contains("/tmp/ws"));
        assert(prompt.contains("Git branch: main"));
        assert(prompt.contains("be terse"));
        assert(prompt.contains("bash: runs commands"));
    }
}
