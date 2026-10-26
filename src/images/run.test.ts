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
