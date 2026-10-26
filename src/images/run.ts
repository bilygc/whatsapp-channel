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
 * On a content-policy rejection the ladder walks progressively reduced
 * inputs (rejected filter calls are unbilled and fast, so up to 3 fallback
 * attempts after the initial call is acceptable): full prompt + reference,
 * no-names prompt + reference, full prompt without reference, no-names
 * prompt without reference. First success wins; rungs whose input is
 * unavailable are skipped (no reference image). Exhaustion throws a
 * permanent error listing ONLY the rungs actually tried.
 *
 * Client interplay: a with-reference rung may trigger the client's internal
 * text-only retry (reference unfetchable upstream). That retry covers the
 * same-variant no-reference rung's shape and proves the reference unusable,
 * so the ladder then skips the remaining with-reference rungs and the
 * covered rung instead of running any shape twice. Non-policy failures
 * propagate exactly as before (no ladder).
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

  // Per-rung wire observation: a text-only wire call inside a with-reference
  // rung means the client performed its internal text-only retry (the
  // reference is unfetchable upstream). Only meaningful on the real-client
  // path — the generateFn seam bypasses fetch entirely, and a mocked policy
  // rejection then counts as a direct policy failure with the reference
  // still usable.
  let rungSawTextOnlyWire = false;
  const observingFetch: typeof fetch = (async (input, init) => {
    try {
      if (typeof init?.body === 'string') {
        const parsed = JSON.parse(init.body) as { input_references?: unknown };
        if (parsed.input_references === undefined) rungSawTextOnlyWire = true;
      }
    } catch {
      // Observation is best-effort — never break the call.
    }
    return deps.fetchFn(input, init);
  }) as typeof fetch;
  const callDeps: ImageDeps = deps.generateFn ? deps : { ...deps, fetchFn: observingFetch };

  const runRung = (prompt: string, withRef: boolean) =>
    generate(
      { scope, prompt, ...(withRef ? { referenceUrl: row.image_url as string } : {}) },
      callDeps,
    );

  interface LadderRung {
    variant: 'full' | 'nonames';
    withRef: boolean;
    /** Failure-message token, e.g. `full+reference`, `no-names`, `full`. */
    label: string;
    prompt: string;
  }
  const ladder: LadderRung[] = [];
  if (hasReference) {
    ladder.push({
      variant: 'full',
      withRef: true,
      label: 'full+reference',
      prompt: buildImagePrompt({ title: row.title, captionEs: row.caption_es, hasReferenceImage: true }),
    });
    ladder.push({
      variant: 'nonames',
      withRef: true,
      label: 'no-names+reference',
      prompt: buildImageFallbackPrompt({
        title: row.title,
        captionEs: row.caption_es,
        hasReferenceImage: true,
      }),
    });
  }
  ladder.push({
    variant: 'full',
    withRef: false,
    label: 'full',
    prompt: buildImagePrompt({ title: row.title, captionEs: row.caption_es, hasReferenceImage: false }),
  });
  ladder.push({
    variant: 'nonames',
    withRef: false,
    label: 'no-names',
    prompt: buildImageFallbackPrompt({
      title: row.title,
      captionEs: row.caption_es,
      hasReferenceImage: false,
    }),
  });

  let image: Awaited<ReturnType<typeof generate>> | undefined;
  let fallbackPrompt = false;
  // Rungs actually attempted (wire went out), in order — the permanent
  // failure message lists exactly these.
  const triedLabels: string[] = [];
  const tried = new Set<string>();
  const markTried = (label: string): void => {
    if (!tried.has(label)) {
      tried.add(label);
      triedLabels.push(label);
    }
  };
  let refKnownBad = false;
  let lastPolicyCause: string | null = null;
  try {
    for (let i = 0; i < ladder.length; i += 1) {
      const rung = ladder[i];
      // Skip rungs whose input is gone: a known-bad reference, or a
      // no-reference shape the client's internal retry already covered.
      if ((rung.withRef && refKnownBad) || tried.has(rung.label)) continue;
      rungSawTextOnlyWire = false;
      try {
        image = await runRung(rung.prompt, rung.withRef);
        markTried(rung.label);
        fallbackPrompt = rung.variant === 'nonames';
        break;
      } catch (err) {
        // Non-policy failures behave exactly as before: propagate typed.
        if (!isPolicyRefusal(err)) throw err;
        markTried(rung.label);
        const message = err instanceof Error ? err.message : String(err);
        lastPolicyCause = message;
        if (rung.withRef && rungSawTextOnlyWire) {
          // The client's text-only retry already tried this variant without
          // the reference, and the reference proved unfetchable: skip the
          // remaining with-reference rungs and the covered no-ref shape.
          refKnownBad = true;
          markTried(rung.variant === 'full' ? 'full' : 'no-names');
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The client already prefixes `images generate failed for <scope>` —
    // keep the single domain prefix instead of doubling it.
    if (message.startsWith('images generate failed for ')) throw err;
    throw fail(message);
  }
  if (!image) {
    const prefix = `images generate failed for draft ${draftId}: `;
    const cause =
      lastPolicyCause !== null && lastPolicyCause.startsWith(prefix)
        ? lastPolicyCause.slice(prefix.length)
        : (lastPolicyCause ?? 'content filter rejected the prompt');
    throw fail(
      `${cause} (content filter rejected ${triedLabels.length} variants: ${triedLabels.join(', ')})`,
    );
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
