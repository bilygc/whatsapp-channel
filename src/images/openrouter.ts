/**
 * Typed OpenRouter image-generation client (Phase 1: manual `/img` flow).
 *
 * Conventions mirror the writer client (`src/writer/openrouter.ts`): every
 * call carries `redirect: 'error'` (the key rides in the Authorization
 * header, so it must never follow a redirect), an `AbortSignal.timeout`
 * budget, and a response body cap enforced WHILE streaming. Failures surface
 * as typed `ImageApiError`s (`images generate failed for <scope>: <cause>`)
 * — never a raw library/network error — with the API key redacted.
 *
 * API contract (verified against the official OpenRouter docs):
 * - Slug: `meta/muse-image` (real, image-capable).
 * - Endpoint: `POST https://openrouter.ai/api/v1/images` — NOT
 *   chat/completions. Same `Authorization: Bearer <OPENROUTER_API_KEY>`.
 * - Minimal body: `{model, prompt, input_references?}` with up to TWO
 *   references `{type:'image_url', image_url:{url}}` in semantic order
 *   `[news-image?, channel-logo?]`: the article's news image (https URL)
 *   first, the channel brand logo (base64 data URL) second. Providers vary
 *   in how many refs they honour — a 400 on multi-ref is surfaced like
 *   any other 400 (the ladder/fallback design handles prompt-level
 *   fallbacks). Never send `modalities` / `messages` / `image_config`
 *   (chat-API fields).
 * - Response: `{data:[{b64_json, media_type}]}` — base64 only, no hosted
 *   URL. Generations take 60–90s+, so the timeout budget is ≥5 min.
 *
 * Data-URL references (the logo) are inlined bytes — they can never fail
 * with an upstream "unfetchable" error the way an https reference can.
 * Request bodies are therefore NEVER included in error messages or logs:
 * they may carry megabytes of logo base64.
 *
 * Machine-readable failure classification (callers branch on this):
 * - 429 → honour `Retry-After`, retryable.
 * - 5xx (502/524/529 included) → safe to retry (all-or-nothing billing:
 *   failed generations are not billed).
 * - 403 with `error.metadata.error_type` of `content_policy_violation` /
 *   `refusal` → PERMANENT, never retry (often caused by named trademarked
 *   characters — the orchestration layer falls back to a no-names prompt).
 *   The same provider filter also surfaces as other statuses (notably 400)
 *   with explicit content-filter phrasing or a `content_filter` error type —
 *   those classify as policy too.
 * - 400 with error types `image_download_failed` / `image_not_found` →
 *   the https reference URL couldn't be fetched upstream: retry ONCE
 *   text-only (ALL references are dropped — the inlined data-URL logo is
 *   never "unfetchable upstream", so a selective https-only retry would
 *   add state-machine complexity for no benefit; the orchestration layer
 *   re-attaches the logo on its next ladder rung anyway).
 */

export const OPENROUTER_IMAGES_URL = 'https://openrouter.ai/api/v1/images';

/** Verified image-model slug (2026). Overridable via IMAGE_MODEL. */
export const DEFAULT_IMAGE_MODEL = 'meta/muse-image';

/**
 * Generations take 60–90s+: a 5-minute stall budget so a slow-but-healthy
 * render is never cut off mid-flight.
 */
export const IMAGE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Responses carry a few MB of base64 — 15 MB is generous; anything bigger
 * is hostile. Enforced WHILE streaming (see readJsonCapped).
 */
export const IMAGE_MAX_BODY_BYTES = 15 * 1024 * 1024;

/** Backoff between transient-failure retries (~2s then ~5s). */
export const IMAGE_RETRY_DELAYS_MS = [2000, 5000];

/** 1 initial attempt + 1 retry per backoff delay (3 attempts total). */
export const IMAGE_MAX_ATTEMPTS = IMAGE_RETRY_DELAYS_MS.length + 1;

/** Upper bound for honouring an image-API `Retry-After` backoff hint. */
export const IMAGE_MAX_RETRY_AFTER_SEC = 120;

/**
 * Cap for an API `error.message` surfaced in a failure cause. The message
 * itself comes FIRST in the cause because a downstream phone display
 * truncates at ~180 chars — the meaningful part must land in the first 180.
 */
export const IMAGE_ERROR_MESSAGE_CAP = 300;

/**
 * Cap for the raw-body snippet surfaced when an error body is not JSON
 * (HTML/WAF pages): enough to identify the upstream, never a full dump.
 */
export const IMAGE_ERROR_RAW_SNIPPET_CAP = 200;

export interface ImageDeps {
  fetchFn: typeof fetch;
  apiKey: string;
  model: string;
  /** Per-request timeout in ms (default IMAGE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Max response body size in bytes (default IMAGE_MAX_BODY_BYTES). */
  maxBytes?: number;
  /** Backoff wait between retries (default: real setTimeout — inject a noop in tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface ImageConfig {
  apiKey: string | undefined;
  model: string;
}

/**
 * Resolve image config from the environment. Empty/whitespace values count
 * as unset. Reuses OPENROUTER_API_KEY (same key as the writer); the model
 * is user-overridable via IMAGE_MODEL.
 */
export function resolveImageConfig(env: NodeJS.ProcessEnv = process.env): ImageConfig {
  const apiKey = env.OPENROUTER_API_KEY?.trim() || undefined;
  const model = env.IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
  return { apiKey, model };
}

/** Machine-readable failure kinds for caller branching. */
export type ImageFailureKind = 'retryable' | 'policy' | 'reference-unfetchable' | 'failed';

/**
 * Typed image-API error. `status` is the HTTP status (absent when the
 * request never got a response). `kind` drives caller branching:
 * `policy` → never retry (fall back to a no-names prompt once);
 * `reference-unfetchable` → the reference URL couldn't be fetched upstream
 * (the client already retried once text-only before surfacing this);
 * `retryable` → a transient failure that exhausted its retries.
 * `retryAfterSec` carries a 429 backoff hint when one was present.
 */
export class ImageApiError extends Error {
  readonly status?: number;
  readonly retryAfterSec?: number;
  readonly kind: ImageFailureKind;

  constructor(
    message: string,
    opts: { status?: number; retryAfterSec?: number; kind?: ImageFailureKind } = {},
  ) {
    super(message);
    this.name = 'ImageApiError';
    this.status = opts.status;
    this.retryAfterSec = opts.retryAfterSec;
    this.kind = opts.kind ?? 'failed';
  }
}

/** True when the error is a permanent content-policy refusal (never retry). */
export function isPolicyRefusal(err: unknown): boolean {
  return err instanceof ImageApiError && err.kind === 'policy';
}

/** True when the reference image couldn't be fetched upstream. */
export function isReferenceUnfetchable(err: unknown): boolean {
  return err instanceof ImageApiError && err.kind === 'reference-unfetchable';
}

/** Strip the API key from any message — secrets never reach logs or errors. */
function sanitize(message: string, apiKey: string): string {
  if (apiKey !== '') return message.split(apiKey).join('[redacted]');
  return message;
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
 * guard), mirroring the writer convention (`src/writer/openrouter.ts`).
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

/**
 * Read a response body as text with a byte cap enforced WHILE streaming
 * (memory-DoS guard), mirroring `readJsonCapped`. Used for non-2xx bodies:
 * the text is JSON-parsed best-effort afterwards, so HTML/WAF/empty
 * upstreams stay diagnosable instead of throwing away all detail with a
 * blind JSON parse.
 */
async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
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
    return Buffer.concat(chunks).toString('utf8');
  }
  const raw = res as Response & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof raw.arrayBuffer === 'function') {
    const buf = await raw.arrayBuffer.call(res);
    if (buf.byteLength > maxBytes) {
      throw new Error(`response body too large (${buf.byteLength} bytes, limit ${maxBytes})`);
    }
    return Buffer.from(buf).toString('utf8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`response body too large (limit ${maxBytes} bytes)`);
  }
  return text;
}

/** Transient HTTP statuses worth another attempt (429 + server blips). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Transient transport errors worth another attempt: dropped connections and
 * the like. NOT retryable: `AbortSignal.timeout` exhaustion
 * (`TimeoutError` / `AbortError` — the 5-minute stall budget already ran
 * out) and redirect rejections (fail-closed `redirect: 'error'` is
 * deterministic).
 */
function isRetryableFetchError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name !== 'TimeoutError' && err.name !== 'AbortError';
  }
  if (err instanceof TypeError && /redirect/i.test(err.message)) return false;
  return true;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort `Retry-After` (seconds) from response headers. */
function retryAfterFromHeaders(res: Response): number | undefined {
  try {
    const raw = res.headers?.get('retry-after');
    if (raw == null) return undefined;
    const n = Number(raw.trim().split(',')[0]);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort extraction of OpenRouter's machine-readable error type:
 * `{error: {metadata: {error_type}}}` (also tolerates `reason` / `code`
 * spellings — the docs only promise the metadata shape, so be liberal).
 */
function errorTypeFromBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return undefined;
  const rec = err as Record<string, unknown>;
  const meta = rec.metadata;
  if (typeof meta === 'object' && meta !== null) {
    const t = (meta as Record<string, unknown>).error_type;
    if (typeof t === 'string' && t !== '') return t.toLowerCase();
    const reason = (meta as Record<string, unknown>).reason;
    if (typeof reason === 'string' && reason !== '') return reason.toLowerCase();
  }
  const code = rec.code;
  if (typeof code === 'string' && code !== '') return code.toLowerCase();
  if (typeof code === 'number') return String(code);
  return undefined;
}

/** Collapse every whitespace run to a single space and trim the ends. */
function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Best-effort extraction of OpenRouter's human-readable API error message:
 * `{error: {message}}`. Collapsed to one line and capped at
 * IMAGE_ERROR_MESSAGE_CAP chars; non-string or blank values are ignored.
 */
function errorMessageFromBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return undefined;
  const message = (err as Record<string, unknown>).message;
  if (typeof message !== 'string') return undefined;
  const collapsed = collapseWhitespace(message);
  if (collapsed === '') return undefined;
  return collapsed.length > IMAGE_ERROR_MESSAGE_CAP
    ? collapsed.slice(0, IMAGE_ERROR_MESSAGE_CAP)
    : collapsed;
}

/**
 * Best-effort extraction of OpenRouter's machine-readable error code:
 * `{error: {code}}` (numbers stringified). Blank values are ignored. Note
 * `errorTypeFromBody()` may itself be derived from this field — the display
 * in `formatErrorCause` dedupes a code that repeats the type token.
 */
function errorCodeFromBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as Record<string, unknown>).code;
  if (typeof code === 'string') return code === '' ? undefined : code;
  if (typeof code === 'number') return Number.isFinite(code) ? String(code) : undefined;
  return undefined;
}

/** Structured detail extracted from a non-2xx image-API response body. */
export interface ErrorDetail {
  /** Human-readable API message (whitespace-collapsed, capped). */
  message?: string;
  /** Machine-readable classification token (from `errorTypeFromBody`). */
  type?: string;
  /** Machine-readable error code (numbers stringified). */
  code?: string;
  /** Capped raw snippet, set only when the body was not blank JSON. */
  rawSnippet?: string;
  /** Oversize-guard text, set only when the body exceeded the byte cap. */
  bodyTooLargeMessage?: string;
}

/**
 * Build one non-2xx failure cause. The API message comes FIRST (a downstream
 * phone display truncates at ~180 chars — the meaningful part must land in
 * the first 180), machine-readable `[type=… code=…]` tokens next (missing
 * parts omitted, a code repeating the type deduped), and the caller's
 * human-readable suffix last. Unparseable bodies surface a capped raw
 * snippet plus `[unparseable body]`; oversize bodies surface only the cap
 * note (the bytes are never buffered). A blank body yields a bare
 * `HTTP <status>` — there is no detail to surface.
 */
function formatErrorCause(status: number, detail: ErrorDetail, suffix?: string): string {
  let cause = `HTTP ${status}`;
  if (detail.bodyTooLargeMessage !== undefined) {
    cause += ` (${detail.bodyTooLargeMessage})`;
  } else if (detail.rawSnippet !== undefined) {
    cause += `: "${detail.rawSnippet}" [unparseable body]`;
  } else {
    if (detail.message !== undefined) cause += `: "${detail.message}"`;
    const tokens: string[] = [];
    if (detail.type !== undefined) tokens.push(`type=${detail.type}`);
    if (detail.code !== undefined) {
      const repeatsType =
        detail.type !== undefined && detail.code.toLowerCase() === detail.type.toLowerCase();
      if (!repeatsType) tokens.push(`code=${detail.code}`);
    }
    if (tokens.length > 0) cause += ` [${tokens.join(' ')}]`;
  }
  if (suffix !== undefined) cause += ` ${suffix}`;
  return cause;
}

function isPolicyErrorType(t: string | undefined): boolean {
  if (!t) return false;
  return t.includes('content_policy_violation') || t === 'refusal' || t.includes('refusal');
}

/**
 * Tight content-filter phrasing match (case-insensitive) against the
 * human-readable API message. Matches ONLY explicit filter wording — never a
 * bare "policy" mention, so a plain validation 400 that happens to say
 * "policy" stays generic.
 */
function isContentFilterMessage(message: string | undefined): boolean {
  if (!message) return false;
  return (
    /filtered (?:due|because)/i.test(message) ||
    /content management policy/i.test(message) ||
    /content (management )?policy/i.test(message)
  );
}

/** True for machine-readable content-filter tokens (e.g. `content_filter`). */
function isContentFilterErrorType(t: string | undefined): boolean {
  if (!t) return false;
  return /content.filter/i.test(t);
}

function isReferenceErrorType(t: string | undefined): boolean {
  if (!t) return false;
  return t.includes('image_download_failed') || t.includes('image_not_found');
}

export interface GenerateImageRequest {
  /** Scope for typed errors, e.g. `draft 12`. */
  scope: string;
  /** English image prompt (see src/images/prompts.ts). */
  prompt: string;
  /**
   * Optional references, sent in order (max 2 expected: news + logo).
   * Semantic order: `[news-image?, channel-logo?]` — the article's news
   * image (https URL) first, the channel brand logo (base64 data URL)
   * second. Entries that are neither an https URL nor a
   * `data:image/<png|jpeg|webp|gif>;base64,` URL (case-tolerant) are
   * dropped before the wire call.
   */
  referenceUrls?: string[];
}

export interface GeneratedImage {
  bytes: Buffer;
  mediaType: string;
  extension: string;
  /** True when the successful call went out with ≥1 reference. */
  referenceUsed: boolean;
  /** How many references rode on the successful (final) wire call. */
  referencesUsed: number;
}

function extensionFor(mediaType: string): string {
  const t = mediaType.toLowerCase().split(';')[0].trim();
  if (t === 'image/jpeg') return 'jpg';
  if (t === 'image/webp') return 'webp';
  if (t === 'image/gif') return 'gif';
  return 'png';
}

/**
 * Hard cap on references per wire call (the contract allows at most two:
 * `[news-image?, channel-logo?]`). Enforced after `isSendableRef` filtering
 * in both `requestBody` and the `generateImage` retry loop. Exported for tests.
 */
export const MAX_SENDABLE_REFERENCES = 2;

function requestBody(model: string, prompt: string, referenceUrls?: string[]): string {
  const body: Record<string, unknown> = { model, prompt };
  // Minimal body: the model advertises no optional params
  // (`supported_parameters: {}`) — never send chat-API fields
  // (`modalities` / `messages` / `image_config`).
  const refs = (referenceUrls ?? []).filter(isSendableRef).slice(0, MAX_SENDABLE_REFERENCES);
  if (refs.length > 0) {
    body.input_references = refs.map((url) => ({
      type: 'image_url',
      image_url: { url },
    }));
  }
  return JSON.stringify(body);
}

/**
 * Only an https reference or an inlined `data:image/…;base64` image ever
 * goes on the wire — anything else is a caller bug, and sending it would
 * burn a paid call on a guaranteed 400. The data-URL media-type check is
 * case-tolerant (`DATA:IMAGE/PNG;BASE64,…` is a legal data URL), and the
 * payload must carry at least one base64 character (empty payloads are
 * dropped, never sent).
 */
function isSendableRef(url: string): boolean {
  if (/^https:\/\//.test(url)) return true;
  return /^data:image\/(png|jpe?g|webp|gif);base64,[\s\S]+$/i.test(url);
}

/**
 * One image generation. Returns the decoded bytes plus the file extension
 * derived from `media_type` (default png).
 *
 * Retry policy: transient failures (HTTP 429 / 5xx, dropped connections)
 * retry up to 2 times; a 400 with an `image_download_failed` /
 * `image_not_found` type retries ONCE fully text-only (every reference is
 * dropped — the https news image couldn't be fetched upstream, and the
 * data-URL logo is never worth a selective re-send); a content-policy refusal (403 policy/refusal type,
 * or explicit content-filter phrasing / a `content_filter` type at any
 * status) fails immediately with `kind: 'policy'` (the orchestration layer
 * walks progressively reduced prompts — never spend paid generations
 * re-sending a refused prompt).
 * Throws a typed `images generate failed for <scope>: <cause>` error —
 * the key is never in the message.
 */
export async function generateImage(
  request: GenerateImageRequest,
  deps: ImageDeps,
): Promise<GeneratedImage> {
  const maxBytes = deps.maxBytes ?? IMAGE_MAX_BODY_BYTES;
  const timeoutMs = deps.timeoutMs ?? IMAGE_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const fail = (
    cause: string,
    extra: { status?: number; retryAfterSec?: number; kind?: ImageFailureKind } = {},
  ): ImageApiError =>
    new ImageApiError(
      `images generate failed for ${request.scope}: ${sanitize(cause, deps.apiKey)}`,
      extra,
    );

  if (request.prompt.trim() === '') {
    throw fail('empty prompt');
  }
  // Only sendable references ever go on the wire (see `isSendableRef`).
  let referenceUrls = (request.referenceUrls ?? [])
    .filter(isSendableRef)
    .slice(0, MAX_SENDABLE_REFERENCES);
  let referenceDropped = false;

  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      // The key rides in the Authorization header: never follow redirects.
      res = await deps.fetchFn(OPENROUTER_IMAGES_URL, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: requestBody(deps.model, request.prompt, referenceUrls),
        // Fresh stall budget per attempt — a reused signal could already be spent.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isRetryableFetchError(err) && attempt < IMAGE_RETRY_DELAYS_MS.length) {
        await sleep(IMAGE_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw fail(`request failed: ${err instanceof Error ? err.message : String(err)}`, {
        kind: 'failed',
      });
    }

    if (!res.ok) {
      // Read the error body as capped TEXT first, then JSON-parse
      // best-effort: HTML/WAF/non-JSON upstreams stay diagnosable instead of
      // throwing away all detail with a blind JSON parse. Classification and
      // retry behavior below are unchanged — only the cause gains detail.
      let errorMessage: string | undefined;
      let errorType: string | undefined;
      let errorCode: string | undefined;
      let rawSnippet: string | undefined;
      let bodyTooLargeMessage: string | undefined;
      const retryAfterSec = retryAfterFromHeaders(res);
      try {
        const rawText = await readTextCapped(res, maxBytes);
        if (rawText.trim() !== '') {
          try {
            const errBody: unknown = JSON.parse(rawText);
            errorMessage = errorMessageFromBody(errBody);
            errorType = errorTypeFromBody(errBody);
            errorCode = errorCodeFromBody(errBody);
          } catch {
            rawSnippet = collapseWhitespace(rawText).slice(0, IMAGE_ERROR_RAW_SNIPPET_CAP);
          }
        }
      } catch (err) {
        // Oversize (or otherwise unreadable) body: surface the guard note,
        // never the raw bytes. Anything else leaves the detail blank.
        if (err instanceof Error && /too large/.test(err.message)) {
          bodyTooLargeMessage = err.message;
        }
      }
      const detail: ErrorDetail = {
        message: errorMessage,
        type: errorType,
        code: errorCode,
        rawSnippet,
        bodyTooLargeMessage,
      };
      try {
        await res.body?.cancel();
      } catch {
        // A broken body must not mask the HTTP error — ignore cancel failures.
      }

      // Permanent: content-policy refusal — never retry the same prompt.
      // Fires on (a) a 403 with a policy/refusal error type, or (b) ANY status
      // whose API message uses explicit content-filter phrasing (providers
      // surface the same filter as 400 or 403), or whose error type is a
      // content-filter token. Rejected filter calls are unbilled and fast —
      // the orchestration layer walks progressively reduced prompts
      // (see src/images/run.ts).
      const isPolicy =
        (res.status === 403 && isPolicyErrorType(errorType)) ||
        isContentFilterMessage(errorMessage) ||
        isContentFilterErrorType(errorType);
      if (isPolicy) {
        throw fail(formatErrorCause(res.status, detail, '(content policy refusal — not retrying)'), {
          status: res.status,
          kind: 'policy',
        });
      }
      // Reference-unfetchable: the upstream couldn't fetch the https news
      // image — retry ONCE text-only (drop ALL refs, logo included: a
      // data URL is never "unfetchable", and re-sending it alone on a
      // doomed-shape retry would burn context for no signal). The text-only
      // retry DOES consume a transient attempt (the loop's `continue`
      // advances the attempt counter).
      if (res.status === 400 && isReferenceErrorType(errorType)) {
        if (referenceUrls.length > 0 && !referenceDropped) {
          referenceUrls = [];
          referenceDropped = true;
          continue;
        }
        throw fail(
          formatErrorCause(400, detail, '(reference image unfetchable upstream)'),
          {
            status: 400,
            kind: 'reference-unfetchable',
          },
        );
      }
      if (isRetryableStatus(res.status)) {
        if (res.status === 429 && retryAfterSec !== undefined) {
          const waitSec = Math.min(retryAfterSec, IMAGE_MAX_RETRY_AFTER_SEC);
          await sleep(waitSec * 1000);
          if (attempt < IMAGE_MAX_ATTEMPTS - 1) continue;
          throw fail(formatErrorCause(429, detail, `(retry after ${retryAfterSec}s)`), {
            status: 429,
            retryAfterSec,
            kind: 'retryable',
          });
        }
        if (attempt < IMAGE_RETRY_DELAYS_MS.length) {
          await sleep(IMAGE_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw fail(formatErrorCause(res.status, detail), {
          status: res.status,
          kind: 'retryable',
        });
      }
      // Late reference-unfetchable without a machine-readable type on a
      // non-400 (defensive): surface the kind so callers can branch.
      throw fail(formatErrorCause(res.status, detail), {
        status: res.status,
        kind: 'failed',
      });
    }

    let body: unknown;
    try {
      body = await readJsonCapped(res, maxBytes);
    } catch (err) {
      throw fail(err instanceof Error ? err.message : String(err), { kind: 'failed' });
    }

    const first = (body as { data?: Array<{ b64_json?: unknown; media_type?: unknown }> })?.data?.[0];
    const b64 = first?.b64_json;
    if (typeof b64 !== 'string' || b64 === '') {
      throw fail('unexpected response shape (missing data[0].b64_json)', { kind: 'failed' });
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, 'base64');
    } catch (err) {
      throw fail(`invalid base64 payload: ${err instanceof Error ? err.message : String(err)}`, {
        kind: 'failed',
      });
    }
    if (bytes.length === 0) {
      throw fail('empty image payload', { kind: 'failed' });
    }
    const mediaType =
      typeof first?.media_type === 'string' && first.media_type !== ''
        ? first.media_type
        : 'image/png';
    return {
      bytes,
      mediaType,
      extension: extensionFor(mediaType),
      referenceUsed: referenceUrls.length > 0,
      referencesUsed: referenceUrls.length,
    };
  }
}
