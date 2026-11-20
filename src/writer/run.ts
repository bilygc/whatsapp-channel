import type Database from 'better-sqlite3';
import type { LlmArticle } from './openrouter.js';
import { normalizeCaption, normalizeTweet } from './validate.js';

/**
 * Inter-article pacing for the free-tier 20 req/min budget: each article costs
 * TWO LLM calls (caption + X post). A ~6s gap with ±20% jitter spreads those
 * pairs across the window so a run of 3–4 articles never bursts the limit.
 * Overridable via the LLM_INTER_ARTICLE_DELAY_MS env var (0 disables).
 */
export const LLM_INTER_ARTICLE_DELAY_MS = 6000;

/** ±20% jitter so repeated runs (and concurrent deliver windows) de-sync. */
export const LLM_INTER_ARTICLE_JITTER = 0.2;

/**
 * Resolve the inter-article pacing delay from the environment. Empty/blank,
 * non-numeric, non-integer, or negative values fall back to the default;
 * `0` is a valid explicit value (disables pacing), distinct from "unset".
 * Env is read at call time (not module load) so dotenv `config()` has run.
 */
export function resolveInterArticleDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LLM_INTER_ARTICLE_DELAY_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return raw && Number.isInteger(parsed) && parsed >= 0 ? parsed : LLM_INTER_ARTICLE_DELAY_MS;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Jittered delay in [base*(1-J), base*(1+J)], clamped to integer ms. */
function interArticleDelay(baseMs: number, rnd: () => number): number {
  const r = Math.min(1, Math.max(0, rnd()));
  return Math.round(baseMs * (1 - LLM_INTER_ARTICLE_JITTER + 2 * LLM_INTER_ARTICLE_JITTER * r));
}

/** Both generated texts for one article. `xPost` is null when no X post was generated (yet). */
export interface GeneratedDraft {
  caption: string;
  xPost: string | null;
}

/** The generate seam accepts the legacy plain-caption string (stored without an X post). */
export type GenerateResult = string | GeneratedDraft;

export interface WriterDeps {
  now: () => Date;
  /**
   * One LLM call set per article (injectable seam — mocked in tests).
   * Returns the raw texts; runWriter validates both. A plain string keeps
   * the legacy behavior (caption only, `x_post_es` stays NULL).
   */
  generate: (article: LlmArticle) => Promise<GenerateResult>;
  /**
   * Max `selected` rows to process this run (default: all — the standalone
   * `npm run write` behavior). The cron deliver step passes its selection
   * count so one run never spends more than ~4 LLM calls.
   */
  limit?: number;
  /**
   * Explicit fresh-selection IDs (the deliver chain passes what it just
   * selected). The run writes these FIRST — in the given order — so stale
   * `selected` leftovers from an earlier failed run can never starve the
   * current pick via the oldest-first drain. Leftover `selected` rows
   * backfill oldest-first only with spare capacity under `limit` (all of
   * them when `limit` is unset). Failed articles stay `selected` for a
   * retry either way. Standalone `npm run write` omits this and drains
   * everything oldest-first.
   */
  articleIds?: number[];
  /**
   * Injectable pacer clock for the inter-article delay (default: real
   * setTimeout). Tests inject a noop/spy; production leaves it unset so the
   * real free-tier pacing applies.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Inter-article pacing delay in ms. Defaults to
   * `resolveInterArticleDelayMs()` (env LLM_INTER_ARTICLE_DELAY_MS, 6000).
   * `0` disables pacing entirely.
   */
  interArticleDelayMs?: number;
  /** Injectable jitter source in [0,1) (default: Math.random). Tests inject for deterministic bounds. */
  random?: () => number;
}

export interface ArticleResult {
  articleId: number;
  ok: boolean;
  draftId?: number;
  error?: string;
}

export interface WriteSummary {
  results: ArticleResult[];
  total: number;
  written: number;
  failed: number;
  /** 1 only when at least one article was attempted and ALL failed. */
  exitCode: number;
}

/**
 * Insert or regenerate a draft. `drafts.article_id` is UNIQUE (one draft per
 * article) with ON DELETE RESTRICT — so regenerate is an UPDATE of the
 * existing row's caption AND x_post_es, never a delete + reinsert (which
 * would lose delivery state and could orphan FK references). Status/
 * created_at/posted_at/views are preserved on conflict, as are the
 * send-once tracking columns (`last_sent_at`, `telegram_message_id` —
 * delivery history owned by the send step in `src/telegram/send.ts`, never
 * rewritten by a regenerate). `xPost` null means "no X post generated" and
 * overwrites any previous value, mirroring `caption_es`. Returns the draft
 * id. Throws a typed `draft save failed: <cause>` error (e.g. unknown
 * article FK violation).
 */
export function saveDraft(
  db: Database.Database,
  articleId: number,
  caption: string,
  xPost: string | null = null,
): number {
  try {
    const row = db
      .prepare(
        `INSERT INTO drafts (article_id, caption_es, x_post_es)
         VALUES (@articleId, @caption, @xPost)
         ON CONFLICT(article_id) DO UPDATE SET caption_es = excluded.caption_es, x_post_es = excluded.x_post_es
         RETURNING id`,
      )
      .get({ articleId, caption, xPost }) as { id: number };
    return row.id;
  } catch (err) {
    throw new Error(`draft save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Build the per-run write set: the explicitly picked fresh IDs first (in the
 * caller's order, skipping IDs that are no longer `selected`), then stale
 * `selected` leftovers oldest-first to fill any remaining capacity under the
 * limit. Without an explicit pick this is the legacy oldest-first drain,
 * optionally bounded. Bound parameters throughout (never interpolation).
 */
function fetchWriteSet(db: Database.Database, deps: WriterDeps): LlmArticle[] {
  const cap = deps.limit !== undefined ? Math.max(0, Math.floor(deps.limit)) : undefined;
  const wanted = (deps.articleIds ?? []).filter((n) => Number.isInteger(n));
  if (wanted.length === 0) {
    return fetchOldestSelected(db, [], cap);
  }
  const found = db
    .prepare(
      `SELECT id, title, source, url FROM articles WHERE status = 'selected' AND id IN (${wanted.map(() => '?').join(', ')})`,
    )
    .all(...wanted) as LlmArticle[];
  const rank = new Map(wanted.map((id, i) => [id, i]));
  found.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  // The limit is a hard cap on LLM calls: a contradictory oversized pick is
  // truncated rather than blowing the per-run budget.
  const fresh = cap !== undefined ? found.slice(0, cap) : found;
  const remaining = cap !== undefined ? cap - fresh.length : undefined;
  if (remaining !== undefined && remaining <= 0) return fresh;
  return [...fresh, ...fetchOldestSelected(db, fresh.map((a) => a.id), remaining)];
}

/** Oldest `selected` rows excluding the given IDs, optionally bounded. */
function fetchOldestSelected(db: Database.Database, exclude: number[], take?: number): LlmArticle[] {
  const notIn = exclude.length > 0 ? `AND id NOT IN (${exclude.map(() => '?').join(', ')})` : '';
  const limited = take !== undefined ? ' LIMIT ?' : '';
  const args = take !== undefined ? [...exclude, take] : exclude;
  return db
    .prepare(
      `SELECT id, title, source, url FROM articles WHERE status = 'selected' ${notIn} ORDER BY id${limited}`,
    )
    .all(...args) as LlmArticle[];
}

/**
 * Run the writer over the write set (fresh picks first, then stale leftovers
 * oldest-first — see fetchWriteSet): one LLM call each → validate →
 * draft (status `pending`) → mark article `used`. Failures are isolated per
 * article (LLM error, bad output, or SQLite hiccup): the error is recorded,
 * the article stays `selected` for a retry, and the rest of the run continues.
 * A jittered inter-article delay (`LLM_INTER_ARTICLE_DELAY_MS`) paces the
 * two LLM calls per article under the free-tier 20 req/min limit, including
 * after failures. A failed run never loses a draft or an article. Throws a typed
 * `writer run failed: <cause>` error only when the run itself cannot start
 * (e.g. articles table unreadable).
 */
export async function runWriter(db: Database.Database, deps: WriterDeps): Promise<WriteSummary> {
  let articles: LlmArticle[];
  try {
    articles = fetchWriteSet(db, deps);
  } catch (err) {
    throw new Error(`writer run failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const delayMs = deps.interArticleDelayMs ?? resolveInterArticleDelayMs();

  const results: ArticleResult[] = [];
  for (let i = 0; i < articles.length; i++) {
    // Pacing: the two LLM calls per article must not arrive back-to-back
    // across articles (free tier is 20 req/min). Skip the first (nothing to
    // space it from); keep pacing even after a failed article so a burst of
    // retries still trickles out. A broken pacer is best-effort — it must
    // never cost an article or lose a draft.
    if (i > 0 && delayMs > 0) {
      try {
        await sleep(interArticleDelay(delayMs, random));
      } catch {
        // Best-effort pacing: continue rather than drop the remaining articles.
      }
    }
    const article = articles[i];
    try {
      const raw = await deps.generate(article);
      const rawCaption = typeof raw === 'string' ? raw : raw.caption;
      const rawX: string | null = typeof raw === 'string' ? null : (raw.xPost ?? null);
      const caption = normalizeCaption({ caption: rawCaption, source: article.source, url: article.url });
      // The X post normalizes (and fails) independently: a malformed tweet
      // leaves `x_post_es` NULL while the caption still stores — the draft
      // is never lost because the second text misbehaved.
      let xPost: string | null = null;
      if (rawX !== null) {
        try {
          xPost = normalizeTweet({ tweet: rawX, source: article.source, url: article.url });
        } catch {
          xPost = null;
        }
      }
      const draftId = saveDraft(db, article.id, caption, xPost);
      db.prepare(`UPDATE articles SET status = 'used' WHERE id = ?`).run(article.id);
      results.push({ articleId: article.id, ok: true, draftId });
    } catch (err) {
      // Per-article isolation: record and continue; the article stays
      // `selected` (retryable) and any existing draft row is untouched.
      results.push({
        articleId: article.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const written = results.filter((r) => r.ok).length;
  const failed = results.length - written;
  return {
    results,
    total: results.length,
    written,
    failed,
    exitCode: results.length > 0 && failed === results.length ? 1 : 0,
  };
}
