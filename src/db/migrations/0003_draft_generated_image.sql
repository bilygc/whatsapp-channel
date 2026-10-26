-- 0003_draft_generated_image.sql — LLM-generated image path for drafts
--
-- Purpose: store the on-disk path of the image generated for a draft's caption
-- so the Telegram send step can later prefer it over the article's original
-- image_url. The writer/CLI regenerations overwrite this value on the same row;
-- NULL means "no generated image yet for this draft". Keeping the last generated
-- path on the row also leaves an audit trail of what was actually sent when an
-- operator manually regenerates an image.
--
-- Schema notes:
--   * Nullable TEXT, no default, no FK, no index: the send step reads the column
--     from the draft row it has already selected — nothing filters or joins on
--     it, so no index is warranted.
--   * The path is an absolute or project-relative filesystem path of a local
--     image file. No existence guarantee at read time: if the file is gone the
--     send step must fall back to image_url (application concern, not schema).
--
-- Conventions (see 0001_init.sql): STRICT table, PRAGMA user_version bumped at
-- the end. Purely additive: ALTER TABLE ADD COLUMN only — no rebuild, no data
-- loss; existing rows get NULL, which is correct ("no generated image yet").

ALTER TABLE drafts ADD COLUMN generated_image_path TEXT;  -- NULL = no generated image yet; overwritten on regeneration

PRAGMA user_version = 3;
