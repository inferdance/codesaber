//! Output governance (T4): three layers — per-line clamping, head/tail
//! truncation, and full-output spill to the truncations directory so the
//! model can read back what was clipped (7-day retention).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone, Copy)]
pub struct TruncationConfig {
    pub max_lines: usize,
    pub max_line_chars: usize,
}

impl Default for TruncationConfig {
    fn default() -> Self {
        Self {
            max_lines: 2000,
            max_line_chars: 2000,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Truncated {
    pub content: String,
    pub was_truncated: bool,
    pub original_len: usize,
}

/// Clamps each line then keeps head and tail halves of the line budget —
/// the middle is where noise lives (codex output-truncation approach).
pub fn truncate_output(content: &str, config: &TruncationConfig) -> Truncated {
    let clamped: Vec<String> = content
        .lines()
        .map(|line| clamp_line(line, config.max_line_chars))
        .collect();
    if clamped.len() <= config.max_lines {
        let mut out = clamped.join("\n");
        if content.ends_with('\n') {
            out.push('\n');
        }
        let was_truncated = clamped.iter().any(|l| l.ends_with('…')) || out.len() != content.len();
        return Truncated {
            content: out,
            was_truncated,
            original_len: content.len(),
        };
    }
    let head = config.max_lines / 2;
    let tail = config.max_lines - head;
    let omitted = clamped.len() - config.max_lines;
    let mut parts: Vec<String> = Vec::with_capacity(config.max_lines + 2);
    parts.extend(clamped[..head].to_vec());
    parts.push(format!(
        "\n… [truncated: {omitted} lines omitted of {} — full output spilled to disk] …\n",
        clamped.len()
    ));
    parts.extend(clamped[clamped.len() - tail..].to_vec());
    Truncated {
        content: parts.join("\n"),
        was_truncated: true,
        original_len: content.len(),
    }
}

fn clamp_line(line: &str, max_chars: usize) -> String {
    if line.chars().count() <= max_chars {
        line.to_owned()
    } else {
        let kept: String = line.chars().take(max_chars).collect();
        format!("{kept}…")
    }
}

/// Writes the untouched full output under
/// `<data_dir>/truncations/<session_id>/<millis>-<tool>.log` and returns
/// the path so the tool result can point the model at it.
pub fn spill_full_output(
    data_dir: &Path,
    session_id: &str,
    tool: &str,
    content: &str,
) -> std::io::Result<PathBuf> {
    let dir = data_dir.join("truncations").join(sanitize(session_id));
    std::fs::create_dir_all(&dir)?;
    let millis = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("{millis}-{}.log", sanitize(tool)));
    std::fs::write(&path, content)?;
    Ok(path)
}

/// Drops spill files older than the retention window. Call opportunistically
/// (session start); failures are non-fatal for the caller.
pub fn cleanup_stale_truncations(data_dir: &Path, retention: Duration) -> std::io::Result<u64> {
    let root = data_dir.join("truncations");
    if !root.exists() {
        return Ok(0);
    }
    let cutoff = SystemTime::now()
        .checked_sub(retention)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut removed = 0u64;
    for entry in walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let stale = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|mtime| mtime < cutoff)
            .unwrap_or(false);
        if stale && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

fn sanitize(component: &str) -> String {
    component
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_head_and_tail_when_over_budget() {
        let content: String = (0..3000).map(|i| format!("line-{i}\n")).collect();
        let config = TruncationConfig {
            max_lines: 100,
            max_line_chars: 100,
        };
        let truncated = truncate_output(&content, &config);
        assert!(truncated.was_truncated);
        assert!(truncated.content.contains("line-0\n"));
        assert!(truncated.content.contains("line-2999"));
        assert!(!truncated.content.contains("line-500\n"));
        assert!(truncated.content.contains("truncated"));
    }

    #[test]
    fn clamps_long_lines() {
        let long_line = "x".repeat(5000);
        let truncated = truncate_output(&long_line, &TruncationConfig::default());
        assert!(truncated.was_truncated);
        assert!(truncated.content.chars().count() <= 2001);
        assert!(truncated.content.ends_with('…'));
    }

    #[test]
    fn spill_round_trips_and_cleans_up() -> std::io::Result<()> {
        let temp = tempfile::tempdir()?;
        let path = spill_full_output(temp.path(), "s-1/evil", "bash", "full content")?;
        assert_eq!(std::fs::read_to_string(&path)?, "full content");
        // Backdate beyond retention.
        let old = std::time::SystemTime::now() - Duration::from_secs(60 * 60 * 24 * 8);
        let f = std::fs::File::options().append(true).open(&path)?;
        f.set_modified(old)?;
        let removed =
            cleanup_stale_truncations(temp.path(), Duration::from_secs(60 * 60 * 24 * 7))?;
        assert_eq!(removed, 1);
        Ok(())
    }
}
