import { test } from "node:test";
import assert from "node:assert/strict";
import { chatFull, ChatFn } from "../src/chatfull.js";
import { parseAgentOutput } from "../src/fileops.js";
import { ChatMessage, ChatResult, ProviderConfig } from "../src/types.js";

const provider: ProviderConfig = {
  name: "anthropic",
  apiStyle: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  maxOutput: 16_384,
};

const messages: ChatMessage[] = [
  { role: "system", content: "You are an agent." },
  { role: "user", content: "Build the thing." },
];

/** A scripted chat function: plays back results, records every call. */
function scriptedChat(results: ChatResult[]): { fn: ChatFn; calls: ChatMessage[][] } {
  const queue = [...results];
  const calls: ChatMessage[][] = [];
  return {
    fn: async (_p, _m, msgs) => {
      if (queue.length === 0) throw new Error("chatFull made more calls than scripted");
      calls.push(msgs);
      return queue.shift()!;
    },
    calls,
  };
}

const res = (text: string, truncated = false, input = 10, output = 100): ChatResult => ({
  text,
  truncated,
  usage: { inputTokens: input, outputTokens: output },
});

test("chatFull: a normal (non-truncated) reply is a single call", async () => {
  const { fn, calls } = scriptedChat([res('{"summary":"done","ops":[]}')]);
  const out = await chatFull(provider, "claude-sonnet-5", messages, {}, 3, fn);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], messages, "first call gets the original messages untouched");
  assert.equal(out.truncated, false);
  assert.equal(out.text, '{"summary":"done","ops":[]}');
  assert.deepEqual(out.usage, { inputTokens: 10, outputTokens: 100 });
});

test("chatFull: truncation triggers a continuation and the halves stitch into valid JSON", async () => {
  const half1 = '{"summary":"built the api","ops":[{"type":"write","path":"server/a.js","content":"con';
  const half2 = 'sole.log(1)"}],"notes":[]}';
  const { fn, calls } = scriptedChat([res(half1, true, 100, 16_000), res(half2, false, 50, 400)]);

  const out = await chatFull(provider, "claude-sonnet-5", messages, {}, 3, fn);

  assert.equal(calls.length, 2);
  // Continuation call: original messages + assistant(so-far text) + "continue" user prompt.
  assert.equal(calls[1]!.length, messages.length + 2);
  assert.deepEqual(calls[1]!.slice(0, messages.length), messages);
  assert.equal(calls[1]![messages.length]!.role, "assistant");
  assert.equal(calls[1]![messages.length]!.content, half1, "assistant turn carries the text so far");
  assert.equal(calls[1]![messages.length + 1]!.role, "user");
  assert.match(calls[1]![messages.length + 1]!.content, /continue/i);

  assert.equal(out.text, half1 + half2);
  assert.equal(out.truncated, false);
  // The stitched JSON must actually parse as agent output — this was the real-world failure.
  const parsed = parseAgentOutput(out.text);
  assert.equal(parsed.summary, "built the api");
  assert.equal(parsed.ops.length, 1);
  // Usage is summed across all calls (that's what the user pays for).
  assert.deepEqual(out.usage, { inputTokens: 150, outputTokens: 16_400 });
});

test("chatFull: a model that keeps truncating stops after maxContinuations", async () => {
  const { fn, calls } = scriptedChat([res("a", true), res("b", true), res("c", true), res("d", true)]);
  const out = await chatFull(provider, "claude-sonnet-5", messages, {}, 3, fn);

  assert.equal(calls.length, 4, "1 initial + 3 continuations, then it gives up");
  assert.equal(out.text, "abcd");
  assert.equal(out.truncated, true, "caller still sees the output is incomplete");
});
