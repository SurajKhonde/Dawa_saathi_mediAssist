# Dawa Saathi — Medicine Awareness Bot


## 🌐 Multilingual support (English + ಕನ್ನಡ)

On `/start` the bot asks the user to pick a language; the choice is stored per-user in Redis and used for every reply. Switch anytime with `/language`.

Two layers keep this fast and faithful:

- **Static UI** (buttons, section labels, errors, disclaimer) lives in a small i18n table (`src/config/i18n.ts`) — instant and zero token cost. The medical disclaimer is reviewed per language.
- **The medicine response itself is LLM-generated directly in the user's language** — the awareness model writes the values in the target language while JSON keys stay English and drug names stay in Latin script. No brittle dictionary, nothing dropped, and only one model call. Each language is cached separately (`ingredients:purpose:lang`).

Adding a language (Hindi, Marathi, ...) is two edits: a `LangCode` entry in `src/config/languages.ts` and a strings block in `src/config/i18n.ts`.

A Telegram bot that helps people **understand medicine labels** in simple, elder-friendly language. Send a photo of a medicine strip; the bot reads it, asks what you're taking it for, then explains common uses, side effects, and warnings — tailored to your reason.

**This bot does NOT diagnose, prescribe, or recommend dosages. Every response ends with a disclaimer to consult a qualified doctor.**

Guiding principle: **a confident wrong answer is more dangerous than no answer.** The whole design serves that.

## What makes it different

- **Reads with AI vision, not OCR** — Claude reads the label directly, far more accurately than Tesseract on real Indian medicine strips.
- **Refuses to guess** — if it isn't confident it read the medicine correctly (below 0.75), it asks for a clearer photo instead of guessing. This prevents dangerous misreads (e.g. Tranexamic Acid vs Mefenamic Acid).
- **Asks your purpose** — the same medicine can be prescribed for different reasons. After reading the label, the bot asks why you take it and tailors the answer, so a correctly-prescribed patient isn't alarmed by an unrelated primary use.

## Architecture

The bot runs as two stages with a question in between.

```
Telegram (long polling)
        │
        ▼
  Telegram handler
        │
        ▼
  Rate limit (Redis)              ◄── 3 scans/day free
        │
        ▼
  STAGE 1: Vision read (Claude)   ◄── image → base64 → Claude vision
        │
        ▼
  Confidence gate                 ◄── < 0.75 or not a medicine? ask for clearer photo, refund scan
        │  (pass)
        ▼
  Ask purpose (buttons)           ◄── "what are you using this for?"  → saved in Redis 10 min
        │  (user answers)
        ▼
  Cache lookup (Redis → Postgres) ◄── medicine + purpose; skip AI if seen before
        │  (miss)
        ▼
  openFDA verify (optional)       ◄── confirm ingredient, enrich
        │
        ▼
  STAGE 2: Awareness (Claude)     ◄── purpose-tailored summary
        │
        ▼
  Store (Postgres + Redis) → format + disclaimer → reply
```

### Key design decisions

| Decision | Why |
|---|---|
| Claude vision, not Tesseract OCR | Far more accurate on real medicine strips; no noisy-OCR-then-guess chain |
| Two stages (read, then explain) | The AI never guesses-and-explains in one muddy step |
| Confidence gate at 0.75 | Below it, refuse and ask for a clearer photo; never a confident wrong answer |
| Ask the user's purpose | Same drug, different uses; tailoring prevents needless panic |
| Long polling, not webhooks | Zero infra; no public URL or ngrok; works in Docker |
| Two-tier cache (Redis → Postgres) | Fast lookups + durability; same medicine+purpose = one AI call ever |
| Rate limit in Redis with daily TTL | Atomic INCR, self-resets at midnight |
| Disclaimer appended in code | Compliance: users always see it, even if the AI omits it |

## Project structure

```
medicine-awareness-bot/
├── docker-compose.yml          Postgres + Redis + app (with IPv4 fix)
├── Dockerfile                  Multi-stage build, non-root, tini
├── package.json
├── tsconfig.json
├── .env.example
└── src/
    ├── index.ts                Bootstrap + graceful shutdown
    ├── app.ts                  Express (health checks only)
    ├── config/
    │   ├── env.ts              Zod-validated environment variables
    │   ├── logger.ts           Pino structured logging
    │   └── constants.ts        Disclaimer, cache prefixes, thresholds
    ├── db/
    │   ├── client.ts           Postgres pool
    │   ├── migrate.ts          Idempotent schema creation
    │   └── repositories/
    │       ├── medicine.repository.ts
    │       └── usage.repository.ts
    ├── redis/
    │   └── client.ts           ioredis client + retry strategy
    ├── prompts/
    │   ├── extraction.prompt.ts  Stage 1: read label, never guess
    │   └── awareness.prompt.ts   Stage 2: purpose-tailored explanation
    ├── services/
    │   ├── telegram.service.ts   Bot lifecycle, download, send (all retry)
    │   ├── vision.service.ts     Stage 1: Claude reads the image
    │   ├── awareness.service.ts  Stage 2: Claude writes the summary
    │   ├── fda.service.ts        openFDA ingredient verification
    │   ├── cache.service.ts      Two-tier cache + pending-extraction state
    │   ├── ratelimit.service.ts  Per-user daily quota
    │   └── medicine.service.ts   Pipeline orchestrator
    ├── handlers/
    │   └── telegram.handler.ts   commands, photo, purpose buttons, text
    ├── routes/
    │   └── health.routes.ts      /health and /health/ready
    ├── types/
    │   └── index.ts              Shared TypeScript types
    └── utils/
        ├── async.ts              sleep, retry, genReqId
        ├── normalize.ts          ingredient hashing, date helpers
        └── format.ts             Telegram message formatters
```

## Setup

### Prerequisites
- Docker + Docker Compose (the only hard requirement)
- A Telegram bot token (from @BotFather)
- An Anthropic API key (from console.anthropic.com)

### 1. Configure

```bash
cp .env.example .env
nano .env
```

Set at minimum:
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- `EXTRACTION_MODEL=claude-sonnet-4-6` — accurate model for reading labels
- `POSTGRES_PASSWORD` — change to something strong

### 2. Run with Docker

```bash
docker compose up -d --build
docker compose logs -f app
```

You should see, within ~15 seconds:

```
Postgres connected
Migrations complete
Redis ping OK
HTTP server listening
Telegram bot started (polling mode)
🚀 Medicine Awareness Bot is live
```

### 3. Test it

In Telegram, find your bot and:
1. Send `/start` — welcome message
2. Send a photo of a medicine strip
3. The bot reads it and asks what you're using it for — tap a button
4. Get a tailored awareness summary in a few seconds

### 4. Local development (faster iteration)

```bash
# DB + Redis in Docker, app on your machine
docker compose up -d postgres redis
# In .env set POSTGRES_HOST=localhost and REDIS_HOST=localhost
npm install
npm run migrate
npm run dev          # tsx watch, auto-reloads on changes
```

## Useful commands

```bash
npm run dev          # local dev with auto-reload
npm run build        # tsc + tsc-alias (rewrites @/ path aliases)
npm run start        # run compiled output
npm run migrate      # run DB migrations standalone
npm run typecheck    # type-check without emit

npm run docker:up    # start all containers
npm run docker:down  # stop all containers
npm run docker:logs  # tail app logs
npm run docker:reset # wipe volumes + rebuild (destroys data)
```

## Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | (required) | From @BotFather |
| `ANTHROPIC_API_KEY` | (required) | From console.anthropic.com |
| `EXTRACTION_MODEL` | `claude-sonnet-4-6` | Model used to READ the label (accuracy-critical) |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Model used to WRITE the awareness text |
| `EXTRACTION_CONFIDENCE_THRESHOLD` | `0.75` | Below this, ask for a clearer photo and refund the scan |
| `FREE_DAILY_SCAN_LIMIT` | `3` | Scans per Telegram user per day |
| `MEDICINE_CACHE_TTL_SECONDS` | `2592000` | Cache lifetime (30 days) |
| `MAX_IMAGE_BYTES` | `10485760` | Max image size (10 MB) |
| `ENABLE_FDA_LOOKUP` | `true` | Verify ingredients against openFDA |
| `LOG_LEVEL` | `info` | `debug` for verbose logs |

## How an image becomes an answer

1. Telegram delivers the photo as a `file_id`; we download the largest size.
2. Rate-limit check in Redis (3/day) before any expensive work.
3. **Stage 1:** the image is base64-encoded and sent to Claude vision with the extraction prompt. Claude returns the medicine name, ingredients, and a `readConfidence` (0–1).
4. **Confidence gate:** not a medicine, or confidence < 0.75 → ask for a clearer photo and refund the scan.
5. The reading is saved in Redis (10-min expiry) and the bot asks the user's **purpose** via tappable buttons.
6. On the user's answer: cache lookup (Redis → Postgres) keyed by ingredients + purpose; if missed, optionally verify with openFDA.
7. **Stage 2:** Claude writes a purpose-tailored awareness summary.
8. Stored in Postgres + Redis, formatted, disclaimer appended, sent back.

## Cost per scan

| Item | Cost |
|---|---|
| Vision read (Claude Sonnet) | a few rupees |
| Awareness write (Claude Haiku) | under ₹1 |
| Cache hit | ~₹0 (Redis/Postgres only) |
| openFDA, Telegram | free |

A 2 GB / 2 vCPU server comfortably runs the app + Postgres + Redis (heavy AI compute happens on Claude's servers, not yours).

## Safety architecture

Safety is enforced at FOUR independent layers:

1. **Split pipeline** — reading and interpreting are separate steps; the AI never guesses-and-explains in one pass.
2. **Extraction prompt** (`src/prompts/extraction.prompt.ts`) — forbids guessing, warns about look-alike drug names, demands an honest confidence score.
3. **Confidence gate** (`src/services/medicine.service.ts`) — below 0.75, refuse and refund the scan. No confident wrong answers.
4. **Awareness prompt + disclaimer** — never diagnoses/prescribes/doses; the disclaimer is appended in code (single source of truth in `constants.ts`) on every message.

If extending this bot, **do not weaken any of these layers**.

## Production considerations (not in MVP)

- Switch to webhooks for lower idle resource use
- India-specific drug RAG layer (openFDA is US data, matches by ingredient not Indian brand)
- Multi-language UI (Hindi, Tamil, Kannada — strings centralized in `utils/format.ts`)
- Error tracking (Sentry), analytics dashboard (Postgres `scan_log` already collects data)
- Premium tier (Razorpay, higher daily limits)

## License

MIT