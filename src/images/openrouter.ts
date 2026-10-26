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
 * - Minimal body: `{model, prompt, input_references?}` with at most ONE
 *   reference `{type:'image_url', image_url:{url}}`. Never send
 *   `modalities` / `messages` / `image_config` (chat-API fields).
 * - Response: `{data:[{b64_json, media_type}]}` — base64 only, no hosted
 *   URL. Generations take 60–90s+, so the timeout budget is ≥5 min.
 *
 * Machine-readable failure classification (callers branch on this):
 * - 429 → honour `Retry-After`, retryable.
 * - 5xx (502/524/529 included) → safe to retry (all-or-nothing billing:
 *   failed generations are not billed).
 * - 403 with `error.metadata.error_type` of `content_policy_violation` /
 *   `refusal` → PERMANENT, never retry (often caused by named trademarked
 *   characters — the orchestration layer falls back to a no-names prompt).
 * - 400 with error types `image_download_failed` / `image_not_found` →
 *   the reference URL couldn't be fetched upstream: retry ONCE without the
 *   reference (text-only prompt).
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

function isPolicyErrorType(t: string | undefined): boolean {
  if (!t) return false;
  return t.includes('content_policy_violation') || t === 'refusal' || t.includes('refusal');
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
  /** Optional https reference (the article's news image). */
  referenceUrl?: string;
}

export interface GeneratedImage {
  bytes: Buffer;
  mediaType: string;
  extension: string;
  /** False when the call went out text-only (no reference, or reference dropped after a 400). */
  referenceUsed: boolean;
}

function extensionFor(mediaType: string): string {
  const t = mediaType.toLowerCase().split(';')[0].trim();
  if (t === 'image/jpeg') return 'jpg';
  if (t === 'image/webp') return 'webp';
  if (t === 'image/gif') return 'gif';
  return 'png';
}

function requestBody(model: string, prompt: string, referenceUrl?: string): string {
  const body: Record<string, unknown> = { model, prompt };
  // Minimal body: the model advertises no optional params
  // (`supported_parameters: {}`) — never send chat-API fields
  // (`modalities` / `messages` / `image_config`).
  if (referenceUrl) {
    body.input_references = [
      { type: 'image_url', image_url: { url: referenceUrl } },
    ];
  }
  return JSON.stringify(body);
}

/**
 * One image generation. Returns the decoded bytes plus the file extension
 * derived from `media_type` (default png).
 *
 * Retry policy: transient failures (HTTP 429 / 5xx, dropped connections)
 * retry up to 2 times; a 400 with an `image_download_failed` /
 * `image_not_found` type retries ONCE text-only (the reference URL couldn't
 * be fetched upstream); a 403 content-policy refusal fails immediately with
 * `kind: 'policy'` (the orchestration layer falls back to a no-names prompt
 * once — never spend paid generations re-sending a refused prompt).
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
  // Only an https reference ever goes on the wire — anything else is a
  // caller bug, and sending it would burn a paid call on a guaranteed 400.
  const initialRef =
    request.referenceUrl !== undefined && /^https:\/\//.test(request.referenceUrl)
      ? request.referenceUrl
      : undefined;

  let referenceUrl = initialRef;
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
        body: requestBody(deps.model, request.prompt, referenceUrl),
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
      // Read the error body best-effort (capped) for the machine-readable
      // type BEFORE deciding retry vs permanent; release the connection as well.
      let errorType: string | undefined;
      let retryAfterSec = retryAfterFromHeaders(res);
      try {
        const errBody = await readJsonCapped(res, maxBytes);
        errorType = errorTypeFromBody(errBody);
      } catch {
        errorType = undefined;
      }
      try {
        await res.body?.cancel();
      } catch {
        // A broken body must not mask the HTTP error — ignore cancel failures.
      }

      // Permanent: content-policy refusal — never retry the same prompt.
      if (res.status === 403 && isPolicyErrorType(errorType)) {
        throw fail(`HTTP 403 (content policy refusal — not retrying)`, {
          status: 403,
          kind: 'policy',
        });
      }
      // Reference-unfetchable: the upstream couldn't fetch the news image —
      // retry ONCE text-only (does not consume a transient attempt).
      if (res.status === 400 && isReferenceErrorType(errorType)) {
        if (referenceUrl !== undefined && !referenceDropped) {
          referenceUrl = undefined;
          referenceDropped = true;
          continue;
        }
        throw fail(`HTTP 400 (reference image unfetchable upstream)`, {
          status: 400,
          kind: 'reference-unfetchable',
        });
      }
      if (isRetryableStatus(res.status)) {
        if (res.status === 429 && retryAfterSec !== undefined) {
          const waitSec = Math.min(retryAfterSec, IMAGE_MAX_RETRY_AFTER_SEC);
          await sleep(waitSec * 1000);
          if (attempt < IMAGE_MAX_ATTEMPTS - 1) continue;
          throw fail(`HTTP 429 (retry after ${retryAfterSec}s)`, {
            status: 429,
            retryAfterSec,
            kind: 'retryable',
          });
        }
        if (attempt < IMAGE_RETRY_DELAYS_MS.length) {
          await sleep(IMAGE_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw fail(`HTTP ${res.status}`, { status: res.status, kind: 'retryable' });
      }
      // Late reference-unfetchable without a machine-readable type on a
      // non-400 (defensive): surface the kind so callers can branch.
      throw fail(`HTTP ${res.status}`, {
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
      referenceUsed: referenceUrl !== undefined,
    };
  }
}
