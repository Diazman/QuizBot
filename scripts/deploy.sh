#!/usr/bin/env bash
# One-command deploy to Cloudflare Workers (free tier).
# Needs env vars: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, TELEGRAM_BOT_TOKEN, NVIDIA_API_KEY
# Safe to run again: existing database / queue are reused.
set -euo pipefail
cd "$(dirname "$0")/.."

for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TELEGRAM_BOT_TOKEN NVIDIA_API_KEY; do
  if [ -z "${!v:-}" ]; then echo "::error::Missing $v"; exit 1; fi
done

WR="npx --yes wrangler"
DB_NAME=quizbot-db
QUEUE=quizbot-jobs

echo "==> D1 database"
DB_ID=$($WR d1 list --json | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));const d=l.find(x=>x.name===process.argv[1]);console.log(d?d.uuid:"")' "$DB_NAME")
if [ -z "$DB_ID" ]; then
  $WR d1 create "$DB_NAME"
  DB_ID=$($WR d1 list --json | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(l.find(x=>x.name===process.argv[1]).uuid)' "$DB_NAME")
fi
echo "    $DB_NAME = $DB_ID"
sed "s/REPLACE_WITH_D1_ID/$DB_ID/" wrangler.toml > wrangler.deploy.toml

echo "==> Queue"
if ! $WR queues info "$QUEUE" >/dev/null 2>&1; then $WR queues create "$QUEUE"; fi

echo "==> Database migrations"
$WR d1 migrations apply "$DB_NAME" --remote -c wrangler.deploy.toml

echo "==> Deploy worker"
OUT=$(WRANGLER_LOG=${DEPLOY_DEBUG:-info} WRANGLER_LOG_SANITIZE=${DEPLOY_DEBUG_SANITIZE:-true} $WR deploy -c wrangler.deploy.toml 2>&1 | tee /dev/stderr)
URL=$(echo "$OUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)

echo "==> Secrets"
printf '%s' "$TELEGRAM_BOT_TOKEN" | $WR secret put TELEGRAM_BOT_TOKEN -c wrangler.deploy.toml
printf '%s' "$NVIDIA_API_KEY"     | $WR secret put NVIDIA_API_KEY -c wrangler.deploy.toml

if [ -z "$URL" ]; then
  echo "::warning::Could not detect the workers.dev URL. Enable a workers.dev subdomain in the Cloudflare dashboard (Workers & Pages), then re-run."
  exit 1
fi

echo "==> Telegram webhook -> $URL/webhook"
node scripts/set-webhook.mjs "$URL/webhook"
echo "Done. Open your bot in Telegram and send /start"
