import { type Provider } from "@saber/ai";
export declare function getDataDir(): string;
export interface Auth {
    key: string;
    isAnthropic: boolean;
}
export declare function getApiKey(): Auth | null;
export declare function validatedBaseUrl(): string | undefined;
export interface ProviderSetup {
    provider: Provider;
    defaultModel: string;
}
export declare function buildProvider(auth: Auth, baseUrl?: string): ProviderSetup;
export declare const SYSTEM_PROMPT_HEADER = "You are saber, a coding agent. Be direct and surgical.";
export declare function systemPrompt(cwd: string): string;
//# sourceMappingURL=runtime.d.ts.map