import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { ImageApiError } from './openrouter.js';
import { generateImageForDraft, loadLogoDataUrl, LOGO_MAX_BYTES } from './run.js';

/** Logo-less mode: a path that never exists, so generation proceeds logo-free. */
const MISSING_LOGO = path.join('no-such-dir', 'no-such-logo.png');

/** Minimal PNG fixture (valid magic bytes) for logo-riding tests. */
async function writeLogoFixture(dir: string): Promise<{ logoPath: string; dataUrl: string }> {
  const logoPath = path.join(dir, 'logo.png');
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('fake-logo-bytes'),
  ]);
  await fs.writeFile(logoPath, bytes);
  return { logoPath, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
}

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
      logoPath: MISSING_LOGO,
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
      logoPath: MISSING_LOGO,
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
      logoPath: MISSING_LOGO,
      imagesDir: dir,
      generateFn: generateFn as never,
    });

    expect(generateFn).toHaveBeenCalledOnce();
    const [request] = generateFn.mock.calls[0] as unknown as [
      { scope: string; prompt: string; referenceUrls?: string[] },
    ];
    expect(request.scope).toBe(`draft ${id}`);
    expect(request.referenceUrls).toEqual(['https://img.example/news.jpg']);
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
      logoPath: MISSING_LOGO,
      imagesDir: dir,
      generateFn: generateFn as never,
    });

    const [request] = generateFn.mock.calls[0] as unknown as [{ referenceUrls?: string[] }];
    expect(request.referenceUrls).toBeUndefined();
    expect(result.referenceDropped).toBe(true);
    expect(result.logoIncluded).toBe(false);
  });

  it('attaches the news image AND the logo in order on every rung (logo rides along)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    const id = seedDraft(db);
    const { logoPath, dataUrl: logoDataUrl } = await writeLogoFixture(dir);
    const generateFn = okGenerate();

    const result = await generateImageForDraft(db, id, {
      fetchFn: (async () => {
        throw new Error('no network');
      }) as typeof fetch,
      apiKey: 'k',
      model: 'meta/muse-image',
      logoPath,
      imagesDir: dir,
      generateFn: generateFn as never,
    });

    expect(generateFn).toHaveBeenCalledOnce();
    const [request] = generateFn.mock.calls[0] as unknown as [
      { scope: string; prompt: string; referenceUrls?: string[] },
    ];
    // Semantic order: [news, logo].
    expect(request.referenceUrls).toEqual(['https://img.example/news.jpg', logoDataUrl]);
    expect(request.prompt).toMatch(/channel brand logo/i);
    expect(result.referenceDropped).toBe(false);
    expect(result.logoIncluded).toBe(true);
  });

  it('proceeds without the logo when the logo file cannot be read (never aborts)', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    const id = seedDraft(db);
    const generateFn = okGenerate();

    const result = await generateImageForDraft(db, id, {
      fetchFn: (async () => {
        throw new Error('no network');
      }) as typeof fetch,
      apiKey: 'k',
      model: 'meta/muse-image',
      logoPath: path.join(dir, 'no-such-logo.png'),
      imagesDir: dir,
      generateFn: generateFn as never,
    });

    const [request] = generateFn.mock.calls[0] as unknown as [
      { scope: string; prompt: string; referenceUrls?: string[] },
    ];
    expect(request.referenceUrls).toEqual(['https://img.example/news.jpg']);
    expect(request.prompt).not.toMatch(/brand logo/i);
    expect(result.referenceDropped).toBe(false);
    expect(result.logoIncluded).toBe(false);
    expect(
      (db.prepare('SELECT generated_image_path FROM drafts WHERE id = ?').get(id) as {
        generated_image_path: string;
      }).generated_image_path,
    ).toBe(result.path);
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
        logoPath: MISSING_LOGO,
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
      logoPath: MISSING_LOGO,
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
      logoPath: MISSING_LOGO,
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
      logoPath: MISSING_LOGO,
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
      logoPath: MISSING_LOGO,
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
      logoPath: MISSING_LOGO,
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
      logoPath: MISSING_LOGO,
      imagesDir: dir,
      generateFn: failing as never,
    }).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(err).not.toContain(key);
  });

  it('does not mangle messages when apiKey is empty', async () => {
    const db = openTestDb();
    dbs.push(db);
    const dir = await tmpDir();
    // An empty key must not interleave '[redacted]' per character.
    await expect(
      generateImageForDraft(db, 999, {
        fetchFn: (async () => {
          throw new Error('no network');
        }) as typeof fetch,
        apiKey: '',
        model: 'meta/muse-image',
        logoPath: MISSING_LOGO,
        imagesDir: dir,
        generateFn: okGenerate() as never,
      }),
    ).rejects.toThrow('images generate failed for draft 999: draft not found');
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
      logoPath: MISSING_LOGO,
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
      referenceUrls?: string[];
    }>;
    // Rung 1: full + reference.
    expect(requests[0].referenceUrls).toEqual(['https://img.example/news.jpg']);
    expect(requests[0].prompt).not.toMatch(/do NOT depict any named/i);
    // Rung 2: no-names + reference.
    expect(requests[1].referenceUrls).toEqual(['https://img.example/news.jpg']);
    expect(requests[1].prompt).toMatch(/do NOT depict any named/i);
    // Rung 3: full, no reference — stops the ladder.
    expect(requests[2].referenceUrls).toBeUndefined();
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
      referenceUrls?: string[];
    }>;
    expect(requests[3].referenceUrls).toBeUndefined();
    expect(requests[3].prompt).toMatch(/do NOT depict any named/i);
    expect(result.fallbackPrompt).toBe(true);
    expect(result.referenceDropped).toBe(true);
    expect(storedPath(db, id)).toBe(result.path);
  });

  it('keeps the logo riding along on news-less rungs after policy refusals', async () => {
    const db = openDb();
    const dir = await tmpDir();
    const id = seedDraft(db);
    const { logoPath, dataUrl: logoDataUrl } = await writeLogoFixture(dir);
    const generateFn = vi
      .fn()
      .mockRejectedValueOnce(policyErr())
      .mockRejectedValueOnce(policyErr())
      .mockResolvedValueOnce({
        bytes: Buffer.from('logo-only-bytes'),
        mediaType: 'image/png',
        extension: 'png',
        referenceUsed: true,
      });

    const result = await generateImageForDraft(
      db,
      id,
      baseDeps(dir, { logoPath, generateFn: generateFn as never }) as never,
    );

    expect(generateFn).toHaveBeenCalledTimes(3);
    const requests = generateFn.mock.calls.map((c) => c[0]) as Array<{
      prompt: string;
      referenceUrls?: string[];
    }>;
    // Rungs 1–2 carry [news, logo]; rung 3 is the news-less shape but keeps the logo.
    expect(requests[0].referenceUrls).toEqual(['https://img.example/news.jpg', logoDataUrl]);
    expect(requests[1].referenceUrls).toEqual(['https://img.example/news.jpg', logoDataUrl]);
    expect(requests[2].referenceUrls).toEqual([logoDataUrl]);
    for (const r of requests) expect(r.prompt).toMatch(/channel brand logo/i);
    expect(result.fallbackPrompt).toBe(false);
    expect(result.referenceDropped).toBe(true);
    expect(result.logoIncluded).toBe(true);
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
      referenceUrls?: string[];
    }>;
    for (const r of requests) expect(r.referenceUrls).toBeUndefined();
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
    const { logoPath, dataUrl: logoDataUrl } = await writeLogoFixture(dir);
    const bodies: Array<{ prompt: string; newsRef: boolean; refs: string[] }> = [];
    const fetchFn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const parsed = JSON.parse(init?.body as string) as {
        prompt: string;
        input_references?: Array<{ image_url: { url: string } }>;
      };
      const refs = (parsed.input_references ?? []).map((r) => r.image_url.url);
      bodies.push({
        prompt: parsed.prompt,
        newsRef: refs.some((u) => u === 'https://img.example/news.jpg'),
        refs,
      });
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
      logoPath,
      imagesDir: dir,
      now: () => new Date('2026-10-26T12:00:00.000Z'),
      sleep: async () => {},
    });

    // Wire 1: rung 1 (full + news + logo). Wire 2: the client's internal
    // text-only retry (full, zero refs — rung 3's news-less shape). Wire 3:
    // rung 4 (no-names + logo) directly.
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(bodies[0].newsRef).toBe(true);
    expect(bodies[0].refs).toEqual(['https://img.example/news.jpg', logoDataUrl]);
    expect(bodies[0].prompt).not.toMatch(/do NOT depict any named/i);
    expect(bodies[1].refs).toEqual([]);
    expect(bodies[1].prompt).not.toMatch(/do NOT depict any named/i);
    expect(bodies[2].newsRef).toBe(false);
    expect(bodies[2].refs).toEqual([logoDataUrl]);
    expect(bodies[2].prompt).toMatch(/do NOT depict any named/i);
    // Full text-only went out exactly once; no-names+news never went out.
    expect(bodies.filter((b) => b.refs.length === 0 && !/do NOT depict any named/i.test(b.prompt))).toHaveLength(1);
    expect(bodies.filter((b) => b.newsRef && /do NOT depict any named/i.test(b.prompt))).toHaveLength(0);
    expect(result.fallbackPrompt).toBe(true);
    expect(result.referenceDropped).toBe(true);
    expect(result.logoIncluded).toBe(true);
    expect(storedPath(db, id)).toBe(result.path);
  });

  it('reference-unfetchable then policy, rung 4 also filtered → lists only the 3 tried shapes', async () => {
    const db = openDb();
    const dir = await tmpDir();
    const id = seedDraft(db);
    const { logoPath } = await writeLogoFixture(await tmpDir());
    const fetchFn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const parsed = JSON.parse(init?.body as string) as {
        input_references?: Array<{ image_url: { url: string } }>;
      };
      const refs = (parsed.input_references ?? []).map((r) => r.image_url.url);
      // Only the NEWS ref is ever "unfetchable" — the inlined logo URL is
      // always servable, so logo-only rungs get the policy verdict instead.
      const hasNews = refs.some((u) => u === 'https://img.example/news.jpg');
      const status = 400;
      const payload = hasNews
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
      logoPath,
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

  it('wire observation never JSON.parses the request body (cheap substring check)', async () => {
    const db = openDb();
    const dir = await tmpDir();
    const id = seedDraft(db);
    const { logoPath } = await writeLogoFixture(dir);
    // Any JSON.parse of a request body (which always carries the logo's
    // multi-MB base64 when refs ride along) is recorded — the response
    // parse below must be the only parse that happens.
    const origParse = JSON.parse.bind(JSON);
    const parsedRequestBodies: string[] = [];
    vi.spyOn(JSON, 'parse').mockImplementation(
      (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
        if (text.includes('input_references')) parsedRequestBodies.push(text);
        return reviver ? origParse(text, reviver) : origParse(text);
      },
    );
    const payload = {
      data: [{ b64_json: Buffer.from('ok-bytes').toString('base64'), media_type: 'image/png' }],
    };
    const fetchFn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      // The request body really does carry the logo bytes (multi-KB here,
      // multi-MB in prod) — parsing it would be observable above.
      expect(typeof init?.body === 'string' && init.body.includes('input_references')).toBe(
        true,
      );
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () =>
          new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer,
        body: { cancel: async () => {} },
      } as unknown as Response;
    });

    const result = await generateImageForDraft(db, id, baseDeps(dir, {
      logoPath,
      fetchFn: fetchFn as unknown as typeof fetch,
    }) as never);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(parsedRequestBodies).toEqual([]);
    expect(result.logoIncluded).toBe(true);
    expect(result.referenceDropped).toBe(false);
    expect(storedPath(db, id)).toBe(result.path);
  });
});

describe('loadLogoDataUrl', () => {
  let tmpDirs: string[] = [];
  afterEach(async () => {
    for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true });
    tmpDirs = [];
  });

  async function tmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-logo-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('returns undefined (never throws) when the file is missing', async () => {
    await expect(loadLogoDataUrl(path.join('no-such-dir', 'no-such-logo.png'))).resolves
      .toBeUndefined();
  });

  it('returns undefined for an empty file', async () => {
    const dir = await tmpDir();
    const p = path.join(dir, 'empty.png');
    await fs.writeFile(p, Buffer.alloc(0));
    await expect(loadLogoDataUrl(p)).resolves.toBeUndefined();
  });

  it('sniffs PNG magic bytes even under a misleading extension', async () => {
    const dir = await tmpDir();
    const p = path.join(dir, 'logo.bin');
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('x'),
    ]);
    await fs.writeFile(p, bytes);
    await expect(loadLogoDataUrl(p)).resolves.toBe(
      `data:image/png;base64,${bytes.toString('base64')}`,
    );
  });

  it('sniffs JPEG magic bytes (case-tolerant .JPG extension also works)', async () => {
    const dir = await tmpDir();
    const p = path.join(dir, 'logo.JPG');
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('x')]);
    await fs.writeFile(p, bytes);
    await expect(loadLogoDataUrl(p)).resolves.toBe(
      `data:image/jpeg;base64,${bytes.toString('base64')}`,
    );
  });

  it('falls back to the file extension for unrecognized bytes', async () => {
    const dir = await tmpDir();
    const p = path.join(dir, 'logo.webp');
    const bytes = Buffer.from('not-really-webp');
    await fs.writeFile(p, bytes);
    await expect(loadLogoDataUrl(p)).resolves.toBe(
      `data:image/webp;base64,${bytes.toString('base64')}`,
    );
  });

  it('defaults to image/png for unrecognized bytes and extension', async () => {
    const dir = await tmpDir();
    const p = path.join(dir, 'logo.bin');
    const bytes = Buffer.from('mystery-bytes');
    await fs.writeFile(p, bytes);
    await expect(loadLogoDataUrl(p)).resolves.toBe(
      `data:image/png;base64,${bytes.toString('base64')}`,
    );
  });

  it('returns undefined + logs too large when the file exceeds LOGO_MAX_BYTES', async () => {
    expect(LOGO_MAX_BYTES).toBe(2 * 1024 * 1024);
    const dir = await tmpDir();
    const p = path.join(dir, 'big.png');
    await fs.writeFile(p, Buffer.alloc(LOGO_MAX_BYTES + 1));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(loadLogoDataUrl(p)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('too large');
    expect(message).toContain(p);
    // Category only — never bytes, never a stack.
    expect(message).not.toContain(String(LOGO_MAX_BYTES + 1));
  });

  it('returns undefined (never throws) when logoPath is a directory', async () => {
    const dir = await tmpDir();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(loadLogoDataUrl(dir)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
