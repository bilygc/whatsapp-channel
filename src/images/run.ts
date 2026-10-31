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
  /**
   * Channel-logo file to attach as a reference image. Relative paths
   * resolve from `process.cwd()` (default `media/LogoPowerUpGaming.png`).
   * Tests pass a fixture (or a bogus path for the missing-logo case).
   */
  logoPath?: string;
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
  /** True when the NEWS reference did not ride on the final wire call. */
  referenceDropped: boolean;
  /** True when the channel logo rode along as an attached reference. */
  logoIncluded: boolean;
}

export const DEFAULT_IMAGES_DIR = path.join('data', 'images');

/** Project-relative path of the channel brand logo (attached, never composited). */
export const LOGO_RELATIVE_PATH = path.join('media', 'LogoPowerUpGaming.png');

/**
 * Upper bound for the inlined channel-logo file. Anything bigger is treated
 * as logo-less (data URLs are inlined bytes — never buffer megabytes into a
 * paid wire call). Exported for tests.
 */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Best-effort channel-logo loader: reads the file and returns a
 * `data:image/<type>;base64,…` URL for `input_references`. NEVER throws —
 * any read failure (missing file, unreadable bytes, unknown type) yields
 * `undefined` and generation proceeds without the logo. The bytes are
 * only ever returned here, never logged or surfaced in error messages.
 */
export async function loadLogoDataUrl(logoPath: string): Promise<string | undefined> {
  try {
    const abs = path.isAbsolute(logoPath) ? logoPath : path.join(process.cwd(), logoPath);
    try {
      const st = await fs.stat(abs);
      if (st.size > LOGO_MAX_BYTES) {
        console.warn(`images: logo skipped (too large): ${logoPath}`);
        return undefined;
      }
    } catch {
      // stat is best-effort only (the read below is authoritative) —
      // fall through and let the read decide.
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const reason = code === 'ENOENT' ? 'not found' : 'unreadable';
      console.warn(`images: logo skipped (${reason}): ${logoPath}`);
      return undefined;
    }
    if (bytes.length === 0) {
      console.warn(`images: logo skipped (empty): ${logoPath}`);
      return undefined;
    }
    if (bytes.length > LOGO_MAX_BYTES) {
      console.warn(`images: logo skipped (too large): ${logoPath}`);
      return undefined;
    }
    const mediaType = sniffImageMediaType(bytes) ?? mediaTypeFromExtension(logoPath) ?? 'image/png';
    return `data:${mediaType};base64,${bytes.toString('base64')}`;
  } catch {
    console.warn(`images: logo skipped (unreadable): ${logoPath}`);
    return undefined;
  }
}

/** Magic-byte sniff: PNG, JPEG, GIF, WEBP. Unknown → undefined. */
function sniffImageMediaType(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

/** Extension fallback when magic bytes are unrecognized (case-tolerant). */
function mediaTypeFromExtension(logoPath: string): string | undefined {
  const ext = path.extname(logoPath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return undefined;
}

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
 * unavailable are skipped (no news reference image). Exhaustion throws a
 * permanent error listing ONLY the rungs actually tried.
 *
 * The channel brand logo (see LOGO_RELATIVE_PATH) is attached as an extra
 * `input_references` entry on EVERY rung whenever it loads — it rides
 * along with or without the news reference, because a policy refusal is
 * about prompt/subject content, not the brand mark. A missing/unreadable
 * logo file never aborts generation (the run simply proceeds logo-less).
 * "With-reference" therefore means "news image attached"; logo-only rungs
 * are the ladder's without-reference shape.
 *
 * Client interplay: a with-reference rung may trigger the client's internal
 * text-only retry (the https news image unfetchable upstream — the inlined
 * data-URL logo can never be "unfetchable", and the retry drops all refs
 * regardless). That retry covers the same-variant no-reference rung's shape
 * and proves the reference unusable, so the ladder then skips the remaining
 * with-reference rungs and the covered rung instead of running any shape
 * twice. Non-policy failures propagate exactly as before (no ladder).
 */
export async function generateImageForDraft(
  db: Database.Database,
  draftId: number,
  deps: DraftImageDeps,
): Promise<DraftImageResult> {
  const fail = (cause: string): Error =>
    new Error(
      deps.apiKey !== ''
        ? `images generate failed for draft ${draftId}: ${cause}`
            .split(deps.apiKey)
            .join('[redacted]')
        : `images generate failed for draft ${draftId}: ${cause}`,
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

  // Best-effort brand-logo attachment (never aborts the run when missing).
  const logoDataUrl = await loadLogoDataUrl(deps.logoPath ?? LOGO_RELATIVE_PATH);
  const hasLogo = logoDataUrl !== undefined;

  // Per-rung wire observation: a text-only wire call inside a with-reference
  // rung means the client performed its internal text-only retry (the
  // https reference is unfetchable upstream). Text-only means
  // `input_references` is ABSENT — every ladder rung normally carries ≥1
  // ref now (the logo rides along even on news-less rungs), so rungs differ
  // by WHICH refs they carry, not by whether the key exists. Only
  // meaningful on the real-client path — the generateFn seam bypasses fetch
  // entirely, and a mocked policy rejection then counts as a direct policy
  // failure with the reference still usable.
  let rungSawTextOnlyWire = false;
  const observingFetch: typeof fetch = (async (input, init) => {
    try {
      if (typeof init?.body === 'string') {
        // Cheap substring check — never JSON.parse a multi-MB body (the
        // inlined logo base64 rides here). Absence of the key means the
        // client performed its internal text-only retry.
        if (!/"input_references"\s*:/.test(init.body)) rungSawTextOnlyWire = true;
      }
    } catch {
      // Observation is best-effort — never break the call.
    }
    return deps.fetchFn(input, init);
  }) as typeof fetch;
  const callDeps: ImageDeps = deps.generateFn ? deps : { ...deps, fetchFn: observingFetch };

  /**
   * Reference order on the wire is `[news?, logo?]` (see
   * `GenerateImageRequest.referenceUrls`): the news image first, the brand
   * logo second. `withRef` toggles ONLY the news image — the logo rides
   * along whenever it loaded.
   */
  const runRung = (prompt: string, withRef: boolean) => {
    const referenceUrls = [
      ...(withRef ? [row.image_url as string] : []),
      ...(hasLogo ? [logoDataUrl as string] : []),
    ];
    return generate(
      { scope, prompt, ...(referenceUrls.length > 0 ? { referenceUrls } : {}) },
      callDeps,
    );
  };

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
      prompt: buildImagePrompt({
        title: row.title,
        captionEs: row.caption_es,
        hasReferenceImage: true,
        hasLogoImage: hasLogo,
      }),
    });
    ladder.push({
      variant: 'nonames',
      withRef: true,
      label: 'no-names+reference',
      prompt: buildImageFallbackPrompt({
        title: row.title,
        captionEs: row.caption_es,
        hasReferenceImage: true,
        hasLogoImage: hasLogo,
      }),
    });
  }
  ladder.push({
    variant: 'full',
    withRef: false,
    label: 'full',
    prompt: buildImagePrompt({
      title: row.title,
      captionEs: row.caption_es,
      hasReferenceImage: false,
      hasLogoImage: hasLogo,
    }),
  });
  ladder.push({
    variant: 'nonames',
    withRef: false,
    label: 'no-names',
    prompt: buildImageFallbackPrompt({
      title: row.title,
      captionEs: row.caption_es,
      hasReferenceImage: false,
      hasLogoImage: hasLogo,
    }),
  });

  let image: Awaited<ReturnType<typeof generate>> | undefined;
  /** Whether the winning rung carried the NEWS reference. */
  let imageWithRef = false;
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
        imageWithRef = rung.withRef;
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
    // News-specific: the news image rode on the final wire call only when
    // the winning rung carried it AND the client didn't drop to its
    // internal text-only retry. The logo alone still counts as "used", so
    // a logo-only win is a dropped news reference.
    referenceDropped: !(imageWithRef && image.referenceUsed),
    logoIncluded: hasLogo,
  };
}

/** Re-exported so the listener CLI resolves the model default consistently. */
export { DEFAULT_IMAGE_MODEL };
