import type { SourceResult } from '../fetcher/run.js';
import type { DraftSendResult } from '../telegram/send.js';
import type { ArticleResult } from '../writer/run.js';
import { sanitizeTelegram } from '../telegram/api.js';
import { scrubToLine } from '../writer/validate.js';

/**
 * One line of the `npm run fetch` summary. Feed-controlled error strings
 * (sax/JSON.parse failures embed feed bytes) are printed through
 * `scrubToLine()` — the single-LINE variant — so a CSI/OSC sequence cannot
 * spoof terminal output and a smuggled newline cannot forge extra review-gate
 * lines. Stored captions keep `scrub()` (multi-line content); these one-line
 * summaries never do.
 */
export function formatSourceLine(s: SourceResult): string {
  const status = s.failed ? `FAILED: ${scrubToLine(s.error ?? '')}` : s.error ? scrubToLine(s.error) : 'ok';
  return `${s.source}\t${s.fetched}\t${s.inserted}\t${s.skipped}\t${status}`;
}

/**
 * One line of the `npm run write` summary. Same escape hygiene: writer
 * errors can carry LLM-echoed article bytes.
 */
export function formatArticleLine(r: ArticleResult): string {
  return r.ok
    ? `ok: article ${r.articleId} -> draft ${r.draftId}`
    : `FAILED: article ${r.articleId}: ${scrubToLine(r.error ?? '')}`;
}

/**
 * One line for a CLI top-level `main().catch` (the last-resort handler after
 * `main()` itself threw). The error may echo request details carrying the
 * bot token, so it goes through `sanitizeTelegram()` with the RESOLVED
 * (trimmed) token — the same form URLs are built with — then `scrubToLine()`
 * before it reaches the terminal. Pass `token ?? ''` at the call site.
 */
export function formatCliFailure(area: string, err: unknown, token: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `${area} failed: ${scrubToLine(sanitizeTelegram(msg, token))}`;
}

/**
 * One line of the `npm run telegramSend` summary. Send errors can echo
 * Telegram descriptions and (sanitized) transport text, so the line goes
 * through `scrubToLine()` like the other summary formatters. A race-lost
 * draft (a concurrent run won the send-once stamp) renders as `skipped:` —
 * never `FAILED:` — since it is not a retryable failure.
 */
export function formatDraftSendLine(r: DraftSendResult): string {
  if (r.skipped) {
    return `skipped: draft ${r.draftId} (already sent — not re-sent)`;
  }
  if (r.ok) {
    const via = r.via === 'photo' ? 'photo' : 'message';
    const extra = [r.fallback ? 'fallback' : '', r.truncated ? 'truncated' : '']
      .filter(Boolean)
      .join(',');
    return `ok: draft ${r.draftId} -> ${via}${extra ? ` (${extra})` : ''}`;
  }
  return `FAILED: draft ${r.draftId}: ${scrubToLine(r.error ?? '')}`;
}
