//! `read`: cat -n style line output with read-tracking registration (the
//! write/edit tools require a prior read), binary detection, and output
//! governance (line clamp + spill).

use crate::ToolContext;
use crate::truncation::{TruncationConfig, spill_full_output, truncate_output};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct ReadParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

const BINARY_PROBE_BYTES: usize = 8192;

pub async fn run_read(ctx: &ToolContext, params: ReadParams) -> (String, bool) {
    match run_read_inner(ctx, params).await {
        Ok(output) => (output, false),
        Err(e) => (format!("read failed: {e}"), true),
    }
}

async fn run_read_inner(ctx: &ToolContext, params: ReadParams) -> Result<String, String> {
    let path = PathBuf::from(&params.path);
    let resolved = ctx.policy.check_read(&path).map_err(|e| e.to_string())?;
    let bytes = tokio::fs::read(&resolved)
        .await
        .map_err(|e| format!("{}: {e}", params.path))?;
    if bytes.iter().take(BINARY_PROBE_BYTES).any(|b| *b == 0) {
        return Err(format!("{} is binary; refuse to read as text", params.path));
    }
    let content = String::from_utf8(bytes).map_err(|_| {
        format!(
            "{} is not valid UTF-8 (binary or non-UTF-8 encoding)",
            params.path
        )
    })?;

    ctx.mark_read(&resolved);

    let offset = params.offset.unwrap_or(0);
    let config = TruncationConfig::default();
    let limit = params.limit.unwrap_or(config.max_lines as u64);
    let selected: Vec<&str> = content
        .lines()
        .skip(offset as usize)
        .take((limit as usize).min(config.max_lines))
        .collect();

    let mut rendered = String::new();
    for (idx, line) in selected.iter().enumerate() {
        let line_no = offset as usize + idx + 1;
        let clamped: String = line.chars().take(config.max_line_chars).collect();
        let ellipsis = if line.chars().count() > config.max_line_chars {
            "…"
        } else {
            ""
        };
        rendered.push_str(&format!("{line_no:>6}\t{clamped}{ellipsis}\n"));
    }
    if selected.len() == config.max_lines && content.lines().count() > selected.len() {
        rendered.push_str(&format!(
            "\n[memory limit: showing {} of {} lines from offset {offset}; pass offset/limit to continue]",
            selected.len(),
            content.lines().count()
        ));
    }
    Ok(rendered)
}

#[allow(dead_code)]
pub(crate) fn spill_note(ctx: &ToolContext, full: &str) -> Option<String> {
    let _ = truncate_output(full, &TruncationConfig::default());
    spill_full_output(&ctx.data_dir, &ctx.session_id, "read", full)
        .ok()
        .map(|p| p.display().to_string())
}
