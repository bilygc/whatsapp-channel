#!/usr/bin/env bash
# One-time, idempotent repair utility for syncing additive drafts columns.
# This is intentionally a shell script: SQLite has no portable
# ALTER TABLE ... ADD COLUMN IF NOT EXISTS syntax.
set -euo pipefail

DB_PATH="${1:-${DB_PATH:-data/whatsapp-channel.db}}"

if [[ ! -f "$DB_PATH" ]]; then
  printf 'Database file not found: %s\n' "$DB_PATH" >&2
  exit 1
fi

table_count="$(sqlite3 -readonly -batch -noheader "$DB_PATH" \
  "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'drafts';")"
if [[ "$table_count" != "1" ]]; then
  printf 'Expected table drafts in %s; no changes made.\n' "$DB_PATH" >&2
  exit 1
fi

column_exists() {
  local name="$1"
  [[ "$(sqlite3 -readonly -batch -noheader "$DB_PATH" \
    "SELECT COUNT(*) FROM pragma_table_info('drafts') WHERE name = '$name';")" == "1" ]]
}

# These existing columns cannot be safely reconstructed with ADD COLUMN while
# preserving the local schema's primary key, NOT NULL semantics, defaults, and
# foreign-key/UNIQUE constraints. Refuse before changing anything if absent.
for required in id article_id caption_es created_at; do
  if ! column_exists "$required"; then
    printf 'Cannot safely add required drafts.%s with ALTER TABLE ADD COLUMN; no changes made.\n' "$required" >&2
    printf 'That schema drift requires a reviewed table rebuild and data-preservation plan.\n' >&2
    exit 1
  fi
done

sql='BEGIN IMMEDIATE;'
added=0

add_column_if_missing() {
  local name="$1"
  local definition="$2"
  if ! column_exists "$name"; then
    sql+=$'\nALTER TABLE drafts ADD COLUMN '"$definition"';'
    added=$((added + 1))
    printf 'Adding drafts.%s\n' "$name"
  fi
}

# Match the local live schema. Nullable columns are added as NULL for existing
# rows; status uses its local default and CHECK constraint.
add_column_if_missing status "status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'skipped', 'posted'))"
add_column_if_missing posted_at 'posted_at TEXT'
add_column_if_missing views 'views INTEGER CHECK (views IS NULL OR views >= 0)'
add_column_if_missing last_sent_at 'last_sent_at TEXT'
add_column_if_missing telegram_message_id 'telegram_message_id INTEGER'
add_column_if_missing generated_image_path 'generated_image_path TEXT'
add_column_if_missing caption_x 'caption_x TEXT'
add_column_if_missing x_post_es 'x_post_es TEXT'

if [[ "$added" == "0" ]]; then
  printf 'drafts already has all locally syncable columns; no changes needed.\n'
  exit 0
fi

sql+=$'\nCOMMIT;'
sqlite3 -bail "$DB_PATH" "$sql"
printf 'Added %s column(s) to drafts in %s.\n' "$added" "$DB_PATH"
