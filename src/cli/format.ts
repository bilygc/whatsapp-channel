import type { SourceResult } from '../fetcher/run.js';
import type { DraftSendResult } from '../telegram/send.js';
import type { ArticleResult } from '../writer/run.js';
import { sanitizeTelegram } from '../telegram/api.js';
import { scrub } from '../writer/validate.js';

/**
 * One line of the `npm run fetch` summary. Feed-controlled error strings
 * (sax/JSON.parse failures embed feed bytes) are printed through `scrub()`
 * so a CSI/OSC sequence cannot spoof terminal output and undermine the
 * human review gate.
 */
export function formatSourceLine(s: SourceResult): string {
  const status = s.failed ? `FAILED: ${scrub(s.error ?? '')}` : s.error ? scrub(s.error) : 'ok';
  return `${s.source}\t${s.fetched}\t${s.inserted}\t${s.skipped}\t${status}`;
}

/**
 * One line of the `npm run write` summary. Same escape hygiene: writer
 * errors can carry LLM-echoed article bytes.
 */
export function formatArticleLine(r: ArticleResult): string {
  return r.ok
    ? `ok: article ${r.articleId} -> draft ${r.draftId}`
    : `FAILED: article ${r.articleId}: ${scrub(r.error ?? '')}`;
}

/**
 * One line for a CLI top-level `main().catch` (the last-resort handler after
 * `main()` itself threw). The error may echo request details carrying the
 * bot token, so it goes through `sanitizeTelegram()` with the RESOLVED
 * (trimmed) token — the same form URLs are built with — then `scrub()`
 * before it reaches the terminal. Pass `token ?? ''` at the call site.
 */
export function formatCliFailure(area: string, err: unknown, token: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `${area} failed: ${scrub(sanitizeTelegram(msg, token))}`;
}

/**
 * One line of the `npm run telegramSend` summary. Send errors can echo
 * Telegram descriptions and (sanitized) transport text, so the line goes
 * through `scrub()` like the other summary formatters.
 */
export function formatDraftSendLine(r: DraftSendResult): string {
  if (r.ok) {
    const via = r.via === 'photo' ? 'photo' : 'message';
    const extra = [r.fallback ? 'fallback' : '', r.truncated ? 'truncated' : '']
      .filter(Boolean)
      .join(',');
    return `ok: draft ${r.draftId} -> ${via}${extra ? ` (${extra})` : ''}`;
  }
  return `FAILED: draft ${r.draftId}: ${scrub(r.error ?? '')}`;
}
