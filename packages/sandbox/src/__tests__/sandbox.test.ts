import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execa } from "execa";
import { buildSeatbeltProfile, confineArgv, sandboxExecWorks } from "../index.js";

const mac = process.platform === "darwin" && sandboxExecWorks();
const sandboxed = describe.skipIf(!mac);

describe("buildSeatbeltProfile", () => {
  it("embeds writable roots and denies everything else", () => {
    const profile = buildSeatbeltProfile({ writableRoots: ["/tmp/a", "/tmp/b"] });
    // nonexistent roots fall back to their lexical path
    expect(profile).toContain('(allow file-write* (subpath "/tmp/a"))');
    expect(profile).toContain('(allow file-write* (subpath "/tmp/b"))');
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain("(deny network*)");
  });
});

describe("confineArgv", () => {
  it("wraps argv when confinement is available, null otherwise", () => {
    const wrapped = confineArgv(["bash", "-c", "true"], { writableRoots: ["/tmp"] });
    if (mac) {
      expect(wrapped?.[0]).toBe("sandbox-exec");
      expect(wrapped?.slice(-3)).toEqual(["bash", "-c", "true"]);
    } else {
      expect(wrapped).toBeNull();
    }
  });
});

let workspace: string;
beforeAll(() => { workspace = mkdtempSync(path.join(tmpdir(), "saber-sbx-")); });
afterAll(() => { rmSync(workspace, { recursive: true, force: true }); });

sandboxed("confined bash (macOS sandbox-exec)", () => {
  const run = (command: string) => {
    const argv = confineArgv(["bash", "-c", command], { writableRoots: [workspace, tmpdir()] });
    if (!argv) throw new Error("sandbox unavailable");
    return execa(argv[0], argv.slice(1), { reject: false, timeout: 15_000 });
  };

  it("allows writes inside the workspace", async () => {
    const result = await run(`echo sandboxed-ok > ${workspace}/inside.txt`);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(path.join(workspace, "inside.txt"), "utf-8")).toContain("sandboxed-ok");
  });

  it("denies writes outside the writable roots", async () => {
    const outside = path.join("/private/var/tmp", `saber-deny-${Date.now()}.txt`);
    const result = await run(`echo evil > ${outside}`);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(outside)).toBe(false);
  });

  it("denies network egress", async () => {
    const result = await run(`curl -sS -m 3 http://example.com/`);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/operation not permitted|denied|could not resolve/i);
  });
});
