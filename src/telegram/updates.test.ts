import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import type { TelegramUpdate } from './api.js';
import {
  applyStatusUpdate,
  parseCallbackData,
  pollOnce,
  processUpdate,
  runTelegramListen,
  type PollDeps,
} from './updates.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  return db;
}

function seedDraft(db: Database.Database, status = 'pending'): number {
  const url = `https://example.com/${Math.random().toString(36).slice(2)}`;
  const articleId = Number(
    db
      .prepare(
        `INSERT INTO articles (url_hash, title, source, url, published_at, status)
         VALUES (?, 'Title', 'IGN', ?, '2026-10-17T10:00:00.000Z', 'used')`,
      )
      .run(`hash-${url}`, url).lastInsertRowid,
  );
  return Number(
    db
      .prepare(`INSERT INTO drafts (article_id, caption_es, status) VALUES (?, ?, ?)`)
      .run(articleId, `caption ${url}`, status).lastInsertRowid,
  );
}

function okResult(result: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify({ ok: true, result })).buffer as ArrayBuffer,
    json: async () => ({ ok: true, result }),
  } as unknown as Response;
}

function callbackUpdate(
  updateId: number,
  opts: { data?: unknown; chatId?: number; queryId?: string; messageId?: number } = {},
): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: opts.queryId ?? `q${updateId}`,
      data: opts.data ?? 'draft:1:posted',
      message: { message_id: opts.messageId ?? 9, chat: { id: opts.chatId ?? 123 } },
    },
  };
}

function pollDeps(dbFetch: (url: string, init?: RequestInit) => Promise<Response>): PollDeps & {
  sleep: (ms: number) => Promise<void>;
} {
  return {
    fetchFn: dbFetch as typeof fetch,
    token: 'test-token',
    chatId: '123',
    now: () => new Date('2026-10-18T10:00:00.000Z'),
    pollSeconds: 0,
    sleep: async () => {},
    onEvent: () => {},
  };
}

describe('parseCallbackData', () => {
  it('accepts the exact draft:<id>:<posted|skipped> shape', () => {
    expect(parseCallbackData('draft:12:posted')).toEqual({ draftId: 12, action: 'posted' });
    expect(parseCallbackData('draft:7:skipped')).toEqual({ draftId: 7, action: 'skipped' });
  });

  it('rejects malformed, forged, and non-string payloads', () => {
    expect(parseCallbackData('draft:1:deleted')).toBeNull();
    expect(parseCallbackData('draft:1:posted:extra')).toBeNull();
    expect(parseCallbackData('draft::posted')).toBeNull();
    expect(parseCallbackData('draft:0:posted')).toBeNull();
    expect(parseCallbackData('draft:-5:posted')).toBeNull();
    expect(parseCallbackData('draft:1.5:posted')).toBeNull();
    expect(parseCallbackData('draft:99999999999999999999:posted')).toBeNull();
    expect(parseCallbackData('draft:1:POSTED')).toBeNull();
    expect(parseCallbackData(' draft:1:posted')).toBeNull();
    expect(parseCallbackData('')).toBeNull();
    expect(parseCallbackData(undefined)).toBeNull();
    expect(parseCallbackData(null)).toBeNull();
    expect(parseCallbackData(42)).toBeNull();
    expect(parseCallbackData({})).toBeNull();
  });
});

describe('applyStatusUpdate', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
  });

  it('marks posted with a posted_at timestamp', () => {
    const db = openTestDb();
    dbs.push(db);
    const id = seedDraft(db);
    expect(
      applyStatusUpdate(db, id, 'posted', () => new Date('2026-10-18T10:00:00.000Z')),
    ).toEqual({ note: 'applied' });
    expect(db.prepare('SELECT status, posted_at, views FROM drafts WHERE id = ?').get(id)).toEqual({
      status: 'posted',
      posted_at: '2026-10-18T10:00:00.000Z',
      views: null,
    });
  });

  it('marks skipped WITHOUT a posted_at timestamp', () => {
    const db = openTestDb();
    dbs.push(db);
    const id = seedDraft(db);
    expect(
      applyStatusUpdate(db, id, 'skipped', () => new Date('2026-10-18T10:00:00.000Z')),
    ).toEqual({ note: 'applied' });
    expect(db.prepare('SELECT status, posted_at FROM drafts WHERE id = ?').get(id)).toEqual({
      status: 'skipped',
      posted_at: null,
    });
  });

  it('reports unknown for missing drafts', () => {
    const db = openTestDb();
    dbs.push(db);
    expect(applyStatusUpdate(db, 999, 'posted', () => new Date())).toEqual({ note: 'unknown' });
  });

  it('is a no-op for already-acted drafts (duplicate callbacks)', () => {
    const db = openTestDb();
    dbs.push(db);
    const id = seedDraft(db, 'posted');
    db.prepare('UPDATE drafts SET posted_at = ? WHERE id = ?').run('2026-10-18T09:00:00.000Z', id);
    expect(applyStatusUpdate(db, id, 'skipped', () => new Date())).toEqual({ note: 'already' });
    // The duplicate press must not flip the earlier decision.
    expect(db.prepare('SELECT status, posted_at FROM drafts WHERE id = ?').get(id)).toEqual({
      status: 'posted',
      posted_at: '2026-10-18T09:00:00.000Z',
    });
  });

  it('throws a typed error on SQLite failures, never a raw one', () => {
    const db = openTestDb();
    dbs.push(db);
    db.exec('DROP TABLE drafts');
    expect(() => applyStatusUpdate(db, 1, 'posted', () => new Date())).toThrow(
      /^telegram status update failed for draft 1: /,
    );
  });
});

describe('processUpdate', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
    vi.restoreAllMocks();
  });

  /** Fetch double answering answer/edit calls; records method names. */
  function botFetch(methods: string[] = []) {
    return vi.fn(async (url: string) => {
      const method = String(url).split('/').pop() ?? '';
      methods.push(method);
      return okResult(true);
    });
  }

  it('applies a valid press, answers the callback, and strips the buttons', async () => {
    const db = openTestDb();
    dbs.push(db);
    const id = seedDraft(db);
    const methods: string[] = [];
    const deps = {
      ...pollDeps(botFetch(methods) as (url: string) => Promise<Response>),
    };
    const outcome = await processUpdate(
      db,
      deps,
      callbackUpdate(10, { data: `draft:${id}:posted` }),
    );
    expect(outcome).toBe('applied');
    expect((db.prepare('SELECT status FROM drafts WHERE id = ?').get(id) as { status: string }).status).toBe('posted');
    expect(methods).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
  });

  it('ignores updates from foreign chats WITHOUT answering or touching the DB', async () => {
    const db = openTestDb();
    dbs.push(db);
    const id = seedDraft(db);
    const events: string[] = [];
    const methods: string[] = [];
    const deps = {
      ...pollDeps(botFetch(methods) as (url: string) => Promise<Response>),
      onEvent: (m: string) => events.push(m),
    };
    const outcome = await processUpdate(
      db,
      deps,
      callbackUpdate(11, { data: `draft:${id}:posted`, chatId: 666 }),
    );
    expect(outcome).toBe('foreign');
    expect(methods).toEqual([]);
    expect((db.prepare('SELECT status FROM drafts WHERE id = ?').get(id) as { status: string }).status).toBe('pending');
    expect(events.length).toBe(1);
  });

  it('answers malformed payloads and duplicate presses without DB changes', async () => {
    const db = openTestDb();
    dbs.push(db);
    const id = seedDraft(db, 'skipped');
    const methods: string[] = [];
    const deps = { ...pollDeps(botFetch(methods) as (url: string) => Promise<Response>) };
    expect(await processUpdate(db, deps, callbackUpdate(12, { data: 'draft:1:delete' }))).toBe(
      'invalid',
    );
    expect(await processUpdate(db, deps, callbackUpdate(13, { data: `draft:${id}:posted` }))).toBe(
      'already',
    );
    expect(methods).toEqual(['answerCallbackQuery', 'answerCallbackQuery']);
  });

  it('answers unknown drafts without crashing', async () => {
    const db = openTestDb();
    dbs.push(db);
    const methods: string[] = [];
    const deps = { ...pollDeps(botFetch(methods) as (url: string) => Promise<Response>) };
    expect(await processUpdate(db, deps, callbackUpdate(14, { data: 'draft:999:posted' }))).toBe(
      'unknown',
    );
    expect(methods).toEqual(['answerCallbackQuery']);
  });

  it('ignores non-callback updates', async () => {
    const db = openTestDb();
    dbs.push(db);
    const deps = pollDeps(botFetch() as (url: string) => Promise<Response>);
    expect(await processUpdate(db, deps, { update_id: 15 })).toBe('ignored');
  });

  it('survives a failing answer call (loop must not crash)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const id = seedDraft(db);
    const events: string[] = [];
    const deps = {
      ...pollDeps((async () => {
        throw new TypeError('socket hang up');
      }) as typeof fetch),
      onEvent: (m: string) => events.push(m),
    };
    // The DB update happens before the answer, so state still advances.
    const outcome = await processUpdate(db, deps, callbackUpdate(16, { data: `draft:${id}:posted` }));
    expect(outcome).toBe('applied');
    expect((db.prepare('SELECT status FROM drafts WHERE id = ?').get(id) as { status: string }).status).toBe('posted');
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('pollOnce / runTelegramListen', () => {
  let dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs = [];
  });

  it('advances the offset past processed updates (bounded long-poll page)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const id = seedDraft(db);
    const fetchFn = vi.fn(async () =>
      okResult([
        callbackUpdate(40, { data: `draft:${id}:skipped` }),
        { update_id: 41 },
      ]),
    );
    const next = await pollOnce(db, pollDeps(fetchFn as typeof fetch), 40);
    expect(next).toBe(42);
    expect((db.prepare('SELECT status FROM drafts WHERE id = ?').get(id) as { status: string }).status).toBe('skipped');
    // Pagination is forwarded to getUpdates.
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      offset: 40,
      limit: 100,
      timeout: 0,
      allowed_updates: ['callback_query', 'message'],
    });
  });

  it('keeps the offset when a poll returns no updates', async () => {
    const db = openTestDb();
    dbs.push(db);
    const fetchFn = vi.fn(async () => okResult([]));
    await expect(pollOnce(db, pollDeps(fetchFn as typeof fetch), 40)).resolves.toBe(40);
  });

  it('propagates getUpdates transport failures as typed errors (loop catches them)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: async () => ({ ok: false, description: 'boom' }),
      arrayBuffer: async () => new TextEncoder().encode('{"ok":false}').buffer as ArrayBuffer,
      body: { cancel: async () => {} },
    }));
    await expect(pollOnce(db, pollDeps(fetchFn as unknown as typeof fetch))).rejects.toThrow(
      /^telegram getUpdates failed for updates: /,
    );
  });

  it('runs a bounded loop, surviving failed ticks and honouring shouldStop', async () => {
    const db = openTestDb();
    dbs.push(db);
    const events: string[] = [];
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('socket hang up');
      return okResult([]);
    });
    const result = await runTelegramListen(db, {
      ...pollDeps(fetchFn as typeof fetch),
      onEvent: (m: string) => events.push(m),
      maxTicks: 3,
      retryDelayMs: 0,
    });
    expect(result).toEqual({ ticks: 3 });
    expect(calls).toBe(3);
    expect(events.length).toBe(1);
    expect(events[0]).toMatch(/^telegram listen: /);
    expect(events[0]).not.toContain('test-token');
  });

  it('skips elements without a safe-integer update_id without poisoning the offset', async () => {
    const db = openTestDb();
    dbs.push(db);
    const idA = seedDraft(db);
    const idB = seedDraft(db);
    const events: string[] = [];
    const answerFetch = vi.fn(async (_url: string, _init?: RequestInit) => okResult(true));
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResult([
        callbackUpdate(60, { data: `draft:${idA}:posted` }),
        { note: 'garbage without update_id' },
        { update_id: 'abc', callback_query: { id: 'q', data: 'draft:1:posted' } },
        { update_id: 61.5, callback_query: { id: 'q', data: 'draft:1:posted' } },
        null,
        callbackUpdate(62, { data: `draft:${idB}:skipped` }),
      ]),
    );
    // Answer/edit calls go through the same fetch double in these deps, so
    // route per-method: updates for getUpdates, ok for the rest.
    const router = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/getUpdates')) return fetchFn(url, init);
      return answerFetch(url, init);
    });
    const deps = {
      ...pollDeps(router as typeof fetch),
      onEvent: (m: string) => events.push(m),
    };
    const next = await pollOnce(db, deps, 60);
    // Offset advances past the valid elements only — never NaN.
    expect(next).toBe(63);
    expect(Number.isSafeInteger(next)).toBe(true);
    // Both valid elements were still processed around the garbage.
    expect((db.prepare('SELECT status FROM drafts WHERE id = ?').get(idA) as { status: string }).status).toBe('posted');
    expect((db.prepare('SELECT status FROM drafts WHERE id = ?').get(idB) as { status: string }).status).toBe('skipped');
    // Every malformed element was logged-and-skipped (4 bad elements).
    const idNotes = events.filter((m) => /update_id/.test(m));
    expect(idNotes).toHaveLength(4);
    // The returned offset serializes as a JSON number on the next tick
    // (NaN would serialize to null and corrupt pagination).
    const fetchFn2 = vi.fn(async () => okResult([]));
    await pollOnce(db, pollDeps(fetchFn2 as typeof fetch), next);
    const [, init2] = (fetchFn2 as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init2.body as string)).toMatchObject({ offset: 63 });
  });
});

describe('processUpdate /img replies (manual image generation)', () => {
  let dbs: Database.Database[] = [];
  let tmpDirs: string[] = [];
  afterEach(async () => {
    for (const db of dbs) db.close();
    dbs = [];
    for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true });
    tmpDirs = [];
    vi.restoreAllMocks();
  });

  async function tmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-listen-'));
    tmpDirs.push(dir);
    return dir;
  }

  /** Seed a draft stamped as sent with a Telegram message id. */
  function seedImageDraft(
    db: Database.Database,
    opts: { messageId?: number; caption?: string; imageUrl?: string | null } = {},
  ): number {
    const url = `https://example.com/${Math.random().toString(36).slice(2)}`;
    const articleId = Number(
      db
        .prepare(
          `INSERT INTO articles (url_hash, title, source, url, image_url, published_at, status)
           VALUES (?, 'Retro game news', 'IGN', ?, ?, '2026-10-17T10:00:00.000Z', 'used')`,
        )
        .run(`hash-${url}`, url, opts.imageUrl ?? 'https://img.example/news.jpg').lastInsertRowid,
    );
    const id = Number(
      db
        .prepare(`INSERT INTO drafts (article_id, caption_es, status) VALUES (?, ?, 'pending')`)
        .run(articleId, opts.caption ?? `🔥 Notición\n\nFuente: IGN ${url}`).lastInsertRowid,
    );
    db.prepare(
      `UPDATE drafts SET last_sent_at = ?, telegram_message_id = ? WHERE id = ?`,
    ).run('2026-10-19T08:55:00.000Z', opts.messageId ?? 440, id);
    return id;
  }

  function messageUpdate(
    updateId: number,
    opts: { text?: unknown; chatId?: number; messageId?: number; replyTo?: number } = {},
  ): TelegramUpdate {
    return {
      update_id: updateId,
      message: {
        message_id: opts.messageId ?? 777,
        chat: { id: opts.chatId ?? 123 },
        ...(opts.text !== undefined ? { text: opts.text } : {}),
        ...(opts.replyTo !== undefined ? { reply_to_message: { message_id: opts.replyTo } } : {}),
      },
    };
  }

  /**
   * Telegram fetch double routing per method: sendMessage/edit calls return
   * usable shapes; getUpdates is overridden per test. Records method names
   * and parsed JSON bodies (FormData for editMessageMedia is captured raw).
   */
  function telegramFetch(
    methods: string[],
    bodies: Array<{ method: string; json?: unknown; form?: FormData }>,
    overrides: { getUpdatesResult?: unknown; nextMessageId?: () => number } = {},
  ) {
    let sent = 1000;
    return vi.fn(async (url: string, init?: RequestInit) => {
      const method = String(url).split('/').pop() ?? '';
      methods.push(method);
      if (method === 'getUpdates') {
        return okResult(overrides.getUpdatesResult ?? []);
      }
      if (method === 'sendMessage') {
        sent += 1;
        bodies.push({ method, json: JSON.parse(init?.body as string) });
        return okResult({ message_id: overrides.nextMessageId ? overrides.nextMessageId() : sent });
      }
      if (init?.body instanceof FormData) {
        bodies.push({ method, form: init.body });
        return okResult({ message_id: 440 });
      }
      bodies.push({ method, json: init?.body ? JSON.parse(init.body as string) : undefined });
      return okResult(true);
    });
  }

  /** runImage stub backed by a real temp file (the listener re-reads bytes from disk). */
  async function stubImageFile(dir: string, name = 'draft-1-x.png'): Promise<string> {
    const file = path.join(dir, name);
    await fs.writeFile(file, 'fake-image-bytes');
    return file;
  }

  it('swaps the photo on /img, keeping caption + buttons, and marks the status done', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    const id = seedImageDraft(db, { messageId: 440 });
    const imageFile = await stubImageFile(dir);
    const methods: string[] = [];
    const bodies: Array<{ method: string; json?: unknown; form?: FormData }> = [];
    const runImage = vi.fn(async () => ({ path: imageFile }));
    const events: string[] = [];
    const deps = {
      ...pollDeps(telegramFetch(methods, bodies) as unknown as typeof fetch),
      imageApiKey: 'img-key',
      runImage: runImage as PollDeps['runImage'],
      onEvent: (m: string) => events.push(m),
    };

    const outcome = await processUpdate(db, deps, messageUpdate(50, { text: '/img', replyTo: 440 }));

    expect(outcome).toBe('image');
    expect(runImage).toHaveBeenCalledOnce();
    expect((runImage.mock.calls as unknown[][])[0][1]).toBe(id);
    // Status line posted first, photo swapped, status edited to done.
    expect(methods).toEqual(['sendMessage', 'editMessageMedia', 'editMessageText']);
    const statusPost = bodies[0].json as Record<string, unknown>;
    expect(statusPost).toMatchObject({ chat_id: '123', text: '🎨 Generando imagen…' });
    const form = bodies[1].form as FormData;
    expect(form.get('message_id')).toBe('440');
    const media = JSON.parse(form.get('media') as string) as Record<string, unknown>;
    expect(media).toMatchObject({ type: 'photo', media: 'attach://image' });
    expect(media.caption as string).toContain('Fuente: IGN https://example.com/');
    const keyboard = JSON.parse(form.get('reply_markup') as string) as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    expect(keyboard.inline_keyboard[0][0].callback_data).toBe(`draft:${id}:posted`);
    expect(keyboard.inline_keyboard[0][1].callback_data).toBe(`draft:${id}:skipped`);
    expect(bodies[2].json).toMatchObject({ text: '✅ Imagen lista' });
    expect(events).toEqual([]);
  });

  it('requires the EXACT /img text (prose and suffixed commands are ignored)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedImageDraft(db, { messageId: 440 });
    const methods: string[] = [];
    const bodies: Array<{ method: string; json?: unknown; form?: FormData }> = [];
    const runImage = vi.fn(async () => ({ path: 'x' }));
    const deps = {
      ...pollDeps(telegramFetch(methods, bodies) as unknown as typeof fetch),
      imageApiKey: 'img-key',
      runImage: runImage as PollDeps['runImage'],
    };
    for (const text of ['/img please', 'generate /img', 'IMG', '/img@otherbot', '']) {
      expect(await processUpdate(db, deps, messageUpdate(51, { text, replyTo: 440 }))).toBe(
        'ignored',
      );
    }
    expect(runImage).not.toHaveBeenCalled();
    expect(methods).toEqual([]);
  });

  it('ignores a bare /img with no reply target (never guesses a draft)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedImageDraft(db, { messageId: 440 });
    const methods: string[] = [];
    const runImage = vi.fn(async () => ({ path: 'x' }));
    const deps = {
      ...pollDeps(telegramFetch(methods, []) as unknown as typeof fetch),
      imageApiKey: 'img-key',
      runImage: runImage as PollDeps['runImage'],
    };
    expect(await processUpdate(db, deps, messageUpdate(52, { text: '/img' }))).toBe('ignored');
    expect(await processUpdate(db, deps, messageUpdate(53, { text: '  /img  ' }))).toBe('ignored');
    expect(runImage).not.toHaveBeenCalled();
    expect(methods).toEqual([]);
  });

  it('ignores /img from foreign chats without answering or generating', async () => {
    const db = openTestDb();
    dbs.push(db);
    const id = seedImageDraft(db, { messageId: 440 });
    const events: string[] = [];
    const methods: string[] = [];
    const runImage = vi.fn(async () => ({ path: 'x' }));
    const deps = {
      ...pollDeps(telegramFetch(methods, []) as unknown as typeof fetch),
      imageApiKey: 'img-key',
      runImage: runImage as PollDeps['runImage'],
      onEvent: (m: string) => events.push(m),
    };
    const outcome = await processUpdate(
      db,
      deps,
      messageUpdate(54, { text: '/img', replyTo: 440, chatId: 666 }),
    );
    expect(outcome).toBe('foreign');
    expect(runImage).not.toHaveBeenCalled();
    expect(methods).toEqual([]);
    expect(events.length).toBe(1);
    expect(
      (db.prepare('SELECT generated_image_path FROM drafts WHERE id = ?').get(id) as {
        generated_image_path: string | null;
      }).generated_image_path,
    ).toBeNull();
  });

  it('logs unknown when no draft matches the reply target (NULL message ids included)', async () => {
    const db = openTestDb();
    dbs.push(db);
    // Tracking-degraded draft: sent but without a message id — can never match.
    const url = `https://example.com/${Math.random().toString(36).slice(2)}`;
    const articleId = Number(
      db
        .prepare(
          `INSERT INTO articles (url_hash, title, source, url, published_at, status)
           VALUES (?, 'T', 'IGN', ?, '2026-10-17T10:00:00.000Z', 'used')`,
        )
        .run(`hash-${url}`, url).lastInsertRowid,
    );
    db.prepare(`INSERT INTO drafts (article_id, caption_es, status) VALUES (?, 'c', 'pending')`).run(
      articleId,
    );
    const events: string[] = [];
    const methods: string[] = [];
    const runImage = vi.fn(async () => ({ path: 'x' }));
    const deps = {
      ...pollDeps(telegramFetch(methods, []) as unknown as typeof fetch),
      imageApiKey: 'img-key',
      runImage: runImage as PollDeps['runImage'],
      onEvent: (m: string) => events.push(m),
    };
    expect(await processUpdate(db, deps, messageUpdate(55, { text: '/img', replyTo: 9999 }))).toBe(
      'unknown',
    );
    expect(runImage).not.toHaveBeenCalled();
    expect(methods).toEqual([]);
    expect(events.length).toBe(1);
  });

  it('edits the status to a short reason when generation fails (draft untouched, loop continues)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const id = seedImageDraft(db, { messageId: 440 });
    const methods: string[] = [];
    const bodies: Array<{ method: string; json?: unknown; form?: FormData }> = [];
    const events: string[] = [];
    const runImage = vi.fn(async () => {
      throw new Error('images generate failed for draft 1: HTTP 500');
    });
    const deps = {
      ...pollDeps(telegramFetch(methods, bodies) as unknown as typeof fetch),
      imageApiKey: 'img-key',
      runImage: runImage as PollDeps['runImage'],
      onEvent: (m: string) => events.push(m),
    };
    const outcome = await processUpdate(db, deps, messageUpdate(56, { text: '/img', replyTo: 440 }));
    expect(outcome).toBe('image-error');
    // Status posted, no photo swap, status edited to the failure reason.
    expect(methods).toEqual(['sendMessage', 'editMessageText']);
    expect((bodies[1].json as Record<string, unknown>).text as string).toMatch(/^❌/);
    expect(events.length).toBe(1);
    expect(
      (db.prepare('SELECT generated_image_path FROM drafts WHERE id = ?').get(id) as {
        generated_image_path: string | null;
      }).generated_image_path,
    ).toBeNull();
  });

  it('never leaks the image key or bot token into the phone status text', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedImageDraft(db, { messageId: 440 });
    const bodies: Array<{ method: string; json?: unknown; form?: FormData }> = [];
    const runImage = vi.fn(async () => {
      throw new Error('images generate failed: boom super-secret-img-key for botTOKEN123/x');
    });
    const deps = {
      ...pollDeps(telegramFetch([], bodies) as unknown as typeof fetch),
      token: 'TOKEN123',
      imageApiKey: 'super-secret-img-key',
      runImage: runImage as PollDeps['runImage'],
    };
    await processUpdate(
      db,
      deps,
      messageUpdate(57, { text: '/img', replyTo: 440 }),
    );
    const statusText = (bodies[1].json as Record<string, unknown>).text as string;
    expect(statusText).not.toContain('super-secret-img-key');
    expect(statusText).not.toContain('TOKEN123');
  });

  it('fails gracefully when image generation is not configured (no key, no seam)', async () => {
    const db = openTestDb();
    dbs.push(db);
    seedImageDraft(db, { messageId: 440 });
    const methods: string[] = [];
    const bodies: Array<{ method: string; json?: unknown; form?: FormData }> = [];
    const events: string[] = [];
    const deps = {
      ...pollDeps(telegramFetch(methods, bodies) as unknown as typeof fetch),
      imageApiKey: undefined,
      runImage: undefined,
      onEvent: (m: string) => events.push(m),
    };
    expect(await processUpdate(db, deps, messageUpdate(58, { text: '/img', replyTo: 440 }))).toBe(
      'image-error',
    );
    expect(methods).toEqual(['sendMessage', 'editMessageText']);
    expect((bodies[1].json as Record<string, unknown>).text as string).toContain('OPENROUTER_API_KEY');
    expect(events.length).toBe(1);
  });

  it('never ships a linkless caption: fit failures skip the photo swap', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    // Attribution-less overlong caption: fitCaptionForTelegram takes the typed-skip path.
    seedImageDraft(db, { messageId: 440, caption: 'no attribution here ' + 'x'.repeat(2000) });
    const imageFile = await stubImageFile(dir);
    const methods: string[] = [];
    const bodies: Array<{ method: string; json?: unknown; form?: FormData }> = [];
    const runImage = vi.fn(async () => ({ path: imageFile }));
    const deps = {
      ...pollDeps(telegramFetch(methods, bodies) as unknown as typeof fetch),
      imageApiKey: 'img-key',
      runImage: runImage as PollDeps['runImage'],
    };
    expect(await processUpdate(db, deps, messageUpdate(59, { text: '/img', replyTo: 440 }))).toBe(
      'image-error',
    );
    expect(methods).toEqual(['sendMessage', 'editMessageText']);
    expect(methods).not.toContain('editMessageMedia');
  });

  it('still succeeds when the done-edit fails (photo swap already live)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    seedImageDraft(db, { messageId: 440 });
    const imageFile = await stubImageFile(dir);
    const events: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const method = String(url).split('/').pop() ?? '';
      if (method === 'sendMessage') return okResult({ message_id: 1001 });
      if (init?.body instanceof FormData) return okResult({ message_id: 440 });
      if (method === 'editMessageText') {
        throw new TypeError('socket hang up');
      }
      return okResult(true);
    });
    const deps = {
      ...pollDeps(fetchFn as unknown as typeof fetch),
      imageApiKey: 'img-key',
      runImage: (async () => ({ path: imageFile })) as PollDeps['runImage'],
      onEvent: (m: string) => events.push(m),
    };
    expect(await processUpdate(db, deps, messageUpdate(60, { text: '/img', replyTo: 440 }))).toBe(
      'image',
    );
    expect(events.length).toBe(1);
  });

  it('pollOnce advances the offset past /img updates and requests message updates', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    seedImageDraft(db, { messageId: 440 });
    const imageFile = await stubImageFile(dir);
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const method = String(url).split('/').pop() ?? '';
      if (method === 'getUpdates') {
        const params = JSON.parse(init?.body as string) as Record<string, unknown>;
        expect(params).toMatchObject({ allowed_updates: ['callback_query', 'message'] });
        return okResult([messageUpdate(70, { text: '/img', replyTo: 440 })]);
      }
      if (method === 'sendMessage') return okResult({ message_id: 1001 });
      if (init?.body instanceof FormData) return okResult({ message_id: 440 });
      return okResult(true);
    });
    const next = await pollOnce(
      db,
      {
        ...pollDeps(fetchFn as unknown as typeof fetch),
        imageApiKey: 'img-key',
        runImage: (async () => ({ path: imageFile })) as PollDeps['runImage'],
      },
      70,
    );
    // Offset advances past the processed /img even though generation is slow.
    expect(next).toBe(71);
  });

  it('survives a failing /img tick and keeps listening (log-and-continue)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const events: string[] = [];
    let calls = 0;
    const fetchFn = vi.fn(async (url: string) => {
      const method = String(url).split('/').pop() ?? '';
      if (method === 'getUpdates') {
        calls += 1;
        if (calls === 1) {
          return okResult([messageUpdate(80, { text: '/img', replyTo: 440 })]);
        }
        return okResult([]);
      }
      if (method === 'sendMessage') return okResult({ message_id: 1001 });
      if (method === 'editMessageText') return okResult(true);
      return okResult(true);
    });
    const runImage = vi.fn(async () => {
      throw new Error('images generate failed for draft 1: HTTP 500');
    });
    const result = await runTelegramListen(db, {
      ...pollDeps(fetchFn as unknown as typeof fetch),
      imageApiKey: 'img-key',
      runImage: runImage as PollDeps['runImage'],
      onEvent: (m: string) => events.push(m),
      maxTicks: 2,
      retryDelayMs: 0,
    });
    expect(result).toEqual({ ticks: 2 });
    expect(calls).toBe(2);
    expect(events.length).toBeGreaterThan(0);
  });
});
