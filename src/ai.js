// Turns raw question text (or a picture of questions) into the bot's JSON format.
//
// Providers, tried in order (change with the AI_ORDER variable, e.g. "nvidia,openrouter,workers-ai"):
//   1. OpenRouter (OPENROUTER_API_KEY) – the best *free* model currently available,
//      picked at runtime from OpenRouter's live model list.
//   2. NVIDIA  (NVIDIA_API_KEY)      – z-ai/glm-5.3-flash by default
//   3. Cloudflare Workers AI (the "AI" binding) – last resort, uses the free daily allowance.
//      Text only (photos/scans need one of the first two).
// Both speak the OpenAI-compatible /chat/completions format.

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_MODEL = "z-ai/glm-5.3-flash";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Free OpenRouter models we prefer, strongest first (matched against the live list, so
// models that disappear are skipped automatically). Based on Nov 2026 free-model tests:
// Nemotron 3.5 Super VL passed every JSON-extraction task and also reads images.
const OPENROUTER_PREFERRED = [
  /nemotron-3\.5-super-vl/i,
  /nemotron-3-ultra/i,
  /qwen-?3\.8/i,
  /deepseek/i,
  /glm/i,
  /qwen/i,
  /llama/i,
];

const SYSTEM_PROMPT = `You are an expert teacher of the Russian language (grammar, spelling, punctuation, vocabulary, stress, morphology, syntax, literature).
You receive raw, messy text containing multiple-choice test questions. Your job:
1. Find every question in the text. Keep the question wording and the answer options exactly as written (fix only obvious broken whitespace). Do not translate.
2. Remove option labels such as "А)", "Б.", "a)", "1)", "-" from the start of each option — the bot adds its own.
3. Decide which option is correct. If the text already marks the answer (e.g. "Ответ: Б", "*", "+", "(correct)", or text wrapped in **double asterisks** which means it was bold/highlighted in the original document), use that mark unless it is clearly wrong. Otherwise solve the question yourself, carefully, using the rules of Russian.
4. Write a short explanation (max 180 characters, in Russian) of the rule that makes the answer correct.
5. Rate your confidence: "high", "medium" or "low".
Skip text fragments that are not complete questions (for example a question whose options are cut off). Never invent questions.

Answer with JSON only, no markdown fences, exactly in this shape:
{"questions":[{"question":"...","options":["...","..."],"correct":0,"explanation":"...","confidence":"high"}]}
"correct" is the 0-based index of the right option in "options".`;

const IMAGE_INSTRUCTION =
  "The attached image is a photo or scan of a page with multiple-choice questions. Read ALL the text on it carefully (it is usually Russian; marks like ticks, circles, underlines or highlighted options may show the right answer). Then extract the questions as instructed.";

/**
 * @returns {Promise<Array<{question:string,options:string[],correct:number,explanation?:string,confidence?:string}>>}
 */
export function extractQuestions(env, text) {
  return withFallback(env, { userContent: `Questions:\n\n${text}`, vision: false });
}

/** Same as extractQuestions, but the questions are in a picture (photo or scanned page). */
export function extractQuestionsFromImage(env, bytes, mime = "image/jpeg") {
  const url = `data:${mime};base64,${toBase64(bytes)}`;
  return withFallback(env, {
    userContent: [{ type: "text", text: IMAGE_INSTRUCTION }, { type: "image_url", image_url: { url } }],
    vision: true,
  });
}

// If a provider times out / is overloaded, skip it for a while so every part doesn't
// wait for it again. (Per worker instance; resets on redeploy.)
const PAUSE_MS = 10 * 60_000;
const pausedUntil = {};
export const isPaused = (name) => (pausedUntil[name] || 0) > Date.now();
export const nextUtcMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
/** OpenRouter's "free-models-per-day" cap (50/day without purchased credits, 1000/day with). */
export const isDailyLimit = (text) => /per-day|per day|daily limit|free_daily/i.test(String(text || ""));
export const resetPauses = () => { for (const k of Object.keys(pausedUntil)) delete pausedUntil[k]; };

/** Try OpenRouter, then NVIDIA. Bad JSON from a model also counts as a failure. */
async function withFallback(env, { userContent, vision }) {
  const errors = [];
  const all = providers(env, vision);
  // Skip paused providers, unless that would leave nothing to try.
  const usable = all.filter((p) => !isPaused(p.name));
  for (const provider of usable.length ? usable : all) {
    try {
      await provider.resolve?.();
      const { content } = await chat(provider, userContent);
      return parseModelJson(content);
    } catch (e) {
      console.error(`${provider.name} failed:`, e?.message);
      if (e.dailyLimit) pausedUntil[provider.name] = nextUtcMidnight(); // no point retrying today
      else if (e.overloaded && all.length > 1) pausedUntil[provider.name] = Date.now() + PAUSE_MS;
      errors.push(e);
    }
  }
  if (!errors.length) throw Object.assign(new Error("No AI key is set (NVIDIA_API_KEY or OPENROUTER_API_KEY)."), { retryable: false });
  const err = new Error(errors.map((e) => e.message).join(" | ").slice(0, 600));
  // Retry later if any provider failed for a temporary reason (rate limit, timeout, 5xx, bad JSON).
  err.retryable = errors.some((e) => e.retryable !== false);
  throw err;
}

/** The providers to try, in order. OpenRouter's model list is only fetched if it's actually needed. */
export function providers(env, vision = false) {
  const list = [];
  if (env.NVIDIA_API_KEY) {
    list.push({
      name: "NVIDIA",
      baseUrl: env.NVIDIA_BASE_URL || NVIDIA_BASE_URL,
      key: env.NVIDIA_API_KEY,
      models: [(vision && env.NVIDIA_VISION_MODEL) || env.NVIDIA_MODEL || NVIDIA_MODEL],
      timeoutMs: Number(env.NVIDIA_TIMEOUT_MS) || 120_000,
    });
  }
  if (env.OPENROUTER_API_KEY) {
    const provider = {
      name: "OpenRouter",
      baseUrl: env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
      key: env.OPENROUTER_API_KEY,
      models: env.OPENROUTER_MODEL ? [env.OPENROUTER_MODEL] : [],
      timeoutMs: Number(env.OPENROUTER_TIMEOUT_MS) || 180_000,
      extraHeaders: { "X-Title": "QuizBot" },
      async resolve() {
        if (provider.models.length) return;
        try {
          provider.models = await bestFreeOpenRouterModels(env, vision);
        } catch (e) {
          throw Object.assign(new Error(`OpenRouter: could not load the model list (${e?.message || e})`), { retryable: true });
        }
        if (!provider.models.length) {
          throw Object.assign(new Error(`OpenRouter: no free ${vision ? "image-reading " : ""}model available right now`), { retryable: true });
        }
      },
    };
    list.push(provider);
  }
  if (env.AI?.run && !vision && env.WORKERS_AI_MODEL !== "off") {
    list.push({
      name: "Workers AI",
      workersAi: env.AI,
      models: [env.WORKERS_AI_MODEL || WORKERS_AI_MODEL],
      timeoutMs: 180_000,
    });
  }
  const order = String(env.AI_ORDER || "openrouter,nvidia,workers-ai").toLowerCase().split(",").map((x) => x.trim());
  const pos = (p) => { const i = order.indexOf(p.name.toLowerCase().replace(/\s+/g, "-")); return i === -1 ? order.length : i; };
  return list.sort((a, b) => pos(a) - pos(b));
}

/** True if an error text means "the AI services are busy", not "something is broken". */
export function isOverloadError(text) {
  return /\b(429|5\d\d)\b|no answer within|unreachable|overload|busy|rate.?limit|no free .*model available|could not load the model list/i.test(String(text || ""));
}

let freeModelsCache = null; // { at, models }

/**
 * The strongest free OpenRouter models right now (up to 3, used as OpenRouter's own
 * fallback list: if the first is rate-limited it tries the next).
 */
export async function bestFreeOpenRouterModels(env, vision = false) {
  if (!freeModelsCache || Date.now() - freeModelsCache.at > 6 * 3600_000) {
    const res = await fetch(`${env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL}/models`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`OpenRouter /models ${res.status}`);
    const { data } = await res.json();
    freeModelsCache = { at: Date.now(), models: data || [] };
  }
  return rankFreeModels(freeModelsCache.models, vision).slice(0, 3);
}

/** Pure ranking helper (exported for tests). */
export function rankFreeModels(models, vision = false) {
  const isFree = (m) =>
    m.id?.endsWith(":free") || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0 && !m.id?.startsWith("openrouter/"));
  // e.g. input_modalities: ["text","image"]  or  modality: "text+image->text"
  const canSeeImages = (m) => (m.architecture?.input_modalities || []).includes("image") || /image.*->/.test(m.architecture?.modality || "");
  const rank = (m) => {
    const i = OPENROUTER_PREFERRED.findIndex((re) => re.test(m.id));
    return i === -1 ? OPENROUTER_PREFERRED.length : i;
  };
  const reasoning = (m) => ((m.supported_parameters || []).includes("reasoning") ? 1 : 0);
  return models
    .filter((m) => isFree(m) && (m.context_length || 0) >= 16_000 && (!vision || canSeeImages(m)))
    .sort((a, b) =>
      rank(a) - rank(b) ||
      reasoning(b) - reasoning(a) ||
      (b.context_length || 0) - (a.context_length || 0) ||
      (b.created || 0) - (a.created || 0))
    .map((m) => m.id);
}

/** One chat completion. Returns { content, model, ms }. */
async function chat(provider, userContent, { maxTokens = 16000, system = SYSTEM_PROMPT, timeoutMs } = {}) {
  const limit = timeoutMs || provider.timeoutMs || 300_000;
  if (provider.workersAi) return chatWorkersAi(provider, userContent, { maxTokens, system, limit });
  const body = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: maxTokens,
    stream: false,
  };
  // OpenRouter accepts a list of models and falls back between them itself.
  if (provider.models.length > 1) body.models = provider.models;
  else body.model = provider.models[0];

  const started = Date.now();
  let res;
  try {
    res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(limit),
      headers: {
        Authorization: `Bearer ${provider.key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(provider.extraHeaders || {}),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    throw Object.assign(
      new Error(`${provider.name}: ${timedOut ? `no answer within ${Math.round(limit / 1000)}s` : `unreachable (${e?.message || e})`}`),
      { retryable: true, overloaded: timedOut },
    );
  }
  const text = await res.text();
  if (!res.ok) {
    // 429 / 5xx are temporary; 4xx (bad key, bad model, image too big) are not.
    throw Object.assign(new Error(`${provider.name} ${res.status}: ${text.slice(0, 250)}`), {
      retryable: res.status === 429 || res.status >= 500,
      overloaded: res.status === 429 || res.status >= 500,
      dailyLimit: res.status === 429 && isDailyLimit(text),
    });
  }
  const data = JSON.parse(text);
  if (data?.error) throw Object.assign(new Error(`${provider.name}: ${JSON.stringify(data.error).slice(0, 250)}`), { retryable: true });
  return {
    content: data?.choices?.[0]?.message?.content ?? "",
    model: data?.model || provider.models[0],
    ms: Date.now() - started,
  };
}

/** Cloudflare Workers AI through the AI binding (no key needed; free daily allowance). */
async function chatWorkersAi(provider, userContent, { maxTokens, system, limit }) {
  const started = Date.now();
  const run = provider.workersAi.run(provider.models[0], {
    messages: [
      { role: "system", content: system },
      { role: "user", content: typeof userContent === "string" ? userContent : userContent.map((c) => c.text || "").join("\n") },
    ],
    max_tokens: Math.min(maxTokens, 8000),
    temperature: 0.2,
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${provider.name}: no answer within ${Math.round(limit / 1000)}s`), { retryable: true, overloaded: true })), limit);
  });
  let r;
  try {
    r = await Promise.race([run, timeout]);
  } catch (e) {
    if (e?.retryable !== undefined) throw e;
    const msg = String(e?.message || e);
    throw Object.assign(new Error(`${provider.name}: ${msg.slice(0, 250)}`), {
      retryable: true,
      overloaded: true,
      dailyLimit: /neuron|daily|allocation|limit/i.test(msg),
    });
  } finally {
    clearTimeout(timer);
  }
  const out = r?.response ?? r?.choices?.[0]?.message?.content ?? r?.result?.response ?? "";
  return { content: typeof out === "string" ? out : JSON.stringify(out), model: provider.models[0], ms: Date.now() - started };
}

/** OpenRouter key info (does NOT use one of the daily free requests). */
async function openRouterKeyInfo(env) {
  const res = await fetch(`${env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL}/key`, {
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text).data || {};
}

/** Tiny request per provider, used by /check: is the key valid, which model, how fast. */
export async function pingProviders(env) {
  const out = [];
  for (const provider of providers(env)) {
    if (provider.name === "OpenRouter") {
      // Check the key without spending one of the (few) free daily requests.
      try {
        const info = await openRouterKeyInfo(env);
        await provider.resolve?.();
        const paused = isPaused("OpenRouter");
        out.push({
          name: "OpenRouter", ok: !paused, keyOnly: true, model: provider.models[0], freeTier: info.is_free_tier,
          error: paused ? "daily free limit used up (resets at 00:00 UTC)" : undefined,
        });
      } catch (e) {
        out.push({ name: "OpenRouter", ok: false, model: provider.models.join(", ") || "-", error: e.message });
      }
      continue;
    }
    try {
      await provider.resolve?.();
      const r = await chat(provider, "Reply with the single word: OK", {
        maxTokens: 2000,
        system: "You are a helpful assistant.",
        timeoutMs: 25_000,
      });
      out.push({ name: provider.name, ok: true, ...r });
    } catch (e) {
      out.push({ name: provider.name, ok: false, model: provider.models.join(", "), error: e.message });
    }
  }
  return out;
}

/** Pull the JSON object out of a model reply (tolerates <think> blocks and ``` fences). */
export function parseModelJson(content) {
  let s = String(content).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`Model returned no JSON: ${s.slice(0, 200)}`);
  const obj = JSON.parse(s.slice(start, end + 1));
  const list = Array.isArray(obj) ? obj : obj.questions;
  if (!Array.isArray(list)) throw new Error("Model JSON has no 'questions' array");
  return list;
}

/** Base64-encode bytes (native toBase64 when the runtime has it — much cheaper on CPU). */
export function toBase64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
