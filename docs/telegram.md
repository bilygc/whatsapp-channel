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
npm run telegramSend    # push all pending drafts to your DM now
npm run telegramListen  # long-poll button presses, updates drafts.status (Ctrl+C stops)
```

`telegramSend` is send-only and safe to run while the listener polls.
`telegramSetup` and `telegramListen` both use `getUpdates` — run only one
at a time or Telegram answers the second with HTTP 409.

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
  one retry); other failures leave the draft `pending`.
- **At-least-once, schema-free.** Only `pending` drafts send; nothing is
  written on send. A draft is `pending` until a button marks it
  `posted` (`posted_at` stamped) or `skipped` (`posted_at` stays NULL).
  Consequence: re-running `telegramSend` before marking resends — dedupe is
  visual (you already have it on your phone). No schema change was needed
  (no `telegram_message_id` column); if exactly-once tracking is ever
  wanted, that is a `dba` migration decision.
- **Untrusted inbound.** Callback data must match exactly
  `draft:<id>:<posted|skipped>` with a positive integer id; updates from
  other chats are ignored (chat id pinned to `TELEGRAM_CHAT_ID`); drafts are
  re-checked as `pending` with a compare-and-set update, so duplicate taps
  are no-ops. The listener polls `callback_query` updates only.
- **Loop safety.** `runTelegramListen` keeps the `getUpdates` offset,
  survives failed polls (sanitized log + backoff + continue), and exits on
  SIGINT. A `maxTicks`/`shouldStop` seam keeps the loop unit-testable.
