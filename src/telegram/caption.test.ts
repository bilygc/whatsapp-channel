import { describe, expect, it } from 'vitest';
import { MAX_CAPTION_CHARS } from '../writer/validate.js';
import {
  buildTelegramMessage,
  TELEGRAM_CAPTION_LIMIT,
  fitCaptionForTelegram,
  TELEGRAM_MESSAGE_LIMIT,
  X_POST_SECTION_LABEL,
} from './caption.js';

describe('telegram caption limit', () => {
  it('sits between the photo and text limits: writer drafts fit the text path untouched, photo path truncates', () => {
    // Writer cap (1500) exceeds the photo-caption limit (1024) but fits
    // inside the text-message limit (4096): a max-size writer draft passes
    // the text path through untouched, while the photo path truncates the
    // body and keeps the Fuente: attribution intact.
    expect(MAX_CAPTION_CHARS).toBeGreaterThan(TELEGRAM_CAPTION_LIMIT);
    expect(MAX_CAPTION_CHARS).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    const attribution = 'Fuente: IGN https://example.com/a';
    const draft = `${'Palabra '.repeat(180).trim()}\n\n${attribution}`;
    expect(draft.length).toBeGreaterThan(TELEGRAM_CAPTION_LIMIT);
    expect(draft.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    const textFit = fitCaptionForTelegram(draft, TELEGRAM_MESSAGE_LIMIT);
    expect(textFit.ok && !textFit.truncated).toBe(true);
    const photoFit = fitCaptionForTelegram(draft);
    expect(photoFit.ok).toBe(true);
    if (!photoFit.ok) return;
    expect(photoFit.truncated).toBe(true);
    expect(photoFit.caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(photoFit.caption.endsWith(attribution)).toBe(true);
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

describe('telegram message with X post section', () => {
  it('appends the labeled X section after the caption when both fit', () => {
    const caption = '🔥 Hola\n\nFuente: IGN https://example.com/a';
    const xPost = '🎮 ¡Hola! #Gaming';
    const msg = buildTelegramMessage(caption, xPost);
    expect(msg.ok).toBe(true);
    if (!msg.ok) return;
    expect(msg.truncated).toBe(false);
    expect(msg.caption).toBe(`${caption}\n\n${X_POST_SECTION_LABEL}\n${xPost}`);
  });

  it('omits the section for NULL, empty, or whitespace-only X posts', () => {
    const caption = '🔥 Hola\n\nFuente: IGN https://example.com/a';
    for (const x of [null, undefined, '', '   ']) {
      const msg = buildTelegramMessage(caption, x);
      expect(msg).toEqual(fitCaptionForTelegram(caption));
    }
  });

  it('over budget: truncates the WhatsApp caption and keeps the full X post', () => {
    const attribution = 'Fuente: IGN https://example.com/a';
    const xPost = '🎮 ¡Notición! #Gaming';
    const caption = `${'Palabra '.repeat(130).trim()}\n\n${attribution}`;
    const msg = buildTelegramMessage(caption, xPost, 1024);
    expect(msg.ok).toBe(true);
    if (!msg.ok) return;
    expect(msg.truncated).toBe(true);
    expect(msg.caption.length).toBeLessThanOrEqual(1024);
    expect(msg.caption.endsWith(`\n\n${X_POST_SECTION_LABEL}\n${xPost}`)).toBe(true);
    expect(msg.caption).toContain(attribution);
  });

  it('over budget with no attribution: typed skip, never a linkless send', () => {
    const msg = buildTelegramMessage('B'.repeat(1500), '🎮 ¡Hola! #Gaming', 1024);
    expect(msg.ok).toBe(false);
    if (msg.ok) return;
    expect(msg.error).toMatch(/attribution/);
  });

  it('exposes the 4096 text-message limit alongside the 1024 photo-caption limit', () => {
    expect(TELEGRAM_MESSAGE_LIMIT).toBe(4096);
    expect(TELEGRAM_CAPTION_LIMIT).toBe(1024);
  });
});
