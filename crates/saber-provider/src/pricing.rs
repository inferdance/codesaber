//! Cost accounting: static price table + `chars/4` token estimation.
//!
//! The table is deliberately tiny for M0 — budgets are soft warnings. The
//! models.dev catalog import lands with the v2 router. Provider-reported
//! usage is always authoritative when present; estimation only fills gaps.

use saber_protocol::Usage;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    /// USD per million input tokens.
    pub input_per_mtok: f64,
    /// USD per million output tokens.
    pub output_per_mtok: f64,
    /// USD per million cache-read tokens (typically ~0.1× input).
    pub cache_read_per_mtok: f64,
    /// USD per million cache-write tokens (typically ~1.25× input).
    pub cache_write_per_mtok: f64,
}

/// Illustrative list prices (USD/Mtok) as of 2026-08; treat as soft-budget
/// inputs, not billing truth.
pub fn lookup(model: &str) -> Option<Price> {
    let price = match model {
        m if m.starts_with("claude-opus") => Price {
            input_per_mtok: 15.0,
            output_per_mtok: 75.0,
            cache_read_per_mtok: 1.5,
            cache_write_per_mtok: 18.75,
        },
        m if m.starts_with("claude-sonnet") => Price {
            input_per_mtok: 3.0,
            output_per_mtok: 15.0,
            cache_read_per_mtok: 0.3,
            cache_write_per_mtok: 3.75,
        },
        m if m.starts_with("claude-haiku") => Price {
            input_per_mtok: 0.8,
            output_per_mtok: 4.0,
            cache_read_per_mtok: 0.08,
            cache_write_per_mtok: 1.0,
        },
        m if m.starts_with("deepseek-chat") => Price {
            input_per_mtok: 0.27,
            output_per_mtok: 1.1,
            cache_read_per_mtok: 0.07,
            cache_write_per_mtok: 0.27,
        },
        m if m.starts_with("deepseek-reasoner") => Price {
            input_per_mtok: 0.55,
            output_per_mtok: 2.19,
            cache_read_per_mtok: 0.14,
            cache_write_per_mtok: 0.55,
        },
        _ => return None,
    };
    Some(price)
}

/// `chars / 4` (character count, not bytes — CJK text estimates 4× too high
/// on bytes). Provider usage is authoritative when reported; this only
/// fills gaps for budget warnings.
pub fn estimate_tokens(text: &str) -> u64 {
    (text.chars().count() as u64).div_ceil(4)
}

/// Completes a usage record: fills estimated input tokens when the provider
/// reported none, and computes `cost_usd` from the configured price (or the
/// static table when no override is supplied).
pub fn finalize_usage(
    mut usage: Usage,
    model: &str,
    fallback_input_text: &str,
    price_override: Option<Price>,
) -> Usage {
    if usage.input_tokens == 0 && !fallback_input_text.is_empty() {
        usage.input_tokens = estimate_tokens(fallback_input_text);
    }
    if let Some(price) = price_override.or_else(|| lookup(model)) {
        usage.cost_usd = usage.input_tokens as f64 / 1e6 * price.input_per_mtok
            + usage.output_tokens as f64 / 1e6 * price.output_per_mtok
            + usage.cache_read_tokens as f64 / 1e6 * price.cache_read_per_mtok
            + usage.cache_write_tokens as f64 / 1e6 * price.cache_write_per_mtok;
    }
    usage
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimation_counts_chars_not_bytes() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abc"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        // CJK: 2 chars → 1, not bytes/4 = 2.
        assert_eq!(estimate_tokens("你好"), 1);
    }

    #[test]
    fn cost_uses_authoritative_tokens_when_present() {
        let usage = finalize_usage(
            Usage {
                input_tokens: 1_000_000,
                output_tokens: 1_000_000,
                ..Usage::default()
            },
            "claude-sonnet-4-5",
            "ignored fallback",
            None,
        );
        assert!((usage.cost_usd - 18.0).abs() < 1e-6);
    }

    #[test]
    fn unknown_model_costs_zero_but_tokens_estimate() {
        let usage = finalize_usage(Usage::default(), "mystery-model", "12345678", None);
        assert_eq!(usage.input_tokens, 2);
        assert_eq!(usage.cost_usd, 0.0);
    }

    #[test]
    fn price_override_beats_table_lookup() {
        let usage = finalize_usage(
            Usage {
                input_tokens: 1_000_000,
                output_tokens: 0,
                ..Usage::default()
            },
            "claude-sonnet-4-5",
            "",
            Some(Price {
                input_per_mtok: 1.0,
                output_per_mtok: 1.0,
                cache_read_per_mtok: 0.0,
                cache_write_per_mtok: 0.0,
            }),
        );
        assert!((usage.cost_usd - 1.0).abs() < 1e-6);
    }
}
