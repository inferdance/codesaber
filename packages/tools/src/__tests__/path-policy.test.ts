import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createPathPolicy, checkRead, checkWrite } from "../path-policy.ts";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "saber-test-")); });

describe("path policy", () => {
  it("denies .ssh reads", () => {
    const policy = createPathPolicy(tmp, path.join(tmp, ".saber"));
    expect(checkRead(policy, path.join(process.env.HOME!, ".ssh/config"))).toBeTruthy();
  });

  it("denies .env reads in workspace", () => {
    const policy = createPathPolicy(tmp, path.join(tmp, ".saber"));
    expect(checkRead(policy, path.join(tmp, ".env"))).toBeTruthy();
    expect(checkRead(policy, path.join(tmp, ".env.production"))).toBeTruthy();
  });

  it("allows normal workspace reads", () => {
    const policy = createPathPolicy(tmp, path.join(tmp, ".saber"));
    expect(checkRead(policy, path.join(tmp, "src/main.ts"))).toBeNull();
  });

  it("denies writes outside workspace", () => {
    const policy = createPathPolicy(tmp, path.join(tmp, ".saber"));
    expect(checkWrite(policy, "/etc/passwd")).toBeTruthy();
    expect(checkWrite(policy, path.join(tmp, "file.txt"))).toBeNull();
  });

  it("catches .. escapes", () => {
    const policy = createPathPolicy(tmp, path.join(tmp, ".saber"));
    expect(checkWrite(policy, path.join(tmp, "sub/../../etc/passwd"))).toBeTruthy();
  });
});
