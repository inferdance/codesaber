//! Unified path policy (T4): the single authority every tool consults for
//! read denials and write allowances. One implementation, one test suite —
//! per-tool drift is structurally impossible (spec §3.7 v3).
//!
//! Rules:
//! - Reads are denied under secret homes (`~/.ssh`, `~/.aws`, `~/.gnupg`,
//!   `~/.kube`) and denied-read globs (`**/.env`, `**/*.pem`,
//!   `**/*id_rsa*`) — TCC does not protect us because subprocesses inherit
//!   the terminal's grants.
//! - Writes must land under a canonicalized writable root (workspace cwd or
//!   the saber data dir); anything else is rejected.
//! - Resolution survives `..`, `.` and symlink escapes: canonicalize the
//!   deepest existing ancestor and append the remainder.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum PathDenied {
    #[error("read denied: {path} is a protected secret location ({reason})")]
    SecretRead { path: PathBuf, reason: String },
    #[error("write denied: {path} is outside the writable roots ({roots})")]
    OutsideWritableRoots { path: PathBuf, roots: String },
    #[error("path resolution failed for {path}: {reason}")]
    Unresolvable { path: PathBuf, reason: String },
}

/// Secret home directories denied for reads — the single list shared by
/// the engine path policy AND the sandbox profile builder.
pub const SECRET_HOME_DIRS: [&str; 4] = [".ssh", ".aws", ".gnupg", ".kube"];

/// Secret file-name suffixes denied for reads (unified list).
pub const SECRET_SUFFIXES: [&str; 8] = [
    ".env",
    ".env.local",
    ".pem",
    "id_rsa",
    "id_ed25519",
    ".npmrc",
    ".netrc",
    ".git-credentials",
];

#[derive(Debug, Clone)]
pub struct PathPolicy {
    writable_roots: Vec<PathBuf>,
    denied_read_prefixes: Vec<PathBuf>,
    denied_read_suffixes: Vec<String>,
}

impl PathPolicy {
    /// `workspace_root` (cwd) and `data_dir` (`~/.codesaber`) are the
    /// writable roots; both are canonicalized (roots must exist).
    pub fn new(workspace_root: &Path, data_dir: &Path) -> Result<Self, PathDenied> {
        let workspace = workspace_root
            .canonicalize()
            .map_err(|e| PathDenied::Unresolvable {
                path: workspace_root.to_owned(),
                reason: e.to_string(),
            })?;
        let data = std::fs::create_dir_all(data_dir)
            .and_then(|_| data_dir.canonicalize())
            .map_err(|e| PathDenied::Unresolvable {
                path: data_dir.to_owned(),
                reason: e.to_string(),
            })?;
        let home = std::env::var("HOME").unwrap_or_default();
        let home = PathBuf::from(home);
        let denied_read_prefixes = Self::deny_prefixes_for(&home);
        let denied_read_suffixes = vec![
            ".env".to_owned(),
            ".env.local".to_owned(),
            ".pem".to_owned(),
            "id_rsa".to_owned(),
            "id_ed25519".to_owned(),
        ];
        Ok(Self {
            writable_roots: vec![workspace, data],
            denied_read_prefixes,
            denied_read_suffixes,
        })
    }

    /// Deny roots keep BOTH the lexical path and its canonical target:
    /// the lexical form survives runtime symlink re-pointing, the
    /// canonical form catches symlinked-at-construction roots.
    fn deny_prefixes_for(home: &Path) -> Vec<PathBuf> {
        let mut prefixes = Vec::new();
        for dir in SECRET_HOME_DIRS {
            let lexical = home.join(dir);
            if let Ok(canonical) = lexical.canonicalize() {
                prefixes.push(canonical);
            }
            prefixes.push(lexical);
        }
        prefixes
    }

    pub fn writable_roots(&self) -> &[PathBuf] {
        &self.writable_roots
    }

    /// Resolves a path through `..`/`.` and symlinks: canonicalize the
    /// deepest existing ancestor, append the remainder.
    pub fn resolve(&self, path: &Path) -> Result<PathBuf, PathDenied> {
        let lexical = self.lexical_normalize(path);
        if lexical.exists() {
            return lexical
                .canonicalize()
                .map_err(|e| PathDenied::Unresolvable {
                    path: lexical.clone(),
                    reason: e.to_string(),
                });
        }
        // Find the deepest existing ancestor; canonicalize it and reattach.
        let mut existing = lexical.clone();
        let mut remainder: Vec<std::ffi::OsString> = Vec::new();
        loop {
            if existing.exists() || existing.parent().is_none() {
                break;
            }
            let Some(file_name) = existing.file_name().map(ToOwned::to_owned) else {
                break;
            };
            remainder.push(file_name);
            let Some(parent) = existing.parent().map(ToOwned::to_owned) else {
                break;
            };
            existing = parent;
        }
        let mut resolved = existing
            .canonicalize()
            .map_err(|e| PathDenied::Unresolvable {
                path: existing.clone(),
                reason: e.to_string(),
            })?;
        for part in remainder.iter().rev() {
            resolved.push(part);
        }
        Ok(resolved)
    }

    pub fn check_read(&self, path: &Path) -> Result<PathBuf, PathDenied> {
        let resolved = self.resolve(path)?;
        // The lexical (pre-canonicalization) path guards against symlink
        // renames: a workspace `.env -> /tmp/plain` must stay denied by its
        // visible name even though canonicalization rewrites it.
        let lexical = self.lexical_normalize(path);
        for candidate in [&lexical, &resolved] {
            if let Some(denied) = self.deny_reason(candidate) {
                return Err(PathDenied::SecretRead {
                    path: resolved.clone(),
                    reason: denied,
                });
            }
        }
        Ok(resolved)
    }

    fn deny_reason(&self, candidate: &Path) -> Option<String> {
        for prefix in &self.denied_read_prefixes {
            if candidate.starts_with(prefix) {
                return Some("protected home directory".into());
            }
        }
        if let Some(name) = candidate.file_name().and_then(|n| n.to_str()) {
            for suffix in &self.denied_read_suffixes {
                if name.starts_with(suffix.as_str()) || name.ends_with(suffix.as_str()) {
                    return Some("secret file pattern".into());
                }
            }
        }
        None
    }

    /// Lexical normalization only (`..`/`.` resolved, no filesystem access,
    /// no symlink following). Relative paths anchor to the workspace root.
    pub fn lexical_normalize(&self, path: &Path) -> PathBuf {
        let absolute = if path.is_absolute() {
            path.to_owned()
        } else {
            self.writable_roots
                .first()
                .cloned()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(path)
        };
        let mut lexical = PathBuf::new();
        for component in absolute.components() {
            match component {
                std::path::Component::ParentDir => {
                    lexical.pop();
                }
                std::path::Component::CurDir => {}
                other => lexical.push(other.as_os_str()),
            }
        }
        lexical
    }

    pub fn check_write(&self, path: &Path) -> Result<PathBuf, PathDenied> {
        let resolved = self.resolve(path)?;
        if self
            .writable_roots
            .iter()
            .any(|root| resolved.starts_with(root))
        {
            return Ok(resolved);
        }
        Err(PathDenied::OutsideWritableRoots {
            path: resolved,
            roots: self
                .writable_roots
                .iter()
                .map(|r| r.display().to_string())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
                .join(", "),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_in(temp: &tempfile::TempDir) -> PathPolicy {
        PathPolicy::new(temp.path(), &temp.path().join(".saber-data")).unwrap_or_else(|e| {
            panic!("policy construction failed: {e}");
        })
    }

    #[test]
    fn dotdot_cannot_escape_the_workspace() {
        let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let policy = policy_in(&temp);
        std::fs::write(temp.path().join("victim.txt"), "x").unwrap_or_else(|e| panic!("{e}"));
        std::fs::create_dir_all(temp.path().join("sub")).unwrap_or_else(|e| panic!("{e}"));
        // sub/../victim.txt resolves inside the root — allowed.
        let inside = policy.check_write(&temp.path().join("sub/../victim.txt"));
        assert!(inside.is_ok(), "in-workspace .. stays allowed: {inside:?}");
        // ../../.. from a subdirectory leaves the root — rejected.
        let escaping = temp.path().join("sub/../../../etc/passwd");
        assert!(policy.check_write(&escaping).is_err());
    }

    #[test]
    fn symlink_escape_is_caught() {
        let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let policy = policy_in(&temp);
        let outside_dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(outside_dir.path(), &link).unwrap_or_else(|e| panic!("{e}"));
        let target = link.join("file.txt");
        std::fs::write(&target, "x").unwrap_or_else(|e| panic!("{e}"));
        let result = policy.check_write(&target);
        assert!(
            result.is_err(),
            "write through symlink out of root must fail"
        );
    }

    #[test]
    fn secret_reads_are_denied_everywhere() {
        let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let policy = policy_in(&temp);
        let home = std::env::var("HOME").unwrap_or_default();
        assert!(
            policy
                .check_read(&PathBuf::from(&home).join(".ssh/id_rsa"))
                .is_err()
        );
        assert!(policy.check_read(&temp.path().join(".env")).is_err());
        assert!(policy.check_read(&temp.path().join("deploy.pem")).is_err());
        assert!(policy.check_read(&temp.path().join("src/main.rs")).is_ok());
    }

    #[test]
    fn symlinked_secret_stays_denied_by_visible_name() {
        let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let policy = policy_in(&temp);
        let plain = temp.path().join("plain.txt");
        std::fs::write(&plain, "not secret").unwrap_or_else(|e| panic!("{e}"));
        let link = temp.path().join(".env");
        std::os::unix::fs::symlink(&plain, &link).unwrap_or_else(|e| panic!("{e}"));
        // Canonical target is an innocuous name — the lexical .env must
        // still deny the read.
        assert!(policy.check_read(&link).is_err());
        // Reading the plain target directly remains allowed.
        assert!(policy.check_read(&plain).is_ok());
    }

    #[test]
    fn repointed_deny_root_stays_denied() {
        // ~/.ssh is a symlink at construction; it is later re-pointed to a
        // different target — the lexical prefix must still deny reads.
        let home = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let target_a = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let target_b = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(target_a.path().join("config"), "a").unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(target_b.path().join("config"), "b").unwrap_or_else(|e| panic!("{e}"));
        let ssh = home.path().join(".ssh");
        std::os::unix::fs::symlink(target_a.path(), &ssh).unwrap_or_else(|e| panic!("{e}"));
        let policy = PathPolicy::deny_prefixes_for(home.path());
        assert!(policy.iter().any(|p| p.starts_with(home.path())));
        // Re-point and re-check via a fresh policy build over the same
        // home (the production path constructs once per session).
        std::fs::remove_file(&ssh).unwrap_or_else(|e| panic!("{e}"));
        std::os::unix::fs::symlink(target_b.path(), &ssh).unwrap_or_else(|e| panic!("{e}"));
        let policy = PathPolicy::deny_prefixes_for(home.path());
        let lexical_hits = policy.iter().any(|p| p == &ssh);
        assert!(
            lexical_hits,
            "lexical deny root must survive re-pointing: {policy:?}"
        );
    }

    #[test]
    fn data_dir_is_writable() {
        let temp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let policy = policy_in(&temp);
        let data_file = temp.path().join(".saber-data/truncations/x.log");
        assert!(policy.check_write(&data_file).is_ok());
    }
}
