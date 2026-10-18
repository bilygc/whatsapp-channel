import type Database from 'better-sqlite3';
import {
  isRateLimited,
  sendMessage,
  sendPhoto,
  type TelegramDeps,
} from './api.js';
import { TELEGRAM_CAPTION_LIMIT, fitCaptionForTelegram } from './caption.js';

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
}

export interface DraftSendResult {
  draftId: number;
  ok: boolean;
  via?: 'photo' | 'message';
  /** True when a failed sendPhoto fell back to a text sendMessage. */
  fallback?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface SendSummary {
  results: DraftSendResult[];
  total: number;
  sent: number;
  failed: number;
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
 * Send every `pending` draft to the configured chat: the article image (by
 * URL — Telegram fetches it server-side) plus the ready-to-paste Spanish
 * caption and posted/skipped inline buttons.
 *
 * Per-draft isolation: a failed send (oversize caption attribution, 400
 * from Telegram, network error) is recorded and the run continues; the draft
 * stays `pending` for a later retry — a failed delivery never loses a draft.
 * Status changes happen ONLY via the listen buttons, never here, so no
 * schema change is needed: re-running the send is at-least-once by design
 * (a draft marked posted/skipped is no longer `pending` and won't resend).
 */
export async function runTelegramSend(db: Database.Database, deps: SendDeps): Promise<SendSummary> {
  let rows: PendingDraftRow[];
  try {
    rows = db
      .prepare(
        `SELECT d.id, d.caption_es, a.source, a.url, a.image_url, a.title
         FROM drafts d JOIN articles a ON a.id = d.article_id
         WHERE d.status = 'pending' ORDER BY d.id`,
      )
      .all() as PendingDraftRow[];
  } catch (err) {
    throw new Error(`telegram send failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const sleep = deps.sleep ?? defaultSleep;
  const results: DraftSendResult[] = [];
  for (const row of rows) {
    try {
      results.push(await sendOneDraft(row, deps, sleep));
    } catch (err) {
      // Per-draft isolation: record and continue; the draft stays `pending`.
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
  const failed = results.length - sent;
  return {
    results,
    total: results.length,
    sent,
    failed,
    exitCode: results.length > 0 && failed === results.length ? 1 : 0,
  };
}

async function sendOneDraft(
  row: PendingDraftRow,
  deps: SendDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<DraftSendResult> {
  const fail = (cause: string): Error =>
    new Error(`telegram send failed for draft ${row.id}: ${cause}`);

  const fit = fitCaptionForTelegram(row.caption_es, TELEGRAM_CAPTION_LIMIT);
  if (!fit.ok) throw fail(fit.error);
  const text = fit.caption;
  const replyMarkup = buildKeyboard(row.id);

  if (row.image_url) {
    try {
      await sendWithRateLimitRetry(
        () =>
          sendPhoto(
            { chatId: deps.chatId, text, photoUrl: row.image_url as string, replyMarkup },
            deps,
            `draft ${row.id}`,
          ),
        sleep,
      );
      return { draftId: row.id, ok: true, via: 'photo', truncated: fit.truncated || undefined };
    } catch (err) {
      // Telegram answers 400 when it cannot fetch the image URL (gone,
      // hotlink-protected, wrong MIME): fall back to a text send so the
      // caption still reaches the phone instead of losing the delivery.
      // Other failures (429-after-retry, 5xx, network) stay failures.
      if (err instanceof Error && /HTTP 400/.test(err.message)) {
        await sendWithRateLimitRetry(
          () => sendMessage({ chatId: deps.chatId, text, replyMarkup }, deps, `draft ${row.id}`),
          sleep,
        );
        return {
          draftId: row.id,
          ok: true,
          via: 'message',
          fallback: true,
          truncated: fit.truncated || undefined,
        };
      }
      throw err instanceof Error && err.message.startsWith('telegram ')
        ? err
        : fail(err instanceof Error ? err.message : String(err));
    }
  }

  try {
    await sendWithRateLimitRetry(
      () => sendMessage({ chatId: deps.chatId, text, replyMarkup }, deps, `draft ${row.id}`),
      sleep,
    );
  } catch (err) {
    throw err instanceof Error && err.message.startsWith('telegram ')
      ? err
      : fail(err instanceof Error ? err.message : String(err));
  }
  return { draftId: row.id, ok: true, via: 'message', truncated: fit.truncated || undefined };
}
