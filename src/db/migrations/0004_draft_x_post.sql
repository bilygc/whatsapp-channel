-- 0004_draft_x_post.sql — Spanish X (Twitter) post text for drafts
--
-- Purpose: store the Spanish-language X post text for a draft alongside the
-- WhatsApp caption (caption_es), so a future X posting step can use it. The
-- writer/CLI regenerations overwrite this value on the same row; NULL means
-- "no X post generated yet for this draft".
--
-- Backfill: none. Existing rows keep NULL, which is correct ("no X post
-- generated yet") — there is no data to backfill.
--
-- Schema notes:
--   * Nullable TEXT, no default, no FK, no index: consumers read the column
--     from the draft row they have already selected — nothing filters or joins
--     on it, so no index is warranted.
--
-- Conventions (see 0001_init.sql): STRICT table, PRAGMA user_version bumped at
-- the end. Purely additive: ALTER TABLE ADD COLUMN only — no rebuild, no data
-- loss; existing rows get NULL, which is correct ("no X post yet").

ALTER TABLE drafts ADD COLUMN x_post_es TEXT;  -- NULL = no X post generated yet; overwritten on regeneration

PRAGMA user_version = 4;
