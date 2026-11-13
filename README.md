# Kaam — personal agent on Cloudflare (free tier)

A Telegram agent on one Worker + one SQLite Durable Object. Remembers you, runs tools, messages you first. Free plan only, no card.

## Setup (once)

1. **Telegram:** in Telegram talk to @BotFather → `/newbot` → copy the token. Talk to @userinfobot → copy your numeric ID.
2. **Cloudflare:** make sure the account is on Workers Free with no payment method.
3. In this folder:
   ```
   npm install
   npx wrangler login            # approve in browser
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random 32+ chars
   npx wrangler secret put OWNER_TELEGRAM_ID
   npm test && npx wrangler deploy
   ```
4. Open `https://<worker>.workers.dev/setup?key=<TELEGRAM_WEBHOOK_SECRET>` once (registers webhook, bot commands, daily schedules; safe to repeat — also run it after changing briefing times).
5. Send `/start` to the bot.

Pick the model with `npx tsx scripts/eval-tools.ts [modelId]`, then set `MODEL_ID` in `wrangler.jsonc`.

## Demo script
Start ~2 PM IST: `/start` → ask news / link summary / "remind me in 10 minutes…" / a watch → "I'm vegetarian and I hate morning meetings" → 8 PM wrap-up arrives → 8 AM briefing → `/summary` (or set `DEMO_END_AT`, e.g. `2026-11-14T14:00`, then re-run `/setup`).

## Checking usage
`/status` (free, no AI) — or Cloudflare dashboard → Workers AI. Chat stops at 8,000 Neurons (reserve left for jobs), all model calls at 9,500. Resets 5:30 AM IST.

## Troubleshooting
- No reply: `npx wrangler tail`; check `/health`; re-open `/setup?key=…`.
- Bot silent for strangers is intentional.
- "resting" message: Neuron budget; see `/status`.
- Briefing time wrong: edit vars in `wrangler.jsonc`, deploy, re-run `/setup`.

## Notes
- Search is DuckDuckGo Instant Answer + Wikipedia (keyless, shallow); news is Google News RSS.
- `read_url` blocks private/loopback addresses by hostname/IP literal; it cannot stop a public hostname that resolves to a private IP (Workers can't reach private networks anyway).
- Tests run in plain Node (`npm test`), with the Agents SDK stubbed, not in the workerd pool.
