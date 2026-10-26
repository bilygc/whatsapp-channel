import type Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_IMAGE_MODEL,
  generateImage,
  isPolicyRefusal,
  type ImageDeps,
} from './openrouter.js';
import { buildImageFallbackPrompt, buildImagePrompt } from './prompts.js';

export interface DraftImageDeps extends ImageDeps {
  /** Clock for the output filename timestamp (default: live time). */
  now?: () => Date;
  /**
   * Project-relative image dir (default `data/images`). Absolute dirs are
   * used (and stored) as-is — tests pass a tmpdir.
   */
  imagesDir?: string;
  /** Seam for tests: replaces the network call. */
  generateFn?: typeof generateImage;
}

export interface DraftImageResult {
  draftId: number;
  /** Path stored in `drafts.generated_image_path` (project-relative in prod). */
  path: string;
  bytes: number;
  /** True when the prompt fell back to the no-names variant after a 403. */
  fallbackPrompt: boolean;
  /** True when the call went out text-only (no usable reference). */
  referenceDropped: boolean;
}

export const DEFAULT_IMAGES_DIR = path.join('data', 'images');

interface DraftImageRow {
  id: number;
  caption_es: string;
  title: string;
  image_url: string | null;
}

/**
 * Generate an image for a draft (manual `/img` flow) and stamp
 * `drafts.generated_image_path`. Overwrites the previous path on
 * regeneration (NULL = none yet).
 *
 * Per-attempt isolation: the DB row is written ONLY after the file is
 * saved. Any failure throws a typed
 * `images generate failed for draft <id>: <cause>` error with NO partial
 * DB state (the draft keeps its old `generated_image_path`, or NULL).
 * Secrets never reach the message.
 *
 * On a 403 content-policy refusal the prompt falls back ONCE to the
 * no-names variant (style description only) before failing.
 */
export async function generateImageForDraft(
  db: Database.Database,
  draftId: number,
  deps: DraftImageDeps,
): Promise<DraftImageResult> {
  const fail = (cause: string): Error =>
    new Error(
      `images generate failed for draft ${draftId}: ${cause}`
        .split(deps.apiKey)
        .join('[redacted]'),
    );

  let row: DraftImageRow | undefined;
  try {
    row = db
      .prepare(
        `SELECT d.id, d.caption_es, a.title, a.image_url
         FROM drafts d JOIN articles a ON a.id = d.article_id
         WHERE d.id = ?`,
      )
      .get(draftId) as DraftImageRow | undefined;
  } catch (err) {
    throw fail(err instanceof Error ? err.message : String(err));
  }
  if (!row) {
    throw fail('draft not found');
  }

  const generate = deps.generateFn ?? generateImage;
  const hasReference = typeof row.image_url === 'string' && /^https:\/\//.test(row.image_url);
  const scope = `draft ${draftId}`;

  const runOnce = (prompt: string) =>
    generate(
      { scope, prompt, ...(hasReference ? { referenceUrl: row.image_url as string } : {}) },
      deps,
    );

  let image: Awaited<ReturnType<typeof generate>>;
  let fallbackPrompt = false;
  try {
    try {
      image = await runOnce(
        buildImagePrompt({ title: row.title, captionEs: row.caption_es, hasReferenceImage: hasReference }),
      );
    } catch (err) {
      // Policy refusal (often named trademarked characters): fall back ONCE
      // to the no-names prompt. Anything else propagates typed below.
      if (!isPolicyRefusal(err)) throw err;
      fallbackPrompt = true;
      image = await runOnce(
        buildImageFallbackPrompt({
          title: row.title,
          captionEs: row.caption_es,
          hasReferenceImage: hasReference,
        }),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The client already prefixes `images generate failed for <scope>` —
    // keep the single domain prefix instead of doubling it.
    if (message.startsWith('images generate failed for ')) throw err;
    throw fail(message);
  }

  // Save bytes BEFORE touching the DB (durability ordering: the row is
  // stamped only after the file exists).
  const imagesDir = deps.imagesDir ?? DEFAULT_IMAGES_DIR;
  const timestamp = (deps.now ?? (() => new Date()))()
    .toISOString()
    .replace(/[:.]/g, '-');
  const filename = `draft-${draftId}-${timestamp}.${image.extension}`;
  const absPath = path.isAbsolute(imagesDir)
    ? path.join(imagesDir, filename)
    : path.join(process.cwd(), imagesDir, filename);
  const storedPath = path.isAbsolute(imagesDir) ? absPath : path.join(imagesDir, filename);

  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, image.bytes);
  } catch (err) {
    throw fail(`cannot save image file: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    db.prepare(`UPDATE drafts SET generated_image_path = ? WHERE id = ?`).run(storedPath, draftId);
  } catch (err) {
    throw fail(`cannot stamp generated image: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    draftId,
    path: storedPath,
    bytes: image.bytes.length,
    fallbackPrompt,
    referenceDropped: !image.referenceUsed,
  };
}

/** Re-exported so the listener CLI resolves the model default consistently. */
export { DEFAULT_IMAGE_MODEL };
