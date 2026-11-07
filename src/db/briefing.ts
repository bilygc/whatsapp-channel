import type Database from 'better-sqlite3';

/**
 * One-line startup diagnostic (stderr) naming the exact SQLite file a CLI
 * opened: cwd + resolved path + user_version + whether `drafts.x_post_es`
 * exists. Read-only (PRAGMA reads only, no writes); a failure to inspect
 * never throws — it prints `unknown` so startup always continues.
 */
export function logDbBriefing(openedPath: string, db: Database.Database): void {
  let userVersion: number | string = 'unknown';
  let column: 'present' | 'missing' | 'unknown' = 'unknown';
  try {
    userVersion = db.pragma('user_version', { simple: true }) as number;
  } catch {
    // Keep 'unknown': the briefing must never break startup.
  }
  try {
    const cols = db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[];
    column = cols.some((c) => c.name === 'x_post_es') ? 'present' : 'missing';
  } catch {
    // Keep 'unknown': the briefing must never break startup.
  }
  const flag = column === 'missing' ? ' <-- MISSING (draft writes will fail)' : '';
  console.error(
    `[db] cwd=${process.cwd()} path=${openedPath} user_version=${userVersion} drafts.x_post_es=${column}${flag}`,
  );
}
