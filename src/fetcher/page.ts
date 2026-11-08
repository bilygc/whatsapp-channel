import { lookup as defaultDnsLookup } from 'node:dns/promises';
import { canonicalizeUrl, isBlockedHost, isSafeWebUrl } from './canonical.js';
import { scrub } from '../writer/validate.js';

export const PAGE_TIMEOUT_MS = 10_000;
export const PAGE_MAX_BODY_BYTES = 256 * 1024;
export const PAGE_MAX_REDIRECTS = 3;
export const PAGE_MAX_BODY_CHARS = 2500;
export const PAGE_MAX_TITLE_CHARS = 300;
export const PAGE_MAX_SOURCE_CHARS = 80;

export interface PageFetchDeps {
  fetchFn: typeof fetch;
  /** DNS resolver returning all A/AAAA records for SSRF validation (default: node:dns/promises lookup with {all:true}). */
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface ArticleMetadata {
  url: string;
  title: string;
  body: string;
  source: string;
}

function defaultLookup(hostname: string): Promise<Array<{ address: string }>> {
  return defaultDnsLookup(hostname, { all: true });
}

function declaredLength(res: Response): number | null {
  try {
    const raw = res.headers?.get('content-length');
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = declaredLength(res);
  if (declared != null && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      // Ignore cancel errors when rejecting oversize responses.
    }
    throw new Error(`response body too large (${declared} bytes declared, limit ${maxBytes})`);
  }
  const stream = res.body as ReadableStream<Uint8Array> | null;
  if (stream != null && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new Error(`response body too large (exceeds ${maxBytes} bytes)`);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`response body too large (limit ${maxBytes} bytes)`);
  }
  return text;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanTextFragment(raw: string): string {
  const withoutTags = raw.replace(/<[^>]+>/g, ' ');
  return scrub(decodeHtmlEntities(withoutTags)).replace(/\s+/g, ' ').trim();
}

function readAttr(tag: string, attrName: string): string | null {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

function findMetaContent(html: string, keys: string[]): string {
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  const metaRe = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRe.exec(html)) !== null) {
    const tag = match[0];
    const key = (readAttr(tag, 'property') ?? readAttr(tag, 'name') ?? '').trim().toLowerCase();
    if (!wanted.has(key)) continue;
    const rawContent = readAttr(tag, 'content');
    if (rawContent == null) continue;
    const cleaned = cleanTextFragment(rawContent);
    if (cleaned !== '') return cleaned;
  }
  return '';
}

function extractTitle(html: string): string {
  const ogOrTwitter = findMetaContent(html, ['og:title', 'twitter:title']);
  if (ogOrTwitter !== '') return ogOrTwitter.slice(0, PAGE_MAX_TITLE_CHARS);

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch) {
    const cleaned = cleanTextFragment(titleMatch[1]);
    if (cleaned !== '') return cleaned.slice(0, PAGE_MAX_TITLE_CHARS);
  }
  return '';
}

function extractBody(html: string, maxChars: number): string {
  const description = findMetaContent(html, ['og:description', 'twitter:description', 'description']);
  const parts: string[] = [];
  if (description !== '') parts.push(description);

  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;
  let totalLen = parts.join(' ').length;
  while ((match = pRe.exec(html)) !== null) {
    const paragraph = cleanTextFragment(match[1]);
    if (paragraph === '' || paragraph === description) continue;
    parts.push(paragraph);
    totalLen += paragraph.length + 1;
    if (totalLen >= maxChars) break;
  }

  return parts.join(' ').slice(0, maxChars).trim();
}

function extractSource(html: string, canonicalUrl: string): string {
  const siteName = findMetaContent(html, ['og:site_name']);
  if (siteName !== '') return siteName.slice(0, PAGE_MAX_SOURCE_CHARS);
  const hostname = new URL(canonicalUrl).hostname.replace(/^www\./i, '');
  return scrub(hostname).replace(/\s+/g, '').slice(0, PAGE_MAX_SOURCE_CHARS) || 'web';
}

async function validatePublicTarget(
  rawUrl: string,
  lookupFn: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<string> {
  const canonical = canonicalizeUrl(rawUrl);
  if (!isSafeWebUrl(canonical)) {
    throw new Error('blocked or unsafe URL');
  }
  const parsed = new URL(canonical);
  const rawHost =
    parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
  if (isBlockedHost(rawHost)) {
    throw new Error('blocked host (private or reserved address)');
  }
  const records = await lookupFn(rawHost);
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('DNS lookup returned no addresses');
  }
  for (const record of records) {
    if (!record?.address || isBlockedHost(record.address)) {
      throw new Error('blocked host (private or reserved address)');
    }
  }
  return canonical;
}

/**
 * Fetch an article page with full SSRF defenses (canonicalizeUrl, isSafeWebUrl,
 * DNS resolution checked against isBlockedHost on every hop, manual redirects
 * capped at 3, 10s timeout, HTML content-type check, 256KB streaming cap) and
 * extract `{ url, title, body, source }` for stateless draft generation.
 */
export async function fetchArticleMetadata(
  rawUrl: string,
  deps: PageFetchDeps,
): Promise<ArticleMetadata> {
  const lookupFn = deps.lookupFn ?? defaultLookup;
  const timeoutMs = deps.timeoutMs ?? PAGE_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? PAGE_MAX_BODY_BYTES;
  const maxRedirects = deps.maxRedirects ?? PAGE_MAX_REDIRECTS;

  try {
    let currentUrl = await validatePublicTarget(rawUrl, lookupFn);
    let res: Response;

    for (let hop = 0; ; hop++) {
      res = await deps.fetchFn(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'whatsapp-channel-bot/1.0',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status >= 300 && res.status < 400) {
        try {
          await res.body?.cancel();
        } catch {
          // Ignore cancel errors on redirect hops.
        }
        if (hop >= maxRedirects) {
          throw new Error(`too many redirects (exceeded ${maxRedirects})`);
        }
        const location = res.headers?.get('location');
        if (!location || location.trim() === '') {
          throw new Error(`HTTP ${res.status} redirect without Location header`);
        }
        const nextUrl = new URL(location, currentUrl).toString();
        currentUrl = await validatePublicTarget(nextUrl, lookupFn);
        continue;
      }
      break;
    }

    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        // Ignore cancel errors on HTTP failure.
      }
      throw new Error(`HTTP ${res.status}`);
    }

    const contentType = (res.headers?.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      try {
        await res.body?.cancel();
      } catch {
        // Ignore cancel errors on non-HTML response.
      }
      const shortType = contentType.split(';')[0]?.trim() || 'missing';
      throw new Error(`unsupported content-type: ${shortType}`);
    }

    const rawHtml = await readTextCapped(res, maxBytes);
    const strippedHtml = rawHtml
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');

    const title = extractTitle(strippedHtml);
    if (title === '') {
      throw new Error('could not extract article title');
    }
    const body = extractBody(strippedHtml, PAGE_MAX_BODY_CHARS);
    const source = extractSource(strippedHtml, currentUrl);

    return {
      url: currentUrl,
      title,
      body,
      source,
    };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(cause.startsWith('article fetch failed: ') ? cause : `article fetch failed: ${cause}`);
  }
}
