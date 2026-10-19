#!/usr/bin/env tsx
/**
 * `npm run telegramSend` — M3 delivery CLI: push every unsent `pending` draft
 * (send-once: `status = 'pending' AND last_sent_at IS NULL`) to the
 * configured Telegram chat (article image + ready-to-paste Spanish caption +
 * posted/skipped buttons). A successful send stamps `last_sent_at` + the
 * Telegram `message_id`, so re-running before marking sends nothing new.
 * Per-draft isolation: a failed send leaves that draft queued for a retry
 * and the rest still deliver. Exit code is 1 only if ALL attempted drafts
 * failed. Status changes happen only via `npm run telegramListen` buttons.
 * Usage: npm run telegramSend [-- --resend [draft-id ...]]
 *   --resend re-arms drafts (clears last_sent_at/telegram_message_id) and
 *   then sends: with draft ids only those, without ids all pending drafts.
 */
import type Database from 'better-sqlite3';
import { config } from 'dotenv';
import { applyMigrations, openDb, resolveDbPath } from '../db/migrate.js';
import { resolveTelegramConfig } from '../telegram/config.js';
import { runTelegramSend } from '../telegram/send.js';
import { formatCliFailure, formatDraftSendLine } from './format.js';

config();

export interface TelegramSendArgs {
  /** Re-arm before sending (clear delivery tracking, then send the queue). */
  resend: boolean;
  /** Optional positional draft ids limiting the re-arm (requires --resend). */
  ids: number[];
}

/**
 * Parse `npm run telegramSend [-- ...]` args. Throws a typed
 * `telegramSend failed: ...` error on bad input (never a raw throw).
 */
export function parseTelegramSendArgs(argv: string[]): TelegramSendArgs {
  const resend = argv.includes('--resend');
  const rest = argv.filter((a) => a !== '--resend');
  const ids: number[] = [];
  for (const token of rest) {
    if (token === '--help' || token === '-h') {
      throw new Error(
        'telegramSend failed: usage: npm run telegramSend [-- --resend [draft-id ...]]',
      );
    }
    const n = Number(token);
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error(
        `telegramSend failed: invalid draft id "${token}" (expected a positive integer after --resend)`,
      );
    }
    ids.push(n);
  }
  if (ids.length > 0 && !resend) {
    throw new Error(
      'telegramSend failed: draft ids require --resend (re-arm first, then send) — ' +
        'usage: npm run telegramSend [-- --resend [draft-id ...]]',
    );
  }
  return { resend, ids };
}

/**
 * Re-arm drafts for resending: clear the send-once tracking columns
 * (`last_sent_at`, `telegram_message_id`) so the send queue picks them up
 * again. With `ids`, only those drafts; otherwise every `pending` draft
 * (already-unsent ones match too — clearing NULL is a no-op for them).
 * Returns the re-armed count. Throws a typed `telegramSend failed: ...`
 * error on SQLite failures.
 */
export function rearmDrafts(db: Database.Database, ids: number[] = []): number {
  try {
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const result = db
        .prepare(
          `UPDATE drafts SET last_sent_at = NULL, telegram_message_id = NULL
           WHERE status = 'pending' AND id IN (${placeholders})`,
        )
        .run(...ids);
      return Number(result.changes);
    }
    const result = db
      .prepare(
        `UPDATE drafts SET last_sent_at = NULL, telegram_message_id = NULL
         WHERE status = 'pending'`,
      )
      .run();
    return Number(result.changes);
  } catch (err) {
    throw new Error(`telegramSend failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  let args: TelegramSendArgs;
  try {
    args = parseTelegramSendArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
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
    if (args.resend) {
      const count = rearmDrafts(db, args.ids);
      console.log(
        args.ids.length > 0
          ? `telegramSend: re-armed ${count} draft(s) (${args.ids.join(', ')}).`
          : `telegramSend: re-armed ${count} pending draft(s).`,
      );
    }
    const summary = await runTelegramSend(db, { fetchFn: fetch, token, chatId });
    for (const r of summary.results) {
      console.log(formatDraftSendLine(r));
    }
    for (const w of summary.warnings) {
      console.warn(`telegramSend warning: ${w}`);
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
