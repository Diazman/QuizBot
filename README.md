# 🇷🇺 Russian Quiz Bot

A Telegram bot that turns a pile of multiple-choice questions (any format) into **Telegram quiz polls** you can share with others.

1. You send the bot your questions (paste text, or upload **PDF** / `.docx` / `.txt`).
2. The AI (**GLM-5.3 Flash on NVIDIA**, `z-ai/glm-5.3-flash`) reads them, strips the A)/Б)/1) labels, **finds the correct answer** for each one (or uses yours if you marked it, e.g. `Ответ: Б` or bold), and writes a short explanation.
3. The bot stores every question in a fixed format and gives you a **share link** like `https://t.me/YourBot?start=q_ab12cd34`.
4. Anyone who opens the link picks 10 / 20 / 50 / all questions and gets them as quiz polls one by one, in random order, with a score at the end.

It runs on the **Cloudflare Workers free tier** (Worker + D1 database + Queues; PDFs are converted to text with Workers AI `toMarkdown`, which is free for PDFs). GitHub Actions only **deploys** it and copies your GitHub secrets into Cloudflare. Nothing runs on GitHub after that.

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

### 2. Cloudflare (free)
1. Create a free account at <https://dash.cloudflare.com>.
2. Open **Workers & Pages** once so Cloudflare gives you a `*.workers.dev` subdomain.
3. Copy your **Account ID** (shown on the Workers & Pages overview, right sidebar).
4. Go to **My Profile → API Tokens → Create Token** and use the **"Edit Cloudflare Workers"** template. Also add the permissions **Account → D1 → Edit** and **Account → Queues → Edit**, then create the token and copy it.

### 3. GitHub secrets
In the repo, go to **Settings → Secrets and variables → Actions** and make sure these four secrets exist:

| Secret | Value |
|---|---|
| `NVIDIA_API_KEY` | your NVIDIA key (`nvapi-…`) |
| `TELEGRAM_BOT_TOKEN` | token from BotFather |
| `CLOUDFLARE_API_TOKEN` | token from step 2.4 |
| `CLOUDFLARE_ACCOUNT_ID` | account ID from step 2.3 |

If your NVIDIA secret has a different name, rename it, or change the `NVIDIA_API_KEY: ${{ secrets.… }}` line in `.github/workflows/deploy.yml`.

### 4. Deploy
Merge to `main`, or open **Actions → Deploy to Cloudflare → Run workflow**. The workflow:
- creates the D1 database and queue (only the first time),
- applies the database schema,
- deploys the worker and stores the two keys as Cloudflare secrets,
- connects the Telegram webhook.

Then open your bot in Telegram and send `/start`. Try it with `examples/sample-questions.txt`.

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
