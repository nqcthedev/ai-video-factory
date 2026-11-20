import { ProviderError, ProviderUnavailableError } from "../core/errors.js";
import { type FetchLike, httpJson } from "../core/http.js";
import type { Logger } from "../core/logger.js";
import { nullLogger } from "../core/logger.js";
import { RateLimiter, sharedLimiter } from "../core/rateLimiter.js";
import { withRetry } from "../core/retry.js";
import type { AppConfig, AppEnv } from "../config/schema.js";
import { toProviderError } from "../tts/providers.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

export interface LlmClient {
  readonly model: string;
  chat(messages: ChatMessage[], opts?: { json?: boolean; temperature?: number }): Promise<ChatResult>;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

/**
 * Chat client for any OpenAI-compatible endpoint. Gemini is used through
 * https://generativelanguage.googleapis.com/v1beta/openai/ (Bearer GEMINI_API_KEY).
 */
export class OpenAiCompatibleClient implements LlmClient {
  readonly model: string;
  private readonly limiter: RateLimiter;

  constructor(
    private readonly opts: {
      baseUrl: string;
      apiKey?: string;
      model: string;
      temperature: number;
      timeoutMs: number;
      reasoningEffort?: string;
      requestsPerMinute: number;
      providerName: string;
      fetch?: FetchLike;
      sleep?: (ms: number) => Promise<void>;
      logger?: Logger;
      retries?: number;
    },
  ) {
    this.model = opts.model;
    this.limiter = sharedLimiter(`llm:${opts.providerName}`, { maxPerMinute: opts.requestsPerMinute });
  }

  async chat(messages: ChatMessage[], o: { json?: boolean; temperature?: number } = {}): Promise<ChatResult> {
    if (!this.opts.apiKey) throw new ProviderUnavailableError(this.opts.providerName, "API key not set");
    const url = new URL("chat/completions", this.opts.baseUrl.endsWith("/") ? this.opts.baseUrl : `${this.opts.baseUrl}/`).toString();
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      temperature: o.temperature ?? this.opts.temperature,
    };
    if (o.json) body.response_format = { type: "json_object" };
    if (this.opts.reasoningEffort) body.reasoning_effort = this.opts.reasoningEffort;
    const log = this.opts.logger ?? nullLogger;
    try {
      const res = await withRetry(
        () =>
          this.limiter.schedule(() =>
            httpJson<ChatCompletionResponse>(url, {
              method: "POST",
              fetch: this.opts.fetch,
              timeoutMs: this.opts.timeoutMs,
              headers: { authorization: `Bearer ${this.opts.apiKey}` },
              body,
            }),
          ),
        {
          retries: this.opts.retries ?? 4,
          baseDelayMs: 3000,
          maxDelayMs: 90_000,
          sleep: this.opts.sleep,
          onRetry: ({ attempt, delayMs, error }) =>
            log.warn("llm request failed, backing off", { attempt, delayMs, error: (error as Error).message.slice(0, 200) }),
        },
      );
      const text = res.choices?.[0]?.message?.content ?? "";
      if (!text) throw new ProviderError(this.opts.providerName, `empty completion (finish_reason=${res.choices?.[0]?.finish_reason})`, { retryable: true });
      return {
        text,
        model: res.model ?? this.opts.model,
        usage: { promptTokens: res.usage?.prompt_tokens ?? 0, completionTokens: res.usage?.completion_tokens ?? 0 },
      };
    } catch (err) {
      throw toProviderError(this.opts.providerName, err);
    }
  }
}

export function createLlmClient(cfg: AppConfig["llm"], env: AppEnv, deps: { fetch?: FetchLike; logger?: Logger; sleep?: (ms: number) => Promise<void> } = {}): LlmClient {
  const isGemini = cfg.provider === "gemini";
  return new OpenAiCompatibleClient({
    baseUrl: cfg.baseUrl ?? (isGemini ? env.GEMINI_BASE_URL : env.OPENAI_BASE_URL),
    apiKey: isGemini ? env.GEMINI_API_KEY : env.OPENAI_API_KEY,
    model: cfg.model,
    temperature: cfg.temperature,
    timeoutMs: cfg.timeoutMs,
    reasoningEffort: cfg.reasoningEffort === undefined ? undefined : cfg.reasoningEffort,
    requestsPerMinute: cfg.requestsPerMinute,
    providerName: isGemini ? "gemini-llm" : "openai-llm",
    ...deps,
  });
}
