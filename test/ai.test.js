import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { extractQuestions, rankFreeModels } from "../src/ai.js";

const MODELS = [
  { id: "meta-llama/llama-4-scout:free", context_length: 128000, architecture: { input_modalities: ["text", "image"] } },
  { id: "nvidia/nemotron-3.5-super-vl:free", context_length: 256000, architecture: { input_modalities: ["text", "image"] } },
  { id: "nvidia/nemotron-3-ultra:free", context_length: 1000000, architecture: { input_modalities: ["text"] } },
  { id: "openai/gpt-paid", context_length: 400000, pricing: { prompt: "0.00001", completion: "0.00003" } },
  { id: "tiny/model:free", context_length: 4000 },
  { id: "someone/new-reasoner:free", context_length: 200000, supported_parameters: ["reasoning"] },
];

test("rankFreeModels prefers strongest known free models and filters paid/tiny", () => {
  assert.deepEqual(rankFreeModels(MODELS), [
    "nvidia/nemotron-3.5-super-vl:free",
    "nvidia/nemotron-3-ultra:free",
    "meta-llama/llama-4-scout:free",
    "someone/new-reasoner:free",
  ]);
});

test("rankFreeModels for images keeps only vision models", () => {
  assert.deepEqual(rankFreeModels(MODELS, true), ["nvidia/nemotron-3.5-super-vl:free", "meta-llama/llama-4-scout:free"]);
});

const GOOD = JSON.stringify({ choices: [{ message: { content: '{"questions":[{"question":"q","options":["a","b"],"correct":1}]}' } }] });
let calls;
function mockFetch(nvidiaReply) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: MODELS }));
    if (String(url).includes("nvidia")) return nvidiaReply();
    return new Response(GOOD);
  };
}
const env = { NVIDIA_API_KEY: "n", OPENROUTER_API_KEY: "o" };

test("NVIDIA ok: OpenRouter is not called", async () => {
  mockFetch(() => new Response(GOOD));
  const q = await extractQuestions(env, "text");
  assert.equal(q.length, 1);
  assert.ok(calls.every((c) => !c.url.includes("openrouter")));
});

test("NVIDIA error: falls back to OpenRouter's best free models", async () => {
  mockFetch(() => new Response("boom", { status: 500 }));
  const q = await extractQuestions(env, "text");
  assert.equal(q[0].correct, 1);
  const or = calls.find((c) => c.url.endsWith("openrouter.ai/api/v1/chat/completions"));
  assert.deepEqual(or.body.models, ["nvidia/nemotron-3.5-super-vl:free", "nvidia/nemotron-3-ultra:free", "meta-llama/llama-4-scout:free"]);
});

test("NVIDIA returns garbage: also falls back", async () => {
  mockFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: "sorry, no" } }] })));
  assert.equal((await extractQuestions(env, "text")).length, 1);
});

test("only OpenRouter key: uses OpenRouter directly", async () => {
  mockFetch(() => { throw new Error("should not call NVIDIA"); });
  assert.equal((await extractQuestions({ OPENROUTER_API_KEY: "o" }, "text")).length, 1);
});

test("both fail: error is retryable and mentions both", async () => {
  calls = [];
  globalThis.fetch = async (url) => String(url).endsWith("/models")
    ? new Response(JSON.stringify({ data: MODELS }))
    : new Response("busy", { status: 429 });
  await assert.rejects(extractQuestions(env, "t"), (e) => e.retryable === true && /NVIDIA 429/.test(e.message) && /OpenRouter 429/.test(e.message));
});
