import { buildUserPrompt, buildXUserPrompt, SYSTEM_PROMPT, X_SYSTEM_PROMPT, type PromptArticle } from './prompts.js';

export interface LlmArticle extends PromptArticle {
  id: number;
}

export interface LlmDeps {
  fetchFn: typeof fetch;
  apiKey: string;
  model: string;
  /** Per-request timeout in ms (default LLM_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Token budget per call (default LLM_MAX_TOKENS; overridable via LLM_MAX_TOKENS env). */
  maxTokens?: number;
  /** Max response body size in bytes (default LLM_MAX_BODY_BYTES). */
  maxBytes?: number;
  /** Backoff wait between retries (default: real setTimeout — inject a noop in tests). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Spacing delay between the caption and X-post calls in `generateDraft`
   * (default LLM_CALL_SPACING_MS; 0 disables). Consulted via `deps.sleep`,
   * so tests inject a noop like any other backoff.
   */
  callSpacingMs?: number;
}

/** OpenAI-compatible chat-completions endpoint (OpenRouter). */
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Resolved live against https://openrouter.ai/api/v1/models (2026-10-17). */
export const DEFAULT_LLM_MODEL = 'nvidia/nemotron-3.5-super-vl:free';

/** Generation takes longer than a feed fetch: 60s stall budget. */
export const LLM_TIMEOUT_MS = 60_000;

/**
 * Default token budget per caption call. Reasoning-style free-tier models
 * (e.g. the default Nemotron VL slug) emit English chain-of-thought in
 * `message.reasoning` BEFORE the caption: with the original 500-token budget
 * the run was cut off mid-reasoning (`content: null`, `finish_reason: length`)
 * and most articles failed (incident 1 → raised to 2000). The model's
 * reasoning length has since grown past that too — ~1500+ tokens of CoT
 * observed — and every article failed the same way again (incident 2).
 * 6000 fits ~1500+ reasoning tokens plus a full 1500-char Spanish caption
 * (~500-800 tokens) plus hashtags with headroom. Overridable per-machine via
 * the LLM_MAX_TOKENS env var (see resolveLlmConfig); the fail-fast
 * no-retry-on-truncation policy is unchanged (deliberate: free-tier quota).
 */
export const LLM_MAX_TOKENS = 6000;

/** Captions are short — 1 MB is already generous; anything bigger is hostile. */
export const LLM_MAX_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Backoff between transient-failure retries: ~750ms then ~2000ms. Total added
 * wall-time stays under ~3s in the worst case (free-tier 502s are usually a
 * brief capacity blip, so a short backoff is enough without stalling the run).
 */
export const LLM_RETRY_DELAYS_MS = [750, 2000];

/**
 * Backoff between RATE-LIMIT (HTTP 429) retries: ~2s then ~10s then ~30s.
 * Free-tier 429s signal real quota pressure — each article now costs TWO LLM
 * calls since the X-post feature landed — so the schedule is an order of
 * magnitude longer than the 5xx blip schedule above: hammering a limited
 * model with 750ms retries only extends the ban. A `Retry-After` response
 * header overrides the schedule entry for that retry when parseable (see
 * retryAfterMs). 5xxs and dropped connections stay on the short schedule.
 */
export const LLM_RATE_LIMIT_DELAYS_MS = [2000, 10_000, 30_000];

/**
 * Spacing delay between the caption and X-post calls in `generateDraft`:
 * keeps the per-article burst from arriving back-to-back in the same
 * instant. Small on purpose (a failed run is re-run manually) and
 * overridable per call via `LlmDeps.callSpacingMs` (0 disables).
 */
export const LLM_CALL_SPACING_MS = 250;

/** 1 initial attempt + 1 retry per backoff delay (3 attempts total). */
export const LLM_MAX_ATTEMPTS = LLM_RETRY_DELAYS_MS.length + 1;

export interface LlmConfig {
  apiKey: string | undefined;
  model: string;
  maxTokens: number;
}

/**
 * Resolve LLM config from the environment. Empty/whitespace values count as
 * unset. The model is user-overridable via LLM_MODEL; the default is the
 * free-tier Nemotron VL slug resolved at implementation time. The token
 * budget is user-overridable via LLM_MAX_TOKENS; blank, non-numeric,
 * non-integer, or non-positive values fall back to the default.
 */
export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = env.OPENROUTER_API_KEY?.trim() || undefined;
  const model = env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
  const rawMax = env.LLM_MAX_TOKENS?.trim();
  const parsedMax = rawMax ? Number(rawMax) : NaN;
  const maxTokens =
    rawMax && Number.isInteger(parsedMax) && parsedMax > 0 ? parsedMax : LLM_MAX_TOKENS;
  return { apiKey, model, maxTokens };
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
 * guard), mirroring the RSS fetcher convention (`src/fetcher/rss.ts`):
 * the declared content-length is checked first, then chunks are counted as
 * they arrive and the stream is cancelled on overflow — so a chunked reply
 * with no content-length cannot OOM the run. Test doubles without a stream
 * fall back to `arrayBuffer()` / `json()` with a post-read size check.
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
 * Pull caption text out of an OpenAI-compatible message. Accepts a plain
 * string `content` and the `content` array of typed parts some providers
 * return (`[{type:'text',text:...}, …]` — non-text parts are ignored).
 * Returns null when no caption text is present. NOTE: `reasoning` /
 * `reasoning_content` are deliberately NEVER used as the caption — live
 * traffic shows they carry the model's English chain-of-thought, not the
 * Spanish caption, so surfacing them would store deliberation as a draft.
 */
function messageContent(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (part): part is { type: string; text: string } =>
          typeof part === 'object' &&
          part !== null &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text);
    return texts.length > 0 ? texts.join('') : null;
  }
  return null;
}

/** Strip `<think>…</think>` deliberation blocks some models wrap around the caption. */
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Transient HTTP statuses worth one more attempt: rate limit + server blips. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Parse a `Retry-After` header value into milliseconds. Accepts delay-seconds
 * (`120`, the form OpenRouter sends on free-tier 429s) and HTTP-dates;
 * returns null when missing, unparseable, or already in the past (the caller
 * falls back to the 429 schedule). Never throws — header values are
 * provider-controlled.
 */
function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(trimmed);
  if (!Number.isNaN(at)) {
    const delta = at - Date.now();
    return delta > 0 ? delta : null;
  }
  return null;
}

/** Read the `Retry-After` header without letting a hostile value throw. */
function retryAfterMs(res: Response): number | null {
  try {
    return parseRetryAfterMs(res.headers?.get('retry-after'));
  } catch {
    return null;
  }
}

/**
 * Transient transport errors worth one more attempt: dropped connections and
 * the like. NOT retryable: `AbortSignal.timeout` exhaustion (`TimeoutError` /
 * `AbortError` — the stall budget already ran out, waiting longer burns quota
 * for nothing) and redirect rejections (fail-closed `redirect: 'error'` is
 * deterministic — retrying just re-sends the key at the same wall).
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

/**
 * One LLM call → raw Spanish caption for an article. Throws a typed
 * `llm write failed for article <id>: <cause>` error — callers catch per
 * article so one failure never blocks the rest, and the article stays
 * `selected` for a retry. Error messages never contain the key.
 *
 * Transient failures are retried on two independent budgets: HTTP 429
 * (rate limit) waits out the long `LLM_RATE_LIMIT_DELAYS_MS` schedule (up to
 * 3 retries, honoring `Retry-After` when the provider sends one), while 5xx
 * and dropped connections keep the short `LLM_RETRY_DELAYS_MS` backoff —
 * free-tier 502 blips resolve on their own and a manual re-run should not be
 * needed. Deterministic failures (other 4xx, timeouts, bad shapes,
 * truncation, empty replies) fail immediately: retrying those only burns
 * free-tier quota. Retries are silent (no per-attempt log noise with key
 * material) — the run summary still just reports ok/FAILED.
 */
export async function generateCaption(article: LlmArticle, deps: LlmDeps): Promise<string> {
  const maxBytes = deps.maxBytes ?? LLM_MAX_BODY_BYTES;
  const timeoutMs = deps.timeoutMs ?? LLM_TIMEOUT_MS;
  const maxTokens = deps.maxTokens ?? LLM_MAX_TOKENS;
  const sleep = deps.sleep ?? defaultSleep;
  const fail = (cause: string): Error =>
    new Error(`llm write failed for article ${article.id}: ${sanitize(cause, deps.apiKey)}`);

  let userPrompt: string;
  try {
    userPrompt = buildUserPrompt(article);
  } catch (err) {
    // Invalid article (e.g. absurd URL): typed, and thrown BEFORE any network
    // call so a bad row never spends LLM credits. The article stays `selected`
    // for a later run to skip again.
    throw fail(err instanceof Error ? err.message : String(err));
  }

  const requestInit = (): RequestInit => ({
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${deps.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: deps.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
    // Fresh stall budget per attempt — a reused signal could already be spent.
    signal: AbortSignal.timeout(timeoutMs),
  });

  // 429s and 5xx/transports retry on INDEPENDENT budgets: rate limiting gets
  // the long schedule (up to 3 retries), brief 5xx blips and dropped
  // connections keep the short one. Mixed failures consume both budgets.
  let transientRetries = 0;
  let rateLimitRetries = 0;
  for (;;) {
    let res: Response;
    try {
      // The key rides in the Authorization header: never follow redirects —
      // fail closed rather than forward the secret to an untrusted target
      // (same convention as the NewsData fetcher).
      res = await deps.fetchFn(OPENROUTER_URL, requestInit());
    } catch (err) {
      if (isRetryableFetchError(err) && transientRetries < LLM_RETRY_DELAYS_MS.length) {
        await sleep(LLM_RETRY_DELAYS_MS[transientRetries]);
        transientRetries += 1;
        continue;
      }
      throw fail(`request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      // Release the connection before throwing OR retrying; the status is all
      // we report.
      try {
        await res.body?.cancel();
      } catch {
        // A broken body must not mask the HTTP error — ignore cancel failures.
      }
      if (res.status === 429) {
        // Rate limiting gets its own, longer budget (up to 3 retries): the
        // provider asked us to slow down, so the short blip backoff must not
        // apply. Mixed failures consume both budgets independently.
        if (rateLimitRetries < LLM_RATE_LIMIT_DELAYS_MS.length) {
          const wait = retryAfterMs(res) ?? LLM_RATE_LIMIT_DELAYS_MS[rateLimitRetries];
          rateLimitRetries += 1;
          await sleep(wait);
          continue;
        }
        throw fail(`HTTP 429 (rate limited, gave up after ${rateLimitRetries} retries)`);
      }
      if (isRetryableStatus(res.status) && transientRetries < LLM_RETRY_DELAYS_MS.length) {
        await sleep(LLM_RETRY_DELAYS_MS[transientRetries]);
        transientRetries += 1;
        continue;
      }
      throw fail(`HTTP ${res.status}`);
    }

    let body: unknown;
    try {
      body = await readJsonCapped(res, maxBytes);
    } catch (err) {
      throw fail(err instanceof Error ? err.message : String(err));
    }

    const choice = (body as { choices?: Array<{ finish_reason?: unknown; message?: unknown }> })?.choices?.[0];
    const raw = messageContent(choice?.message);
    if (raw === null) {
      // Reasoning models cut off mid-chain-of-thought report content:null with
      // finish_reason length — actionable (budget/model issue), not a generic
      // shape mystery. The article stays `selected` for a retry.
      if (choice?.finish_reason === 'length') {
        throw fail('response truncated before any caption text (finish_reason length)');
      }
      throw fail('unexpected response shape');
    }
    const content = stripThinkBlocks(raw);
    if (content === '') throw fail('empty reply');
    return content;
  }
}

/**
 * One LLM call → raw Spanish X post for an article. A dedicated second call
 * (not a two-section caption reply) so the caption path stays byte-identical
 * and X drift can never corrupt it: callers treat an X failure as
 * non-fatal (the draft stores with `x_post_es` NULL for a later
 * regenerate). Same retry/sanitize/timeout contract as generateCaption —
 * including the long 429 schedule with `Retry-After` honoring (up to 3
 * retries, then a typed exhaustion error) — the error prefix differs
 * (`llm xpost failed …`) so run summaries tell the two calls apart. Throws a typed
 * `llm xpost failed for article <id>: <cause>` error; messages never
 * contain the key.
 */
export async function generateXPost(article: LlmArticle, deps: LlmDeps): Promise<string> {
  const maxBytes = deps.maxBytes ?? LLM_MAX_BODY_BYTES;
  const timeoutMs = deps.timeoutMs ?? LLM_TIMEOUT_MS;
  const maxTokens = deps.maxTokens ?? LLM_MAX_TOKENS;
  const sleep = deps.sleep ?? defaultSleep;
  const fail = (cause: string): Error =>
    new Error(`llm xpost failed for article ${article.id}: ${sanitize(cause, deps.apiKey)}`);

  let userPrompt: string;
  try {
    userPrompt = buildXUserPrompt(article);
  } catch (err) {
    // Invalid article (e.g. absurd URL): typed, and thrown BEFORE any network
    // call so a bad row never spends LLM credits.
    throw fail(err instanceof Error ? err.message : String(err));
  }

  const requestInit = (): RequestInit => ({
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${deps.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: deps.model,
      messages: [
        { role: 'system', content: X_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
    // Fresh stall budget per attempt — a reused signal could already be spent.
    signal: AbortSignal.timeout(timeoutMs),
  });

  // 429s and 5xx/transports retry on INDEPENDENT budgets: rate limiting gets
  // the long schedule (up to 3 retries), brief 5xx blips and dropped
  // connections keep the short one. Mixed failures consume both budgets.
  let transientRetries = 0;
  let rateLimitRetries = 0;
  for (;;) {
    let res: Response;
    try {
      // The key rides in the Authorization header: never follow redirects —
      // fail closed rather than forward the secret to an untrusted target
      // (same convention as the NewsData fetcher).
      res = await deps.fetchFn(OPENROUTER_URL, requestInit());
    } catch (err) {
      if (isRetryableFetchError(err) && transientRetries < LLM_RETRY_DELAYS_MS.length) {
        await sleep(LLM_RETRY_DELAYS_MS[transientRetries]);
        transientRetries += 1;
        continue;
      }
      throw fail(`request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      // Release the connection before throwing OR retrying; the status is all
      // we report.
      try {
        await res.body?.cancel();
      } catch {
        // A broken body must not mask the HTTP error — ignore cancel failures.
      }
      if (res.status === 429) {
        // Rate limiting gets its own, longer budget (up to 3 retries): the
        // provider asked us to slow down, so the short blip backoff must not
        // apply. Mixed failures consume both budgets independently.
        if (rateLimitRetries < LLM_RATE_LIMIT_DELAYS_MS.length) {
          const wait = retryAfterMs(res) ?? LLM_RATE_LIMIT_DELAYS_MS[rateLimitRetries];
          rateLimitRetries += 1;
          await sleep(wait);
          continue;
        }
        throw fail(`HTTP 429 (rate limited, gave up after ${rateLimitRetries} retries)`);
      }
      if (isRetryableStatus(res.status) && transientRetries < LLM_RETRY_DELAYS_MS.length) {
        await sleep(LLM_RETRY_DELAYS_MS[transientRetries]);
        transientRetries += 1;
        continue;
      }
      throw fail(`HTTP ${res.status}`);
    }

    let body: unknown;
    try {
      body = await readJsonCapped(res, maxBytes);
    } catch (err) {
      throw fail(err instanceof Error ? err.message : String(err));
    }

    const choice = (body as { choices?: Array<{ finish_reason?: unknown; message?: unknown }> })?.choices?.[0];
    const raw = messageContent(choice?.message);
    if (raw === null) {
      if (choice?.finish_reason === 'length') {
        throw fail('response truncated before any post text (finish_reason length)');
      }
      throw fail('unexpected response shape');
    }
    const content = stripThinkBlocks(raw);
    if (content === '') throw fail('empty reply');
    return content;
  }
}

/** Raw (pre-validation) output of the two-call draft generation. */
export interface GeneratedDraftRaw {
  caption: string;
  /** Null when the X call failed — the draft still stores, without an X post. */
  xPost: string | null;
}

/**
 * Generate both draft texts for an article: the caption call first, then the
 * X-post call. The X call fails independently to `null` (its typed error is
 * swallowed here — runWriter records nothing for it): a tweet failure must
 * never fail the article or lose the caption. A caption failure still
 * propagates (the article stays `selected` for a retry) — notably a caption
 * 429 exhausts the long backoff and throws BEFORE the X call is attempted,
 * so a rate-limited model never spends a second round of quota on the same
 * article. The two calls stay sequential (no parallelism): bursty parallel
 * calls are exactly what trips free-tier limits, and a short spacing delay
 * (`LLM_CALL_SPACING_MS`, via `deps.callSpacingMs`) spreads the burst.
 */
export async function generateDraft(article: LlmArticle, deps: LlmDeps): Promise<GeneratedDraftRaw> {
  const caption = await generateCaption(article, deps);
  const sleep = deps.sleep ?? defaultSleep;
  const spacing = deps.callSpacingMs ?? LLM_CALL_SPACING_MS;
  if (spacing > 0) await sleep(spacing);
  let xPost: string | null = null;
  try {
    xPost = await generateXPost(article, deps);
  } catch {
    xPost = null;
  }
  return { caption, xPost };
}
