import type Database from 'better-sqlite3';

export interface SelectableArticle {
  id: number;
  title: string;
  source: string;
  url: string;
  image_url: string | null;
  published_at: string;
}

export interface SelectOptions {
  /** Max articles to mark `selected`. Defaults to SELECT_DEFAULT_LIMIT (plan cap: 3–4/day). */
  limit?: number;
  /** Injected clock for deterministic tests. */
  now?: Date;
}

export interface SelectResult {
  selected: SelectableArticle[];
  scored: number;
}

/** Plan cap: quality over volume, 3–4 posts/day. Default to the top of the range. */
export const SELECT_DEFAULT_LIMIT = 4;

/**
 * Token-set Jaccard at/above which two headlines are treated as the same story
 * and the lower-ranked one is vetoed. Tunable: 0.5–0.6 keeps genuinely distinct
 * topics apart while collapsing differently-worded reports of a single event.
 */
export const SIMILARITY_THRESHOLD = 0.55;

/** How far back (days) of `selected`/`used` headlines count against a new pick. */
export const RECENT_LOOKBACK_DAYS = 7;

/**
 * Per-source weights. All neutral (1.0) until M4 delivery stats give real
 * signal on which outlets resonate — the shape (recency × weight + keywords)
 * is what the plan asks for, without inventing preferences.
 */
export const SOURCE_WEIGHTS: Record<string, number> = {
  ign: 1.0,
  polygon: 1.0,
  eurogamer: 1.0,
  gematsu: 1.0,
  nintendolife: 1.0,
  gamedeveloper: 1.0,
  newsdata: 1.0,
};

/** Keyword relevance: distinct case-insensitive substring hits on the title. */
export const KEYWORDS = [
  'gta',
  'zelda',
  'mario',
  'pokemon',
  'pokémon',
  'switch',
  'playstation',
  'ps5',
  'xbox',
  'nintendo',
  'elden ring',
  'minecraft',
  'fortnite',
  'call of duty',
  'ea fc',
  'steam',
  'fromsoftware',
  'dlc',
  'remake',
  'trailer',
  'lanzamiento',
  'secuela',
  'league of legends',
  'emulator',
  'emulador',
];

const KEYWORD_POINTS = 8;
const MAX_KEYWORD_BONUS = 24;
/** Recency window: linear decay to 0 at 72h old. */
const RECENCY_WINDOW_HOURS = 72;

export function scoreArticle(
  article: { title: string; source: string; publishedAt: string },
  now: Date,
): number {
  const ms = Date.parse(article.publishedAt);
  // Belt-and-braces: an unparseable date scores as maximally fresh, never NaN.
  const ageHours = Number.isNaN(ms) ? 0 : Math.max(0, (now.getTime() - ms) / 3600_000);
  const recency = 100 * Math.max(0, 1 - ageHours / RECENCY_WINDOW_HOURS);

  const lower = article.title.toLowerCase();
  let hits = 0;
  for (const kw of KEYWORDS) {
    if (lower.includes(kw)) hits += 1;
  }
  const keywordBonus = Math.min(MAX_KEYWORD_BONUS, hits * KEYWORD_POINTS);

  const weight = SOURCE_WEIGHTS[article.source.toLowerCase()] ?? 1.0;
  return (recency + keywordBonus) * weight;
}

/* -------------------------------------------------------------------------- */
/* Diversity veto                                                             */
/*                                                                            */
/* Dedupe by URL hash cannot catch one story reported by several outlets: the  */
/* URLs differ, so several near-identical headlines reach the selector. These   */
/* helpers collapse such headlines to a comparable token set and the selector  */
/* greedily vetoes near-duplicates (within the batch and against recent        */
/* `selected`/`used` history) so the writer/telegramSend see one post.          */
/* -------------------------------------------------------------------------- */

/**
 * Function words plus headline boilerplate. None of these say WHICH story a
 * headline covers, so dropping them lets differently-worded reports of one
 * event (e.g. "Reveals" vs "Announced") share the same discriminative tokens.
 */
const STOPWORDS = new Set<string>([
  // English function words.
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'at', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'we', 'you', 'he', 'she',
  'they', 'them', 'us', 'his', 'her', 'their', 'our', 'your', 'will', 'would',
  'can', 'could', 'has', 'have', 'had', 'do', 'does', 'did', 'not', 'no', 'so',
  'than', 'then', 'into', 'onto', 'about', 'after', 'before', 'over', 'under',
  'up', 'down', 'out', 'if', 'when', 'where', 'what', 'which', 'who', 'how',
  'why', 'all', 'any', 'some', 'more', 'most', 'just', 'also', 'via', 'now',
  // Spanish function words (NewsData titles can be mixed-language).
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'y', 'o', 'en', 'con',
  'por', 'para', 'que', 'se', 'su', 'sus', 'al', 'lo', 'como', 'pero', 'ya',
  'es', 'son', 'este', 'esta',
  // Headline boilerplate: non-discriminative verbs/fillers that vary by outlet.
  'new', 'news', 'reveal', 'reveals', 'revealed', 'revealing', 'announce',
  'announces', 'announced', 'confirm', 'confirms', 'confirmed', 'official',
  'officially', 'show', 'shows', 'shown', 'get', 'gets', 'got', 'watch', 'see',
  'first', 'look', 'exclusive', 'here', 'says', 'report', 'reports', 'leak',
  'leaks', 'leaked',
]);

/** Phrase aliases applied to the cleaned string before tokenizing. */
const PHRASE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgrand theft auto\b/g, 'gta'],
];

/**
 * Roman-numeral sequel numbers collapsed to digits so "GTA VI" and "GTA 6"
 * share a token. Single-letter i/x are deliberately excluded: they collide
 * with ordinary words ("i", "X-Men", "Mortal Kombat X").
 */
const TOKEN_ALIASES: Record<string, string> = {
  ii: '2',
  iii: '3',
  iv: '4',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
};

/**
 * Normalize a headline to its sorted, unique token set (as an array):
 * lowercase, fold accents, strip punctuation, apply aliases, drop stopwords.
 * Exported so callers and tests can inspect the exact tokens compared.
 */
export function normalizeTitle(title: string): string[] {
  // A URL that leaks into a headline is an identifier, not prose. Splitting it
  // into "https example com ..." would create meaningless shared tokens that
  // make unrelated articles look like the same story. Keep each URL as one
  // opaque token (distinct per URL) instead. Production titles carry the link
  // in the separate `url` column, so this only guards malformed/feed titles.
  const withUrlTokens = title.replace(/https?:\/\/[^\s]+/gi, (url) =>
    ` ${url.toLowerCase().replace(/[^a-z0-9]/g, '')} `,
  );
  const cleaned = withUrlTokens
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  let aliased = cleaned;
  for (const [pattern, replacement] of PHRASE_ALIASES) {
    aliased = aliased.replace(pattern, replacement);
  }

  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const raw of aliased.split(/\s+/)) {
    if (raw === '') continue;
    const token = TOKEN_ALIASES[raw] ?? raw;
    if (STOPWORDS.has(token)) continue;
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  tokens.sort();
  return tokens;
}

/** Jaccard similarity of two normalized token lists (0 when either is empty). */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Token-set Jaccard of two headlines after normalization. Public similarity
 * seam; the greedy veto reuses `jaccard` on precomputed token lists to avoid
 * re-normalizing history for every candidate.
 */
export function titleSimilarity(a: string, b: string): number {
  return jaccard(normalizeTitle(a), normalizeTitle(b));
}

/** Read recent `selected`/`used` headlines (lookback measured from `now`). */
function loadRecentTitles(db: Database.Database, now: Date): string[] {
  const cutoff = new Date(now.getTime() - RECENT_LOOKBACK_DAYS * 86400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT title FROM articles WHERE status IN ('selected', 'used') AND published_at > ?`,
    )
    .all(cutoff) as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

/**
 * Greedy diversity pick over the already-sorted `scored` list. A candidate is
 * skipped when it is at/above SIMILARITY_THRESHOLD vs any earlier pick OR any
 * recent headline; survivors fill up to `cap` (ordering/tiebreak preserved).
 */
function pickDiverse(
  scored: Array<{ article: SelectableArticle; score: number }>,
  cap: number,
  historyTokens: string[][],
): SelectableArticle[] {
  const picked: SelectableArticle[] = [];
  const pickedTokens: string[][] = [];
  for (const { article } of scored) {
    if (picked.length >= cap) break;
    const tokens = normalizeTitle(article.title);
    const tooSimilar =
      pickedTokens.some((t) => jaccard(tokens, t) >= SIMILARITY_THRESHOLD) ||
      historyTokens.some((t) => jaccard(tokens, t) >= SIMILARITY_THRESHOLD);
    if (tooSimilar) continue;
    picked.push(article);
    pickedTokens.push(tokens);
  }
  return picked;
}

/**
 * Score every `new` article, persist the scores, and mark the top `limit` as
 * `selected` — skipping near-duplicate headlines so one story from several
 * outlets produces a single post (and stories already `selected`/`used` in the
 * recent window are not re-sent). Only `new` rows are touched; a vetoed
 * candidate stays `new` for a later run. Throws a typed `select failed:
 * <cause>` error on SQLite failures.
 */
export function selectTopArticles(db: Database.Database, options: SelectOptions = {}): SelectResult {
  const now = options.now ?? new Date();
  const limit = options.limit ?? SELECT_DEFAULT_LIMIT;
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  try {
    const candidates = db
      .prepare(
        `SELECT id, title, source, url, image_url, published_at
         FROM articles WHERE status = 'new'`,
      )
      .all() as SelectableArticle[];

    const scored = candidates.map((a) => ({
      article: a,
      score: scoreArticle(
        { title: a.title, source: a.source, publishedAt: a.published_at },
        now,
      ),
    }));

    // Snapshot recent history BEFORE this run marks anything `selected`, so it
    // reflects previous runs only; within-batch duplicates are handled by the
    // already-picked set inside pickDiverse.
    const historyTokens = loadRecentTitles(db, now).map(normalizeTitle);

    const selectTx = db.transaction(() => {
      const setScore = db.prepare('UPDATE articles SET score = @score WHERE id = @id');
      for (const { article, score } of scored) {
        setScore.run({ score, id: article.id });
      }
      scored.sort((x, y) => {
        if (y.score !== x.score) return y.score - x.score;
        return y.article.published_at < x.article.published_at ? -1 : 1;
      });
      const top = pickDiverse(scored, cap, historyTokens);
      if (top.length > 0) {
        const mark = db.prepare(`UPDATE articles SET status = 'selected' WHERE id = ?`);
        for (const a of top) mark.run(a.id);
      }
      return top;
    });

    const selected = selectTx();
    return { selected, scored: scored.length };
  } catch (err) {
    throw new Error(`select failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
