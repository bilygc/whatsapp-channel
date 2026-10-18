/**
 * Telegram caption-length guard.
 *
 * Telegram caps photo captions at 1024 chars (message text allows 4096, but
 * the cap is applied uniformly so the photo and text paths behave
 * identically). The writer cap (`MAX_CAPTION_CHARS = 1000` in
 * `src/writer/validate.ts`) already sits under it, so the truncation path
 * below only ever fires for legacy drafts written before the writer cap.
 *
 * Truncation shares `normalizeCaption()`'s rule (same helper, imported
 * from `src/writer/validate.ts`): the body is cut and the
 * canonical `Fuente:` attribution line is NEVER the part that gets cut off —
 * original captions with attribution are a project invariant.
 *
 * Two safety rules govern the cut itself:
 * - The body is always cut at a whitespace boundary, never mid-token: a
 *   sliced `https://news.examp…` would auto-linkify to a squatted domain.
 *   Cutting at whitespace also never splits an emoji surrogate pair.
 * - A caption with no detectable `Fuente:` line anywhere is NEVER blindly
 *   truncated (the old code cut the whole text and could ship a caption with
 *   no source link at all). It takes the typed-skip path instead — the draft
 *   stays `pending` for a human to look at.
 */
import { truncateBodyAtBoundary } from '../writer/validate.js';

export const TELEGRAM_CAPTION_LIMIT = 1024;

export type FitCaptionResult =
  | { ok: true; caption: string; truncated: boolean }
  | { ok: false; error: string };

function isAttributionLine(line: string): boolean {
  return /^fuente\s*:/i.test(line.trim());
}

/**
 * Fit a stored draft caption into Telegram's caption limit. Returns the
 * caption unchanged when it already fits; otherwise truncates the body and
 * re-appends the attribution line. A caption whose attribution ALONE exceeds
 * the limit — or that carries NO detectable attribution line at all — is a
 * typed skip (the draft stays `pending` for a human to look at): cutting the
 * attribution, or shipping a caption with no source link, would violate the
 * attribution invariant.
 */
export function fitCaptionForTelegram(
  raw: string,
  limit: number = TELEGRAM_CAPTION_LIMIT,
): FitCaptionResult {
  const text = raw.trim();
  if (text.length <= limit) return { ok: true, caption: text, truncated: false };

  const lines = text.split('\n');
  // Scan ALL lines, not just the last: a `Fuente:` line buried mid-caption
  // still counts as attribution worth preserving.
  let attribution: string | null = null;
  let attrIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isAttributionLine(lines[i])) {
      attribution = lines[i].trim();
      attrIndex = i;
      break;
    }
  }
  if (attribution === null) {
    // No attribution anywhere: blind truncation could ship a caption with no
    // source name/link (or a sliced mid-URL fragment) — leave it for a human
    // instead of sending a linkless caption.
    return {
      ok: false,
      error: `caption too long for telegram (${text.length} chars, no attribution line found; draft left pending for human review)`,
    };
  }
  if (attribution.length + 2 > limit) {
    return {
      ok: false,
      error: `caption too long for telegram (${text.length} chars, attribution alone exceeds the ${limit}-char caption limit)`,
    };
  }
  const body = lines
    .filter((_, i) => i !== attrIndex)
    .join('\n')
    .trim();
  const room = limit - attribution.length - 2; // blank line before Fuente
  if (room < 1 || body === '') return { ok: true, caption: attribution, truncated: true };
  // Boundary cut shared with the writer (`truncateBodyAtBoundary` in
  // `src/writer/validate.ts`): the body is always cut at whitespace, never
  // mid-token, so no partial `https://…` fragment survives the cut.
  const truncated = truncateBodyAtBoundary(body, room);
  if (truncated === '') return { ok: true, caption: attribution, truncated: true };
  return { ok: true, caption: `${truncated}\n\n${attribution}`, truncated: true };
}
