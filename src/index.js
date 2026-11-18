// QuizBot — Cloudflare Worker entry point.
//  fetch: Telegram webhook (commands, uploads, poll answers)
//  queue: AI processing of question chunks (runs in the background, retried on failure)

import { extractQuestions, extractQuestionsFromImage, isDailyLimit, isOverloadError, pingProviders } from "./ai.js";
import { buildPoll, countImages, imageMarker, normalizeQuestion, parseImageMarker, parseQuizJson, planChunks, randomCode, shuffle } from "./format.js";
import { fileToText, pdfJpegImages } from "./files.js";
import { esc, tg, webhookSecret } from "./telegram.js";

const MAX_DRAFT_CHARS = 400_000;
const now = () => Math.floor(Date.now() / 1000);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("QuizBot is running. Open /setup once to connect Telegram.");
    if (request.method === "GET" && url.pathname === "/setup") return setup(env, url.origin);
    if (request.method !== "POST" || url.pathname !== "/webhook") return new Response("Not found", { status: 404 });

    const secret = await webhookSecret(env.TELEGRAM_BOT_TOKEN);
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
      return new Response("Forbidden", { status: 403 });
    }
    const update = await request.json();
    try {
      await handleUpdate(update, env);
    } catch (err) {
      console.error("update failed", err?.stack || err);
      const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
      if (chatId) ctx.waitUntil(tg(env).send(chatId, `⚠️ Error: ${esc(err.message || err)}`).catch(() => {}));
    }
    // Always 200 so Telegram doesn't redeliver the same update forever.
    return new Response("ok");
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      if (msg.body?.ping) { // /check: proves the background worker is attached and running
        await tg(env).send(msg.body.ping, `✅ Background worker: running (picked up the test job after ${Math.round((Date.now() - msg.body.at) / 1000)}s).`).catch(() => {});
        msg.ack();
        continue;
      }
      try {
        await processChunk(env, msg.body.quizId, msg.body.idx, msg.body.progress);
        msg.ack();
      } catch (err) {
        console.error("chunk failed", msg.body, err?.message);
        if (err.retryable !== false && msg.attempts < 4) {
          msg.retry({ delaySeconds: 20 * msg.attempts });
          await showProgress(env, msg.body.quizId, msg.body.progress, "⏳ The AI is busy, retrying in a moment…");
        } else {
          await failChunk(env, msg.body.quizId, msg.body.idx, String(err.message || err), msg.body.progress);
          msg.ack();
        }
      }
    }
  },
};

// Points the Telegram webhook at this worker and registers the command menu.
// Safe to call any time: it can only ever point the bot at this same worker.
async function setup(env, origin) {
  const text = (msg, status = 200) => new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (!env.TELEGRAM_BOT_TOKEN) return text("TELEGRAM_BOT_TOKEN secret is missing. Add it in Cloudflare: Worker → Settings → Variables and Secrets.", 500);
  if (!env.NVIDIA_API_KEY) return text("NVIDIA_API_KEY secret is missing. Add it in Cloudflare: Worker → Settings → Variables and Secrets.", 500);
  try {
    const api = tg(env);
    await api.call("setWebhook", {
      url: `${origin}/webhook`,
      secret_token: await webhookSecret(env.TELEGRAM_BOT_TOKEN),
      allowed_updates: ["message", "callback_query", "poll_answer"],
    });
    await api.call("setMyCommands", {
      commands: [
        { command: "new", description: "Create a new quiz" },
        { command: "done", description: "Finish uploading and let the AI build the quiz" },
        { command: "my", description: "My quizzes and share links" },
        { command: "practice", description: "Practise a quiz by code" },
        { command: "export", description: "Download a quiz as JSON" },
        { command: "delete", description: "Delete or stop quizzes" },
        { command: "check", description: "Test the AI / see why a quiz is stuck" },
        { command: "check", description: "Test the AI / see why a quiz is stuck" },
    { command: "stop", description: "Stop the current quiz" },
        { command: "help", description: "How it works" },
      ],
    });
    const me = await api.call("getMe");
    return text(`✅ Telegram is connected.\nOpen https://t.me/${me.username} and send /start`);
  } catch (e) {
    return text(`❌ ${e.message}`, 500);
  }
}

// ───────────────────────────── updates ─────────────────────────────

async function handleUpdate(update, env) {
  if (update.poll_answer) return onPollAnswer(update.poll_answer, env);
  if (update.callback_query) return onCallback(update.callback_query, env);
  const msg = update.message;
  if (!msg || !msg.from) return;
  if (msg.chat.type !== "private") return; // practice & uploads happen in private chat

  const api = tg(env);
  if (msg.photo) return onPhoto(msg, env);
  if (msg.document) return onDocument(msg, env);

  const text = (msg.text || "").trim();
  if (!text) return;
  if (!text.startsWith("/")) return onPlainText(msg, env);

  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const arg = rest.join(" ").trim();
  const uid = msg.from.id;
  const chat = msg.chat.id;

  switch (cmd) {
    case "/start":
      if (arg.startsWith("q_")) return offerQuiz(env, chat, arg.slice(2));
      return api.send(chat, HELP);
    case "/help":
      return api.send(chat, HELP);
    case "/new": {
      const title = arg || `Quiz ${new Date().toISOString().slice(0, 10)}`;
      const quiz = await createQuiz(env, uid, title);
      await env.DB.prepare("INSERT OR REPLACE INTO drafts (user_id, quiz_id) VALUES (?, ?)").bind(uid, quiz.id).run();
      return api.send(chat,
        `📝 New quiz <b>${esc(title)}</b>.\n\nNow send me the questions: paste them as messages (as many as you need) and/or upload <b>PDF</b> / <b>.docx</b> / <b>.txt</b> files and <b>photos</b> of test pages.\nWhen everything is sent, type /done.`);
    }
    case "/done": {
      const draft = await getDraft(env, uid);
      if (!draft) return api.send(chat, "You have no open draft. Start one with /new <i>title</i>.");
      if (!draft.raw_text.trim()) return api.send(chat, "The draft is empty — send some questions first.");
      await env.DB.prepare("DELETE FROM drafts WHERE user_id = ?").bind(uid).run();
      return startProcessing(env, draft, chat);
    }
    case "/cancel": {
      const draft = await getDraft(env, uid);
      if (draft) await deleteQuiz(env, draft.id);
      await env.DB.prepare("DELETE FROM drafts WHERE user_id = ?").bind(uid).run();
      return api.send(chat, draft ? "Draft discarded." : "Nothing to cancel.");
    }
    case "/my":
      return listQuizzes(env, uid, chat);
    case "/export":
      return exportQuiz(env, uid, chat, arg);
    case "/delete": {
      const quiz = await ownedQuiz(env, uid, arg);
      if (!quiz) return listQuizzes(env, uid, chat); // no/unknown code: show the list with 🗑 buttons
      await deleteQuiz(env, quiz.id);
      return api.send(chat, `🗑 Deleted <b>${esc(quiz.title)}</b>.`);
    }
    case "/retry": {
      const quiz = await ownedQuiz(env, uid, arg);
      if (!quiz) return api.send(chat, "Usage: /retry <i>code</i> (see /my)");
      return retryFailed(env, quiz, chat);
    }
    case "/practice": {
      const code = arg.replace(/^q_/, "");
      if (!code) return api.send(chat, "Usage: /practice <i>code</i>");
      return offerQuiz(env, chat, code);
    }
    case "/check":
      return runCheck(env, chat, uid, arg);
    case "/stop": {
      const s = await env.DB.prepare("SELECT * FROM sessions WHERE user_id = ?").bind(uid).first();
      if (!s) return api.send(chat, "No quiz running.");
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(uid).run();
      return api.send(chat, `⏹ Stopped. Score: <b>${s.score}/${s.idx}</b>.`);
    }
    default:
      return api.send(chat, "Unknown command. /help");
  }
}

const HELP = `🇷🇺 <b>Russian Quiz Bot</b>

<b>Create a quiz</b>
1. /new <i>title</i>
2. Send your questions (paste text, upload PDF / .docx / .txt, or send photos of the pages). Any format works — numbered questions with A/B/C/D options are perfect. If you already marked answers (e.g. "Ответ: Б" or bold), the AI uses them; otherwise it solves the questions itself.
3. /done — the AI finds the correct answers and builds the quiz polls.
Tip: you can also just upload a file without /new — it becomes a quiz straight away.

<b>Share &amp; practise</b>
After processing you get a link. Anyone who opens it gets the questions as Telegram quiz polls, one by one, with a score at the end.

<b>Commands</b>
/my — your quizzes and share links
/practice <i>code</i> — practise a quiz
/export <i>code</i> — download the quiz in bot format (JSON). Edit it and upload it back to fix answers.
/retry <i>code</i> — re-run parts that failed or got stuck
/delete — delete quizzes (also stops ones that are still processing). Or use the 🗑 buttons in /my
/check <i>code</i> — test the AI and see why a quiz is stuck
/stop — stop the current practice
/cancel — discard the current draft`;

// ───────────────────────────── diagnostics ─────────────────────────────

async function runCheck(env, chat, uid, code) {
  const api = tg(env);
  await api.send(chat, "🔎 Checking… (takes up to ~30 seconds)");
  const lines = [];
  lines.push(env.NVIDIA_API_KEY ? "✅ NVIDIA key: set" : "⚠️ NVIDIA key: missing (NVIDIA_API_KEY)");
  lines.push(env.OPENROUTER_API_KEY ? "✅ OpenRouter key (backup AI): set" : "⚠️ OpenRouter key (backup AI): missing (OPENROUTER_API_KEY)");
  lines.push(env.AI ? "✅ PDF converter (Workers AI): connected" : "⚠️ PDF converter (Workers AI): not connected");

  const pings = await pingProviders(env);
  if (!pings.length) lines.push("❌ No AI is configured: add NVIDIA_API_KEY and/or OPENROUTER_API_KEY as Secrets in Cloudflare.");
  for (const p of pings) {
    if (p.keyOnly && p.ok) {
      lines.push(`✅ OpenRouter key works; model <code>${esc(p.model)}</code>${p.freeTier ? " (free tier: 50 free requests/day; buy $10 credits once for 1000/day)" : ""}`);
    } else if (p.ok) {
      const said = String(p.content).replace(/<think>[\s\S]*?<\/think>/g, "").trim().slice(0, 30);
      lines.push(`✅ ${p.name} <code>${esc(p.model)}</code> answered in ${(p.ms / 1000).toFixed(1)}s: "${esc(said)}"`);
      if (p.ms > 15000) lines.push(`⚠️ ${p.name} is slow right now; each part of a quiz can take minutes.`);
    } else {
      lines.push(isDailyLimit(p.error)
        ? `❌ ${p.name}: today's free limit is used up (resets at 00:00 UTC).`
        : `❌ ${p.name} (<code>${esc(p.model)}</code>): ${esc(p.error).slice(0, 250)}`);
    }
  }
  if (pings.length > 1) lines.push(`ℹ️ Order: ${pings.map((p) => p.name).join(" → ")}. If one fails, the next is used.`);

  if (code) {
    const quiz = await ownedQuiz(env, uid, code);
    if (!quiz) lines.push(`❓ Quiz <code>${esc(code)}</code> not found (see /my).`);
    else {
      const { results } = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM chunks WHERE quiz_id = ? GROUP BY status").bind(quiz.id).all();
      const counts = Object.fromEntries(results.map((r) => [r.status, r.n]));
      lines.push(`📊 <b>${esc(quiz.title)}</b>: ${quiz.status}. Parts: ${counts.done || 0} done, ${counts.pending || 0} waiting, ${counts.failed || 0} failed.`);
      const err = await env.DB.prepare("SELECT idx, error FROM chunks WHERE quiz_id = ? AND error IS NOT NULL ORDER BY idx LIMIT 1").bind(quiz.id).first();
      if (err) lines.push(`Last error (part ${err.idx + 1}): <code>${esc(err.error).slice(0, 300)}</code>`);
    }
  }

  await api.send(chat, lines.join("\n"));
  // Last check: the background worker should answer with a separate message within a few seconds.
  await env.QUIZ_QUEUE.send({ ping: chat, at: Date.now() });
  const { busy } = await env.DB.prepare("SELECT COUNT(*) AS busy FROM chunks WHERE status = 'pending'").first();
  return api.send(chat, busy
    ? `⏳ Testing the background worker… ${busy} part(s) of quizzes are being processed right now, so the "✅ Background worker" reply will come after those.`
    : "⏳ Testing the background worker… a \"✅ Background worker\" reply should arrive within a few seconds.");
}

// ───────────────────────────── creating quizzes ─────────────────────────────

async function createQuiz(env, ownerId, title, status = "draft") {
  for (let i = 0; i < 5; i++) {
    const code = randomCode();
    const row = await env.DB.prepare(
      "INSERT OR IGNORE INTO quizzes (code, owner_id, title, status, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
    ).bind(code, ownerId, title.slice(0, 120), status, now()).first();
    if (row) return row;
  }
  throw new Error("Could not allocate a quiz code");
}

const getDraft = (env, uid) =>
  env.DB.prepare("SELECT q.* FROM drafts d JOIN quizzes q ON q.id = d.quiz_id WHERE d.user_id = ?").bind(uid).first();

async function appendToDraft(env, draft, text) {
  if (draft.raw_text.length + text.length > MAX_DRAFT_CHARS) throw new Error("Draft is too large (max ~400k characters). Send /done or split into several quizzes.");
  const row = await env.DB.prepare("UPDATE quizzes SET raw_text = raw_text || ? WHERE id = ? RETURNING length(raw_text) AS n")
    .bind(`\n\n${text}`, draft.id).first();
  return row.n;
}

/** The user's open draft, or a new one (pictures always go to a draft so albums stay together). */
async function ensureDraft(env, uid, title) {
  const draft = await getDraft(env, uid);
  if (draft) return { draft, created: false };
  const quiz = await createQuiz(env, uid, title);
  await env.DB.prepare("INSERT OR REPLACE INTO drafts (user_id, quiz_id) VALUES (?, ?)").bind(uid, quiz.id).run();
  return { draft: quiz, created: true };
}

function draftStatus(raw) {
  const pics = countImages(raw);
  const chars = raw.replace(/\[\[img:[^\]]+\]\]/g, "").trim().length;
  const parts = [];
  if (chars) parts.push(`${chars.toLocaleString("en")} characters`);
  if (pics) parts.push(`${pics} picture${pics === 1 ? "" : "s"}`);
  return parts.join(" + ") || "empty";
}

async function addPicturesToDraft(env, msg, markers, what) {
  const api = tg(env);
  const title = (msg.caption || `Quiz ${new Date().toISOString().slice(0, 10)}`).trim();
  const { draft, created } = await ensureDraft(env, msg.from.id, title);
  await appendToDraft(env, draft, markers.join("\n"));
  const fresh = await env.DB.prepare("SELECT raw_text FROM quizzes WHERE id = ?").bind(draft.id).first();
  // An album arrives as many messages at once: only answer the first one to avoid spam.
  if (msg.media_group_id && !created) return;
  return api.send(msg.chat.id,
    `🖼 ${what} added to ${created ? "new " : ""}draft <b>${esc(draft.title)}</b> (${draftStatus(fresh.raw_text)}).\nSend more pages, or /done when everything is in.`);
}

async function onPhoto(msg, env) {
  // Telegram sends several sizes; take the biggest one (best for reading small text).
  const photo = msg.photo[msg.photo.length - 1];
  return addPicturesToDraft(env, msg, [imageMarker("tg", photo.file_id, "image/jpeg")], "Photo");
}

async function onPlainText(msg, env) {
  const api = tg(env);
  const draft = await getDraft(env, msg.from.id);
  if (!draft) {
    return api.send(msg.chat.id, "To create a quiz, first send /new <i>title</i>, then paste the questions. /help");
  }
  await appendToDraft(env, draft, msg.text);
  const { raw_text } = await env.DB.prepare("SELECT raw_text FROM quizzes WHERE id = ?").bind(draft.id).first();
  return api.send(msg.chat.id, `➕ Added. Draft: ${draftStatus(raw_text)}. Send more, or /done to process.`);
}

async function onDocument(msg, env) {
  const api = tg(env);
  const doc = msg.document;
  const uid = msg.from.id;
  if (doc.file_size > 10 * 1024 * 1024) return api.send(msg.chat.id, "File is too big (max 10 MB).");
  const bytes = await api.downloadFile(doc.file_id);
  const { kind, text, mime, pages } = await fileToText(bytes, doc.file_name || "", env);
  const baseTitle = (msg.caption || (doc.file_name || "Quiz").replace(/\.[^.]+$/, "")).trim();

  if (kind === "json") return importJson(env, uid, msg.chat.id, text, baseTitle);
  if (kind === "image") {
    if (bytes.length > 4 * 1024 * 1024) return api.send(msg.chat.id, "This picture is very large. Please send it as a normal photo (not as a file) so Telegram compresses it.");
    return addPicturesToDraft(env, msg, [imageMarker("tg", doc.file_id, mime)], "Picture");
  }
  if (kind === "scanned") {
    const markers = Array.from({ length: pages }, (_, i) => imageMarker("pdf", doc.file_id, i));
    await api.send(msg.chat.id, `📄 This PDF is scanned (${pages} page picture${pages === 1 ? "" : "s"}). The AI will read each page from the image.`);
    return addPicturesToDraft(env, { ...msg, caption: msg.caption || baseTitle }, markers, `${pages} scanned page(s)`);
  }

  if (!text.trim()) return api.send(msg.chat.id, "I couldn't find any text in that file.");
  const draft = await getDraft(env, uid);
  if (draft) {
    await appendToDraft(env, draft, text);
    const n = (await env.DB.prepare("SELECT raw_text FROM quizzes WHERE id = ?").bind(draft.id).first()).raw_text;
    return api.send(msg.chat.id, `📎 File added to draft <b>${esc(draft.title)}</b>. Draft: ${draftStatus(n)}. Send more, or /done.`);
  }
  // No draft: the file is a whole quiz on its own.
  const quiz = await createQuiz(env, uid, baseTitle);
  await env.DB.prepare("UPDATE quizzes SET raw_text = ? WHERE id = ?").bind(text, quiz.id).run();
  quiz.raw_text = text;
  return startProcessing(env, quiz, msg.chat.id);
}

async function importJson(env, uid, chat, text, title) {
  const api = tg(env);
  let parsed;
  try {
    parsed = parseQuizJson(text);
  } catch (e) {
    return api.send(chat, `Could not read JSON: ${esc(e.message)}`);
  }
  if (!parsed.questions.length) return api.send(chat, "No valid questions found in that JSON.");
  const quiz = await createQuiz(env, uid, parsed.title || title, "ready");
  await insertQuestions(env, quiz.id, 0, parsed.questions);
  return api.send(chat, await readyMessage(env, quiz, parsed.questions.length, 0));
}

async function startProcessing(env, quiz, chat) {
  const api = tg(env);
  const chunks = planChunks(quiz.raw_text);
  if (!chunks.length) return api.send(chat, "Nothing to process.");
  const stmts = chunks.map((text, idx) =>
    env.DB.prepare("INSERT OR REPLACE INTO chunks (quiz_id, idx, text, status) VALUES (?, ?, ?, 'pending')").bind(quiz.id, idx, text));
  stmts.push(env.DB.prepare(
    "UPDATE quizzes SET status = 'processing', chunks_total = ?, chunks_done = 0, chunks_failed = 0 WHERE id = ?",
  ).bind(chunks.length, quiz.id));
  await env.DB.batch(stmts);

  const sent = await api.send(chat, progressText({ ...quiz, chunks_total: chunks.length, chunks_done: 0, chunks_failed: 0 }, 0),
    { reply_markup: stopKeyboard(quiz.code) });
  const progress = { chat, msg: sent.message_id };
  const messages = chunks.map((_, idx) => ({ body: { quizId: quiz.id, idx, progress } }));
  for (let i = 0; i < messages.length; i += 100) await env.QUIZ_QUEUE.sendBatch(messages.slice(i, i + 100));
}

// ───────────────────────────── progress message ─────────────────────────────

function progressBar(fraction, width = 12) {
  const full = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return "▓".repeat(full) + "░".repeat(width - full);
}

const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/**
 * reading: [{ idx, started }] for every part the AI is reading right now (from all workers).
 * Each counts as partly done (estimated from elapsed time), so the bar moves smoothly
 * instead of jumping a whole part at a time.
 */
export function progressText(quiz, found, note = "", reading = [], expectedMs = 40_000) {
  const total = Math.max(quiz.chunks_total, 1);
  const handled = quiz.chunks_done + quiz.chunks_failed;
  const running = handled < quiz.chunks_total;
  let partial = 0;
  if (running) {
    for (const r of reading) partial += Math.min(0.95, 1 - Math.exp(-(Date.now() - r.started) / expectedMs)); // eases towards 95%
  }
  const fraction = Math.min(1, (handled + partial) / total);
  const pct = Math.floor(100 * fraction);
  let t = `🤖 <b>${esc(quiz.title)}</b>\n\n${progressBar(fraction)} ${pct}%\n`;
  t += `Parts read: <b>${handled}/${quiz.chunks_total}</b>\nQuestions found so far: <b>${found}</b>`;
  if (quiz.chunks_failed) t += `\n⚠️ Failed parts: ${quiz.chunks_failed}`;
  if (running && reading.length) {
    const parts = reading.map((r) => r.idx + 1);
    const label = parts.length === 1 ? `part ${parts[0]}` : `parts ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
    const longest = Math.max(...reading.map((r) => Date.now() - r.started));
    t += `\n🔄 Reading ${label}${reading.length > 1 ? " at the same time" : ""}… ${mmss(longest)}`;
  }
  t += running
    ? `\n\nThe AI is reading the questions and finding the correct answers…`
    : `\n\n✅ Done.`;
  if (note) t += `\n${note}`;
  return t;
}

const stopKeyboard = (code) => ({ inline_keyboard: [[{ text: "⏹ Stop & delete", callback_data: `del:${code}` }]] });

/** Update the "Processing…" message in place. Never fails the job if Telegram refuses the edit. */
async function showProgress(env, quizId, progress, note = "", expectedMs = 40_000) {
  if (!progress?.msg) return;
  try {
    const quiz = await env.DB.prepare("SELECT * FROM quizzes WHERE id = ?").bind(quizId).first();
    if (!quiz) return;
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE quiz_id = ?").bind(quizId).first();
    const running = quiz.chunks_done + quiz.chunks_failed < quiz.chunks_total;
    let reading = [];
    if (running) {
      await ensureReadingTable(env);
      // Ignore leftovers from a worker that was killed (a part never takes longer than 15 min).
      ({ results: reading } = await env.DB.prepare("SELECT idx, started FROM reading WHERE quiz_id = ? AND started > ? ORDER BY idx")
        .bind(quizId, Date.now() - 15 * 60_000).all());
    }
    await tg(env).call("editMessageText", {
      chat_id: progress.chat,
      message_id: progress.msg,
      text: progressText(quiz, n, note, reading, expectedMs),
      parse_mode: "HTML",
      reply_markup: running ? stopKeyboard(quiz.code) : { inline_keyboard: [] },
    });
  } catch (e) {
    // "message is not modified" or a deleted message: nothing to do.
  }
}

// ───────────────────────────── queue consumer ─────────────────────────────

let recentPartMs = 0; // moving average of how long a part takes (per worker instance)

// The "reading" table (migrations/0002) is created on first use, because deploys from
// the Cloudflare dashboard don't run migrations.
let readingTableReady = false;
async function ensureReadingTable(env) {
  if (readingTableReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS reading (quiz_id INTEGER NOT NULL, idx INTEGER NOT NULL, started INTEGER NOT NULL, PRIMARY KEY (quiz_id, idx))",
  ).run();
  readingTableReady = true;
}

async function processChunk(env, quizId, idx, progress) {
  const chunk = await env.DB.prepare("SELECT * FROM chunks WHERE quiz_id = ? AND idx = ?").bind(quizId, idx).first();
  if (!chunk || chunk.status !== "pending") return; // deleted quiz or already handled

  const img = parseImageMarker(chunk.text);

  // Keep the progress message alive while the AI works on this part. The expected time comes
  // from how long recent parts actually took (falls back to a guess for the first one).
  const guess = img ? 30_000 : 15_000 + chunk.text.length * 3;
  const working = { idx, started: Date.now(), expectedMs: recentPartMs ? recentPartMs * 0.6 : guess };
  await ensureReadingTable(env);
  await env.DB.prepare("INSERT OR REPLACE INTO reading (quiz_id, idx, started) VALUES (?, ?, ?)").bind(quizId, idx, working.started).run();
  let pendingEdit = showProgress(env, quizId, progress, "", working.expectedMs);
  const ticker = setInterval(() => {
    pendingEdit = pendingEdit.then(() => showProgress(env, quizId, progress, "", working.expectedMs));
  }, 8000);
  let result;
  try {
    result = await readChunk(env, quizId, idx, chunk, img, progress);
  } finally {
    clearInterval(ticker);
    await pendingEdit; // make sure a late "reading…" edit can't overwrite the final state
    await env.DB.prepare("DELETE FROM reading WHERE quiz_id = ? AND idx = ?").bind(quizId, idx).run().catch(() => {});
  }
  if (!result) return;
  const took = Date.now() - working.started;
  recentPartMs = recentPartMs ? recentPartMs * 0.6 + took * 0.4 : took;
  await showProgress(env, quizId, progress);
  await maybeFinish(env, result.quizRow);
}

async function readChunk(env, quizId, idx, chunk, img, progress) {
  let raw;
  if (img?.type === "tg") {
    raw = await extractQuestionsFromImage(env, await tg(env).downloadFile(img.fileId), img.mime);
  } else if (img?.type === "pdf") {
    const page = pdfJpegImages(await tg(env).downloadFile(img.fileId))[img.page];
    if (!page) throw Object.assign(new Error(`Page ${img.page + 1} not found in the PDF`), { retryable: false });
    raw = await extractQuestionsFromImage(env, page, "image/jpeg");
  } else {
    raw = await extractQuestions(env, chunk.text);
  }
  const questions = raw.map(normalizeQuestion).filter(Boolean);

  // Everything is conditional on the part still waiting: if the quiz was deleted (or the
  // part was already handled) while the AI was working, the result is simply dropped.
  const stillPending = "EXISTS (SELECT 1 FROM chunks WHERE quiz_id = ? AND idx = ? AND status = 'pending')";
  const res = await env.DB.batch([
    ...questions.map((q, i) =>
      env.DB.prepare(
        `INSERT INTO questions (quiz_id, position, question, options, correct, explanation, confidence)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${stillPending}`,
      ).bind(quizId, idx * 1000 + i, q.question, JSON.stringify(q.options), q.correct, q.explanation || null, q.confidence || null, quizId, idx)),
    env.DB.prepare("UPDATE quizzes SET chunks_done = chunks_done + 1 WHERE id = ? AND " + stillPending + " RETURNING *").bind(quizId, quizId, idx),
    env.DB.prepare("UPDATE chunks SET status = 'done', error = NULL WHERE quiz_id = ? AND idx = ? AND status = 'pending'").bind(quizId, idx),
  ]);
  const quizRow = res[res.length - 2].results[0];
  if (!quizRow) return; // deleted or already handled
  // Final progress edit + "ready" message run after the ticker has stopped.
  return { quizRow };
}

async function failChunk(env, quizId, idx, error, progress) {
  const chunk = await env.DB.prepare("SELECT status FROM chunks WHERE quiz_id = ? AND idx = ?").bind(quizId, idx).first();
  if (!chunk || chunk.status !== "pending") return;
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE chunks SET status = 'failed', error = ? WHERE quiz_id = ? AND idx = ?").bind(error.slice(0, 500), quizId, idx),
    env.DB.prepare("UPDATE quizzes SET chunks_failed = chunks_failed + 1 WHERE id = ? RETURNING *").bind(quizId),
  ]);
  await showProgress(env, quizId, progress);
  await maybeFinish(env, res[1].results[0]);
}

async function maybeFinish(env, quiz) {
  if (!quiz || quiz.chunks_done + quiz.chunks_failed < quiz.chunks_total) return;
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE quiz_id = ?").bind(quiz.id).first();
  const status = n > 0 ? "ready" : "failed";
  await env.DB.prepare("UPDATE quizzes SET status = ?, raw_text = '' WHERE id = ?").bind(status, quiz.id).run();
  const api = tg(env);
  if (status === "failed") {
    const err = await env.DB.prepare("SELECT error FROM chunks WHERE quiz_id = ? AND error IS NOT NULL LIMIT 1").bind(quiz.id).first();
    if (err && isDailyLimit(err.error)) {
      return api.send(quiz.owner_id,
        `😔 The free AI's daily limit is used up, so <b>${esc(quiz.title)}</b> couldn't be processed.\nIt resets at 00:00 UTC; then use /retry ${quiz.code}.\n(Adding $10 of OpenRouter credits once raises the limit from 50 to 1000 requests a day.)`);
    }
    if (err && isOverloadError(err.error)) {
      return api.send(quiz.owner_id,
        `😔 The AI is overloaded right now, so <b>${esc(quiz.title)}</b> couldn't be processed.\nPlease try again in a few minutes: /retry ${quiz.code}`);
    }
    return api.send(quiz.owner_id,
      `❌ Could not build <b>${esc(quiz.title)}</b>: no questions were recognised.${err ? `\nLast error: <code>${esc(err.error)}</code>` : ""}\nTry /retry ${quiz.code}`);
  }
  return api.send(quiz.owner_id, await readyMessage(env, quiz, n, quiz.chunks_failed));
}

async function readyMessage(env, quiz, count, failedParts) {
  const link = await shareLink(env, quiz.code);
  const { low } = await env.DB.prepare("SELECT COUNT(*) AS low FROM questions WHERE quiz_id = ? AND confidence = 'low'").bind(quiz.id).first();
  let text = `✅ <b>${esc(quiz.title)}</b> is ready: <b>${count}</b> questions.\n\n🔗 Share this link to let anyone practise:\n${link}\n\nCode: <code>${quiz.code}</code> — /practice ${quiz.code}`;
  if (low) text += `\n\n⚠️ The AI was unsure about ${low} answer(s). Check them with /export ${quiz.code} (look for "confidence": "low"), fix, and upload the JSON back.`;
  if (failedParts) {
    const err = await env.DB.prepare("SELECT error FROM chunks WHERE quiz_id = ? AND status = 'failed' LIMIT 1").bind(quiz.id).first();
    text += err && isOverloadError(err.error)
      ? `\n\n⚠️ ${failedParts} part(s) were skipped because the AI is overloaded right now. Try again later with /retry ${quiz.code} to add the missing questions.`
      : `\n\n⚠️ ${failedParts} part(s) failed to process. Use /retry ${quiz.code}.`;
  }
  return text;
}

function questionInserts(env, quizId, basePos, questions) {
  return questions.map((q, i) =>
    env.DB.prepare(
      "INSERT INTO questions (quiz_id, position, question, options, correct, explanation, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(quizId, basePos + i, q.question, JSON.stringify(q.options), q.correct, q.explanation || null, q.confidence || null));
}

async function insertQuestions(env, quizId, basePos, questions) {
  const stmts = questionInserts(env, quizId, basePos, questions);
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

async function retryFailed(env, quiz, chat) {
  const api = tg(env);
  // Failed parts, plus parts stuck in "waiting" (e.g. the background job was killed).
  const { results } = await env.DB.prepare("SELECT idx FROM chunks WHERE quiz_id = ? AND status IN ('failed', 'pending')").bind(quiz.id).all();
  if (!results.length) return api.send(chat, "Nothing to retry: all parts are done.");
  await env.DB.batch([
    env.DB.prepare("UPDATE chunks SET status = 'pending', error = NULL WHERE quiz_id = ? AND status = 'failed'").bind(quiz.id),
    env.DB.prepare("UPDATE quizzes SET status = 'processing', chunks_failed = 0, chunks_done = chunks_total - ? WHERE id = ?").bind(results.length, quiz.id),
  ]);
  const fresh = await env.DB.prepare("SELECT * FROM quizzes WHERE id = ?").bind(quiz.id).first();
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE quiz_id = ?").bind(quiz.id).first();
  const sent = await api.send(chat, progressText(fresh, n, `🔁 Retrying ${results.length} part(s)…`), { reply_markup: stopKeyboard(quiz.code) });
  const progress = { chat, msg: sent.message_id };
  await env.QUIZ_QUEUE.sendBatch(results.map((r) => ({ body: { quizId: quiz.id, idx: r.idx, progress } })));
}

// ───────────────────────────── managing quizzes ─────────────────────────────

let cachedUsername = null;
async function shareLink(env, code) {
  if (!cachedUsername) cachedUsername = env.BOT_USERNAME || (await tg(env).call("getMe")).username;
  return `https://t.me/${cachedUsername}?start=q_${code}`;
}

const ownedQuiz = (env, uid, code) =>
  code ? env.DB.prepare("SELECT * FROM quizzes WHERE code = ? AND owner_id = ?").bind(code.replace(/^q_/, ""), uid).first() : null;

async function deleteQuiz(env, quizId) {
  await ensureReadingTable(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reading WHERE quiz_id = ?").bind(quizId),
    env.DB.prepare("DELETE FROM questions WHERE quiz_id = ?").bind(quizId),
    env.DB.prepare("DELETE FROM chunks WHERE quiz_id = ?").bind(quizId),
    env.DB.prepare("DELETE FROM sessions WHERE quiz_id = ?").bind(quizId),
    env.DB.prepare("DELETE FROM drafts WHERE quiz_id = ?").bind(quizId),
    env.DB.prepare("DELETE FROM quizzes WHERE id = ?").bind(quizId),
  ]);
}

async function listQuizzes(env, uid, chat) {
  const api = tg(env);
  const { results } = await env.DB.prepare(
    `SELECT q.*, (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) AS n
     FROM quizzes q WHERE owner_id = ? ORDER BY id DESC LIMIT 30`,
  ).bind(uid).all();
  if (!results.length) return api.send(chat, "You have no quizzes yet. Start with /new <i>title</i>.");
  const icon = { draft: "📝", processing: "⏳", ready: "✅", failed: "❌" };
  const lines = [];
  const keyboard = [];
  const short = (t) => (t.length > 22 ? t.slice(0, 21) + "…" : t);
  for (const q of results) {
    let line = `${icon[q.status] || "•"} <b>${esc(q.title)}</b> — ${q.n} questions — <code>${q.code}</code>`;
    if (q.status === "processing") line += ` (${q.chunks_done + q.chunks_failed}/${q.chunks_total} parts)`;
    if (q.status === "draft") line += " (draft: send /done to process)";
    if (q.status === "ready") line += `\n    ${await shareLink(env, q.code)}`;
    lines.push(line);
    if (keyboard.length < 20) {
      const row = q.status === "ready"
        ? [{ text: `▶️ ${short(q.title)}`, callback_data: `prac:${q.code}` }, { text: "📤", callback_data: `exp:${q.code}` }]
        : [{ text: `${icon[q.status] || "•"} ${short(q.title)}`, callback_data: `prac:${q.code}` }];
      row.push({ text: q.status === "processing" ? "⏹🗑" : "🗑", callback_data: `del:${q.code}` });
      keyboard.push(row);
    }
  }
  keyboard.push([{ text: "🗑 Delete all my quizzes", callback_data: "delall" }]);
  lines.push("\n▶️ practise · 📤 export · 🗑 delete · ⏹🗑 stop & delete");
  return api.send(chat, lines.join("\n"), { reply_markup: { inline_keyboard: keyboard } });
}

async function exportQuiz(env, uid, chat, code) {
  const api = tg(env);
  const quiz = await ownedQuiz(env, uid, code);
  if (!quiz) return api.send(chat, "Usage: /export <i>code</i> (see /my)");
  const { results } = await env.DB.prepare("SELECT * FROM questions WHERE quiz_id = ? ORDER BY position").bind(quiz.id).all();
  const data = {
    title: quiz.title,
    questions: results.map((r) => ({
      question: r.question,
      options: JSON.parse(r.options),
      correct: r.correct,
      explanation: r.explanation || "",
      confidence: r.confidence || "medium",
    })),
  };
  const safe = quiz.title.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "quiz";
  return api.sendDocument(chat, `${safe}.json`, JSON.stringify(data, null, 2),
    `${results.length} questions. "correct" is the 0-based index of the right option. Edit and send this file back to create a corrected quiz.`);
}

// ───────────────────────────── delete / manage buttons ─────────────────────────────

async function onManageCallback(env, cb, kind, code) {
  const api = tg(env);
  const uid = cb.from.id;
  const chat = cb.message.chat.id;
  const edit = (text, keyboard = []) =>
    api.call("editMessageText", {
      chat_id: chat, message_id: cb.message.message_id, text, parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    }).catch(() => api.send(chat, text, { reply_markup: { inline_keyboard: keyboard } }));

  switch (kind) {
    case "prac":
      return offerQuiz(env, chat, code);
    case "exp":
      return exportQuiz(env, uid, chat, code);
    case "del": {
      const quiz = await ownedQuiz(env, uid, code);
      if (!quiz) return api.send(chat, "That quiz no longer exists.");
      const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE quiz_id = ?").bind(quiz.id).first();
      const what = quiz.status === "processing" ? "This stops the AI and deletes" : "This deletes";
      return api.send(chat,
        `🗑 Delete <b>${esc(quiz.title)}</b>?\n${what} the quiz and its ${n} question(s). People with the link won't be able to open it any more.`,
        { reply_markup: { inline_keyboard: [[
          { text: "Yes, delete", callback_data: `delyes:${quiz.code}` },
          { text: "Cancel", callback_data: "delno" },
        ]] } });
    }
    case "delyes": {
      const quiz = await ownedQuiz(env, uid, code);
      if (!quiz) return edit("Already deleted.");
      await deleteQuiz(env, quiz.id);
      return edit(`🗑 Deleted <b>${esc(quiz.title)}</b>.`);
    }
    case "delno":
      return edit("Cancelled. Nothing was deleted.");
    case "delall": {
      const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM quizzes WHERE owner_id = ?").bind(uid).first();
      if (!n) return api.send(chat, "You have no quizzes.");
      return api.send(chat, `⚠️ Delete <b>all ${n}</b> of your quizzes? This also stops any that are still processing. This can't be undone.`, {
        reply_markup: { inline_keyboard: [[
          { text: `Yes, delete all ${n}`, callback_data: "delallyes" },
          { text: "Cancel", callback_data: "delno" },
        ]] },
      });
    }
    case "delallyes": {
      const { results } = await env.DB.prepare("SELECT id FROM quizzes WHERE owner_id = ?").bind(uid).all();
      for (const r of results) await deleteQuiz(env, r.id);
      return edit(`🗑 Deleted ${results.length} quiz(zes).`);
    }
  }
}

// ───────────────────────────── practice ─────────────────────────────

async function offerQuiz(env, chat, code) {
  const api = tg(env);
  const quiz = await env.DB.prepare("SELECT * FROM quizzes WHERE code = ?").bind(code).first();
  if (!quiz) return api.send(chat, "Quiz not found. Check the link or code.");
  if (quiz.status !== "ready") return api.send(chat, "This quiz is still being prepared. Try again in a few minutes.");
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE quiz_id = ?").bind(quiz.id).first();
  const sizes = [10, 20, 50].filter((s) => s < n);
  const buttons = [...sizes.map((s) => ({ text: `${s}`, callback_data: `go:${code}:${s}` })), { text: `All ${n}`, callback_data: `go:${code}:0` }];
  return api.send(chat, `📚 <b>${esc(quiz.title)}</b>\n${n} questions. How many do you want? (random order)`, {
    reply_markup: { inline_keyboard: [buttons] },
  });
}

async function onCallback(cb, env) {
  const api = tg(env);
  await api.call("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
  const [kind, code, countStr] = (cb.data || "").split(":");
  if (!cb.message) return;
  if (kind !== "go") return onManageCallback(env, cb, kind, code);
  const quiz = await env.DB.prepare("SELECT * FROM quizzes WHERE code = ? AND status = 'ready'").bind(code).first();
  if (!quiz) return api.send(cb.message.chat.id, "Quiz not found.");
  const { results } = await env.DB.prepare("SELECT id FROM questions WHERE quiz_id = ?").bind(quiz.id).all();
  let order = shuffle(results.map((r) => r.id));
  const count = Number(countStr);
  if (count > 0) order = order.slice(0, count);

  const session = { user_id: cb.from.id, chat_id: cb.message.chat.id, quiz_id: quiz.id, q_order: order, idx: 0, score: 0 };
  await env.DB.prepare(
    "INSERT OR REPLACE INTO sessions (user_id, chat_id, quiz_id, q_order, idx, score, poll_id, started_at) VALUES (?, ?, ?, ?, 0, 0, NULL, ?)",
  ).bind(session.user_id, session.chat_id, quiz.id, JSON.stringify(order), now()).run();
  await api.send(session.chat_id, `▶️ Starting <b>${esc(quiz.title)}</b>: ${order.length} questions. /stop to quit.`);
  return sendCurrent(env, session);
}

async function sendCurrent(env, s) {
  const api = tg(env);
  const total = s.q_order.length;
  if (s.idx >= total) {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(s.user_id).run();
    const pct = Math.round((100 * s.score) / Math.max(total, 1));
    const medal = pct >= 90 ? "🏆" : pct >= 70 ? "🎉" : pct >= 50 ? "👍" : "📖";
    const quiz = await env.DB.prepare("SELECT code FROM quizzes WHERE id = ?").bind(s.quiz_id).first();
    return api.send(s.chat_id, `${medal} Finished! Score: <b>${s.score}/${total}</b> (${pct}%).${quiz ? `\nTry again: /practice ${quiz.code}` : ""}`);
  }
  const row = await env.DB.prepare("SELECT * FROM questions WHERE id = ?").bind(s.q_order[s.idx]).first();
  if (!row) { // question deleted meanwhile; skip it
    s.idx++;
    return sendCurrent(env, s);
  }
  const { preface, poll } = buildPoll({ ...row, options: JSON.parse(row.options) }, s.idx + 1, total);
  if (preface) await api.send(s.chat_id, esc(preface));
  const sent = await api.call("sendPoll", { chat_id: s.chat_id, ...poll });
  await env.DB.prepare("UPDATE sessions SET poll_id = ?, idx = ?, score = ? WHERE user_id = ?")
    .bind(sent.poll.id, s.idx, s.score, s.user_id).run();
}

async function onPollAnswer(ans, env) {
  const uid = ans.user?.id;
  if (!uid) return;
  const row = await env.DB.prepare("SELECT * FROM sessions WHERE user_id = ? AND poll_id = ?").bind(uid, ans.poll_id).first();
  if (!row) return; // old poll or session stopped
  const s = { ...row, q_order: JSON.parse(row.q_order) };
  const q = await env.DB.prepare("SELECT correct FROM questions WHERE id = ?").bind(s.q_order[s.idx]).first();
  if (q && ans.option_ids?.[0] === q.correct) s.score++;
  s.idx++;
  // Claim this poll so a duplicate delivery can't advance twice.
  const claimed = await env.DB.prepare("UPDATE sessions SET poll_id = NULL, idx = ?, score = ? WHERE user_id = ? AND poll_id = ?")
    .bind(s.idx, s.score, uid, ans.poll_id).run();
  if (!claimed.meta.changes) return;
  return sendCurrent(env, s);
}
