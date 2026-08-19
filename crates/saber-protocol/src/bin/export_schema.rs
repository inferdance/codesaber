//! Writes the committed JSON Schema artifact for the saber protocol:
//! `schema/saber-protocol.json` at the workspace root.
//!
//! Run after changing protocol types, then commit the artifact:
//!
//! ```sh
//! cargo run -p saber-protocol --bin saber-export-schema
//! ```
//!
//! CI enforces freshness via the `committed_schema_artifact_is_current`
//! test — the artifact and the Rust types can never silently drift.

use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let artifact = saber_protocol::schema_artifact_json();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../schema/saber-protocol.json");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, artifact)?;
    println!("wrote {}", path.display());
    Ok(())
}
