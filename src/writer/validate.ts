/** Maximum caption length (see prompts.ts SYSTEM_PROMPT — kept in sync). */

/** WhatsApp-caption ceiling: keep drafts paste-ready without manual trimming. */
export const MAX_CAPTION_CHARS = 1000;

export interface ValidateInput {
  caption: string;
  source: string;
  url: string;
}

/** Any linkable token in a body line: full URLs, mailto:, www. hosts, bare domains. */
const FOREIGN_RE =
  /(?:https?|ftp):\/\/\S+|mailto:\S+|\bwww\.\S+|\b[\w-]+(?:\.[\w-]+){0,10}\.[a-z]{2,}\b(?:\/\S*)?/gi;

/** C0/C1 control characters, except newline (kept as the line separator). */
const CONTROL_RE = /[\x00-\x09\x0B-\x1F\x7F-\x9F]/g;

/**
 * Zero-width / bidi / joining / line-separator characters, plus soft hyphen
 * (U+00AD), bidi isolates (U+2066-U+2069), Arabic letter mark (U+061C), and
 * tag characters (U+E0000-U+E007F). These are invisible but can smear a fake
 * `Fuente:` line past a naive prefix check (bidi override) or hide an
 * attacker URL, so they are stripped before validation.
 */
const INVISIBLE_RE = /[\u200B-\u200F\u2060\uFEFF\u202A-\u202E\u2028\u2029\u00AD\u061C\u2066-\u2069\u{E0000}-\u{E007F}]/gu;

/** ANSI escape sequences (e.g. SGR color codes) — never part of a caption. */
const ANSI_RE = /\u001B\[[0-?]*[ -\/]*[@-~]/g;

/** Lines the model may have used as its own (possibly mangled) attribution. */
function isAttributionLine(line: string): boolean {
  return /^fuente\s*:/i.test(line.trim());
}

/**
 * Strip invisible/control characters and ANSI escapes from a raw caption.
 * Runs BEFORE any validation so smuggled bytes cannot evade the attribution
 * or URL checks below. Exported for the CLIs, which print remote-controlled
 * feed fields to a terminal (an OSC sequence could otherwise spoof or
 * overwrite terminal output and undermine the human review gate).
 */
export function scrub(text: string): string {
  return text.replace(ANSI_RE, '').replace(CONTROL_RE, '').replace(INVISIBLE_RE, '');
}

/**
 * Cut `body` to `room` chars (including the trailing `…`), always at a
 * whitespace boundary so no partial token survives the cut. Dropping a
 * partial token whole is what keeps a sliced `https://…` fragment out of
 * the stored caption — a truncated link would auto-linkify to a squatted
 * domain. As a side effect a surrogate pair (emoji) is never split either.
 * A body with no whitespace boundary is a single giant token: it is
 * dropped whole when URL-shaped (a lone URL is not body copy worth a
 * partial link), otherwise hard-cut without leaving a lone surrogate.
 *
 * Shared with the Telegram sender (`src/telegram/caption.ts`), which
 * applies the same rule to legacy drafts: this lives here (not in
 * telegram/) so the writer never imports from the delivery layer.
 */
export function truncateBodyAtBoundary(body: string, room: number): string {
  if (body.length <= room) return body;
  const head = body.slice(0, room - 1); // reserve 1 char for '…'
  const cutAt = head.search(/\s\S*$/);
  if (cutAt > 0) return `${head.slice(0, cutAt).trimEnd()}…`;
  if (/https?:\/\//i.test(head) || /^www\./i.test(head)) return '';
  // Hard cut of a non-URL token: never leave a lone surrogate behind.
  const safe = /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
  return `${safe}…`;
}

/**
 * A body line survives only when it carries no foreign links: every linkable
 * token in the line must equal the true article URL (trailing punctuation
 * trimmed). A line with zero linkable tokens always survives. This
 * intentionally matches the whole `https://evil.example/?u=<true-url>` blob
 * as one foreign URL and drops it.
 *
 * Tradeoff: the bare-domain alternative is deliberately aggressive — any
 * `word.tld[/path]`-shaped token drops its line (e.g. `attack.de/promo`,
 * `game.shop/x`, or even `version.txt`-like lookalikes). That is safe here
 * because captions are short and the canonical attribution line below always
 * carries the true link; a dropped line only ever costs body copy, never the
 * attribution.
 */
function isCleanBodyLine(line: string, trueUrl: string): boolean {
  FOREIGN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FOREIGN_RE.exec(line)) !== null) {
    const candidate = m[0].replace(/[.,;:!?)"'\]]+$/g, '');
    if (candidate !== trueUrl) return false;
  }
  return true;
}

/**
 * Validate + normalize a raw LLM caption before it touches the DB.
 * Second line of defense after the system prompt (which model output may
 * ignore): guarantees the stored draft ALWAYS carries the source name and
 * article link, within MAX_CAPTION_CHARS.
 *
 * Model-written links and attribution are NEVER trusted — the caption is
 * ALWAYS rebuilt from the cleaned body plus the canonical
 * `Fuente: <source> <url>` line:
 * - Invisible/control characters and ANSI escapes are scrubbed first.
 * - Model-written `Fuente:` lines are stripped (they may carry fake URLs).
 * - Body lines bearing any URL other than the true article URL are dropped
 *   (link-swap guard); the canonical attribution re-adds the true link.
 * - Overlong: truncate the body, then append canonical attribution so it
 *   is never the part that gets cut off (exactly one attribution line).
 * - Empty output, or an attribution line that alone exceeds the cap, is a
 *   retryable failure (typed error; the article stays `selected` so a later
 *   run can retry).
 */
export function normalizeCaption(input: ValidateInput): string {
  const text = scrub(input.caption).trim();
  if (text === '') {
    throw new Error('caption validation failed: empty reply');
  }

  // The article URL/source are stored DB values, not model output — but a
  // legacy row may carry a smuggled multi-line URL (ingest now rejects these;
  // see canonical.ts). Scrub, then reject whitespace/control-bearing URLs
  // outright: appending one raw would plant the attacker's `Fuente:` line and
  // live phishing link in the stored draft. The article stays retryable.
  // `source` here is safe to re-emit verbatim only because it comes from
  // our own `feeds.ts` config (RSS) or the literal 'newsdata' — never from
  // feed-controlled content (cf. title/url, which are untrusted and scrubbed
  // above). If M3 ever accepts a source name from a remote payload, it must
  // be allowlisted here before reaching the draft.
  const cleanSource = scrub(input.source).trim();
  const cleanUrl = scrub(input.url).trim();
  // Mirror the ingest rule (canonical.ts): the trimmed raw URL must not
  // contain control/inner-whitespace, and nothing whitespace-like may survive
  // scrubbing (a surviving \n would split the attribution line). Either way
  // the article is invalid yet retryable — never a multi-line draft.
  if (cleanUrl === '' || /[\x00-\x20\x7F]/.test(input.url.trim()) || /\s/.test(cleanUrl)) {
    throw new Error('invalid article: url contains whitespace/control characters');
  }

  const required = `Fuente: ${cleanSource} ${cleanUrl}`;
  if (required.length + 2 > MAX_CAPTION_CHARS) {
    throw new Error('caption validation failed: attribution too long');
  }

  // Strip any model-written attribution lines and drop URL-bearing foreign
  // lines; we unconditionally re-append the canonical attribution below.
  const bodyLines = text
    .split('\n')
    .filter((line) => !isAttributionLine(line))
    .filter((line) => isCleanBodyLine(line, cleanUrl));
  const body = bodyLines.join('\n').trim();

  const room = MAX_CAPTION_CHARS - required.length - 2; // blank line before Fuente
  if (room < 1) return required;
  // Boundary cut (shared with the Telegram sender): never store a partial
  // `https://…` fragment — the true URL is dropped whole here and re-added
  // verbatim in the canonical attribution below.
  const truncated = truncateBodyAtBoundary(body, room);
  if (truncated === '') return required;
  return `${truncated}\n\n${required}`;
}
