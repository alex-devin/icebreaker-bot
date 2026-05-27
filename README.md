# Versant Icebreaker Bot

An internal Slack bot for the Versant Media workspace that posts icebreakers, fun facts, and jokes on a schedule or on demand.

## Setup

### 1. Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From an app manifest**.
2. Select the Versant Media workspace.
3. Paste the contents of `manifest.yaml`.
4. Click **Create**.

### 2. Enable Socket Mode

1. In the app settings, go to **Socket Mode** and enable it.
2. Generate an **App-Level Token** with the `connections:write` scope. This is your `SLACK_APP_TOKEN` (starts with `xapp-`).

### 3. Get Tokens

- **Bot Token**: Under **OAuth & Permissions**, install the app to your workspace. Copy the `xoxb-...` token.
- **Signing Secret**: Under **Basic Information** > **App Credentials**.

### 4. Configure Environment

```bash
cp .env.example .env
```

Fill in:
- `SLACK_BOT_TOKEN` — Bot User OAuth Token (`xoxb-...`)
- `SLACK_APP_TOKEN` — App-Level Token (`xapp-...`)
- `SLACK_SIGNING_SECRET` — From app credentials
- `ICEBREAKER_ADMIN_USER_IDS` — Comma-separated Slack user IDs for admins

### 5. Install and Run

```bash
npm install
npm run dev
```

The bot seeds the database with prompts on first run.

### 6. Invite the Bot

In any channel where you want the bot to post:
```
/invite @IcebreakerBot
```

## Commands

| Command | Description | Access |
|---------|-------------|--------|
| `/icebreaker` | Post a random icebreaker | Everyone |
| `/icebreaker funfact` | Post a fun fact | Everyone |
| `/icebreaker joke` or `/icebreaker joketime` | Post a joke | Everyone |
| `/icebreaker status` | Show schedule and remaining prompts | Everyone |
| `/icebreaker help` | Show usage info | Everyone |
| `/icebreaker setup ...` | Configure channel schedule | Admin only |
| `/icebreaker reset <type\|all>` | Reset prompt memory | Admin only |

## Mentions

- `@IcebreakerBot prompt` or `@IcebreakerBot icebreaker` — Post an icebreaker
- `@IcebreakerBot funfact` — Post a fun fact
- `@IcebreakerBot joke` — Post a joke

## Schedule Setup

### Syntax

```
/icebreaker setup <frequency> [weekday] <HH:MM> <timezone> <content_type> [anchor_date]
```

### Examples

```
/icebreaker setup daily 09:00 America/New_York random
/icebreaker setup weekly thursday 10:00 America/New_York icebreaker
/icebreaker setup biweekly thursday 10:00 America/New_York joke 2026-05-28
```

### Parameters

- **frequency**: `daily`, `weekly`, or `biweekly`
- **weekday**: Required for weekly/biweekly. Full name (e.g., `monday`, `thursday`).
- **time**: 24-hour format `HH:MM`
- **timezone**: IANA timezone (e.g., `America/New_York`, `US/Pacific`, `UTC`)
- **content_type**: `icebreaker`, `funfact`, `joke`, or `random`
- **anchor_date**: Required for biweekly. `YYYY-MM-DD` format. The first post lands on this date, then every two weeks.

## Reset

Reset prompt memory so previously-used prompts become available again:

```
/icebreaker reset              # Reset icebreaker memory
/icebreaker reset icebreaker   # Same as above
/icebreaker reset funfact      # Reset fun fact memory
/icebreaker reset joke         # Reset joke memory
/icebreaker reset all          # Reset all types
```

Reset is scoped to the current channel. Other channels are not affected.

## Content Sourcing

All prompts are local reviewed seed data in `prompts.json`. Each item supports optional metadata:

- `source_name` — Origin (e.g., "original", author name)
- `source_url` — Link to source if applicable
- `license` — License type
- `reviewed_at` — Date the item was reviewed for appropriateness

Metadata is stored in the database but not shown in Slack posts.

## Testing

```bash
npm test            # Run once
npm run test:watch  # Watch mode
```

Uses **Vitest** — chosen for zero-config TypeScript support, fast execution, and a simpler setup than Jest (no `ts-jest` or babel config needed).

## Project Structure

```
src/
  app.ts                    # Entry point
  config.ts                 # Environment config
  slack/handlers.ts         # Slash command and mention handlers
  prompts/promptService.ts  # No-repeat prompt selection
  schedule/scheduleService.ts # Schedule CRUD and next-run computation
  scheduler/scheduler.ts    # Periodic scheduler loop
  store/db.ts               # SQLite schema and connection
  store/seed.ts             # Seed prompts from JSON
tests/
  promptService.test.ts     # Prompt no-repeat, reset, exhaustion
  scheduleService.test.ts   # Schedule computation, CRUD
  handlers.test.ts          # Admin access, aliases, integration
```

## Known Limitations

- Single-workspace only (no OAuth distribution flow).
- Schedule check interval is configurable via `SCHEDULER_INTERVAL_SECONDS` (default 30s). Posts may be up to that many seconds late.
- The bot must be explicitly invited to channels before it can post.
- No web UI for managing schedules — use slash commands.
- Biweekly schedules require an explicit anchor date.
- If the bot process restarts, the scheduler resumes on the next tick — no missed posts are backfilled.
- **Dev DB migration**: The `prompts` table was updated to add a `content_id` column with a `UNIQUE` constraint. Any SQLite database created before this change must be deleted and recreated (or migrated manually with `ALTER TABLE prompts ADD COLUMN content_id TEXT` followed by a data backfill). The simplest fix is to delete `icebreaker.db` and let the app recreate and reseed it on next startup. There is no automated migration framework.
