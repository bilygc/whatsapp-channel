import type Database from 'better-sqlite3';
import {
  isRateLimited,
  sendMessage,
  sendPhoto,
  type TelegramDeps,
} from './api.js';
import { TELEGRAM_CAPTION_LIMIT, fitCaptionForTelegram } from './caption.js';
import { SELECT_DEFAULT_LIMIT } from '../selector/select.js';

export interface PendingDraftRow {
  id: number;
  caption_es: string;
  source: string;
  url: string;
  image_url: string | null;
  title: string;
}

export interface SendDeps extends TelegramDeps {
  chatId: string;
  /** Backoff wait for 429 honours (default: real setTimeout — inject a noop in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock stamping successful sends (default: live time — inject a fixed date in tests). */
  now?: () => Date;
  /**
   * Max drafts to send this run (default SEND_QUEUE_LIMIT). Surplus stays
   * queued (`last_sent_at IS NULL`) for later windows — one run never
   * drains an arbitrarily large backlog in a single burst.
   */
  limit?: number;
}

/**
 * Per-run send bound: 3× the daily selection cap. One deliver run selects at
 * most SELECT_DEFAULT_LIMIT fresh drafts, but stale pendings (failed sends,
 * re-armed drafts) can pile the queue higher — the bound keeps a catch-up
 * run to a sane burst while the surplus waits for the next window.
 */
export const SEND_QUEUE_LIMIT = 3 * SELECT_DEFAULT_LIMIT;

export interface DraftSendResult {
  draftId: number;
  ok: boolean;
  via?: 'photo' | 'message';
  /** True when a failed sendPhoto fell back to a text sendMessage. */
  fallback?: boolean;
  truncated?: boolean;
  /**
   * Set when the message WAS delivered but tracking is degraded: the
   * send-once stamp needed a best-effort fallback, or a concurrent run won
   * the stamp first. Always surfaced in SendSummary.warnings too.
   */
  warning?: string;
  /**
   * True when a concurrent run won the send-once stamp (CAS changes === 0):
   * this run also delivered a message (possible duplicate), but it counts
   * as sent-skipped — never as a fresh send and never as a retryable failure.
   */
  skipped?: boolean;
  error?: string;
}

export interface SendSummary {
  results: DraftSendResult[];
  total: number;
  sent: number;
  failed: number;
  /** Loud typed warnings: tracking-degraded deliveries and concurrent-race skips. */
  warnings: string[];
  /** 1 only when at least one draft was attempted and ALL failed. */
  exitCode: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildKeyboard(draftId: number): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: [
      [
        { text: '✅ Publicado', callback_data: `draft:${draftId}:posted` },
        { text: '⏭ Omitir', callback_data: `draft:${draftId}:skipped` },
      ],
    ],
  };
}

/**
 * Upper bound for honouring Telegram's `retry_after` backoff hint: a bogus
 * (or hostile) value must not stall the send run for hours.
 */
export const TELEGRAM_MAX_RETRY_AFTER_SEC = 120;

/**
 * Run an outgoing call with one backoff retry: when Telegram answers 429
 * (or an ok:false flood-control reply) with `retry_after`, wait that long
 * (capped at TELEGRAM_MAX_RETRY_AFTER_SEC) and try once more. Deterministic
 * failures (other 4xx, timeouts, bad shapes) fail immediately — retrying
 * those only risks double-sends.
 */
async function sendWithRateLimitRetry<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (isRateLimited(err)) {
      const waitSec = Math.min(err.retryAfterSec, TELEGRAM_MAX_RETRY_AFTER_SEC);
      if (waitSec < err.retryAfterSec) {
        // `retryAfterSec` is a plain number from Telegram — no secret to
        // redact, but keep the note terse and machine-greppable.
        console.warn(
          `telegram retry_after ${err.retryAfterSec}s exceeds the ${TELEGRAM_MAX_RETRY_AFTER_SEC}s cap — waiting ${waitSec}s`,
        );
      }
      await sleep(waitSec * 1000);
      return await operation();
    }
    throw err;
  }
}

/**
 * Send every unsent `pending` draft to the configured chat: the article image
 * (by URL — Telegram fetches it server-side) plus the ready-to-paste Spanish
 * caption and posted/skipped inline buttons.
 *
 * Send-once semantics (migration 0002): the queue is
 * `status = 'pending' AND last_sent_at IS NULL`, bounded per run by
 * `deps.limit` (default SEND_QUEUE_LIMIT). A successful send stamps
 * `last_sent_at` (compare-and-set — the row is only stamped when still
 * NULL) plus the `telegram_message_id` Telegram returned, so the timer never
 * re-sends a delivered draft even before the operator presses a button.
 * Per-draft isolation: a failed send (oversize caption attribution, 400
 * from Telegram, network error) is recorded and the run continues; the draft
 * keeps `last_sent_at IS NULL` and stays queued for a later retry — a failed
 * delivery never loses a draft. Status changes happen ONLY via the listen
 * buttons, never here. Re-running the send without new successes sends
 * nothing; `--resend` on the CLI re-arms drafts explicitly. Surplus beyond
 * the per-run bound stays queued for later windows.
 */
export async function runTelegramSend(db: Database.Database, deps: SendDeps): Promise<SendSummary> {
  const bound = deps.limit ?? SEND_QUEUE_LIMIT;
  if (!Number.isSafeInteger(bound) || bound < 0) {
    throw new Error(
      `telegram send failed: limit must be a non-negative integer (got ${String(deps.limit)})`,
    );
  }
  let rows: PendingDraftRow[];
  try {
    rows = db
      .prepare(
        `SELECT d.id, d.caption_es, a.source, a.url, a.image_url, a.title
         FROM drafts d JOIN articles a ON a.id = d.article_id
         WHERE d.status = 'pending' AND d.last_sent_at IS NULL ORDER BY d.id LIMIT ?`,
      )
      .all(bound) as PendingDraftRow[];
  } catch (err) {
    throw new Error(`telegram send failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const results: DraftSendResult[] = [];
  for (const row of rows) {
    try {
      results.push(await sendOneDraft(db, row, deps, sleep, now));
    } catch (err) {
      // Per-draft isolation: record and continue; the draft stays queued
      // (`last_sent_at` untouched) for a later retry.
      results.push({
        draftId: row.id,
        ok: false,
        error:
          err instanceof Error
            ? err.message.startsWith('telegram ')
              ? err.message
              : `telegram send failed for draft ${row.id}: ${err.message}`
            : `telegram send failed for draft ${row.id}: ${String(err)}`,
      });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  // Race-losers (skipped) are neither sends nor retryable failures.
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  const warnings = results.flatMap((r) => (r.warning !== undefined ? [r.warning] : []));
  return {
    results,
    total: results.length,
    sent,
    failed,
    warnings,
    exitCode: results.length > 0 && failed === results.length ? 1 : 0,
  };
}

async function sendOneDraft(
  db: Database.Database,
  row: PendingDraftRow,
  deps: SendDeps,
  sleep: (ms: number) => Promise<void>,
  now: () => Date,
): Promise<DraftSendResult> {
  const fail = (cause: string): Error =>
    new Error(`telegram send failed for draft ${row.id}: ${cause}`);

  const fit = fitCaptionForTelegram(row.caption_es, TELEGRAM_CAPTION_LIMIT);
  if (!fit.ok) throw fail(fit.error);
  const text = fit.caption;
  const replyMarkup = buildKeyboard(row.id);

  // The Telegram message_id for the send-once stamp: whichever call actually
  // delivered (photo, text, or the photo→text fallback).
  let messageId: number;
  let via: 'photo' | 'message';
  let fallback = false;
  if (row.image_url) {
    try {
      const sent = await sendWithRateLimitRetry(
        () =>
          sendPhoto(
            { chatId: deps.chatId, text, photoUrl: row.image_url as string, replyMarkup },
            deps,
            `draft ${row.id}`,
          ),
        sleep,
      );
      messageId = sent.message_id;
      via = 'photo';
    } catch (err) {
      // Telegram answers 400 when it cannot fetch the image URL (gone,
      // hotlink-protected, wrong MIME): fall back to a text send so the
      // caption still reaches the phone instead of losing the delivery.
      // Other failures (429-after-retry, 5xx, network) stay failures.
      if (err instanceof Error && /HTTP 400/.test(err.message)) {
        const sent = await sendWithRateLimitRetry(
          () => sendMessage({ chatId: deps.chatId, text, replyMarkup }, deps, `draft ${row.id}`),
          sleep,
        );
        messageId = sent.message_id;
        via = 'message';
        fallback = true;
      } else {
        throw err instanceof Error && err.message.startsWith('telegram ')
          ? err
          : fail(err instanceof Error ? err.message : String(err));
      }
    }
  } else {
    try {
      const sent = await sendWithRateLimitRetry(
        () => sendMessage({ chatId: deps.chatId, text, replyMarkup }, deps, `draft ${row.id}`),
        sleep,
      );
      messageId = sent.message_id;
      via = 'message';
    } catch (err) {
      throw err instanceof Error && err.message.startsWith('telegram ')
        ? err
        : fail(err instanceof Error ? err.message : String(err));
    }
  }

  // Send-once stamp: compare-and-set so a concurrent send run stamping the
  // same draft first wins and this one stays honest. The message WAS
  // delivered at this point, so tracking-side trouble must never re-queue
  // it for a duplicate send: the stamp coerces a malformed message_id to
  // NULL (best-effort — the api layer already validates it), falls back to
  // a sent-at-only stamp when the full stamp throws, and otherwise reports
  // DELIVERED with a loud warning.
  const safeMessageId = Number.isSafeInteger(messageId) ? messageId : null;
  const sentAt = now().toISOString();
  try {
    const stamped = db.prepare(
      `UPDATE drafts SET last_sent_at = ?, telegram_message_id = ?
       WHERE id = ? AND last_sent_at IS NULL`,
    ).run(sentAt, safeMessageId, row.id);
    if (stamped.changes === 1) {
      if (safeMessageId === null) {
        const warning =
          `telegram send tracking degraded for draft ${row.id}: Telegram returned no usable ` +
          `message_id, so the draft is stamped sent without one — future edits cannot target it.`;
        console.warn(warning);
        return { draftId: row.id, ok: true, via, fallback: fallback || undefined, truncated: fit.truncated || undefined, warning };
      }
      return {
        draftId: row.id,
        ok: true,
        via,
        fallback: fallback || undefined,
        truncated: fit.truncated || undefined,
      };
    }
    // CAS loser: a concurrent run stamped first and its message won — this
    // run also delivered (possible duplicate), so mark sent-skipped: not a
    // send, not a retryable failure, and loudly warned.
    const warning =
      `telegram send skipped for draft ${row.id}: already stamped by a concurrent run ` +
      `(this run also delivered a message — possible duplicate, not re-queued).`;
    console.warn(warning);
    return { draftId: row.id, ok: false, skipped: true, via, warning };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    // Best-effort fallback: stamp the sent-at WITHOUT the message_id so the
    // delivered draft still leaves the queue (a duplicate send is worse than
    // a missing message_id for future edits).
    try {
      const retry = db.prepare(
        `UPDATE drafts SET last_sent_at = ? WHERE id = ? AND last_sent_at IS NULL`,
      ).run(sentAt, row.id);
      if (retry.changes === 1) {
        const warning =
          `telegram send tracking degraded for draft ${row.id}: ${cause} — ` +
          `stamped sent-at without the Telegram message_id (future edits cannot target it).`;
        console.warn(warning);
        return {
          draftId: row.id,
          ok: true,
          via,
          fallback: fallback || undefined,
          truncated: fit.truncated || undefined,
          warning,
        };
      }
      const warning =
        `telegram send skipped for draft ${row.id}: already stamped by a concurrent run ` +
        `(this run also delivered a message — possible duplicate, not re-queued).`;
      console.warn(warning);
      return { draftId: row.id, ok: false, skipped: true, via, warning };
    } catch (retryErr) {
      const retryCause = retryErr instanceof Error ? retryErr.message : String(retryErr);
      const warning =
        `telegram send tracking failed for draft ${row.id}: ${cause} ` +
        `(fallback also failed: ${retryCause}) — the message WAS delivered and is reported ` +
        `as such so it is not silently re-queued; verify delivery by hand.`;
      console.warn(warning);
      return {
        draftId: row.id,
        ok: true,
        via,
        fallback: fallback || undefined,
        truncated: fit.truncated || undefined,
        warning,
      };
    }
  }
}
