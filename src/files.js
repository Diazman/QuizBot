// Turn uploaded files (.txt, .md, .csv, .docx) into plain text.

/** Decode bytes as UTF-8, falling back to Windows-1251 (common for Russian .txt files). */
export function decodeText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

/** Read one entry from a ZIP archive (enough for .docx). */
async function readZipEntry(bytes, wanted) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid .docx (zip) file");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      const lNameLen = view.getUint16(localOff + 26, true);
      const lExtraLen = view.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = bytes.subarray(start, start + compSize);
      if (method === 0) return dec.decode(data);
      if (method !== 8) throw new Error(`Unsupported zip compression ${method}`);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(stream).text();
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wanted} not found in file`);
}

const unescapeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");

/** Extract text from a .docx. Bold / highlighted runs are wrapped in **…** (often the marked answer). */
export async function docxToText(bytes) {
  const xml = await readZipEntry(bytes, "word/document.xml");
  const paragraphs = xml.split(/<\/w:p>/);
  const out = [];
  for (const para of paragraphs) {
    let line = "";
    for (const run of para.match(/<w:r[ >][\s\S]*?<\/w:r>/g) || []) {
      const props = (run.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [""])[0];
      const marked = /<w:b(?: w:val="(?:1|true|on)")?\s*\/>|<w:highlight /.test(props);
      let text = "";
      for (const m of run.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
        text += m[1] !== undefined ? unescapeXml(m[1]) : m[0] === "<w:tab/>" ? "\t" : "\n";
      }
      line += marked && text.trim() ? `**${text}**` : text;
    }
    out.push(line.replace(/\*\*\*\*/g, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Extract text from a PDF using Cloudflare Workers AI "toMarkdown" (free for PDFs).
 * The conversion runs on Cloudflare's side, so it doesn't use the Worker's CPU budget.
 * Returns "" when the PDF has no real text (e.g. it is scanned pictures).
 */
export async function pdfToText(env, bytes, fileName = "file.pdf") {
  if (!env?.AI?.toMarkdown) return "";
  let out;
  try {
    out = await env.AI.toMarkdown([{ name: fileName, blob: new Blob([bytes], { type: "application/pdf" }) }]);
  } catch (e) {
    console.error("toMarkdown failed", e?.message);
    return "";
  }
  const res = Array.isArray(out) ? out[0] : out;
  if (!res || res.format === "error") return "";
  const text = String(res.data ?? "")
    .replace(/^---[\s\S]*?---\s*/, "")      // drop metadata front matter
    .replace(/^#{1,6}\s+Page \d+\s*$/gim, "") // drop "## Page N" headings
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.replace(/\s/g, "").length < 20 ? "" : text;
}

/**
 * Find the JPEG page images inside a scanned PDF (scanners almost always store
 * pages as JPEG / DCTDecode streams), without rendering anything.
 * Returns an array of Uint8Array JPEGs in file order; tiny images (logos) are skipped.
 */
export function pdfJpegImages(bytes, minSize = 20_000) {
  // latin1 decoding keeps 1 char per byte, so string offsets == byte offsets.
  const s = new TextDecoder("latin1").decode(bytes);
  const images = [];
  let pos = 0;
  for (;;) {
    const f = s.indexOf("/DCTDecode", pos);
    if (f === -1) break;
    const dictStart = s.lastIndexOf("<<", f);
    const kw = s.indexOf("stream", f);
    if (kw === -1) break;
    let start = kw + 6;
    if (s[start] === "\r") start++;
    if (s[start] === "\n") start++;
    let end = -1;
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(s.slice(dictStart, kw));
    if (len) end = start + Number(len[1]);
    if (end <= start || end > bytes.length || s.slice(end, end + 12).trim().slice(0, 9) !== "endstream") {
      end = s.indexOf("endstream", start);
      if (end === -1) break;
      while (end > start && (s[end - 1] === "\n" || s[end - 1] === "\r")) end--;
    }
    const img = bytes.subarray(start, end);
    if (img.length >= minSize && img[0] === 0xff && img[1] === 0xd8) images.push(img);
    pos = end;
  }
  return images;
}

const IMAGE_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** MIME type for an image file name / sniffed bytes, or null if it isn't an image we can send to the AI. */
export function imageMime(fileName = "", bytes) {
  const ext = fileName.toLowerCase().split(".").pop();
  if (IMAGE_EXT[ext]) return IMAGE_EXT[ext];
  if (bytes && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  return null;
}

/**
 * Returns one of:
 *   { kind: "text", text }          – text to give the AI
 *   { kind: "json", text }          – an exported quiz to import as-is
 *   { kind: "image", mime }         – a picture: the AI will read it
 *   { kind: "scanned", pages }      – a PDF made of page pictures: the AI will read each page
 */
export async function fileToText(bytes, fileName = "", env = {}) {
  const lower = fileName.toLowerCase();
  const isPdf = lower.endsWith(".pdf") || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46); // %PDF
  if (isPdf) {
    const text = await pdfToText(env, bytes, fileName || "file.pdf");
    if (text) return { kind: "text", text };
    const pages = pdfJpegImages(bytes).length;
    if (pages) return { kind: "scanned", pages };
    throw new Error("I couldn't read this PDF. Please send the pages as photos, or as a .docx / .txt file.");
  }
  const mime = imageMime(fileName, bytes);
  if (mime) return { kind: "image", mime };
  if (lower.endsWith(".docx")) return { kind: "text", text: await docxToText(bytes) };
  if (lower.endsWith(".json")) return { kind: "json", text: decodeText(bytes) };
  if (lower.endsWith(".doc")) {
    throw new Error("Old .doc files are not supported. Please save it as .docx or PDF and send again.");
  }
  return { kind: "text", text: decodeText(bytes) };
}
