/**
 * Telegram caption-length guard.
 *
 * Telegram caps photo captions at 1024 chars; plain text messages allow
 * 4096. The photo path fits to `TELEGRAM_CAPTION_LIMIT`, the text path to
 * `TELEGRAM_MESSAGE_LIMIT` (the photo→text fallback keeps its photo-fitted
 * text, which always fits the larger text budget too). The writer cap
 * (`MAX_CAPTION_CHARS` in `src/writer/validate.ts`) may sit above the photo
 * cap, so the truncation path below fires for drafts the writer produced —
 * not just legacy rows.
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

/** Plain text messages (no photo) allow up to 4096 chars. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Labeled section separating the X/Twitter post from the WhatsApp caption
 * in the same Telegram message (Spanish, plaintext — no parse_mode).
 */
export const X_POST_SECTION_LABEL = '𝕏 Post para X:';

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

/**
 * Build the per-draft Telegram message: the WhatsApp caption first, then the
 * X/Twitter post under a labeled section — same message, so the operator
 * copy-pastes (or forwards) both from one place.
 *
 * Limit rule: the COMBINED text must fit `limit` (photo or text budget,
 * chosen by the caller). When it fits, both ship verbatim. When it does
 * NOT fit, the X post is NEVER truncated mid-tweet — it is short by design
 * (≤280 chars) — so the WhatsApp caption is shrunk into the remaining
 * budget instead (`limit - section.length`, via `fitCaptionForTelegram`,
 * which keeps the `Fuente:` attribution intact). A remainder too small for
 * the attribution (or an X section that alone exceeds the limit) is a typed
 * skip, like any other overlong caption: the draft stays `pending`.
 *
 * A NULL/empty/whitespace-only X post (the dedicated X LLM call failed)
 * omits the section entirely — the message is exactly `fitCaptionForTelegram`.
 */
export function buildTelegramMessage(
  rawCaption: string,
  xPost: string | null | undefined,
  limit: number = TELEGRAM_CAPTION_LIMIT,
): FitCaptionResult {
  const x = (xPost ?? '').trim();
  if (x === '') return fitCaptionForTelegram(rawCaption, limit);
  const section = `\n\n${X_POST_SECTION_LABEL}\n${x}`;
  if (section.length >= limit) {
    return {
      ok: false,
      error:
        `message too long for telegram (X section alone is ${section.length} chars, ` +
        `limit ${limit} — draft left pending for human review)`,
    };
  }
  const caption = rawCaption.trim();
  if (caption.length + section.length <= limit) {
    return { ok: true, caption: `${caption}${section}`, truncated: false };
  }
  const fit = fitCaptionForTelegram(rawCaption, limit - section.length);
  if (!fit.ok) return fit;
  return { ok: true, caption: `${fit.caption}${section}`, truncated: true };
}
