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

import { pdfJpegImages, imageMime } from "../src/files.js";

function fakeScannedPdf(pages) {
  const enc = new TextEncoder();
  const parts = [enc.encode("%PDF-1.4\n")];
  pages.forEach((jpeg, i) => {
    parts.push(enc.encode(`${i + 3} 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`));
    parts.push(jpeg);
    parts.push(enc.encode("\nendstream\nendobj\n"));
  });
  parts.push(enc.encode("%%EOF"));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const fakeJpeg = (n, fill) => { const b = new Uint8Array(n).fill(fill); b[0] = 0xff; b[1] = 0xd8; return b; };

test("pdfJpegImages finds page images and skips tiny ones", () => {
  const pdf = fakeScannedPdf([fakeJpeg(30000, 1), fakeJpeg(500, 2), fakeJpeg(25000, 3)]);
  const imgs = pdfJpegImages(pdf);
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].length, 30000);
  assert.equal(imgs[1][5], 3);
});

test("scanned PDF (no text) becomes page pictures", async () => {
  const pdf = fakeScannedPdf([fakeJpeg(30000, 1), fakeJpeg(30000, 2)]);
  const r = await fileToText(pdf, "scan.pdf", fakeAI({ format: "markdown", data: "## Page 1\n\n" }));
  assert.deepEqual(r, { kind: "scanned", pages: 2 });
});

test("unreadable PDF without images gives a clear error", async () => {
  await assert.rejects(fileToText(pdfBytes, "bad.pdf", fakeAI({ format: "error", error: "corrupt" })), /photos/);
});

test("image files are detected", async () => {
  assert.equal(imageMime("a.PNG"), "image/png");
  assert.equal(imageMime("x", new Uint8Array([0xff, 0xd8, 0])), "image/jpeg");
  assert.deepEqual(await fileToText(new Uint8Array([0xff, 0xd8, 0]), "page.jpg"), { kind: "image", mime: "image/jpeg" });
});
