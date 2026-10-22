-- 0001_init.sql — initial schema for whatsapp-channel
--
-- Conventions (do not change per-migration):
--   * Timestamps: ISO-8601 UTC TEXT, 'YYYY-MM-DDTHH:MM:SS.sssZ' (lexicographically sortable).
--   * STRICT tables (SQLite >= 3.37) so column types are enforced.
--   * Migration tracking: PRAGMA user_version (bumped at the end of each migration).
--     A runner in src/db/ should apply pending files in filename order and set
--     user_version to the migration number.
--   * journal_mode=WAL is NOT set here on purpose: it is persistent and must be
--     enabled outside a transaction (a runner may wrap migrations in one). Set it
--     once when creating/first-opening the DB.
--
-- Status enums (application-level state machines):
--   articles.status: 'new'      -> fetched, not yet considered by the selector
--                    'selected' -> picked by the selector, awaiting draft generation
--                    'used'     -> a draft has been generated for this article
--   drafts.status:   'pending'  -> written, queued for Telegram delivery
--                    'skipped'  -> operator pressed "skip"
--                    'posted'   -> operator pressed "posted" (posted_at set)
--   Article lifecycle lives in articles.status; delivery lifecycle in drafts.status.

CREATE TABLE articles (
    id           INTEGER PRIMARY KEY,          -- implicit rowid alias
    url_hash     TEXT    NOT NULL UNIQUE,      -- hex SHA-256 of the canonical URL; the dedup key
    title        TEXT    NOT NULL,
    source       TEXT    NOT NULL,
    url          TEXT    NOT NULL,
    image_url    TEXT,                         -- NULL = no image available
    published_at TEXT    NOT NULL,             -- ISO-8601 UTC; fetcher falls back to fetch time
    score        REAL    NOT NULL DEFAULT 0,   -- selector score; 0 = not yet scored
    status       TEXT    NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new', 'selected', 'used'))
) STRICT;

-- Selector query: "top N recent unprocessed" -> WHERE status = 'new' ORDER BY published_at DESC
CREATE INDEX idx_articles_status_published_at ON articles (status, published_at DESC);

CREATE TABLE drafts (
    id         INTEGER PRIMARY KEY,
    article_id INTEGER NOT NULL UNIQUE         -- one draft per article (writer: one call per chosen article)
               REFERENCES articles (id) ON DELETE RESTRICT,
    caption_es TEXT    NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'skipped', 'posted')),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    posted_at  TEXT,                           -- NULL until the draft is posted
    views      INTEGER,                        -- NULL = not logged yet (distinct from 0)
    CHECK (views IS NULL OR views >= 0)
) STRICT;

-- Delivery bot queries drafts by status (e.g. pending, oldest first)
CREATE INDEX idx_drafts_status ON drafts (status);

CREATE TABLE stats (
    date           TEXT    NOT NULL PRIMARY KEY,  -- 'YYYY-MM-DD', one row per logged date
    follower_count INTEGER NOT NULL CHECK (follower_count >= 0)
) STRICT;

PRAGMA user_version = 1;
