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
