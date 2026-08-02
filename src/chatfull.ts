/**
 * chatFull — a chat call that survives output-cap truncation.
 *
 * Build/integrate responses are one big JSON of complete files; when the
 * model hits the output cap mid-JSON the parse fails ("unbalanced") and the
 * whole role burns its tokens for nothing. Instead, when the provider
 * reports truncation (finish_reason "length" / stop_reason "max_tokens"),
 * we ask the model to continue exactly where it stopped and concatenate —
 * up to `maxContinuations` extra calls.
 *
 * `chatFn` is injectable so tests can script truncated/final responses.
 */
import { chat, ChatOptions } from "./provider.js";
import { ChatMessage, ChatResult, ProviderConfig, Usage } from "./types.js";

export type ChatFn = (
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
) => Promise<ChatResult>;

const CONTINUE_PROMPT =
  "Continue exactly where you stopped. Output ONLY the remaining text — do not repeat anything, do not add commentary or fences.";

export const DEFAULT_MAX_CONTINUATIONS = 3;

export async function chatFull(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions = {},
  maxContinuations: number = DEFAULT_MAX_CONTINUATIONS,
  chatFn: ChatFn = chat,
): Promise<ChatResult> {
  let res = await chatFn(provider, model, messages, opts);
  const usage: Usage = { ...res.usage };
  let text = res.text;
  let continuations = 0;

  while (res.truncated && continuations < maxContinuations) {
    continuations++;
    res = await chatFn(
      provider,
      model,
      [...messages, { role: "assistant", content: text }, { role: "user", content: CONTINUE_PROMPT }],
      opts,
    );
    text += res.text;
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
  }
  return { text, usage, truncated: res.truncated };
}
