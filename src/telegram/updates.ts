import type Database from 'better-sqlite3';
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
  getUpdates,
  sanitizeTelegram,
  GETUPDATES_LIMIT,
  GETUPDATES_POLL_SECONDS,
  GETUPDATES_HTTP_TIMEOUT_MS,
  type TelegramDeps,
  type TelegramUpdate,
} from './api.js';

export interface DraftAction {
  draftId: number;
  action: 'posted' | 'skipped';
}

/**
 * Validate an inbound callback payload. Callback data is treated as
 * untrusted (anyone who finds the bot could forge presses): only the exact
 * `draft:<id>:<posted|skipped>` shape with a positive safe-integer id is
 * accepted — everything else is ignored with an answer so the phone's
 * spinner clears.
 */
export function parseCallbackData(data: unknown): DraftAction | null {
  if (typeof data !== 'string') return null;
  const match = /^draft:(\d+):(posted|skipped)$/.exec(data);
  if (!match) return null;
  const draftId = Number(match[1]);
  if (!Number.isSafeInteger(draftId) || draftId <= 0) return null;
  return { draftId, action: match[2] as 'posted' | 'skipped' };
}

export type StatusNote = 'applied' | 'already' | 'unknown';

/**
 * Apply a button press to a draft. Verifies the draft exists AND is still
 * `pending` before acting (compare-and-set via `WHERE status = 'pending'`),
 * so duplicate/delayed callbacks on an already-acted draft are no-ops.
 * `posted` stamps `posted_at`; `skipped` leaves it NULL (cf. 0001_init.sql —
 * `posted_at` marks posting, `views` stays NULL until manual M4 logging).
 * Throws a typed `telegram status update failed for draft <id>: ...` error
 * on SQLite failures.
 */
export function applyStatusUpdate(
  db: Database.Database,
  draftId: number,
  action: 'posted' | 'skipped',
  now: () => Date,
): { note: StatusNote } {
  try {
    const row = db
      .prepare('SELECT status FROM drafts WHERE id = ?')
      .get(draftId) as { status: string } | undefined;
    if (!row) return { note: 'unknown' };
    if (row.status !== 'pending') return { note: 'already' };
    const postedAt = action === 'posted' ? now().toISOString() : null;
    const result = db
      .prepare(`UPDATE drafts SET status = ?, posted_at = ? WHERE id = ? AND status = 'pending'`)
      .run(action, postedAt, draftId);
    if (result.changes === 0) return { note: 'already' };
    return { note: 'applied' };
  } catch (err) {
    throw new Error(
      `telegram status update failed for draft ${draftId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface PollDeps extends TelegramDeps {
  chatId: string;
  now?: () => Date;
  /** Long-poll wait in seconds (default GETUPDATES_POLL_SECONDS). */
  pollSeconds?: number;
  /** Page size per poll (default GETUPDATES_LIMIT). */
  limit?: number;
  /** Sink for log-and-continue notes (ignored updates, recovered errors). */
  onEvent?: (message: string) => void;
}

export type UpdateOutcome =
  | 'applied'
  | 'already'
  | 'unknown'
  | 'invalid'
  | 'foreign'
  | 'ignored'
  | 'error';

const ANSWER_TEXT: Record<string, string> = {
  posted: 'Marcado como publicado ✓',
  skipped: 'Marcado como omitido ✓',
};

async function safeAnswer(
  deps: PollDeps,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  try {
    await answerCallbackQuery({ callbackQueryId, text }, deps);
  } catch (err) {
    // A failed answer must never break the loop — the DB update already
    // happened (or was already decided); just note it and continue.
    deps.onEvent?.(
      `answerCallbackQuery failed: ${sanitizeTelegram(err instanceof Error ? err.message : String(err), deps.token)}`,
    );
  }
}

/**
 * Handle one update. Only button presses on messages in the configured chat
 * act; everything else is logged-and-skipped (foreign chats, non-callback
 * updates, malformed payloads). Never throws for update-driven failures —
 * only `pollOnce`'s own getUpdates transport error propagates, and the
 * listener loop catches that per tick (same degradation philosophy).
 */
export async function processUpdate(
  db: Database.Database,
  deps: PollDeps,
  update: TelegramUpdate,
): Promise<UpdateOutcome> {
  const query = update.callback_query;
  if (!query) return 'ignored';

  // TELEGRAM_CHAT_ID pinning: only the owner's chat may drive state changes.
  const chatId = query.message?.chat?.id;
  if (chatId === undefined || String(chatId) !== deps.chatId) {
    deps.onEvent?.(`ignoring update from unexpected chat (update ${update.update_id})`);
    return 'foreign';
  }

  const parsed = parseCallbackData(query.data);
  if (!parsed) {
    await safeAnswer(deps, query.id, 'Botón no válido 🤖');
    return 'invalid';
  }

  let note: StatusNote;
  try {
    note = applyStatusUpdate(
      db,
      parsed.draftId,
      parsed.action,
      deps.now ?? (() => new Date()),
    ).note;
  } catch (err) {
    await safeAnswer(deps, query.id, 'Error interno, intenta de nuevo 🤖');
    deps.onEvent?.(
      sanitizeTelegram(err instanceof Error ? err.message : String(err), deps.token),
    );
    return 'error';
  }

  if (note === 'unknown') {
    await safeAnswer(deps, query.id, 'Ese borrador ya no existe 🤖');
    return 'unknown';
  }
  if (note === 'already') {
    await safeAnswer(deps, query.id, 'Ya estaba marcado ✓');
    return 'already';
  }
  await safeAnswer(deps, query.id, ANSWER_TEXT[parsed.action]);
  // Strip the buttons so a double-tap cannot re-fire, but keep the caption
  // intact — the user still needs to copy it to WhatsApp.
  if (query.message) {
    try {
      await editMessageReplyMarkup(
        {
          chatId: deps.chatId,
          messageId: query.message.message_id,
          replyMarkup: { inline_keyboard: [] },
        },
        deps,
      );
    } catch (err) {
      deps.onEvent?.(
        `editMessageReplyMarkup failed: ${sanitizeTelegram(err instanceof Error ? err.message : String(err), deps.token)}`,
      );
    }
  }
  return 'applied';
}

/**
 * One long-poll tick: fetch updates since `offset` (restricted to
 * `callback_query` — the listener only handles button presses) and process
 * each in turn. Returns the next offset. Throws the typed transport error
 * when getUpdates itself fails; per-update failures are contained in
 * `processUpdate`.
 */
export async function pollOnce(
  db: Database.Database,
  deps: PollDeps,
  offset?: number,
): Promise<number | undefined> {
  const pollSeconds = deps.pollSeconds ?? GETUPDATES_POLL_SECONDS;
  const updates = await getUpdates(
    {
      ...(offset !== undefined ? { offset } : {}),
      limit: deps.limit ?? GETUPDATES_LIMIT,
      timeout: pollSeconds,
      allowedUpdates: ['callback_query'],
    },
    // The long-poll needs a longer HTTP budget than the poll window itself.
    { ...deps, timeoutMs: deps.timeoutMs ?? GETUPDATES_HTTP_TIMEOUT_MS },
  );
  let next = offset;
  for (const update of updates) {
    // `updates` is runtime JSON: an element without a safe-integer
    // `update_id` is unparseable. Log-and-skip it WITHOUT advancing the
    // offset past it — there is no valid id to advance to, and `undefined
    // + 1` would serialize a NaN offset (JSON null) into the next poll.
    // Deliberate tradeoff: valid elements later in the same page still
    // advance past an early malformed one (Telegram returns ids in order),
    // but a page with NO valid ids returns the incoming offset, so Telegram
    // redelivers it next tick. Redelivery-plus-log is preferred over
    // synthesizing an offset (which could skip real updates) or silently
    // dropping the page; each occurrence is visible via `onEvent`.
    const rawId =
      typeof update === 'object' && update !== null
        ? (update as { update_id?: unknown }).update_id
        : undefined;
    if (!Number.isSafeInteger(rawId)) {
      // Describe the shape, not the value: the element is untrusted JSON
      // (a BigInt or huge object would break JSON.stringify in the log path).
      const got = rawId === undefined ? 'missing' : typeof rawId;
      deps.onEvent?.(
        `ignoring update without a valid update_id (got ${got}) — offset unchanged, page will redeliver`,
      );
      continue;
    }
    await processUpdate(db, deps, update);
    next = (rawId as number) + 1;
  }
  return next;
}

export interface ListenDeps extends PollDeps {
  /** Backoff between ticks after a failed poll (default 5000 ms). */
  retryDelayMs?: number;
  /** Stop flag (wired to SIGINT in the CLI); maxTicks bounds the loop in tests. */
  shouldStop?: () => boolean;
  maxTicks?: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Long-poll loop: keeps the offset across ticks, survives failed polls
 * (log-and-continue with backoff — one Telegram blip must not kill the
 * listener), exits cleanly on `shouldStop`. Per-tick errors are sanitized
 * (the token never reaches the log).
 */
export async function runTelegramListen(
  db: Database.Database,
  deps: ListenDeps,
): Promise<{ ticks: number }> {
  const sleep = deps.sleep ?? defaultSleep;
  let offset: number | undefined;
  let ticks = 0;
  for (;;) {
    if (deps.shouldStop?.()) break;
    if (deps.maxTicks !== undefined && ticks >= deps.maxTicks) break;
    ticks += 1;
    try {
      offset = await pollOnce(db, deps, offset);
    } catch (err) {
      deps.onEvent?.(
        `telegram listen: ${sanitizeTelegram(err instanceof Error ? err.message : String(err), deps.token)} — continuing`,
      );
      await sleep(deps.retryDelayMs ?? 5000);
    }
  }
  return { ticks };
}
