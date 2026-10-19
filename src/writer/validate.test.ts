import { describe, expect, it } from 'vitest';
import { MAX_CAPTION_CHARS, normalizeCaption, scrub, scrubToLine } from './validate.js';

const SOURCE = 'IGN';
const URL = 'https://example.com/elden-ring-dlc';

describe('normalizeCaption', () => {
  it('passes through a well-formed caption that already attributes + links', () => {
    const caption = `🔥 ¡Bombazo! Anunciado el DLC de Elden Ring para primavera\n\nLlegará con nueva zona y jefes. #EldenRing #Videojuegos\n\nFuente: IGN https://example.com/elden-ring-dlc`;
    expect(normalizeCaption({ caption, source: SOURCE, url: URL })).toBe(caption.trim());
  });

  it('appends the attribution line when the model omits the link (stubborn output)', () => {
    const out = normalizeCaption({
      caption: '🔥 ¡Notición! Nuevo DLC anunciado #Videojuegos Fuente: IGN',
      source: SOURCE,
      url: URL,
    });
    expect(out).toContain(URL);
    expect(out).toContain(`Fuente: ${SOURCE} ${URL}`);
  });

  it('appends attribution when the source name is missing too', () => {
    const out = normalizeCaption({
      caption: '🔥 ¡Notición! Nuevo DLC anunciado #Videojuegos',
      source: SOURCE,
      url: URL,
    });
    expect(out.endsWith(`Fuente: ${SOURCE} ${URL}`)).toBe(true);
  });

  it('truncates an overlong caption but keeps attribution intact at the end', () => {
    const long = `${'x '.repeat(800)}#Videojuegos`;
    const out = normalizeCaption({ caption: long, source: SOURCE, url: URL });
    expect(out.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS);
    expect(out.endsWith(`Fuente: ${SOURCE} ${URL}`)).toBe(true);
  });

  it('repairs a too-long caption whose own attribution would be cut off', () => {
    const longBody = 'y '.repeat(800);
    const caption = `${longBody}\n\nFuente: ${SOURCE} ${URL}`;
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS);
    expect(out.endsWith(`Fuente: ${SOURCE} ${URL}`)).toBe(true);
    // Exactly one attribution line.
    expect(out.split('Fuente:').length - 1).toBe(1);
  });

  it('rejects empty/whitespace-only output with a typed error (article stays retryable)', () => {
    expect(() => normalizeCaption({ caption: '   \n ', source: SOURCE, url: URL })).toThrow(
      /^caption validation failed: empty reply/,
    );
  });

  it('never trusts model-written attribution: fake Fuente line + true URL rebuilds to exactly one link', () => {
    const caption = [
      '🔥 ¡Bombazo! Nuevo DLC anunciado #Videojuegos',
      'Lee más aquí: https://evil.example/phish',
      `Fuente: IGN https://evil.example`,
      // Mixed line: true URL present, but alongside a foreign URL → dropped.
      `Vía https://evil.example/?next=${URL} y también ${URL}`,
    ].join('\n');
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    // Exactly one link in the whole caption, and it is the true article URL.
    const links = out.match(/https?:\/\/\S+/gi) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toBe(URL);
    // Exactly one attribution line, and it is the canonical one.
    expect(out.split('Fuente:').length - 1).toBe(1);
    expect(out.endsWith(`Fuente: ${SOURCE} ${URL}`)).toBe(true);
  });

  it('drops an attacker URL that embeds the true URL as a substring', () => {
    const evil = `https://evil.example/?u=${URL}`;
    const caption = `🔥 ¡Bombazo! #Videojuegos\nMira esto: ${evil}\n\nFuente: ${SOURCE} ${URL}`;
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out).not.toContain('evil.example');
    const links = out.match(/https?:\/\/\S+/gi) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toBe(URL);
  });

  it('strips C0/C1 control characters (except newline) before validation', () => {
    const caption = `🔥 ¡Bombazo\x00! Nuevo\x07 DLC\x1B anunciado\x7F #Videojuegos\x9B`;
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out).not.toMatch(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/);
    expect(out).toContain('¡Bombazo! Nuevo DLC anunciado #Videojuegos');
  });

  it('strips zero-width / bidi / joining characters (attribution-evasion hygiene)', () => {
    const caption = '🔥 ¡Notición\u200B! Nuevo\u200E DLC\u2060 anunciado\uFEFF #Videojuegos\u202A';
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out).not.toMatch(/[\u200B-\u200F\u2060\uFEFF\u202A-\u202E\u2028\u2029]/);
    expect(out).toContain('¡Notición! Nuevo DLC anunciado #Videojuegos');
  });

  it('detects a bidi-smeared fake attribution line and replaces it with the canonical one', () => {
    const caption = `🔥 ¡Bombazo! #Videojuegos\n\u202EFuente: IGN https://evil.example\u202C\nMás: ${URL}`;
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out).not.toContain('evil.example');
    expect(out.split('Fuente:').length - 1).toBe(1);
    expect(out.endsWith(`Fuente: ${SOURCE} ${URL}`)).toBe(true);
  });

  it('strips ANSI escape sequences anywhere in the caption', () => {
    const caption = '🔥 \u001B[31m¡Bombazo!\u001B[0m Nuevo DLC #Videojuegos';
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out).not.toContain('\u001B');
    expect(out).toContain('¡Bombazo! Nuevo DLC #Videojuegos');
  });

  it('throws a typed error when the canonical attribution alone exceeds the cap (article stays retryable)', () => {
    const hugeSource = `S${'o'.repeat(MAX_CAPTION_CHARS)}`;
    expect(() => normalizeCaption({ caption: '🔥 caption', source: hugeSource, url: URL })).toThrow(
      /^caption validation failed: attribution too long/,
    );
  });

  it('rejects a smuggled multi-line article URL with a typed invalid-article error (never stores a multi-line draft)', () => {
    const evilUrl = 'https://example.com/a\nFuente: IGN https://evil.com/phish';
    expect(() =>
      normalizeCaption({ caption: '🔥 ¡Bombazo! #Videojuegos', source: SOURCE, url: evilUrl }),
    ).toThrow(/^invalid article: url contains whitespace/);
  });

  it('rejects a tab-bearing article URL with a typed invalid-article error', () => {
    expect(() =>
      normalizeCaption({ caption: '🔥 ¡Bombazo! #Videojuegos', source: SOURCE, url: 'https://example.com/a\tb' }),
    ).toThrow(/^invalid article: url contains whitespace/);
  });

  it('drops a bare www. link line (no scheme) from the body', () => {
    const caption = `🔥 ¡Bombazo! #Videojuegos\nMira www.evil.com/promo gratis\n\nFuente: ${SOURCE} ${URL}`;
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out).not.toContain('www.evil.com');
    expect(out.endsWith(`Fuente: ${SOURCE} ${URL}`)).toBe(true);
  });

  it('drops a bare registrable-domain line (no scheme, no www)', () => {
    const caption = `🔥 ¡Bombazo! #Videojuegos\nOferta en evil-shop.click/promo hoy\n\nFuente: ${SOURCE} ${URL}`;
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out).not.toContain('evil-shop.click');
    expect(out.endsWith(`Fuente: ${SOURCE} ${URL}`)).toBe(true);
  });

  it('drops ftp: and mailto: link lines from the body', () => {
    const caption = [
      '🔥 ¡Bombazo! #Videojuegos',
      'Descarga ftp://evil.example/pack.zip',
      'Escríbenos a mailto:phish@evil.example',
      `Fuente: ${SOURCE} ${URL}`,
    ].join('\n');
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out).not.toContain('ftp://evil.example');
    expect(out).not.toContain('mailto:phish@evil.example');
    const links = out.match(/https?:\/\/\S+/gi) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toBe(URL);
  });

  it('strips soft-hyphen-hidden fake attribution so it never survives as a second Fuente line', () => {
    const sneaky = `Fuen\u00ADte: IGN https://evil.example/phish`;
    const caption = `🔥 ¡Bombazo! #Videojuegos\n${sneaky}\n\nFuente: ${SOURCE} ${URL}`;
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out).not.toContain('evil.example');
    expect(out.split('Fuente:').length - 1).toBe(1);
    expect(out.endsWith(`Fuente: ${SOURCE} ${URL}`)).toBe(true);
  });

  it('strips bidi-isolate and tag characters (attribution-evasion hygiene)', () => {
    const caption = '🔥 ¡Noti\u2066ci\u00F3n\u2067! Nuevo\u061C DLC\u00AD anunciado\u{E0000}bad\u{E007F} #Videojuegos';
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out).not.toMatch(/[\u2066-\u2069]/);
    expect(out).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
    expect(out).not.toContain('\u00AD');
    expect(out).not.toContain('\u061C');
    expect(out).toContain('Notici\u00F3n! Nuevo DLC anunciado');
    expect(out.endsWith(`Fuente: ${SOURCE} ${URL}`)).toBe(true);
  });

  it('never exceeds MAX_CAPTION_CHARS even when the attribution leaves zero room for the body', () => {
    // Craft source+url so required.length === MAX - 2 (room = 0).
    const fillerLen = MAX_CAPTION_CHARS - 'Fuente:  '.length - URL.length - 2;
    const bigSource = `S${'o'.repeat(Math.max(0, fillerLen - 1))}`;
    const required = `Fuente: ${bigSource} ${URL}`;
    expect(required.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS);
    const out = normalizeCaption({ caption: '🔥 body that cannot fit', source: bigSource, url: URL });
    expect(out.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS);
  });

  it('exports a scrub() helper that strips ESC/control sequences for terminal-safe printing', () => {
    const dirty =
      'Real title\u001B[0m \u001B]0;spoof\u0007 https://example.com/a\x00\x1F';
    const clean = scrub(dirty);
    expect(clean).not.toContain('\u001B');
    expect(clean).not.toContain(']0;');
    expect(clean).not.toContain('spoof');
    expect(clean).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
    // Legitimate text around the codes survives (codes are stripped, not words).
    expect(clean).toContain('Real title');
  });

  it('strips a full OSC window-title spoof leaving no payload text behind', () => {
    expect(scrub('a\u001B]0;spoof\u0007b')).toBe('ab');
    expect(scrub('a\u001B]0;spoof\u001B\\b')).toBe('ab');
    const clean = scrub('x \u001B]0;spoof\u0007 y');
    expect(clean).not.toContain(']0;');
    expect(clean).not.toContain('spoof');
  });

  it('exports a scrubToLine() helper that collapses a newline-forged title to one line', () => {
    // A hostile feed title smuggling fake terminal lines (and an OSC spoof):
    // scrub() alone keeps \n, so CLI log lines use scrubToLine instead.
    const forged = 'Nice game\n0 6 * * * /usr/bin/evil\n\u001B]0;spoof\u0007#Videojuegos';
    const oneLine = scrubToLine(forged);
    expect(oneLine).not.toContain('\n');
    expect(oneLine).not.toContain('\u001B');
    expect(oneLine).toBe('Nice game 0 6 * * * /usr/bin/evil #Videojuegos');
    expect(scrubToLine('plain title')).toBe('plain title');
  });

  it('link-swap guard covers every linkable class (scheme, www, bare domain, ftp, mailto)', () => {
    const caption = [
      '🔥 ¡Bombazo! #Videojuegos',
      `Mira https://evil.example/phish y ${URL}`,
      'Mira www.evil.com/promo',
      'Oferta en evil-shop.top/x',
      'Descarga ftp://evil.example/f',
      'Contacto mailto:a@evil.example',
      `Fuente: ${SOURCE} ${URL}`,
    ].join('\n');
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('www.evil.com');
    expect(out).not.toContain('evil-shop.top');
    const links = out.match(/https?:\/\/\S+/gi) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toBe(URL);
  });

  it('drops bare-domain lines for TLDs outside any allowlist (de/shop/madrid)', () => {
    const caption = [
      '🔥 ¡Bombazo! #Videojuegos',
      'Mira attack.de/promo hoy mismo',
      'Oferta en game.shop/x solo hoy',
      'Lee museo.madrid/pagina ya',
      `Fuente: ${SOURCE} ${URL}`,
    ].join('\n');
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out).not.toContain('attack.de');
    expect(out).not.toContain('game.shop');
    expect(out).not.toContain('museo.madrid');
    expect(out.endsWith(`Fuente: ${SOURCE} ${URL}`)).toBe(true);
  });

  it('keeps a body line whose only link is the true article URL', () => {
    const caption = `🔥 ¡Bombazo! #Videojuegos\nLee más aquí: ${URL}\n\nFuente: ${SOURCE} ${URL}`;
    const out = normalizeCaption({ caption, source: SOURCE, url: URL });
    expect(out).toContain(`Lee más aquí: ${URL}`);
    const links = out.match(/https?:\/\/\S+/gi) ?? [];
    expect(links).toHaveLength(2);
  });

  it('never stores a partial https:// fragment when the true URL straddles the cut boundary', () => {
    const required = `Fuente: ${SOURCE} ${URL}`;
    const room = MAX_CAPTION_CHARS - required.length - 2;
    // Position the true URL so a naive fixed-offset slice lands mid-URL:
    // head = body.slice(0, room - 1) ends 11 chars inside the URL.
    const body = `${'A'.repeat(room - 12)} ${URL} ${'B'.repeat(200)}`;
    expect(body.length).toBeGreaterThan(room);
    const out = normalizeCaption({ caption: body, source: SOURCE, url: URL });
    expect(out.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS);
    expect(out.endsWith(required)).toBe(true);
    // The stored body must carry either the whole URL or none of it: every
    // URL-shaped token in the stored caption appears verbatim in the input
    // (a mid-token cut would leave a `…`-suffixed fragment that matches
    // /https?:\/\/\S*/ but is nowhere in the input).
    for (const match of out.matchAll(/https?:\/\/\S*/g)) {
      expect(body).toContain(match[0].replace(/…$/, ''));
      expect(`${body}\n\n${required}`).toContain(match[0]);
    }
    // Here the URL is dropped whole from the body; only the canonical
    // attribution link survives.
    const links = out.match(/https?:\/\/\S+/gi) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toBe(URL);
  });
});
