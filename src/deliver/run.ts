import type Database from 'better-sqlite3';
import {
  SELECT_DEFAULT_LIMIT,
  selectTopArticles,
  type SelectableArticle,
  type SelectResult,
} from '../selector/select.js';
import { runWriter, type WriteSummary } from '../writer/run.js';
import type { LlmArticle } from '../writer/openrouter.js';
import { runTelegramSend, SEND_QUEUE_LIMIT, type SendSummary } from '../telegram/send.js';

export interface DeliverSelectFn {
  (db: Database.Database, opts: { limit: number; now?: Date }): SelectResult;
}

export interface DeliverWriteFn {
  (
    db: Database.Database,
    deps: {
      now: () => Date;
      generate: (article: LlmArticle) => Promise<string>;
      /** Cap on `selected` rows processed this run (the writer's own bound). */
      limit?: number;
    },
  ): Promise<WriteSummary>;
}

export interface DeliverSendFn {
  (
    db: Database.Database,
    deps: {
      fetchFn: typeof fetch;
      token: string;
      chatId: string;
      sleep?: (ms: number) => Promise<void>;
      /** Per-run send bound (the deliver chain always passes its own cap explicitly). */
      limit?: number;
    },
  ): Promise<SendSummary>;
}

export interface DeliverDeps {
  /** Max articles to select (default SELECT_DEFAULT_LIMIT, the plan's 3–4/day cap). */
  limit?: number;
  /** Injected clock for deterministic tests. */
  now?: Date;
  /**
   * One LLM call per selected article. When undefined (no OPENROUTER_API_KEY),
   * the write step is skipped with a reason and the run continues to send —
   * already-pending drafts must still deliver.
   */
  generate?: (article: LlmArticle) => Promise<string>;
  fetchFn: typeof fetch;
  token: string | undefined;
  chatId: string | undefined;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable step seams (defaults are the real CLI-backed functions). */
  selectFn?: DeliverSelectFn;
  writeFn?: DeliverWriteFn;
  sendFn?: DeliverSendFn;
}

export interface DeliverSummary {
  scored: number;
  selected: number;
  /** Selected articles (for the CLI's scrubbed log lines). */
  articles: SelectableArticle[];
  /** Null when skipped (0 selected, no LLM key, or the write run itself threw). */
  write: WriteSummary | null;
  /** Why the write step was skipped — set when `write` is null but articles were selected. */
  writeSkippedReason?: string;
  /** Null when skipped (0 selected). */
  send: SendSummary | null;
  exitCode: number;
}

/**
 * Run the post-fetch chain for cron: select → write → telegramSend.
 *
 * Honest chain semantics (per the repo's degradation philosophy):
 * - Select throws (e.g. DB unreadable) → the whole run aborts with a typed
 *   `deliver failed at select: ...` error; write/send never run.
 * - Select finds 0 articles → a fine outcome: skip write+send, exit 0.
 * - Write is per-article isolated (see runWriter): partial or total failure
 *   never aborts send — send simply has nothing new, exit stays 0 unless
 *   send itself failed everything. A throwing write run is recorded as
 *   `writeSkippedReason` and send still runs.
 * - Missing LLM key skips write (with reason) but still sends pendings.
 * - Missing Telegram token/chatId is a clean typed refusal (drafts stay
 *   `pending` for a later retry).
 * - Exit code is 1 only when ALL attempted sends failed and something was
 *   attempted; a throwing send run becomes a typed error.
 */
export async function runDeliver(db: Database.Database, deps: DeliverDeps): Promise<DeliverSummary> {
  const limit = deps.limit ?? SELECT_DEFAULT_LIMIT;
  const selectFn = deps.selectFn ?? selectTopArticles;
  const writeFn = deps.writeFn ?? runWriter;
  const sendFn = deps.sendFn ?? runTelegramSend;

  let select: SelectResult;
  try {
    select = selectFn(db, { limit, now: deps.now });
  } catch (err) {
    throw new Error(
      `deliver failed at select: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (select.selected.length === 0) {
    return { scored: select.scored, selected: 0, articles: [], write: null, send: null, exitCode: 0 };
  }

  let write: WriteSummary | null = null;
  let writeSkippedReason: string | undefined;
  if (!deps.generate && !deps.writeFn) {
    writeSkippedReason =
      'OPENROUTER_API_KEY is not set — skipping write (see .env.example); pending drafts will still send.';
  } else {
    try {
      const generate = deps.generate ?? (async () => {
        throw new Error('deliver misconfigured: no generate function and no writeFn');
      });
      // Bound the per-run write set at the just-selected count (stale
      // `selected` leftovers beyond it wait for a later run), on the
      // injected clock so tests are deterministic.
      const now = deps.now ?? new Date();
      write = await writeFn(db, { now: () => now, generate, limit: select.selected.length });
    } catch (err) {
      // The write run itself cannot start (e.g. articles table unreadable):
      // record and continue — send may still deliver older pendings.
      writeSkippedReason = err instanceof Error ? err.message : String(err);
    }
  }

  if (!deps.token || !deps.chatId) {
    throw new Error(
      'deliver failed at telegramSend: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set ' +
        '(see docs/telegram.md — run `npm run telegramSetup` once to find your chat id).',
    );
  }

  let send: SendSummary;
  try {
    // The deliver chain passes its own send bound explicitly (not the send
    // default): a backlog from failed windows drains 12 per window instead
    // of bursting all at once.
    send = await sendFn(db, {
      fetchFn: deps.fetchFn,
      token: deps.token,
      chatId: deps.chatId,
      sleep: deps.sleep,
      limit: SEND_QUEUE_LIMIT,
    });
  } catch (err) {
    throw new Error(
      `deliver failed at telegramSend: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    scored: select.scored,
    selected: select.selected.length,
    articles: select.selected,
    write,
    writeSkippedReason,
    send,
    exitCode: send.exitCode,
  };
}
