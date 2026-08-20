//! `edit`: old/new string replacement with a progressive fallback chain and
//! hard guards. Designed for the reality that model-provided `old_string`
//! is often inexact (opencode `tool/edit.ts` lineage, M0 subset):
//!
//! Simple → LineTrimmed → IndentationFlexible → WhitespaceNormalized
//!
//! Guards: unique-match requirement (unless `replace_all`), and a
//! disproportionate-match rejection on fallback levels (a match far larger
//! than the needle means the normalization is lying). CRLF and UTF-8 BOM
//! are preserved.

use crate::ToolContext;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct EditParams {
    pub path: String,
    pub old_string: String,
    pub new_string: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub replace_all: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Level {
    Simple,
    LineTrimmed,
    IndentationFlexible,
    WhitespaceNormalized,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Level::Simple => "simple",
            Level::LineTrimmed => "line_trimmed",
            Level::IndentationFlexible => "indentation_flexible",
            Level::WhitespaceNormalized => "whitespace_normalized",
        }
    }
}

/// A normalized text with a byte-index map back to the original.
struct Normalized {
    text: String,
    /// original byte index for every byte offset in `text` boundaries
    map: Vec<usize>,
}

fn normalize(source: &str, level: Level) -> Normalized {
    let mut text = String::new();
    let mut map: Vec<usize> = Vec::new();
    fn push(ch: char, orig: usize, text: &mut String, map: &mut Vec<usize>) {
        for _ in 0..ch.len_utf8() {
            map.push(orig);
        }
        text.push(ch);
    }
    match level {
        Level::Simple => {
            for (idx, ch) in source.char_indices() {
                push(ch, idx, &mut text, &mut map);
            }
        }
        Level::LineTrimmed => {
            for (idx, ch) in source.char_indices() {
                if !ch.is_whitespace() {
                    push(ch, idx, &mut text, &mut map);
                }
            }
        }
        Level::IndentationFlexible => {
            let mut at_line_start = true;
            for (idx, ch) in source.char_indices() {
                let is_indent_ws = at_line_start && ch.is_whitespace() && ch != '\n';
                if !is_indent_ws {
                    push(ch, idx, &mut text, &mut map);
                }
                at_line_start = ch == '\n';
            }
        }
        Level::WhitespaceNormalized => {
            let mut pending_ws = false;
            for (idx, ch) in source.char_indices() {
                if ch.is_whitespace() {
                    pending_ws = true;
                } else {
                    if pending_ws {
                        push(' ', idx.saturating_sub(1), &mut text, &mut map);
                        pending_ws = false;
                    }
                    push(ch, idx, &mut text, &mut map);
                }
            }
        }
    }
    Normalized { text, map }
}

/// Finds all match spans (original byte ranges) of `needle` in `hay` at the
/// first level that yields an acceptable match set.
fn find_matches(hay: &str, needle: &str) -> Result<(Vec<std::ops::Range<usize>>, Level), String> {
    if needle.is_empty() {
        return Err("old_string must not be empty (use write for new files)".into());
    }
    let levels = [
        Level::Simple,
        Level::LineTrimmed,
        Level::IndentationFlexible,
        Level::WhitespaceNormalized,
    ];
    let mut last_seen = 0usize;
    for level in levels {
        let norm_hay = normalize(hay, level);
        let norm_needle = normalize(needle, level);
        if norm_needle.text.is_empty() {
            continue;
        }
        let mut spans = Vec::new();
        let mut cursor = 0usize;
        while let Some(found) = norm_hay.text[cursor..].find(&norm_needle.text) {
            let start_norm = cursor + found;
            let end_norm = start_norm + norm_needle.text.len();
            let Some(&start_orig) = norm_hay.map.get(start_norm) else {
                break;
            };
            let end_orig = norm_hay.map.get(end_norm).copied().unwrap_or(hay.len());
            let span = start_orig..end_orig;
            if level == Level::Simple || !disproportionate(needle.len(), end_orig - start_orig) {
                spans.push(span);
            }
            cursor = end_norm;
            last_seen = spans.len();
        }
        match spans.len() {
            0 => continue,
            _ => return Ok((spans, level)),
        }
    }
    let _ = last_seen;
    Err(format!(
        "old_string not found in the file (tried simple, line-trimmed, indentation-flexible, whitespace-normalized matching); expected {needle:?}"
    ))
}

/// Rejects fallback matches whose span dwarfs the needle: whitespace
/// normalization matching across unrelated code is worse than failing.
fn disproportionate(needle_len: usize, span_len: usize) -> bool {
    span_len > needle_len.saturating_mul(2).saturating_add(8)
}

#[derive(Debug, thiserror::Error)]
pub enum EditError {
    #[error("{0}")]
    Message(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("path policy: {0}")]
    Policy(#[from] crate::path_policy::PathDenied),
}

fn split_bom(content: &str) -> (Option<&str>, &str) {
    match content.strip_prefix('\u{feff}') {
        Some(rest) => (Some("\u{feff}"), rest),
        None => (None, content),
    }
}

fn detect_crlf(content: &str) -> bool {
    content.contains("\r\n")
}

/// Applies the edit and returns the new content plus a human summary.
pub fn apply_edit(content: &str, params: &EditParams) -> Result<(String, String), EditError> {
    let (bom, body) = split_bom(content);
    let crlf = detect_crlf(body);
    let working = if crlf {
        body.replace("\r\n", "\n")
    } else {
        body.to_owned()
    };

    let (mut spans, level) =
        find_matches(&working, &params.old_string).map_err(EditError::Message)?;
    if spans.len() > 1 && !params.replace_all {
        return Err(EditError::Message(format!(
            "old_string matches {} locations; provide a longer, unique old_string or set replace_all",
            spans.len()
        )));
    }
    if !params.replace_all {
        spans.truncate(1);
    }
    // Apply from the back so earlier byte offsets stay valid.
    spans.sort_by_key(|span| span.start);
    let mut result = working.clone();
    for span in spans.iter().rev() {
        result.replace_range(span.clone(), &params.new_string);
    }
    let replaced = spans.len();

    let mut out = String::new();
    if let Some(bom) = bom {
        out.push_str(bom);
    }
    if crlf {
        out.push_str(&result.replace('\n', "\r\n"));
    } else {
        out.push_str(&result);
    }
    let summary = format!(
        "applied {replaced} replacement(s) via {} matching",
        level.label()
    );
    Ok((out, summary))
}

/// Full tool entry used by the registry: policy check, read-before-edit
/// enforcement, per-file content application.
pub async fn run_edit(ctx: &ToolContext, params: EditParams) -> (String, bool) {
    match run_edit_inner(ctx, params).await {
        Ok(summary) => (summary, false),
        Err(e) => (format!("edit failed: {e}"), true),
    }
}

async fn run_edit_inner(ctx: &ToolContext, params: EditParams) -> Result<String, EditError> {
    let path = PathBuf::from(&params.path);
    let resolved = ctx.policy.check_write(&path)?;
    if !ctx.has_been_read(&resolved) {
        return Err(EditError::Message(format!(
            "you must read {} before editing it (call the read tool first)",
            params.path
        )));
    }
    if !resolved.exists() {
        return Err(EditError::Message(format!(
            "{} does not exist (use the write tool to create it)",
            params.path
        )));
    }
    // Mutation serialization: tools marked Exclusive are serialized by the
    // scheduler; a context-level lock additionally guards concurrent edits
    // to the same file from parallel batches.
    let _guard = ctx.file_lock(&resolved).await;
    let content = tokio::fs::read_to_string(&resolved).await?;
    let (new_content, summary) = apply_edit(&content, &params)?;
    write_atomic(&resolved, &new_content).await?;
    Ok(format!(
        "{summary} in {} ({} -> {} bytes)",
        params.path,
        content.len(),
        new_content.len()
    ))
}

pub(crate) async fn write_atomic(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("sabertmp-{}", std::process::id()));
    tokio::fs::write(&tmp, content).await?;
    tokio::fs::rename(&tmp, path).await?;
    Ok(())
}

/// Exposed for tests: check-only variant that reports what would happen.
pub fn plan_edit(content: &str, params: &EditParams) -> Result<String, EditError> {
    let (_, summary) = apply_edit(content, params)?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(content: &str, old: &str, new: &str) -> Result<(String, String), EditError> {
        apply_edit(
            content,
            &EditParams {
                path: "x".into(),
                old_string: old.into(),
                new_string: new.into(),
                replace_all: false,
            },
        )
    }

    #[test]
    fn simple_unique_match() {
        let (out, summary) = edit("fn main() {}\n", "fn main() {}", "fn main() { todo!() }")
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(out, "fn main() { todo!() }\n");
        assert!(summary.contains("simple"));
    }

    #[test]
    fn line_trimmed_fallback_recovers_whitespace_noise() {
        // Model dropped the trailing spaces of indentation-heavy code.
        let content = "    let a = 1;\n    let b = 2;\n";
        let needle = "let a = 1; let b = 2;";
        let (out, summary) =
            edit(content, needle, "let a = 10;\nlet b = 20;").unwrap_or_else(|e| panic!("{e}"));
        assert!(out.contains("let a = 10;"), "out: {out}");
        assert!(summary.contains("line_trimmed") || summary.contains("normalized"));
    }

    #[test]
    fn indent_flexible_ignores_indentation_differences() {
        let content = "\t\tfn inner() {\n\t\t\tdoit()\n\t\t}\n";
        let needle = "fn inner() {\n    doit()\n}";
        let (out, summary) =
            edit(content, needle, "fn inner() { doit() }").unwrap_or_else(|e| panic!("{e}"));
        assert!(out.contains("fn inner() { doit() }"));
        assert!(summary.contains("indentation_flexible") || summary.contains("line_trimmed"));
    }

    #[test]
    fn ambiguous_match_is_rejected() {
        match edit("a\na\n", "a", "b") {
            Err(err) => assert!(err.to_string().contains("2 locations"), "{err}"),
            Ok(_) => panic!("ambiguous match must be rejected"),
        }
    }

    #[test]
    fn replace_all_replaces_every_occurrence() {
        let params = EditParams {
            path: "x".into(),
            old_string: "x".into(),
            new_string: "y".into(),
            replace_all: true,
        };
        let (out, summary) = apply_edit("x\nx\nx\n", &params).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(out, "y\ny\ny\n");
        assert!(summary.contains("3 replacement(s)"));
    }

    #[test]
    fn crlf_and_bom_are_preserved() {
        let content = "\u{feff}line one\r\nline two\r\n";
        let (out, _) = edit(content, "line one", "LINE ONE").unwrap_or_else(|e| panic!("{e}"));
        assert!(out.starts_with('\u{feff}'));
        assert!(out.contains("LINE ONE\r\nline two\r\n"));
    }

    #[test]
    fn not_found_reports_all_levels() {
        match edit("completely unrelated", "ghost", "x") {
            Err(err) => assert!(err.to_string().contains("not found"), "{err}"),
            Ok(_) => panic!("ghost must not be found"),
        }
    }
}
