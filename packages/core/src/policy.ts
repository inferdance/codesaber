import * as path from "node:path";
import * as fs from "node:fs";

export const SECRET_HOME_DIRS = [".ssh", ".aws", ".gnupg", ".kube"] as const;
export const SECRET_SUFFIXES = [
  ".env", ".env.local", ".pem", "id_rsa", "id_ed25519",
  ".npmrc", ".netrc", ".git-credentials",
] as const;

export interface PathPolicy {
  writableRoots: string[];
  deniedReadPrefixes: string[];
  deniedReadSuffixes: string[];
}

export function createPathPolicy(workspaceRoot: string, dataDir: string): PathPolicy {
  const cwd = fs.realpathSync(workspaceRoot);
  fs.mkdirSync(dataDir, { recursive: true });
  const data = fs.realpathSync(dataDir);
  const home = process.env.HOME ?? ".";
  const deniedReadPrefixes: string[] = [];
  for (const dir of SECRET_HOME_DIRS) {
    const lexical = path.join(home, dir);
    try { deniedReadPrefixes.push(fs.realpathSync(lexical)); } catch { /* not present */ }
    deniedReadPrefixes.push(lexical);
  }
  return { writableRoots: [cwd, data], deniedReadPrefixes, deniedReadSuffixes: [...SECRET_SUFFIXES] };
}

/**
 * Component-level containment check using path.relative.
 * NOT startsWith (prefix bypass: /tmp/work-escape vs root /tmp/work).
 * NOT startsWith("..") (false positive: ..cache/ is a valid directory).
 */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

export function checkRead(policy: PathPolicy, target: string): string | null {
  const resolved = resolvePath(policy, target);
  const lexical = lexicalNormalize(policy, target);
  for (const candidate of [lexical, resolved]) {
    for (const prefix of policy.deniedReadPrefixes) {
      if (candidate.startsWith(prefix + path.sep) || candidate === prefix) {
        return `read denied: protected location ${prefix}`;
      }
    }
    const name = path.basename(candidate);
    for (const suffix of policy.deniedReadSuffixes) {
      if (name === suffix || name.startsWith(suffix) || name.endsWith(suffix)) {
        return `read denied: secret file pattern ${suffix}`;
      }
    }
  }
  return null;
}

export function checkWrite(policy: PathPolicy, target: string): string | null {
  const resolved = resolvePath(policy, target);
  for (const root of policy.writableRoots) {
    if (isInside(root, resolved)) return null;
  }
  return `write denied: ${resolved} is outside writable roots [${policy.writableRoots.join(", ")}]`;
}

function resolvePath(policy: PathPolicy, target: string): string {
  const absolute = path.isAbsolute(target) ? target : path.join(policy.writableRoots[0] ?? ".", target);
  const lexical = lexicalNormalize(policy, absolute);
  if (fs.existsSync(lexical)) return fs.realpathSync(lexical);
  let current = lexical;
  const remainder: string[] = [];
  while (!fs.existsSync(current) && current !== path.dirname(current)) {
    remainder.unshift(path.basename(current));
    current = path.dirname(current);
  }
  try { return path.join(fs.realpathSync(current), ...remainder); } catch { return lexical; }
}

function lexicalNormalize(policy: PathPolicy, target: string): string {
  const absolute = path.isAbsolute(target) ? target : path.join(policy.writableRoots[0] ?? ".", target);
  const parts: string[] = [];
  for (const part of absolute.split(path.sep)) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return path.sep + parts.join(path.sep);
}
