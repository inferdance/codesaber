//! `write`: creates or overwrites files inside the writable roots. Existing
//! targets must have been read first (session-state guard); writes are
//! atomic (tmp + rename) so crashes never leave half files.

use crate::ToolContext;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct WriteParams {
    pub path: String,
    pub content: String,
}

pub async fn run_write(ctx: &ToolContext, params: WriteParams) -> (String, bool) {
    match run_write_inner(ctx, params).await {
        Ok(summary) => (summary, false),
        Err(e) => (format!("write failed: {e}"), true),
    }
}

async fn run_write_inner(ctx: &ToolContext, params: WriteParams) -> Result<String, String> {
    let path = PathBuf::from(&params.path);
    let resolved = ctx.policy.check_write(&path).map_err(|e| e.to_string())?;
    let existed = resolved.exists();
    if existed && !ctx.has_been_read(&resolved) {
        return Err(format!(
            "{} already exists; read it before overwriting with write",
            params.path
        ));
    }
    if let Some(parent) = resolved.parent() {
        // Parent must stay inside the writable roots (mkdir -p is fine,
        // but the resolved target was already policy-checked).
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let _guard = ctx.file_lock(&resolved).await;
    let tmp = resolved.with_extension(format!("sabertmp-{}", std::process::id()));
    tokio::fs::write(&tmp, &params.content)
        .await
        .map_err(|e| format!("{}: {e}", params.path))?;
    tokio::fs::rename(&tmp, &resolved)
        .await
        .map_err(|e| format!("{}: {e}", params.path))?;
    Ok(format!(
        "{} {} ({} bytes)",
        if existed { "overwrote" } else { "created" },
        params.path,
        params.content.len()
    ))
}
