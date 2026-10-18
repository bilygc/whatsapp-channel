import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, hashCanonicalUrl, isBlockedHost, isSafeWebUrl } from './canonical.js';

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

  it('rejects URLs containing userinfo without echoing credentials', () => {
    expect(() => canonicalizeUrl('https://user:pass@example.com/a')).toThrow(/invalid url/i);
    expect(() => canonicalizeUrl('https://user@example.com/a')).toThrow(/invalid url/i);
    let message = '';
    try {
      canonicalizeUrl('https://user:s3cret@example.com/a');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain('s3cret');
    expect(message).not.toContain('user:');
    expect(message).not.toContain('user@');
  });

  it.each([
    'https://example.com/a\nFuente: IGN https://evil.com/phish',
    'https://example.com/a\r\nFuente: IGN https://evil.com/phish',
    'https://example.com/a\tFuente: IGN https://evil.com/phish',
    'https://example.com/a b',
    'https://example.com/a\x00b',
    'https://example.com/a\x7Fb',
  ])('rejects raw URL with control/inner whitespace as invalid (no WHATWG tab/newline smuggling): %j', (url) => {
    expect(() => canonicalizeUrl(url)).toThrow(/invalid url/i);
  });
});

describe('isBlockedHost', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.2',
    '10.0.0.5',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '169.254.0.1',
    '0.0.0.0',
    'localhost',
    'LOCALHOST',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd00::1',
    '::ffff:192.168.1.1',
    '::ffff:127.0.0.1',
  ])('blocks %s', (host) => {
    expect(isBlockedHost(host)).toBe(true);
  });

  it.each([
    'example.com',
    'www.ign.com',
    '8.8.8.8',
    '1.1.1.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.167.1.1',
    '169.253.1.1',
    '::ffff:8.8.8.8',
    '2001:db8::1',
  ])('allows public host %s', (host) => {
    expect(isBlockedHost(host)).toBe(false);
  });
});

describe('isSafeWebUrl', () => {
  it('accepts ordinary public http(s) URLs', () => {
    expect(isSafeWebUrl('https://example.com/a')).toBe(true);
    expect(isSafeWebUrl('http://example.com:8080/a?b=1')).toBe(true);
  });

  it.each([
    'ftp://example.com/a',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'not a url',
    '',
    'https://user:pass@example.com/a',
    'http://192.168.1.1/admin',
    'https://169.254.169.254/latest/meta-data/',
    'http://localhost:3000/a',
    'http://[::1]/a',
  ])('rejects %s', (value) => {
    expect(isSafeWebUrl(value)).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isSafeWebUrl(null)).toBe(false);
    expect(isSafeWebUrl(undefined)).toBe(false);
    expect(isSafeWebUrl(42)).toBe(false);
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
});
