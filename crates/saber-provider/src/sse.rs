//! In-crate SSE parsing (~100 lines): LLM streams are `data:` lines plus the
//! `[DONE]` sentinel, so a full SSE crate buys nothing (and
//! reqwest-eventsource is unmaintained).
//!
//! Feed raw bytes from `Response::bytes_stream()`; receive complete `data`
//! payloads. Handles `\n` and `\r\n` line endings, multi-line `data:`
//! concatenation (joined with `\n` per the SSE spec), comment lines (`:`),
//! and ignores `event:`/`id:`/`retry:` fields (the event type rides inside
//! the JSON payload for every provider we target).

/// Incremental byte-chunk → SSE `data` payload parser.
#[derive(Debug, Default)]
pub struct SseParser {
    buffer: Vec<u8>,
    data_lines: Vec<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds one raw chunk, returning every complete `data` payload whose
    /// event boundary has been seen.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(chunk);
        let mut payloads = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buffer.drain(..=newline).collect();
            // Strip the terminator: '\n', then a preceding '\r' for CRLF.
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line).into_owned();
            self.process_line(&line, &mut payloads);
        }
        payloads
    }

    /// Ends the stream: dispatches a trailing event only if its last line
    /// was already terminated (incomplete trailing lines are dropped per the
    /// SSE spec — this is exactly the truncated-stream fault we must absorb
    /// without panicking).
    pub fn finish(&mut self) -> Vec<String> {
        self.buffer.clear();
        self.dispatch()
    }

    fn process_line(&mut self, line: &str, payloads: &mut Vec<String>) {
        if line.is_empty() {
            payloads.extend(self.dispatch());
            return;
        }
        if let Some(data) = line.strip_prefix("data:") {
            let value = data.strip_prefix(' ').unwrap_or(data);
            self.data_lines.push(value.to_owned());
        }
        // `:` comments and `event:`/`id:`/`retry:` fields are ignored.
    }

    fn dispatch(&mut self) -> Vec<String> {
        if self.data_lines.is_empty() {
            return Vec::new();
        }
        let joined = std::mem::take(&mut self.data_lines).join("\n");
        vec![joined]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(chunks: &[&[u8]]) -> Vec<String> {
        let mut parser = SseParser::new();
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(parser.feed(chunk));
        }
        out.extend(parser.finish());
        out
    }

    #[test]
    fn parses_basic_data_events_split_across_chunks() {
        let payloads = collect(&[b"data: {\"a\":", b"1}\n\n", b"data: [DONE]\n", b"\n"]);
        assert_eq!(payloads, vec!["{\"a\":1}".to_owned(), "[DONE]".to_owned()]);
    }

    #[test]
    fn handles_crlf_comments_and_ignored_fields() {
        let payloads = collect(&[
            b": keep-alive\r\n",
            b"event: message_start\r\n",
            b"id: 42\r\n",
            b"data: hello\r\n",
            b"data: world\r\n",
            b"\r\n",
        ]);
        assert_eq!(payloads, vec!["hello\nworld".to_owned()]);
    }

    #[test]
    fn drops_incomplete_trailing_line() {
        let payloads = collect(&[b"data: {\"trunc"]);
        assert!(payloads.is_empty());
    }
}
