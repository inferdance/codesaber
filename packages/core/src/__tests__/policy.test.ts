import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createPathPolicy, checkRead, checkWrite, isInside } from "../policy.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "saber-")); });

describe("path policy", () => {
  it("denies .ssh reads", () => {
    const p = createPathPolicy(tmp, path.join(tmp, ".saber"));
    expect(checkRead(p, path.join(process.env.HOME!, ".ssh/config"))).toBeTruthy();
  });

  it("denies .env in workspace", () => {
    const p = createPathPolicy(tmp, path.join(tmp, ".saber"));
    expect(checkRead(p, path.join(tmp, ".env"))).toBeTruthy();
    expect(checkRead(p, path.join(tmp, ".env.production"))).toBeTruthy();
  });

  it("allows normal reads", () => {
    const p = createPathPolicy(tmp, path.join(tmp, ".saber"));
    expect(checkRead(p, path.join(tmp, "src/main.ts"))).toBeNull();
  });

  it("denies writes outside workspace", () => {
    const p = createPathPolicy(tmp, path.join(tmp, ".saber"));
    expect(checkWrite(p, "/etc/passwd")).toBeTruthy();
    expect(checkWrite(p, path.join(tmp, "file.txt"))).toBeNull();
  });

  it("isInside rejects prefix bypass but not sibling names", () => {
    expect(isInside("/tmp/work", "/tmp/work-escape")).toBe(false);
    expect(isInside("/tmp/work", "/tmp/work/file.txt")).toBe(true);
    expect(isInside("/tmp/work", "/tmp/work")).toBe(true);
    expect(isInside("/tmp/work", "/tmp/work/../etc")).toBe(false);
  });
});
