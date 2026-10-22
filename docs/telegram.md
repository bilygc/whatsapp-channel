# Telegram delivery (M3)

The bot DMs you each `pending` draft — article image + ready-to-paste
Spanish caption — so you can manually paste it to WhatsApp. Inline buttons
mark the draft **posted** / **skipped** from the phone (feeds `drafts.status`
and `posted_at`; `views` stays NULL for manual M4 logging).

## One-time setup

1. Talk to [@BotFather](https://t.me/BotFather) on Telegram: `/newbot`,
   follow the prompts, copy the token into `.env` as `TELEGRAM_BOT_TOKEN=`.
2. DM your new bot (any message, e.g. `/start`).
3. Stop the listener if it runs, then resolve your chat id:
   ```sh
   npm run telegramSetup
   ```
   It lists recently seen chats — copy the numeric id of your private chat.
4. Put it in `.env` as `TELEGRAM_CHAT_ID=`.
5. Verify the token without sending anything: `npm run telegramSetup`
   hitting the API successfully is already proof (or call `getMe` via the
   transport in `src/telegram/api.ts`).

## Daily use

```sh
npm run telegramSend                  # push every UNSENT pending draft now
npm run telegramSend -- --resend      # re-arm ALL pending drafts, then send
npm run telegramSend -- --resend 3 7  # re-arm only drafts 3 and 7, then send
npm run telegramListen  # long-poll button presses, updates drafts.status (Ctrl+C stops)
```

`telegramSend` is send-only and safe to run while the listener polls.
`telegramSetup` and `telegramListen` both use `getUpdates` — run only one
at a time or Telegram answers the second with HTTP 409.

## Automation

The whole chain (select → write → telegramSend) runs on cron — three
deliveries daily at 08:55/13:55/18:55 server time, plus a 15-minute fetch.
See [docs/schedule.md](schedule.md) for install, logs, and how to stop.

## Design decisions

- **No SDK, plain `fetch`** over `https://api.telegram.org/bot<token>/<method>`
  (`src/telegram/api.ts`), same conventions as the fetcher/writer: injected
  `fetchFn`, `AbortSignal.timeout` budgets, streaming body caps,
  `redirect: 'error'` (the token rides in the URL), typed errors, secrets
  scrubbed (`sanitizeTelegram()` redacts `bot<token>` patterns).
- **`parse_mode` omitted (plaintext).** Captions carry bare URLs, which
  Telegram clients auto-linkify. A stray `*`/`_`/`[` (common in URLs and
  Spanish copy) would break Markdown/HTML parsing and fail the send, so
  plaintext keeps delivery independent of caption content. You still copy
  the whole caption text as before.
- **Caption limit 1024 chars** (`TELEGRAM_CAPTION_LIMIT`), applied to both
  `sendPhoto` captions and `sendMessage` text so both paths behave
  identically. The writer cap (1000) already sits under it
  (`fitCaptionForTelegram` asserts this in tests); a legacy longer draft is
  truncated body-first with the `Fuente:` attribution line intact, and a
  draft whose attribution alone exceeds 1024 is a typed skip (stays
  `pending` for a human to look at). There is no `parse_mode` entity
  interplay to account for since captions are plaintext.
- **`sendPhoto` by image URL** — Telegram fetches the image server-side; the
  process never downloads remote bytes (SSRF surface stays low; ingest
  already vetted the URL). HTTP 400 from `sendPhoto` (Telegram can't fetch
  that image) falls back to a text `sendMessage` so the caption still
  arrives. HTTP 429 honours the machine-readable `retry_after` (sleep +
  one retry); other failures leave the draft queued (`last_sent_at` NULL).
- **Send-once, not at-least-once.** The send queue is
  `status = 'pending' AND last_sent_at IS NULL` (partial index
  `idx_drafts_unsent`; migration `0002_draft_send_tracking.sql`). A successful
  send stamps `last_sent_at` (compare-and-set — still NULL wins) plus the
  `telegram_message_id` Telegram returned, so the scheduled timer sends each
  draft exactly ONCE even before you press a button. Drafts you haven't marked
  simply wait — later timer runs never re-send them. Status changes still
  happen only via the buttons (`posted` stamps `posted_at`, `skipped` leaves
  it NULL). Escape hatch: `--resend` clears the tracking columns (for the
  given ids, or all pending drafts) and then sends — NULL means "never sent
  OR manually re-armed". The writer's regenerate path (`saveDraft` UPSERT)
  never touches these columns: delivery history is send-owned.
- **Untrusted inbound.** Callback data must match exactly
  `draft:<id>:<posted|skipped>` with a positive integer id; updates from
  other chats are ignored (chat id pinned to `TELEGRAM_CHAT_ID`); drafts are
  re-checked as `pending` with a compare-and-set update, so duplicate taps
  are no-ops. The listener polls `callback_query` updates only.
- **Loop safety.** `runTelegramListen` keeps the `getUpdates` offset,
  survives failed polls (sanitized log + backoff + continue), and exits on
  SIGINT. A `maxTicks`/`shouldStop` seam keeps the loop unit-testable.
