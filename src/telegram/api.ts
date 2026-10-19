/**
 * Minimal Telegram Bot API transport over plain `fetch` — no SDK deps.
 *
 * Conventions mirror the other boundary modules (`src/writer/openrouter.ts`,
 * `src/fetcher/newsdata.ts`): every call carries `redirect: 'error'` (the
 * token rides in the request URL, so it must never follow a redirect), an
 * `AbortSignal.timeout` budget, and a response body cap enforced WHILE
 * streaming. Failures surface as typed `TelegramApiError`s
 * (`telegram <method> failed for <scope>: <cause>`) — never a raw
 * library/network error — with the token redacted. HTTP 429 carries the
 * machine-readable `retry_after` so senders can honour Telegram's backoff.
 */
export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Per-request budget for send/answer/edit calls: a stalled call must not hang the run. */
export const TELEGRAM_TIMEOUT_MS = 15_000;

/** Bot API replies are tiny — 1 MB is already generous; anything bigger is hostile. */
export const TELEGRAM_MAX_BODY_BYTES = 1 * 1024 * 1024;

/** Long-poll wait requested from getUpdates (Telegram allows up to ~50s). */
export const GETUPDATES_POLL_SECONDS = 30;

/**
 * HTTP budget for a getUpdates call: the poll window plus headroom, so the
 * abort signal never fires before Telegram's own long-poll timeout.
 */
export const GETUPDATES_HTTP_TIMEOUT_MS = (GETUPDATES_POLL_SECONDS + 15) * 1000;

/** Page size for getUpdates — keeps each poll bounded. */
export const GETUPDATES_LIMIT = 100;

export interface TelegramDeps {
  fetchFn: typeof fetch;
  token: string;
  /** Per-request timeout in ms (default TELEGRAM_TIMEOUT_MS; long-poll callers pass more). */
  timeoutMs?: number;
  /** Max response body size in bytes (default TELEGRAM_MAX_BODY_BYTES). */
  maxBytes?: number;
}

/**
 * Typed transport error. `status` is the HTTP status (absent when the
 * request never got a response or the API returned ok:false with HTTP 200).
 * `retryAfterSec` is set when Telegram asked for backoff (HTTP 429 or an
 * ok:false flood-control reply carrying `parameters.retry_after`).
 */
export class TelegramApiError extends Error {
  readonly status?: number;
  readonly retryAfterSec?: number;

  constructor(message: string, opts: { status?: number; retryAfterSec?: number } = {}) {
    super(message);
    this.name = 'TelegramApiError';
    this.status = opts.status;
    this.retryAfterSec = opts.retryAfterSec;
  }
}

/** True when the error carries a Telegram backoff request worth honouring. */
export function isRateLimited(err: unknown): err is TelegramApiError & { retryAfterSec: number } {
  return err instanceof TelegramApiError && typeof err.retryAfterSec === 'number';
}

/**
 * Strip the bot token from a message — the token rides in every request URL
 * (`.../bot<token>/...`), so any error that echoes request details must be
 * scrubbed before it reaches logs or the terminal.
 */
export function sanitizeTelegram(message: string, token: string): string {
  if (token !== '') return message.split(token).join('[redacted]');
  return message;
}

export interface TelegramChat {
  id: number;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: unknown;
  message?: TelegramMessage;
  from?: { id: number; username?: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface SendMessageResult {
  message_id: number;
}

/**
 * Message-returning methods (sendMessage/sendPhoto) must prove the delivery
 * before the send-once stamp runs: an unchecked `result as T` lets a missing
 * `message_id` reach the STRICT `telegram_message_id INTEGER` stamp (or a
 * NULL stamp that re-queues a delivered draft). Fail typed instead.
 */
function assertMessageResult(
  method: string,
  scope: string,
  result: unknown,
): asserts result is SendMessageResult {
  const messageId = (result as { message_id?: unknown } | null)?.message_id;
  if (typeof result !== 'object' || result === null || !Number.isSafeInteger(messageId)) {
    throw new TelegramApiError(
      `telegram ${method} failed for ${scope}: unexpected response shape ` +
        `(expected an object with an integer message_id)`,
    );
  }
}

function declaredLength(res: Response): number | null {
  try {
    const raw = res.headers?.get('content-length');
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Parse a JSON body with a byte cap enforced WHILE streaming (memory-DoS
 * guard), mirroring `src/writer/openrouter.ts`: the declared content-length
 * is checked first, then chunks are counted as they arrive and the stream is
 * cancelled on overflow. Test doubles without a stream fall back to
 * `arrayBuffer()` / `json()` with a post-read size check.
 */
async function readJsonCapped(res: Response, maxBytes: number): Promise<unknown> {
  const declared = declaredLength(res);
  if (declared != null && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      // A broken body must not mask the oversize error — ignore cancel failures.
    }
    throw new Error(`response body too large (${declared} bytes declared, limit ${maxBytes})`);
  }
  const stream = res.body as ReadableStream<Uint8Array> | null;
  if (stream != null && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new Error(`response body too large (exceeds ${maxBytes} bytes)`);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const raw = res as Response & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof raw.arrayBuffer === 'function') {
    const buf = await raw.arrayBuffer.call(res);
    if (buf.byteLength > maxBytes) {
      throw new Error(`response body too large (${buf.byteLength} bytes, limit ${maxBytes})`);
    }
    return JSON.parse(Buffer.from(buf).toString('utf8'));
  }
  const body = await res.json();
  const approx = JSON.stringify(body)?.length ?? 0;
  if (approx > maxBytes) {
    throw new Error(`response body too large (limit ${maxBytes} bytes)`);
  }
  return body;
}

/** Best-effort extraction of Telegram's `parameters.retry_after` from an error body. */
function retryAfterFromBody(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const params = (body as { parameters?: unknown }).parameters;
  if (typeof params !== 'object' || params === null) return undefined;
  const retryAfter = (params as { retry_after?: unknown }).retry_after;
  return typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
    ? retryAfter
    : undefined;
}

/**
 * One Bot API call. `scope` names the draft (or run step) the call belongs to
 * so errors read `telegram <method> failed for <scope>: <cause>`.
 * Error messages are status-only plus Telegram's `description` — never the
 * request URL or token (both scrubbed as defense in depth).
 */
export async function callTelegramMethod<T>(
  method: string,
  params: Record<string, unknown>,
  deps: TelegramDeps,
  scope: string,
): Promise<T> {
  const maxBytes = deps.maxBytes ?? TELEGRAM_MAX_BODY_BYTES;
  const timeoutMs = deps.timeoutMs ?? TELEGRAM_TIMEOUT_MS;
  const fail = (cause: string, extra: { status?: number; retryAfterSec?: number } = {}) =>
    new TelegramApiError(
      `telegram ${method} failed for ${scope}: ${sanitizeTelegram(cause, deps.token)}`,
      extra,
    );

  const url = `${TELEGRAM_API_BASE}/bot${deps.token}/${method}`;
  let res: Response;
  try {
    // The token rides in the URL: fail closed on redirects rather than leak
    // it to a redirect target (same convention as the NewsData fetcher).
    res = await deps.fetchFn(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw fail(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    // A 429 still carries a JSON body with the backoff hint — read it
    // best-effort so callers can honour `retry_after`.
    let retryAfterSec: number | undefined;
    try {
      retryAfterSec = retryAfterFromBody(await readJsonCapped(res, maxBytes));
    } catch {
      retryAfterSec = undefined;
    }
    try {
      await res.body?.cancel();
    } catch {
      // A broken body must not mask the HTTP error — ignore cancel failures.
    }
    const retryNote = retryAfterSec !== undefined ? ` (retry after ${retryAfterSec}s)` : '';
    throw fail(`HTTP ${res.status}${retryNote}`, { status: res.status, retryAfterSec });
  }

  let body: { ok?: unknown; result?: unknown; description?: unknown; parameters?: unknown };
  try {
    body = (await readJsonCapped(res, maxBytes)) as {
      ok?: unknown;
      result?: unknown;
      description?: unknown;
      parameters?: unknown;
    };
  } catch (err) {
    throw fail(err instanceof Error ? err.message : String(err));
  }
  if (body.ok !== true) {
    const description =
      typeof body.description === 'string' ? body.description : 'unknown API error';
    throw fail(description, { retryAfterSec: retryAfterFromBody(body) });
  }
  return body.result as T;
}

/** Verify the token — cheap, sends nothing. Returns the bot's username. */
export async function getMe(deps: TelegramDeps): Promise<{ id: number; username?: string }> {
  return callTelegramMethod<{ id: number; username?: string }>('getMe', {}, deps, 'bot');
}

export interface OutgoingMessage {
  chatId: string;
  text: string;
  replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

/**
 * NOTE on parse_mode: deliberately omitted (plaintext). Captions carry bare
 * URLs — which Telegram clients auto-linkify — plus emoji/hashtags where a
 * stray `*`, `_`, `[` or `(` (common in URLs) would break Markdown/HTML
 * parsing and fail the send. Plaintext keeps delivery independent of caption
 * content. See docs/telegram.md.
 */
export async function sendMessage(
  msg: OutgoingMessage,
  deps: TelegramDeps,
  scope = 'draft',
): Promise<SendMessageResult> {
  const result = await callTelegramMethod<SendMessageResult>(
    'sendMessage',
    {
      chat_id: msg.chatId,
      text: msg.text,
      ...(msg.replyMarkup ? { reply_markup: msg.replyMarkup } : {}),
    },
    deps,
    scope,
  );
  assertMessageResult('sendMessage', scope, result);
  return result;
}

export interface OutgoingPhoto extends OutgoingMessage {
  photoUrl: string;
}

/**
 * Send by image URL: Telegram fetches the image server-side, so the process
 * never downloads remote bytes (keeps the SSRF surface low — ingest already
 * vetted the URL via `isSafeWebUrl()`, and Telegram re-validates on fetch).
 */
export async function sendPhoto(
  photo: OutgoingPhoto,
  deps: TelegramDeps,
  scope = 'draft',
): Promise<SendMessageResult> {
  const result = await callTelegramMethod<SendMessageResult>(
    'sendPhoto',
    {
      chat_id: photo.chatId,
      photo: photo.photoUrl,
      caption: photo.text,
      ...(photo.replyMarkup ? { reply_markup: photo.replyMarkup } : {}),
    },
    deps,
    scope,
  );
  assertMessageResult('sendPhoto', scope, result);
  return result;
}

export async function getUpdates(
  query: { offset?: number; limit?: number; timeout?: number; allowedUpdates?: string[] },
  deps: TelegramDeps,
): Promise<TelegramUpdate[]> {
  const result = await callTelegramMethod<unknown>(
    'getUpdates',
    {
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.timeout !== undefined ? { timeout: query.timeout } : {}),
      ...(query.allowedUpdates !== undefined ? { allowed_updates: query.allowedUpdates } : {}),
    },
    deps,
    'updates',
  );
  // List-returning methods must verify the shape: an unexpected `result`
  // (object, string, null) would otherwise flow into `for...of` callers as a
  // raw TypeError. Fail typed instead.
  if (!Array.isArray(result)) {
    throw new TelegramApiError(
      'telegram getUpdates failed for updates: unexpected response shape (expected a list)',
    );
  }
  return result as TelegramUpdate[];
}

export async function answerCallbackQuery(
  args: { callbackQueryId: string; text?: string },
  deps: TelegramDeps,
): Promise<void> {
  await callTelegramMethod<true>(
    'answerCallbackQuery',
    {
      callback_query_id: args.callbackQueryId,
      ...(args.text !== undefined ? { text: args.text } : {}),
    },
    deps,
    'callback',
  );
}

export async function editMessageReplyMarkup(
  args: {
    chatId: string;
    messageId: number;
    replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  },
  deps: TelegramDeps,
): Promise<void> {
  await callTelegramMethod<true>(
    'editMessageReplyMarkup',
    {
      chat_id: args.chatId,
      message_id: args.messageId,
      reply_markup: args.replyMarkup,
    },
    deps,
    'callback',
  );
}
