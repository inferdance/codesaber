//! `grep`: ripgrep-kernel content search that respects gitignore and the
//! unified path policy (denied paths are skipped, never read).

use crate::ToolContext;
use grep::searcher::SearcherBuilder;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct GrepParams {
    pub pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glob: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_results: Option<usize>,
}

const DEFAULT_MAX_RESULTS: usize = 200;

pub async fn run_grep(ctx: &ToolContext, params: GrepParams) -> (String, bool) {
    // Content search is CPU/IO-bound and short; running it synchronously
    // inside the async fn keeps the code honest about borrowing.
    match run_grep_inner(ctx, params) {
        Ok(output) => (output, false),
        Err(e) => (format!("grep failed: {e}"), true),
    }
}

fn run_grep_inner(ctx: &ToolContext, params: GrepParams) -> Result<String, String> {
    let matcher = grep::regex::RegexMatcherBuilder::new()
        .case_insensitive(false)
        .build(&params.pattern)
        .map_err(|e| format!("invalid regex {}: {e}", params.pattern))?;
    let root = params
        .path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| ctx.cwd.clone());
    let resolved_root = ctx.policy.resolve(&root).map_err(|e| e.to_string())?;

    let mut walker = ignore::WalkBuilder::new(&resolved_root);
    walker.hidden(true).git_ignore(true).git_exclude(true);
    if let Some(glob) = &params.glob {
        let glob_matcher = globset::Glob::new(glob)
            .and_then(|g| globset::GlobSetBuilder::new().add(g).build())
            .map_err(|e| format!("invalid glob {glob}: {e}"))?;
        let policy = ctx.policy.clone();
        walker.filter_entry(move |entry| {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return true;
            }
            matches_globset(&glob_matcher, entry.path()) && policy.check_read(entry.path()).is_ok()
        });
    }

    let max_results = params.max_results.unwrap_or(DEFAULT_MAX_RESULTS);
    let mut results: Vec<String> = Vec::new();
    let mut searched = 0usize;
    for entry in walker.build().filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if params.glob.is_none() && ctx.policy.check_read(entry.path()).is_err() {
            continue;
        }
        if results.len() >= max_results {
            break;
        }
        searched += 1;
        let mut sink = grep::searcher::sinks::UTF8(|line_num, line| {
            if results.len() < max_results {
                let text = line.trim_end();
                let rel = relative_display(entry.path(), &ctx.cwd);
                results.push(format!("{rel}:{line_num}:{text}"));
            }
            Ok(true)
        });
        let mut searcher = SearcherBuilder::new().line_number(true).build();
        let _ = searcher.search_path(&matcher, entry.path(), &mut sink);
    }
    if results.is_empty() {
        return Ok(format!(
            "no matches for {:?} (searched {searched} files under {})",
            params.pattern,
            relative_display(&resolved_root, &ctx.cwd)
        ));
    }
    let mut out = results.join("\n");
    out.push_str(&format!(
        "\n\n[{} match(es), {} file(s) searched]",
        results.len(),
        searched
    ));
    Ok(out)
}

fn matches_globset(set: &globset::GlobSet, path: &Path) -> bool {
    set.is_match(path) || set.is_match(path.file_name().unwrap_or_default())
}

fn relative_display(path: &Path, base: &Path) -> String {
    path.strip_prefix(base)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| path.display().to_string())
}
