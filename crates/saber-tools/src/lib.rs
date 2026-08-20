//! Tool system (M0-T4): tool contracts, registry, scheduler, and the six
//! built-in tools (bash / read / write / edit / grep / glob).
//!
//! Contract highlights (spec §3.2 + §3.7 v3):
//! - [`ToolDefinition`] declares a concurrency class and schemars-derived
//!   JSON-Schema parameters; richer optional fields (render, permission
//!   rules) join when a real consumer exists (admission question 3).
//! - The scheduler runs read-class tools concurrently and exclusive tools
//! - serially in call order; results keep call order; failures become
//!   `is_error` results and never abort the batch.
//! - Every tool consults the **unified path policy** (`path_policy`) for
//!   read denials and write allowances — per-tool drift is impossible.
//! - The execution context carries session id, workspace, data dir, path
//!   policy, read tracking and per-file locks (the v3 execution-context
//!   seam: jobs / MCP / subagent tools never need to bypass the base).

pub mod bash;
pub mod edit;
pub mod glob;
pub mod grep;
pub mod path_policy;
pub mod read;
pub mod truncation;
pub mod write;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Concurrency class for scheduler batching.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Concurrency {
    /// Safe to run alongside anything (read-only).
    ReadOnly,
    /// Serialized after all read-only work in the batch, in call order.
    Exclusive,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub content: String,
    pub is_error: bool,
}

impl ToolResult {
    pub fn ok(content: String) -> Self {
        Self {
            content,
            is_error: false,
        }
    }

    pub fn error(content: String) -> Self {
        Self {
            content,
            is_error: true,
        }
    }
}

pub type ExecuteFn = Arc<
    dyn Fn(Arc<ToolContext>, serde_json::Value) -> BoxFuture<'static, ToolResult> + Send + Sync,
>;

type SharedToolFuture = Shared<BoxFuture<'static, ToolResult>>;

#[derive(Clone)]
pub struct ToolDefinition {
    pub name: &'static str,
    pub description: String,
    pub parameters: serde_json::Value,
    pub concurrency: Concurrency,
    pub execute: ExecuteFn,
}

impl std::fmt::Debug for ToolDefinition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolDefinition")
            .field("name", &self.name)
            .field("concurrency", &self.concurrency)
            .finish_non_exhaustive()
    }
}

/// Shared per-session tool execution context.
pub struct ToolContext {
    pub session_id: String,
    pub cwd: PathBuf,
    pub data_dir: PathBuf,
    pub policy: path_policy::PathPolicy,
    read_files: Mutex<HashSet<PathBuf>>,
    file_locks: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl ToolContext {
    pub fn new(
        session_id: impl Into<String>,
        cwd: &Path,
        data_dir: &Path,
    ) -> Result<Self, path_policy::PathDenied> {
        Ok(Self {
            session_id: session_id.into(),
            cwd: cwd.to_owned(),
            data_dir: data_dir.to_owned(),
            policy: path_policy::PathPolicy::new(cwd, data_dir)?,
            read_files: Mutex::new(HashSet::new()),
            file_locks: Mutex::new(HashMap::new()),
        })
    }

    pub fn mark_read(&self, resolved: &Path) {
        if let Ok(mut files) = self.read_files.lock() {
            files.insert(resolved.to_owned());
        }
    }

    pub fn has_been_read(&self, resolved: &Path) -> bool {
        self.read_files
            .lock()
            .map(|files| files.contains(resolved))
            .unwrap_or(false)
    }

    /// Per-file async lock guarding concurrent edits/writes to one target.
    pub async fn file_lock(&self, resolved: &Path) -> FileLockGuard {
        let lock = {
            let mut locks = self.file_locks.lock().unwrap_or_else(|e| e.into_inner());
            locks
                .entry(resolved.to_owned())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        FileLockGuard {
            _guard: lock.lock_owned().await,
        }
    }
}

pub struct FileLockGuard {
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

#[derive(Default)]
pub struct Registry {
    tools: Vec<ToolDefinition>,
    index: HashMap<&'static str, usize>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a tool; first registration of a name wins (protected
    /// against external tools shadowing built-ins).
    pub fn register(&mut self, definition: ToolDefinition) {
        if self.index.contains_key(definition.name) {
            return;
        }
        self.index.insert(definition.name, self.tools.len());
        self.tools.push(definition);
    }

    pub fn get(&self, name: &str) -> Option<&ToolDefinition> {
        self.index.get(name).map(|&i| &self.tools[i])
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    /// Ordered (name, description, parameters) triples for prompt assembly
    /// (T5) — registration order.
    pub fn schema_for_prompt(&self) -> Vec<(&'static str, &str, &serde_json::Value)> {
        self.tools
            .iter()
            .map(|t| (t.name, t.description.as_str(), &t.parameters))
            .collect()
    }

    /// Executes a batch of tool calls. Read-only tools run concurrently;
    /// exclusive tools run serially in call order afterwards. Results are
    /// returned in call order; every failure becomes an `is_error` result.
    pub async fn execute_batch(
        &self,
        ctx: Arc<ToolContext>,
        calls: Vec<(String, serde_json::Value)>,
    ) -> Vec<ToolResult> {
        let mut futures: Vec<SharedToolFuture> = Vec::with_capacity(calls.len());
        let mut exclusive: Vec<usize> = Vec::new();
        for (position, (name, args)) in calls.into_iter().enumerate() {
            match self.get(&name) {
                Some(tool) => {
                    if tool.concurrency == Concurrency::Exclusive {
                        exclusive.push(position);
                    }
                    futures.push((tool.execute)(ctx.clone(), args).shared());
                }
                None => {
                    let message = format!("unknown tool: {name}");
                    futures.push(async move { ToolResult::error(message) }.boxed().shared());
                }
            }
        }

        // Phase 1: all read-only futures concurrently (exclusive futures are
        // merely created — BoxFutures do nothing until first polled).
        let read_futures: Vec<SharedToolFuture> = futures
            .iter()
            .enumerate()
            .filter(|(position, _)| !exclusive.contains(position))
            .map(|(_, fut)| fut.clone())
            .collect();
        futures::future::join_all(read_futures).await;

        // Phase 2: exclusive futures serially in call order.
        for position in exclusive {
            if let Some(fut) = futures.get(position) {
                fut.clone().await;
            }
        }

        // All done — awaiting shared futures again returns cached results,
        // which re-establishes call order for the response.
        futures::future::join_all(futures).await
    }
}

/// Builds the six built-in tools (M0 set).
pub fn builtin_tools(bash_executor: Arc<dyn bash::BashExecutor>) -> Vec<ToolDefinition> {
    vec![
        tool_bash(bash_executor),
        tool_read(),
        tool_write(),
        tool_edit(),
        tool_grep(),
        tool_glob(),
    ]
}

fn tool_bash(executor: Arc<dyn bash::BashExecutor>) -> ToolDefinition {
    ToolDefinition {
        name: "bash",
        description: "Runs a bash command in the workspace. Non-interactive (stdin closed). Prefer grep/glob tools for search instead of cat/find. Output is truncated head+tail; the full output spills to disk and the result tells you where.".into(),
        parameters: schema_for::<bash::BashParams>(),
        concurrency: Concurrency::Exclusive,
        execute: Arc::new(move |ctx, args| {
            let executor = executor.clone();
            Box::pin(async move {
                match serde_json::from_value::<bash::BashParams>(args) {
                    Ok(params) => {
                        let (content, is_error) =
                            bash::run_bash(&ctx, executor.as_ref(), params).await;
                        ToolResult { content, is_error }
                    }
                    Err(e) => ToolResult::error(format!("invalid arguments: {e}")),
                }
            })
        }),
    }
}

fn tool_read() -> ToolDefinition {
    ToolDefinition {
        name: "read",
        description: "Reads a text file with cat -n style line numbers (max 2000 lines per call, 2000 chars per line). You must read a file before editing or overwriting it.".into(),
        parameters: schema_for::<read::ReadParams>(),
        concurrency: Concurrency::ReadOnly,
        execute: Arc::new(|ctx, args| {
            Box::pin(async move {
                match serde_json::from_value::<read::ReadParams>(args) {
                    Ok(params) => {
                        let (content, is_error) = read::run_read(&ctx, params).await;
                        ToolResult { content, is_error }
                    }
                    Err(e) => ToolResult::error(format!("invalid arguments: {e}")),
                }
            })
        }),
    }
}

fn tool_write() -> ToolDefinition {
    ToolDefinition {
        name: "write",
        description: "Creates or overwrites a file atomically. Existing files must be read first. Paths must stay inside the workspace.".into(),
        parameters: schema_for::<write::WriteParams>(),
        concurrency: Concurrency::Exclusive,
        execute: Arc::new(|ctx, args| {
            Box::pin(async move {
                match serde_json::from_value::<write::WriteParams>(args) {
                    Ok(params) => {
                        let (content, is_error) = write::run_write(&ctx, params).await;
                        ToolResult { content, is_error }
                    }
                    Err(e) => ToolResult::error(format!("invalid arguments: {e}")),
                }
            })
        }),
    }
}

fn tool_edit() -> ToolDefinition {
    ToolDefinition {
        name: "edit",
        description: "Replaces old_string with new_string in a file. old_string must match uniquely (progressive fallback: exact, line-trimmed, indentation-flexible, whitespace-normalized); set replace_all for intentional multi-replacement. Requires a prior read of the file.".into(),
        parameters: schema_for::<edit::EditParams>(),
        concurrency: Concurrency::Exclusive,
        execute: Arc::new(|ctx, args| {
            Box::pin(async move {
                match serde_json::from_value::<edit::EditParams>(args) {
                    Ok(params) => {
                        let (content, is_error) = edit::run_edit(&ctx, params).await;
                        ToolResult { content, is_error }
                    }
                    Err(e) => ToolResult::error(format!("invalid arguments: {e}")),
                }
            })
        }),
    }
}

fn tool_grep() -> ToolDefinition {
    ToolDefinition {
        name: "grep",
        description: "Content search (ripgrep kernel, gitignore-aware) over the workspace or a subpath. Returns path:line:text matches, capped at 200.".into(),
        parameters: schema_for::<grep::GrepParams>(),
        concurrency: Concurrency::ReadOnly,
        execute: Arc::new(|ctx, args| {
            Box::pin(async move {
                match serde_json::from_value::<grep::GrepParams>(args) {
                    Ok(params) => {
                        let (content, is_error) = grep::run_grep(&ctx, params).await;
                        ToolResult { content, is_error }
                    }
                    Err(e) => ToolResult::error(format!("invalid arguments: {e}")),
                }
            })
        }),
    }
}

fn tool_glob() -> ToolDefinition {
    ToolDefinition {
        name: "glob",
        description:
            "File-path glob matching over the workspace (gitignore-aware), capped at 200 results."
                .into(),
        parameters: schema_for::<glob::GlobParams>(),
        concurrency: Concurrency::ReadOnly,
        execute: Arc::new(|ctx, args| {
            Box::pin(async move {
                match serde_json::from_value::<glob::GlobParams>(args) {
                    Ok(params) => {
                        let (content, is_error) = glob::run_glob(&ctx, params).await;
                        ToolResult { content, is_error }
                    }
                    Err(e) => ToolResult::error(format!("invalid arguments: {e}")),
                }
            })
        }),
    }
}

/// Schemas come from the params structs themselves — one source of truth.
pub fn schema_for<T: schemars::JsonSchema>() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(T))
        .unwrap_or_else(|_| serde_json::json!({"type": "object"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Registry {
        let mut registry = Registry::new();
        for tool in builtin_tools(Arc::new(bash::DirectExecutor)) {
            registry.register(tool);
        }
        registry
    }

    fn context(temp: &tempfile::TempDir) -> Arc<ToolContext> {
        Arc::new(
            ToolContext::new("s-test", temp.path(), &temp.path().join(".saber"))
                .unwrap_or_else(|e| panic!("{e}")),
        )
    }

    #[test]
    fn registry_holds_six_ordered_tools() {
        let registry = registry();
        let names: Vec<&str> = registry
            .schema_for_prompt()
            .into_iter()
            .map(|(n, _, _)| n)
            .collect();
        assert_eq!(names, ["bash", "read", "write", "edit", "grep", "glob"]);
        assert_eq!(registry.len(), 6);
    }

    #[test]
    fn first_registration_wins() {
        let mut registry = registry();
        let shadow = ToolDefinition {
            name: "bash",
            description: "shadow".into(),
            parameters: serde_json::json!({}),
            concurrency: Concurrency::ReadOnly,
            execute: Arc::new(|_, _| Box::pin(async { ToolResult::ok("shadow".into()) })),
        };
        registry.register(shadow);
        assert_ne!(
            registry.get("bash").map(|t| t.description.as_str()),
            Some("shadow")
        );
    }

    #[tokio::test]
    async fn write_requires_prior_read_and_stays_in_workspace() {
        let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let registry = registry();
        let ctx = context(&temp);

        let overwrote = registry
            .execute_batch(
                ctx.clone(),
                vec![(
                    "write".into(),
                    serde_json::json!({"path": "a.txt", "content": "v1"}),
                )],
            )
            .await;
        assert!(!overwrote[0].is_error, "{}", overwrote[0].content);

        // Overwrite without a fresh read: refused.
        let refused = registry
            .execute_batch(
                ctx.clone(),
                vec![(
                    "write".into(),
                    serde_json::json!({"path": "a.txt", "content": "v2"}),
                )],
            )
            .await;
        assert!(refused[0].is_error);
        assert!(refused[0].content.contains("read it before overwriting"));

        // Read, then edit and overwrite succeed.
        let ok = registry
            .execute_batch(
                ctx.clone(),
                vec![
                    ("read".into(), serde_json::json!({"path": "a.txt"})),
                    ("edit".into(), serde_json::json!({"path": "a.txt", "old_string": "v1", "new_string": "v1-edited"})),
                ],
            )
            .await;
        assert!(!ok[0].is_error, "{}", ok[0].content);
        assert!(!ok[1].is_error, "{}", ok[1].content);

        // Escape attempt: refused by policy.
        let escape = registry
            .execute_batch(
                ctx.clone(),
                vec![(
                    "write".into(),
                    serde_json::json!({"path": "../outside.txt", "content": "x"}),
                )],
            )
            .await;
        assert!(escape[0].is_error);
        assert!(escape[0].content.contains("outside the writable roots"));
    }

    #[tokio::test]
    async fn batch_keeps_call_order_and_reports_unknown_tools() {
        let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let registry = registry();
        let ctx = context(&temp);
        let results = registry
            .execute_batch(
                ctx,
                vec![
                    ("glob".into(), serde_json::json!({"pattern": "**"})),
                    ("nope".into(), serde_json::json!({})),
                    ("bash".into(), serde_json::json!({"command": "echo hi"})),
                ],
            )
            .await;
        assert_eq!(results.len(), 3);
        assert!(!results[0].is_error);
        assert!(results[1].is_error);
        assert!(results[1].content.contains("unknown tool"));
        assert!(!results[2].is_error);
        assert!(results[2].content.contains("hi"));
    }

    #[tokio::test]
    #[allow(unsafe_code)] // test-only: set_var/remove_var are unsafe in edition 2024
    async fn bash_env_holds_no_secrets_and_cwd_is_workspace() {
        unsafe { std::env::set_var("SABER_TEST_SECRET", "leak-me") };
        let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let registry = registry();
        let ctx = context(&temp);
        let results = registry
            .execute_batch(
                ctx,
                vec![(
                    "bash".into(),
                    serde_json::json!({"command": "echo secret=${SABER_TEST_SECRET:-absent}; pwd"}),
                )],
            )
            .await;
        unsafe { std::env::remove_var("SABER_TEST_SECRET") };
        assert!(!results[0].is_error, "{}", results[0].content);
        assert!(
            results[0].content.contains("secret=absent"),
            "{}",
            results[0].content
        );
        assert!(
            results[0].content.contains(
                temp.path()
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .as_ref()
            )
        );
    }

    #[tokio::test]
    async fn bash_timeout_kills_the_process_group() {
        let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let registry = registry();
        let ctx = context(&temp);
        let started = std::time::Instant::now();
        let results = registry
            .execute_batch(
                ctx,
                vec![(
                    "bash".into(),
                    serde_json::json!({"command": "sleep 30; echo never", "timeout_ms": 500}),
                )],
            )
            .await;
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert!(!results[0].is_error); // timeout is a reported outcome, not a tool failure
        assert!(
            results[0].content.contains("timed out"),
            "{}",
            results[0].content
        );
    }

    #[tokio::test]
    async fn grep_and_glob_find_workspace_files() {
        let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(temp.path().join("main.rs"), "fn main() { finder() }")
            .unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(temp.path().join("util.rs"), "pub fn finder() {}")
            .unwrap_or_else(|e| panic!("{e}"));
        let registry = registry();
        let ctx = context(&temp);
        let results = registry
            .execute_batch(
                ctx,
                vec![
                    ("grep".into(), serde_json::json!({"pattern": "finder"})),
                    ("glob".into(), serde_json::json!({"pattern": "*.rs"})),
                ],
            )
            .await;
        assert!(
            results[0].content.contains("main.rs:1"),
            "{}",
            results[0].content
        );
        assert!(results[0].content.contains("util.rs:1"));
        assert!(
            results[1].content.contains("main.rs"),
            "{}",
            results[1].content
        );
        assert!(results[1].content.contains("util.rs"));
    }
}
