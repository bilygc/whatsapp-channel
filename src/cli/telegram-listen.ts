#!/usr/bin/env tsx
/**
 * `npm run telegramListen` — M3 button listener: long-polls getUpdates for
 * callback queries (marks drafts `posted` / `skipped` from the phone) and
 * `/img` reply commands (manual image generation — swaps the draft
 * message's photo, keeping caption + buttons).
 * Exits cleanly on SIGINT. A failed poll never crashes the loop
 * (log-and-continue with backoff — same degradation philosophy as the
 * fetcher). Run only ONE getUpdates consumer at a time: stop this listener
 * before `npm run telegramSetup` (Telegram answers concurrent getUpdates
 * with 409). `npm run telegramSend` is send-only and safe to run alongside.
 * The `/img` flow runs in THIS same process (no second consumer): `pollOnce`
 * advances the offset only after each update — including minutes-long image
 * generations — is fully processed.
 */
import { config } from 'dotenv';
import { applyMigrations, openDb, resolveDbPath } from '../db/migrate.js';
import { resolveImageConfig } from '../images/openrouter.js';
import { resolveTelegramConfig } from '../telegram/config.js';
import { sanitizeTelegram } from '../telegram/api.js';
import { runTelegramListen } from '../telegram/updates.js';
import { formatCliFailure } from './format.js';
import { scrub } from '../writer/validate.js';

config();

async function main(): Promise<void> {
  const { token, chatId } = resolveTelegramConfig();
  if (!token || !chatId) {
    console.error(
      'telegramListen failed: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set ' +
        '(see docs/telegram.md).',
    );
    process.exitCode = 1;
    return;
  }

  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    console.log('Stopping telegram listener…');
  });

  const db = openDb(resolveDbPath());
  try {
    applyMigrations(db);
    // Image generation reuses the writer's OpenRouter key (same billing);
    // IMAGE_MODEL overrides the default image slug. When the key is unset
    // the listener still handles buttons — only `/img` fails gracefully.
    const { apiKey: imageApiKey, model: imageModel } = resolveImageConfig();
    console.log(`Listening for draft buttons in chat ${scrub(chatId)} (Ctrl+C to stop)…`);
    await runTelegramListen(db, {
      fetchFn: fetch,
      token,
      chatId,
      imageApiKey,
      imageModel,
      shouldStop: () => stopped,
      // The token must never reach the terminal — sanitize just in case an
      // error echoes request details, then scrub terminal-escape bytes.
      onEvent: (message) => console.log(scrub(sanitizeTelegram(message, token))),
    });
  } catch (err) {
    console.error(formatCliFailure('telegramListen', err, token));
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  // Last-resort handler: the error may echo request details carrying the
  // token, so resolve the trimmed config token and redact before printing.
  const { token } = resolveTelegramConfig();
  console.error(formatCliFailure('telegramListen', err, token ?? ''));
  process.exitCode = 1;
});
