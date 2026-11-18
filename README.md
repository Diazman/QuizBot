# 🇷🇺 Russian Quiz Bot

A Telegram bot that turns a pile of multiple-choice questions (any format) into **Telegram quiz polls** you can share with others.

1. You send the bot your questions (paste text, upload **PDF** / `.docx` / `.txt`, or send **photos** of the test pages).
2. The AI (**GLM-5.3 Flash on NVIDIA**, `z-ai/glm-5.3-flash`) reads them, strips the A)/Б)/1) labels, **finds the correct answer** for each one (or uses yours if you marked it, e.g. `Ответ: Б` or bold), and writes a short explanation.
3. The bot stores every question in a fixed format and gives you a **share link** like `https://t.me/YourBot?start=q_ab12cd34`.
4. Anyone who opens the link picks 10 / 20 / 50 / all questions and gets them as quiz polls one by one, in random order, with a score at the end.

It runs on the **Cloudflare Workers free tier** (Worker + D1 database + Queues; PDFs are converted to text with Workers AI `toMarkdown`, which is free for PDFs. Photos and scanned PDFs are read by the same NVIDIA GLM-5.3 Flash model, which understands images). GitHub Actions only **deploys** it and copies your GitHub secrets into Cloudflare. Nothing runs on GitHub after that.

## The bot's question format

This is what the AI produces. You can download it with `/export <code>`:

```json
{
  "title": "Ударения",
  "questions": [
    {
      "question": "В каком слове ударение падает на второй слог?",
      "options": ["торты", "звонит", "красивее", "щавель"],
      "correct": 1,
      "explanation": "звонИт — ударение на окончание.",
      "confidence": "high"
    }
  ]
}
```

`correct` is the 0-based index of the right option. If the AI wasn't sure, `confidence` is `"low"`, and the bot tells you how many of those there are. To fix answers, edit the file and send it back to the bot. A `.json` upload skips the AI and becomes a new quiz right away.

## Commands

| Command | What it does |
|---|---|
| `/new <title>` | Start a new quiz, then send questions (any number of messages and files) |
| `/done` | Send the draft to the AI |
| *(upload a file without `/new`)* | The file becomes a quiz straight away |
| `/my` | Your quizzes, their status and share links |
| `/practice <code>` | Practise a quiz |
| `/export <code>` | Download the quiz as JSON (owner only) |
| `/retry <code>` | Re-run parts that failed (for example after an API rate limit) |
| `/delete <code>` | Delete a quiz |
| `/stop` | Stop the current practice |
| `/cancel` | Throw away the current draft |

## Setup (one time, about 10 minutes)

### 1. Create the Telegram bot
Message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the **token**.

### 2. Give Cloudflare access to this repo
On GitHub, open **Settings → Applications → Cloudflare Workers and Pages → Configure** (or install it from <https://github.com/apps/cloudflare-workers-and-pages>). Under **Repository access**, allow **QuizBot**, and accept any pending permission request.

### 3. Create the worker from the repo
In the Cloudflare dashboard, go to **Workers & Pages → Create application → Import a repository** and pick `Diazman/QuizBot`. Use these settings:
- Project name: `quizbot`
- Build command: *(empty)*
- Deploy command: `npx wrangler deploy`
- Production branch: `main`

Every push to `main` now redeploys the bot automatically.

### 4. Add the keys
Open the **quizbot** worker and go to **Settings → Variables and Secrets**. Add these two entries with type **Secret**:
- `TELEGRAM_BOT_TOKEN`: the BotFather token
- `OPENROUTER_API_KEY`: the main AI. The bot uses the strongest **free** OpenRouter model available at that moment. It looks up OpenRouter's live model list, prefers Nemotron 3.5 Super VL, and sends up to 3 models so OpenRouter can switch between them when one is busy.
- `NVIDIA_API_KEY`: the backup AI (`z-ai/glm-5.3-flash`), used when OpenRouter fails. If both fail, the bot says the AI is overloaded and to try again later with `/retry`.

### 5. Connect Telegram
Open `https://quizbot.<your-subdomain>.workers.dev/setup` once. It should say "✅ Telegram is connected". Then send `/start` to your bot.

The database (`quizbot-db`) and queue (`quizbot-jobs`) already exist, and the database ID is in `wrangler.toml`. If you ever set this up in a different Cloudflare account, create them with `npx wrangler d1 create quizbot-db` and `npx wrangler queues create quizbot-jobs`, put the new database ID in `wrangler.toml`, and run `npx wrangler d1 migrations apply quizbot-db --remote`.

The GitHub Actions workflow (`.github/workflows/deploy.yml` with `scripts/deploy.sh`) is another way to deploy, using a Cloudflare API token. It only runs when you start it manually.

## How it works

```
Telegram ──webhook──▶ Worker (fetch) ──▶ D1: quizzes, questions, sessions
                          │
                          └─▶ Queue: one message per ~6 000-character chunk (~20 questions)
                                   │
                                   ▼
                     Worker (queue consumer) ──▶ NVIDIA API (GLM-5.3 Flash)
                                   │                retries on 429/5xx
                                   ▼
                     questions saved ──▶ "✅ ready + share link" message to the owner
```

- 200 questions turn into about 10 chunks. They are processed two at a time, which keeps the bot under NVIDIA's free-tier rate limit.
- The text is split only where a new question starts, so no question is cut in half.
- Telegram limits polls to 300 characters per question and 100 per option. Longer questions are sent as a normal message first, and the poll follows it. Long options are shortened with "…".
- Poll answers are tracked per user, so many people can practise the same quiz at the same time.

## Settings

In `wrangler.toml` under `[vars]`:
- `NVIDIA_MODEL`: defaults to `z-ai/glm-5.3-flash`
- `AI_ORDER`: optional; defaults to `openrouter,nvidia`. Set it to `nvidia,openrouter` to try NVIDIA first.
- `OPENROUTER_MODEL`: optional; pins one OpenRouter model instead of picking the best free one automatically
- `BOT_USERNAME`: optional; the bot looks it up itself if you leave it out

## Local development

```bash
npm install
npm test                                        # unit tests
npx wrangler d1 migrations apply quizbot-db --local
# put TELEGRAM_BOT_TOKEN and NVIDIA_API_KEY in .dev.vars
npx wrangler dev
```

To deploy from your own computer instead of GitHub Actions, export the four variables above and run `bash scripts/deploy.sh`.
