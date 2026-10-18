import { describe, expect, it } from 'vitest';
import { formatArticleLine, formatSourceLine } from './format.js';

describe('CLI summary formatting (terminal-escape hygiene)', () => {
  it('scrubs an OSC sequence out of a fetch-source error', () => {
    const line = formatSourceLine({
      source: 'ign',
      fetched: 0,
      inserted: 0,
      skipped: 0,
      failed: true,
      error: 'rss fetch failed for "ign": \u001B]0;spoof\u0007 socket hang up',
    });
    expect(line).not.toContain('\u001B');
    expect(line).toContain('FAILED');
    expect(line).toContain('socket hang up');
  });

  it('scrubs control bytes out of a non-failed fetch-source note', () => {
    const line = formatSourceLine({
      source: 'newsdata',
      fetched: 0,
      inserted: 0,
      skipped: 0,
      failed: false,
      error: 'note\x00with\x1Fcontrols',
    });
    // The line itself is tab-separated; the scrubbed status segment must be
    // control-free (scrub strips \t too, keeping \n as the line separator).
    const status = line.split('\t').pop() ?? '';
    expect(status).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
    expect(status).toBe('notewithcontrols');
  });

  it('prints ok for a source with no error', () => {
    const line = formatSourceLine({
      source: 'ign',
      fetched: 2,
      inserted: 1,
      skipped: 1,
      failed: false,
    });
    expect(line).toContain('ok');
  });

  it('scrubs an OSC sequence out of a writer article error', () => {
    const line = formatArticleLine({
      articleId: 7,
      ok: false,
      error: 'boom \u001B]0;spoof\u0007 happened',
    });
    expect(line).not.toContain('\u001B');
    expect(line).toContain('FAILED: article 7');
    expect(line).toContain('boom');
  });

  it('keeps the ok shape for a written article', () => {
    expect(formatArticleLine({ articleId: 7, ok: true, draftId: 3 })).toBe(
      'ok: article 7 -> draft 3',
    );
  });
});
