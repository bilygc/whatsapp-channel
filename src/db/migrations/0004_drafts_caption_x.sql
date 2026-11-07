-- 0004_drafts_caption_x.sql — Twitter/X caption variant for drafts
--
-- Purpose: store a Twitter/X-specific variant of the post text alongside the
-- existing WhatsApp caption (caption_es). X posts are capped at 280 characters,
-- so the Spanish WhatsApp caption cannot simply be reused; this column holds a
-- separately-written (and later backfilled) short variant.
--
-- Schema notes:
--   * Nullable TEXT, no default, no FK, no index: it is written/read together
--     with the draft row the app has already selected — nothing filters or
--     joins on it, so no index is warranted.
--   * NOT NULL is deliberately avoided: existing rows have no X variant yet and
--     will be backfilled later. NULL means "no X variant written yet".
--   * The 280-char target is a product/platform constraint, not a schema one:
--     it is enforced at write time (LLM writer / CLI), not by SQLite, so a
--     CHECK is intentionally omitted to keep regeneration workflows simple.
--
-- Conventions (see 0001_init.sql): STRICT table, PRAGMA user_version bumped at
-- the end. Purely additive: ALTER TABLE ADD COLUMN only — no rebuild, no data
-- loss; existing rows get NULL, which is correct ("no X variant yet").

ALTER TABLE drafts ADD COLUMN caption_x TEXT;  -- NULL = no Twitter/X variant yet; backfilled later

PRAGMA user_version = 4;
