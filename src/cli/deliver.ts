#!/usr/bin/env tsx
/**
 * `npm run deliver` — the cron deliver step (M5 automation): runs the
 * post-fetch chain select → write → telegramSend in one process via
 * `runDeliver` (the same library functions the individual CLIs call — no
 * duplicated logic). Honest chain semantics:
 * - 0 selected → fine outcome: skip write+send, exit 0.
 * - Write partial/total failure → send still runs; exit 0 unless send failed
 *   everything (warning lines flag the write trouble).
 * - Select DB failure, missing Telegram config, or a throwing send run →
 *   typed error, exit 1. Drafts/articles are never lost either way.
 * Usage: npm run deliver [-- <limit>]
 */
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations, openDb, resolveDbPath } from '../db/migrate.js';
import { generateCaption, resolveLlmConfig } from '../writer/openrouter.js';
import { resolveTelegramConfig } from '../telegram/config.js';
import { SELECT_DEFAULT_LIMIT } from '../selector/select.js';
import { runDeliver } from '../deliver/run.js';
import { acquireDeliverGuard } from '../deliver/guard.js';
import { scrubToLine } from '../writer/validate.js';
import { formatArticleLine, formatCliFailure, formatDraftSendLine } from './format.js';

config();

/** Repo root for the single-instance guard file (same convention as schedule.ts). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(): Promise<void> {
  const rawLimit = process.argv[2];
  const limit = rawLimit !== undefined ? Number(rawLimit) : SELECT_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    console.error(`deliver failed: limit must be a non-negative integer (got "${rawLimit}")`);
    process.exitCode = 1;
    return;
  }
  // Plan cap is quality-over-volume (3–4 posts/day): the timer never writes
  // or sends more than SELECT_DEFAULT_LIMIT drafts per run. A bigger ask is
  // a typed refusal, not a silent clamp (silent clamps hide operator error).
  if (limit > SELECT_DEFAULT_LIMIT) {
    console.error(
      `deliver failed: limit ${limit} exceeds the per-run cap of ${SELECT_DEFAULT_LIMIT} ` +
        `(plan: 3–4 posts/day; at most ${SELECT_DEFAULT_LIMIT} drafts per deliver run).`,
    );
    process.exitCode = 1;
    return;
  }

  const db = openDb(resolveDbPath());
  // Single-instance claim FIRST (fail fast): a second deliver starting
  // while one is mid-flight exits typed instead of double-sending. The
  // guard is a dedicated SQLite file, so the held claim never blocks fetch.
  // Guard errors are already typed `deliver failed: ...` — print directly
  // (not via formatCliFailure, which would double the prefix).
  let guard: { release(): void };
  try {
    guard = acquireDeliverGuard(REPO_ROOT);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    try {
      db.close();
    } catch {
      // Nothing ran: a failing close here has no outcome to mask.
    }
    return;
  }
  try {
    applyMigrations(db);

    const { apiKey, model } = resolveLlmConfig();
    const { token, chatId } = resolveTelegramConfig();
    if (!apiKey) {
      console.warn(
        'deliver: OPENROUTER_API_KEY is not set — skipping write step (pending drafts will still send).',
      );
    } else {
      console.log(`Using model: ${model}`);
    }

    const summary = await runDeliver(db, {
      limit,
      generate: apiKey
        ? (article) => generateCaption(article, { fetchFn: fetch, apiKey, model })
        : undefined,
      fetchFn: fetch,
      token,
      chatId,
    });

    console.log(`select: scored=${summary.scored} selected=${summary.selected} (limit ${limit}).`);
    for (const a of summary.articles) {
      // Feed fields are remote-controlled: single-line scrub so a hostile
      // title cannot forge extra terminal lines past the review gate.
      console.log(`- [${a.id}] ${scrubToLine(a.source)}: ${scrubToLine(a.title)} (${scrubToLine(a.url)})`);
    }
    if (summary.selected === 0) {
      console.log('deliver: no articles selected — skipping write+send.');
      process.exitCode = 0;
      return;
    }

    if (summary.write) {
      for (const r of summary.write.results) {
        console.log(formatArticleLine(r));
      }
      console.log(
        `write: selected=${summary.write.total} written=${summary.write.written} ` +
          `failed=${summary.write.failed}.`,
      );
    }
    if (summary.writeSkippedReason) {
      console.warn(`deliver: write step skipped (${scrubToLine(summary.writeSkippedReason)}) — continuing to send.`);
    }

    if (summary.send) {
      for (const r of summary.send.results) {
        console.log(formatDraftSendLine(r));
      }
      for (const w of summary.send.warnings) {
        console.warn(`deliver warning: ${scrubToLine(w)}`);
      }
      console.log(
        `send: pending=${summary.send.total} sent=${summary.send.sent} ` +
          `failed=${summary.send.failed}.`,
      );
    }
    process.exitCode = summary.exitCode;
  } catch (err) {
    // Resolve the TRIMMED config token (same convention as telegram-send):
    // request URLs are built with the trimmed form, so only it reliably
    // redacts an error echoing request details.
    const { token } = resolveTelegramConfig();
    console.error(formatCliFailure('deliver', err, token ?? ''));
    process.exitCode = 1;
  } finally {
    // Release the single-instance claim first so a concurrent waiter can
    // proceed even if the DB close below misbehaves.
    try {
      guard.release();
    } catch (releaseErr) {
      console.error(
        `deliver warning: failed to release the deliver guard: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
      );
    }
    // A failing close must never mask the run's own outcome (success or the
    // typed failure above): note it and keep the exit code already decided.
    try {
      db.close();
    } catch (closeErr) {
      console.error(
        `deliver warning: failed to close the database: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
      );
    }
  }
}

main().catch((err: unknown) => {
  const { token } = resolveTelegramConfig();
  console.error(formatCliFailure('deliver', err, token ?? ''));
  process.exitCode = 1;
});
