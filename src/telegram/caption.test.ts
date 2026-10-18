import { describe, expect, it } from 'vitest';
import { MAX_CAPTION_CHARS } from '../writer/validate.js';
import { TELEGRAM_CAPTION_LIMIT, fitCaptionForTelegram } from './caption.js';

describe('telegram caption limit', () => {
  it('sits above the writer cap, so writer drafts always fit untouched', () => {
    expect(MAX_CAPTION_CHARS).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    const body = `🔥 Noticia\n\n${'x'.repeat(900)}\n\nFuente: IGN https://example.com/a`;
    const fit = fitCaptionForTelegram(body.slice(0, MAX_CAPTION_CHARS));
    expect(fit.ok && !fit.truncated).toBe(true);
  });

  it('passes short captions through unchanged', () => {
    const caption = '🔥 Hola\n\nFuente: IGN https://example.com/a';
    expect(fitCaptionForTelegram(caption)).toEqual({ ok: true, caption, truncated: false });
  });

  it('truncates a legacy overlong caption keeping the attribution line intact', () => {
    const attribution = 'Fuente: IGN https://example.com/very-long-article-slug-here';
    const caption = `${'A'.repeat(1500)}\n\n${attribution}`;
    const fit = fitCaptionForTelegram(caption);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.truncated).toBe(true);
    expect(fit.caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(fit.caption.endsWith(attribution)).toBe(true);
    expect(fit.caption).toContain('…');
  });

  it('falls back to the attribution alone when the body leaves no room', () => {
    const attribution = 'Fuente: IGN https://example.com/a';
    const fit = fitCaptionForTelegram(`x\n\n${attribution}`, attribution.length + 2);
    expect(fit).toEqual({ ok: true, caption: attribution, truncated: true });
  });

  it('returns a typed skip when the attribution alone exceeds the limit', () => {
    const caption = `body\n\nFuente: IGN https://example.com/${'x'.repeat(2000)}`;
    const fit = fitCaptionForTelegram(caption);
    expect(fit.ok).toBe(false);
    if (fit.ok) return;
    expect(fit.error).toMatch(/attribution/);
  });

  it('leaves overlong captions with NO attribution line for a human (typed skip, stays pending)', () => {
    const fit = fitCaptionForTelegram('B'.repeat(1500));
    expect(fit.ok).toBe(false);
    if (fit.ok) return;
    expect(fit.error).toMatch(/attribution/);
  });

  it('never leaves a partial https:// fragment when cutting the body', () => {
    const attribution = 'Fuente: IGN https://example.com/a';
    // Body crafted so a naive fixed-offset slice lands mid-URL.
    const body = `${'A'.repeat(950)} https://news.example/very-long-article-slug-that-runs-past-the-limit ${'B'.repeat(200)}`;
    const fit = fitCaptionForTelegram(`${body}\n\n${attribution}`);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.truncated).toBe(true);
    expect(fit.caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(fit.caption.endsWith(attribution)).toBe(true);
    // No whitespace-split URL token may survive: every https?:// occurrence
    // must appear verbatim in the input (i.e. the cut happened at
    // whitespace, dropping the partial token whole), never a mid-token slice.
    for (const match of fit.caption.matchAll(/https?:\/\/\S*/g)) {
      expect(`${body}\n\n${attribution}`).toContain(match[0]);
    }
  });

  it('cuts the body at a whitespace boundary, not mid-token', () => {
    const attribution = 'Fuente: IGN https://example.com/a';
    const body = `word ${'x'.repeat(TELEGRAM_CAPTION_LIMIT)} tail`;
    const fit = fitCaptionForTelegram(`${body}\n\n${attribution}`);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    // The giant token must be dropped whole (cut at the space before it),
    // not sliced into a partial fragment.
    expect(fit.caption).not.toMatch(/x{10}/);
    expect(fit.caption.endsWith(attribution)).toBe(true);
  });

  it('preserves attribution even when the Fuente: line is not the last line', () => {
    const attribution = 'Fuente: IGN https://example.com/a';
    const caption = `${'C'.repeat(1100)}\n\n${attribution}\ntrailing junk line`;
    const fit = fitCaptionForTelegram(caption);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.truncated).toBe(true);
    expect(fit.caption).toContain(attribution);
    expect(fit.caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
  });

  it('never splits an emoji surrogate pair when truncating', () => {
    const attribution = 'Fuente: IGN https://example.com/a';
    const body = `${'🎮'.repeat(600)}\nfinal words here`;
    const fit = fitCaptionForTelegram(`${body}\n\n${attribution}`);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    // Lone surrogates would indicate a split multi-byte character.
    // eslint-disable-next-line no-misleading-character-class
    expect(fit.caption).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(fit.caption).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(fit.caption.endsWith(attribution)).toBe(true);
  });
});
