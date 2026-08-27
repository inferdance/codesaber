import { existsSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";

export interface SeatbeltOptions {
  /** Directories the confined command may write to (cwd, data dir). */
  writableRoots: string[];
}

export function seatbeltAvailable(): boolean {
  return process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}

/**
 * workspace-write-lite profile: everything allowed EXCEPT writes outside the
 * roots and all network. Read-mostly keeps bash functional; the two things a
 * coding agent must not do silently — clobber the machine and phone home —
 * are the two things denied. (dsh's stance, one notch stricter on write.)
 */
export function buildSeatbeltProfile(options: SeatbeltOptions): string {
  // Seatbelt matches resolved paths — /var/folders is a symlink to
  // /private/var/folders, so roots must be realpathed (same invariant as
  // the core path policy).
  const real = (root: string): string => {
    try { return realpathSync(root); } catch { return root; } // not created yet
  };
  const writes = options.writableRoots
    .map((root) => `(allow file-write* (subpath "${escapeRoot(real(root))}"))`)
    .join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    writes,
    "(deny network*)",
  ].join("\n");
}

/**
 * Wraps argv with sandbox-exec when available; returns null when the host
 * cannot confine (non-macOS or missing binary) so callers run unsandboxed
 * rather than broken.
 */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function confineArgv(argv: string[], options: SeatbeltOptions): string[] | null {
  if (!seatbeltAvailable()) return null;
  // absolute path: a same-named shim earlier in PATH must not be able to
  // drop the -p profile and run the command unconstrained
  return [SANDBOX_EXEC, "-p", buildSeatbeltProfile(options), ...argv];
}

/**
 * Fail-closed gate for explicit confinement requests: when the user asked
 * for a sandbox the command must NOT silently run unsandboxed. Returns an
 * error message when refused, null when confining can proceed.
 */
export function confinementRefusal(requested: boolean, available: boolean): string | null {
  if (!requested) return null;
  if (!available) {
    // availability already encodes platform (sandbox-exec is macOS-only)
    return "SABER_SANDBOX=1 set but sandbox-exec confinement is unavailable on this host; refusing to run unsandboxed";
  }
  return null;
}

/** Escapes a path for the SBPL string literal. */
function escapeRoot(root: string): string {
  return root.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Probe used once per process to avoid shelling out repeatedly. */
let probed: boolean | false | null = null;
export function sandboxExecWorks(): boolean {
  if (probed !== null) return probed === true;
  if (!seatbeltAvailable()) {
    probed = false;
    return false;
  }
  try {
    execSync('/usr/bin/sandbox-exec -p "(version 1)(allow default)" true', { stdio: "ignore" });
    probed = true;
  } catch {
    probed = false;
  }
  return probed === true;
}
