import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, hashCanonicalUrl } from './canonical.js';

describe('canonicalizeUrl', () => {
  it('lowercases scheme and host', () => {
    expect(canonicalizeUrl('HTTPS://WWW.IGN.COM/articles/x')).toBe(
      'https://www.ign.com/articles/x',
    );
  });

  it('strips the fragment', () => {
    expect(canonicalizeUrl('https://example.com/a#b')).toBe('https://example.com/a');
  });

  it('strips common tracking params but keeps real ones', () => {
    expect(
      canonicalizeUrl('https://example.com/a?utm_source=x&fbclid=y&id=42&utm_medium=z'),
    ).toBe('https://example.com/a?id=42');
  });

  it.each(['gclid', 'msclkid', 'igshid', 'mc_cid', 'mc_eid', 'ref', '_ga'])(
    'strips tracking param %s',
    (param) => {
      expect(canonicalizeUrl(`https://example.com/a?${param}=1&p=2`)).toBe(
        'https://example.com/a?p=2',
      );
    },
  );

  it('strips any utm_* param', () => {
    expect(canonicalizeUrl('https://example.com/a?utm_foo=1&p=2')).toBe(
      'https://example.com/a?p=2',
    );
  });

  it('sorts remaining query params for stable output', () => {
    expect(canonicalizeUrl('https://example.com/a?b=2&a=1')).toBe(
      'https://example.com/a?a=1&b=2',
    );
  });

  it('removes default ports', () => {
    expect(canonicalizeUrl('https://example.com:443/a')).toBe('https://example.com/a');
    expect(canonicalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
  });

  it('drops a trailing slash on non-root paths', () => {
    expect(canonicalizeUrl('https://example.com/a/')).toBe('https://example.com/a');
  });

  it('trims surrounding whitespace', () => {
    expect(canonicalizeUrl('  https://example.com/a  ')).toBe('https://example.com/a');
  });

  it('throws a typed error on unparseable input', () => {
    expect(() => canonicalizeUrl('not a url')).toThrow(/invalid url/i);
    expect(() => canonicalizeUrl('')).toThrow(/invalid url/i);
  });
});

describe('hashCanonicalUrl', () => {
  it('returns a 64-char lowercase hex SHA-256', () => {
    const hash = hashCanonicalUrl('https://example.com/a');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the canonical form: tracking params and case do not change the hash', () => {
    expect(hashCanonicalUrl('HTTPS://EXAMPLE.COM/a?utm_source=x')).toBe(
      hashCanonicalUrl('https://example.com/a'),
    );
  });

  it('different URLs produce different hashes', () => {
    expect(hashCanonicalUrl('https://example.com/a')).not.toBe(
      hashCanonicalUrl('https://example.com/b'),
    );
  });
});
