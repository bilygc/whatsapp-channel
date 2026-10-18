#!/usr/bin/env tsx
/**
 * `npm run telegramSend` — M3 delivery CLI: push every `pending` draft to
 * the configured Telegram chat (article image + ready-to-paste Spanish
 * caption + posted/skipped buttons). Per-draft isolation: a failed send
 * leaves that draft `pending` for a retry and the rest still deliver. Exit
 * code is 1 only if ALL attempted drafts failed. Status changes happen only
 * via the `npm run telegramListen` buttons, never here.
 */
import { config } from 'dotenv';
import { applyMigrations, openDb, resolveDbPath } from '../db/migrate.js';
import { resolveTelegramConfig } from '../telegram/config.js';
import { runTelegramSend } from '../telegram/send.js';
import { formatCliFailure, formatDraftSendLine } from './format.js';

config();

async function main(): Promise<void> {
  const { token, chatId } = resolveTelegramConfig();
  if (!token || !chatId) {
    console.error(
      'telegramSend failed: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set ' +
        '(see docs/telegram.md — run `npm run telegramSetup` once to find your chat id).',
    );
    process.exitCode = 1;
    return;
  }

  const db = openDb(resolveDbPath());
  try {
    applyMigrations(db);
    const summary = await runTelegramSend(db, { fetchFn: fetch, token, chatId });
    for (const r of summary.results) {
      console.log(formatDraftSendLine(r));
    }
    console.log(`Total: pending=${summary.total} sent=${summary.sent} failed=${summary.failed}`);
    process.exitCode = summary.exitCode;
  } catch (err) {
    console.error(formatCliFailure('telegramSend', err, token));
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  // Resolve the TRIMMED config token (not the raw env value): request URLs
  // are built with the trimmed form, so only it reliably redacts an error
  // echoing request details when `.env` padded or quoted the value.
  const { token } = resolveTelegramConfig();
  console.error(formatCliFailure('telegramSend', err, token ?? ''));
  process.exitCode = 1;
});
