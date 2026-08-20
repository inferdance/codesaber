//! `edit`: old/new string replacement with a six-level progressive
//! fallback chain and hard guards, built for the reality that
//! model-provided `old_string` is often inexact (opencode `tool/edit.rs`
//! lineage).
//!
//! Levels, strict → loose (each strictly weaker than the previous; the
//! plan's nominal list is reordered so earlier levels never shadow later
//! ones):
//!
//! 1. `Simple` — exact bytes
//! 2. `EscapeNormalized` — common escapes decoded (`\\n`, `\\t`, `\\"`)
//! 3. `IndentationFlexible` — leading whitespace per line stripped
//! 4. `LineTrimmed` — per-line edges trimmed, internal whitespace kept
//! 5. `BlockAnchor` — per-line edges trimmed + internal runs collapsed
//! 6. `WhitespaceNormalized` — all whitespace runs (incl. newlines) → one space
//!
//! Guards: unique-match requirement (unless `replace_all`), and a
//! disproportionate-match rejection on fallback levels. CRLF files are
//! rewritten as CRLF only when the file is *uniformly* CRLF; mixed
//! line-ending files are edited byte-exact. UTF-8 BOM is preserved.
//! Match spans use per-character end boundaries, so fallback matches never
//! swallow trailing whitespace that belongs to the next character.

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
    EscapeNormalized,
    IndentationFlexible,
    LineTrimmed,
    BlockAnchor,
    WhitespaceNormalized,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Level::Simple => "simple",
            Level::EscapeNormalized => "escape_normalized",
            Level::IndentationFlexible => "indentation_flexible",
            Level::LineTrimmed => "line_trimmed",
            Level::BlockAnchor => "block_anchor",
            Level::WhitespaceNormalized => "whitespace_normalized",
        }
    }
}

/// Normalized text where every normalized character remembers its original
/// byte span — `ends` is what keeps fallback matches from swallowing the
/// whitespace that follows the match.
struct Normalized {
    text: String,
    starts: Vec<usize>,
    ends: Vec<usize>,
}

impl Normalized {
    fn push(&mut self, ch: char, span: (usize, usize)) {
        self.text.push(ch);
        self.starts.push(span.0);
        self.ends.push(span.1);
    }

    fn char_index_of_byte(&self, byte_offset: usize) -> usize {
        self.text[..byte_offset.min(self.text.len())]
            .chars()
            .count()
    }
}

fn normalize(source: &str, level: Level) -> Normalized {
    let mut out = Normalized {
        text: String::new(),
        starts: Vec::new(),
        ends: Vec::new(),
    };
    match level {
        Level::Simple => {
            for (idx, ch) in source.char_indices() {
                out.push(ch, (idx, idx + ch.len_utf8()));
            }
        }
        Level::EscapeNormalized => {
            let mut chars = source.char_indices().peekable();
            while let Some((idx, ch)) = chars.next() {
                if ch == '\\' {
                    if let Some(&(_, next)) = chars.peek() {
                        let decoded = match next {
                            'n' => Some('\n'),
                            't' => Some('\t'),
                            'r' => Some('\r'),
                            '"' => Some('"'),
                            '\'' => Some('\''),
                            '\\' => Some('\\'),
                            _ => None,
                        };
                        if let Some(decoded) = decoded {
                            chars.next();
                            let span_end = idx + 1 + next.len_utf8();
                            out.push(decoded, (idx, span_end));
                            continue;
                        }
                    }
                    out.push(ch, (idx, idx + 1));
                } else {
                    out.push(ch, (idx, idx + ch.len_utf8()));
                }
            }
        }
        Level::IndentationFlexible => {
            let mut at_line_start = true;
            for (idx, ch) in source.char_indices() {
                let is_indent = at_line_start && ch.is_whitespace() && ch != '\n';
                if is_indent {
                    // Stay in line-start mode: the whole indent run strips.
                    continue;
                }
                out.push(ch, (idx, idx + ch.len_utf8()));
                at_line_start = ch == '\n';
            }
        }
        Level::LineTrimmed | Level::BlockAnchor => {
            let collapse = level == Level::BlockAnchor;
            for (start, end, line) in line_spans(source) {
                let indent = line.len() - line.trim_start().len();
                let line_start = start + indent;
                let trimmed = line.trim_end_matches('\n').trim();
                if trimmed.is_empty() {
                    continue;
                }
                let mut pending_space = false;
                for (idx, ch) in trimmed.char_indices() {
                    let collapse_this = collapse && ch.is_whitespace();
                    if collapse_this {
                        pending_space = true;
                    } else {
                        if pending_space {
                            out.push(' ', (line_start + idx - 1, line_start + idx));
                            pending_space = false;
                        }
                        out.push(ch, (line_start + idx, line_start + idx + ch.len_utf8()));
                    }
                }
                let _ = pending_space;
                // Newline joins normalized lines; its span stays inside the
                // original line so trailing-context swallowing is bounded.
                out.push('\n', (end.saturating_sub(1).max(line_start), end));
            }
        }
        Level::WhitespaceNormalized => {
            let mut pending_space = false;
            for (idx, ch) in source.char_indices() {
                if ch.is_whitespace() {
                    pending_space = true;
                } else {
                    if pending_space {
                        out.push(' ', (idx.saturating_sub(1), idx));
                        pending_space = false;
                    }
                    out.push(ch, (idx, idx + ch.len_utf8()));
                }
            }
        }
    }
    out
}

fn line_spans(source: &str) -> Vec<(usize, usize, &str)> {
    let mut spans = Vec::new();
    let mut start = 0usize;
    for line in source.split_inclusive('\n') {
        let end = start + line.len();
        spans.push((start, end, line));
        start = end;
    }
    spans
}

/// Finds all match spans (original byte ranges) of `needle` in `hay` at the
/// first level that yields an acceptable match set.
fn find_matches(hay: &str, needle: &str) -> Result<(Vec<std::ops::Range<usize>>, Level), String> {
    if needle.is_empty() {
        return Err("old_string must not be empty (use write for new files)".into());
    }
    let levels = [
        Level::Simple,
        Level::EscapeNormalized,
        Level::IndentationFlexible,
        Level::LineTrimmed,
        Level::BlockAnchor,
        Level::WhitespaceNormalized,
    ];
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
            let start_char = norm_hay.char_index_of_byte(start_norm);
            let end_char = norm_hay.char_index_of_byte(end_norm);
            let Some(&start_orig) = norm_hay.starts.get(start_char) else {
                break;
            };
            // End boundary: the END of the LAST matched character — never
            // the start of the next one (that swallowed trailing context).
            let end_orig = norm_hay
                .ends
                .get(end_char.saturating_sub(1))
                .copied()
                .unwrap_or(hay.len());
            let span = start_orig..end_orig.max(start_orig);
            if level == Level::Simple || !disproportionate(needle.len(), span.len()) {
                spans.push(span);
            }
            cursor = end_norm;
        }
        if !spans.is_empty() {
            return Ok((spans, level));
        }
    }
    Err(format!(
        "old_string not found (tried simple, escape-normalized, indentation-flexible, line-trimmed, block-anchor, whitespace-normalized matching); expected {:?}",
        needle
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

/// Uniformly-CRLF detection: every `\n` is preceded by `\r`.
fn is_uniform_crlf(content: &str) -> bool {
    let newlines = content.matches('\n').count();
    newlines > 0 && newlines == content.matches("\r\n").count()
}

/// Applies the edit and returns the new content plus a human summary.
pub fn apply_edit(content: &str, params: &EditParams) -> Result<(String, String), EditError> {
    let (bom, body) = split_bom(content);
    let uniform_crlf = is_uniform_crlf(body);
    let working = if uniform_crlf {
        body.replace("\r\n", "\n")
    } else {
        body.to_owned()
    };
    // new_string participates in CRLF mode with its own line endings
    // normalized first, so embedded CRLF can never become `\r\r\n`.
    let replacement = if uniform_crlf {
        params.new_string.replace("\r\n", "\n")
    } else {
        params.new_string.clone()
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
    spans.sort_by_key(|span| span.start);
    spans.dedup_by_key(|span| span.start);
    let mut result = working.clone();
    for span in spans.iter().rev() {
        result.replace_range(span.clone(), &replacement);
    }
    let replaced = spans.len();

    let mut out = String::new();
    if let Some(bom) = bom {
        out.push_str(bom);
    }
    if uniform_crlf {
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
    let _guard = ctx.file_lock(&resolved).await;
    let content = tokio::fs::read_to_string(&resolved).await?;
    let (new_content, summary) = apply_edit(&content, &params)?;
    crate::atomic_write(&resolved, &new_content).await?;
    Ok(format!(
        "{summary} in {} ({} -> {} bytes)",
        params.path,
        content.len(),
        new_content.len()
    ))
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

    fn level_of(summary: &str) -> &str {
        summary.split(" via ").nth(1).unwrap_or_default()
    }

    // --- Level 1: simple -------------------------------------------------

    #[test]
    fn m01_simple_unique_match() {
        let (out, summary) = edit("fn main() {}\n", "fn main() {}", "fn main() { todo!() }")
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(out, "fn main() { todo!() }\n");
        assert!(level_of(&summary).starts_with("simple"));
    }

    #[test]
    fn m02_trailing_context_is_never_swallowed() {
        // Regression for the boundary bug: ws-normalized match of "a b"
        // inside "a  b c" must replace "a  b" exactly and keep " c".
        let (out, _) = edit("a  b c", "a b", "X").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(out, "X c", "whitespace after the match must survive");
    }

    #[test]
    fn m03_multiline_simple_match() {
        let content = "alpha\nbeta\ngamma\n";
        let (out, _) =
            edit(content, "alpha\nbeta", "ALPHA\nBETA").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(out, "ALPHA\nBETA\ngamma\n");
    }

    // --- Level 2: escape-normalized ---------------------------------------

    #[test]
    fn m04_escaped_needle_recovers_escape_confusion() {
        // File contains a literal backslash-n; the model sent a real
        // newline in old_string. Escape-normalized matching recovers.
        let content = "x = \"a\\nb\"\n";
        let needle = "x = \"a\nb\"";
        let (out, summary) = edit(content, needle, "removed").unwrap_or_else(|e| panic!("{e}"));
        assert!(out.contains("removed"), "{out}");
        assert!(level_of(&summary).starts_with("escape"), "{summary}");
    }

    // --- Level 3: indentation-flexible -------------------------------------

    #[test]
    fn m05_indentation_difference_is_tolerated() {
        let content = "\t\tfn inner() {\n\t\t\tdoit()\n\t\t}\n";
        let needle = "fn inner() {\n    doit()\n}";
        let (out, summary) =
            edit(content, needle, "fn inner() { doit() }").unwrap_or_else(|e| panic!("{e}"));
        assert!(out.contains("fn inner() { doit() }"));
        assert!(level_of(&summary).starts_with("indentation"), "{summary}");
    }

    #[test]
    fn m06_indent_flexible_keeps_internal_spacing_exact_when_possible() {
        // Internal spacing intact → indentation level alone differs.
        let content = "    let  x=1;\n";
        let (out, _) = edit(content, "let  x=1;", "let x = 1;").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(out, "    let x = 1;\n");
    }

    // --- Level 4: line-trimmed ----------------------------------------------

    #[test]
    fn m07_trailing_line_noise_is_tolerated() {
        let content = "alpha   \nbeta\t\n";
        let (out, summary) =
            edit(content, "alpha\nbeta", "one\ntwo").unwrap_or_else(|e| panic!("{e}"));
        assert!(out.contains("one") && out.contains("two"), "{out}");
        assert!(
            level_of(&summary).starts_with("line_trimmed")
                || level_of(&summary).starts_with("block"),
            "{summary}"
        );
    }

    // --- Level 5: block-anchor -----------------------------------------------

    #[test]
    fn m08_internal_whitespace_runs_collapse() {
        let content = "fn   main( )   {\n}\n";
        let (out, summary) =
            edit(content, "fn main( ) {", "fn entry() {").unwrap_or_else(|e| panic!("{e}"));
        assert!(out.contains("fn entry() {"), "{out}");
        assert!(
            level_of(&summary).starts_with("block") || level_of(&summary).starts_with("whitespace"),
            "{summary}"
        );
    }

    // --- Level 6: whitespace-normalized ---------------------------------------

    #[test]
    fn m09_newline_vs_space_confusion_recovers() {
        let content = "value = compute(x,\n y)\n";
        let needle = "value = compute(x, y)";
        let (out, summary) = edit(content, needle, "value = 0").unwrap_or_else(|e| panic!("{e}"));
        assert!(out.contains("value = 0"), "{out}");
        assert!(level_of(&summary).starts_with("whitespace"), "{summary}");
    }

    // --- Guards ------------------------------------------------------------

    #[test]
    fn m10_ambiguous_match_is_rejected() {
        match edit("a\na\n", "a", "b") {
            Err(err) => assert!(err.to_string().contains("2 locations"), "{err}"),
            Ok(_) => panic!("ambiguous match must be rejected"),
        }
    }

    #[test]
    fn m11_replace_all_replaces_every_occurrence() {
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
    fn m12_empty_needle_rejected() {
        match edit("abc", "", "x") {
            Err(err) => assert!(err.to_string().contains("must not be empty")),
            Ok(_) => panic!("empty old_string must be rejected"),
        }
    }

    #[test]
    fn m13_not_found_reports_all_levels() {
        match edit("completely unrelated", "ghost", "x") {
            Err(err) => assert!(err.to_string().contains("not found"), "{err}"),
            Ok(_) => panic!("ghost must not be found"),
        }
    }

    #[test]
    fn m14_disproportionate_fallback_match_is_rejected() {
        // A needle of two words must not whitespace-normalize onto a whole
        // paragraph span.
        let content = "start alpha beta gamma delta epsilon zeta end\n".repeat(6);
        match edit(&content, "start end", "X") {
            Err(err) => assert!(err.to_string().contains("not found"), "{err}"),
            Ok((out, _)) => panic!("disproportionate match must be rejected, got: {out}"),
        }
    }

    // --- Encoding preservation ------------------------------------------------

    #[test]
    fn m15_uniform_crlf_preserved_and_no_double_cr() {
        let content = "line one\r\nline two\r\n";
        let (out, _) =
            edit(content, "line one", "LINE ONE\r\nEXTRA").unwrap_or_else(|e| panic!("{e}"));
        assert!(out.contains("LINE ONE\r\nEXTRA\r\nline two\r\n"), "{out:?}");
        assert!(!out.contains("\r\r"), "{out:?}");
    }

    #[test]
    fn m16_mixed_line_endings_are_edited_byte_exact() {
        let content = "lf line\n crlf line\r\n lf again\n";
        let (out, _) = edit(content, "lf again", "LF AGAIN").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(out, "lf line\n crlf line\r\n LF AGAIN\n");
    }

    #[test]
    fn m17_bom_is_preserved() {
        let content = "\u{feff}hello\n";
        let (out, _) = edit(content, "hello", "world").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(out, "\u{feff}world\n");
    }

    #[test]
    fn m18_unicode_boundaries_are_char_safe() {
        let content = "let 你好 = 世界;\n";
        let (out, _) = edit(content, "你好", "hello").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(out, "let hello = 世界;\n");
    }

    #[test]
    fn m19_replacement_at_start_and_end() {
        let (out, _) = edit("head MID tail", "MID", "(mid)").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(out, "head (mid) tail");
    }

    #[test]
    fn m20_repeated_application_is_stable() {
        let params = EditParams {
            path: "x".into(),
            old_string: "old".into(),
            new_string: "new".into(),
            replace_all: true,
        };
        let once = apply_edit("old old old", &params)
            .unwrap_or_else(|e| panic!("{e}"))
            .0;
        let twice = apply_edit(&once, &params).map(|(content, _)| content);
        assert!(
            twice.is_err(),
            "second application must not find old_string"
        );
    }

    #[test]
    fn m21_needle_longer_than_hay_fails_cleanly() {
        match edit("ab", "abcdef", "x") {
            Err(err) => assert!(err.to_string().contains("not found")),
            Ok(_) => panic!("longer needle cannot match"),
        }
    }

    #[test]
    fn m22_crlf_needle_against_lf_file_via_fallback() {
        // Model sent CRLF in the needle for an LF file — line-trimmed level
        // should recover (the \r is trailing whitespace per line).
        let content = "alpha\nbeta\n";
        let (out, _) = edit(content, "alpha\r\nbeta", "one\ntwo").unwrap_or_else(|e| panic!("{e}"));
        assert!(out.contains("one") && out.contains("two"), "{out}");
    }

    #[test]
    fn m23_multi_replacement_ordering_with_fallback_level() {
        let params = EditParams {
            path: "x".into(),
            old_string: "item".into(),
            new_string: "THING".into(),
            replace_all: true,
        };
        let (out, _) =
            apply_edit("item a\n mid item b\n item c", &params).unwrap_or_else(|e| panic!("{e}"));
        assert!(out.starts_with("THING a"));
        assert!(out.contains("mid THING b"));
        assert!(out.ends_with("THING c"));
    }

    #[test]
    fn m24_match_span_extends_to_last_char_end_not_next_start() {
        // Whitespace-normalized match ends mid-line: bytes after the match
        // on the same line must survive untouched.
        let content = "fn compute(a: i32)   -> i32 { a }\n";
        let needle = "fn compute(a: i32) -> i32";
        let (out, _) = edit(content, needle, "pub fn compute(a: i64) -> i64")
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(out.contains("{ a }"), "trailing body must survive: {out}");
        assert!(out.contains("pub fn compute(a: i64) -> i64"), "{out}");
    }
}
