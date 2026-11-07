import { describe, expect, it } from 'vitest';
import { formatDraftPreview, type DraftPreviewRow } from './preview-drafts.js';

function row(overrides: Partial<DraftPreviewRow> = {}): DraftPreviewRow {
  return {
    id: 1,
    status: 'pending',
    caption_es: '🔥 ¡Bombazo! Nuevo DLC anunciado #Videojuegos\n\nFuente: IGN https://example.com/a',
    x_post_es: '¡Bombazo! Nuevo DLC #Videojuegos\n\nFuente: IGN https://example.com/a',
    created_at: '2026-10-17T12:00:00.000Z',
    title: 'Elden Ring DLC announced',
    source: 'IGN',
    url: 'https://example.com/a',
    ...overrides,
  };
}

describe('formatDraftPreview', () => {
  it('prints both the caption and the X post as labeled blocks', () => {
    const out = formatDraftPreview(row());
    expect(out).toContain('--- caption (paste-ready) ---');
    expect(out).toContain('🔥 ¡Bombazo! Nuevo DLC anunciado #Videojuegos');
    expect(out).toContain('X post');
    expect(out).toContain('¡Bombazo! Nuevo DLC #Videojuegos');
    // The X block comes after the caption block.
    expect(out.indexOf('X post')).toBeGreaterThan(out.indexOf('--- caption (paste-ready) ---'));
  });

  it('marks a missing X post instead of printing null/undefined', () => {
    const out = formatDraftPreview(row({ x_post_es: null }));
    expect(out).toContain('X post');
    expect(out).toContain('(no X post yet)');
    expect(out).not.toContain('null');
    expect(out).not.toContain('undefined');
    // The caption still prints.
    expect(out).toContain('🔥 ¡Bombazo!');
  });

  it('single-line scrubs hostile feed fields so they cannot forge terminal lines', () => {
    const out = formatDraftPreview(
      row({ title: 'Nice game\n0 6 * * * /usr/bin/evil', source: 'IGN', url: 'https://example.com/a' }),
    );
    expect(out).toContain('Article: Nice game 0 6 * * * /usr/bin/evil');
    expect(out).not.toContain('Article: Nice game\n0 6');
  });

  it('scrubs control/escape sequences out of the printed caption and X post', () => {
    const out = formatDraftPreview(
      row({
        caption_es: 'Real caption\x00\u001B[31m red',
        x_post_es: 'Real post\u001B]0;spoof\x07 text',
      }),
    );
    expect(out).not.toContain('\u001B');
    expect(out).not.toContain('spoof');
    expect(out).toContain('Real caption');
    expect(out).toContain('Real post');
  });
});
