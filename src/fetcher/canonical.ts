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
  // Credentials in the URL are never legitimate for ingested article links,
  // and echoing the raw URL would leak them into logs. Keep the message free
  // of the userinfo (hostname only — itself caller-controlled config or feed
  // data, not a secret).
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`invalid url: userinfo not allowed in URL for host ${parsed.hostname}`);
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

function isBlockedIPv4(dotted: string): boolean {
  const parts = dotted.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // RFC-1918 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC-1918 172.16.0.0/12
  if (a === 192 && b === 168) return true; // RFC-1918 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (cloud metadata 169.254.169.254)
  if (a === 0) return true; // "this network" 0.0.0.0/8
  return false;
}

/**
 * True when a hostname is an obvious non-public target: loopback, RFC-1918
 * private ranges, link-local (incl. cloud metadata IPs like 169.254.169.254),
 * IPv6 loopback/link-local/unique-local, or `localhost`. Used as an
 * ingest-time filter for obvious cases — hostname/IP-literal checks only, no
 * DNS resolution here.
 *
 * NOTE (M2): insert-time host checks are bypassable via DNS rebinding (a
 * hostile name resolving to a private IP at fetch time, or changing between
 * check and fetch). When M2 fetches article bodies/images over the network,
 * resolve the hostname at fetch time and re-apply this denylist to the
 * resolved IP(s) immediately before opening the connection (TODO).
 */
export function isBlockedHost(hostname: string): boolean {
  let host = hostname.toLowerCase().replace(/\.$/, ''); // strip trailing dot
  // URL.hostname keeps IPv6 brackets (e.g. "[::1]"); strip them.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // IPv6 literals (URL.hostname strips the brackets already).
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    const segments = host.split(':');
    // IPv4-mapped/embedded (e.g. ::ffff:192.168.1.1): judge the embedded IPv4.
    const last = segments[segments.length - 1];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return isBlockedIPv4(last);
    const first = Number.parseInt(segments[0], 16);
    if (!Number.isNaN(first)) {
      if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
      if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    }
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isBlockedIPv4(host);
  return false;
}

/**
 * True when a value is a fetchable public http(s) URL: parseable, http/https
 * scheme, no userinfo, host not denylisted. Article `url` failures are
 * drop-the-row conditions; `image_url` failures degrade to NULL — callers in
 * rss.ts / newsdata.ts use this for the latter.
 */
export function isSafeWebUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  let canonical: string;
  try {
    canonical = canonicalizeUrl(value);
  } catch {
    return false;
  }
  let hostname: string;
  try {
    hostname = new URL(canonical).hostname;
  } catch {
    return false;
  }
  return !isBlockedHost(hostname);
}
