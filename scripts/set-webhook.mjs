// Point the Telegram bot at the worker and register the command menu.
// Usage: TELEGRAM_BOT_TOKEN=... node scripts/set-webhook.mjs https://quizbot.<you>.workers.dev/webhook
import { webhookSecret } from "../src/telegram.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const url = process.argv[2];
if (!token || !url) {
  console.error("Usage: TELEGRAM_BOT_TOKEN=... node scripts/set-webhook.mjs <webhook-url>");
  process.exit(1);
}

async function call(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

await call("setWebhook", {
  url,
  secret_token: await webhookSecret(token),
  allowed_updates: ["message", "callback_query", "poll_answer"],
  drop_pending_updates: false,
});
await call("setMyCommands", {
  commands: [
    { command: "new", description: "Create a new quiz" },
    { command: "done", description: "Finish uploading and let the AI build the quiz" },
    { command: "my", description: "My quizzes and share links" },
    { command: "practice", description: "Practise a quiz by code" },
    { command: "export", description: "Download a quiz as JSON" },
    { command: "delete", description: "Delete or stop quizzes" },
    { command: "check", description: "Test the AI / see why a quiz is stuck" },
    { command: "stop", description: "Stop the current quiz" },
    { command: "help", description: "How it works" },
  ],
});
const me = await call("getMe", {});
console.log(`Webhook set. Bot: https://t.me/${me.username}`);
