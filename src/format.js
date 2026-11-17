// Pure helpers: chunking raw text, validating the bot question format,
// and building Telegram poll payloads within Telegram's limits.

export const LIMITS = { question: 300, option: 100, explanation: 200, minOptions: 2, maxOptions: 10 };

const QUESTION_START = /^\s*(?:\d{1,4}\s*[.)\]:]|вопрос\b|question\b|№\s*\d)/i;

/**
 * Split raw text into chunks of roughly `maxChars`, cutting only at a line that
 * looks like the start of a new question, or at a blank line as a fallback,
 * so a question is never split between two AI calls.
 */
export function splitIntoChunks(text, maxChars = 6000) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const chunks = [];
  let cur = [];
  let len = 0;
  let lastBlank = -1; // index in `cur` of the last blank line

  const flush = (upto = cur.length) => {
    const piece = cur.slice(0, upto).join("\n").trim();
    if (piece) chunks.push(piece);
    cur = cur.slice(upto);
    len = cur.reduce((n, l) => n + l.length + 1, 0);
    lastBlank = cur.findLastIndex((l) => !l.trim());
  };

  for (const line of lines) {
    if (len + line.length > maxChars && cur.length) {
      if (QUESTION_START.test(line)) flush();
      else if (lastBlank > 0) flush(lastBlank);
      else if (len > maxChars * 1.5) flush(); // no safe boundary at all: hard cut
    }
    cur.push(line);
    len += line.length + 1;
    if (!line.trim()) lastBlank = cur.length - 1;
  }
  flush();
  return chunks;
}

const OPTION_LABEL = /^\s*(?:[(\[]?[a-zа-яё0-9][)\].:]|[-–•*+])\s+/i;

/** Validate / clean one question object. Returns null if it can't be used. */
export function normalizeQuestion(q) {
  if (!q || typeof q !== "object") return null;
  const question = String(q.question ?? q.q ?? "").trim();
  let options = Array.isArray(q.options) ? q.options : [];
  options = options.map((o) => String(o ?? "").replace(OPTION_LABEL, "").trim()).filter(Boolean);
  let correct = Number(q.correct ?? q.answer);
  if (!question || options.length < LIMITS.minOptions || options.length > LIMITS.maxOptions) return null;
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) return null;
  const explanation = q.explanation ? String(q.explanation).trim() : "";
  const confidence = ["high", "medium", "low"].includes(q.confidence) ? q.confidence : "medium";
  return { question, options, correct, explanation, confidence };
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Build the Telegram sendPoll payload for a question.
 * If the question text is too long for a poll, `preface` holds the full text to
 * send as a normal message first and the poll gets a short prompt instead.
 */
export function buildPoll(q, number, total) {
  const head = `${number}/${total}. `;
  let question = head + q.question;
  let preface = null;
  if (question.length > LIMITS.question) {
    preface = `❓ ${head}${q.question}`;
    question = `${head}Выберите правильный ответ ⬆️`;
  }
  // Telegram needs unique option texts; truncation could create duplicates.
  const seen = new Set();
  const options = q.options.map((o, i) => {
    let t = cut(o, LIMITS.option);
    if (seen.has(t)) t = cut(`${i + 1}. ${o}`, LIMITS.option);
    seen.add(t);
    return { text: t };
  });
  const poll = {
    question,
    options,
    type: "quiz",
    correct_option_id: q.correct,
    is_anonymous: false,
  };
  if (q.explanation) poll.explanation = cut(q.explanation, LIMITS.explanation);
  return { preface, poll };
}

/** Fisher–Yates shuffle (returns a new array). */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Short random share code. */
export function randomCode(len = 8) {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

/** Parse a previously exported quiz JSON file (skips the AI). */
export function parseQuizJson(text) {
  const obj = JSON.parse(text);
  const list = Array.isArray(obj) ? obj : obj.questions;
  if (!Array.isArray(list)) throw new Error("JSON must be an array or have a 'questions' array");
  return { title: !Array.isArray(obj) && obj.title ? String(obj.title) : null, questions: list.map(normalizeQuestion).filter(Boolean) };
}
