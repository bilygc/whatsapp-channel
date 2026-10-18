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

/**
 * Score every `new` article, persist the scores, and mark the top `limit` as
 * `selected` (freshness tiebreak: most recently published). Only `new` rows
 * are touched — `selected`/`used` rows keep their state. Throws a typed
 * `select failed: <cause>` error on SQLite failures.
 */
export function selectTopArticles(db: Database.Database, options: SelectOptions = {}): SelectResult {
  const now = options.now ?? new Date();
  const limit = options.limit ?? SELECT_DEFAULT_LIMIT;
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

    const selectTx = db.transaction(() => {
      const setScore = db.prepare('UPDATE articles SET score = @score WHERE id = @id');
      for (const { article, score } of scored) {
        setScore.run({ score, id: article.id });
      }
      scored.sort((x, y) => {
        if (y.score !== x.score) return y.score - x.score;
        return y.article.published_at < x.article.published_at ? -1 : 1;
      });
      const top = scored.slice(0, Math.max(0, limit)).map((s) => s.article);
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
