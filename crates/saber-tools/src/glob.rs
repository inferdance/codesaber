//! `glob`: file-path matching over the workspace (gitignore-aware), the
//! lighter sibling of grep for "where is this file" questions.

use crate::ToolContext;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct GlobParams {
    pub pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

const DEFAULT_MAX_RESULTS: usize = 200;

pub async fn run_glob(ctx: &ToolContext, params: GlobParams) -> (String, bool) {
    let cwd = ctx.cwd.clone();
    let policy = ctx.policy.clone();
    let joined = tokio::task::spawn_blocking(move || run_glob_inner(&cwd, &policy, params))
        .await
        .map_err(|e| format!("glob task: {e}"));
    match joined.and_then(|inner| inner) {
        Ok(output) => (output, false),
        Err(e) => (format!("glob failed: {e}"), true),
    }
}

fn run_glob_inner(
    cwd: &std::path::Path,
    policy: &crate::path_policy::PathPolicy,
    params: GlobParams,
) -> Result<String, String> {
    let root = params
        .path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.to_owned());
    let resolved_root = policy.resolve(&root).map_err(|e| e.to_string())?;
    let glob = globset::Glob::new(&params.pattern)
        .map_err(|e| format!("invalid glob {:?}: {e}", params.pattern))?;
    let matcher = globset::GlobSetBuilder::new()
        .add(glob)
        .build()
        .map_err(|e| format!("glob build: {e}"))?;

    let mut paths: Vec<String> = Vec::new();
    for entry in ignore::WalkBuilder::new(&resolved_root)
        .hidden(true)
        .git_ignore(true)
        .build()
        .filter_map(|e| e.ok())
    {
        if paths.len() >= DEFAULT_MAX_RESULTS {
            break;
        }
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let candidate = entry.path();
        if !(matcher.is_match(candidate)
            || matcher.is_match(candidate.file_name().unwrap_or_default()))
        {
            continue;
        }
        if policy.check_read(candidate).is_err() {
            continue;
        }
        paths.push(
            candidate
                .strip_prefix(cwd)
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| candidate.display().to_string()),
        );
    }
    if paths.is_empty() {
        return Ok(format!(
            "no files matching {:?} under {}",
            params.pattern,
            resolved_root.display()
        ));
    }
    let count = paths.len();
    let mut out = paths.join("\n");
    if count == DEFAULT_MAX_RESULTS {
        out.push_str("\n\n[result cap reached; narrow the pattern]");
    }
    Ok(out)
}
