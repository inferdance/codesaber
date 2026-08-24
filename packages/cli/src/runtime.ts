import { createOpenAiProvider, createAnthropicProvider, type Provider } from "@saber/ai";
import * as fs from "node:fs";
import * as path from "node:path";

export function getDataDir(): string {
  const dir = process.env.SABER_DATA_DIR ?? path.join(process.env.HOME ?? ".", ".codesaber");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface Auth {
  key: string;
  isAnthropic: boolean;
}

export function getApiKey(): Auth | null {
  const anthropic = process.env.SABER_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (anthropic) return { key: anthropic, isAnthropic: true };
  const openai = process.env.SABER_OPENAI_KEY ?? process.env.OPENAI_API_KEY;
  if (openai) return { key: openai, isAnthropic: false };
  return null;
}

export function validatedBaseUrl(): string | undefined {
  const baseUrl = process.env.SABER_BASE_URL;
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    console.error("error: SABER_BASE_URL must be an http(s) URL");
    process.exit(2);
  }
  return baseUrl;
}

export interface ProviderSetup {
  provider: Provider;
  defaultModel: string;
}

export function buildProvider(auth: Auth, baseUrl?: string): ProviderSetup {
  if (auth.isAnthropic) {
    return {
      provider: createAnthropicProvider({
        baseUrl: baseUrl ?? "https://api.anthropic.com",
        apiKey: auth.key,
        defaultModel: "claude-sonnet-4-5-20250929",
      }),
      defaultModel: "claude-sonnet-4-5-20250929",
    };
  }
  return {
    provider: createOpenAiProvider({
      name: "openai",
      baseUrl: baseUrl ?? "https://api.openai.com/v1",
      apiKey: auth.key,
      defaultModel: "gpt-4o",
    }),
    defaultModel: "gpt-4o",
  };
}

export const SYSTEM_PROMPT_HEADER = `You are saber, a coding agent. Be direct and surgical.`;

export function systemPrompt(cwd: string): string {
  return `${SYSTEM_PROMPT_HEADER}

# Environment
- cwd: ${cwd}
- platform: ${process.platform}

# Rules
- Read a file before editing it; use edit (not sed) for code changes.
- Prefer grep/glob to locate code over listing directories with bash.
- After changing code, verify with tests or a build via bash.
- Cite locations as path:line in your final answer.`;
}
