# @saber/sandbox

macOS Seatbelt (sandbox-exec) confinement for the bash tool.

**Status: deferred to M2** (plan amendment 7 in
`docs/superpowers/plans/2026-08-21-m0-ts-native.md`). The package exists so the
workspace layout matches the design; confinement lands with the approval
workflow it belongs to.

Planned scope:
- Seatbelt profile builder (`workspace-write-lite`: cwd + dataDir writable,
  secrets denied, network off in M0 profile)
- Wrapped execa invocation (`sandbox-exec -p <profile> -- <argv>`)
- "Sandbox denied" stderr fingerprint recognition for approval escalation
