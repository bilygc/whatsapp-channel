-- 0002_draft_send_tracking.sql — send-once delivery tracking for drafts
--
-- Product decision: draft delivery to Telegram is SEND-ONCE under the scheduled
-- timer. Before this migration the send step selected every `pending` draft on
-- every run, so a draft re-sent each window until an operator pressed
-- posted/skipped. From now on a successfully sent draft is never re-sent
-- automatically:
--
--   * Send step selects
--       WHERE status = 'pending' AND last_sent_at IS NULL
--     (see src/telegram/send.ts).
--   * last_sent_at is written ONLY on a successful Telegram send (photo, text,
--     or the photo->text fallback). It is NOT cleared when the operator later
--     marks the draft posted/skipped: it is delivery history and survives the
--     human gate.
--   * telegram_message_id is the message_id Telegram returned on that send;
--     kept for future caption/message edits (no constraint — plain storage).
--   * Escape hatch (re-arm): a `--resend` flag on telegramSend clears both
--     columns (SET last_sent_at = NULL, telegram_message_id = NULL) and then
--     sends. NULL therefore means "never sent OR manually re-armed".
--
-- Existing rows all get last_sent_at NULL. That is CORRECT, not a data gap:
-- pre-0002 delivery history was never recorded, so every existing draft is
-- eligible to be sent exactly once (e.g. the 8 currently-pending drafts once
-- the operator's chat id is configured).
--
-- Conventions (see 0001_init.sql): ISO-8601 UTC TEXT timestamps
-- ('YYYY-MM-DDTHH:MM:SS.sssZ', same format as created_at), STRICT table,
-- PRAGMA user_version bumped at the end. Purely additive: ALTER TABLE ADD
-- COLUMN only — no rebuild, no data loss, nullable columns default to NULL on
-- the 20+ existing rows.

ALTER TABLE drafts ADD COLUMN last_sent_at TEXT;        -- NULL = never sent / re-armed for resend
ALTER TABLE drafts ADD COLUMN telegram_message_id INTEGER;  -- message_id returned by Telegram on send; for future edits

-- Send-step queue: exactly the query the send step runs
-- (FROM drafts ... WHERE status = 'pending' AND last_sent_at IS NULL ORDER BY id).
-- Partial so it holds only unsent pending drafts and retires rows as they are
-- sent/acted on; keying on id lets SQLite walk it in ORDER BY order without a
-- sort. idx_drafts_status stays as-is (still serves status-filtered listings
-- such as previewDrafts).
CREATE INDEX idx_drafts_unsent ON drafts (id)
    WHERE status = 'pending' AND last_sent_at IS NULL;

PRAGMA user_version = 2;
