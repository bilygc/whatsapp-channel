import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Single-instance guard for `npm run deliver` (M5 automation).
 *
 * Cron serializes its own deliver entries with `flock -n`, but a manual run
 * during a window (or two manuals racing) would sail past that file lock and
 * double-send drafts + double-spend LLM calls. So every deliver run — cron
 * or manual — first claims THIS guard: a dedicated tiny SQLite file under
 * `<repoRoot>/logs/` held under `BEGIN IMMEDIATE` for the whole run. A
 * second claimer gets `SQLITE_BUSY` immediately (`busy_timeout = 0`, never a
 * wait) and fails with a typed `another deliver is running` error instead of
 * sending. Process death releases the POSIX lock with the file description,
 * so the guard can never go stale (no PID files).
 *
 * A separate file — never the main DB — so the held write transaction
 * cannot block fetch's inserts mid-run.
 */

export const DELIVER_GUARD_DB_NAME = 'deliver-guard.db';

export interface DeliverGuard {
  /** The guard file actually claimed. */
  lockFile: string;
  /** Roll back the claim and close (safe to call twice). */
  release(): void;
}

export interface GuardDeps {
  mkdir?: (dir: string) => void;
  openDb?: (file: string) => Database.Database;
}

function isBusy(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'SQLITE_BUSY'
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Claim the deliver guard for this run. Throws a typed
 * `deliver failed: another deliver is running ...` error when a concurrent
 * run owns the window, or a typed `deliver failed: ...` error when the
 * guard itself is unusable — never a raw SQLite error.
 */
export function acquireDeliverGuard(repoRoot: string, deps: GuardDeps = {}): DeliverGuard {
  const logsDir = path.join(repoRoot, 'logs');
  try {
    (deps.mkdir ?? ((dir: string) => fs.mkdirSync(dir, { recursive: true })))(logsDir);
  } catch (err) {
    throw new Error(`deliver failed: could not create logs dir ${logsDir}: ${errText(err)}`);
  }
  const lockFile = path.join(logsDir, DELIVER_GUARD_DB_NAME);
  const openDb =
    deps.openDb ??
    ((file: string) => {
      const opened = new Database(file);
      // Non-blocking contender: a held guard must fail FAST with
      // SQLITE_BUSY, never stall the run waiting out the other deliver.
      opened.pragma('busy_timeout = 0');
      return opened;
    });
  let db: Database.Database;
  try {
    db = openDb(lockFile);
  } catch (err) {
    if (isBusy(err)) {
      throw new Error(
        'deliver failed: another deliver is running (could not claim logs/deliver-guard.db) — ' +
          'the other run owns this window; retry after it finishes.',
      );
    }
    throw new Error(`deliver failed: could not open the deliver guard ${lockFile}: ${errText(err)}`);
  }
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    try {
      db.close();
    } catch {
      // A broken close must not mask the claim failure — ignore it.
    }
    if (isBusy(err)) {
      throw new Error(
        'deliver failed: another deliver is running (could not claim logs/deliver-guard.db) — ' +
          'the other run owns this window; retry after it finishes.',
      );
    }
    throw new Error(`deliver failed: could not claim the deliver guard ${lockFile}: ${errText(err)}`);
  }
  let released = false;
  return {
    lockFile,
    release(): void {
      if (released) return;
      released = true;
      try {
        db.exec('ROLLBACK');
      } catch {
        // Nothing was ever written: a failing rollback has no state to save.
      }
      try {
        db.close();
      } catch {
        // A failing close must never mask the run's own outcome — ignore it.
      }
    },
  };
}
