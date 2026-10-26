import type Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  answerCallbackQuery,
  editMessageMediaPhoto,
  editMessageReplyMarkup,
  editMessageText,
  getUpdates,
  sanitizeTelegram,
  sendMessage,
  GETUPDATES_LIMIT,
  GETUPDATES_POLL_SECONDS,
  GETUPDATES_HTTP_TIMEOUT_MS,
  type TelegramDeps,
  type TelegramMessage,
  type TelegramUpdate,
} from './api.js';
import { fitCaptionForTelegram } from './caption.js';
import { DEFAULT_IMAGE_MODEL } from '../images/openrouter.js';
import { generateImageForDraft } from '../images/run.js';

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
  /**
   * OpenRouter key for `/img` generation (reuses the writer key — same
   * billing). Unset → `/img` requests fail gracefully with a status edit,
   * never a crash. Test doubles inject `runImage` instead.
   */
  imageApiKey?: string;
  /** Image model slug (default DEFAULT_IMAGE_MODEL). */
  imageModel?: string;
  /** Image output dir (default `data/images` — see src/images/run.ts). */
  imagesDir?: string;
  /**
   * Seam for the draft-image run (default: the real
   * `generateImageForDraft`). Tests stub this to avoid network + disk.
   */
  runImage?: (db: Database.Database, draftId: number) => Promise<{ path: string }>;
}

export type UpdateOutcome =
  | 'applied'
  | 'already'
  | 'unknown'
  | 'invalid'
  | 'foreign'
  | 'ignored'
  | 'error'
  | 'image'
  | 'image-error';

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
 * Handle one update. Button presses on messages in the configured chat
 * act; `/img` replies to a draft message trigger manual image generation
 * (see handleImageReply). Everything else is logged-and-skipped (foreign
 * chats, non-command messages, malformed payloads). Never throws for
 * update-driven failures — only `pollOnce`'s own getUpdates transport
 * error propagates, and the listener loop catches that per tick (same
 * degradation philosophy).
 */
export async function processUpdate(
  db: Database.Database,
  deps: PollDeps,
  update: TelegramUpdate,
): Promise<UpdateOutcome> {
  const query = update.callback_query;
  if (query) {
    return processCallbackQuery(db, deps, update, query);
  }

  if (update.message) {
    return handleImageReply(db, deps, update.message, update.update_id);
  }

  return 'ignored';
}

/**
 * The callback half of processUpdate, extracted so the `/img` message path
 * reads separately. Logic unchanged: pin, parse, compare-and-set, answer,
 * strip buttons.
 */
async function processCallbackQuery(
  db: Database.Database,
  deps: PollDeps,
  update: TelegramUpdate,
  query: NonNullable<TelegramUpdate['callback_query']>,
): Promise<UpdateOutcome> {

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
 * The `/img` command text. Matching is EXACT (after trimming): image
 * generations cost money, so anything that is not precisely `/img` —
 * prose mentioning img, `/img please`, captions — is ignored and never
 * generates. Replies are required too (see handleImageReply): a bare
 * `/img` with no reply target cannot name a draft and is ignored.
 */
const IMG_COMMAND = '/img';

const IMG_STATUS_START = '🎨 Generando imagen…';
const IMG_STATUS_DONE = '✅ Imagen lista';

/** Same button shape as the sender (`src/telegram/send.ts`): kept local so the photo swap preserves the exact posted/skipped keyboard. */
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

/** Redact both secrets that can appear in image-flow errors (bot token + OpenRouter key). */
function sanitizeImageError(message: string, deps: PollDeps): string {
  const withoutToken = sanitizeTelegram(message, deps.token);
  const key = deps.imageApiKey ?? '';
  if (key !== '') return withoutToken.split(key).join('[redacted]');
  return withoutToken;
}

/** One-line, capped failure reason for the phone status message. */
function shortReason(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function contentTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

/**
 * Manual image generation (Phase 1): the operator replies `/img` to a
 * draft's Telegram message → a new image is generated via OpenRouter's
 * image model → the draft message's photo is swapped, keeping caption +
 * buttons. NO automatic generation happens anywhere else (writer, sender,
 * and this listener's callback path never call it).
 *
 * Flow: match the reply target to `drafts.telegram_message_id` → post a
 * "generating" status message → generate (60–90s+) → save bytes + stamp
 * `generated_image_path` (that happens inside the image run, only after
 * the file exists) → `editMessageMedia` photo swap → edit the status
 * message to done. Any failure edits the status message to a short
 * sanitized reason and logs via onEvent; the loop continues either way
 * (log-and-continue). A failed generation never loses a draft: the
 * caption/buttons are untouched and `generated_image_path` keeps its old
 * value (or NULL).
 *
 * Never throws for message-driven failures — returns 'image' on success,
 * 'image-error' on failure, 'unknown' when no draft matches the reply
 * target, 'foreign' for other chats, 'ignored' for non-commands.
 */
async function handleImageReply(
  db: Database.Database,
  deps: PollDeps,
  message: TelegramMessage,
  updateId: number,
): Promise<UpdateOutcome> {
  // TELEGRAM_CHAT_ID pinning, identical to the callback path: only the
  // owner's chat may spend image generations.
  const chatId = message.chat?.id;
  if (chatId === undefined || String(chatId) !== deps.chatId) {
    deps.onEvent?.(`ignoring update from unexpected chat (update ${updateId})`);
    return 'foreign';
  }

  // Exact-command gate: anything but precisely `/img` is ignored, so prose
  // can never trigger a paid generation by accident.
  if (typeof message.text !== 'string' || message.text.trim() !== IMG_COMMAND) {
    return 'ignored';
  }

  // The command must reply to a bot message (`reply_to_message.message_id`
  // carries the draft's `telegram_message_id`). A bare `/img` names no
  // draft — ignore it rather than guess.
  const replyId = message.reply_to_message?.message_id;
  if (!Number.isSafeInteger(replyId)) {
    return 'ignored';
  }
  const targetMessageId = replyId as number;

  let draft: { id: number; caption_es: string } | undefined;
  try {
    draft = db
      .prepare(`SELECT id, caption_es FROM drafts WHERE telegram_message_id = ?`)
      .get(targetMessageId) as { id: number; caption_es: string } | undefined;
  } catch (err) {
    deps.onEvent?.(
      `telegram image lookup failed: ${sanitizeImageError(err instanceof Error ? err.message : String(err), deps)}`,
    );
    return 'error';
  }
  if (!draft) {
    // Includes the tracking-degraded case (drafts with NULL
    // telegram_message_id can never match a reply target): log unknown.
    deps.onEvent?.(
      `ignoring /img reply to unknown message ${targetMessageId} (update ${updateId})`,
    );
    return 'unknown';
  }
  const draftId = draft.id;

  // Status line: posted first so the phone shows progress during the
  // minutes-long generation. Its id is needed for later edits — if even
  // this send fails, bail out typed (nothing was generated or changed).
  let statusId: number;
  try {
    const sent = await sendMessage(
      { chatId: deps.chatId, text: IMG_STATUS_START },
      deps,
      `draft ${draftId}`,
    );
    statusId = sent.message_id;
  } catch (err) {
    deps.onEvent?.(
      `telegram /img status failed for draft ${draftId}: ${sanitizeImageError(err instanceof Error ? err.message : String(err), deps)}`,
    );
    return 'image-error';
  }

  const failStatus = async (cause: string): Promise<void> => {
    try {
      await editMessageText(
        {
          chatId: deps.chatId,
          messageId: statusId,
          text: `❌ No se pudo generar la imagen: ${shortReason(cause)}`,
        },
        deps,
        `draft ${draftId}`,
      );
    } catch (editErr) {
      deps.onEvent?.(
        `telegram /img status edit failed for draft ${draftId}: ${sanitizeImageError(editErr instanceof Error ? editErr.message : String(editErr), deps)}`,
      );
    }
  };

  if (!deps.runImage && !deps.imageApiKey) {
    const cause = 'missing OPENROUTER_API_KEY (image generation is not configured)';
    deps.onEvent?.(`telegram /img failed for draft ${draftId}: ${cause}`);
    await failStatus(cause);
    return 'image-error';
  }

  let imagePath: string;
  try {
    const run =
      deps.runImage ??
      ((database: Database.Database, id: number) =>
        generateImageForDraft(database, id, {
          fetchFn: deps.fetchFn,
          apiKey: deps.imageApiKey ?? '',
          model: deps.imageModel ?? DEFAULT_IMAGE_MODEL,
          ...(deps.imagesDir !== undefined ? { imagesDir: deps.imagesDir } : {}),
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        }));
    imagePath = (await run(db, draftId)).path;
  } catch (err) {
    const cause = sanitizeImageError(err instanceof Error ? err.message : String(err), deps);
    deps.onEvent?.(`telegram /img failed for draft ${draftId}: ${cause}`);
    await failStatus(cause);
    return 'image-error';
  }

  // The run stamped `generated_image_path` only after saving the file —
  // re-read the bytes from disk (also proves the file actually exists
  // before attempting the photo swap).
  let imageBytes: Buffer;
  try {
    const absPath = path.isAbsolute(imagePath) ? imagePath : path.join(process.cwd(), imagePath);
    imageBytes = await fs.readFile(absPath);
    if (imageBytes.length === 0) throw new Error('saved image file is empty');
  } catch (err) {
    const cause = sanitizeImageError(
      `cannot read generated image: ${err instanceof Error ? err.message : String(err)}`,
      deps,
    );
    deps.onEvent?.(`telegram /img failed for draft ${draftId}: ${cause}`);
    await failStatus(cause);
    return 'image-error';
  }

  const fit = fitCaptionForTelegram(draft.caption_es);
  if (!fit.ok) {
    // Never ship a linkless/overlong caption: leave caption + buttons
    // untouched (the image file stays saved + stamped for a later retry).
    const cause = sanitizeImageError(fit.error, deps);
    deps.onEvent?.(`telegram /img failed for draft ${draftId}: ${cause}`);
    await failStatus(cause);
    return 'image-error';
  }

  try {
    await editMessageMediaPhoto(
      {
        chatId: deps.chatId,
        messageId: targetMessageId,
        caption: fit.caption,
        replyMarkup: buildKeyboard(draftId),
        imageBytes,
        filename: path.basename(imagePath),
        contentType: contentTypeFor(imagePath),
      },
      deps,
      `draft ${draftId}`,
    );
  } catch (err) {
    const cause = sanitizeImageError(err instanceof Error ? err.message : String(err), deps);
    deps.onEvent?.(`telegram /img failed for draft ${draftId}: ${cause}`);
    await failStatus(cause);
    return 'image-error';
  }

  try {
    await editMessageText(
      { chatId: deps.chatId, messageId: statusId, text: IMG_STATUS_DONE },
      deps,
      `draft ${draftId}`,
    );
  } catch (err) {
    // The photo swap already succeeded — the image is live with caption +
    // buttons intact. A stale "generating" status line is cosmetic: log it.
    deps.onEvent?.(
      `editMessageText failed for draft ${draftId} status: ${sanitizeImageError(err instanceof Error ? err.message : String(err), deps)}`,
    );
  }
  return 'image';
}

/**
 * One long-poll tick: fetch updates since `offset` (restricted to
 * `callback_query` + `message` — button presses and `/img` reply commands)
 * and process each in turn. Returns the next offset. Throws the typed
 * transport error when getUpdates itself fails; per-update failures are
 * contained in `processUpdate`. The offset advances past `/img` updates
 * only AFTER their (minutes-long) generation completes — the advance is
 * the last step of the tick, so a restart redelivers an in-flight command
 * rather than skipping it.
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
      allowedUpdates: ['callback_query', 'message'],
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
