/**
 * Provider layer — talks to OpenAI-compatible chat completions APIs,
 * the Anthropic messages API, or an offline deterministic mock.
 * Zero dependencies: uses global fetch (Node >= 18).
 */
import { ChatMessage, ChatResult, ProviderConfig, Usage } from "./types.js";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
  }
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** Total wall-clock budget for one chat call including retries. */
  timeoutMs?: number;
  /** Called before each retry wait, e.g. for logging. */
  onRetry?: (attempt: number, waitMs: number, reason: string) => void;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error;
    if (e.name === "AbortError") {
      throw new ProviderError(`Request to ${url} timed out after ${timeoutMs} ms.`, undefined, true);
    }
    throw new ProviderError(`Network error calling ${url}: ${e.message}`, undefined, true);
  }
  clearTimeout(timer);

  let json: unknown;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError(
      `Non-JSON response from ${url} (HTTP ${res.status}): ${text.slice(0, 300)}`,
      res.status,
      res.status >= 500,
    );
  }
  return { status: res.status, json };
}

function extractApiError(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const err = (json as Record<string, unknown>).error;
  if (typeof err === "object" && err !== null) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string") return msg;
  }
  if (typeof err === "string") return err;
  return undefined;
}

async function openAiChat(
  provider: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<ChatResult> {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const { status, json } = await postJson(
    url,
    { authorization: `Bearer ${apiKey}` },
    {
      model,
      messages,
      ...(opts.maxTokens ? { max_completion_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const apiErr = extractApiError(json);
  if (status < 200 || status >= 300 || apiErr) {
    const retryable = status === 429 || status >= 500;
    throw new ProviderError(
      `OpenAI-style API error (HTTP ${status})${apiErr ? `: ${apiErr}` : ""}`,
      status,
      retryable,
    );
  }

  const root = json as Record<string, unknown>;
  const choices = root.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content !== "string") {
    throw new ProviderError(`Unexpected OpenAI-style response shape: no choices[0].message.content.`);
  }
  const u = (root.usage ?? {}) as Record<string, unknown>;
  const usage: Usage = {
    inputTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
    outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
  };
  return { text: content, usage };
}

async function anthropicChat(
  provider: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<ChatResult> {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const convo = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const { status, json } = await postJson(
    url,
    { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    {
      model,
      max_tokens: opts.maxTokens ?? 8192,
      ...(system ? { system } : {}),
      messages: convo,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const apiErr = extractApiError(json);
  if (status < 200 || status >= 300 || apiErr) {
    const retryable = status === 429 || status >= 500;
    throw new ProviderError(
      `Anthropic API error (HTTP ${status})${apiErr ? `: ${apiErr}` : ""}`,
      status,
      retryable,
    );
  }

  const root = json as Record<string, unknown>;
  const content = root.content as Array<Record<string, unknown>> | undefined;
  const text = content?.map((b) => (typeof b.text === "string" ? b.text : "")).join("") ?? "";
  if (!text) throw new ProviderError("Unexpected Anthropic response shape: empty content.");
  const u = (root.usage ?? {}) as Record<string, unknown>;
  const usage: Usage = {
    inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
    outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
  };
  return { text, usage };
}

/** Rough local token estimate — used when an API does not return usage. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export type MockResponder = (model: string, messages: ChatMessage[]) => string;

/** Registered mock responder — set by the mock module / tests. */
let mockResponder: MockResponder | undefined;
export function setMockResponder(fn: MockResponder): void {
  mockResponder = fn;
}

async function mockChat(model: string, messages: ChatMessage[]): Promise<ChatResult> {
  if (!mockResponder) {
    throw new ProviderError("Mock provider selected but no mock responder is registered.");
  }
  const text = mockResponder(model, messages);
  return {
    text,
    usage: {
      inputTokens: estimateTokens(messages.map((m) => m.content).join("\n")),
      outputTokens: estimateTokens(text),
    },
  };
}

/**
 * Chat with retry + exponential backoff for transient failures (429/5xx/network).
 */
export async function chat(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const apiKey = provider.apiKeyEnv ? (process.env[provider.apiKeyEnv] ?? "") : "";
  if (provider.apiStyle !== "mock" && !apiKey) {
    throw new ProviderError(
      `Missing API key for provider "${provider.name}" — set ${provider.apiKeyEnv}.`,
    );
  }

  let attempt = 0;
  let lastErr: ProviderError | undefined;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      switch (provider.apiStyle) {
        case "openai":
          return await openAiChat(provider, apiKey, model, messages, opts);
        case "anthropic":
          return await anthropicChat(provider, apiKey, model, messages, opts);
        case "mock":
          return await mockChat(model, messages);
      }
    } catch (err) {
      const e = err as ProviderError;
      lastErr = e;
      if (!e.retryable || attempt >= MAX_ATTEMPTS) break;
      const waitMs = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      opts.onRetry?.(attempt, waitMs, e.message);
      await sleep(waitMs);
    }
  }
  throw lastErr ?? new ProviderError("Unknown provider error.");
}
