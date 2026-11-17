import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPoll, normalizeQuestion, parseQuizJson, splitIntoChunks } from "../src/format.js";
import { parseModelJson } from "../src/ai.js";

test("splitIntoChunks keeps questions whole", () => {
  const qs = Array.from({ length: 200 }, (_, i) => `${i + 1}. Вопрос номер ${i + 1}?\nА) один\nБ) два\nВ) три\n`).join("\n");
  const chunks = splitIntoChunks(qs, 1000);
  assert.ok(chunks.length > 5);
  for (const c of chunks) assert.match(c, /^\d+\. Вопрос/);
  const total = chunks.join("\n").match(/Вопрос номер/g).length;
  assert.equal(total, 200);
});

test("splitIntoChunks small text is one chunk", () => {
  const t = readFileSync(new URL("../examples/sample-questions.txt", import.meta.url), "utf8");
  assert.equal(splitIntoChunks(t).length, 1);
});

test("normalizeQuestion strips labels and validates", () => {
  const q = normalizeQuestion({ question: " Q? ", options: ["А) да", "Б) нет"], correct: 1, confidence: "low" });
  assert.deepEqual(q, { question: "Q?", options: ["да", "нет"], correct: 1, explanation: "", confidence: "low" });
  assert.equal(normalizeQuestion({ question: "Q", options: ["a"], correct: 0 }), null);
  assert.equal(normalizeQuestion({ question: "Q", options: ["a", "b"], correct: 2 }), null);
});

test("buildPoll respects Telegram limits", () => {
  const long = "я".repeat(400);
  const { preface, poll } = buildPoll({ question: long, options: ["x".repeat(150), "x".repeat(150)], correct: 1, explanation: "e".repeat(300) }, 3, 10);
  assert.ok(preface.includes(long));
  assert.ok(poll.question.length <= 300);
  for (const o of poll.options) assert.ok(o.text.length <= 100);
  assert.notEqual(poll.options[0].text, poll.options[1].text);
  assert.ok(poll.explanation.length <= 200);
  assert.equal(poll.type, "quiz");
  assert.equal(poll.correct_option_id, 1);
});

test("parseModelJson handles think blocks and fences", () => {
  const out = parseModelJson('<think>hmm {"x":1}</think>\n```json\n{"questions":[{"question":"q","options":["a","b"],"correct":0}]}\n```');
  assert.equal(out.length, 1);
});

test("parseQuizJson round trip", () => {
  const p = parseQuizJson(JSON.stringify({ title: "T", questions: [{ question: "q", options: ["a", "b"], correct: 1 }] }));
  assert.equal(p.title, "T");
  assert.equal(p.questions[0].correct, 1);
});
