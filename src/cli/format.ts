import type { SourceResult } from '../fetcher/run.js';
import type { ArticleResult } from '../writer/run.js';
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
