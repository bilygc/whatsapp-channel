import { buildUserPrompt, SYSTEM_PROMPT, type PromptArticle } from './prompts.js';

export interface LlmArticle extends PromptArticle {
  id: number;
}

export interface LlmDeps {
  fetchFn: typeof fetch;
  apiKey: string;
  model: string;
  /** Per-request timeout in ms (default LLM_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Max response body size in bytes (default LLM_MAX_BODY_BYTES). */
  maxBytes?: number;
}

/** OpenAI-compatible chat-completions endpoint (OpenRouter). */
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Resolved live against https://openrouter.ai/api/v1/models (2026-10-17). */
export const DEFAULT_LLM_MODEL = 'nvidia/nemotron-3.5-super-vl:free';

/** Generation takes longer than a feed fetch: 60s stall budget. */
export const LLM_TIMEOUT_MS = 60_000;

/** Captions are short — 1 MB is already generous; anything bigger is hostile. */
export const LLM_MAX_BODY_BYTES = 1 * 1024 * 1024;

export interface LlmConfig {
  apiKey: string | undefined;
  model: string;
}

/**
 * Resolve LLM config from the environment. Empty/whitespace values count as
 * unset. The model is user-overridable via LLM_MODEL; the default is the
 * free-tier Nemotron VL slug resolved at implementation time.
 */
export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = env.OPENROUTER_API_KEY?.trim() || undefined;
  const model = env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
  return { apiKey, model };
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
 * One LLM call → raw Spanish caption for an article. Throws a typed
 * `llm write failed for article <id>: <cause>` error on HTTP errors (401/429
 * quota), timeouts, oversize bodies, unexpected shapes, or empty replies —
 * callers catch per article so one failure never blocks the rest, and the
 * article stays `selected` for a retry. Error messages never contain the key.
 */
export async function generateCaption(article: LlmArticle, deps: LlmDeps): Promise<string> {
  const maxBytes = deps.maxBytes ?? LLM_MAX_BODY_BYTES;
  const timeoutMs = deps.timeoutMs ?? LLM_TIMEOUT_MS;
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

  let res: Response;
  try {
    // The key rides in the Authorization header: never follow redirects —
    // fail closed rather than forward the secret to an untrusted target
    // (same convention as the NewsData fetcher).
    res = await deps.fetchFn(OPENROUTER_URL, {
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
        max_tokens: 500,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw fail(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    // Release the connection before throwing; the status is all we report.
    try {
      await res.body?.cancel();
    } catch {
      // A broken body must not mask the HTTP error — ignore cancel failures.
    }
    throw fail(`HTTP ${res.status}`);
  }

  let body: unknown;
  try {
    body = await readJsonCapped(res, maxBytes);
  } catch (err) {
    throw fail(err instanceof Error ? err.message : String(err));
  }

  const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
    ?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    if (typeof content === 'string') throw fail('empty reply');
    throw fail('unexpected response shape');
  }
  return content;
}
