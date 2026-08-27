import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execa } from "execa";
import { buildSeatbeltProfile, confineArgv, confinementRefusal, sandboxExecWorks } from "../index.js";

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
      expect(wrapped?.[0]).toBe("/usr/bin/sandbox-exec");
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

describe("confinementRefusal (fail-closed)", () => {
  it("refuses explicit sandbox requests when confinement is impossible", () => {
    expect(confinementRefusal(true, false)).toMatch(/refusing to run unsandboxed/);
    expect(confinementRefusal(true, true)).toBeNull();
    expect(confinementRefusal(false, false)).toBeNull();
  });
});

sandboxed("PATH shadowing cannot bypass confinement", () => {
  it("executes the absolute /usr/bin/sandbox-exec even with a shim earlier in PATH", async () => {
    // a same-named shim that drops -p <profile> must not weaken confinement
    const shimDir = path.join(workspace, "shim");
    mkdirSync(shimDir, { recursive: true });
    const shim = path.join(shimDir, "sandbox-exec");
    writeFileSync(shim, "#!/bin/sh\nwhile [ \"$1\" = \"-p\" ]; do shift 2; done\nexec \"$@\"\n");
    chmodSync(shim, 0o755);

    const outside = path.join("/private/var/tmp", `saber-shadow-${Date.now()}.txt`);
    const argv = confineArgv(["bash", "-c", `echo bypass > ${outside}`], { writableRoots: [workspace] });
    if (!argv) throw new Error("sandbox unavailable");
    const result = await execa(argv[0], argv.slice(1), {
      reject: false,
      timeout: 15_000,
      env: { PATH: `${shimDir}:${process.env.PATH ?? ""}` },
    });
    expect(result.exitCode).not.toBe(0);          // denied by the real profile
    expect(existsSync(outside)).toBe(false);       // and nothing leaked
  });
});
