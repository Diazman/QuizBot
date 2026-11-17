// Minimal Telegram Bot API client.

export function tg(env) {
  const api = (env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
  const base = `${api}/bot${env.TELEGRAM_BOT_TOKEN}`;
  async function call(method, params = {}) {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`);
    return data.result;
  }
  return {
    call,
    send: (chat_id, text, extra = {}) =>
      call("sendMessage", { chat_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra }),
    async sendDocument(chat_id, filename, content, caption) {
      const form = new FormData();
      form.append("chat_id", String(chat_id));
      if (caption) form.append("caption", caption);
      form.append("document", new Blob([content], { type: "application/json" }), filename);
      const res = await fetch(`${base}/sendDocument`, { method: "POST", body: form });
      const data = await res.json();
      if (!data.ok) throw new Error(`Telegram sendDocument failed: ${data.description}`);
      return data.result;
    },
    async downloadFile(file_id) {
      const file = await call("getFile", { file_id });
      const res = await fetch(`${api}/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
      if (!res.ok) throw new Error(`Could not download file (HTTP ${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** Secret Telegram echoes back in X-Telegram-Bot-Api-Secret-Token; derived from the bot token. */
export async function webhookSecret(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`quizbot:${token}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
