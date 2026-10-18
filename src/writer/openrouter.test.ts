import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LLM_MODEL,
  generateCaption,
  LLM_TIMEOUT_MS,
  OPENROUTER_URL,
  resolveLlmConfig,
  type LlmArticle,
} from './openrouter.js';

const ARTICLE: LlmArticle = {
  id: 1,
  title: 'Elden Ring DLC announced',
  source: 'IGN',
  url: 'https://example.com/elden-ring-dlc',
};

function okResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content } }] })).buffer as ArrayBuffer,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    fetchFn: vi.fn(async () => okResponse('🔥 caption\n\nFuente: IGN https://example.com/elden-ring-dlc')),
    apiKey: 'test-key',
    model: DEFAULT_LLM_MODEL,
    ...overrides,
  };
}

describe('resolveLlmConfig', () => {
  it('defaults the model to the Nemotron free slug when LLM_MODEL is unset', () => {
    expect(resolveLlmConfig({})).toEqual({ apiKey: undefined, model: DEFAULT_LLM_MODEL });
    expect(DEFAULT_LLM_MODEL).toBe('nvidia/nemotron-3.5-super-vl:free');
  });

  it('honours LLM_MODEL and OPENROUTER_API_KEY from the environment', () => {
    expect(
      resolveLlmConfig({ OPENROUTER_API_KEY: 'k', LLM_MODEL: 'other/model:free' }),
    ).toEqual({ apiKey: 'k', model: 'other/model:free' });
  });

  it('treats blank env values as unset', () => {
    expect(resolveLlmConfig({ OPENROUTER_API_KEY: '  ', LLM_MODEL: '' })).toEqual({
      apiKey: undefined,
      model: DEFAULT_LLM_MODEL,
    });
  });
});

describe('generateCaption', () => {
  it('posts to the OpenRouter chat-completions endpoint and returns the content', async () => {
    const d = deps();
    const caption = await generateCaption(ARTICLE, d);
    expect(caption).toContain('caption');
    expect(d.fetchFn).toHaveBeenCalledOnce();
    const [url, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OPENROUTER_URL);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string) as { model: string; messages: unknown[] };
    expect(body.model).toBe(DEFAULT_LLM_MODEL);
    expect(body.messages).toHaveLength(2);
  });

  it('fails typed (never raw) on HTTP errors, with the key redacted', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 429 }) as unknown as Response);
    await expect(generateCaption(ARTICLE, deps({ fetchFn }))).rejects.toThrow(
      /^llm write failed for article 1: /,
    );
    await expect(generateCaption(ARTICLE, deps({ fetchFn }))).rejects.not.toThrow(/test-key/);
  });

  it('fails typed on timeouts/aborts, with the key redacted', async () => {
    const fetchFn = vi.fn(async () => {
      throw new DOMException('The operation was aborted.', 'TimeoutError');
    });
    await expect(generateCaption(ARTICLE, deps({ fetchFn }))).rejects.toThrow(
      /^llm write failed for article 1: /,
    );
  });

  it('fails typed on empty replies (whitespace-only content)', async () => {
    const fetchFn = vi.fn(async () => okResponse('   \n  '));
    await expect(generateCaption(ARTICLE, deps({ fetchFn }))).rejects.toThrow(/empty reply/);
  });

  it('fails typed on unexpected response shapes (no choices)', async () => {
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ nope: 1 })).buffer as ArrayBuffer,
          json: async () => ({ nope: 1 }),
        }) as unknown as Response,
    );
    await expect(generateCaption(ARTICLE, deps({ fetchFn }))).rejects.toThrow(
      /^llm write failed for article 1: unexpected response shape/,
    );
  });

  it('fails typed on oversize bodies (no unbounded response buffering)', async () => {
    const big = 'z'.repeat(64);
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => String(10 * 1024 * 1024) },
          arrayBuffer: async () => new TextEncoder().encode(big).buffer as ArrayBuffer,
          json: async () => big,
        }) as unknown as Response,
    );
    await expect(generateCaption(ARTICLE, deps({ fetchFn, maxBytes: 16 }))).rejects.toThrow(
      /too large/,
    );
  });

  it('sends an abort timeout so a stalled LLM call cannot hang the run', async () => {
    const d = deps();
    await generateCaption(ARTICLE, d);
    const [, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(LLM_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('sends redirect:error so the bearer key is never forwarded to a redirect target', async () => {
    const d = deps();
    await generateCaption(ARTICLE, d);
    const [, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('error');
  });

  it('fails typed (never raw, key redacted) on redirect rejection', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed: unexpected redirect');
    });
    await expect(generateCaption(ARTICLE, deps({ fetchFn }))).rejects.toThrow(
      /^llm write failed for article 1: .*redirect/,
    );
    await expect(generateCaption(ARTICLE, deps({ fetchFn }))).rejects.not.toThrow(/test-key/);
  });

  it('fails typed on oversize chunked streams with no content-length (never buffers unbounded)', async () => {
    const chunk = new TextEncoder().encode('{"choices":[{"message":{"content":"');
    const bigTail = new TextEncoder().encode(`${'z'.repeat(4096)}"}}]}`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(bigTail);
        controller.close();
      },
    });
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: stream,
        }) as unknown as Response,
    );
    await expect(generateCaption(ARTICLE, deps({ fetchFn, maxBytes: 64 }))).rejects.toThrow(
      /^llm write failed for article 1: .*too large/,
    );
  });

  it('drains the unread body on HTTP errors before throwing (status-only message)', async () => {
    let cancelled = false;
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: false,
          status: 429,
          headers: { get: () => null },
          body: { cancel: async () => { cancelled = true; } },
        }) as unknown as Response,
    );
    await expect(generateCaption(ARTICLE, deps({ fetchFn }))).rejects.toThrow(
      /^llm write failed for article 1: HTTP 429$/,
    );
    expect(cancelled).toBe(true);
  });

  it('cancels the body when the declared content-length overflows (no leak)', async () => {
    let cancelled = false;
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => String(10 * 1024 * 1024) },
          body: { cancel: async () => { cancelled = true; } },
          arrayBuffer: async () => new TextEncoder().encode('x').buffer as ArrayBuffer,
          json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
        }) as unknown as Response,
    );
    await expect(generateCaption(ARTICLE, deps({ fetchFn, maxBytes: 16 }))).rejects.toThrow(
      /too large/,
    );
    expect(cancelled).toBe(true);
  });

  it('rejects a whitespace-bearing legacy URL before any network call (no LLM quota burn)', async () => {
    const fetchFn = vi.fn(async () => okResponse('unused'));
    const poison: LlmArticle = {
      ...ARTICLE,
      url: 'https://example.com/a\nFuente: IGN https://evil.com/phish',
    };
    await expect(generateCaption(poison, deps({ fetchFn }))).rejects.toThrow(
      /^llm write failed for article 1: invalid article: url contains/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
