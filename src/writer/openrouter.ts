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

/**
 * Token budget per caption call. Reasoning-style free-tier models (e.g. the
 * default Nemotron VL slug) emit ~400-500 tokens of English chain-of-thought
 * in `message.reasoning` BEFORE the caption: with the old 500-token budget the
 * run was cut off mid-reasoning (`content: null`, `finish_reason: length`) and
 * most articles failed. 2000 leaves room for the reasoning plus the caption.
 */
export const LLM_MAX_TOKENS = 2000;

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

/**
 * One LLM call → raw Spanish caption for an article. Throws a typed
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
        max_tokens: LLM_MAX_TOKENS,
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
