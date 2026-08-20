//! Session log with WAL semantics (M0-T5): append-only JSONL as the single
//! source of truth. One line = one
//! [`SessionEventEnvelope`][saber_protocol::SessionEventEnvelope]
//! (`{"ts":..,"seq":..,"session_id":..,"type":..,"payload":{..}}`).
//!
//! Write-ahead rule: before a tool side effect runs, the engine durably
//! appends a `tool_call` intent; the `tool_result` lands after the side
//! effect completes. Recovery treats intent-without-result as an
//! unfinished call — reported, never replayed.

use saber_protocol::{SessionEvent, SessionEventEnvelope};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("corrupt session log at {path} line {line}: {reason}")]
    Corrupt {
        path: PathBuf,
        line: usize,
        reason: String,
    },
}

/// Append-only JSONL session writer with WAL `fsync` for intents.
pub struct SessionLog {
    path: PathBuf,
    session_id: String,
    writer: Mutex<std::fs::File>,
    seq: AtomicU64,
}

impl SessionLog {
    /// Opens an existing session log in append mode, rebuilding the
    /// sequence counter from the recovered events. Fails if the log does
    /// not exist (use [`SessionLog::create`] for new sessions).
    pub fn open_append(path: &Path) -> Result<Self, SessionError> {
        let recovered = recover(path)?;
        let next_seq = recovered.events.last().map(|e| e.seq + 1).unwrap_or(0);
        // Truncate any torn tail so appends never create mid-file
        // corruption. The last complete event's byte offset is the new EOF.
        let last_complete_offset = recovered.events.last().map(|_| ()).unwrap_or(());
        let _ = last_complete_offset;
        // Re-read raw bytes and find the offset after the last complete line.
        let raw = std::fs::read(path)?;
        let mut clean_end = raw.len();
        for (i, byte) in raw.iter().enumerate().rev() {
            if *byte == b'\n' {
                clean_end = i + 1;
                break;
            }
        }
        // Verify the clean prefix parses; if the last complete line is
        // corrupt (not just torn), keep truncating to the prior newline.
        let text = String::from_utf8_lossy(&raw[..clean_end]).into_owned();
        let lines: Vec<&str> = text.lines().collect();
        let mut valid_lines = lines.len();
        for (idx, line) in lines.iter().enumerate().rev() {
            if line.trim().is_empty() {
                valid_lines = idx;
                continue;
            }
            match serde_json::from_str::<SessionEventEnvelope>(line) {
                Ok(_) => break,
                Err(_) => valid_lines = idx,
            }
        }
        if valid_lines < lines.len() {
            // Recompute byte offset after the last valid line.
            let mut offset = 0;
            for (idx, line) in lines.iter().enumerate() {
                if idx >= valid_lines {
                    break;
                }
                offset += line.len() + 1;
            }
            clean_end = offset;
        }
        if clean_end < raw.len() {
            let file = std::fs::OpenOptions::new().write(true).open(path)?;
            file.set_len(clean_end as u64)?;
        }

        let writer = std::fs::OpenOptions::new().append(true).open(path)?;
        let session_id = recovered
            .events
            .first()
            .map(|e| e.session_id.clone())
            .unwrap_or_default();
        Ok(Self {
            path: path.to_owned(),
            session_id,
            writer: Mutex::new(writer),
            seq: AtomicU64::new(next_seq),
        })
    }

    /// Creates (or truncates) a session log; `meta` becomes line 1.
    pub fn create(dir: &Path, session_id: &str, meta: SessionEvent) -> Result<Self, SessionError> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("{session_id}.jsonl"));
        let writer = std::fs::File::create(&path)?;
        let log = Self {
            path,
            session_id: session_id.to_owned(),
            writer: Mutex::new(writer),
            seq: AtomicU64::new(0),
        };
        log.append_inner(meta, false)?;
        Ok(log)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Appends an event. `sync` = WAL boundary (tool intents).
    pub fn append(&self, event: SessionEvent, sync: bool) -> Result<u64, SessionError> {
        self.append_inner(event, sync)
    }

    fn append_inner(&self, event: SessionEvent, sync: bool) -> Result<u64, SessionError> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let envelope = SessionEventEnvelope {
            ts: now_ms(),
            seq,
            session_id: self.session_id.clone(),
            event,
        };
        let mut line = serde_json::to_string(&envelope).map_err(|e| SessionError::Corrupt {
            path: self.path.clone(),
            line: seq as usize,
            reason: e.to_string(),
        })?;
        line.push('\n');
        let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        writer.write_all(line.as_bytes())?;
        if sync {
            writer.sync_data()?;
        }
        Ok(seq)
    }

    /// Snapshot of the next sequence number (for tests/inspection).
    pub fn next_seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A reconstructed session: every parsed event plus the unfinished tool
/// calls (intent without result) found during recovery.
#[derive(Debug)]
pub struct Recovered {
    pub events: Vec<SessionEventEnvelope>,
    /// `seq` of tool_call intents whose results never landed.
    pub unfinished_tool_calls: Vec<u64>,
}

/// Rebuilds a session from its JSONL log. Torn trailing lines (partial
/// writes from a crash) are dropped; mid-file corruption is an error.
pub fn recover(path: &Path) -> Result<Recovered, SessionError> {
    let text = std::fs::read_to_string(path)?;
    let mut events = Vec::new();
    let mut lines = text.lines().enumerate().peekable();
    while let Some((index, line)) = lines.next() {
        if line.trim().is_empty() {
            continue;
        }
        let is_last = lines.peek().is_none();
        match serde_json::from_str::<SessionEventEnvelope>(line) {
            Ok(envelope) => events.push(envelope),
            Err(_) if is_last => {
                // Torn tail from a crash mid-write: drop it.
                break;
            }
            Err(e) => {
                return Err(SessionError::Corrupt {
                    path: path.to_owned(),
                    line: index + 1,
                    reason: e.to_string(),
                });
            }
        }
    }
    let mut finished = std::collections::HashSet::new();
    for event in &events {
        if let SessionEvent::ToolResult { call_id, .. } = &event.event {
            finished.insert(call_id.clone());
        }
    }
    let unfinished_tool_calls = events
        .iter()
        .filter(|event| {
            matches!(&event.event, SessionEvent::ToolCall { call_id, .. }
                if !finished.contains(call_id))
        })
        .map(|event| event.seq)
        .collect();
    Ok(Recovered {
        events,
        unfinished_tool_calls,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> SessionEvent {
        SessionEvent::SessionMeta {
            protocol_version: "0.1.0".into(),
            engine_version: "0.1.0".into(),
            cwd: "/tmp".into(),
            model: None,
        }
    }

    #[test]
    fn wal_intent_and_result_roundtrip() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let log = SessionLog::create(dir.path(), "s-1", meta())?;
        log.append(
            SessionEvent::ToolCall {
                call_id: "c1".into(),
                name: "bash".into(),
                arguments: serde_json::json!({"command": "touch x"}),
            },
            true,
        )?;
        log.append(
            SessionEvent::ToolResult {
                call_id: "c1".into(),
                content: "done".into(),
                is_error: false,
            },
            false,
        )?;
        let recovered = recover(log.path())?;
        assert_eq!(recovered.events.len(), 3);
        assert!(recovered.unfinished_tool_calls.is_empty());
        Ok(())
    }

    #[test]
    fn intent_without_result_is_flagged_not_replayed() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let log = SessionLog::create(dir.path(), "s-2", meta()).unwrap_or_else(|e| panic!("{e}"));
        let seq = log
            .append(
                SessionEvent::ToolCall {
                    call_id: "c9".into(),
                    name: "bash".into(),
                    arguments: serde_json::json!({"command": "rm -rf /"}),
                },
                true,
            )
            .unwrap_or_else(|e| panic!("{e}"));
        let recovered = recover(log.path()).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(recovered.unfinished_tool_calls, vec![seq]);
    }

    #[test]
    fn open_append_continues_sequence() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let log =
            SessionLog::create(dir.path(), "s-resume", meta()).unwrap_or_else(|e| panic!("{e}"));
        log.append(
            SessionEvent::UserMessage {
                message: saber_protocol::Message {
                    role: saber_protocol::Role::User,
                    blocks: vec![saber_protocol::Block::Text {
                        text: "first".into(),
                    }],
                },
            },
            false,
        )
        .unwrap_or_else(|e| panic!("{e}"));
        drop(log);

        let path = dir.path().join("s-resume.jsonl");
        let resumed = SessionLog::open_append(&path).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(resumed.session_id(), "s-resume");
        let seq = resumed
            .append(
                SessionEvent::Error {
                    message: "resumed".into(),
                },
                false,
            )
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(seq, 2, "sequence must continue from recovery");
        let recovered = recover(&path).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(recovered.events.len(), 3);
    }

    #[test]
    fn torn_tail_is_dropped_midfile_corrupt_is_error() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let log = SessionLog::create(dir.path(), "s-3", meta()).unwrap_or_else(|e| panic!("{e}"));
        log.append(
            SessionEvent::UserMessage {
                message: saber_protocol::Message {
                    role: saber_protocol::Role::User,
                    blocks: vec![saber_protocol::Block::Text { text: "hi".into() }],
                },
            },
            false,
        )
        .unwrap_or_else(|e| panic!("{e}"));
        // Simulate a torn tail: append half a JSON line.
        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(log.path())
                .unwrap_or_else(|e| panic!("{e}"));
            file.write_all(b"{\"ts\":123")
                .unwrap_or_else(|e| panic!("{e}"));
        }
        let recovered = recover(log.path()).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(recovered.events.len(), 2, "torn tail must be dropped");

        // Mid-file corruption stays an error.
        let bad = dir.path().join("bad.jsonl");
        std::fs::write(&bad, "{\"garbage\":true}\n{\"more\":1}\n")
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(recover(&bad).is_err());
    }
}
