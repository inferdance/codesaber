import { describe, it, expect } from "vitest";
import { createProviderFromEnv } from "../env.js";

describe("createProviderFromEnv", () => {
  it("rejects an invalid SABER_BASE_URL instead of silently defaulting", () => {
    expect(() => createProviderFromEnv({ SABER_OPENAI_KEY: "k", SABER_BASE_URL: "localhost:4000/v1" })).toThrow(/http\(s\) URL/);
    expect(() => createProviderFromEnv({ ANTHROPIC_API_KEY: "k", SABER_BASE_URL: "ftp://x" })).toThrow(/http\(s\) URL/);
  });

  it("uses the explicit endpoint when valid", () => {
    const built = createProviderFromEnv({ SABER_OPENAI_KEY: "k", SABER_BASE_URL: "http://127.0.0.1:9/v1" });
    expect(built?.provider.name).toBe("openai");
  });

  it("returns null with no keys set", () => {
    expect(createProviderFromEnv({})).toBeNull();
  });
});
