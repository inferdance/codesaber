import { createAnthropicProvider, createOpenAiProvider, type Provider } from "./index.js";

export interface ProviderFromEnv {
  provider: Provider;
  defaultModel: string;
}

/**
 * Builds a provider from the conventional environment (SABER_* overrides
 * first, then the standard API key vars), honoring SABER_BASE_URL for any
 * OpenAI/Anthropic-compatible endpoint. Returns null when no key is set.
 */
export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderFromEnv | null {
  const anthropic = env.SABER_ANTHROPIC_KEY ?? env.ANTHROPIC_API_KEY;
  const openai = env.SABER_OPENAI_KEY ?? env.OPENAI_API_KEY;
  // an explicitly-set but invalid endpoint must FAIL LOUD — silently
  // defaulting would send credentials and prompts to the public API
  const rawBase = env.SABER_BASE_URL;
  if (rawBase !== undefined && !/^https?:\/\//.test(rawBase)) {
    throw new Error(`SABER_BASE_URL must be an http(s) URL, got: ${rawBase}`);
  }
  const baseUrl = rawBase;
  if (anthropic) {
    return {
      provider: createAnthropicProvider({ baseUrl: baseUrl ?? "https://api.anthropic.com", apiKey: anthropic, defaultModel: "claude-sonnet-4-5-20250929" }),
      defaultModel: "claude-sonnet-4-5-20250929",
    };
  }
  if (openai) {
    return {
      provider: createOpenAiProvider({ name: "openai", baseUrl: baseUrl ?? "https://api.openai.com/v1", apiKey: openai, defaultModel: "gpt-4o" }),
      defaultModel: "gpt-4o",
    };
  }
  return null;
}
