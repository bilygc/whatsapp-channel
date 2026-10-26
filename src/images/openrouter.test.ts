import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_IMAGE_MODEL,
  generateImage,
  IMAGE_ERROR_MESSAGE_CAP,
  IMAGE_ERROR_RAW_SNIPPET_CAP,
  IMAGE_MAX_BODY_BYTES,
  IMAGE_TIMEOUT_MS,
  isPolicyRefusal,
  isReferenceUnfetchable,
  OPENROUTER_IMAGES_URL,
  resolveImageConfig,
  ImageApiError,
} from './openrouter.js';

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

function okImageResponse(
  body: unknown = { data: [{ b64_json: PNG_B64, media_type: 'image/png' }] },
): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
    json: async () => body,
  } as unknown as Response;
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    fetchFn: vi.fn(async () => okImageResponse()),
    apiKey: 'test-image-key',
    model: DEFAULT_IMAGE_MODEL,
    ...overrides,
  };
}

function errorResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
    json: async () => body,
    body: { cancel: async () => {} },
  } as unknown as Response;
}

/**
 * Raw-text error body (HTML/WAF pages, proxy errors): `json()` throws, so a
 * test using this helper proves the error path reads the body as text first
 * and never depends on `res.json()`.
 */
function rawErrorResponse(status: number, rawText: string, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => new TextEncoder().encode(rawText).buffer as ArrayBuffer,
    json: async () => {
      throw new SyntaxError('Unexpected token in JSON');
    },
    body: { cancel: async () => {} },
  } as unknown as Response;
}

describe('resolveImageConfig', () => {
  it('defaults the model to the muse-image slug when IMAGE_MODEL is unset', () => {
    expect(resolveImageConfig({})).toEqual({ apiKey: undefined, model: DEFAULT_IMAGE_MODEL });
    expect(DEFAULT_IMAGE_MODEL).toBe('meta/muse-image');
  });

  it('reuses OPENROUTER_API_KEY and honours IMAGE_MODEL', () => {
    expect(
      resolveImageConfig({ OPENROUTER_API_KEY: 'k', IMAGE_MODEL: 'other/model' }),
    ).toEqual({ apiKey: 'k', model: 'other/model' });
  });

  it('treats blank env values as unset', () => {
    expect(resolveImageConfig({ OPENROUTER_API_KEY: '  ', IMAGE_MODEL: '' })).toEqual({
      apiKey: undefined,
      model: DEFAULT_IMAGE_MODEL,
    });
  });
});

describe('generateImage', () => {
  it('posts the minimal body to the images endpoint (never chat-API fields)', async () => {
    const d = deps();
    const image = await generateImage(
      { scope: 'draft 1', prompt: 'an exciting game cover', referenceUrl: 'https://img.example/x.jpg' },
      d,
    );
    expect(image.bytes).toEqual(Buffer.from('fake-png-bytes'));
    expect(image.extension).toBe('png');
    expect(image.referenceUsed).toBe(true);
    expect(d.fetchFn).toHaveBeenCalledOnce();
    const [url, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(OPENROUTER_IMAGES_URL);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-image-key');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: DEFAULT_IMAGE_MODEL,
      prompt: 'an exciting game cover',
      input_references: [{ type: 'image_url', image_url: { url: 'https://img.example/x.jpg' } }],
    });
    expect(body).not.toHaveProperty('messages');
    expect(body).not.toHaveProperty('modalities');
    expect(body).not.toHaveProperty('image_config');
  });

  it('omits input_references when no reference is given (text-only)', async () => {
    const d = deps();
    await generateImage({ scope: 'draft 1', prompt: 'a dark console' }, d);
    const [, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('input_references');
  });

  it('never sends a non-https reference (text-only instead of a doomed 400)', async () => {
    const d = deps();
    const image = await generateImage(
      { scope: 'draft 1', prompt: 'x', referenceUrl: 'http://insecure.example/x.jpg' },
      d,
    );
    expect(image.referenceUsed).toBe(false);
    const [, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('input_references');
  });

  it('uses a ≥5-minute abort budget (generations take 60–90s+)', async () => {
    expect(IMAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    const d = deps();
    await generateImage({ scope: 'draft 1', prompt: 'x' }, d);
    const [, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps media_type to a file extension (jpeg → jpg)', async () => {
    const d = deps({
      fetchFn: vi.fn(async () =>
        okImageResponse({ data: [{ b64_json: PNG_B64, media_type: 'image/jpeg' }] }),
      ),
    });
    const image = await generateImage({ scope: 'draft 1', prompt: 'x' }, d);
    expect(image.extension).toBe('jpg');
    expect(image.mediaType).toBe('image/jpeg');
  });

  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse(429, { error: { message: 'rate limited' } }, { 'retry-after': '7' }),
      )
      .mockResolvedValueOnce(okImageResponse());
    const image = await generateImage(
      { scope: 'draft 1', prompt: 'x' },
      deps({ fetchFn: fetchFn as typeof fetch, sleep }),
    );
    expect(image.bytes.length).toBeGreaterThan(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it('gives up after exhausting retries on persistent 429 (typed, retryable)', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi.fn(async () => errorResponse(429, { error: { message: 'slow down' } }));
    const err = await generateImage(
      { scope: 'draft 1', prompt: 'x' },
      deps({ fetchFn: fetchFn as typeof fetch, sleep }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ImageApiError);
    expect((err as Error).message).toMatch(/^images generate failed for draft 1: HTTP 429/);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('retries transient 502/524/529 then succeeds', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(502, { error: { message: 'bad gateway' } }))
      .mockResolvedValueOnce(errorResponse(524, { error: { message: 'timeout' } }))
      .mockResolvedValueOnce(okImageResponse());
    await generateImage(
      { scope: 'draft 1', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep }),
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('fails permanent on 403 content_policy_violation (never retries)', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi.fn(async () =>
      errorResponse(403, {
        error: { message: 'flagged', metadata: { error_type: 'content_policy_violation' } },
      }),
    );
    const err = await generateImage(
      { scope: 'draft 2', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ImageApiError);
    expect((err as Error).message).toMatch(/^images generate failed for draft 2: HTTP 403/);
    expect(isPolicyRefusal(err)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails permanent on 403 refusal type (never retries)', async () => {
    const fetchFn = vi.fn(async () =>
      errorResponse(403, {
        error: { message: 'refused', metadata: { error_type: 'refusal' } },
      }),
    );
    const err = await generateImage(
      { scope: 'draft 2', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} }),
    ).catch((e) => e);
    expect(isPolicyRefusal(err)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries ONCE text-only on 400 image_download_failed, then succeeds', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse(400, {
          error: { message: 'fetch failed', metadata: { error_type: 'image_download_failed' } },
        }),
      )
      .mockResolvedValueOnce(okImageResponse());
    const image = await generateImage(
      { scope: 'draft 3', prompt: 'x', referenceUrl: 'https://img.example/gone.jpg' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep }),
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    const secondBody = JSON.parse(
      (fetchFn.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(secondBody).not.toHaveProperty('input_references');
    expect(image.referenceUsed).toBe(false);
  });

  it('surfaces reference-unfetchable when the text-only retry also 400s', async () => {
    const fetchFn = vi.fn(async () =>
      errorResponse(400, {
        error: { message: 'fetch failed', metadata: { error_type: 'image_not_found' } },
      }),
    );
    const err = await generateImage(
      { scope: 'draft 3', prompt: 'x', referenceUrl: 'https://img.example/gone.jpg' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} }),
    ).catch((e) => e);
    expect(isReferenceUnfetchable(err)).toBe(true);
    // With-reference attempt + exactly one text-only retry.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry deterministic 400s without a reference error type', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi.fn(async () =>
      errorResponse(400, { error: { message: 'bad prompt' } }),
    );
    const err = await generateImage(
      { scope: 'draft 3', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep }),
    ).catch((e) => e);
    expect((err as Error).message).toMatch(/^images generate failed for draft 3: HTTP 400/);
    expect(isReferenceUnfetchable(err)).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry timeout exhaustion (single call, no sleep)', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout.', 'TimeoutError');
    });
    await expect(
      generateImage({ scope: 'draft 1', prompt: 'x' }, deps({ fetchFn: fetchFn as typeof fetch, sleep })),
    ).rejects.toThrow(/^images generate failed for draft 1: /);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails typed (never raw) on redirect rejection and dropped connections', async () => {
    const redirecting = vi.fn(async () => {
      throw new TypeError('fetch failed: unexpected redirect');
    });
    await expect(
      generateImage({ scope: 'draft 1', prompt: 'x' }, deps({ fetchFn: redirecting as typeof fetch })),
    ).rejects.toThrow(/^images generate failed for draft 1: .*redirect/);
    expect(redirecting).toHaveBeenCalledTimes(1);
  });

  it('retries a dropped connection then succeeds', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed: socket hang up'))
      .mockResolvedValueOnce(okImageResponse());
    await generateImage(
      { scope: 'draft 1', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep }),
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('fails typed on unexpected response shapes (no b64_json)', async () => {
    const fetchFn = vi.fn(async () => okImageResponse({ data: [] }));
    await expect(
      generateImage({ scope: 'draft 1', prompt: 'x' }, deps({ fetchFn: fetchFn as typeof fetch })),
    ).rejects.toThrow(/^images generate failed for draft 1: unexpected response shape/);
  });

  it('fails typed on oversize bodies without buffering them', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(IMAGE_MAX_BODY_BYTES + 1) },
      body: { cancel: async () => {} },
    }));
    await expect(
      generateImage(
        { scope: 'draft 1', prompt: 'x' },
        deps({ fetchFn: fetchFn as unknown as typeof fetch, maxBytes: 16 }),
      ),
    ).rejects.toThrow(/too large/);
  });

  it('fails typed before any network call on an empty prompt', async () => {
    const fetchFn = vi.fn(async () => okImageResponse());
    await expect(
      generateImage({ scope: 'draft 1', prompt: '   ' }, deps({ fetchFn: fetchFn as typeof fetch })),
    ).rejects.toThrow(/^images generate failed for draft 1: empty prompt/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('never leaks the API key into error messages', async () => {
    const key = 'super-secret-image-key';
    const failing = vi.fn(async () => {
      throw new Error(`boom ${key} exploded`);
    });
    const err = await generateImage(
      { scope: 'draft 1', prompt: 'x' },
      deps({ fetchFn: failing as unknown as typeof fetch, apiKey: key, sleep: async () => {} }),
    ).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(err).toMatch(/^images generate failed for draft 1: /);
    expect(err).not.toContain(key);
  });

  it('surfaces the API message and type verbatim, message first (phone truncates at ~180)', async () => {
    const fetchFn = vi.fn(async () =>
      errorResponse(400, {
        error: {
          message: 'prompt too long, please shorten it',
          code: 'E123',
          metadata: { error_type: 'invalid_request' },
        },
      }),
    );
    const err = await generateImage(
      { scope: 'draft 9', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ImageApiError);
    expect((err as Error).message).toBe(
      'images generate failed for draft 9: HTTP 400: "prompt too long, please shorten it" [type=invalid_request code=E123]',
    );
    // Message lands before the tokens: the meaningful part survives a phone-side cut.
    const msg = (err as Error).message;
    expect(msg.indexOf('"prompt too long')).toBeLessThan(msg.indexOf('[type='));
    expect(isReferenceUnfetchable(err)).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('truncates overlong API messages at 300 chars', async () => {
    expect(IMAGE_ERROR_MESSAGE_CAP).toBe(300);
    const long = `prefix ${'x'.repeat(500)}`;
    const fetchFn = vi.fn(async () =>
      errorResponse(400, { error: { message: long } }),
    );
    const err = await generateImage(
      { scope: 'draft 9', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} }),
    ).catch((e: Error) => e.message);
    // Collapsed message is capped at exactly 300 chars inside the quotes.
    expect(err).toContain(`"${`prefix ${'x'.repeat(293)}`}"`);
    expect(err).not.toContain('x'.repeat(301));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('stringifies numeric error codes', async () => {
    const fetchFn = vi.fn(async () =>
      errorResponse(400, {
        error: { message: 'nope', code: 429, metadata: { error_type: 'rate_limited' } },
      }),
    );
    const err = await generateImage(
      { scope: 'draft 9', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} }),
    ).catch((e: Error) => e.message);
    expect(err).toContain('HTTP 400: "nope" [type=rate_limited code=429]');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('dedupes a code that repeats the type token', async () => {
    const fetchFn = vi.fn(async () =>
      errorResponse(400, { error: { message: 'bad request body', code: 'bad_request' } }),
    );
    const err = await generateImage(
      { scope: 'draft 9', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} }),
    ).catch((e: Error) => e.message);
    // The type here is derived from the code itself — shown once, not twice.
    expect(err).toContain('HTTP 400: "bad request body" [type=bad_request]');
    expect(err).not.toContain('code=');
  });

  it('surfaces HTML/WAF bodies as a capped snippet instead of throwing', async () => {
    expect(IMAGE_ERROR_RAW_SNIPPET_CAP).toBe(200);
    const html = `<html>\n  <head><title>Access\n  Denied</title></head>\n  <body>${'x'.repeat(300)}</body>\n</html>`;
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi.fn(async () => rawErrorResponse(500, html));
    const err = await generateImage(
      { scope: 'draft 9', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep }),
    ).catch((e: Error) => e.message);
    // Classification unchanged: a 500 is still transient and retried to exhaustion.
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // Whitespace collapsed, capped at 200 chars, tagged — never a raw throw.
    const collapsed = html.replace(/\s+/g, ' ').trim().slice(0, IMAGE_ERROR_RAW_SNIPPET_CAP);
    expect(err).toContain(`HTTP 500: "${collapsed}" [unparseable body]`);
  });

  it('surfaces oversize error bodies without buffering them', async () => {
    const fetchFn = vi.fn(async () =>
      errorResponse(
        400,
        { error: { message: 'too big to read' } },
        { 'content-length': '999999' },
      ),
    );
    const err = await generateImage(
      { scope: 'draft 9', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {}, maxBytes: 16 }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ImageApiError);
    expect((err as Error).message).toContain(
      'HTTP 400 (response body too large (999999 bytes declared, limit 16))',
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps the reference-unfetchable retry shape with the API message first', async () => {
    const fetchFn = vi.fn(async () =>
      errorResponse(400, {
        error: {
          message: 'upstream rejected the reference pixels',
          metadata: { error_type: 'image_download_failed' },
        },
      }),
    );
    const err = await generateImage(
      { scope: 'draft 3', prompt: 'x', referenceUrl: 'https://img.example/gone.jpg' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} }),
    ).catch((e) => e);
    expect(isReferenceUnfetchable(err)).toBe(true);
    // With-reference attempt + exactly one text-only retry, then permanent.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect((err as Error).message).toBe(
      'images generate failed for draft 3: HTTP 400: "upstream rejected the reference pixels" [type=image_download_failed] (reference image unfetchable upstream)',
    );
  });

  it('keeps policy 403 no-retry with the API message first', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi.fn(async () =>
      errorResponse(403, {
        error: {
          message: 'violates policy: trademarked hero front and center',
          metadata: { error_type: 'content_policy_violation' },
        },
      }),
    );
    const err = await generateImage(
      { scope: 'draft 2', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep }),
    ).catch((e) => e);
    expect(isPolicyRefusal(err)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect((err as Error).message).toBe(
      'images generate failed for draft 2: HTTP 403: "violates policy: trademarked hero front and center" [type=content_policy_violation] (content policy refusal — not retrying)',
    );
  });

  it('keeps 429 backoff with the API message and retry-after suffix', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi.fn(async () =>
      errorResponse(
        429,
        { error: { message: 'slow down, generation queue full', code: 'rate_limited' } },
        { 'retry-after': '7' },
      ),
    );
    const err = await generateImage(
      { scope: 'draft 1', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ImageApiError);
    expect((err as ImageApiError).kind).toBe('retryable');
    expect((err as ImageApiError).retryAfterSec).toBe(7);
    // Still the 3-call backoff shape.
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect((err as Error).message).toBe(
      'images generate failed for draft 1: HTTP 429: "slow down, generation queue full" [type=rate_limited] (retry after 7s)',
    );
  });

  it('redacts the API key even when echoed inside the API error message', async () => {
    const key = 'super-secret-image-key';
    const fetchFn = vi.fn(async () =>
      errorResponse(401, { error: { message: `invalid key ${key} provided`, code: 'bad_key' } }),
    );
    const err = await generateImage(
      { scope: 'draft 1', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, apiKey: key, sleep: async () => {} }),
    ).catch((e: Error) => e.message);
    expect(err).toMatch(/^images generate failed for draft 1: HTTP 401: "/);
    expect(err).not.toContain(key);
    expect(err).toContain('[redacted]');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('generateImage content-filter policy classification', () => {
  it('classifies a 400 with the provider filter message as policy (live 400 shape)', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi.fn(async () =>
      errorResponse(400, {
        error: {
          message:
            'The response was filtered due to the prompt triggering our content management policy.',
          code: 400,
        },
      }),
    );
    const err = await generateImage(
      { scope: 'draft 48', prompt: 'x', referenceUrl: 'https://img.example/x.jpg' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ImageApiError);
    expect(isPolicyRefusal(err)).toBe(true);
    expect(isReferenceUnfetchable(err)).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect((err as Error).message).toBe(
      'images generate failed for draft 48: HTTP 400: "The response was filtered due to the prompt triggering our content management policy." [type=400] (content policy refusal — not retrying)',
    );
  });

  it('classifies a content_filter error type as policy at any status', async () => {
    const fetchFn = vi.fn(async () =>
      errorResponse(422, {
        error: { message: 'blocked by filter', metadata: { error_type: 'content_filter' } },
      }),
    );
    const err = await generateImage(
      { scope: 'draft 5', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ImageApiError);
    expect(isPolicyRefusal(err)).toBe(true);
    expect((err as ImageApiError).status).toBe(422);
    expect((err as Error).message).toContain('(content policy refusal — not retrying)');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('classifies "filtered because" phrasing as policy', async () => {
    const fetchFn = vi.fn(async () =>
      errorResponse(400, { error: { message: 'Request was filtered because of policy' } }),
    );
    const err = await generateImage(
      { scope: 'draft 6', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} }),
    ).catch((e) => e);
    expect(isPolicyRefusal(err)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps a generic 400 with incidental "policy" wording generic (no ladder trigger)', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchFn = vi.fn(async () =>
      errorResponse(400, { error: { message: 'invalid policy field: must be a string' } }),
    );
    const err = await generateImage(
      { scope: 'draft 7', prompt: 'x' },
      deps({ fetchFn: fetchFn as unknown as typeof fetch, sleep }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ImageApiError);
    expect(isPolicyRefusal(err)).toBe(false);
    expect(isReferenceUnfetchable(err)).toBe(false);
    expect((err as ImageApiError).kind).toBe('failed');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
