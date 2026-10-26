import { describe, expect, it, vi } from 'vitest';
import {
  answerCallbackQuery,
  callTelegramMethod,
  editMessageMediaPhoto,
  editMessageReplyMarkup,
  editMessageText,
  getMe,
  getUpdates,
  isRateLimited,
  sanitizeTelegram,
  sendMessage,
  sendPhoto,
  TelegramApiError,
  TELEGRAM_API_BASE,
} from './api.js';

const TOKEN = 'test-token-abc';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
    json: async () => body,
  } as unknown as Response;
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    fetchFn: vi.fn(async () => jsonResponse({ ok: true, result: { message_id: 7 } })),
    token: TOKEN,
    ...overrides,
  };
}

describe('callTelegramMethod', () => {
  it('POSTs to bot<token>/<method> with redirect errors and an abort signal', async () => {
    const d = deps();
    await callTelegramMethod('getMe', {}, d, 'bot');
    expect(d.fetchFn).toHaveBeenCalledOnce();
    const [url, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${TELEGRAM_API_BASE}/bot${TOKEN}/getMe`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns the API result on ok:true', async () => {
    const d = deps();
    const result = await callTelegramMethod<{ message_id: number }>(
      'sendMessage',
      { chat_id: '1', text: 'hi' },
      d,
      'draft',
    );
    expect(result).toEqual({ message_id: 7 });
  });

  it('throws a typed error on HTTP failures without leaking the token', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => jsonResponse({ ok: false, description: 'bad' }, 500)),
    });
    const err = await callTelegramMethod('sendMessage', {}, d, 'draft 3').catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as Error).message).toBe('telegram sendMessage failed for draft 3: HTTP 500');
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as TelegramApiError).status).toBe(500);
  });

  it('extracts retry_after on HTTP 429 so callers can honour the backoff', async () => {
    const d = deps({
      fetchFn: vi.fn(async () =>
        jsonResponse(
          { ok: false, description: 'Too Many Requests', parameters: { retry_after: 30 } },
          429,
        ),
      ),
    });
    const err = await callTelegramMethod('sendMessage', {}, d, 'draft 3').catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as Error).message).toContain('HTTP 429 (retry after 30s)');
    expect(isRateLimited(err)).toBe(true);
    expect((err as TelegramApiError).retryAfterSec).toBe(30);
  });

  it('surfaces ok:false API errors with their description (and retry_after when present)', async () => {
    const d = deps({
      fetchFn: vi.fn(async () =>
        jsonResponse({
          ok: false,
          description: 'Too Many Requests: retry after 12',
          parameters: { retry_after: 12 },
        }),
      ),
    });
    const err = await callTelegramMethod('sendPhoto', {}, d, 'draft 3').catch((e) => e);
    expect((err as Error).message).toContain('Too Many Requests: retry after 12');
    expect(isRateLimited(err)).toBe(true);
  });

  it('redacts the token when the transport error echoes request details', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => {
        throw new TypeError(`fetch failed for ${TELEGRAM_API_BASE}/bot${TOKEN}/sendMessage`);
      }),
    });
    const err = await callTelegramMethod('sendMessage', {}, d, 'draft 3').catch((e) => e);
    expect((err as Error).message).toBe(
      'telegram sendMessage failed for draft 3: request failed: fetch failed for ' +
        `${TELEGRAM_API_BASE}/bot[redacted]/sendMessage`,
    );
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('throws a typed error on oversize bodies without hanging', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => String(2 * 1024 * 1024) },
        body: { cancel: async () => {} },
      })),
    });
    const err = await callTelegramMethod('getMe', {}, d, 'bot').catch((e) => e);
    expect((err as Error).message).toMatch(/response body too large/);
  });
});

describe('sanitizeTelegram', () => {
  it('redacts bot<token> occurrences and leaves other text alone', () => {
    expect(sanitizeTelegram(`url bot${TOKEN}/x and ${TOKEN} end`, TOKEN)).toBe(
      'url bot[redacted]/x and [redacted] end',
    );
    expect(sanitizeTelegram('nothing secret', TOKEN)).toBe('nothing secret');
  });
});

describe('method wrappers', () => {
  it('getMe resolves the bot identity', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => jsonResponse({ ok: true, result: { id: 1, username: 'mybot' } })),
    });
    await expect(getMe(d)).resolves.toEqual({ id: 1, username: 'mybot' });
  });

  it('sendMessage posts text without a parse_mode', async () => {
    const d = deps();
    await sendMessage({ chatId: '123', text: 'hola *mundo*' }, d);
    const [, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ chat_id: '123', text: 'hola *mundo*' });
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('sendPhoto posts the image URL (server-side fetch) with the caption', async () => {
    const d = deps();
    await sendPhoto({ chatId: '123', text: 'caption', photoUrl: 'https://img.example/x.jpg' }, d);
    const [url, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${TELEGRAM_API_BASE}/bot${TOKEN}/sendPhoto`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      chat_id: '123',
      photo: 'https://img.example/x.jpg',
      caption: 'caption',
    });
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('sendMessage throws a typed error when the result lacks a safe-integer message_id', async () => {
    for (const result of [{}, { message_id: undefined }, { message_id: '7' }, null, 'ok']) {
      const d = deps({
        fetchFn: vi.fn(async () => jsonResponse({ ok: true, result })),
      });
      const err = await sendMessage({ chatId: '123', text: 'hi' }, d, 'draft 3').catch((e) => e);
      expect(err).toBeInstanceOf(TelegramApiError);
      expect((err as Error).message).toMatch(
        /^telegram sendMessage failed for draft 3: unexpected response shape/,
      );
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });

  it('sendPhoto throws a typed error when the result lacks a safe-integer message_id', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => jsonResponse({ ok: true, result: { message_id: 7.5 } })),
    });
    const err = await sendPhoto(
      { chatId: '123', text: 'caption', photoUrl: 'https://img.example/x.jpg' },
      d,
      'draft 4',
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as Error).message).toMatch(
      /^telegram sendPhoto failed for draft 4: unexpected response shape/,
    );
  });

  it('getUpdates forwards offset/limit/timeout pagination', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => jsonResponse({ ok: true, result: [] })),
    });
    await getUpdates({ offset: 41, limit: 100, timeout: 30 }, d);
    const [, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toMatchObject({ offset: 41, limit: 100, timeout: 30 });
  });

  it('getUpdates throws a typed error when the result is not a list', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => jsonResponse({ ok: true, result: { update_id: 1 } })),
    });
    const err = await getUpdates({ limit: 100 }, d).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as Error).message).toMatch(/^telegram getUpdates failed for updates: /);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('answerCallbackQuery and editMessageReplyMarkup hit their methods', async () => {
    const d = deps();
    await answerCallbackQuery({ callbackQueryId: 'q1', text: 'ok ✓' }, d);
    await editMessageReplyMarkup(
      { chatId: '123', messageId: 9, replyMarkup: { inline_keyboard: [] } },
      d,
    );
    const calls = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe(`${TELEGRAM_API_BASE}/bot${TOKEN}/answerCallbackQuery`);
    expect(calls[1][0]).toBe(`${TELEGRAM_API_BASE}/bot${TOKEN}/editMessageReplyMarkup`);
  });
});

describe('editMessageText', () => {
  it('posts chat_id/message_id/text without a parse_mode', async () => {
    const d = deps();
    await editMessageText({ chatId: '123', messageId: 9, text: '✅ Imagen lista' }, d);
    const [url, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${TELEGRAM_API_BASE}/bot${TOKEN}/editMessageText`);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ chat_id: '123', message_id: 9, text: '✅ Imagen lista' });
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('throws a typed error without leaking the token', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => jsonResponse({ ok: false, description: 'bad' }, 400)),
    });
    const err = await editMessageText(
      { chatId: '123', messageId: 9, text: 'hi' },
      d,
      'draft 3',
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as Error).message).toMatch(/^telegram editMessageText failed for draft 3: /);
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

describe('editMessageMediaPhoto', () => {
  it('sends multipart form-data with attach://image media + file field (not JSON)', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => jsonResponse({ ok: true, result: { message_id: 44 } })),
    });
    await editMessageMediaPhoto(
      {
        chatId: '123',
        messageId: 44,
        caption: 'caption ✓',
        replyMarkup: {
          inline_keyboard: [[{ text: '✅ Publicado', callback_data: 'draft:1:posted' }]],
        },
        imageBytes: Buffer.from('fake-image-bytes'),
        filename: 'draft-1-x.png',
        contentType: 'image/png',
      },
      d,
      'draft 1',
    );
    const [url, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${TELEGRAM_API_BASE}/bot${TOKEN}/editMessageMedia`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Multipart: FormData body, no JSON Content-Type header.
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get('chat_id')).toBe('123');
    expect(form.get('message_id')).toBe('44');
    expect(JSON.parse(form.get('media') as string)).toMatchObject({
      type: 'photo',
      media: 'attach://image',
      caption: 'caption ✓',
    });
    expect(JSON.parse(form.get('reply_markup') as string)).toMatchObject({
      inline_keyboard: [[{ text: '✅ Publicado', callback_data: 'draft:1:posted' }]],
    });
    const file = form.get('image');
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe('image/png');
  });

  it('accepts an ok:true boolean result (editMessageMedia may return True)', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => jsonResponse({ ok: true, result: true })),
    });
    await expect(
      editMessageMediaPhoto(
        { chatId: '123', messageId: 44, caption: 'c', imageBytes: Buffer.from('x') },
        d,
        'draft 1',
      ),
    ).resolves.toBeUndefined();
  });

  it('throws a typed error when the result lacks a message_id', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => jsonResponse({ ok: true, result: { nope: 1 } })),
    });
    const err = await editMessageMediaPhoto(
      { chatId: '123', messageId: 44, caption: 'c', imageBytes: Buffer.from('x') },
      d,
      'draft 1',
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as Error).message).toMatch(
      /^telegram editMessageMedia failed for draft 1: unexpected response shape/,
    );
  });

  it('throws a typed error on HTTP failures with the token redacted', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => jsonResponse({ ok: false, description: 'bad' }, 400)),
    });
    const err = await editMessageMediaPhoto(
      { chatId: '123', messageId: 44, caption: 'c', imageBytes: Buffer.from('x') },
      d,
      'draft 1',
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as Error).message).toMatch(/^telegram editMessageMedia failed for draft 1: /);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('redacts the token when the transport error echoes request details', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => {
        throw new TypeError(`fetch failed for ${TELEGRAM_API_BASE}/bot${TOKEN}/editMessageMedia`);
      }),
    });
    const err = await editMessageMediaPhoto(
      { chatId: '123', messageId: 44, caption: 'c', imageBytes: Buffer.from('x') },
      d,
      'draft 1',
    ).catch((e) => e);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).toMatch(/^telegram editMessageMedia failed for draft 1: /);
  });

  it('throws a typed error on oversize bodies without hanging', async () => {
    const d = deps({
      fetchFn: vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => String(2 * 1024 * 1024) },
        body: { cancel: async () => {} },
      })),
    });
    const err = await editMessageMediaPhoto(
      { chatId: '123', messageId: 44, caption: 'c', imageBytes: Buffer.from('x') },
      d,
      'draft 1',
    ).catch((e) => e);
    expect((err as Error).message).toMatch(/response body too large/);
  });
});
