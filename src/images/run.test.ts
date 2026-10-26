import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { ImageApiError } from './openrouter.js';
import { generateImageForDraft } from './run.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  return db;
}

/** Seed one article + draft; returns the draft id. */
function seedDraft(
  db: Database.Database,
  opts: { imageUrl?: string | null; caption?: string; title?: string } = {},
): number {
  const url = `https://example.com/${Math.random().toString(36).slice(2)}`;
  const articleId = Number(
    db
      .prepare(
        `INSERT INTO articles (url_hash, title, source, url, image_url, published_at, status)
         VALUES (?, ?, 'IGN', ?, ?, '2026-10-17T10:00:00.000Z', 'used')`,
      )
      .run(
        `hash-${url}`,
        opts.title ?? 'Retro game collection announced',
        url,
        'imageUrl' in opts ? opts.imageUrl : 'https://img.example/news.jpg',
      ).lastInsertRowid,
  );
  return Number(
    db
      .prepare(`INSERT INTO drafts (article_id, caption_es, status) VALUES (?, ?, 'pending')`)
      .run(articleId, opts.caption ?? `🔥 Notición\n\nFuente: IGN ${url}`).lastInsertRowid,
  );
}

function okGenerate(extension = 'png') {
  return vi.fn(async () => ({
    bytes: Buffer.from('fake-image-bytes'),
    mediaType: extension === 'jpg' ? 'image/jpeg' : 'image/png',
    extension,
    referenceUsed: true,
  }));
}

describe('generateImageForDraft', () => {
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-img-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('saves bytes to disk and stamps generated_image_path (overwrites on regeneration)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    const id = seedDraft(db);
    const generateFn = okGenerate();

    const first = await generateImageForDraft(db, id, {
      fetchFn: (async () => {
        throw new Error('must not hit network with generateFn seam');
      }) as typeof fetch,
      apiKey: 'k',
      model: 'meta/muse-image',
      imagesDir: dir,
      now: () => new Date('2026-10-26T12:00:00.000Z'),
      generateFn: generateFn as never,
    });

    expect(first.draftId).toBe(id);
    expect(first.path).toContain(`draft-${id}-`);
    expect(first.path.endsWith('.png')).toBe(true);
    const stored = (
      db.prepare('SELECT generated_image_path FROM drafts WHERE id = ?').get(id) as {
        generated_image_path: string;
      }
    ).generated_image_path;
    expect(stored).toBe(first.path);
    expect((await fs.readFile(first.path)).toString()).toBe('fake-image-bytes');

    // Regeneration overwrites the path (same row, new file).
    const second = await generateImageForDraft(db, id, {
      fetchFn: (async () => {
        throw new Error('must not hit network');
      }) as typeof fetch,
      apiKey: 'k',
      model: 'meta/muse-image',
      imagesDir: dir,
      now: () => new Date('2026-10-26T12:05:00.000Z'),
      generateFn: generateFn as never,
    });
    expect(second.path).not.toBe(first.path);
    expect(
      (db.prepare('SELECT generated_image_path FROM drafts WHERE id = ?').get(id) as {
        generated_image_path: string;
      }).generated_image_path,
    ).toBe(second.path);
  });

  it('sends the article reference URL and builds an English prompt from title + caption', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    const id = seedDraft(db, { title: 'Elden Ring DLC announced' });
    const generateFn = okGenerate();

    await generateImageForDraft(db, id, {
      fetchFn: (async () => {
        throw new Error('no network');
      }) as typeof fetch,
      apiKey: 'k',
      model: 'meta/muse-image',
      imagesDir: dir,
      generateFn: generateFn as never,
    });

    expect(generateFn).toHaveBeenCalledOnce();
    const [request] = generateFn.mock.calls[0] as unknown as [
      { scope: string; prompt: string; referenceUrl?: string },
    ];
    expect(request.scope).toBe(`draft ${id}`);
    expect(request.referenceUrl).toBe('https://img.example/news.jpg');
    expect(request.prompt).toContain('Elden Ring DLC announced');
  });

  it('goes text-only when the article has no usable reference', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    const id = seedDraft(db, { imageUrl: null });
    const generateFn = vi.fn(async () => ({
      bytes: Buffer.from('fake-image-bytes'),
      mediaType: 'image/png',
      extension: 'png',
      referenceUsed: false,
    }));

    const result = await generateImageForDraft(db, id, {
      fetchFn: (async () => {
        throw new Error('no network');
      }) as typeof fetch,
      apiKey: 'k',
      model: 'meta/muse-image',
      imagesDir: dir,
      generateFn: generateFn as never,
    });

    const [request] = generateFn.mock.calls[0] as unknown as [{ referenceUrl?: string }];
    expect(request.referenceUrl).toBeUndefined();
    expect(result.referenceDropped).toBe(true);
  });

  it('leaves the DB untouched when generation fails (no partial state)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    const id = seedDraft(db);
    const failing = vi.fn(async () => {
      throw new ImageApiError('images generate failed for draft 1: HTTP 500', {
        status: 500,
        kind: 'retryable',
      });
    });

    await expect(
      generateImageForDraft(db, id, {
        fetchFn: (async () => {
          throw new Error('no network');
        }) as typeof fetch,
        apiKey: 'k',
        model: 'meta/muse-image',
        imagesDir: dir,
        generateFn: failing as never,
      }),
    ).rejects.toThrow(/^images generate failed for draft \d+: /);

    expect(
      (db.prepare('SELECT generated_image_path FROM drafts WHERE id = ?').get(id) as {
        generated_image_path: string | null;
      }).generated_image_path,
    ).toBeNull();
    // And no file was written.
    expect(await fs.readdir(dir).catch(() => [])).toEqual([]);
  });

  it('falls back ONCE to the no-names prompt after a policy refusal', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    const id = seedDraft(db, { title: 'Mario announces a new console' });
    const policyErr = new ImageApiError('images generate failed for draft 1: HTTP 403', {
      status: 403,
      kind: 'policy',
    });
    const generateFn = vi
      .fn()
      .mockRejectedValueOnce(policyErr)
      .mockResolvedValueOnce({
        bytes: Buffer.from('fallback-bytes'),
        mediaType: 'image/png',
        extension: 'png',
        referenceUsed: true,
      });

    const result = await generateImageForDraft(db, id, {
      fetchFn: (async () => {
        throw new Error('no network');
      }) as typeof fetch,
      apiKey: 'k',
      model: 'meta/muse-image',
      imagesDir: dir,
      generateFn: generateFn as never,
    });

    expect(result.fallbackPrompt).toBe(true);
    expect(generateFn).toHaveBeenCalledTimes(2);
    const [, secondRequest] = generateFn.mock.calls.map((c) => c[0]) as Array<{ prompt: string }>;
    expect(secondRequest.prompt).toMatch(/do NOT depict any named/i);
    expect(
      (db.prepare('SELECT generated_image_path FROM drafts WHERE id = ?').get(id) as {
        generated_image_path: string;
      }).generated_image_path,
    ).toBe(result.path);
  });

  it('does not fall back on non-policy failures (single attempt, DB untouched)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    const id = seedDraft(db);
    const generateFn = vi.fn(async () => {
      throw new ImageApiError('images generate failed for draft 1: HTTP 500', {
        status: 500,
        kind: 'retryable',
      });
    });

    await expect(
      generateImageForDraft(db, id, {
        fetchFn: (async () => {
          throw new Error('no network');
        }) as typeof fetch,
        apiKey: 'k',
        model: 'meta/muse-image',
        imagesDir: dir,
        generateFn: generateFn as never,
      }),
    ).rejects.toThrow(/^images generate failed for draft \d+: /);
    expect(generateFn).toHaveBeenCalledTimes(1);
  });

  it('throws typed when the draft does not exist (never touches the network)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    const generateFn = okGenerate();
    await expect(
      generateImageForDraft(db, 999, {
        fetchFn: (async () => {
          throw new Error('no network');
        }) as typeof fetch,
        apiKey: 'k',
        model: 'meta/muse-image',
        imagesDir: dir,
        generateFn: generateFn as never,
      }),
    ).rejects.toThrow(/^images generate failed for draft 999: draft not found/);
    expect(generateFn).not.toHaveBeenCalled();
  });

  it('throws typed when the DB lookup itself fails', async () => {
    const db = openTestDb();
    dbs.push(db);
    db.exec('DROP TABLE drafts');
    await expect(
      generateImageForDraft(db, 1, {
        fetchFn: (async () => {
          throw new Error('no network');
        }) as typeof fetch,
        apiKey: 'k',
        model: 'meta/muse-image',
        generateFn: okGenerate() as never,
      }),
    ).rejects.toThrow(/^images generate failed for draft 1: /);
  });

  it('throws typed when the file cannot be saved, without stamping the DB', async () => {
    const db = openTestDb();
    dbs.push(db);
    const id = seedDraft(db);
    // A file as imagesDir: mkdir succeeds (EEXIST-ish) but writeFile fails.
    const blocker = path.join(await tmpDir(), 'blocker');
    await fs.writeFile(blocker, 'i am a file, not a dir');
    await expect(
      generateImageForDraft(db, id, {
        fetchFn: (async () => {
          throw new Error('no network');
        }) as typeof fetch,
        apiKey: 'k',
        model: 'meta/muse-image',
        imagesDir: path.join(blocker, 'sub'),
        generateFn: okGenerate() as never,
      }),
    ).rejects.toThrow(/^images generate failed for draft \d+: cannot save image file/);
    // Table still exists and the row is unstamped — check via a fresh read
    // guarded against the sabotage above (only the file write failed).
    expect(
      (db.prepare('SELECT generated_image_path FROM drafts WHERE id = ?').get(id) as {
        generated_image_path: string | null;
      }).generated_image_path,
    ).toBeNull();
  });

  it('never leaks the API key into errors', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    const id = seedDraft(db);
    const key = 'super-secret-key-xyz';
    const failing = vi.fn(async () => {
      throw new ImageApiError(`images generate failed: boom ${key}`, { kind: 'failed' });
    });
    const err = await generateImageForDraft(db, id, {
      fetchFn: (async () => {
        throw new Error('no network');
      }) as typeof fetch,
      apiKey: key,
      model: 'meta/muse-image',
      imagesDir: dir,
      generateFn: failing as never,
    }).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(err).not.toContain(key);
  });
});

describe('generateImageForDraft policy ladder', () => {
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-img-ladder-'));
    tmpDirs.push(dir);
    return dir;
  }

  function openDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    applyMigrations(db);
    dbs.push(db);
    return db;
  }

  function baseDeps(dir: string, extra: Record<string, unknown> = {}) {
    return {
      fetchFn: (async () => {
        throw new Error('no network');
      }) as typeof fetch,
      apiKey: 'k',
      model: 'meta/muse-image',
      imagesDir: dir,
      now: () => new Date('2026-10-26T12:00:00.000Z'),
      ...extra,
    };
  }

  function policyErr(message = 'images generate failed for draft 1: HTTP 403: "refused"'): ImageApiError {
    return new ImageApiError(message, { status: 403, kind: 'policy' });
  }

  function okTextOnly() {
    return {
      bytes: Buffer.from('text-only-bytes'),
      mediaType: 'image/png',
      extension: 'png',
      referenceUsed: false,
    };
  }

  function storedPath(db: Database.Database, id: number): string | null {
    return (
      db.prepare('SELECT generated_image_path FROM drafts WHERE id = ?').get(id) as {
        generated_image_path: string | null;
      }
    ).generated_image_path;
  }

  it('stops at rung 3 (full, no reference) and records exactly the tried rungs', async () => {
    const db = openDb();
    const dir = await tmpDir();
    const id = seedDraft(db);
    const generateFn = vi
      .fn()
      .mockRejectedValueOnce(policyErr())
      .mockRejectedValueOnce(policyErr())
      .mockResolvedValueOnce(okTextOnly());

    const result = await generateImageForDraft(db, id, baseDeps(dir, {
      generateFn: generateFn as never,
    }) as never);

    expect(generateFn).toHaveBeenCalledTimes(3);
    const requests = generateFn.mock.calls.map((c) => c[0]) as Array<{
      prompt: string;
      referenceUrl?: string;
    }>;
    // Rung 1: full + reference.
    expect(requests[0].referenceUrl).toBe('https://img.example/news.jpg');
    expect(requests[0].prompt).not.toMatch(/do NOT depict any named/i);
    // Rung 2: no-names + reference.
    expect(requests[1].referenceUrl).toBe('https://img.example/news.jpg');
    expect(requests[1].prompt).toMatch(/do NOT depict any named/i);
    // Rung 3: full, no reference — stops the ladder.
    expect(requests[2].referenceUrl).toBeUndefined();
    expect(requests[2].prompt).not.toMatch(/do NOT depict any named/i);
    expect(result.fallbackPrompt).toBe(false);
    expect(result.referenceDropped).toBe(true);
    expect(storedPath(db, id)).toBe(result.path);
  });

  it('stops at rung 4 (no-names, no reference)', async () => {
    const db = openDb();
    const dir = await tmpDir();
    const id = seedDraft(db);
    const generateFn = vi
      .fn()
      .mockRejectedValueOnce(policyErr())
      .mockRejectedValueOnce(policyErr())
      .mockRejectedValueOnce(policyErr())
      .mockResolvedValueOnce(okTextOnly());

    const result = await generateImageForDraft(db, id, baseDeps(dir, {
      generateFn: generateFn as never,
    }) as never);

    expect(generateFn).toHaveBeenCalledTimes(4);
    const requests = generateFn.mock.calls.map((c) => c[0]) as Array<{
      prompt: string;
      referenceUrl?: string;
    }>;
    expect(requests[3].referenceUrl).toBeUndefined();
    expect(requests[3].prompt).toMatch(/do NOT depict any named/i);
    expect(result.fallbackPrompt).toBe(true);
    expect(result.referenceDropped).toBe(true);
    expect(storedPath(db, id)).toBe(result.path);
  });

  it('all rungs fail → permanent error lists all 4 tried variants, DB untouched', async () => {
    const db = openDb();
    const dir = await tmpDir();
    const id = seedDraft(db);
    const generateFn = vi.fn(async () => {
      throw policyErr(
        `images generate failed for draft ${id}: HTTP 400: "filtered due to policy" [type=400] (content policy refusal — not retrying)`,
      );
    });

    const err = await generateImageForDraft(db, id, baseDeps(dir, {
      generateFn: generateFn as never,
    }) as never).then(
      () => 'resolved',
      (e: Error) => e.message,
    );

    expect(generateFn).toHaveBeenCalledTimes(4);
    expect(err).toBe(
      `images generate failed for draft ${id}: HTTP 400: "filtered due to policy" [type=400] (content policy refusal — not retrying) (content filter rejected 4 variants: full+reference, no-names+reference, full, no-names)`,
    );
    // API message leads (phone truncates at ~180 chars).
    expect(err.indexOf('"filtered due to policy"')).toBeLessThan(
      err.indexOf('(content filter rejected'),
    );
    expect(storedPath(db, id)).toBeNull();
    expect(await fs.readdir(dir).catch(() => [])).toEqual([]);
  });

  it('no-reference draft degenerates to 2 rungs with no duplicate calls', async () => {
    const db = openDb();
    const dir = await tmpDir();
    const id = seedDraft(db, { imageUrl: null });
    const generateFn = vi
      .fn()
      .mockRejectedValueOnce(policyErr())
      .mockResolvedValueOnce(okTextOnly());

    const result = await generateImageForDraft(db, id, baseDeps(dir, {
      generateFn: generateFn as never,
    }) as never);

    expect(generateFn).toHaveBeenCalledTimes(2);
    const requests = generateFn.mock.calls.map((c) => c[0]) as Array<{
      prompt: string;
      referenceUrl?: string;
    }>;
    for (const r of requests) expect(r.referenceUrl).toBeUndefined();
    expect(requests[0].prompt).not.toMatch(/do NOT depict any named/i);
    expect(requests[1].prompt).toMatch(/do NOT depict any named/i);
    expect(result.fallbackPrompt).toBe(true);
    expect(storedPath(db, id)).toBe(result.path);
  });

  it('no-reference draft, all fail → lists only the 2 tried variants', async () => {
    const db = openDb();
    const dir = await tmpDir();
    const id = seedDraft(db, { imageUrl: null });
    const generateFn = vi.fn(async () => {
      throw policyErr(`images generate failed for draft ${id}: HTTP 403: "refused"`);
    });

    const err = await generateImageForDraft(db, id, baseDeps(dir, {
      generateFn: generateFn as never,
    }) as never).then(
      () => 'resolved',
      (e: Error) => e.message,
    );

    expect(generateFn).toHaveBeenCalledTimes(2);
    expect(err).toBe(
      `images generate failed for draft ${id}: HTTP 403: "refused" (content filter rejected 2 variants: full, no-names)`,
    );
    expect(storedPath(db, id)).toBeNull();
  });

  it('reference-unfetchable then policy (wire level): skips to rung 4, no shape twice', async () => {
    const db = openDb();
    const dir = await tmpDir();
    const id = seedDraft(db);
    const bodies: Array<{ prompt: string; withRef: boolean }> = [];
    const fetchFn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const parsed = JSON.parse(init?.body as string) as {
        prompt: string;
        input_references?: unknown;
      };
      bodies.push({ prompt: parsed.prompt, withRef: parsed.input_references !== undefined });
      const payload =
        bodies.length === 1
          ? { error: { message: 'could not fetch reference', metadata: { error_type: 'image_download_failed' } } }
          : bodies.length === 2
            ? {
                error: {
                  message:
                    'The response was filtered due to the prompt triggering our content management policy.',
                  code: 400,
                },
              }
            : { data: [{ b64_json: Buffer.from('rung4-bytes').toString('base64'), media_type: 'image/png' }] };
      const status = bodies.length <= 2 ? (bodies.length === 1 ? 400 : 400) : 200;
      return {
        ok: status === 200,
        status,
        headers: { get: () => null },
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer,
        body: { cancel: async () => {} },
      } as unknown as Response;
    });

    const result = await generateImageForDraft(db, id, {
      fetchFn: fetchFn as unknown as typeof fetch,
      apiKey: 'k',
      model: 'meta/muse-image',
      imagesDir: dir,
      now: () => new Date('2026-10-26T12:00:00.000Z'),
      sleep: async () => {},
    });

    // Wire 1: rung 1 (full+ref). Wire 2: the client's internal text-only
    // retry (full, no ref — rung 3's shape). Wire 3: rung 4 directly.
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(bodies[0].withRef).toBe(true);
    expect(bodies[0].prompt).not.toMatch(/do NOT depict any named/i);
    expect(bodies[1]).toMatchObject({ withRef: false });
    expect(bodies[1].prompt).not.toMatch(/do NOT depict any named/i);
    expect(bodies[2].withRef).toBe(false);
    expect(bodies[2].prompt).toMatch(/do NOT depict any named/i);
    // Full-no-ref went out exactly once; no-names+reference never went out.
    expect(bodies.filter((b) => !b.withRef && !/do NOT depict any named/i.test(b.prompt))).toHaveLength(1);
    expect(bodies.filter((b) => b.withRef && /do NOT depict any named/i.test(b.prompt))).toHaveLength(0);
    expect(result.fallbackPrompt).toBe(true);
    expect(result.referenceDropped).toBe(true);
    expect(storedPath(db, id)).toBe(result.path);
  });

  it('reference-unfetchable then policy, rung 4 also filtered → lists only the 3 tried shapes', async () => {
    const db = openDb();
    const dir = await tmpDir();
    const id = seedDraft(db);
    const fetchFn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const parsed = JSON.parse(init?.body as string) as { input_references?: unknown };
      const status = 400;
      const payload =
        parsed.input_references !== undefined
          ? { error: { message: 'could not fetch reference', metadata: { error_type: 'image_download_failed' } } }
          : {
              error: {
                message:
                  'The response was filtered due to the prompt triggering our content management policy.',
                code: 400,
              },
            };
      return {
        ok: false,
        status,
        headers: { get: () => null },
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer,
        body: { cancel: async () => {} },
      } as unknown as Response;
    });

    const err = await generateImageForDraft(db, id, {
      fetchFn: fetchFn as unknown as typeof fetch,
      apiKey: 'k',
      model: 'meta/muse-image',
      imagesDir: dir,
      now: () => new Date('2026-10-26T12:00:00.000Z'),
      sleep: async () => {},
    }).then(
      () => 'resolved',
      (e: Error) => e.message,
    );

    // Rung 1 (full+ref) + its internal text-only retry (full) + rung 4.
    // Rung 2 (no-names+ref) is skipped: the reference proved unfetchable.
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(err).toBe(
      `images generate failed for draft ${id}: HTTP 400: "The response was filtered due to the prompt triggering our content management policy." [type=400] (content policy refusal — not retrying) (content filter rejected 3 variants: full+reference, full, no-names)`,
    );
    expect(storedPath(db, id)).toBeNull();
    expect(await fs.readdir(dir).catch(() => [])).toEqual([]);
  });
});
