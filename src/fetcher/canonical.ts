import { createHash } from 'node:crypto';

/**
 * Query params that carry tracking/attribution rather than content identity.
 * Stripped before hashing so the same article shared via different
 * newsletters/feeds still dedupes to one row. `utm_*` is matched by prefix;
 * the rest are exact names (lowercased before comparison).
 */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'msclkid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'source',
  '_ga',
  '_gac',
  '_gid',
]);

function isTrackingParam(name: string): boolean {
  return name.startsWith('utm_') || TRACKING_PARAMS.has(name);
}

/**
 * Canonicalize a URL for dedupe hashing:
 * lowercase scheme+host, drop default ports, strip fragment, strip tracking
 * params, sort remaining params, drop trailing slash on non-root paths.
 * Throws `Error('invalid url: ...')` on unparseable input.
 */
export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`invalid url: ${trimmed.slice(0, 120)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`invalid url: unsupported protocol in ${trimmed.slice(0, 120)}`);
  }

  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();

  // Drop default ports so :443/:80 variants hash identically.
  if (
    (parsed.protocol === 'https:' && parsed.port === '443') ||
    (parsed.protocol === 'http:' && parsed.port === '80')
  ) {
    parsed.port = '';
  }

  parsed.hash = '';

  const kept: Array<[string, string]> = [];
  for (const [key, value] of parsed.searchParams) {
    if (!isTrackingParam(key.toLowerCase())) kept.push([key, value]);
  }
  kept.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  parsed.search = '';
  for (const [key, value] of kept) parsed.searchParams.append(key, value);

  // Normalize trailing slash: "/a/" and "/a" are the same page.
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return parsed.toString();
}

/** Lowercase hex SHA-256 of the canonical URL — the `articles.url_hash` value. */
export function hashCanonicalUrl(rawUrl: string): string {
  return createHash('sha256').update(canonicalizeUrl(rawUrl)).digest('hex');
}
