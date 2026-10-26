import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_IMAGE_MODEL,
  generateImage,
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
});
