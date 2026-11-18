import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeText, docxToText } from "../src/files.js";

test("docxToText extracts paragraphs and marks bold", async () => {
  const text = await docxToText(new Uint8Array(readFileSync(new URL("./sample.docx", import.meta.url))));
  assert.equal(text, "1. Сколько падежей?\nА) 5\n**Б) 6**\nВ) 7 & more");
});

test("decodeText falls back to windows-1251", () => {
  const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет"
  assert.equal(decodeText(cp1251), "Привет");
});

import { fileToText } from "../src/files.js";

const fakeAI = (reply) => ({ AI: { toMarkdown: async (files) => { assert.equal(files[0].blob.type, "application/pdf"); return [reply]; } } });
const pdfBytes = new TextEncoder().encode("%PDF-1.7 fake");

test("PDF is converted via Workers AI toMarkdown", async () => {
  const env = fakeAI({ name: "q.pdf", format: "markdown", data: "---\ntitle: x\n---\n## Page 1\n1. Сколько падежей в русском?\nА) 5\nБ) 6\n\n\n\n" });
  const r = await fileToText(pdfBytes, "q.pdf", env);
  assert.deepEqual(r, { kind: "text", text: "1. Сколько падежей в русском?\nА) 5\nБ) 6" });
});

test("PDF detected by magic bytes even without .pdf name", async () => {
  const env = fakeAI({ format: "markdown", data: "1. Вопрос номер один, достаточно длинный?\nА) да\nБ) нет" });
  assert.equal((await fileToText(pdfBytes, "file", env)).kind, "text");
});

test("scanned PDF gives a clear error", async () => {
  await assert.rejects(fileToText(pdfBytes, "scan.pdf", fakeAI({ format: "markdown", data: "## Page 1\n\n" })), /scanned/);
});

test("conversion error is reported", async () => {
  await assert.rejects(fileToText(pdfBytes, "bad.pdf", fakeAI({ format: "error", error: "corrupt" })), /corrupt/);
});
