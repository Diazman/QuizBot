// Calls the NVIDIA API (OpenAI-compatible chat completions) to turn raw
// question text into the bot's normalised JSON format.

const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL = "z-ai/glm-5.3-flash";

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

/**
 * @param {object} env Worker env (NVIDIA_API_KEY, optional NVIDIA_MODEL / NVIDIA_BASE_URL)
 * @param {string} text raw chunk of questions
 * @returns {Promise<Array<{question:string,options:string[],correct:number,explanation?:string,confidence?:string}>>}
 */
export function extractQuestions(env, text) {
  return chat(env, env.NVIDIA_MODEL || DEFAULT_MODEL, `Questions:\n\n${text}`);
}

/**
 * Same as extractQuestions, but the questions are in a picture (photo or scanned page).
 * Uses the NVIDIA model's built-in vision (GLM-5.3 Flash is multimodal).
 */
export function extractQuestionsFromImage(env, bytes, mime = "image/jpeg") {
  const url = `data:${mime};base64,${toBase64(bytes)}`;
  return chat(env, env.NVIDIA_VISION_MODEL || env.NVIDIA_MODEL || DEFAULT_MODEL, [
    {
      type: "text",
      text: "The attached image is a photo or scan of a page with multiple-choice questions. Read ALL the text on it carefully (it is usually Russian; marks like ticks, circles, underlines or highlighted options may show the right answer). Then extract the questions as instructed.",
    },
    { type: "image_url", image_url: { url } },
  ]);
}

async function chat(env, model, userContent) {
  if (!env.NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY secret is not set");
  const baseUrl = (env.NVIDIA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 16000,
      stream: false,
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`NVIDIA API ${res.status}: ${body.slice(0, 300)}`);
    // 429 / 5xx are worth retrying; 4xx (bad key, bad model, image too big) are not.
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  const data = JSON.parse(body);
  const content = data?.choices?.[0]?.message?.content ?? "";
  return parseModelJson(content);
}

/** Base64-encode bytes (native toBase64 when the runtime has it — much cheaper on CPU). */
export function toBase64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
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
